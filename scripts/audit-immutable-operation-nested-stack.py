#!/usr/bin/env python3
"""Strict nested file-OOF audit for the immutable operation stack."""

from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trainer = load_module(
    "immutable_two_stage_trainer",
    SCRIPT_DIR / "train-immutable-two-stage-adjudicator.py",
)
stack = load_module(
    "immutable_stacked_listwise",
    SCRIPT_DIR / "audit-immutable-operation-stacked-listwise.py",
)

VARIANTS = (
    "base512",
    "all",
    "hierarchy",
    "top1",
    "xendcg",
    "capacity",
    "workflow_base",
    "workflow_all",
    "workflow_hierarchy",
)


def make_ranker(variant: str, seed: int):
    variant = variant.removeprefix("workflow_")
    if variant == "base":
        variant = "base512"
    estimator = trainer.ranker(seed, graded=False)
    if variant == "top1":
        estimator.set_params(n_estimators=850, lambdarank_truncation_level=5)
    elif variant == "xendcg":
        estimator.set_params(objective="rank_xendcg", n_estimators=850)
    elif variant == "capacity":
        estimator.set_params(
            n_estimators=900,
            num_leaves=31,
            min_child_samples=16,
            colsample_bytree=0.82,
            reg_alpha=2.5,
            reg_lambda=9.0,
        )
    elif variant not in {"base512", "all", "hierarchy"}:
        raise RuntimeError(f"unsupported nested rank view {variant}")
    return estimator


def fit_predict(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    train_index: np.ndarray,
    test_index: np.ndarray,
    *,
    variant: str,
    label: str,
    seed: int,
) -> np.ndarray:
    train = frame.iloc[train_index].reset_index(drop=True)
    estimator = trainer.fit_ranker(
        make_ranker(variant, seed),
        train,
        values.iloc[train_index].reset_index(drop=True),
        label=label,
        group="attempt_id",
    )
    return estimator.predict(values.iloc[test_index].reset_index(drop=True))


def nested_view_scores(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    outer_train: np.ndarray,
    outer_test: np.ndarray,
    *,
    variant: str,
    label: str,
    inner_splits: int,
    seed: int,
) -> np.ndarray:
    predictions = np.full(len(frame), np.nan, dtype=np.float32)
    inner = frame.iloc[outer_train].reset_index(names="_outer_index")
    splitter = GroupKFold(
        n_splits=min(inner_splits, inner["file_id"].nunique())
    )
    for inner_fold, (inner_train, inner_test) in enumerate(
        splitter.split(inner, groups=inner["file_id"])
    ):
        train_index = inner.iloc[inner_train]["_outer_index"].to_numpy(dtype=int)
        test_index = inner.iloc[inner_test]["_outer_index"].to_numpy(dtype=int)
        predictions[test_index] = fit_predict(
            frame,
            values,
            train_index,
            test_index,
            variant=variant,
            label=label,
            seed=seed + inner_fold,
        )
    predictions[outer_test] = fit_predict(
        frame,
        values,
        outer_train,
        outer_test,
        variant=variant,
        label=label,
        seed=seed + 20,
    )
    if np.isnan(predictions).any():
        raise RuntimeError(f"nested rank view {variant} left rows without scores")
    return predictions


def feature_values(
    operations: pd.DataFrame,
    outer_train: np.ndarray,
    *,
    variant: str,
) -> pd.DataFrame:
    variant = variant.removeprefix("workflow_")
    if variant == "base":
        variant = "base512"
    maximum = 2048 if variant == "all" else 512
    spec = trainer.make_feature_spec(
        operations.iloc[outer_train],
        group_column="attempt_id",
        maximum_numeric=maximum,
        categorical_columns=("event_type",),
        preferred_numeric=trainer.OPERATION_PREFERRED,
    )
    return (
        trainer.project_operation_hierarchy_features(operations, spec)
        if variant == "hierarchy"
        else trainer.project_relative_features(operations, spec)
    )


