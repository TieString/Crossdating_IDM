#!/usr/bin/env python3
"""Fit frozen unified heads on development files and calibrate gates on separate files."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


TRAINER_PATH = Path(__file__).with_name("train-unified-diagnosis-adjudicator.py")
SPEC = importlib.util.spec_from_file_location("unified_adjudicator", TRAINER_PATH)
assert SPEC and SPEC.loader
TRAINER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRAINER
SPEC.loader.exec_module(TRAINER)


def per_operation_thresholds(top: pd.DataFrame) -> tuple[dict[str, float], dict[str, Any]]:
    thresholds: dict[str, float] = {}
    metrics: dict[str, Any] = {}
    for event_type in sorted(TRAINER.EVENT_TYPES):
        selected = top[top["alternative_event_type"] == event_type]
        if selected.empty:
            thresholds[event_type] = 1.01
            metrics[event_type] = {
                "overrides": 0,
                "beneficialOverrides": 0,
                "harmfulOverrides": 0,
            }
            continue
        threshold, selected_metrics = TRAINER.choose_pair_threshold(
            selected,
            require_zero_harm=True,
        )
        thresholds[event_type] = threshold
        metrics[event_type] = selected_metrics
    return thresholds, metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-run-dir", action="append", required=True)
    parser.add_argument("--calibration-run-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    development_frames = []
    development_attempts = 0
    for index, run in enumerate(args.development_run_dir):
        selected, attempts = TRAINER.make_candidate_rows(
            Path(run).resolve(),
            f"development-{index}",
        )
        selected["dataset_role"] = "development"
        development_frames.append(selected)
        development_attempts += len(attempts)
    calibration, calibration_attempts = TRAINER.make_candidate_rows(
        Path(args.calibration_run_dir).resolve(),
        "evaluation",
    )
    calibration["dataset_role"] = "evaluation"
    candidates = pd.concat(
        [*development_frames, calibration],
        ignore_index=True,
    )
    features, feature_names = TRAINER.encoded_features(candidates)
    development_mask = candidates["dataset_role"].eq("development").to_numpy()
    calibration_mask = candidates["dataset_role"].eq("evaluation").to_numpy()
    development_indices = np.flatnonzero(development_mask)
    calibration_indices = np.flatnonzero(calibration_mask)

    candidate_labels = candidates.iloc[development_indices]["label_workflow"]
    candidate_model = TRAINER.model_for(candidate_labels, 20001)
    candidate_model.fit(features.iloc[development_indices], candidate_labels)
    candidate_probabilities = np.full(len(candidates), np.nan)
    candidate_probabilities[calibration_indices] = candidate_model.predict_proba(
        features.iloc[calibration_indices]
    )[:, 1]

    pairs, pair_values, pair_feature_names = TRAINER.make_pairwise_table(
        candidates,
        features,
        feature_names,
    )
    operation_train = np.flatnonzero(
        pairs["dataset_role"].eq("development").to_numpy()
        & pairs["same_operation_identity"].eq(0).to_numpy()
    )
    operation_test = np.flatnonzero(
        pairs["dataset_role"].eq("evaluation").to_numpy()
        & pairs["same_operation_identity"].eq(0).to_numpy()
    )
    operation_labels = pairs.iloc[operation_train]["pair_label"]
    operation_model = TRAINER.pair_model(operation_labels, 20002)
    operation_model.fit(pair_values[operation_train], operation_labels)
    operation_probabilities = operation_model.predict_proba(
        pair_values[operation_test]
    )[:, 1]
    operation_pairs = pairs.iloc[operation_test].copy().reset_index(drop=True)
    operation_top = TRAINER.top_stacked_predictions(
        operation_pairs,
        operation_probabilities,
        candidate_probabilities,
        "alternative_failure",
        "operation",
        0.001,
    )
    operation_thresholds, operation_calibration = per_operation_thresholds(
        operation_top,
    )
    _, operation_decisions = TRAINER.evaluate_operation_thresholds(
        operation_top,
        operation_thresholds,
    )

    location_pairs_all, location_values, _ = TRAINER.make_location_pair_table(
        pairs,
        features,
        feature_names,
    )
    location_train = np.flatnonzero(
        location_pairs_all["dataset_role"].eq("development").to_numpy()
    )
    location_test = np.flatnonzero(
        location_pairs_all["dataset_role"].eq("evaluation").to_numpy()
    )
    location_labels = location_pairs_all.iloc[location_train]["pair_label"]
    location_model = TRAINER.pair_model(location_labels, 20003)
    location_model.fit(location_values[location_train], location_labels)
    location_probabilities = location_model.predict_proba(
        location_values[location_test]
    )[:, 1]
    location_pairs = location_pairs_all.iloc[location_test].copy().reset_index(drop=True)
    location_top = TRAINER.top_pair_predictions(
        location_pairs,
        location_probabilities,
    )
    location_thresholds, location_calibration = per_operation_thresholds(
        location_top,
    )
    _, location_decisions = TRAINER.evaluate_operation_thresholds(
        location_top,
        location_thresholds,
    )
    product_decisions = TRAINER.combine_structured_decisions(
        operation_decisions,
        location_decisions,
    )

    calibration_candidates = candidates[calibration_mask]
    recovery_top = TRAINER.top_recovery_predictions(
        calibration_candidates,
        candidate_probabilities,
    )
    recovery_threshold, recovery_calibration = TRAINER.choose_recovery_threshold(
        recovery_top,
    )
    fake_fold = [{
        "testFiles": sorted(calibration_candidates["file_id"].unique()),
        "recoveryThreshold": recovery_threshold,
    }]
    recovery_decisions = TRAINER.apply_recovery_gates(
        candidates,
        candidate_probabilities,
        fake_fold,
    )
    decisions = pd.concat(
        [product_decisions, recovery_decisions],
        ignore_index=True,
    )
    summary = TRAINER.summarize_pair_decisions(decisions, calibration_attempts)

    model_dir = output_dir / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "candidate.txt").write_text(
        candidate_model.booster_.model_to_string(),
        encoding="utf8",
    )
    (model_dir / "operation-pair.txt").write_text(
        operation_model.booster_.model_to_string(),
        encoding="utf8",
    )
    (model_dir / "location-pair.txt").write_text(
        location_model.booster_.model_to_string(),
        encoding="utf8",
    )
    decisions.to_csv(output_dir / "calibration-decisions.csv", index=False)
    calibration_attempts.to_csv(output_dir / "calibration-attempts.csv", index=False)
    operation_top.to_csv(output_dir / "calibration-operation-top.csv", index=False)
    location_top.to_csv(output_dir / "calibration-location-top.csv", index=False)
    recovery_top.to_csv(output_dir / "calibration-recovery-top.csv", index=False)
    architecture = {
        "schemaVersion": 1,
        "architecture": [
            "immutable_candidate_table",
            "operation_shift_head",
            "same_identity_location_head",
            "safe_refusal_recovery_head",
            "single_final_suggestion",
        ],
        "developmentRunDirs": [str(Path(path).resolve()) for path in args.development_run_dir],
        "calibrationRunDir": str(Path(args.calibration_run_dir).resolve()),
        "developmentAttempts": development_attempts,
        "calibrationAttempts": len(calibration_attempts),
        "candidateFeatures": feature_names,
        "pairFeatures": pair_feature_names,
        "operation": {
            "score": "sqrt(alternative_candidate_probability * (1 - product_probability))",
            "pairFloor": 0.001,
            "thresholds": operation_thresholds,
            "calibration": operation_calibration,
        },
        "location": {
            "score": "pair_probability",
            "thresholds": location_thresholds,
            "calibration": location_calibration,
        },
        "recovery": {
            "score": "candidate_probability",
            "threshold": recovery_threshold,
            "calibration": recovery_calibration,
        },
        "calibrationSummary": summary,
    }
    (output_dir / "architecture.json").write_text(
        json.dumps(architecture, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({
        "outputDir": str(output_dir),
        **summary["event"],
        "clean": summary["clean"],
        "operationThresholds": operation_thresholds,
        "locationThresholds": location_thresholds,
        "recoveryThreshold": recovery_threshold,
        "beneficialOverrides": summary.get("beneficialOverrides"),
        "harmfulOverrides": summary.get("harmfulOverrides"),
    }))


if __name__ == "__main__":
    main()
