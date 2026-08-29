#!/usr/bin/env python3
"""Diagnostic file-OOF listwise fusion of immutable operation rank views."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
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


def parse_score_paths(values: list[str]) -> dict[str, Path]:
    output: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise RuntimeError("rank score must use NAME=PKL_PATH")
        name, raw_path = value.split("=", 1)
        name = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
        if not name or name in output:
            raise RuntimeError("rank score names must be unique and non-empty")
        output[name] = Path(raw_path).resolve()
    if len(output) < 2:
        raise RuntimeError("stacked audit requires at least two rank views")
    return output


def attach_rank_views(
    operations: pd.DataFrame,
    score_paths: dict[str, Path],
) -> tuple[pd.DataFrame, tuple[str, ...]]:
    output = operations.copy()
    generated: list[str] = []
    rank_columns: list[str] = []
    for name, path in score_paths.items():
        scores = pd.read_pickle(path).reset_index(drop=True)
        if not output["identity_group"].equals(scores["identity_group"]):
            raise RuntimeError(f"rank view {name} does not match operation identities")
        column = f"stack_rank_{name}"
        output[column] = pd.to_numeric(scores["rank_oof_score"], errors="raise")
        rank_columns.append(column)
        generated.append(column)

    ranks = pd.concat([
        output[column].groupby(output["attempt_id"], sort=False).rank(pct=True)
        for column in rank_columns
    ], axis=1)
    ranks.columns = rank_columns
    output["stack_rank_mean"] = ranks.mean(axis=1)
    output["stack_rank_median"] = ranks.median(axis=1)
    output["stack_rank_min"] = ranks.min(axis=1)
    output["stack_rank_max"] = ranks.max(axis=1)
    output["stack_rank_std"] = ranks.std(axis=1)
    output["stack_top1_vote_fraction"] = ranks.eq(1).mean(axis=1)
    output["stack_top2_vote_fraction"] = ranks.ge(
        ranks.groupby(output["attempt_id"], sort=False).transform(
            lambda values: values.nlargest(min(2, len(values))).min()
        )
    ).mean(axis=1)
    generated.extend((
        "stack_rank_mean",
        "stack_rank_median",
        "stack_rank_min",
        "stack_rank_max",
        "stack_rank_std",
        "stack_top1_vote_fraction",
        "stack_top2_vote_fraction",
    ))
    return output, tuple(generated)


def meta_oof_scores(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    disagreement_weight: float,
) -> np.ndarray:
    predictions = np.full(len(frame), np.nan, dtype=np.float32)
    splitter = GroupKFold(n_splits=min(5, frame["file_id"].nunique()))
    for fold, (train_index, test_index) in enumerate(
        splitter.split(frame, groups=frame["file_id"])
    ):
        train = frame.iloc[train_index].reset_index(drop=True)
        ordered = train.sort_values("attempt_id").index.to_numpy(dtype=int)
        group_sizes = train.loc[ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
        consensus = train.groupby("attempt_id", sort=False)[
            "stack_top1_vote_fraction"
        ].transform("max")
        query_weight = 1 + disagreement_weight * (1 - consensus)
        estimator = trainer.ranker(130000 + fold, graded=False)
        estimator.fit(
            values.iloc[train_index].reset_index(drop=True).loc[ordered],
            train.loc[ordered, "operation_correct"],
            group=group_sizes,
            sample_weight=query_weight.loc[ordered],
        )
        predictions[test_index] = estimator.predict(
            values.iloc[test_index].reset_index(drop=True)
        )
    if np.isnan(predictions).any():
        raise RuntimeError("stacked listwise audit left rows without predictions")
    return predictions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--rank-score", action="append", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-raw-features", type=int, default=0)
    parser.add_argument("--disagreement-weight", type=float, default=0.0)
    args = parser.parse_args()

    operation_path = Path(args.operation_scores).resolve()
    score_paths = parse_score_paths(args.rank_score)
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = trainer.prepare_operation(pd.read_pickle(operation_path))
    operations, stack_columns = attach_rank_views(operations, score_paths)
    preferred = tuple(stack_columns) + (
        trainer.OPERATION_PREFERRED if args.maximum_raw_features > 0 else ()
    )
    maximum = len(stack_columns) + max(0, args.maximum_raw_features)
    spec = trainer.make_feature_spec(
        operations,
        group_column="attempt_id",
        maximum_numeric=maximum,
        categorical_columns=("event_type",),
        preferred_numeric=preferred,
    )
    values = trainer.project_relative_features(operations, spec)
    meta_score = meta_oof_scores(
        operations,
        values,
        disagreement_weight=max(0.0, args.disagreement_weight),
    )
    selected = trainer.select_top(
        operations,
        pd.Series(meta_score, index=operations.index),
        "attempt_id",
    )
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(np.int8)
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "stackingCaveat": (
            "Base rank views are file-held-out, but meta training is not yet "
            "nested cross-fitted."
        ),
        "candidateGeneratorFrozen": True,
        "operationScoresSha256": trainer.sha256(operation_path),
        "rankScoreSha256": {
            name: trainer.sha256(path) for name, path in score_paths.items()
        },
        "rankViews": len(score_paths),
        "inputFeatures": len(spec.numeric_columns),
        "projectedFeatures": values.shape[1],
        "disagreementWeight": max(0.0, args.disagreement_weight),
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
        "meta_oof_score": meta_score,
    }).to_pickle(output_dir / "candidate-oof-scores.pkl")
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
