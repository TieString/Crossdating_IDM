"""Evaluate translation-invariant breakpoint regressors inside the coarse window."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import (
    ExtraTreesRegressor,
    GradientBoostingRegressor,
    RandomForestRegressor,
)
from sklearn.linear_model import HuberRegressor, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "event_window_calibration",
    HERE / "calibrate-event-window-policy.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load event-window calibration helpers")
CALIBRATION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CALIBRATION
SPEC.loader.exec_module(CALIBRATION)

OUTPUT_PATH = Path(os.environ.get(
    "EVENT_CENTER_REPORT_PATH",
    ".tmp-event-center-regressor-report.json",
))

EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
CORE_PROFILES = (
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeLocal31",
    "cumulativeLocal61",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "sideStepScore",
    "sideMinimumAdvantage",
    "correctedSideSupport",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "reference:rankMedian",
    "reference:weightedRankMean",
    "reference:weightedWindowVote25",
    "currentPeak",
    "jointPeak",
    "candidateConsensus",
)


def finite(value: Any) -> float:
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return 0.0
    return converted if np.isfinite(converted) else 0.0


def weighted_center(
    positions: np.ndarray,
    values: np.ndarray,
) -> float:
    positive = np.maximum(0, values - np.median(values))
    total = float(positive.sum())
    return float((positions * positive).sum() / total) if total > 1e-9 else 0.5


def profile_features(
    positions: np.ndarray,
    values: np.ndarray,
) -> list[float]:
    order = np.argsort(values)[::-1]
    top_count = min(5, len(order))
    top_positions = positions[order[:top_count]]
    thirds = [
        values[(positions >= start) & (positions <= end)]
        for start, end in ((0, 1 / 3), (1 / 3, 2 / 3), (2 / 3, 1))
    ]
    return [
        float(positions[int(np.argmax(values))]),
        weighted_center(positions, values),
        float(np.mean(top_positions)),
        float(np.std(top_positions)),
        float(np.mean(thirds[0])) - float(np.mean(thirds[2])),
        float(np.max(values) - np.median(values)),
    ]


def case_features(case: dict[str, Any]) -> list[float]:
    coarse = CALIBRATION.available_coarse_bounds(case)
    indexes = [
        index
        for index, year in enumerate(case["years"])
        if coarse["startYear"] <= year <= coarse["endYear"]
    ]
    width = max(1, coarse["endYear"] - coarse["startYear"])
    positions = np.asarray([
        (case["years"][index] - coarse["startYear"]) / width
        for index in indexes
    ])
    features = []
    for profile in CORE_PROFILES:
        values = np.asarray([
            finite(case["ranks"].get(profile, [0] * len(case["years"]))[index])
            for index in indexes
        ])
        features.extend(profile_features(positions, values))

    current = case.get("currentPrimaryYear")
    operation = case.get("selectedOperation") or {}
    joint = operation.get("bestYear")
    candidates = case.get("candidates", [])
    candidate_positions = np.asarray([
        (
            (candidate["startYear"] + candidate["endYear"]) / 2
            - coarse["startYear"]
        ) / width
        for candidate in candidates
    ])
    candidate_weights = np.asarray([
        finite(candidate.get("aggregateScore")) + 0.1
        for candidate in candidates
    ])
    weighted_candidate = (
        float(np.average(candidate_positions, weights=candidate_weights))
        if len(candidate_positions)
        else 0.5
    )
    features.extend([
        0.5 if current is None else (current - coarse["startYear"]) / width,
        0.5 if joint is None else (joint - coarse["startYear"]) / width,
        float(current is not None),
        float(joint is not None),
        weighted_candidate,
        float(np.std(candidate_positions)) if len(candidate_positions) else 0.0,
        (
            float(candidate_positions.max() - candidate_positions.min())
            if len(candidate_positions)
            else 0.0
        ),
        finite(operation.get("topThreeDifferenceGain")),
        finite(operation.get("remoteDifferenceMargin")),
        finite(operation.get("sideStepRemoteMargin")),
        finite(case.get("context", {}).get("referenceCount")) / 20,
        width / 29,
    ])
    return features


def target_position(case: dict[str, Any]) -> float:
    coarse = CALIBRATION.available_coarse_bounds(case)
    width = max(1, coarse["endYear"] - coarse["startYear"])
    return (case["truthYear"] - coarse["startYear"]) / width


def predicted_window(
    case: dict[str, Any],
    relative_position: float,
) -> tuple[int, int]:
    coarse = CALIBRATION.available_coarse_bounds(case)
    width = coarse["endYear"] - coarse["startYear"]
    center = coarse["startYear"] + float(np.clip(relative_position, 0, 1)) * width
    start = max(
        coarse["startYear"],
        min(round(center) - 6, coarse["endYear"] - 12),
    )
    return start, start + 12


def evaluate(
    cases: list[dict[str, Any]],
    model: Any,
) -> dict[str, Any]:
    predictions = model.predict(np.asarray([
        case_features(case)
        for case in cases
    ]))
    windows = [
        predicted_window(case, prediction)
        for case, prediction in zip(cases, predictions)
    ]
    errors = [
        0 if start <= case["truthYear"] <= end else min(
            abs(case["truthYear"] - start),
            abs(case["truthYear"] - end),
        )
        for case, (start, end) in zip(cases, windows)
    ]
    center_errors = [
        abs((start + end) / 2 - case["truthYear"])
        for case, (start, end) in zip(cases, windows)
    ]
    return {
        "cases": len(cases),
        "coverage": float(np.mean(np.asarray(errors) == 0)),
        "withinOne": float(np.mean(np.asarray(errors) <= 1)),
        "medianCenterError": float(np.median(center_errors)),
        "p90CenterError": float(np.percentile(
            center_errors,
            90,
            method="higher",
        )),
    }


def model_options() -> list[tuple[str, Any]]:
    options: list[tuple[str, Any]] = []
    for alpha in (0.3, 1, 3, 10, 30, 100):
        options.append((
            f"ridge_{alpha}",
            make_pipeline(StandardScaler(), Ridge(alpha=alpha)),
        ))
    for epsilon in (1.1, 1.35, 1.7):
        options.append((
            f"huber_{epsilon}",
            make_pipeline(
                StandardScaler(),
                HuberRegressor(
                    epsilon=epsilon,
                    alpha=1,
                    max_iter=2000,
                ),
            ),
        ))
    for depth in (2, 3, 4):
        for leaf in (4, 8, 12):
            options.extend([
                (
                    f"extra_d{depth}_l{leaf}",
                    ExtraTreesRegressor(
                        n_estimators=240,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features=0.65,
                        random_state=20260730,
                    ),
                ),
                (
                    f"forest_d{depth}_l{leaf}",
                    RandomForestRegressor(
                        n_estimators=240,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features=0.65,
                        random_state=20260730,
                    ),
                ),
            ])
    for depth in (1, 2, 3):
        options.append((
            f"huber_boost_d{depth}",
            GradientBoostingRegressor(
                loss="huber",
                n_estimators=80,
                max_depth=depth,
                min_samples_leaf=6,
                learning_rate=0.03,
                random_state=20260730,
            ),
        ))
    return options


def main() -> None:
    cases = CALIBRATION.load_cases()
    for case in cases:
        CALIBRATION.add_synthetic_profiles(case)
    report = {"profiles": CORE_PROFILES, "byType": {}}
    for event_type in EVENT_TYPES:
        typed = [case for case in cases if case["eventType"] == event_type]
        training = [case for case in typed if case["split"] == "train"]
        calibration = [
            case for case in typed
            if case["split"] == "calibration"
        ]
        validation = [
            case for case in typed
            if case["split"] == "validation"
        ]
        train_x = np.asarray([case_features(case) for case in training])
        train_y = np.asarray([target_position(case) for case in training])
        options = []
        for name, model in model_options():
            model.fit(train_x, train_y)
            options.append({
                "name": name,
                "train": evaluate(training, model),
                "calibration": evaluate(calibration, model),
                "validation": evaluate(validation, model),
            })
        options.sort(
            key=lambda row: (
                row["calibration"]["coverage"],
                row["calibration"]["withinOne"],
                -row["calibration"]["medianCenterError"],
                row["train"]["coverage"],
            ),
            reverse=True,
        )
        report["byType"][event_type] = {
            "selected": options[0],
            "options": options,
        }
    OUTPUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        event_type: report["byType"][event_type]["selected"]
        for event_type in EVENT_TYPES
    }, indent=2))


if __name__ == "__main__":
    main()
