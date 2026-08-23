#!/usr/bin/env python3
"""Evaluate a truly hierarchical operation-identity then location model with file OOF."""

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


def classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=450,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=35,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.0,
        reg_lambda=3.0,
        scale_pos_weight=min(50.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def workflow_operation_correct(row: pd.Series) -> bool:
    return bool(row["operation_correct"]) or (
        row["truth_type"] == "missingRing"
        and row["candidate_event_type"] == "partialMove"
        and int(row["candidate_shift_years"]) < -1
    )


def build_identities(
    candidates: pd.DataFrame,
    features: pd.DataFrame,
) -> tuple[pd.DataFrame, np.ndarray, dict[tuple[str, str, int], np.ndarray]]:
    metadata: list[dict[str, Any]] = []
    vectors: list[np.ndarray] = []
    members: dict[tuple[str, str, int], np.ndarray] = {}
    for attempt_id, attempt in candidates.groupby("attempt_id", sort=False):
        package_identities = {
            (row["candidate_event_type"], int(row["candidate_shift_years"]))
            for _, row in attempt[
                (attempt["exact_product_primary"] > 0)
                | (attempt["exact_product_alternative"] > 0)
            ].iterrows()
        }
        for (event_type, shift_years), group in attempt.groupby(
            ["candidate_event_type", "candidate_shift_years"],
            sort=False,
        ):
            indices = group.index.to_numpy(dtype=int)
            key = (attempt_id, str(event_type), int(shift_years))
            members[key] = indices
            if (event_type, int(shift_years)) in package_identities:
                continue
            representative_index = int(group.sort_values(
                [
                    "operation_dynamic_score_max",
                    "exact_source_count",
                    "near_source_count",
                    "score_max",
                ],
                ascending=False,
            ).index[0])
            first = group.iloc[0]
            metadata.append({
                "identity_key": "|".join(map(str, key)),
                "attempt_id": attempt_id,
                "file_id": first["file_id"],
                "family": first["family"],
                "dataset_role": first["dataset_role"],
                "is_clean": int(first["is_clean"]),
                "event_type": event_type,
                "shift_years": int(shift_years),
                "product_correct": int(first["product_correct"]),
                "operation_correct": int(any(
                    workflow_operation_correct(row)
                    for _, row in group.iterrows()
                )),
                "strict_operation_correct": int(group["operation_correct"].max()),
                "representative_index": representative_index,
            })
            vectors.append(features.loc[representative_index].to_numpy(dtype=np.float32))
    return pd.DataFrame(metadata), np.stack(vectors), members


def file_oof(
    metadata: pd.DataFrame,
    values: np.ndarray,
    label: str,
    seed: int,
) -> np.ndarray:
    evaluation = metadata["dataset_role"].eq("evaluation").to_numpy()
    evaluation_files = np.array(sorted(metadata.loc[evaluation, "file_id"].unique()))
    predictions = np.full(len(metadata), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(evaluation_files)),
        groups=evaluation_files,
    )):
        test_files = set(evaluation_files[test_file_indices])
        train = np.flatnonzero(~metadata["file_id"].isin(test_files).to_numpy())
        test = np.flatnonzero(
            evaluation & metadata["file_id"].isin(test_files).to_numpy()
        )
        labels = metadata.iloc[train][label]
        model = classifier(labels, seed + fold)
        model.fit(values[train], labels)
        predictions[test] = model.predict_proba(values[test])[:, 1]
    if np.isnan(predictions[evaluation]).any():
        raise RuntimeError(f"missing OOF predictions for {label}")
    return predictions


def location_ranker_oof(
    metadata: pd.DataFrame,
    values: np.ndarray,
) -> np.ndarray:
    evaluation = metadata["dataset_role"].eq("evaluation").to_numpy()
    evaluation_files = np.array(sorted(metadata.loc[evaluation, "file_id"].unique()))
    predictions = np.full(len(metadata), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(evaluation_files)),
        groups=evaluation_files,
    )):
        test_files = set(evaluation_files[test_file_indices])
        train = np.flatnonzero(~metadata["file_id"].isin(test_files).to_numpy())
        test = np.flatnonzero(
            evaluation & metadata["file_id"].isin(test_files).to_numpy()
        )
        ordered = metadata.iloc[train].sort_values("identity_key").index.to_numpy(dtype=int)
        groups = metadata.loc[ordered].groupby("identity_key", sort=False).size().to_numpy()
        model = TRAINER.ranker_for(24000 + fold)
        model.fit(
            values[ordered],
            metadata.loc[ordered, "label_relaxed"],
            group=groups,
        )
        predictions[test] = model.predict(values[test])
    if np.isnan(predictions[evaluation]).any():
        raise RuntimeError("missing location ranker OOF predictions")
    return predictions


