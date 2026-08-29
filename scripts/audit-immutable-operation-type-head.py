#!/usr/bin/env python3
"""File-OOF audit of one immutable evidence package per operation type."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

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


def build_type_packages(
    operations: pd.DataFrame,
    *,
    maximum_features: int,
) -> tuple[pd.DataFrame, int]:
    numeric = trainer.make_feature_spec(
        operations,
        group_column="attempt_id",
        maximum_numeric=maximum_features,
        categorical_columns=(),
        preferred_numeric=trainer.OPERATION_PREFERRED,
    ).numeric_columns
    group_columns = ["attempt_id", "event_type"]
    metadata = operations.groupby(group_columns, sort=False).agg(
        file_id=("file_id", "first"),
        family=("family", "first"),
        operation_correct=("operation_correct", "max"),
        identity_count=("identity_group", "size"),
        shift_abs_min=("shift_years", lambda value: value.abs().min()),
        shift_abs_max=("shift_years", lambda value: value.abs().max()),
        shift_abs_mean=("shift_years", lambda value: value.abs().mean()),
    )
    aggregates = operations.groupby(group_columns, sort=False)[list(numeric)].agg(
        ["max", "mean", "min", "std"]
    )
    aggregates.columns = [
        f"type_{stat}_{column}" for column, stat in aggregates.columns
    ]
    packages = metadata.join(aggregates).reset_index()
    packages["type_group"] = (
        packages["attempt_id"].astype(str)
        + "|type|"
        + packages["event_type"].astype(str)
    )
    return packages, len(numeric)


def type_oof_scores(packages: pd.DataFrame, values: pd.DataFrame) -> np.ndarray:
    predictions = np.full(len(packages), np.nan, dtype=np.float32)
    splitter = GroupKFold(n_splits=min(5, packages["file_id"].nunique()))
    for fold, (train_index, test_index) in enumerate(
        splitter.split(packages, groups=packages["file_id"])
    ):
        train = packages.iloc[train_index].reset_index(drop=True)
        estimator = trainer.fit_ranker(
            trainer.ranker(120000 + fold, graded=False),
            train,
            values.iloc[train_index].reset_index(drop=True),
            label="operation_correct",
            group="attempt_id",
        )
        predictions[test_index] = estimator.predict(
            values.iloc[test_index].reset_index(drop=True)
        )
    if np.isnan(predictions).any():
        raise RuntimeError("file-OOF type head left rows without predictions")
    return predictions


def select_identity_in_type(
    operations: pd.DataFrame,
    packages: pd.DataFrame,
    type_score: np.ndarray,
    identity_score: pd.Series,
) -> pd.DataFrame:
    type_top = trainer.select_top(
        packages,
        pd.Series(type_score, index=packages.index),
        "attempt_id",
    )
    selected_type = operations["attempt_id"].map(
        type_top.set_index("attempt_id")["event_type"]
    )
    eligible_score = pd.Series(identity_score, index=operations.index, dtype=float)
    eligible_score.loc[operations["event_type"].ne(selected_type)] = -np.inf
    return trainer.select_top(operations, eligible_score, "attempt_id")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--ranking-oof-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-features", type=int, default=192)
    args = parser.parse_args()

    operation_path = Path(args.operation_scores).resolve()
    ranking_path = Path(args.ranking_oof_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = trainer.prepare_operation(pd.read_pickle(operation_path))
    ranking = pd.read_pickle(ranking_path).reset_index(drop=True)
    if not operations["identity_group"].equals(ranking["identity_group"]):
        raise RuntimeError("ranking OOF rows do not match operation identities")
    identity_score = ranking["rank_oof_score"].groupby(
        operations["attempt_id"], sort=False
    ).rank(pct=True)

    packages, source_feature_count = build_type_packages(
        operations, maximum_features=args.maximum_features
    )
    spec = trainer.make_feature_spec(
        packages,
        group_column="attempt_id",
        maximum_numeric=args.maximum_features * 4 + 8,
        categorical_columns=("event_type",),
    )
    values = trainer.project_relative_features(packages, spec)
    type_score = type_oof_scores(packages, values)
    selected = select_identity_in_type(
        operations, packages, type_score, identity_score
    )
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(np.int8)
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "fileIsolatedOof": True,
        "candidateGeneratorFrozen": True,
        "immutableTypePackageHead": True,
        "operationScoresSha256": trainer.sha256(operation_path),
        "rankingScoresSha256": trainer.sha256(ranking_path),
        "sourceFeatures": source_feature_count,
        "typePackageFeatures": len(spec.numeric_columns),
        "projectedFeatures": values.shape[1],
        "correct": int(event["operation_correct"].sum()),
        "events": len(event),
        "accuracy": float(event["operation_correct"].mean()),
        "typeCorrect": int(
            packages.loc[
                trainer.select_top(
                    packages,
                    pd.Series(type_score, index=packages.index),
                    "attempt_id",
                ).index,
                "operation_correct",
            ].sum()
        ),
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
    selected.to_csv(output_dir / "best-top.csv", index=False)
    packages.assign(type_oof_score=type_score).to_pickle(
        output_dir / "type-package-oof-scores.pkl"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