def attach_scores(
    operations: pd.DataFrame,
    score_by_view: dict[str, np.ndarray],
) -> tuple[pd.DataFrame, tuple[str, ...]]:
    output = operations.copy()
    rank_columns: list[str] = []
    for name, score in score_by_view.items():
        column = f"stack_rank_{name}"
        output[column] = score
        rank_columns.append(column)
    ranks = pd.concat([
        output[column].groupby(output["attempt_id"], sort=False).rank(pct=True)
        for column in rank_columns
    ], axis=1)
    ranks.columns = rank_columns
    generated = list(rank_columns)
    aggregates = {
        "stack_rank_mean": ranks.mean(axis=1),
        "stack_rank_median": ranks.median(axis=1),
        "stack_rank_min": ranks.min(axis=1),
        "stack_rank_max": ranks.max(axis=1),
        "stack_rank_std": ranks.std(axis=1),
        "stack_top1_vote_fraction": ranks.eq(1).mean(axis=1),
        "stack_top2_vote_fraction": ranks.ge(
            ranks.groupby(output["attempt_id"], sort=False).transform(
                lambda values: values.nlargest(min(2, len(values))).min()
            )
        ).mean(axis=1),
    }
    for column, values in aggregates.items():
        output[column] = values
        generated.append(column)
    return output, tuple(generated)


