"""Fit a conservative file-grouped gate for missing-ring window width.

The production point model already decides whether a case is narrow enough for
a 9-year window. This offline trainer only learns which of those accepted
9-year windows are unusually risky and which existing 13-year windows can be
safely narrowed around the same center. The gate cannot change the selected
mode. Validation files are report-only.
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
POINT_TRAINER_PATH = HERE / "fit-file-grouped-unit-point-model.py"
SPEC = importlib.util.spec_from_file_location(
    "unit_point_trainer_for_missing_width",
    POINT_TRAINER_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {POINT_TRAINER_PATH}")
POINT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POINT
SPEC.loader.exec_module(POINT)

EVENT_TYPE = "missingRing"
NARROW_WIDTH = 9
WIDE_WIDTH = 13
MINIMUM_NARROW_FRACTION = 0.5

warnings.filterwarnings(
    "ignore",
    message="X does not have valid feature names",
    category=UserWarning,
)


@dataclass(frozen=True)
class SafetyRow:
    case: Any
    features: np.ndarray
    current_width: int
    current_hit: bool
    narrow_hit: bool
    wide_hit: bool

    @property
    def group(self) -> str:
        return self.case.group


@dataclass(frozen=True)
class Configuration:
    leaves: int
    depth: int
    minimum: int
    estimators: int

    @property
    def name(self) -> str:
        return (
            f"l{self.leaves}:d{self.depth}:m{self.minimum}:n{self.estimators}"
        )


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def mean(values: Sequence[float]) -> float:
    return sum(values) / max(1, len(values))


def predict_node(node: dict[str, Any], features: Sequence[float]) -> float:
    if "leaf_value" in node:
        return float(node["leaf_value"])
    value = float(features[int(node["split_feature"])])
    threshold = float(node["threshold"])
    if not math.isfinite(value):
        go_left = bool(node.get("default_left", True))
    elif node.get("decision_type", "<=") == "<=":
        go_left = value <= threshold
    else:
        go_left = value == threshold
    return predict_node(
        node["left_child"] if go_left else node["right_child"],
        features,
    )


def predict_dumped_model(model: dict[str, Any], matrix: np.ndarray) -> np.ndarray:
    trees = [tree["tree_structure"] for tree in model["tree_info"]]
    return np.asarray([
        sum(predict_node(tree, row) for tree in trees)
        for row in matrix
    ], dtype=float)


def safety_feature_names(point_feature_names: Sequence[str]) -> list[str]:
    return [
        "mass5",
        "mass7",
        "mass9",
        "mass13",
        "mass5Over9",
        "mass7Over9",
        "mass9Over13",
        "adjacentMassMargin",
        "remoteMassMargin",
        "entropy",
        "maximumYearProbability",
        "rawScoreDeviation",
        "rawScoreQ90Margin",
        "peakCenterSigned",
        "peakCenterDistance",
        "currentSigned",
        "currentDistance",
        "operationSigned",
        "operationDistance",
        "sideSigned",
        "sideDistance",
        "coarseRelative",
        "coarseCenterSigned",
        "oldNineYearSafety",
        "oldSafetyMargin",
        "oldWasNarrow",
        *[f"point:{name}" for name in point_feature_names],
    ]


def bounded_window(case: Any, center: int, width: int) -> tuple[int, int]:
    minimum = int(case.years[0])
    maximum = int(case.years[-1])
    start = max(minimum, min(center - width // 2, maximum - width + 1))
    return start, start + width - 1


def build_row(
    case: Any,
    point_model: dict[str, Any],
    temperature: float,
) -> SafetyRow | None:
    source = case.source
    current_width = int(source.get("calibratedWidth", 0))
    if current_width not in (NARROW_WIDTH, WIDE_WIDTH):
        return None
    final_window = source["finalWindow"]
    center = (
        int(final_window["startYear"]) + int(final_window["endYear"])
    ) // 2
    raw_scores = predict_dumped_model(point_model, case.features)
    maximum = float(np.max(raw_scores))
    probabilities = np.exp(np.clip(
        (raw_scores - maximum) / temperature,
        -30,
        0,
    ))
    probabilities /= max(1e-12, float(np.sum(probabilities)))
    years = np.asarray(case.years, dtype=int)
    peak_year = int(years[int(np.argmax(raw_scores))])

    def mass(radius: int, at: int = center) -> float:
        return float(np.sum(probabilities[np.abs(years - at) <= radius]))

    centers = sorted(
        (
            (mass(4, candidate), candidate)
            for candidate in range(int(years[0]), int(years[-1]) + 1)
        ),
        key=lambda row: (
            row[0],
            -abs(row[1] - peak_year),
            row[1],
        ),
        reverse=True,
    )
    adjacent = max(
        (row for row in centers if 0 < abs(row[1] - center) <= 2),
        default=centers[0],
    )
    remote = max(
        (row for row in centers if abs(row[1] - center) > 8),
        default=centers[-1],
    )
    entropy = -float(np.sum(
        probabilities * np.log(np.maximum(probabilities, 1e-12))
    )) / max(1e-12, math.log(max(2, len(probabilities))))
    center_index = int(np.argmin(np.abs(years - center)))
    point_features = case.features[center_index]
    coarse = source["coarseWindow"]
    coarse_start = int(coarse["startYear"])
    coarse_end = int(coarse["endYear"])
    span = max(1, coarse_end - coarse_start)
    operation = source.get("selectedOperation") or {}

    def signed(anchor: Any) -> float:
        return 0.0 if anchor is None else (center - float(anchor)) / span

    def distance(anchor: Any) -> float:
        return 1.0 if anchor is None else abs(center - float(anchor)) / span

    mass5 = mass(2)
    mass7 = mass(3)
    mass9 = mass(4)
    mass13 = mass(6)
    old_safety = float(source.get("nineYearSafety", 0))
    old_threshold = float(source.get("nineYearSafetyThreshold", 1))
    values = [
        mass5,
        mass7,
        mass9,
        mass13,
        mass5 / max(1e-12, mass9),
        mass7 / max(1e-12, mass9),
        mass9 / max(1e-12, mass13),
        mass9 - adjacent[0],
        mass9 - remote[0],
        entropy,
        float(np.max(probabilities)),
        float(np.std(raw_scores)),
        float(np.max(raw_scores) - np.quantile(raw_scores, 0.9)),
        (peak_year - center) / span,
        abs(peak_year - center) / span,
        signed(source.get("currentPrimaryYear")),
        distance(source.get("currentPrimaryYear")),
        signed(operation.get("bestYear")),
        distance(operation.get("bestYear")),
        signed(operation.get("sideStepBestYear")),
        distance(operation.get("sideStepBestYear")),
        (center - coarse_start) / span,
        (center - (coarse_start + coarse_end) / 2) / span,
        old_safety,
        old_safety - old_threshold,
        float(current_width == NARROW_WIDTH),
        *[float(value) for value in point_features],
    ]
    truth = int(source["truthYear"])
    narrow = bounded_window(case, center, NARROW_WIDTH)
    wide = bounded_window(case, center, WIDE_WIDTH)
    return SafetyRow(
        case=case,
        features=np.asarray(values, dtype=np.float32),
        current_width=current_width,
        current_hit=(
            int(final_window["startYear"])
            <= truth
            <= int(final_window["endYear"])
        ),
        narrow_hit=narrow[0] <= truth <= narrow[1],
        wide_hit=wide[0] <= truth <= wide[1],
    )


def make_classifier(configuration: Configuration, seed: int):
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=configuration.estimators,
        learning_rate=0.03,
        num_leaves=configuration.leaves,
        max_depth=configuration.depth,
        min_child_samples=configuration.minimum,
        max_bin=31,
        feature_fraction=0.8,
        bagging_fraction=0.85,
        bagging_freq=1,
        reg_lambda=4.0,
        class_weight="balanced",
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
    )


def fit_classifier(
    rows: Sequence[SafetyRow],
    configuration: Configuration,
    seed: int,
):
    model = make_classifier(configuration, seed)
    model.fit(
        np.asarray([row.features for row in rows]),
        np.asarray([int(row.narrow_hit) for row in rows]),
    )
    return model


def probabilities(model: Any, rows: Sequence[SafetyRow]) -> np.ndarray:
    return model.predict_proba(np.asarray([row.features for row in rows]))[:, 1]


def split_width_rows(
    rows: Sequence[SafetyRow],
) -> tuple[list[SafetyRow], list[SafetyRow]]:
    return (
        [row for row in rows if row.current_width == NARROW_WIDTH],
        [row for row in rows if row.current_width == WIDE_WIDTH],
    )


def predict_by_current_width(
    narrow_model: Any,
    wide_model: Any,
    rows: Sequence[SafetyRow],
) -> np.ndarray:
    result = np.zeros(len(rows), dtype=float)
    narrow_indexes = [
        index
        for index, row in enumerate(rows)
        if row.current_width == NARROW_WIDTH
    ]
    wide_indexes = [
        index
        for index, row in enumerate(rows)
        if row.current_width == WIDE_WIDTH
    ]
    if narrow_indexes:
        values = probabilities(
            narrow_model,
            [rows[index] for index in narrow_indexes],
        )
        for index, value in zip(narrow_indexes, values):
            result[index] = value
    if wide_indexes:
        values = probabilities(
            wide_model,
            [rows[index] for index in wide_indexes],
        )
        for index, value in zip(wide_indexes, values):
            result[index] = value
    return result


def summarize(
    rows: Sequence[SafetyRow],
    safety: Sequence[float],
    existing_narrow_threshold: float,
    existing_wide_threshold: float,
) -> dict[str, Any]:
    use_narrow = [
        value >= (
            existing_narrow_threshold
            if row.current_width == NARROW_WIDTH
            else existing_wide_threshold
        )
        for row, value in zip(rows, safety)
    ]
    hits = [
        row.narrow_hit if narrow else row.wide_hit
        for row, narrow in zip(rows, use_narrow)
    ]
    widening_recoveries = sum(
        row.current_width == NARROW_WIDTH
        and not narrow
        and not row.narrow_hit
        and row.wide_hit
        for row, narrow in zip(rows, use_narrow)
    )
    narrowing_losses = sum(
        row.current_width == WIDE_WIDTH
        and narrow
        and row.current_hit
        and not row.narrow_hit
        for row, narrow in zip(rows, use_narrow)
    )
    current_hits = sum(row.current_hit for row in rows)
    narrow_cases = sum(use_narrow)
    return {
        "cases": len(rows),
        "currentHits": int(current_hits),
        "narrowHits": int(sum(row.narrow_hit for row in rows)),
        "wideOracleHits": int(sum(row.wide_hit for row in rows)),
        "policyHits": int(sum(hits)),
        "policyCoverage": float(mean(hits)),
        "delta": int(sum(hits) - current_hits),
        "wideningRecoveries": int(widening_recoveries),
        "narrowingLosses": int(narrowing_losses),
        "narrowCases": int(narrow_cases),
        "narrowFraction": float(mean(use_narrow)),
        "widenedNarrowCases": int(sum(
            row.current_width == NARROW_WIDTH and not narrow
            for row, narrow in zip(rows, use_narrow)
        )),
        "narrowedWideCases": int(sum(
            row.current_width == WIDE_WIDTH and narrow
            for row, narrow in zip(rows, use_narrow)
        )),
    }


def calibrate_threshold(
    rows: Sequence[SafetyRow],
    safety: Sequence[float],
) -> dict[str, Any]:
    existing_narrow_values = [
        float(value)
        for row, value in zip(rows, safety)
        if row.current_width == NARROW_WIDTH
    ]
    existing_wide_values = [
        float(value)
        for row, value in zip(rows, safety)
        if row.current_width == WIDE_WIDTH
    ]
    narrow_thresholds = [
        min(existing_narrow_values) - 1e-9,
        *sorted(set(existing_narrow_values)),
    ]
    wide_thresholds = [
        *sorted(set(existing_wide_values)),
        max(existing_wide_values) + 1e-9,
    ]
    policies = []
    for existing_narrow_threshold in narrow_thresholds:
        for existing_wide_threshold in wide_thresholds:
            policy = summarize(
                rows,
                safety,
                existing_narrow_threshold,
                existing_wide_threshold,
            )
            if (
                policy["delta"] >= 0
                and policy["narrowingLosses"] == 0
                and policy["narrowCases"] >= len(rows) // 2 + 1
            ):
                policies.append({
                    "existingNarrowThreshold": existing_narrow_threshold,
                    "existingWideThreshold": existing_wide_threshold,
                    **policy,
                })
    policies.sort(key=lambda row: (
        row["policyHits"],
        -row["narrowCases"],
        -row["widenedNarrowCases"] - row["narrowedWideCases"],
        row["existingWideThreshold"],
    ), reverse=True)
    return policies[0]


def configurations() -> list[Configuration]:
    return [
        Configuration(leaves, depth, minimum, estimators)
        for leaves, depth in ((3, 2), (5, 3), (7, 3))
        for minimum in (8, 12, 20, 30)
        for estimators in (30, 60, 100)
    ]


def load_rows(
    paths: Sequence[Path],
    dataset: str,
    point_entry: dict[str, Any],
) -> list[SafetyRow]:
    cases = POINT.load_cases(
        paths,
        dataset,
        EVENT_TYPE,
        point_entry["featureNames"],
    )
    return [
        row
        for case in cases
        if (row := build_row(
            case,
            point_entry["model"],
            float(point_entry["temperature"]),
        )) is not None
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument(
        "--point-model",
        default="src/features/crossdating/diagnosis/unitEventPointWindowModel.json",
    )
    parser.add_argument(
        "--report",
        default=".tmp-file-grouped-missing-width-safety-report.json",
    )
    parser.add_argument(
        "--model",
        default=".tmp-file-grouped-missing-width-safety-model.json",
    )
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()

    point_bundle = json.loads(Path(args.point_model).read_text(encoding="utf-8"))
    point_entry = point_bundle["eventTypes"][EVENT_TYPE]
    train_rows = load_rows(parse_paths(args.train), "train", point_entry)
    calibration_rows = load_rows(
        parse_paths(args.calibration),
        "calibration",
        point_entry,
    )
    validation_rows = load_rows(
        parse_paths(args.validation),
        "validation",
        point_entry,
    )

    groups = np.asarray([row.group for row in train_rows])
    splitter = GroupKFold(n_splits=min(args.folds, len(set(groups))))
    fold_indexes = [
        ([int(index) for index in fit], [int(index) for index in test])
        for fit, test in splitter.split(np.arange(len(train_rows)), groups=groups)
    ]
    candidates = []
    for configuration in configurations():
        oof_safety = np.zeros(len(train_rows), dtype=float)
        for fold, (fit_indexes, test_indexes) in enumerate(fold_indexes):
            fit_rows = [train_rows[index] for index in fit_indexes]
            fit_narrow, fit_wide = split_width_rows(fit_rows)
            narrow_model = fit_classifier(
                fit_narrow,
                configuration,
                20260820 + fold,
            )
            wide_model = fit_classifier(
                fit_wide,
                configuration,
                20260830 + fold,
            )
            values = predict_by_current_width(
                narrow_model,
                wide_model,
                [train_rows[index] for index in test_indexes],
            )
            for index, value in zip(test_indexes, values):
                oof_safety[index] = value
        train_narrow, train_wide = split_width_rows(train_rows)
        narrow_model = fit_classifier(
            train_narrow,
            configuration,
            20260820,
        )
        wide_model = fit_classifier(
            train_wide,
            configuration,
            20260830,
        )
        calibration_safety = predict_by_current_width(
            narrow_model,
            wide_model,
            calibration_rows,
        )
        calibrated = calibrate_threshold(calibration_rows, calibration_safety)
        existing_narrow_threshold = calibrated["existingNarrowThreshold"]
        existing_wide_threshold = calibrated["existingWideThreshold"]
        oof = summarize(
            train_rows,
            oof_safety,
            existing_narrow_threshold,
            existing_wide_threshold,
        )
        folds = [
            {"fold": fold, **summarize(
                [train_rows[index] for index in test_indexes],
                [oof_safety[index] for index in test_indexes],
                existing_narrow_threshold,
                existing_wide_threshold,
            )}
            for fold, (_, test_indexes) in enumerate(fold_indexes)
        ]
        candidates.append({
            "configuration": configuration,
            "narrowModel": narrow_model,
            "wideModel": wide_model,
            "existingNarrowThreshold": existing_narrow_threshold,
            "existingWideThreshold": existing_wide_threshold,
            "oof": oof,
            "folds": folds,
            "calibration": calibrated,
            "selectionScore": (
                min(oof["delta"], calibrated["delta"]),
                oof["delta"] + calibrated["delta"],
                min(oof["narrowFraction"], calibrated["narrowFraction"]),
                -oof["narrowingLosses"],
            ),
        })
    candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
    selected = candidates[0]
    validation_safety = predict_by_current_width(
        selected["narrowModel"],
        selected["wideModel"],
        validation_rows,
    ) if validation_rows else []
    validation = summarize(
        validation_rows,
        validation_safety,
        selected["existingNarrowThreshold"],
        selected["existingWideThreshold"],
    ) if validation_rows else None
    report = {
        "schemaVersion": 1,
        "splitPolicy": (
            "file-disjoint train/calibration/validation; file-grouped OOF"
        ),
        "eventType": EVENT_TYPE,
        "minimumNarrowFraction": MINIMUM_NARROW_FRACTION,
        "selected": {
            "configuration": selected["configuration"].name,
            "existingNarrowThreshold": selected["existingNarrowThreshold"],
            "existingWideThreshold": selected["existingWideThreshold"],
            "oof": selected["oof"],
            "folds": selected["folds"],
            "calibration": selected["calibration"],
            "validation": validation,
        },
        "runnerUp": [{
            "configuration": row["configuration"].name,
            "existingNarrowThreshold": row["existingNarrowThreshold"],
            "existingWideThreshold": row["existingWideThreshold"],
            "oof": row["oof"],
            "calibration": row["calibration"],
        } for row in candidates[:12]],
    }
    model_bundle = {
        "version": 1,
        "eventType": EVENT_TYPE,
        "featureNames": safety_feature_names(point_entry["featureNames"]),
        "existingNarrowThreshold": selected["existingNarrowThreshold"],
        "existingWideThreshold": selected["existingWideThreshold"],
        "training": {
            "configuration": selected["configuration"].name,
            "trainCases": len(train_rows),
            "calibrationCases": len(calibration_rows),
            "validationCases": len(validation_rows),
            "minimumNarrowFraction": MINIMUM_NARROW_FRACTION,
        },
        "models": {
            "existingNarrow": selected["narrowModel"].booster_.dump_model(),
            "existingWide": selected["wideModel"].booster_.dump_model(),
        },
    }
    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.model).write_text(
        json.dumps(model_bundle, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report["selected"], ensure_ascii=False, indent=2))
    print(f"Wrote {args.report} and {args.model}")


if __name__ == "__main__":
    main()
