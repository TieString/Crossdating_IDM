"""Fit file-grouped coarse-candidate rankers for missing and false rings."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


EVENT_TYPES = ("missingRing", "falseRing")
SOURCE_NAMES = (
    "current_event",
    "joint_counterfactual_operation",
    "lag_transition",
    "profile:cumulativeCombined",
    "profile:differenceFull",
    "reference_transition:rankMean",
    "reference_transition:rankMedian",
    "reference_transition:weightedRankMean",
    "reference_transition:peakKernel5",
    "reference_transition:peakKernel9",
    "reference_transition:peakKernel13",
    "reference_transition:windowVote25",
    "reference_transition:weightedWindowVote25",
)
CORE_PROFILES = (
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "differenceFull",
    "comboFull",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
)
FULL_PROFILES = (
    *CORE_PROFILES,
    "whitenedFull",
    "pairDifferenceWeighted",
    "reference:weightedRankMean",
    "reference:weightedWindowVote25",
    "sideStepScore",
    "correctedSideSupport",
)


@dataclass(frozen=True)
class PreparedCase:
    source: dict[str, Any]
    candidates: tuple[dict[str, Any], ...]
    features: np.ndarray
    labels: np.ndarray
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


def standard_deviation(values: Sequence[float]) -> float:
    average = mean(values)
    return math.sqrt(mean((value - average) ** 2 for value in values))


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


def source_family(source: str) -> str:
    if source == "current_event":
        return "current"
    if source == "joint_counterfactual_operation":
        return "operation"
    if source == "lag_transition":
        return "lag"
    if source.startswith("profile:"):
        return "profile"
    if source.startswith("reference_transition:"):
        return "reference"
    return "other"


def expanded_window(event_type: str, candidate: dict[str, Any]) -> tuple[int, int]:
    expansion = 2 if event_type == "falseRing" else 0
    return (
        int(candidate["startYear"]) - expansion,
        int(candidate["endYear"]) + expansion,
    )


def feature_names(profiles: Sequence[str]) -> list[str]:
    base = [
        "aggregateScore",
        "aggregateRank",
        "overlapConsensus",
        "overlapRank",
        "rawScorePresent",
        "rawScoreRank",
        "rawScoreZ",
        "currentSigned",
        "currentDistance",
        "operationSigned",
        "operationDistance",
        "sideSigned",
        "sideDistance",
        "containsCurrent",
        "containsOperation",
        "containsSide",
        "centerMedianSigned",
        "centerMedianDistance",
        "centerMeanSigned",
        "agreement2",
        "agreement4",
        "agreement8",
        "agreement12",
        "meanWindowOverlap",
        "maximumWindowOverlap",
        "chronologicalPosition",
        *[f"source:{name}" for name in SOURCE_NAMES],
        *[f"family:{name}" for name in (
            "current", "operation", "lag", "profile", "reference", "other"
        )],
    ]
    return [
        *base,
        *[
            f"profile:{profile}:{statistic}"
            for profile in profiles
            for statistic in ("mean", "maximum", "center", "peakDistance")
        ],
    ]


def candidate_features(
    source: dict[str, Any],
    candidates: Sequence[dict[str, Any]],
    profiles: Sequence[str],
) -> np.ndarray:
    years = [int(year) for year in source.get("years", [])]
    year_indexes = {year: index for index, year in enumerate(years)}
    ranks = source.get("ranks", {})
    centers = [
        (int(candidate["startYear"]) + int(candidate["endYear"])) / 2
        for candidate in candidates
    ]
    ordered_centers = sorted(centers)
    center_median = float(np.median(centers))
    center_mean = mean(centers)
    scale = max(1.0, max(centers) - min(centers))
    operation = source.get("selectedOperation") or {}
    anchors = {
        "current": source.get("currentPrimaryYear"),
        "operation": operation.get("bestYear"),
        "side": operation.get("sideStepBestYear"),
    }
    aggregate = [float(candidate.get("aggregateScore", 0)) for candidate in candidates]
    overlap = [float(candidate.get("overlapConsensus", 0)) for candidate in candidates]
    raw_present = ["score" in candidate for candidate in candidates]
    raw = [float(candidate.get("score", 0)) for candidate in candidates]
    aggregate_ranks = percentile_ranks(aggregate)
    overlap_ranks = percentile_ranks(overlap)
    raw_rank_source = [value if present else min(raw, default=0) for value, present in zip(raw, raw_present)]
    raw_ranks = percentile_ranks(raw_rank_source)
    raw_mean = mean([value for value, present in zip(raw, raw_present) if present])
    raw_sd = max(1e-8, standard_deviation([
        value for value, present in zip(raw, raw_present) if present
    ]))

    profile_values: dict[str, list[float]] = {}
    profile_peak_year: dict[str, int] = {}
    for profile in profiles:
        values = [float(value) for value in ranks.get(profile, [])]
        profile_values[profile] = values
        profile_peak_year[profile] = years[int(np.argmax(values))] if values else years[0]

    rows = []
    for index, candidate in enumerate(candidates):
        start = int(candidate["startYear"])
        end = int(candidate["endYear"])
        center = centers[index]
        candidate_overlaps = []
        for other in candidates:
            other_start = int(other["startYear"])
            other_end = int(other["endYear"])
            intersection = max(0, min(end, other_end) - max(start, other_start) + 1)
            union = max(end, other_end) - min(start, other_start) + 1
            candidate_overlaps.append(intersection / max(1, union))
        values = [
            aggregate[index],
            aggregate_ranks[index],
            overlap[index],
            overlap_ranks[index],
            float(raw_present[index]),
            raw_ranks[index],
            (raw[index] - raw_mean) / raw_sd if raw_present[index] else 0.0,
        ]
        for anchor in anchors.values():
            if anchor is None:
                values.extend((0.0, 1.0))
            else:
                signed = (center - float(anchor)) / scale
                values.extend((signed, abs(signed)))
        for anchor in anchors.values():
            values.append(float(anchor is not None and start <= float(anchor) <= end))
        values.extend((
            (center - center_median) / scale,
            abs(center - center_median) / scale,
            (center - center_mean) / scale,
        ))
        # Keep the four consensus radii explicit to match the feature schema.
        values.extend(mean(abs(center - other) <= distance for other in centers) for distance in (2, 4, 8, 12))
        values.extend((
            mean(candidate_overlaps),
            max(candidate_overlaps),
            ordered_centers.index(center) / max(1, len(ordered_centers) - 1),
        ))
        source_name = str(candidate.get("source", ""))
        values.extend(float(source_name == name) for name in SOURCE_NAMES)
        family = source_family(source_name)
        values.extend(float(family == name) for name in (
            "current", "operation", "lag", "profile", "reference", "other"
        ))
        for profile in profiles:
            available = profile_values[profile]
            inside = [
                available[year_indexes[year]]
                for year in range(start, end + 1)
                if year in year_indexes and year_indexes[year] < len(available)
            ]
            center_index = year_indexes.get(round(center))
            center_value = (
                available[center_index]
                if center_index is not None and center_index < len(available)
                else 0.0
            )
            values.extend((
                mean(inside),
                max(inside, default=0.0),
                center_value,
                abs(center - profile_peak_year[profile]) / scale,
            ))
        rows.append(values)
    return np.asarray(rows, dtype=np.float32)


def labels_for(
    source: dict[str, Any],
    candidates: Sequence[dict[str, Any]],
    event_type: str,
    label_kind: str,
) -> np.ndarray:
    truth = int(source["truthYear"])
    rows = []
    for candidate in candidates:
        start, end = expanded_window(event_type, candidate)
        if label_kind == "binary":
            rows.append(int(start <= truth <= end))
        else:
            center = (start + end) / 2
            radius = (end - start) // 2
            rows.append(max(0, radius + 1 - round(abs(center - truth))))
    return np.asarray(rows, dtype=int)


def load_cases(
    paths: Sequence[Path],
    dataset: str,
    event_type: str,
    profiles: Sequence[str],
    label_kind: str,
) -> list[PreparedCase]:
    result = []
    seen: set[tuple[str, str, int]] = set()
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            if context.get("baselineFlagged", True) or source.get("eventType") != event_type:
                continue
            candidates = tuple(source.get("candidates", []))
            if not candidates:
                continue
            key = (
                str(context.get("file", "")),
                str(context.get("target", "")),
                int(source["truthYear"]),
            )
            if key in seen:
                continue
            seen.add(key)
            compact_source = dict(source)
            compact_source.pop("coarseCandidateCounterfactuals", None)
            result.append(PreparedCase(
                source=compact_source,
                candidates=candidates,
                features=candidate_features(source, candidates, profiles),
                labels=labels_for(source, candidates, event_type, label_kind),
                group=key[0],
                dataset=dataset,
            ))
    return result


def flatten(cases: Sequence[PreparedCase]) -> tuple[np.ndarray, np.ndarray, list[int]]:
    return (
        np.concatenate([case.features for case in cases]),
        np.concatenate([case.labels for case in cases]),
        [len(case.candidates) for case in cases],
    )


def fit_model(
    cases: Sequence[PreparedCase],
    configuration: Configuration,
    seed: int,
) -> lgb.LGBMRanker:
    x, y, groups = flatten(cases)
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
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=1,
        reg_lambda=2.0,
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
    )
    model.fit(x, y, group=groups)
    return model


def predict_case(model: lgb.LGBMRanker, case: PreparedCase) -> int:
    return int(np.argmax(model.booster_.predict(case.features)))


def summarize(cases: Sequence[PreparedCase], indexes: Sequence[int]) -> dict[str, Any]:
    hits = []
    current_hits = []
    oracle_hits = []
    by_dataset: dict[str, list[bool]] = {}
    for case, index in zip(cases, indexes):
        truth = int(case.source["truthYear"])
        start, end = expanded_window(
            str(case.source["eventType"]), case.candidates[index]
        )
        hit = start <= truth <= end
        current = case.source["coarseWindow"]
        current_hit = int(current["startYear"]) <= truth <= int(current["endYear"])
        oracle = any(
            expanded_window(str(case.source["eventType"]), candidate)[0] <= truth
            <= expanded_window(str(case.source["eventType"]), candidate)[1]
            for candidate in case.candidates
        )
        hits.append(hit)
        current_hits.append(current_hit)
        oracle_hits.append(oracle)
        by_dataset.setdefault(case.dataset, []).append(hit)
    return {
        "cases": len(cases),
        "hits": sum(hits),
        "coverage": mean(hits),
        "currentHits": sum(current_hits),
        "currentCoverage": mean(current_hits),
        "delta": sum(hits) - sum(current_hits),
        "oracleHits": sum(oracle_hits),
        "oracleCoverage": mean(oracle_hits),
        "byDataset": {
            name: {"cases": len(values), "hits": sum(values), "coverage": mean(values)}
            for name, values in sorted(by_dataset.items())
        },
    }


def configurations() -> list[Configuration]:
    return [
        Configuration(feature_set, label_kind, leaves, depth, minimum, estimators)
        for feature_set in ("core", "full")
        for label_kind in ("binary", "central")
        for leaves, depth in ((5, 3), (7, 3), (9, 4), (15, 4))
        for minimum in (15, 30, 60)
        for estimators in (50, 100)
    ]


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument("--report", default=".tmp-file-grouped-unit-coarse-report.json")
    parser.add_argument("--model", default=".tmp-file-grouped-unit-coarse-model.json")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument(
        "--events",
        default=",".join(EVENT_TYPES),
        help="Comma-separated subset of missingRing,falseRing",
    )
    args = parser.parse_args()
    selected_event_types = tuple(
        event.strip()
        for event in args.events.split(",")
        if event.strip() in EVENT_TYPES
    )
    if not selected_event_types:
        raise ValueError("--events must include missingRing or falseRing")
    paths = {
        "train": parse_paths(args.train),
        "calibration": parse_paths(args.calibration),
        "validation": parse_paths(args.validation),
    }
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "splitPolicy": "file-disjoint with file-grouped OOF",
        "eventTypes": {},
    }
    bundle = {"version": 1, "eventTypes": {}}

    for event_type in selected_event_types:
        prepared: dict[tuple[str, str], dict[str, list[PreparedCase]]] = {}
        for feature_set, profiles in (("core", CORE_PROFILES), ("full", FULL_PROFILES)):
            for label_kind in ("binary", "central"):
                prepared[(feature_set, label_kind)] = {
                    dataset: load_cases(
                        dataset_paths, dataset, event_type, profiles, label_kind
                    )
                    for dataset, dataset_paths in paths.items()
                }
        rows = []
        for configuration in configurations():
            datasets = prepared[(configuration.feature_set, configuration.label_kind)]
            train = datasets["train"]
            groups = np.asarray([case.group for case in train])
            splitter = GroupKFold(n_splits=min(args.folds, len(set(groups))))
            oof_indexes = [0] * len(train)
            fold_metrics = []
            for fold, (fit_indexes, test_indexes) in enumerate(
                splitter.split(np.arange(len(train)), groups=groups)
            ):
                fit = [train[index] for index in fit_indexes]
                test = [train[index] for index in test_indexes]
                model = fit_model(fit, configuration, 20260802 + fold)
                indexes = [predict_case(model, case) for case in test]
                for index, selected in zip(test_indexes, indexes):
                    oof_indexes[int(index)] = selected
                fold_metrics.append(summarize(test, indexes))
            oof = summarize(train, oof_indexes)
            model = fit_model(train, configuration, 20260802)
            calibration_indexes = [
                predict_case(model, case) for case in datasets["calibration"]
            ]
            calibration = summarize(datasets["calibration"], calibration_indexes)
            worst_fold = min(row["coverage"] for row in fold_metrics)
            score = (
                min(worst_fold, calibration["coverage"]),
                min(oof["delta"], calibration["delta"]),
                mean((oof["coverage"], calibration["coverage"])),
            )
            rows.append({
                "configuration": configuration,
                "model": model,
                "oof": oof,
                "folds": fold_metrics,
                "worstFoldCoverage": worst_fold,
                "calibration": calibration,
                "selectionScore": score,
            })
        rows.sort(key=lambda row: row["selectionScore"], reverse=True)
        selected = rows[0]
        configuration = selected["configuration"]
        datasets = prepared[(configuration.feature_set, configuration.label_kind)]
        final_model = fit_model(
            [*datasets["train"], *datasets["calibration"]],
            configuration,
            20260803,
        )
        validation = datasets["validation"]
        validation_metrics = summarize(
            validation,
            [predict_case(final_model, case) for case in validation],
        ) if validation else None
        profiles = CORE_PROFILES if configuration.feature_set == "core" else FULL_PROFILES
        report["eventTypes"][event_type] = {
            "selected": {
                "configuration": configuration.name,
                "featureCount": len(feature_names(profiles)),
                "oof": selected["oof"],
                "folds": selected["folds"],
                "worstFoldCoverage": selected["worstFoldCoverage"],
                "calibration": selected["calibration"],
                "validation": validation_metrics,
            },
            "runnerUp": [{
                "configuration": row["configuration"].name,
                "worstFoldCoverage": row["worstFoldCoverage"],
                "oof": row["oof"],
                "calibration": row["calibration"],
            } for row in rows[:12]],
        }
        bundle["eventTypes"][event_type] = {
            "featureNames": feature_names(profiles),
            "profiles": list(profiles),
            "expansionYears": 2 if event_type == "falseRing" else 0,
            "training": {
                "configuration": configuration.name,
                "trainCases": len(datasets["train"]),
                "calibrationCases": len(datasets["calibration"]),
                "validationCases": len(validation),
            },
            "model": final_model.booster_.dump_model(),
        }
        print(json.dumps({event_type: report["eventTypes"][event_type]["selected"]}))

    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.model).write_text(json.dumps(bundle, indent=2), encoding="utf-8")
    print(f"Wrote {args.report} and {args.model}")


if __name__ == "__main__":
    main()
