"""Fit an operation-agnostic ranker over the dynamic -2..-100 shift grid."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


INPUT_DIR = Path(os.environ.get(
    "PARTIAL_SHIFT_AUDIT_DIR",
    ".tmp-window-holdout-v124",
))
OUTPUT_PATH = Path(os.environ.get(
    "PARTIAL_SHIFT_REPORT_PATH",
    ".tmp-dynamic-partial-shift-ranker-report.json",
))
OFFSETS = tuple(int(value) for value in os.environ.get(
    "PARTIAL_SHIFT_OFFSETS",
    "18,19,20,21,22",
).split(","))
TRAIN_OFFSETS = set(OFFSETS[:3])
CALIBRATION_OFFSETS = set(OFFSETS[3:4])
VALIDATION_OFFSETS = set(OFFSETS[4:])

SUMMARY_FIELDS = (
    "rawGain",
    "differenceGain",
    "combinedGain",
    "sideStepScore",
    "sideMinimumAdvantage",
    "correctedSideSupport",
    "transitionSplitGain",
    "transitionNormalizedSplitGain",
    "transitionBalancedAdvantage",
    "transitionLocalGain31",
    "transitionLocalBalancedAdvantage31",
)


def finite(value: Any) -> float:
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return 0.0
    return converted if math.isfinite(converted) else 0.0


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def summarize(values: list[float]) -> list[float]:
    if not values:
        return [0.0] * 8
    ordered = sorted((finite(value) for value in values), reverse=True)
    center = mean(ordered)
    return [
        ordered[0],
        mean(ordered[:3]),
        mean(ordered[:7]),
        float(np.percentile(ordered, 50)),
        float(np.percentile(ordered, 75)),
        float(np.percentile(ordered, 90)),
        center,
        math.sqrt(mean((value - center) ** 2 for value in ordered)),
    ]


def base_features(operation: dict[str, Any]) -> list[float]:
    rows = operation.get("rows", [])
    best_year = finite(operation.get("bestYear"))
    side_year = finite(operation.get("sideStepBestYear"))
    result = [
        finite(operation.get("bestRawGain")),
        finite(operation.get("bestDifferenceGain")),
        finite(operation.get("bestCombinedGain")),
        finite(operation.get("topThreeDifferenceGain")),
        finite(operation.get("remoteDifferenceMargin")),
        finite(operation.get("bestSideStepScore")),
        finite(operation.get("topThreeSideStepScore")),
        finite(operation.get("bestSideMinimumAdvantage")),
        finite(operation.get("bestCorrectedSideSupport")),
        finite(operation.get("sideStepRemoteMargin")),
        finite(operation.get("baselineLag")),
        abs(best_year - side_year) / 25,
        finite(operation.get("rowCount", len(rows))) / 250,
        finite(operation.get("bestSamplePairs")) / 250,
        finite(operation.get("bestDifferencePairs")) / 250,
    ]
    for field in SUMMARY_FIELDS:
        result.extend(summarize([
            finite(row.get(field))
            for row in rows
            if row.get(field) is not None
        ]))
    transition_best = max(
        rows,
        key=lambda row: finite(row.get("transitionSplitGain")),
        default=None,
    )
    result.extend([
        (
            abs(best_year - finite(transition_best.get("year"))) / 25
            if transition_best
            else 4.0
        ),
        finite(transition_best.get("transitionSplitGain"))
        if transition_best else 0.0,
    ])
    return result


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values))
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = ((start + end - 1) / 2) / max(1, len(order) - 1)
        result[order[start:end]] = rank
        start = end
    return result


def case_features(
    operations: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], np.ndarray]:
    partial = [
        operation for operation in operations
        if int(operation.get("shiftYears", 0)) <= -2
    ]
    base = np.asarray([base_features(operation) for operation in partial])
    centers = base.mean(axis=0)
    scales = base.std(axis=0)
    scales[scales < 1e-9] = 1
    ranks = np.stack([
        percentile_ranks(base[:, index])
        for index in range(base.shape[1])
    ], axis=1)
    maxima = base.max(axis=0)
    normalized = (base - centers) / scales
    features = np.concatenate([
        base,
        normalized,
        ranks,
        base - maxima,
    ], axis=1)
    return partial, features


def dynamic_score(
    operation: dict[str, Any],
    operations: list[dict[str, Any]],
) -> float:
    def base(candidate: dict[str, Any]) -> float:
        return (
            finite(candidate.get("topThreeDifferenceGain")) * 0.4
            + finite(candidate.get("bestDifferenceGain")) * 0.25
            + finite(candidate.get("bestCombinedGain")) * 0.2
            + finite(candidate.get("remoteDifferenceMargin")) * 0.15
        )

    value = base(operation)
    shift = int(operation["shiftYears"])
    neighbors = [
        candidate for candidate in operations
        if candidate is not operation
        and int(candidate.get("shiftYears", 0)) <= -2
        and abs(int(candidate["shiftYears"]) - shift) <= 2
    ]
    return value if not neighbors else (
        value + (value - mean(base(candidate) for candidate in neighbors)) * 0.2
    )


def load_cases() -> list[dict[str, Any]]:
    cases = []
    for offset in OFFSETS:
        path = INPUT_DIR / f"offset-{offset}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("jointOperationAuditCases", []):
            if source.get("caseType") != "injected":
                continue
            if source.get("truthEventType") != "partialMove":
                continue
            truth_shift = source.get("truthShiftYears")
            operations, features = case_features(source.get("operations", []))
            truth_index = next(
                (
                    index for index, operation in enumerate(operations)
                    if operation.get("shiftYears") == truth_shift
                ),
                None,
            )
            if truth_index is None:
                continue
            cases.append({
                "offset": offset,
                "truthShiftYears": truth_shift,
                "operations": operations,
                "features": features,
                "truthIndex": truth_index,
            })
    return cases


def topk_metrics(
    cases: list[dict[str, Any]],
    score_rows: list[np.ndarray],
) -> dict[str, Any]:
    ranks = []
    predicted = []
    for case, scores in zip(cases, score_rows):
        order = np.argsort(scores)[::-1]
        rank = int(np.where(order == case["truthIndex"])[0][0]) + 1
        ranks.append(rank)
        predicted.append(
            int(case["operations"][int(order[0])]["shiftYears"]),
        )
    return {
        "cases": len(cases),
        "top1": mean(rank <= 1 for rank in ranks),
        "top3": mean(rank <= 3 for rank in ranks),
        "top8": mean(rank <= 8 for rank in ranks),
        "medianRank": float(np.median(ranks)) if ranks else None,
        "byShift": {
            str(shift): {
                "cases": len(indexes),
                "top1": mean(
                    predicted[index] == shift
                    for index in indexes
                ),
                "top3": mean(ranks[index] <= 3 for index in indexes),
                "top8": mean(ranks[index] <= 8 for index in indexes),
            }
            for shift in sorted(set(
                int(case["truthShiftYears"]) for case in cases
            ))
            if (indexes := [
                index for index, case in enumerate(cases)
                if case["truthShiftYears"] == shift
            ])
        },
    }


def hard_pairwise_rows(
    cases: list[dict[str, Any]],
) -> tuple[np.ndarray, np.ndarray]:
    features = []
    labels = []
    for case in cases:
        truth = case["features"][case["truthIndex"]]
        operations = case["operations"]
        dynamic = np.asarray([
            dynamic_score(operation, operations)
            for operation in operations
        ])
        hard = set(np.argsort(dynamic)[-20:].tolist())
        truth_shift = int(case["truthShiftYears"])
        hard.update(
            index for index, operation in enumerate(operations)
            if abs(int(operation["shiftYears"]) - truth_shift) <= 3
        )
        hard.discard(case["truthIndex"])
        for index in hard:
            difference = truth - case["features"][index]
            features.extend([difference, -difference])
            labels.extend([1, 0])
    return np.asarray(features), np.asarray(labels, dtype=int)


def model_options() -> list[tuple[str, Any]]:
    result: list[tuple[str, Any]] = []
    for regularization in (0.01, 0.03, 0.1, 0.3, 1.0):
        result.append((
            f"pairwise_logistic_{regularization}",
            make_pipeline(
                StandardScaler(),
                LogisticRegression(
                    C=regularization,
                    max_iter=5000,
                    random_state=20260730,
                ),
            ),
        ))
    for depth in (2, 3, 4):
        for leaf in (4, 8, 12):
            result.extend([
                (
                    f"forest_d{depth}_l{leaf}",
                    RandomForestClassifier(
                        n_estimators=320,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features=0.7,
                        class_weight="balanced",
                        random_state=20260730,
                    ),
                ),
                (
                    f"extra_d{depth}_l{leaf}",
                    ExtraTreesClassifier(
                        n_estimators=320,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features=0.7,
                        class_weight="balanced",
                        random_state=20260730,
                    ),
                ),
            ])
    return result


def main() -> None:
    cases = load_cases()
    split_cases = {
        "train": [case for case in cases if case["offset"] in TRAIN_OFFSETS],
        "calibration": [
            case for case in cases
            if case["offset"] in CALIBRATION_OFFSETS
        ],
        "validation": [
            case for case in cases
            if case["offset"] in VALIDATION_OFFSETS
        ],
    }
    baseline = {
        split: topk_metrics(
            selected,
            [
                np.asarray([
                    dynamic_score(operation, case["operations"])
                    for operation in case["operations"]
                ])
                for case in selected
            ],
        )
        for split, selected in split_cases.items()
    }
    options = []
    for name, model in model_options():
        training = split_cases["train"]
        if name.startswith("pairwise"):
            train_x, train_y = hard_pairwise_rows(training)
            model.fit(train_x, train_y)
            scorer = lambda case: model.decision_function(case["features"])
        else:
            train_x = np.concatenate([
                case["features"] for case in training
            ])
            train_y = np.concatenate([
                np.asarray([
                    int(index == case["truthIndex"])
                    for index in range(len(case["operations"]))
                ])
                for case in training
            ])
            model.fit(train_x, train_y)
            scorer = lambda case: model.predict_proba(case["features"])[:, 1]
        metrics = {
            split: topk_metrics(
                selected,
                [np.asarray(scorer(case)) for case in selected],
            )
            for split, selected in split_cases.items()
        }
        options.append({"name": name, **metrics})
    options.sort(
        key=lambda row: (
            row["calibration"]["top1"],
            row["validation"]["top1"],
            row["calibration"]["top3"],
            row["validation"]["top3"],
        ),
        reverse=True,
    )
    report = {
        "inputDirectory": str(INPUT_DIR),
        "offsets": OFFSETS,
        "splits": {
            "train": sorted(TRAIN_OFFSETS),
            "calibration": sorted(CALIBRATION_OFFSETS),
            "validation": sorted(VALIDATION_OFFSETS),
        },
        "featureCount": (
            int(cases[0]["features"].shape[1])
            if cases else 0
        ),
        "baseline": baseline,
        "selected": options[0] if options else None,
        "options": options,
    }
    OUTPUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "baseline": baseline,
        "selected": report["selected"],
    }, indent=2))


if __name__ == "__main__":
    main()
