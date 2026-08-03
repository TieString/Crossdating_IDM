"""Fit a file-grouped safety gate between one 9- and one 13-year mode.

The point ranker and safety classifier are trained only on the development
files. A file-disjoint calibration pool chooses the classifier threshold while
requiring at least half of answered cases to retain the 9-year window. The
validation pool is report-only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
NARROW_TRAINER_PATH = HERE / "fit-file-grouped-unit-narrow-model.py"
SPEC = importlib.util.spec_from_file_location("unit_narrow_trainer", NARROW_TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {NARROW_TRAINER_PATH}")
NARROW = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = NARROW
SPEC.loader.exec_module(NARROW)
POINT = NARROW.POINT

EVENT_TYPE = "falseRing"
POINT_CONFIGURATION = POINT.Configuration("core", 9, 4, 70, 0.03, 50)
POINT_TEMPERATURE = 2.0
# Keep an odd-width median at 9 while leaving the calibrator the full available
# risk budget. For the even calibration pool this requires just over 50% narrow.
MINIMUM_NARROW_FRACTION = 0.505

warnings.filterwarnings(
    "ignore",
    message="X does not have valid feature names",
    category=UserWarning,
)


@dataclass(frozen=True)
class SafetyRow:
    case: Any
    features: np.ndarray
    narrow_window: tuple[int, int, int]
    narrow_hit: bool
    mode_hit: bool

    @property
    def group(self) -> str:
        return self.case.group


@dataclass(frozen=True)
class SafetyConfiguration:
    num_leaves: int
    max_depth: int
    min_child_samples: int
    n_estimators: int

    @property
    def name(self) -> str:
        return (
            f"l{self.num_leaves}:d{self.max_depth}:m{self.min_child_samples}:"
            f"n{self.n_estimators}"
        )


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def mean(values: Sequence[float]) -> float:
    return sum(values) / max(1, len(values))


def quantile(values: Sequence[float], fraction: float) -> float:
    return float(np.quantile(np.asarray(values, dtype=float), fraction))


def point_prediction(
    case: Any,
    raw_scores: Sequence[float],
) -> tuple[tuple[int, int, int], np.ndarray, list[tuple[float, int]]]:
    scores = np.asarray(raw_scores, dtype=float)
    maximum = float(np.max(scores))
    probabilities = np.exp(np.clip(
        (scores - maximum) / POINT_TEMPERATURE,
        -30,
        0,
    ))
    probabilities /= max(1e-12, float(np.sum(probabilities)))
    years = np.asarray(case.years, dtype=int)
    peak_year = int(years[int(np.argmax(scores))])
    centers = []
    for center in range(int(years[0]), int(years[-1]) + 1):
        mass = float(np.sum(probabilities[np.abs(years - center) <= 4]))
        centers.append((mass, center))
    centers.sort(key=lambda row: (
        row[0],
        -abs(row[1] - peak_year),
        row[1],
    ), reverse=True)
    selected = NARROW.bounded_window(case, centers[0][1])
    return selected, probabilities, centers


def safety_feature_names(point_feature_names: Sequence[str]) -> list[str]:
    return [
        "mass9",
        "adjacentMassMargin",
        "remoteMassMargin",
        "entropy",
        "maximumYearProbability",
        "rawScoreDeviation",
        "rawScoreQ90Margin",
        "peakCenterDistance",
        "modeCenterDistance",
        "currentDistance",
        "operationDistance",
        "sideDistance",
        "coarseRelative",
        "oldNineYearSafety",
        "oldSafetyMargin",
        "oldWasNarrow",
        *[f"point:{name}" for name in point_feature_names],
    ]


def build_safety_row(
    case: Any,
    raw_scores: Sequence[float],
) -> SafetyRow:
    narrow_window, probabilities, centers = point_prediction(case, raw_scores)
    scores = np.asarray(raw_scores, dtype=float)
    years = np.asarray(case.years, dtype=int)
    center = narrow_window[2]
    peak_year = int(years[int(np.argmax(scores))])
    center_index = int(np.argmin(np.abs(years - center)))
    selected_features = case.features[center_index]
    adjacent = max(
        (row for row in centers[1:] if abs(row[1] - center) <= 2),
        default=centers[0],
    )
    remote = max(
        (row for row in centers if abs(row[1] - center) > 8),
        default=centers[-1],
    )
    entropy = -float(np.sum(
        probabilities * np.log(np.maximum(probabilities, 1e-12))
    )) / max(1e-12, math.log(max(2, len(probabilities))))
    source = case.source
    coarse = source["coarseWindow"]
    coarse_start = int(coarse["startYear"])
    coarse_end = int(coarse["endYear"])
    span = max(1, coarse_end - coarse_start)
    mode = source["modeWindow"]
    mode_center = (int(mode["startYear"]) + int(mode["endYear"])) / 2
    operation = source.get("selectedOperation") or {}

    def distance(anchor: Any) -> float:
        return 1.0 if anchor is None else abs(center - float(anchor)) / span

    old_safety = float(source.get("nineYearSafety", 0))
    old_threshold = float(source.get("nineYearSafetyThreshold", 1))
    values = [
        centers[0][0],
        centers[0][0] - adjacent[0],
        centers[0][0] - remote[0],
        entropy,
        float(np.max(probabilities)),
        float(np.std(scores)),
        float(np.max(scores) - np.quantile(scores, 0.9)),
        abs(peak_year - center) / span,
        abs(mode_center - center) / span,
        distance(source.get("currentPrimaryYear")),
        distance(operation.get("bestYear")),
        distance(operation.get("sideStepBestYear")),
        (center - coarse_start) / span,
        old_safety,
        old_safety - old_threshold,
        float(int(source.get("calibratedWidth", 0)) == 9),
        *[float(value) for value in selected_features],
    ]
    truth = int(source["truthYear"])
    narrow_hit = narrow_window[0] <= truth <= narrow_window[1]
    mode_hit = int(mode["startYear"]) <= truth <= int(mode["endYear"])
    return SafetyRow(
        case=case,
        features=np.asarray(values, dtype=np.float32),
        narrow_window=narrow_window,
        narrow_hit=narrow_hit,
        mode_hit=mode_hit,
    )


def make_classifier(configuration: SafetyConfiguration, seed: int):
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=configuration.n_estimators,
        learning_rate=0.03,
        num_leaves=configuration.num_leaves,
        max_depth=configuration.max_depth,
        min_child_samples=configuration.min_child_samples,
        max_bin=31,
        feature_fraction=0.8,
        bagging_fraction=0.85,
        bagging_freq=1,
        reg_lambda=3.0,
        class_weight="balanced",
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
    )


def informative(rows: Sequence[SafetyRow]) -> list[SafetyRow]:
    # Neither window can recover a mode miss, so those cases do not teach the gate.
    return [row for row in rows if row.narrow_hit or row.mode_hit]


def fit_classifier(rows: Sequence[SafetyRow], configuration: SafetyConfiguration, seed: int):
    selected = informative(rows)
    model = make_classifier(configuration, seed)
    model.fit(
        np.asarray([row.features for row in selected]),
        np.asarray([int(row.narrow_hit) for row in selected]),
    )
    return model


def predict_probabilities(model: Any, rows: Sequence[SafetyRow]) -> np.ndarray:
    return model.predict_proba(np.asarray([row.features for row in rows]))[:, 1]


def policy_summary(
    rows: Sequence[SafetyRow],
    probabilities: Sequence[float],
    threshold: float,
) -> dict[str, Any]:
    narrow = [probability >= threshold for probability in probabilities]
    hits = [
        row.narrow_hit if use_narrow else row.mode_hit
        for row, use_narrow in zip(rows, narrow)
    ]
    current_hits = []
    for row in rows:
        window = row.case.source["finalWindow"]
        truth = int(row.case.source["truthYear"])
        current_hits.append(int(window["startYear"]) <= truth <= int(window["endYear"]))
    narrow_count = int(sum(narrow))
    hit_count = int(sum(hits))
    current_hit_count = int(sum(current_hits))
    narrow_hit_count = int(sum(
        row.narrow_hit for row, use_narrow in zip(rows, narrow) if use_narrow
    ))
    return {
        "cases": len(rows),
        "hits": hit_count,
        "coverage": hit_count / max(1, len(hits)),
        "currentHits": current_hit_count,
        "currentCoverage": current_hit_count / max(1, len(current_hits)),
        "delta": hit_count - current_hit_count,
        "narrowCases": narrow_count,
        "narrowFraction": narrow_count / max(1, len(narrow)),
        "narrowHits": narrow_hit_count,
        "wideCases": len(rows) - narrow_count,
        "modeHits": int(sum(row.mode_hit for row in rows)),
    }


def calibrate_threshold(rows: Sequence[SafetyRow], probabilities: Sequence[float]):
    minimum_narrow = math.ceil(len(rows) * MINIMUM_NARROW_FRACTION)
    candidates = sorted(set(float(value) for value in probabilities), reverse=True)
    policies = []
    for threshold in candidates:
        summary = policy_summary(rows, probabilities, threshold)
        if summary["narrowCases"] < minimum_narrow:
            continue
        policies.append({"threshold": threshold, **summary})
    policies.sort(key=lambda row: (
        row["hits"],
        row["narrowHits"] / max(1, row["narrowCases"]),
        row["narrowCases"],
        row["threshold"],
    ), reverse=True)
    return policies[0]


def configurations() -> list[SafetyConfiguration]:
    return [
        SafetyConfiguration(leaves, depth, minimum, estimators)
        for leaves, depth in ((3, 2), (5, 3), (7, 3))
        for minimum in (10, 20, 30)
        for estimators in (30, 60, 100)
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument(
        "--narrow-model",
        default=".tmp-file-grouped-unit-narrow-model-v1.json",
    )
    parser.add_argument("--report", default=".tmp-file-grouped-unit-width-safety-report.json")
    parser.add_argument("--model", default=".tmp-file-grouped-unit-width-safety-model.json")
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()

    train_paths = parse_paths(args.train)
    calibration_paths = parse_paths(args.calibration)
    validation_paths = parse_paths(args.validation)
    narrow_bundle = json.loads(Path(args.narrow_model).read_text(encoding="utf-8"))
    point_entry = narrow_bundle["eventTypes"][EVENT_TYPE]
    feature_names = point_entry["featureNames"]
    POINT.WINDOW_WIDTH = 9
    POINT.HALF_WIDTH = 4
    train_cases = POINT.load_cases(train_paths, "train", EVENT_TYPE, feature_names)
    calibration_cases = POINT.load_cases(
        calibration_paths, "calibration", EVENT_TYPE, feature_names
    )
    validation_cases = POINT.load_cases(
        validation_paths, "validation", EVENT_TYPE, feature_names
    )

    groups = np.asarray([case.group for case in train_cases])
    splitter = GroupKFold(n_splits=min(args.folds, len(set(groups))))
    train_rows: list[SafetyRow | None] = [None] * len(train_cases)
    fold_indexes = []
    for fold, (fit_indexes, test_indexes) in enumerate(
        splitter.split(np.arange(len(train_cases)), groups=groups)
    ):
        point_model = POINT.fit_ranker(
            [train_cases[index] for index in fit_indexes],
            POINT_CONFIGURATION,
            20260802 + fold,
        )
        for index in test_indexes:
            case = train_cases[int(index)]
            train_rows[int(index)] = build_safety_row(
                case, point_model.predict(case.features)
            )
        fold_indexes.append([int(index) for index in test_indexes])
    oof_rows = [row for row in train_rows if row is not None]

    development_point_model = POINT.fit_ranker(
        train_cases, POINT_CONFIGURATION, 20260802
    )
    calibration_rows = [
        build_safety_row(case, development_point_model.predict(case.features))
        for case in calibration_cases
    ]
    validation_rows = [
        build_safety_row(case, development_point_model.predict(case.features))
        for case in validation_cases
    ]

    candidates = []
    for configuration in configurations():
        risk_oof = np.zeros(len(oof_rows), dtype=float)
        fold_reports = []
        for fold, test_indexes in enumerate(fold_indexes):
            test_groups = {oof_rows[index].group for index in test_indexes}
            fit_rows = [row for row in oof_rows if row.group not in test_groups]
            test_rows = [oof_rows[index] for index in test_indexes]
            classifier = fit_classifier(fit_rows, configuration, 20260812 + fold)
            probabilities = predict_probabilities(classifier, test_rows)
            for index, probability in zip(test_indexes, probabilities):
                risk_oof[index] = probability
        classifier = fit_classifier(oof_rows, configuration, 20260812)
        calibration_probabilities = predict_probabilities(classifier, calibration_rows)
        calibration = calibrate_threshold(calibration_rows, calibration_probabilities)
        threshold = calibration["threshold"]
        oof = policy_summary(oof_rows, risk_oof, threshold)
        for fold, test_indexes in enumerate(fold_indexes):
            fold_reports.append({
                "fold": fold,
                **policy_summary(
                    [oof_rows[index] for index in test_indexes],
                    [risk_oof[index] for index in test_indexes],
                    threshold,
                ),
            })
        worst_fold = min(row["coverage"] for row in fold_reports)
        score = (
            min(oof["coverage"], calibration["coverage"]),
            min(oof["delta"], calibration["delta"]),
            worst_fold,
            calibration["coverage"],
            oof["coverage"],
        )
        candidates.append({
            "configuration": configuration,
            "classifier": classifier,
            "threshold": threshold,
            "oof": oof,
            "folds": fold_reports,
            "worstFoldCoverage": worst_fold,
            "calibration": calibration,
            "selectionScore": score,
        })

    candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
    selected = candidates[0]
    validation_probabilities = predict_probabilities(
        selected["classifier"], validation_rows
    ) if validation_rows else []
    validation = policy_summary(
        validation_rows,
        validation_probabilities,
        selected["threshold"],
    ) if validation_rows else None
    selected_report = {
        "configuration": selected["configuration"].name,
        "threshold": selected["threshold"],
        "minimumNarrowFraction": MINIMUM_NARROW_FRACTION,
        "oof": selected["oof"],
        "folds": selected["folds"],
        "worstFoldCoverage": selected["worstFoldCoverage"],
        "calibration": selected["calibration"],
        "validation": validation,
    }
    report = {
        "schemaVersion": 1,
        "splitPolicy": "file-disjoint train/calibration/validation; file-grouped OOF",
        "eventType": EVENT_TYPE,
        "pointConfiguration": POINT_CONFIGURATION.name,
        "pointTemperature": POINT_TEMPERATURE,
        "selected": selected_report,
        "runnerUp": [
            {
                "configuration": row["configuration"].name,
                "threshold": row["threshold"],
                "oof": row["oof"],
                "worstFoldCoverage": row["worstFoldCoverage"],
                "calibration": row["calibration"],
            }
            for row in candidates[:12]
        ],
    }
    model = {
        "version": 1,
        "eventType": EVENT_TYPE,
        "pointModel": {
            "featureNames": feature_names,
            "temperature": POINT_TEMPERATURE,
            "windowWidth": 9,
            "model": development_point_model.booster_.dump_model(),
        },
        "safetyModel": {
            "featureNames": safety_feature_names(feature_names),
            "threshold": selected["threshold"],
            "minimumNarrowFraction": MINIMUM_NARROW_FRACTION,
            "training": {
                "configuration": selected["configuration"].name,
                "trainCases": len(oof_rows),
                "calibrationCases": len(calibration_rows),
                "validationCases": len(validation_rows),
            },
            "model": selected["classifier"].booster_.dump_model(),
        },
    }
    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    Path(args.model).write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(selected_report, ensure_ascii=False, indent=2))
    print(f"Wrote {args.report} and {args.model}")


if __name__ == "__main__":
    main()