def fit_meta(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    train_index: np.ndarray,
    test_index: np.ndarray,
    *,
    label: str,
    disagreement_weight: float,
    seed: int,
) -> np.ndarray:
    train = frame.iloc[train_index].reset_index(drop=True)
    train_values = values.iloc[train_index].reset_index(drop=True)
    ordered = train.sort_values("attempt_id").index.to_numpy(dtype=int)
    group_sizes = train.loc[ordered].groupby(
        "attempt_id", sort=False
    ).size().to_numpy()
    consensus = train.groupby("attempt_id", sort=False)[
        "stack_top1_vote_fraction"
    ].transform("max")
    weights = 1 + disagreement_weight * (1 - consensus)
    estimator = trainer.ranker(seed, graded=False)
    estimator.fit(
        train_values.loc[ordered],
        train.loc[ordered, label],
        group=group_sizes,
        sample_weight=weights.loc[ordered],
    )
    return estimator.predict(values.iloc[test_index].reset_index(drop=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--outer-splits", type=int, default=5)
    parser.add_argument("--inner-splits", type=int, default=3)
    parser.add_argument("--disagreement-weight", type=float, default=2.0)
    parser.add_argument(
        "--pair-weight",
        type=float,
        default=0.0,
        help="Fixed OOF blend weight for the hard-negative pairwise head.",
    )
    parser.add_argument(
        "--pair-feature-set",
        choices=("meta", "base512"),
        default="meta",
    )
    parser.add_argument("--pair-shortlist-size", type=int, default=16)
    parser.add_argument("--base-cache-dir")
    parser.add_argument("--reuse-base-cache", action="store_true")
    parser.add_argument(
        "--identity-labels",
        help=(
            "Optional immutable identity table. Local identities use "
            "identity_workflow_oracle as the meta label; whole/noEvent retain "
            "operation_correct."
        ),
    )
    parser.add_argument(
        "--variant",
        action="append",
        choices=VARIANTS,
        dest="variants",
    )
    args = parser.parse_args()

    operation_path = Path(args.operation_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = trainer.prepare_operation(pd.read_pickle(operation_path))
    meta_label = "operation_correct"
    identity_labels_sha256 = None
    if args.identity_labels:
        identity_labels_path = Path(args.identity_labels).resolve()
        identity_labels = pd.read_pickle(identity_labels_path)
        if identity_labels["identity_group"].duplicated().any():
            raise RuntimeError("identity labels must contain one row per identity")
        workflow_by_identity = identity_labels.set_index("identity_group")[
            "identity_workflow_oracle"
        ]
        operations["identity_workflow_correct"] = operations[
            "identity_group"
        ].map(workflow_by_identity)
        operations["identity_workflow_correct"] = operations[
            "identity_workflow_correct"
        ].fillna(operations["operation_correct"]).astype(np.int8)
        meta_label = "identity_workflow_correct"
        identity_labels_sha256 = trainer.sha256(identity_labels_path)
    variants = tuple(args.variants or VARIANTS)
    cache_dir = Path(
        args.base_cache_dir or output_dir / "base-view-cache"
    ).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_manifest = {
        "schemaVersion": 1,
        "operationScoresSha256": trainer.sha256(operation_path),
        "variants": list(variants),
        "outerSplits": min(args.outer_splits, operations["file_id"].nunique()),
        "innerSplits": args.inner_splits,
    }
    if any(variant.startswith("workflow_") for variant in variants):
        if meta_label == "operation_correct":
            raise RuntimeError("workflow views require --identity-labels")
        cache_manifest["identityLabelsSha256"] = identity_labels_sha256
    cache_manifest_path = cache_dir / "manifest.json"
    if args.reuse_base_cache:
        if not cache_manifest_path.exists():
            raise RuntimeError("requested nested base cache does not exist")
        cached_manifest = json.loads(cache_manifest_path.read_text(encoding="utf-8"))
        if cached_manifest != cache_manifest:
            raise RuntimeError("nested base cache manifest does not match this run")
    else:
        cache_manifest_path.write_text(
            json.dumps(cache_manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    outer = GroupKFold(
        n_splits=min(args.outer_splits, operations["file_id"].nunique())
    )
    meta_predictions = np.full(len(operations), np.nan, dtype=np.float32)
    pair_predictions = np.full(len(operations), np.nan, dtype=np.float32)
    for outer_fold, (outer_train, outer_test) in enumerate(
        outer.split(operations, groups=operations["file_id"])
    ):
        cache_path = cache_dir / f"outer-fold-{outer_fold}.pkl"
        if args.reuse_base_cache:
            cached = pd.read_pickle(cache_path)
            if not operations["identity_group"].equals(cached["identity_group"]):
                raise RuntimeError("nested base cache candidate identities changed")
            score_by_view = {
                variant: cached[f"score_{variant}"].to_numpy(dtype=np.float32)
                for variant in variants
            }
            standard_values = None
            print(
                json.dumps({"outerFold": outer_fold, "reusedBaseCache": True}),
                flush=True,
            )
        else:
            score_by_view = {}
            standard_values: pd.DataFrame | None = None
            for view_index, variant in enumerate(variants):
                normalized_variant = variant.removeprefix("workflow_")
                if normalized_variant == "base":
                    normalized_variant = "base512"
                if normalized_variant in {"base512", "top1", "xendcg", "capacity"}:
                    if standard_values is None:
                        standard_values = feature_values(
                            operations, outer_train, variant="base512"
                        )
                    values = standard_values
                else:
                    values = feature_values(operations, outer_train, variant=variant)
                score_by_view[variant] = nested_view_scores(
                    operations,
                    values,
                    outer_train,
                    outer_test,
                    variant=variant,
                    label=(
                        meta_label
                        if variant.startswith("workflow_")
                        else "operation_correct"
                    ),
                    inner_splits=max(2, args.inner_splits),
                    seed=140000 + outer_fold * 1000 + view_index * 100,
                )
                if variant not in {"base512", "top1", "xendcg", "capacity"}:
                    del values
                    gc.collect()
                print(
                    json.dumps({"outerFold": outer_fold, "completedView": variant}),
                    flush=True,
                )
            cache_frame = pd.DataFrame({
                "identity_group": operations["identity_group"],
                **{
                    f"score_{variant}": score_by_view[variant]
                    for variant in variants
                },
            })
            cache_frame.to_pickle(cache_path)
        stacked, generated = attach_scores(operations, score_by_view)
        meta_spec = trainer.make_feature_spec(
            stacked.iloc[outer_train],
            group_column="attempt_id",
            maximum_numeric=len(generated),
            categorical_columns=("event_type",),
            preferred_numeric=generated,
        )
        meta_values = trainer.project_relative_features(stacked, meta_spec)
        fold_meta_predictions = fit_meta(
            stacked,
            meta_values,
            outer_train,
            outer_test,
            label=meta_label,
            disagreement_weight=max(0.0, args.disagreement_weight),
            seed=150000 + outer_fold,
        )
        meta_predictions[outer_test] = fold_meta_predictions
        if args.pair_weight > 0:
            pair_train = stacked.iloc[outer_train].reset_index(drop=True)
            if args.pair_feature_set == "base512":
                pair_model_values = feature_values(
                    operations, outer_train, variant="base512"
                )
            else:
                pair_model_values = meta_values
            pair_train_values = pair_model_values.iloc[
                outer_train
            ].reset_index(drop=True)
            pair_seed = pair_train["stack_rank_mean"].astype(float)
            pair_values, pair_labels = trainer.build_pair_training(
                pair_train,
                pair_train_values,
                label=meta_label,
                group="attempt_id",
                seed_score=pair_seed,
                maximum_positives=(
                    1 if args.pair_shortlist_size <= 2 else 4
                ),
                maximum_negatives=(
                    1 if args.pair_shortlist_size <= 2 else 16
                ),
            )
            pair_estimator = trainer.pair_classifier(155000 + outer_fold)
            pair_estimator.fit(pair_values, pair_labels)
            pair_test = stacked.iloc[outer_test].reset_index(drop=True)
            pair_test_values = pair_model_values.iloc[
                outer_test
            ].reset_index(drop=True)
            listwise_percentile = trainer.within_group_percentile(
                pair_test,
                fold_meta_predictions,
                "attempt_id",
            )
            shortlist_score = listwise_percentile.mul(0.7).add(
                pair_test["stack_rank_mean"].astype(float).mul(0.3)
            )
            pair_predictions[outer_test] = trainer.pair_tournament_scores(
                pair_test,
                pair_test_values,
                pair_estimator,
                group="attempt_id",
                shortlist_score=shortlist_score,
                shortlist_size=max(2, int(args.pair_shortlist_size)),
            )
            del pair_values, pair_labels, pair_estimator, pair_model_values
        del score_by_view, stacked, meta_values, standard_values
        gc.collect()
        print(json.dumps({"completedOuterFold": outer_fold}), flush=True)
    if np.isnan(meta_predictions).any():
        raise RuntimeError("nested stack left rows without outer OOF predictions")

    pair_weight = min(1.0, max(0.0, float(args.pair_weight)))
    selection_score = pd.Series(meta_predictions, index=operations.index)
    if pair_weight > 0:
        if np.isnan(pair_predictions).any():
            raise RuntimeError("nested pair head left rows without outer OOF predictions")
        listwise_percentile = trainer.within_group_percentile(
            operations, meta_predictions, "attempt_id"
        )
        pair_percentile = trainer.within_group_percentile(
            operations, pair_predictions, "attempt_id"
        )
        selection_score = listwise_percentile.mul(1 - pair_weight).add(
            pair_percentile.mul(pair_weight)
        )

    selected = trainer.select_top(
        operations,
        selection_score,
        "attempt_id",
    )
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(np.int8)
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "strictNestedFileOof": True,
        "candidateGeneratorFrozen": True,
        "metaLabel": meta_label,
        "identityLabelsSha256": identity_labels_sha256,
        "operationScoresSha256": trainer.sha256(operation_path),
        "variants": list(variants),
        "outerSplits": min(args.outer_splits, operations["file_id"].nunique()),
        "innerSplits": args.inner_splits,
        "disagreementWeight": max(0.0, args.disagreement_weight),
        "pairWeight": pair_weight,
        "pairFeatureSet": args.pair_feature_set,
        "pairShortlistSize": max(2, int(args.pair_shortlist_size)),
        "baseCacheManifest": cache_manifest,
        "correct": int(event[meta_label].sum()),
        "events": len(event),
        "accuracy": float(event[meta_label].mean()),
        "exactOperationCorrect": int(event["operation_correct"].sum()),
        "exactOperationAccuracy": float(event["operation_correct"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "byFamily": {
            str(family): {
                "correct": int(group[meta_label].sum()),
                "events": len(group),
                "accuracy": float(group[meta_label].mean()),
                "exactOperationCorrect": int(group["operation_correct"].sum()),
                "exactOperationAccuracy": float(group["operation_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }
    selected.to_csv(output_dir / "best-top.csv", index=False)
    pd.DataFrame({
        "identity_group": operations["identity_group"],
        "meta_oof_score": meta_predictions,
        "pair_oof_score": pair_predictions,
        "selection_oof_score": selection_score,
    }).to_pickle(output_dir / "candidate-oof-scores.pkl")
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
