#!/usr/bin/env python3
"""Train a file-held-out second-level selector over pair, candidate, and ranker OOF signals."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


TRAINER_PATH = Path(__file__).with_name("train-unified-diagnosis-adjudicator.py")
SPEC = importlib.util.spec_from_file_location("unified_adjudicator", TRAINER_PATH)
assert SPEC and SPEC.loader
TRAINER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRAINER
SPEC.loader.exec_module(TRAINER)


def candidate_oof(
    candidates: pd.DataFrame,
    features: pd.DataFrame,
) -> np.ndarray:
    files = np.array(sorted(candidates["file_id"].unique()))
    predictions = np.full(len(candidates), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)),
        groups=files,
    )):
        test_files = set(files[test_file_indices])
        train = np.flatnonzero(~candidates["file_id"].isin(test_files).to_numpy())
        test = np.flatnonzero(candidates["file_id"].isin(test_files).to_numpy())
        estimator = TRAINER.model_for(candidates.iloc[train]["label_workflow"], 15000 + fold)
        estimator.fit(features.iloc[train], candidates.iloc[train]["label_workflow"])
        predictions[test] = estimator.predict_proba(features.iloc[test])[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("missing candidate OOF probabilities")
    return predictions


def meta_model(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=450,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=45,
        subsample=0.85,
        colsample_bytree=0.75,
        reg_alpha=1.5,
        reg_lambda=4.0,
        scale_pos_weight=min(60.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def probability_ranks(
    pairs: pd.DataFrame,
    values: np.ndarray,
    prefix: str,
) -> pd.DataFrame:
    table = pairs[["attempt_id"]].copy()
    table[prefix] = values
    table[f"{prefix}_rank"] = table.groupby("attempt_id")[prefix].rank(
        method="min",
        ascending=False,
    )
    table[f"{prefix}_percentile"] = table.groupby("attempt_id")[prefix].rank(
        method="average",
        pct=True,
        ascending=True,
    )
    best = table.groupby("attempt_id")[prefix].transform("max")
    table[f"{prefix}_deficit"] = best - table[prefix]
    return table.drop(columns=["attempt_id", prefix])


def choose_zero_harm_thresholds(top: pd.DataFrame) -> dict[str, float]:
    thresholds: dict[str, float] = {}
    for event_type in sorted(TRAINER.EVENT_TYPES):
        selected = top[top["alternative_event_type"] == event_type]
        if selected.empty:
            thresholds[event_type] = 1.01
            continue
        values = sorted(set(
            np.linspace(0.05, 0.995, 190).tolist()
            + selected["meta_probability"].quantile(np.linspace(0.5, 0.999, 100)).tolist()
            + [1.01]
        ))
        options = []
        for threshold in values:
            overridden = selected["meta_probability"] >= threshold
            harm = int((overridden & selected["pair_harm"].eq(1)).sum())
            benefit = int((overridden & selected["pair_label"].eq(1)).sum())
            if harm:
                continue
            options.append(((benefit, -int(overridden.sum()), threshold), threshold))
        thresholds[event_type] = max(options, key=lambda item: item[0])[1]
    return thresholds


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-cache", required=True)
    parser.add_argument("--operation-pairs", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    cache_path = Path(args.candidate_cache).resolve()
    pair_path = Path(args.operation_pairs).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    candidates = pd.read_pickle(cache_path)
    candidates = candidates[candidates["dataset_role"] == "evaluation"].copy()
    features, feature_names = TRAINER.encoded_features(candidates)
    all_pairs, pair_values, pair_feature_names = TRAINER.make_pairwise_table(
        candidates,
        features,
        feature_names,
    )
    operation_indices = np.flatnonzero(
        (all_pairs["dataset_role"].to_numpy() == "evaluation")
        & (all_pairs["same_operation_identity"].to_numpy() == 0)
    )
    pairs = all_pairs.iloc[operation_indices].copy().reset_index(drop=True)
    base_values = pair_values[operation_indices]
    alternative_indices = pairs["alternative_candidate_index"].to_numpy(dtype=int)
    product_indices = pairs["product_candidate_index"].to_numpy(dtype=int)

    pair_oof = pd.read_csv(pair_path)[[
        "attempt_id",
        "alternative_candidate_index",
        "product_candidate_index",
        "oof_pair_probability",
    ]]
    pairs = pairs.merge(
        pair_oof,
        on=["attempt_id", "alternative_candidate_index", "product_candidate_index"],
        how="left",
        validate="one_to_one",
    )
    if pairs["oof_pair_probability"].isna().any():
        raise RuntimeError("operation pair OOF probabilities do not align with candidate cache")

    candidate_probabilities = candidate_oof(candidates, features)
    ranker_predictions, ranker_folds = TRAINER.ranker_cross_validated_predictions(
        candidates,
        features,
    )
    alternative_candidate_probability = candidate_probabilities[alternative_indices]
    product_candidate_probability = candidate_probabilities[product_indices]
    alternative_ranker_score = ranker_predictions[alternative_indices]
    product_ranker_score = ranker_predictions[product_indices]

    meta_extras = pd.DataFrame({
        "pair_probability": pairs["oof_pair_probability"].to_numpy(),
        "alternative_candidate_probability": alternative_candidate_probability,
        "product_candidate_probability": product_candidate_probability,
        "candidate_probability_advantage": (
            alternative_candidate_probability - product_candidate_probability
        ),
        "alternative_ranker_score": alternative_ranker_score,
        "product_ranker_score": product_ranker_score,
        "ranker_score_advantage": alternative_ranker_score - product_ranker_score,
    })
    meta_extras = pd.concat([
        meta_extras,
        probability_ranks(
            pairs,
            pairs["oof_pair_probability"].to_numpy(),
            "pair_probability",
        ),
        probability_ranks(
            pairs,
            alternative_candidate_probability,
            "candidate_probability",
        ),
        probability_ranks(
            pairs,
            alternative_ranker_score,
            "ranker_score",
        ),
    ], axis=1)
    meta_values = np.concatenate([
        base_values.astype(np.float32),
        meta_extras.to_numpy(dtype=np.float32),
    ], axis=1)
    meta_feature_names = pair_feature_names + list(meta_extras.columns)

    groups = pairs["file_id"].to_numpy()
    predictions = np.full(len(pairs), np.nan)
    folds = []
    splitter = GroupKFold(n_splits=5)
    for fold, (train, test) in enumerate(splitter.split(
        meta_values,
        pairs["pair_label"],
        groups,
    )):
        labels = pairs.iloc[train]["pair_label"]
        estimator = meta_model(labels, 16000 + fold)
        estimator.fit(meta_values[train], labels)
        predictions[test] = estimator.predict_proba(meta_values[test])[:, 1]
        folds.append({
            "fold": fold,
            "testFiles": sorted(set(groups[test])),
            "trainingPairs": len(train),
        })
    if np.isnan(predictions).any():
        raise RuntimeError("missing meta OOF probabilities")

    scored = pairs.copy()
    scored["meta_probability"] = predictions
    top = scored.sort_values(
        ["attempt_id", "meta_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()
    event_top = top[top["family"] != "Clean"]
    product_failures = event_top[~event_top["product_workflow"]]
    recoverable = scored[
        (~scored["product_workflow"])
        & scored["pair_label"].eq(1)
        & scored["family"].ne("Clean")
    ]["attempt_id"].nunique()
    thresholds = choose_zero_harm_thresholds(top)
    selected_thresholds = top["alternative_event_type"].map(thresholds).fillna(1.01)
    top["overridden"] = top["meta_probability"] >= selected_thresholds
    benefit = int((top["overridden"] & top["pair_label"].eq(1)).sum())
    harm = int((top["overridden"] & top["pair_harm"].eq(1)).sum())
    provisional_correct = int(
        np.where(
            top["overridden"],
            top["alternative_workflow"],
            top["product_workflow"],
        )[top["family"].ne("Clean")].sum()
    )
    event_attempts = len(event_top)
    summary: dict[str, Any] = {
        "schemaVersion": 1,
        "files": int(pairs["file_id"].nunique()),
        "candidateRows": len(candidates),
        "operationPairs": len(pairs),
        "features": len(meta_feature_names),
        "productFailures": len(product_failures),
        "recoverableFailures": recoverable,
        "metaTopCorrectFailures": int(product_failures["pair_label"].sum()),
        "metaTopCorrectRateAmongRecoverable": TRAINER.rate(
            int(product_failures["pair_label"].sum()),
            recoverable,
        ),
        "provisionalThresholds": thresholds,
        "provisionalEventAttempts": event_attempts,
        "provisionalCorrect": provisional_correct,
        "provisionalAccuracy": TRAINER.rate(provisional_correct, event_attempts),
        "provisionalBeneficialOverrides": benefit,
        "provisionalHarmfulOverrides": harm,
        "rankerFolds": ranker_folds,
        "metaFolds": folds,
    }
    top.to_csv(output_dir / "meta-top.csv", index=False)
    scored[[
        "attempt_id",
        "file_id",
        "family",
        "alternative_candidate_index",
        "product_candidate_index",
        "alternative_event_type",
        "alternative_shift_years",
        "alternative_start_year",
        "alternative_end_year",
        "pair_label",
        "pair_harm",
        "meta_probability",
        "oof_pair_probability",
    ]].to_csv(output_dir / "meta-pairs.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(meta_feature_names, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
