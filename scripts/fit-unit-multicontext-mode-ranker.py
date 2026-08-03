"""Fit grouped 13-year mode rankers from multi-context counterfactual evidence."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


WINDOW_WIDTH = 13
HALF_WIDTH = 6
EVENT_TYPES = ("missingRing", "falseRing")
LOCATOR_PROFILES = (
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "differenceFull",
    "comboFull",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "reference:weightedRankMean",
    "reference:weightedWindowVote25",
)


@dataclass(frozen=True)
class Case:
    source: dict[str, Any]
    starts: np.ndarray
    features: np.ndarray
    labels: np.ndarray
    current_index: int
    group: str
    dataset: str


@dataclass(frozen=True)
class Configuration:
    feature_set: str
    label_kind: str
    leaves: int
    depth: int
    minimum: int
    estimators: int

    @property
    def name(self) -> str:
        return (
            f"{self.feature_set}:{self.label_kind}:l{self.leaves}:d{self.depth}:"
            f"m{self.minimum}:n{self.estimators}"
        )


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def percentile_ranks(values: Sequence[float]) -> list[float]:
    if len(values) <= 1:
        return [0.5] * len(values)
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + end - 1) / (2 * (len(order) - 1))
        for index in order[start:end]:
            result[index] = rank
        start = end
    return result


def profile_family(name: str) -> str:
    lowered = name.lower()
    if "reference" in lowered:
        return "reference"
    if "master" in lowered:
        return "master"
    if "predictive" in lowered:
        return "predictive"
    return "other"


def multi_context_maps(
    audited: Sequence[dict[str, Any]],
) -> dict[str, dict[int, float]]:
    by_profile: dict[str, dict[int, list[float]]] = {}
    by_family: dict[str, dict[int, list[float]]] = {}
    for candidate in audited:
        rows = candidate.get("rows", [])
        names = sorted({
            name for row in rows for name in (row.get("profiles") or {})
        })
        for name in names:
            values = [float((row.get("profiles") or {}).get(name, -10)) for row in rows]
            ranks = percentile_ranks(values)
            selected_family = profile_family(name)
            for row, rank in zip(rows, ranks):
                year = int(row["year"])
                by_profile.setdefault(name, {}).setdefault(year, []).append(rank)
                for family in ("all", selected_family):
                    by_family.setdefault(family, {}).setdefault(year, []).append(rank)
    result = {
        f"cf:{name}:mean": {
            year: mean(values) for year, values in by_year.items()
        }
        for name, by_year in by_profile.items()
    }
    for family, by_year in by_family.items():
        result[f"cfFamily:{family}:mean"] = {
            year: mean(values) for year, values in by_year.items()
        }
        result[f"cfFamily:{family}:median"] = {
            year: median(values) for year, values in by_year.items()
        }
        result[f"cfFamily:{family}:topVote"] = {
            year: mean(value >= 0.8 for value in values)
            for year, values in by_year.items()
        }
    return result


def locator_maps(source: dict[str, Any]) -> dict[str, dict[int, float]]:
    years = [int(year) for year in source.get("years", [])]
    ranks = source.get("ranks", {})
    return {
        f"locator:{name}": {
            year: float(values[index])
            for index, year in enumerate(years)
            if index < len(values)
        }
        for name in LOCATOR_PROFILES
        if (values := ranks.get(name))
    }


def aggregate_window(
    values: dict[int, float],
    start: int,
) -> tuple[float, ...]:
    inside = [values.get(year, 0) for year in range(start, start + WINDOW_WIDTH)]
    before = [values.get(year, 0) for year in range(start - 3, start)]
    after = [values.get(year, 0) for year in range(start + WINDOW_WIDTH, start + WINDOW_WIDTH + 3)]
    older = mean(inside[:3])
    newer = mean(inside[-3:])
    return (
        mean(inside),
        max(inside),
        min(inside),
        inside[HALF_WIDTH],
        older,
        newer,
        newer - older,
        older - mean(before),
        mean(after) - newer,
    )


def feature_names(map_names: Sequence[str]) -> list[str]:
    statistics = (
        "mean", "maximum", "minimum", "center", "older3", "newer3",
        "flankDelta", "enterDelta", "exitDelta",
    )
    return [
        *[
            f"{name}:{statistic}"
            for name in map_names
            for statistic in statistics
        ],
        "offsetSigned",
        "offsetDistance",
        "currentOverlap",
        "containsCurrent",
        "containsOperation",
        "containsSide",
        "currentDistance",
        "operationDistance",
        "sideDistance",
        "signalStrength",
        "referenceCount",
        "positionOlderEdge",
        "positionOlderInterior",
        "positionMiddle",
        "positionNewerInterior",
        "positionNewerEdge",
    ]


def build_case(
    source: dict[str, Any],
    dataset: str,
    event_type: str,
    feature_set: str,
    label_kind: str,
    map_names: Sequence[str],
) -> Case | None:
    context = source.get("context", {})
    final = source.get("finalWindow")
    mode = source.get("modeWindow")
    audited = source.get("coarseCandidateCounterfactuals") or []
    if (
        context.get("baselineFlagged", True)
        or source.get("eventType") != event_type
        or source.get("correctionYears") != source.get("truthCorrectionYears")
        or not final
        or not mode
        or int(final["endYear"]) - int(final["startYear"]) + 1 != WINDOW_WIDTH
        or not audited
    ):
        return None
    current_start = int(mode["startYear"])
    current_end = int(mode["endYear"])
    maximum_distance = 4 if event_type == "missingRing" else 8
    maps = multi_context_maps(audited)
    if feature_set == "cfLocator":
        maps.update(locator_maps(source))
    available_names = [name for name in map_names if name in maps]
    if len(available_names) != len(map_names):
        return None
    minimum_year = min(min(values) for values in maps.values())
    maximum_year = max(max(values) for values in maps.values())
    starts = [
        start for start in range(minimum_year, maximum_year - WINDOW_WIDTH + 2)
        if abs(start - current_start) <= maximum_distance
    ]
    if current_start not in starts:
        return None
    operation = source.get("selectedOperation") or {}
    anchors = (
        source.get("currentPrimaryYear"),
        operation.get("bestYear"),
        operation.get("sideStepBestYear"),
    )
    span = max(1, maximum_year - minimum_year)
    position = str(context.get("positionStratum", ""))
    rows = []
    labels = []
    truth = int(source["truthYear"])
    for start in starts:
        end = start + WINDOW_WIDTH - 1
        center = start + HALF_WIDTH
        values = []
        for name in map_names:
            values.extend(aggregate_window(maps[name], start))
        overlap = max(0, min(end, current_end) - max(start, current_start) + 1)
        values.extend((
            (start - current_start) / max(1, maximum_distance),
            abs(start - current_start) / max(1, maximum_distance),
            overlap / WINDOW_WIDTH,
            float(anchors[0] is not None and start <= anchors[0] <= end),
            float(anchors[1] is not None and start <= anchors[1] <= end),
            float(anchors[2] is not None and start <= anchors[2] <= end),
            1.0 if anchors[0] is None else abs(center - anchors[0]) / span,
            1.0 if anchors[1] is None else abs(center - anchors[1]) / span,
            1.0 if anchors[2] is None else abs(center - anchors[2]) / span,
            float(context.get("signalStrength") or 0),
            float(context.get("referenceCount") or 0),
            float(position == "olderEdge"),
            float(position == "olderInterior"),
            float(position == "middle"),
            float(position == "newerInterior"),
            float(position == "newerEdge"),
        ))
        distance = abs(center - truth)
        labels.append(
            int(start <= truth <= end)
            if label_kind == "binary"
            else max(0, HALF_WIDTH + 1 - distance)
        )
        rows.append(values)
    return Case(
        source=source,
        starts=np.asarray(starts, dtype=int),
        features=np.asarray(rows, dtype=np.float32),
        labels=np.asarray(labels, dtype=int),
        current_index=starts.index(current_start),
        group=str(context.get("file", "")).lower(),
        dataset=dataset,
    )


def discover_map_names(
    paths: Sequence[Path],
    event_type: str,
    feature_set: str,
) -> tuple[str, ...]:
    common: set[str] | None = None
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            if source.get("eventType") != event_type:
                continue
            audited = source.get("coarseCandidateCounterfactuals") or []
            if not audited:
                continue
            names = set(multi_context_maps(audited))
            if feature_set == "cfLocator":
                names.update(locator_maps(source))
            common = names if common is None else common & names
    return tuple(sorted(common or ()))


def load_cases(
    paths: Sequence[Path],
    dataset: str,
    event_type: str,
    feature_set: str,
    label_kind: str,
    map_names: Sequence[str],
) -> list[Case]:
    result = []
    seen = set()
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            key = (
                str(context.get("file", "")).lower(),
                str(context.get("target", "")).lower(),
                int(source.get("truthYear", 0)),
                event_type,
            )
            if key in seen:
                continue
            case = build_case(
                source, dataset, event_type, feature_set, label_kind, map_names
            )
            if case:
                seen.add(key)
                result.append(case)
    return result


def fit_model(cases: Sequence[Case], configuration: Configuration, seed: int) -> lgb.LGBMRanker:
    x = np.concatenate([case.features for case in cases])
    y = np.concatenate([case.labels for case in cases])
    groups = [len(case.starts) for case in cases]
    maximum_label = int(np.max(y))
    model = lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=list(range(maximum_label + 1)),
        n_estimators=configuration.estimators,
        learning_rate=0.03,
        num_leaves=configuration.leaves,
        max_depth=configuration.depth,
        min_child_samples=configuration.minimum,
        max_bin=63,
        feature_fraction=0.8,
        bagging_fraction=0.85,
        bagging_freq=1,
        reg_lambda=8.0,
        reg_alpha=2.0,
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
    )
    model.fit(x, y, group=groups)
    return model


def predict_scores(model: lgb.LGBMRanker, cases: Sequence[Case]) -> list[np.ndarray]:
    return [np.asarray(model.booster_.predict(case.features)) for case in cases]


def selected_index(case: Case, scores: np.ndarray, threshold: float) -> int:
    best = max(
        range(len(scores)),
        key=lambda index: (scores[index], index == case.current_index, index),
    )
    return best if (
        best != case.current_index
        and scores[best] - scores[case.current_index] >= threshold
    ) else case.current_index


def summarize(
    cases: Sequence[Case],
    scores: Sequence[np.ndarray],
    threshold: float,
) -> dict[str, Any]:
    old_hits = 0
    new_hits = 0
    gains = 0
    losses = 0
    changes = 0
    by_dataset: dict[str, list[tuple[bool, bool]]] = {}
    for case, values in zip(cases, scores):
        truth = int(case.source["truthYear"])
        old_start = int(case.starts[case.current_index])
        old_hit = old_start <= truth <= old_start + WINDOW_WIDTH - 1
        index = selected_index(case, values, threshold)
        new_start = int(case.starts[index])
        new_hit = new_start <= truth <= new_start + WINDOW_WIDTH - 1
        changed = index != case.current_index
        old_hits += old_hit
        new_hits += new_hit
        gains += changed and not old_hit and new_hit
        losses += changed and old_hit and not new_hit
        changes += changed
        by_dataset.setdefault(case.dataset, []).append((old_hit, new_hit))
    return {
        "cases": len(cases),
        "oldHits": old_hits,
        "newHits": new_hits,
        "delta": new_hits - old_hits,
        "gains": gains,
        "losses": losses,
        "changes": changes,
        "byDataset": {
            name: {
                "cases": len(values),
                "oldHits": sum(old for old, _ in values),
                "newHits": sum(new for _, new in values),
            }
            for name, values in sorted(by_dataset.items())
        },
    }


def configurations() -> list[Configuration]:
    return [
        Configuration(feature_set, label_kind, leaves, depth, minimum, estimators)
        for feature_set in ("cf", "cfLocator")
        for label_kind in ("binary", "central")
        for leaves, depth in ((5, 3), (9, 4))
        for minimum in (30, 60)
        for estimators in (50, 100)
    ]


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--report", default=".tmp-unit-multicontext-mode-ranker-report.json")
    parser.add_argument("--model", default=".tmp-unit-multicontext-mode-ranker-model.json")
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()
    paths = {
        "train": parse_paths(args.train),
        "calibration": parse_paths(args.calibration),
    }
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    bundle: dict[str, Any] = {"version": 1, "eventTypes": {}}

    for event_type in EVENT_TYPES:
        prepared: dict[tuple[str, str], dict[str, list[Case]]] = {}
        map_names_by_set = {
            feature_set: discover_map_names(
                [*paths["train"], *paths["calibration"]], event_type, feature_set
            )
            for feature_set in ("cf", "cfLocator")
        }
        for feature_set in ("cf", "cfLocator"):
            for label_kind in ("binary", "central"):
                prepared[(feature_set, label_kind)] = {
                    dataset: load_cases(
                        dataset_paths,
                        dataset,
                        event_type,
                        feature_set,
                        label_kind,
                        map_names_by_set[feature_set],
                    )
                    for dataset, dataset_paths in paths.items()
                }
        candidates = []
        for configuration in configurations():
            datasets = prepared[(configuration.feature_set, configuration.label_kind)]
            train = datasets["train"]
            groups = np.asarray([case.group for case in train])
            splitter = GroupKFold(n_splits=min(args.folds, len(set(groups))))
            oof_scores: list[np.ndarray | None] = [None] * len(train)
            fold_indexes = []
            for fold, (fit_indexes, test_indexes) in enumerate(
                splitter.split(np.arange(len(train)), groups=groups)
            ):
                model = fit_model(
                    [train[index] for index in fit_indexes],
                    configuration,
                    20260803 + fold,
                )
                scores = predict_scores(model, [train[index] for index in test_indexes])
                for index, values in zip(test_indexes, scores):
                    oof_scores[int(index)] = values
                fold_indexes.append([int(index) for index in test_indexes])
            complete_oof = [values for values in oof_scores if values is not None]
            if len(complete_oof) != len(train):
                continue
            model = fit_model(train, configuration, 20260813)
            calibration_scores = predict_scores(model, datasets["calibration"])
            positive_margins = sorted({
                max(values) - values[case.current_index]
                for case, values in zip(train, complete_oof)
                if max(values) > values[case.current_index]
            })
            thresholds = sorted({
                0.0,
                *[
                    positive_margins[round((len(positive_margins) - 1) * fraction)]
                    for fraction in (0.25, 0.5, 0.65, 0.75, 0.85, 0.9, 0.95)
                    if positive_margins
                ],
            })
            for threshold in thresholds:
                oof = summarize(train, complete_oof, threshold)
                folds = [summarize(
                    [train[index] for index in indexes],
                    [complete_oof[index] for index in indexes],
                    threshold,
                ) for indexes in fold_indexes]
                calibration = summarize(
                    datasets["calibration"], calibration_scores, threshold
                )
                score = (
                    min(row["delta"] for row in folds),
                    min(oof["delta"], calibration["delta"]),
                    calibration["delta"],
                    oof["delta"],
                    -calibration["losses"],
                    -oof["losses"],
                    -oof["changes"],
                )
                candidates.append({
                    "configuration": configuration,
                    "model": model,
                    "threshold": threshold,
                    "selectionScore": score,
                    "oof": oof,
                    "folds": folds,
                    "calibration": calibration,
                })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        selected = candidates[0]
        configuration = selected["configuration"]
        map_names = map_names_by_set[configuration.feature_set]
        report["eventTypes"][event_type] = {
            "selected": {
                "configuration": configuration.name,
                "threshold": selected["threshold"],
                "featureCount": len(feature_names(map_names)),
                "mapNames": map_names,
                "selectionScore": selected["selectionScore"],
                "oof": selected["oof"],
                "folds": selected["folds"],
                "calibration": selected["calibration"],
            },
            "runnerUp": [{
                "configuration": row["configuration"].name,
                "threshold": row["threshold"],
                "selectionScore": row["selectionScore"],
                "oof": row["oof"],
                "folds": row["folds"],
                "calibration": row["calibration"],
            } for row in candidates[:20]],
        }
        bundle["eventTypes"][event_type] = {
            "configuration": configuration.name,
            "threshold": selected["threshold"],
            "mapNames": list(map_names),
            "featureNames": feature_names(map_names),
            "model": selected["model"].booster_.dump_model(),
        }
        print(json.dumps({event_type: report["eventTypes"][event_type]["selected"]}))

    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.model).write_text(json.dumps(bundle, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