def operation_ranker_oof(
    metadata: pd.DataFrame,
    values: np.ndarray,
) -> np.ndarray:
    evaluation = metadata["dataset_role"].eq("evaluation").to_numpy()
    evaluation_files = np.array(sorted(metadata.loc[evaluation, "file_id"].unique()))
    predictions = np.full(len(metadata), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(evaluation_files)),
        groups=evaluation_files,
    )):
        test_files = set(evaluation_files[test_file_indices])
        train = np.flatnonzero(~metadata["file_id"].isin(test_files).to_numpy())
        test = np.flatnonzero(
            evaluation & metadata["file_id"].isin(test_files).to_numpy()
        )
        ordered = metadata.iloc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = metadata.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        model = TRAINER.ranker_for(24500 + fold)
        model.fit(
            values[ordered],
            metadata.loc[ordered, "operation_correct"],
            group=groups,
        )
        predictions[test] = model.predict(values[test])
    if np.isnan(predictions[evaluation]).any():
        raise RuntimeError("missing operation ranker OOF predictions")
    return predictions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-cache", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    candidates = pd.read_pickle(Path(args.candidate_cache).resolve())
    features, feature_names = TRAINER.encoded_features(candidates)
    identities, identity_values, members = build_identities(candidates, features)
    identity_probability = operation_ranker_oof(
        identities,
        identity_values,
    )
    identities["operation_probability"] = identity_probability

    identity_correct_by_candidate: dict[int, bool] = {}
    for key, indices in members.items():
        group = candidates.loc[indices]
        correct = any(workflow_operation_correct(row) for _, row in group.iterrows())
        for index in indices:
            identity_correct_by_candidate[int(index)] = correct
    location_training = candidates.loc[[
        index for index, correct in identity_correct_by_candidate.items() if correct
    ]].copy()
    location_training["identity_key"] = [
        "|".join(map(str, (
            row["attempt_id"],
            row["candidate_event_type"],
            int(row["candidate_shift_years"]),
        )))
        for _, row in location_training.iterrows()
    ]
    location_values = features.loc[location_training.index].to_numpy(dtype=np.float32)
    location_metadata = location_training[[
        "attempt_id",
        "file_id",
        "dataset_role",
        "identity_key",
        "label_relaxed",
    ]].copy().reset_index().rename(columns={"index": "candidate_index"})
    location_probability_rows = location_ranker_oof(
        location_metadata,
        location_values,
    )
    location_probability = dict(zip(
        location_metadata["candidate_index"].astype(int),
        location_probability_rows,
    ))

    evaluation_identities = identities[identities["dataset_role"] == "evaluation"].copy()
    top_identity = evaluation_identities.sort_values(
        ["attempt_id", "operation_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()
    rows = []
    for _, identity in top_identity.iterrows():
        key = (
            identity["attempt_id"],
            identity["event_type"],
            int(identity["shift_years"]),
        )
        candidate_indices = members[key]
        available = [
            index for index in candidate_indices
            if index in location_probability
        ]
        selected_index = max(
            available or list(candidate_indices),
            key=lambda index: location_probability.get(int(index), -np.inf),
        )
        selected = candidates.loc[int(selected_index)]
        rows.append({
            **identity.to_dict(),
            "selected_candidate_index": int(selected_index),
            "location_probability": location_probability.get(int(selected_index), 0.0),
            "workflow_correct": int(selected["label_workflow"]),
            "strict_correct": int(selected["label_strict"]),
            "location_correct": int(selected["location_correct"]),
            "selected_start_year": selected["candidate_start_year"],
            "selected_end_year": selected["candidate_end_year"],
            "selected_top_year": selected["candidate_top_year"],
        })
    top = pd.DataFrame(rows)
    event = top[top["family"] != "Clean"]
    product_failures = event[event["product_correct"] == 0]
    operation_recoverable = evaluation_identities[
        (evaluation_identities["family"] != "Clean")
        & evaluation_identities["product_correct"].eq(0)
        & evaluation_identities["operation_correct"].eq(1)
    ]["attempt_id"].nunique()
    operation_top_correct = int(product_failures["operation_correct"].sum())
    end_to_end_correct = int(product_failures["workflow_correct"].sum())
    summary = {
        "schemaVersion": 1,
        "files": int(evaluation_identities["file_id"].nunique()),
        "candidateRows": len(candidates),
        "identityRows": len(identities),
        "evaluationAttemptsWithAlternatives": len(event),
        "productFailures": len(product_failures),
        "operationRecoverableFailures": operation_recoverable,
        "operationTopCorrect": operation_top_correct,
        "operationTopCorrectRate": TRAINER.rate(
            operation_top_correct,
            operation_recoverable,
        ),
        "endToEndTopCorrect": end_to_end_correct,
        "endToEndTopCorrectRate": TRAINER.rate(
            end_to_end_correct,
            operation_recoverable,
        ),
        "strictEndToEndTopCorrect": int(product_failures["strict_correct"].sum()),
        "byFamily": {
            family: {
                "productFailures": len(product_failures[product_failures["family"] == family]),
                "operationTopCorrect": int(product_failures.loc[
                    product_failures["family"] == family,
                    "operation_correct",
                ].sum()),
                "endToEndTopCorrect": int(product_failures.loc[
                    product_failures["family"] == family,
                    "workflow_correct",
                ].sum()),
            }
            for family in ("A", "B", "C", "D")
        },
    }
    top.to_csv(output_dir / "hierarchical-top.csv", index=False)
    identities[identities["dataset_role"] == "evaluation"].to_csv(
        output_dir / "operation-identities.csv",
        index=False,
    )
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
