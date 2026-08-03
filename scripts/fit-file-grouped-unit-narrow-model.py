"""Fit file-grouped point rankers for already-approved unit-event narrow windows.

This is an offline trainer. It reuses the runtime point-feature definition, but
optimizes the center of a 9-year window only for cases where the existing width
calibrator already selected width 9. Validation audits are reported, never used
for model or threshold selection.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path
from statistics import median
from typing import Any, Sequence

import numpy as np
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
POINT_TRAINER_PATH = HERE / "fit-file-grouped-unit-point-model.py"
SPEC = importlib.util.spec_from_file_location("unit_point_trainer", POINT_TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {POINT_TRAINER_PATH}")
POINT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POINT
SPEC.loader.exec_module(POINT)

WINDOW_WIDTH = 9
HALF_WIDTH = WINDOW_WIDTH // 2
EVENT_TYPES = ("missingRing", "falseRing")


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def bounded_window(case: Any, center_year: int) -> tuple[int, int, int]:
    minimum = int(case.years[0])
    maximum = int(case.years[-1])
    start = max(minimum, min(center_year - HALF_WIDTH, maximum - WINDOW_WIDTH + 1))
    return start, start + WINDOW_WIDTH - 1, center_year


def predict_window(case: Any, raw_scores: Sequence[float], temperature: float):
    scores = np.asarray(raw_scores, dtype=float)
    peak_index = int(np.argmax(scores))
    peak_year = int(case.years[peak_index])
    shifted = np.clip((scores - float(np.max(scores))) / temperature, -30, 0)
    probabilities = np.exp(shifted)
    probabilities /= max(1e-12, float(np.sum(probabilities)))
    rows = []
    for center in range(int(case.years[0]), int(case.years[-1]) + 1):
        mass = sum(
            float(probability)
            for year, probability in zip(case.years, probabilities)
            if abs(int(year) - center) <= HALF_WIDTH
        )
        rows.append((mass, -abs(center - peak_year), center))
    return bounded_window(case, max(rows)[2])


def predict_cases(model: Any, cases: Sequence[Any], temperature: float):
    return [
        predict_window(case, model.predict(case.features), temperature)
        for case in cases
    ]


def current_window(case: Any) -> tuple[int, int]:
    window = case.source["finalWindow"]
    return int(window["startYear"]), int(window["endYear"])


def selected_cases(cases: Sequence[Any], predictions: Sequence[tuple[int, int, int]]):
    return [
        (case, prediction)
        for case, prediction in zip(cases, predictions)
        if int(case.source.get("calibratedWidth", 0)) == WINDOW_WIDTH
    ]


def summarize(cases: Sequence[Any], predictions: Sequence[tuple[int, int, int]]):
    rows = selected_cases(cases, predictions)
    current_hits: list[bool] = []
    hits: list[bool] = []
    center_errors: list[int] = []
    by_dataset: dict[str, list[bool]] = {}
    for case, (start, end, center) in rows:
        truth = int(case.source["truthYear"])
        old_start, old_end = current_window(case)
        current_hits.append(old_start <= truth <= old_end)
        hit = start <= truth <= end
        hits.append(hit)
        center_errors.append(abs(center - truth))
        by_dataset.setdefault(case.dataset, []).append(hit)
    return {
        "cases": len(rows),
        "hits": sum(hits),
        "coverage": sum(hits) / max(1, len(hits)),
        "currentHits": sum(current_hits),
        "currentCoverage": sum(current_hits) / max(1, len(current_hits)),
        "delta": sum(hits) - sum(current_hits),
        "medianCenterError": float(median(center_errors)) if center_errors else 0.0,
        "byDataset": {
            name: {
                "cases": len(values),
                "hits": sum(values),
                "coverage": sum(values) / max(1, len(values)),
            }
            for name, values in sorted(by_dataset.items())
        },
    }


def cross_validated_predictions(cases: Sequence[Any], configuration: Any, folds: int):
    groups = np.asarray([case.group for case in cases])
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    predictions: list[tuple[int, int, int] | None] = [None] * len(cases)
    fold_rows = []
    for fold, (train_indexes, test_indexes) in enumerate(
        splitter.split(np.arange(len(cases)), groups=groups)
    ):
        train = [cases[index] for index in train_indexes]
        test = [cases[index] for index in test_indexes]
        model = POINT.fit_ranker(train, configuration, 20260802 + fold)
        selected = predict_cases(model, test, 1.0)
        for index, prediction in zip(test_indexes, selected):
            predictions[int(index)] = prediction
        fold_rows.append({"fold": fold, **summarize(test, selected)})
    return [row for row in predictions if row is not None], fold_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument("--events", default=",".join(EVENT_TYPES))
    parser.add_argument(
        "--bundle",
        default="src/features/crossdating/diagnosis/unitEventPointWindowModel.json",
    )
    parser.add_argument("--report", default=".tmp-file-grouped-unit-narrow-report.json")
    parser.add_argument("--model", default=".tmp-file-grouped-unit-narrow-model.json")
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()

    event_types = tuple(item.strip() for item in args.events.split(",") if item.strip())
    unknown = sorted(set(event_types) - set(EVENT_TYPES))
    if unknown:
        raise ValueError(f"Unsupported events: {unknown}")
    train_paths = parse_paths(args.train)
    calibration_paths = parse_paths(args.calibration)
    validation_paths = parse_paths(args.validation)
    current_bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))

    POINT.WINDOW_WIDTH = WINDOW_WIDTH
    POINT.HALF_WIDTH = HALF_WIDTH
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "splitPolicy": "file-disjoint train/calibration/validation; file-grouped OOF",
        "windowWidth": WINDOW_WIDTH,
        "selectionScope": "existing calibratedWidth=9 cases only",
        "eventTypes": {},
    }
    bundle: dict[str, Any] = {"version": 1, "eventTypes": {}}

    for event_type in event_types:
        feature_sets = POINT.feature_sets(event_type, current_bundle)
        prepared = {
            feature_set: {
                "train": POINT.load_cases(
                    train_paths, "train", event_type, feature_names
                ),
                "calibration": POINT.load_cases(
                    calibration_paths, "calibration", event_type, feature_names
                ),
                "validation": POINT.load_cases(
                    validation_paths, "validation", event_type, feature_names
                ),
            }
            for feature_set, feature_names in feature_sets.items()
        }
        candidates = []
        for configuration in POINT.configurations(tuple(feature_sets)):
            datasets = prepared[configuration.feature_set]
            oof_predictions, fold_rows = cross_validated_predictions(
                datasets["train"], configuration, args.folds
            )
            oof = summarize(datasets["train"], oof_predictions)
            model = POINT.fit_ranker(datasets["train"], configuration, 20260802)
            calibration_raw = [
                model.predict(case.features) for case in datasets["calibration"]
            ]
            temperatures = []
            for temperature in (0.25, 0.5, 1.0, 2.0, 4.0):
                predictions = [
                    predict_window(case, raw, temperature)
                    for case, raw in zip(datasets["calibration"], calibration_raw)
                ]
                temperatures.append({
                    "temperature": temperature,
                    **summarize(datasets["calibration"], predictions),
                })
            temperatures.sort(key=lambda row: (
                row["coverage"],
                row["delta"],
                -row["medianCenterError"],
                -abs(math.log2(row["temperature"])),
            ), reverse=True)
            calibrated = temperatures[0]
            worst_fold = min(row["coverage"] for row in fold_rows)
            nonnegative_folds = sum(row["delta"] >= 0 for row in fold_rows)
            selection_score = (
                int(nonnegative_folds == len(fold_rows)),
                min(worst_fold, calibrated["coverage"]),
                min(oof["delta"], calibrated["delta"]),
                (oof["coverage"] + calibrated["coverage"]) / 2,
                -calibrated["medianCenterError"],
            )
            candidates.append({
                "configuration": configuration,
                "model": model,
                "temperature": calibrated["temperature"],
                "oof": oof,
                "folds": fold_rows,
                "worstFoldCoverage": worst_fold,
                "calibration": calibrated,
                "selectionScore": selection_score,
            })

        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        selected = candidates[0]
        configuration = selected["configuration"]
        datasets = prepared[configuration.feature_set]
        final_training = [*datasets["train"], *datasets["calibration"]]
        final_model = POINT.fit_ranker(final_training, configuration, 20260803)
        validation = datasets["validation"]
        validation_metrics = summarize(
            validation,
            predict_cases(final_model, validation, selected["temperature"]),
        ) if validation else None
        feature_names = feature_sets[configuration.feature_set]
        chosen_report = {
            "configuration": configuration.name,
            "featureCount": len(feature_names),
            "temperature": selected["temperature"],
            "oof": selected["oof"],
            "folds": selected["folds"],
            "worstFoldCoverage": selected["worstFoldCoverage"],
            "calibration": selected["calibration"],
            "validation": validation_metrics,
        }
        report["eventTypes"][event_type] = {
            "selected": chosen_report,
            "runnerUp": [
                {
                    "configuration": row["configuration"].name,
                    "temperature": row["temperature"],
                    "worstFoldCoverage": row["worstFoldCoverage"],
                    "oof": row["oof"],
                    "calibration": row["calibration"],
                }
                for row in candidates[:12]
            ],
        }
        bundle["eventTypes"][event_type] = {
            "featureNames": feature_names,
            "temperature": selected["temperature"],
            "windowWidth": WINDOW_WIDTH,
            "training": {
                "configuration": configuration.name,
                "trainCases": len(datasets["train"]),
                "calibrationCases": len(datasets["calibration"]),
                "validationCases": len(validation),
                "selection": "file-grouped OOF and calibration, restricted to approved 9-year cases",
            },
            "model": final_model.booster_.dump_model(),
        }
        print(json.dumps({event_type: chosen_report}, ensure_ascii=False))

    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    Path(args.model).write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Wrote {args.report} and {args.model}")


if __name__ == "__main__":
    main()
