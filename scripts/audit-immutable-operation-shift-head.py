#!/usr/bin/env python3
"""File-OOF audit of a type-first immutable operation/shift head."""

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

VARIABLE_SHIFT_TYPES = ("partialMove", "wholeSeriesMove")


def add_type_group(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    output["type_group"] = (
        output["attempt_id"].astype(str)
        + "|type|"
        + output["event_type"].astype(str)
    )
    return output


def shift_oof_scores(
    operations: pd.DataFrame,
    values: pd.DataFrame,
) -> np.ndarray:
    predictions = np.full(len(operations), np.nan, dtype=np.float32)
    splitter = GroupKFold(n_splits=min(5, operations["file_id"].nunique()))
    for fold, (train_index, test_index) in enumerate(
        splitter.split(operations, groups=operations["file_id"])
    ):
        train_files = set(operations.iloc[train_index]["file_id"])
        test_files = set(operations.iloc[test_index]["file_id"])
        for type_offset, event_type in enumerate(VARIABLE_SHIFT_TYPES):
            type_mask = operations["event_type"].eq(event_type)
            train_mask = type_mask & operations["file_id"].isin(train_files)
            positive_groups = set(
                operations.loc[train_mask & operations["operation_correct"].eq(1), "type_group"]
            )
            train_mask &= operations["type_group"].isin(positive_groups)
            test_mask = type_mask & operations["file_id"].isin(test_files)
            if not train_mask.any() or not test_mask.any():
                continue
            train = operations.loc[train_mask].reset_index(drop=True)
            train_values = values.loc[train_mask].reset_index(drop=True)
            estimator = trainer.fit_ranker(
                trainer.ranker(110000 + fold * 10 + type_offset, graded=False),
                train,
                train_values,
                label="operation_correct",
                group="type_group",
            )
            predictions[test_mask] = estimator.predict(values.loc[test_mask])
    return predictions


def select_type_then_shift(
    operations: pd.DataFrame,
    type_score: pd.Series,
    shift_score: np.ndarray,
) -> pd.DataFrame:
    type_top = trainer.select_top(operations, type_score, "attempt_id")[
        ["attempt_id", "event_type"]
    ].rename(columns={"event_type": "selected_event_type"})
    selected_type = operations["attempt_id"].map(
        type_top.set_index("attempt_id")["selected_event_type"]
    )
    eligible = operations["event_type"].eq(selected_type)
    score = pd.Series(type_score, index=operations.index, dtype=float)
    variable = eligible & operations["event_type"].isin(VARIABLE_SHIFT_TYPES)
    available = variable & np.isfinite(shift_score)
    score.loc[available] = shift_score[available]
    score.loc[~eligible] = -np.inf
    return trainer.select_top(operations, score, "attempt_id")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--ranking-oof-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-features", type=int, default=512)
    args = parser.parse_args()

    operation_path = Path(args.operation_scores).resolve()
    ranking_path = Path(args.ranking_oof_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = add_type_group(
        trainer.prepare_operation(pd.read_pickle(operation_path))
    )
    ranking = pd.read_pickle(ranking_path).reset_index(drop=True)
    if not operations["identity_group"].equals(ranking["identity_group"]):
        raise RuntimeError("ranking OOF rows do not match operation identities")
    type_score = ranking["rank_oof_score"].groupby(
        operations["attempt_id"], sort=False
    ).rank(pct=True)

    shift_frame = operations[
        operations["event_type"].isin(VARIABLE_SHIFT_TYPES)
    ].copy()
    spec = trainer.make_feature_spec(
        shift_frame,
        group_column="type_group",
        maximum_numeric=args.maximum_features,
        categorical_columns=("event_type",),
        preferred_numeric=trainer.OPERATION_PREFERRED,
    )
    values = trainer.project_relative_features(operations, spec)
    shift_score = shift_oof_scores(operations, values)
    selected = select_type_then_shift(operations, type_score, shift_score)
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(np.int8)
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "fileIsolatedOof": True,
        "candidateGeneratorFrozen": True,
        "typeFirstImmutableShiftHead": True,
        "operationScoresSha256": trainer.sha256(operation_path),
        "rankingScoresSha256": trainer.sha256(ranking_path),
        "inputFeatures": len(spec.numeric_columns),
        "projectedFeatures": values.shape[1],
        "correct": int(event["operation_correct"].sum()),
        "events": len(event),
        "accuracy": float(event["operation_correct"].mean()),
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
    pd.DataFrame({
        "identity_group": operations["identity_group"],
        "type_oof_score": type_score,
        "shift_oof_score": shift_score,
    }).to_pickle(output_dir / "candidate-oof-scores.pkl")
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
