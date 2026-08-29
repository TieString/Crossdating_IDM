#!/usr/bin/env python3
"""File-OOF audit of a diagnosis-balanced immutable operation head.

This script is development-only. It consumes the frozen operation identity
table, projects every numeric channel to diagnosis-relative coordinates, and
selects exactly one ``operationType + shiftYears`` identity per diagnosis.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
TRAINER_SPEC = importlib.util.spec_from_file_location(
    "immutable_two_stage_trainer",
    SCRIPT_DIR / "train-immutable-two-stage-adjudicator.py",
)
trainer = importlib.util.module_from_spec(TRAINER_SPEC)
TRAINER_SPEC.loader.exec_module(trainer)


VARIANTS = {
    "balanced15": {
        "num_leaves": 15,
        "min_child_samples": 36,
        "reg_alpha": 2.0,
        "reg_lambda": 7.0,
    },
    "balanced31": {
        "num_leaves": 31,
        "min_child_samples": 48,
        "reg_alpha": 3.0,
        "reg_lambda": 9.0,
    },
}


def diagnosis_balanced_weights(frame: pd.DataFrame) -> np.ndarray:
    """Give every diagnosis equal mass and split it across its labels."""

    weights = np.zeros(len(frame), dtype=np.float64)
    labels = frame["operation_correct"].to_numpy(dtype=np.int8)
    for indices in frame.groupby("attempt_id", sort=False).indices.values():
        positions = np.asarray(indices, dtype=int)
        positive = positions[labels[positions] == 1]
        negative = positions[labels[positions] == 0]
        if len(positive) and len(negative):
            weights[positive] = 0.5 / len(positive)
            weights[negative] = 0.5 / len(negative)
        elif len(positive):
            weights[positive] = 1.0 / len(positive)
        else:
            weights[negative] = 1.0 / len(negative)
    return weights


def classifier(seed: int, variant: str) -> lgb.LGBMClassifier:
    params = VARIANTS[variant]
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=800,
        learning_rate=0.025,
        subsample=0.85,
        subsample_freq=1,
        colsample_bytree=0.72,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
        **params,
    )


def oof_predictions(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    variant: str,
) -> np.ndarray:
    predictions = np.full(len(frame), np.nan, dtype=np.float32)
    splitter = GroupKFold(n_splits=min(5, frame["file_id"].nunique()))
    weights = diagnosis_balanced_weights(frame)
    for fold, (train_index, test_index) in enumerate(
        splitter.split(frame, groups=frame["file_id"])
    ):
        estimator = classifier(97000 + fold, variant)
        estimator.fit(
            values.iloc[train_index],
            frame.iloc[train_index]["operation_correct"],
            sample_weight=weights[train_index],
        )
        predictions[test_index] = estimator.predict_proba(
            values.iloc[test_index]
        )[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("file-OOF pointwise head left rows without predictions")
    return predictions


def summarize(frame: pd.DataFrame, score: np.ndarray) -> tuple[pd.DataFrame, dict]:
    top = trainer.select_top(
        frame, pd.Series(score, index=frame.index), "attempt_id"
    ).copy()
    top["candidate_has_response"] = top["event_type"].ne("noEvent").astype(np.int8)
    event = top[top["family"].ne("Clean")]
    clean = top[top["family"].eq("Clean")]
    payload = {
        "eventAttempts": len(event),
        "operationCorrect": int(event["operation_correct"].sum()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "byFamily": {
            str(family): {
                "correct": int(group["operation_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["operation_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }
    return top, payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-features", type=int, default=192)
    args = parser.parse_args()

    source = Path(args.operation_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = trainer.prepare_operation(pd.read_pickle(source))
    spec = trainer.make_feature_spec(
        operations,
        group_column="attempt_id",
        maximum_numeric=args.maximum_features,
        categorical_columns=("event_type",),
        preferred_numeric=trainer.OPERATION_PREFERRED,
    )
    values = trainer.project_relative_features(operations, spec)

    result = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "fileIsolatedOof": True,
        "candidateGeneratorFrozen": True,
        "operationScoresSha256": trainer.sha256(source),
        "inputFeatures": len(spec.numeric_columns),
        "projectedFeatures": values.shape[1],
        "variants": {},
    }
    for variant in VARIANTS:
        score = oof_predictions(operations, values, variant=variant)
        top, summary = summarize(operations, score)
        result["variants"][variant] = summary
        top.to_csv(output_dir / f"{variant}-top.csv", index=False)
        np.save(output_dir / f"{variant}-scores.npy", score)
    (output_dir / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
