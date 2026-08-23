#!/usr/bin/env python3
"""Train a file-OOF detector for whether the immutable product package is wrong."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold


TRAINER_PATH = Path(__file__).with_name("train-unified-diagnosis-adjudicator.py")
SPEC = importlib.util.spec_from_file_location("unified_adjudicator", TRAINER_PATH)
assert SPEC and SPEC.loader
TRAINER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRAINER
SPEC.loader.exec_module(TRAINER)


def model(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=30,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.0,
        reg_lambda=3.0,
        scale_pos_weight=min(30.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-cache", required=True)
    parser.add_argument("--yearly-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    candidates = pd.read_pickle(Path(args.candidate_cache).resolve())
    features, feature_names = TRAINER.encoded_features(candidates)
    package_rows = []
    package_values = []
    for attempt_id, attempt in candidates.groupby("attempt_id", sort=False):
        primary = attempt[attempt["exact_product_primary"] > 0]
        if primary.empty:
            continue
        primary_index = int(primary.sort_values(
            ["exact_source_count", "near_source_count"],
            ascending=False,
        ).index[0])
        package = attempt[
            (attempt["exact_product_primary"] > 0)
            | (attempt["exact_product_alternative"] > 0)
        ]
        all_values = features.loc[attempt.index].to_numpy(dtype=np.float32)
        primary_values = features.loc[primary_index].to_numpy(dtype=np.float32)
        package_values_matrix = features.loc[package.index].to_numpy(dtype=np.float32)
        package_max = package_values_matrix.max(axis=0)
        candidate_max = all_values.max(axis=0)
        candidate_mean = all_values.mean(axis=0)
        candidate_std = all_values.std(axis=0)
        package_rows.append({
            "attempt_id": attempt_id,
            "file_id": attempt.iloc[0]["file_id"],
            "family": attempt.iloc[0]["family"],
            "dataset_role": attempt.iloc[0]["dataset_role"],
            "product_correct": int(attempt.iloc[0]["product_correct"]),
            "candidate_count": len(attempt),
            "package_member_count": len(package),
        })
        package_values.append(np.concatenate([
            primary_values,
            package_max,
            candidate_max,
            candidate_mean,
            candidate_std,
            candidate_max - package_max,
        ]))
    package = pd.DataFrame(package_rows)
    values = np.stack(package_values)
    labels = (~package["product_correct"].astype(bool)).astype(int)
    files = package["file_id"].to_numpy()
    evaluation = package["dataset_role"].eq("evaluation").to_numpy()
    evaluation_files = np.array(sorted(package.loc[evaluation, "file_id"].unique()))
    predictions = np.full(len(package), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(evaluation_files)),
        groups=evaluation_files,
    )):
        test_files = set(evaluation_files[test_file_indices])
        train = np.flatnonzero(~package["file_id"].isin(test_files).to_numpy())
        test = np.flatnonzero(
            evaluation & package["file_id"].isin(test_files).to_numpy()
        )
        estimator = model(labels.iloc[train], 27000 + fold)
        estimator.fit(values[train], labels.iloc[train])
        predictions[test] = estimator.predict_proba(values[test])[:, 1]
    if np.isnan(predictions[evaluation]).any():
        raise RuntimeError("missing package-error OOF predictions")
    package["package_error_probability"] = predictions
    evaluation_package = package[evaluation].copy()
    yearly = pd.read_csv(Path(args.yearly_top).resolve())
    joined = yearly.merge(
        evaluation_package[[
            "attempt_id",
            "package_error_probability",
        ]],
        on="attempt_id",
        how="inner",
        validate="one_to_one",
    )
    joined["proposal_correct"] = (
        joined["operation_correct"].eq(1)
        & joined["window_correct"].eq(1)
    )
    joined["benefit"] = joined["product_correct"].eq(0) & joined["proposal_correct"]
    joined["harm"] = joined["product_correct"].eq(1) & ~joined["proposal_correct"]
    thresholds = {}
    selected = []
    for event_type, group in joined.groupby("event_type"):
        options = []
        error_thresholds = sorted(set(
            np.linspace(0.05, 0.995, 190).tolist()
            + group["package_error_probability"].quantile(
                np.linspace(0.2, 0.999, 100)
            ).tolist()
            + [1.01]
        ))
        location_thresholds = sorted(set(
            group["location_score"].quantile(np.linspace(0, 1, 60)).tolist()
            + [-np.inf, np.inf]
        ))
        for error_threshold in error_thresholds:
            for location_threshold in location_thresholds:
                chosen = (
                    group["package_error_probability"] >= error_threshold
                ) & (group["location_score"] >= location_threshold)
                harm = int((chosen & group["harm"]).sum())
                benefit = int((chosen & group["benefit"]).sum())
                if harm:
                    continue
                options.append((
                    (benefit, -int(chosen.sum()), error_threshold, location_threshold),
                    error_threshold,
                    location_threshold,
                ))
        _, error_threshold, location_threshold = max(options, key=lambda item: item[0])
        thresholds[event_type] = {
            "packageError": error_threshold,
            "locationScore": location_threshold,
        }
        chosen = (
            group["package_error_probability"] >= error_threshold
        ) & (group["location_score"] >= location_threshold)
        selected.append(group.assign(selected=chosen))
    selected = pd.concat(selected, ignore_index=True)
    summary = {
        "schemaVersion": 1,
        "packageAttempts": len(evaluation_package),
        "packageErrors": int((~evaluation_package["product_correct"].astype(bool)).sum()),
        "packageErrorAuc": float(roc_auc_score(
            (~evaluation_package["product_correct"].astype(bool)).astype(int),
            evaluation_package["package_error_probability"],
        )),
        "proposalAttempts": len(joined),
        "proposalBenefits": int(joined["benefit"].sum()),
        "selectedBenefits": int((selected["selected"] & selected["benefit"]).sum()),
        "selectedHarms": int((selected["selected"] & selected["harm"]).sum()),
        "selectedTotal": int(selected["selected"].sum()),
        "thresholds": thresholds,
    }
    evaluation_package.to_csv(output_dir / "package-error-oof.csv", index=False)
    selected.to_csv(output_dir / "hierarchical-selective.csv", index=False)
    aggregate_feature_names = [
        *[f"primary_{name}" for name in feature_names],
        *[f"package_max_{name}" for name in feature_names],
        *[f"candidate_max_{name}" for name in feature_names],
        *[f"candidate_mean_{name}" for name in feature_names],
        *[f"candidate_std_{name}" for name in feature_names],
        *[f"candidate_advantage_{name}" for name in feature_names],
    ]
    (output_dir / "feature-names.json").write_text(
        json.dumps(aggregate_feature_names, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
