#!/usr/bin/env python3
"""Persist file-OOF listwise/pairwise scores for immutable operations."""

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


def result_for_score(
    operations: pd.DataFrame,
    score: pd.Series | np.ndarray,
) -> tuple[pd.DataFrame, dict]:
    top = trainer.select_top(
        operations, pd.Series(score, index=operations.index), "attempt_id"
    ).copy()
    top["candidate_has_response"] = top["event_type"].ne("noEvent").astype(np.int8)
    event = top[top["family"].ne("Clean")]
    clean = top[top["family"].eq("Clean")]
    return top, {
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


def listwise_oof_scores(
    operations: pd.DataFrame,
    values: pd.DataFrame,
    *,
    variant: str,
) -> np.ndarray:
    predictions = np.full(len(operations), np.nan, dtype=np.float32)
    splitter = GroupKFold(n_splits=min(5, operations["file_id"].nunique()))
    for fold, (train_index, test_index) in enumerate(
        splitter.split(operations, groups=operations["file_id"])
    ):
        train = operations.iloc[train_index].reset_index(drop=True)
        train_values = values.iloc[train_index].reset_index(drop=True)
        test_values = values.iloc[test_index].reset_index(drop=True)
        estimator = trainer.ranker(98000 + fold, graded=False)
        if variant == "top1":
            estimator.set_params(
                n_estimators=850,
                lambdarank_truncation_level=5,
            )
        elif variant == "xendcg":
            estimator.set_params(
                objective="rank_xendcg",
                n_estimators=850,
            )
        elif variant == "capacity":
            estimator.set_params(
                n_estimators=900,
                num_leaves=31,
                min_child_samples=16,
                colsample_bytree=0.82,
                reg_alpha=2.5,
                reg_lambda=9.0,
            )
        elif variant != "baseline":
            raise RuntimeError(f"unsupported ranker variant {variant}")
        estimator = trainer.fit_ranker(
            estimator,
            train,
            train_values,
            label="operation_correct",
            group="attempt_id",
        )
        predictions[test_index] = estimator.predict(test_values)
    if np.isnan(predictions).any():
        raise RuntimeError("file-OOF listwise audit left rows without predictions")
    return predictions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-features", type=int, default=192)
    parser.add_argument("--listwise-only", action="store_true")
    parser.add_argument("--operation-hierarchy", action="store_true")
    parser.add_argument(
        "--ranker-variant",
        choices=("baseline", "top1", "xendcg", "capacity"),
        default="baseline",
    )
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
    values = (
        trainer.project_operation_hierarchy_features(operations, spec)
        if args.operation_hierarchy
        else trainer.project_relative_features(operations, spec)
    )
    seed_score = trainer.seed_percentile(
        operations, group="attempt_id", columns=trainer.OPERATION_SEED
    )
    if args.listwise_only:
        rank = listwise_oof_scores(
            operations, values, variant=args.ranker_variant
        )
        pair = np.full(len(operations), np.nan, dtype=np.float32)
        pair_rows = 0
    else:
        rank, pair, pair_rows = trainer.oof_scores(
            operations,
            values,
            label="operation_correct",
            group="attempt_id",
            seed_score=seed_score,
            graded=False,
            seed=98000,
            maximum_positives=4,
            maximum_negatives=10,
            shortlist_size=16,
        )

    variants: dict[str, dict] = {}
    best: tuple[int, float, pd.Series, pd.DataFrame] | None = None
    blend_weights = (0.0,) if args.listwise_only else trainer.BLEND_WEIGHTS
    for weight in blend_weights:
        score = (
            pd.Series(rank, index=operations.index)
            if weight == 0
            else trainer.blended_percentiles(
                operations,
                rank,
                pair,
                group="attempt_id",
                weight=float(weight),
            )
        )
        top, summary = result_for_score(operations, score)
        variants[f"pairWeight={weight:.3f}"] = summary
        key = (summary["cleanFalsePositives"], -summary["correct"])
        if best is None or key < (best[0], -best[1]):
            best = (key[0], float(summary["correct"]), score, top)
    assert best is not None

    compact = operations[[
        "attempt_id",
        "file_id",
        "family",
        "identity_group",
        "event_type",
        "shift_years",
        "operation_correct",
    ]].copy()
    compact["rank_oof_score"] = rank
    compact["pair_oof_score"] = pair
    compact["seed_percentile"] = seed_score.to_numpy()
    compact.to_pickle(output_dir / "candidate-oof-scores.pkl")
    best[3].to_csv(output_dir / "best-top.csv", index=False)

    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "fileIsolatedOof": True,
        "candidateGeneratorFrozen": True,
        "operationScoresSha256": trainer.sha256(source),
        "inputFeatures": len(spec.numeric_columns),
        "projectedFeatures": values.shape[1],
        "listwiseOnly": bool(args.listwise_only),
        "operationHierarchy": bool(args.operation_hierarchy),
        "rankerVariant": args.ranker_variant,
        "pairRows": pair_rows,
        "variants": variants,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
