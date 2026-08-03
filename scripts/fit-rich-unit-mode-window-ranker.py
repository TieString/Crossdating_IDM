"""Fit file-grouped 13-year mode rankers from virtual unit-event corrections.

The input is an experimental JSON array produced from fixed-window benchmark
audits. Each row contains the current main window and a wider coarse window
whose years have virtual insert/delete correction features. Validation and
reserved rows are report-only; model selection uses grouped OOF train results
and the file-disjoint calibration split.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


WINDOW_WIDTH = 13
HALF_WIDTH = WINDOW_WIDTH // 2
EVENT_TYPES = ("missingRing", "falseRing")

FALSE_N24 = (
    "differencePredictiveWeightedHuber61",
    "differenceReferenceWeightedHuber61",
    "whitenedPredictiveMedianHuber31",
    "differencePredictiveEnsembleHuber31",
    "differenceReferenceMedianHuber21",
    "rawReferenceWeightedR21",
    "whitenedReferenceMedianR31",
    "differencePredictiveEnsembleHuber61",
    "whitenedPredictiveWeightedHuber61",
    "rawMasterR31",
    "differencePredictiveMedianHuber31",
    "whitenedPredictiveMedianHuber21",
    "differenceReferenceMedianHuber61",
    "differencePredictiveMedianHuber21",
    "differencePredictiveMedianHuber61",
    "differencePredictiveWeightedHuber31",
    "rawReferenceTrimmedR21",
    "whitenedPredictiveMedianHuber61",
    "differenceMasterR31",
    "differenceReferenceMedianR31",
    "rawMasterR61",
    "rawReferenceMeanR21",
    "rawReferenceWeightedR31",
    "rawReferenceWeightedR61",
)


@dataclass(frozen=True)
class WindowCase:
    source: dict[str, Any]
    features: np.ndarray
    labels: np.ndarray
    starts: np.ndarray
    group: str
    dataset: str


def normalize(values: np.ndarray) -> np.ndarray:
    scale = float(np.std(values))
    return (values - float(np.mean(values))) / (scale if scale > 1e-8 else 1.0)


def dense_rank(values: np.ndarray) -> np.ndarray:
    order = np.lexsort((-np.arange(len(values)), -values))
    ranks = np.empty(len(values), dtype=np.float32)
    ranks[order] = np.arange(len(values), dtype=np.float32)
    return ranks / max(1, len(values) - 1)


def bounded_window(center: float, coarse: Sequence[int]) -> tuple[int, int]:
    start = round(center) - HALF_WIDTH
    end = start + WINDOW_WIDTH - 1
    if start < coarse[0]:
        end += coarse[0] - start
        start = coarse[0]
    if end > coarse[1]:
        start -= end - coarse[1]
        end = coarse[1]
    return int(start), int(end)


def dataset_name(source: dict[str, Any]) -> str:
    if "reserved-rich" in str(source.get("sourceAudit", "")):
        return "reserved"
    return str(source["split"])


def point_feature_sets(source: dict[str, Any]) -> dict[str, tuple[str, ...]]:
    all_names = tuple(sorted(source["rows"][0]["features"]))
    common = tuple(name for name in all_names if "Boundary" not in name)
    boundary = tuple(name for name in all_names if "Boundary" in name)
    n24 = tuple(name for name in FALSE_N24 if name in common)
    return {
        "n24": n24,
        "all93": common,
        "difference": tuple(name for name in common if name.startswith("difference")),
        "boundary": boundary,
        "differenceBoundary": tuple(
            name for name in boundary if name.startswith("difference")
        ),
        "n24Boundary": tuple(dict.fromkeys([*n24, *boundary])),
    }


def aggregate_profile(
    values: np.ndarray,
    index: int,
) -> tuple[float, ...]:
    window = values[index:index + WINDOW_WIDTH]
    older = float(np.mean(window[:3]))
    newer = float(np.mean(window[-3:]))
    before_values = values[max(0, index - 3):index]
    after_values = values[index + WINDOW_WIDTH:index + WINDOW_WIDTH + 3]
    before = float(np.mean(before_values)) if len(before_values) else older
    after = float(np.mean(after_values)) if len(after_values) else newer
    return (
        float(np.mean(window)),
        float(np.max(window)),
        float(np.min(window)),
        float(window[HALF_WIDTH]),
        older,
        newer,
        newer - older,
        older - before,
        after - newer,
    )


def feature_names(point_names: Sequence[str]) -> list[str]:
    aggregates = (
        "mean", "maximum", "minimum", "center", "older3", "newer3",
        "flankDelta", "enterDelta", "exitDelta",
    )
    result = [
        f"{transform}:{aggregate}:{name}"
        for name in point_names
        for transform in ("zscore", "rank")
        for aggregate in aggregates
    ]
    return [
        *result,
        "relativeStart",
        "relativeCenter",
        "currentCenterSigned",
        "currentCenterDistance",
        "currentWindowOverlap",
        "sourceCurrentCenter",
        "containsCurrentTop",
        "currentTopDistance",
        "containsOperationTop",
        "operationTopDistance",
        "containsSideTop",
        "sideTopDistance",
        "operationDifferenceGain",
        "operationRemoteMargin",
        "sideStepScore",
        "sideStepRemoteMargin",
        "oldWidth7",
        "oldWidth9",
        "oldWidth13",
        "signalStrength",
        "positionOlderEdge",
        "positionOlderInterior",
        "positionMiddle",
        "positionNewerInterior",
        "positionNewerEdge",
    ]


def build_case(
    source: dict[str, Any],
    point_names: Sequence[str],
    label_type: str,
) -> WindowCase | None:
    rows = source["rows"]
    years = np.asarray([row["year"] for row in rows], dtype=int)
    if len(years) < WINDOW_WIDTH or np.any(np.diff(years) != 1):
        return None
    coarse = source["coarseRange"]
    current_range = source["primaryRange"]
    if not current_range:
        return None
    current_center = (current_range[0] + current_range[1]) / 2
    current_start, current_end = bounded_window(current_center, coarse)
    current_top = source.get("primaryTopYear")
    operation_top = source.get("operationBestYear")
    side_top = source.get("sideStepBestYear")
    old_width = current_range[1] - current_range[0] + 1
    span = max(1, coarse[1] - coarse[0])
    position = str(source.get("positionStratum") or "")
    profiles: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for name in point_names:
        values = np.asarray([row["features"][name] for row in rows], dtype=np.float32)
        profiles[name] = (normalize(values), 1 - dense_rank(values))
    matrix = []
    starts = []
    labels = []
    truth = int(source["truthYear"])
    for index in range(len(years) - WINDOW_WIDTH + 1):
        start = int(years[index])
        end = int(years[index + WINDOW_WIDTH - 1])
        center = start + HALF_WIDTH
        values: list[float] = []
        for name in point_names:
            for profile in profiles[name]:
                values.extend(aggregate_profile(profile, index))
        overlap = max(0, min(end, current_end) - max(start, current_start) + 1)
        values.extend((
            (start - coarse[0]) / span,
            (center - coarse[0]) / span,
            (center - current_center) / span,
            abs(center - current_center) / span,
            overlap / WINDOW_WIDTH,
            float(start == current_start),
            float(current_top is not None and start <= current_top <= end),
            1.0 if current_top is None else abs(center - current_top) / span,
            float(operation_top is not None and start <= operation_top <= end),
            1.0 if operation_top is None else abs(center - operation_top) / span,
            float(side_top is not None and start <= side_top <= end),
            1.0 if side_top is None else abs(center - side_top) / span,
            float(source.get("operationBestDifferenceGain") or 0),
            float(source.get("operationRemoteDifferenceMargin") or 0),
            float(source.get("sideStepBestScore") or 0),
            float(source.get("sideStepRemoteMargin") or 0),
            float(old_width == 7),
            float(old_width == 9),
            float(old_width == 13),
            float(source.get("signalStrength") or 0),
            float(position == "olderEdge"),
            float(position == "olderInterior"),
            float(position == "middle"),
            float(position == "newerInterior"),
            float(position == "newerEdge"),
        ))
        distance = abs(center - truth)
        labels.append(
            int(start <= truth <= end)
            if label_type == "binary"
            else max(0, HALF_WIDTH + 1 - distance)
        )
        matrix.append(values)
        starts.append(start)
    return WindowCase(
        source=source,
        features=np.asarray(matrix, dtype=np.float32),
        labels=np.asarray(labels, dtype=int),
        starts=np.asarray(starts, dtype=int),
        group=str(source["file"]).lower(),
        dataset=dataset_name(source),
    )


def make_ranker(seed: int, label_type: str) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1] if label_type == "binary" else [0, 1, 3, 7, 15, 31, 63, 127],
        n_estimators=70,
        learning_rate=0.025,
        num_leaves=7,
        max_depth=3,
        min_child_samples=100,
        max_bin=63,
        reg_lambda=20,
        reg_alpha=4,
        colsample_bytree=0.7,
        subsample=0.85,
        subsample_freq=1,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def fit(cases: Sequence[WindowCase], seed: int, label_type: str) -> lgb.LGBMRanker:
    model = make_ranker(seed, label_type)
    model.fit(
        np.concatenate([case.features for case in cases]),
        np.concatenate([case.labels for case in cases]),
        group=[len(case.starts) for case in cases],
    )
    return model


def predict(model: Any, cases: Sequence[WindowCase]) -> list[tuple[int, int]]:
    result = []
    for case in cases:
        scores = model.predict(case.features)
        index = max(range(len(scores)), key=lambda row: (scores[row], case.starts[row]))
        start = int(case.starts[index])
        result.append((start, start + WINDOW_WIDTH - 1))
    return result


def current_predictions(cases: Sequence[WindowCase]) -> list[tuple[int, int]]:
    return [bounded_window(
        (case.source["primaryRange"][0] + case.source["primaryRange"][1]) / 2,
        case.source["coarseRange"],
    ) for case in cases]


def summarize(
    cases: Sequence[WindowCase],
    predictions: Sequence[tuple[int, int]],
) -> dict[str, Any]:
    hits = []
    current_hits = []
    gains = losses = 0
    by_dataset: dict[str, list[bool]] = {}
    for case, prediction, current in zip(cases, predictions, current_predictions(cases)):
        truth = int(case.source["truthYear"])
        hit = prediction[0] <= truth <= prediction[1]
        old_hit = current[0] <= truth <= current[1]
        hits.append(hit)
        current_hits.append(old_hit)
        gains += int(hit and not old_hit)
        losses += int(old_hit and not hit)
        by_dataset.setdefault(case.dataset, []).append(hit)
    return {
        "cases": len(cases),
        "coverage": sum(hits) / max(1, len(hits)),
        "currentCoverage": sum(current_hits) / max(1, len(current_hits)),
        "delta": sum(hits) - sum(current_hits),
        "gains": gains,
        "losses": losses,
        "byDataset": {
            name: {
                "cases": len(values),
                "coverage": sum(values) / max(1, len(values)),
            }
            for name, values in sorted(by_dataset.items())
        },
    }


def grouped_oof(
    cases: Sequence[WindowCase],
    label_type: str,
    folds: int,
) -> tuple[list[tuple[int, int]], list[dict[str, Any]]]:
    groups = np.asarray([case.group for case in cases])
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    predictions: list[tuple[int, int] | None] = [None] * len(cases)
    reports = []
    for fold, (fit_indexes, test_indexes) in enumerate(
        splitter.split(np.arange(len(cases)), groups=groups)
    ):
        fit_cases = [cases[index] for index in fit_indexes]
        test_cases = [cases[index] for index in test_indexes]
        model = fit(fit_cases, 20260830 + fold, label_type)
        selected = predict(model, test_cases)
        for index, prediction in zip(test_indexes, selected):
            predictions[int(index)] = prediction
        reports.append({"fold": fold, **summarize(test_cases, selected)})
    return [row for row in predictions if row is not None], reports


def compact_tree(node: dict[str, Any]) -> dict[str, Any]:
    if "leaf_value" in node:
        return {"leaf_value": node["leaf_value"]}
    return {
        "split_feature": node["split_feature"],
        "threshold": node["threshold"],
        "decision_type": node["decision_type"],
        "default_left": node["default_left"],
        "left_child": compact_tree(node["left_child"]),
        "right_child": compact_tree(node["right_child"]),
    }


def compact_model(model: lgb.LGBMRanker) -> dict[str, Any]:
    dumped = model.booster_.dump_model()
    return {
        "tree_info": [
            {"tree_structure": compact_tree(row["tree_structure"])}
            for row in dumped["tree_info"]
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default=".tmp-unit-coarse-window-year-dataset.json")
    parser.add_argument("--report", default=".tmp-rich-unit-mode-window-report.json")
    parser.add_argument("--model", default=".tmp-rich-unit-mode-window-model.json")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--feature-sets", default="n24,difference,all93")
    parser.add_argument("--labels", default="binary,central")
    parser.add_argument("--events", default=",".join(EVENT_TYPES))
    args = parser.parse_args()

    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    available_sets = point_feature_sets(raw[0])
    requested_sets = [name for name in args.feature_sets.split(",") if name in available_sets]
    requested_labels = [name for name in args.labels.split(",") if name in ("binary", "central")]
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    bundle: dict[str, Any] = {"version": 1, "eventTypes": {}}

    requested_events = [
        name for name in args.events.split(",") if name in EVENT_TYPES
    ]
    for event_type in requested_events:
        candidates = []
        prepared: dict[tuple[str, str], dict[str, list[WindowCase]]] = {}
        for feature_set in requested_sets:
            point_names = available_sets[feature_set]
            for label_type in requested_labels:
                cases = [
                    case
                    for source in raw
                    if source["eventType"] == event_type
                    for case in [build_case(source, point_names, label_type)]
                    if case is not None
                ]
                datasets = {
                    name: [case for case in cases if case.dataset == name]
                    for name in ("train", "calibration", "validation", "reserved")
                }
                prepared[(feature_set, label_type)] = datasets
                oof_predictions, folds = grouped_oof(
                    datasets["train"], label_type, args.folds
                )
                oof = summarize(datasets["train"], oof_predictions)
                model = fit(datasets["train"], 20260840, label_type)
                calibration = summarize(
                    datasets["calibration"], predict(model, datasets["calibration"])
                )
                score = (
                    min(min(row["delta"] for row in folds), calibration["delta"]),
                    min(row["coverage"] for row in folds),
                    calibration["coverage"],
                    oof["coverage"],
                )
                candidates.append({
                    "featureSet": feature_set,
                    "labelType": label_type,
                    "pointNames": point_names,
                    "oof": oof,
                    "folds": folds,
                    "calibration": calibration,
                    "selectionScore": score,
                })
                print(json.dumps({
                    "eventType": event_type,
                    "featureSet": feature_set,
                    "labelType": label_type,
                    "oof": oof,
                    "calibration": calibration,
                }))
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        selected = candidates[0]
        datasets = prepared[(selected["featureSet"], selected["labelType"])]
        final_model = fit(
            [*datasets["train"], *datasets["calibration"]],
            20260841,
            selected["labelType"],
        )
        final = {
            name: summarize(rows, predict(final_model, rows))
            for name, rows in datasets.items()
            if rows
        }
        report["eventTypes"][event_type] = {
            "selected": {
                key: value for key, value in selected.items()
                if key not in ("pointNames",)
            },
            "final": final,
            "runnerUp": [
                {key: value for key, value in row.items() if key != "pointNames"}
                for row in candidates[:6]
            ],
        }
        bundle["eventTypes"][event_type] = {
            "pointFeatureNames": selected["pointNames"],
            "featureNames": feature_names(selected["pointNames"]),
            "windowWidth": WINDOW_WIDTH,
            "labelType": selected["labelType"],
            "training": {
                "trainCases": len(datasets["train"]),
                "calibrationCases": len(datasets["calibration"]),
            },
            "model": compact_model(final_model),
        }
        print(json.dumps({"selected": event_type, **report["eventTypes"][event_type]}))

    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.model).write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
