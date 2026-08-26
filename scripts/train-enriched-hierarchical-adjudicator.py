#!/usr/bin/env python3
"""File-OOF operation identity and same-identity location heads on enriched rows."""

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


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
JOINT = load_module(
    "enriched_joint_rows",
    ROOT / "train-joint-operation-year-adjudicator.py",
)


def operation_classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=650,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=35,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=5.0,
        scale_pos_weight=min(60.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def operation_ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=500,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=35,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=5.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def location_ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=550,
        learning_rate=0.02,
        num_leaves=31,
        min_child_samples=70,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.0,
        reg_lambda=4.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def build_identity_table(table: pd.DataFrame) -> pd.DataFrame:
    table = table.copy()
    table["identity_key"] = (
        table["attempt_id"].astype(str)
        + "|" + table["event_type"].astype(str)
        + "|" + table["shift_years"].astype(int).astype(str)
    )
    grouped = table.groupby("identity_key", sort=False)
    metadata_columns = [
        "identity_key", "attempt_id", "file_id", "family", "event_type",
        "shift_years", "shift_abs", "operation_probability", "operation_rank",
        "operation_rank_reciprocal", "package_identity", "operation_correct",
        "strict_operation_correct", "product_correct", "product_strict_correct",
        "baseline_lag", "shift_baseline_distance",
    ]
    metadata = grouped[metadata_columns].first().reset_index(drop=True)
    aggregate = grouped[list(JOINT.PROFILE_FIELDS)].agg(["max", "mean", "std"])
    aggregate.columns = [f"profile_{field}_{stat}" for field, stat in aggregate.columns]
    aggregate = aggregate.reset_index(drop=True).fillna(0)
    identities = pd.concat([metadata, aggregate], axis=1)

    peak_data = {}
    peak_years = []
    for field in JOINT.RANK_FIELDS:
        indices = grouped[field].idxmax()
        peaks = table.loc[indices, ["identity_key", "year"]].set_index(
            "identity_key"
        )["year"].reindex(metadata["identity_key"]).to_numpy()
        peak_data[f"peak_{field}_fraction"] = (
            peaks - grouped["year"].min().reindex(metadata["identity_key"]).to_numpy()
        ) / np.maximum(
            1,
            grouped["year"].max().reindex(metadata["identity_key"]).to_numpy()
            - grouped["year"].min().reindex(metadata["identity_key"]).to_numpy(),
        )
        peak_years.append(peaks)
    peak_matrix = np.stack(peak_years, axis=1)
    peak_data["peak_year_std"] = np.std(peak_matrix, axis=1)
    peak_data["peak_year_span"] = np.max(peak_matrix, axis=1) - np.min(
        peak_matrix, axis=1
    )
    peak_data["peak_year_median_deviation"] = np.median(
        np.abs(peak_matrix - np.median(peak_matrix, axis=1, keepdims=True)),
        axis=1,
    )
    identities = pd.concat([
        identities,
        pd.DataFrame(peak_data, index=identities.index),
    ], axis=1)

    rank_data = {}
    for field in JOINT.RANK_FIELDS:
        source = f"profile_{field}_max"
        groups = identities.groupby("attempt_id", sort=False)[source]
        rank_data[f"operation_{field}_percentile"] = groups.rank(
            method="average", pct=True
        )
        rank_data[f"operation_{field}_deficit"] = groups.transform("max") - identities[source]
    identities = pd.concat([
        identities,
        pd.DataFrame(rank_data, index=identities.index),
    ], axis=1)
    return identities


def encoded_values(
    table: pd.DataFrame,
    forbidden: set[str],
) -> tuple[pd.DataFrame, list[str]]:
    columns = [column for column in table.columns if column not in forbidden]
    values = pd.get_dummies(
        table[columns],
        columns=[column for column in columns if table[column].dtype == object],
        dtype=float,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows-manifest", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--operation-identities", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--row-cache")
    parser.add_argument("--stride", type=int, default=5)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.row_cache:
        cache_dir = Path(args.row_cache).resolve()
        rows = pd.read_pickle(cache_dir / "rows.pkl")
        attempts = pd.read_pickle(cache_dir / "attempts.pkl")
    else:
        rows, attempts = JOINT.build_table(
            Path(args.rows_manifest).resolve(),
            Path(args.run_dir).resolve(),
            Path(args.operation_identities).resolve(),
            max(1, args.stride),
        )
    rows["identity_key"] = (
        rows["attempt_id"].astype(str)
        + "|" + rows["event_type"].astype(str)
        + "|" + rows["shift_years"].astype(int).astype(str)
    )
    identities = build_identity_table(rows)
    operation_forbidden = {
        "identity_key", "attempt_id", "file_id", "family",
        "operation_correct", "strict_operation_correct", "product_correct",
        "product_strict_correct",
    }
    operation_values, operation_features = encoded_values(
        identities, operation_forbidden
    )
    row_forbidden = {
        "identity_key", "attempt_id", "file_id", "family", "product_correct",
        "product_strict_correct", "truth_year", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "year",
    }
    row_values, row_features = encoded_values(rows, row_forbidden)

    files = np.array(sorted(identities["file_id"].unique()))
    operation_predictions = np.full(len(identities), np.nan)
    operation_rank_predictions = np.full(len(identities), np.nan)
    location_predictions = np.full(len(rows), np.nan)
    typed_location_predictions = np.full(len(rows), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        operation_train = np.flatnonzero(
            ~identities["file_id"].isin(held_files).to_numpy()
        )
        operation_test = np.flatnonzero(
            identities["file_id"].isin(held_files).to_numpy()
        )
        operation_fold_predictions = []
        for seed in (38000 + fold * 10, 38001 + fold * 10, 38002 + fold * 10):
            estimator = operation_classifier(
                identities.loc[operation_train, "operation_correct"], seed
            )
            estimator.fit(
                operation_values.iloc[operation_train],
                identities.loc[operation_train, "operation_correct"],
            )
            operation_fold_predictions.append(
                estimator.predict_proba(operation_values.iloc[operation_test])[:, 1]
            )
        operation_predictions[operation_test] = np.mean(
            np.stack(operation_fold_predictions), axis=0
        )
        train_files_mask = ~identities["file_id"].isin(held_files)
        positive_attempts = set(identities.loc[
            train_files_mask & identities["operation_correct"].eq(1),
            "attempt_id",
        ])
        rank_train = np.flatnonzero((
            train_files_mask
            & identities["attempt_id"].isin(positive_attempts)
        ).to_numpy())
        rank_ordered = identities.iloc[rank_train].sort_values(
            "attempt_id"
        ).index.to_numpy(dtype=int)
        rank_groups = identities.loc[rank_ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
        rank_estimator = operation_ranker(38500 + fold)
        rank_estimator.fit(
            operation_values.loc[rank_ordered],
            identities.loc[rank_ordered, "operation_correct"],
            group=rank_groups,
        )
        operation_rank_predictions[operation_test] = rank_estimator.predict(
            operation_values.iloc[operation_test]
        )

        location_train_mask = (
            ~rows["file_id"].isin(held_files)
            & rows["operation_correct"].eq(1)
        )
        location_train = np.flatnonzero(location_train_mask.to_numpy())
        location_test = np.flatnonzero(
            rows["file_id"].isin(held_files).to_numpy()
        )
        ordered = rows.iloc[location_train].sort_values(
            "identity_key"
        ).index.to_numpy(dtype=int)
        groups = rows.loc[ordered].groupby("identity_key", sort=False).size().to_numpy()
        estimator = location_ranker(39000 + fold)
        estimator.fit(
            row_values.loc[ordered],
            rows.loc[ordered, "window_correct"],
            group=groups,
        )
        location_predictions[location_test] = estimator.predict(
            row_values.iloc[location_test]
        )
        for event_index, event_type in enumerate(
            ("missingRing", "falseRing", "partialMove")
        ):
            typed_train = np.flatnonzero((
                location_train_mask & rows["event_type"].eq(event_type)
            ).to_numpy())
            typed_test = np.flatnonzero((
                rows["file_id"].isin(held_files)
                & rows["event_type"].eq(event_type)
            ).to_numpy())
            typed_ordered = rows.iloc[typed_train].sort_values(
                "identity_key"
            ).index.to_numpy(dtype=int)
            typed_groups = rows.loc[typed_ordered].groupby(
                "identity_key", sort=False
            ).size().to_numpy()
            typed_estimator = location_ranker(39500 + fold * 10 + event_index)
            typed_estimator.fit(
                row_values.loc[typed_ordered],
                rows.loc[typed_ordered, "window_correct"],
                group=typed_groups,
            )
            typed_location_predictions[typed_test] = typed_estimator.predict(
                row_values.iloc[typed_test]
            )
    if (
        np.isnan(operation_predictions).any()
        or np.isnan(operation_rank_predictions).any()
        or np.isnan(location_predictions).any()
        or np.isnan(typed_location_predictions).any()
    ):
        raise RuntimeError("missing enriched hierarchical OOF predictions")
    identities["enriched_operation_probability"] = operation_predictions
    identities["enriched_operation_rank_score"] = operation_rank_predictions
    rows["enriched_location_score"] = location_predictions
    rows["enriched_typed_location_score"] = typed_location_predictions
    identity_groups = identities.groupby("attempt_id", sort=False)
    identities["operation_classifier_percentile"] = identity_groups[
        "enriched_operation_probability"
    ].rank(pct=True)
    identities["operation_ranker_percentile"] = identity_groups[
        "enriched_operation_rank_score"
    ].rank(pct=True)
    location_groups = rows.groupby("identity_key", sort=False)
    rows["location_global_percentile"] = location_groups[
        "enriched_location_score"
    ].rank(pct=True)
    rows["location_typed_percentile"] = location_groups[
        "enriched_typed_location_score"
    ].rank(pct=True)

    selections = []
    selected_by_weights = {}
    for operation_ranker_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        operation_score = (
            identities["operation_classifier_percentile"]
            * (1 - operation_ranker_weight)
            + identities["operation_ranker_percentile"]
            * operation_ranker_weight
        )
        top_identity = identities.assign(
            operation_blend_score=operation_score
        ).sort_values(
            ["attempt_id", "operation_blend_score"],
            ascending=[True, False],
        ).groupby("attempt_id", sort=False).head(1)
        selected_identity = top_identity.set_index("attempt_id")["identity_key"]
        selected_rows = rows[
            rows["identity_key"].eq(rows["attempt_id"].map(selected_identity))
        ].copy()
        for typed_location_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            selected_rows["location_blend_score"] = (
                selected_rows["location_global_percentile"]
                * (1 - typed_location_weight)
                + selected_rows["location_typed_percentile"]
                * typed_location_weight
            )
            selected = selected_rows.sort_values(
                ["attempt_id", "location_blend_score"],
                ascending=[True, False],
            ).groupby("attempt_id", sort=False).head(1).copy()
            failures = selected[
                (selected["family"] != "Clean")
                & selected["product_correct"].eq(0)
            ]
            record = {
                "operationRankerWeight": operation_ranker_weight,
                "typedLocationWeight": typed_location_weight,
                "operationTopCorrect": int(failures["operation_correct"].sum()),
                "completeCorrections": int(failures["window_correct"].sum()),
                "strictCorrections": int(failures["strict_correct"].sum()),
            }
            selections.append(record)
            selected_by_weights[
                (operation_ranker_weight, typed_location_weight)
            ] = selected
    selection_grid = pd.DataFrame(selections)
    best = selection_grid.sort_values(
        ["completeCorrections", "operationTopCorrect", "strictCorrections"],
        ascending=[False, False, False],
    ).iloc[0]
    best_weights = (
        float(best["operationRankerWeight"]),
        float(best["typedLocationWeight"]),
    )
    top = selected_by_weights[best_weights]
    result = attempts.merge(
        top,
        on=["attempt_id", "file_id", "family"],
        how="left",
        suffixes=("", "_proposal"),
    )
    event = result[result["family"] != "Clean"].copy()
    product_failures = event[event["product_correct"].eq(0)]
    recoverable = identities[
        (identities["family"] != "Clean")
        & identities["product_correct"].eq(0)
        & identities["operation_correct"].eq(1)
    ]["attempt_id"].nunique()
    complete_oracle = rows[
        (rows["family"] != "Clean")
        & rows["product_correct"].eq(0)
        & rows["window_correct"].eq(1)
    ]["attempt_id"].nunique()
    corrections = int(product_failures["window_correct"].sum())
    oracle_union = int((
        event["product_correct"].eq(1) | event["window_correct"].eq(1)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "files": int(event["file_id"].nunique()),
        "eventAttempts": len(event),
        "rowCount": len(rows),
        "identityCount": len(identities),
        "operationFeatures": len(operation_features),
        "locationFeatures": len(row_features),
        "frozenWeights": {
            "operationRanker": best_weights[0],
            "typedLocation": best_weights[1],
        },
        "productCorrect": int(event["product_correct"].sum()),
        "productFailures": len(product_failures),
        "operationRecoverableFailures": recoverable,
        "completeRecoverableFailures": complete_oracle,
        "operationTopCorrect": int(product_failures["operation_correct"].sum()),
        "completeTopCorrect": corrections,
        "strictCompleteTopCorrect": int(product_failures["strict_correct"].sum()),
        "oracleUnionCorrect": oracle_union,
        "oracleUnionAccuracy": oracle_union / max(1, len(event)),
        "byFamily": {
            family: {
                "events": len(group),
                "productCorrect": int(group["product_correct"].sum()),
                "operationTopCorrect": int(group.loc[
                    group["product_correct"].eq(0), "operation_correct"
                ].sum()),
                "completeCorrections": int(group.loc[
                    group["product_correct"].eq(0), "window_correct"
                ].sum()),
                "oracleUnionCorrect": int((
                    group["product_correct"].eq(1)
                    | group["window_correct"].eq(1)
                ).sum()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }
    top.to_csv(output_dir / "enriched-hierarchical-top.csv", index=False)
    selection_grid.to_csv(output_dir / "enriched-selection-grid.csv", index=False)
    identities.to_csv(output_dir / "enriched-operation-identities.csv", index=False)
    rows[[
        "attempt_id", "file_id", "family", "identity_key", "event_type",
        "shift_years", "operation_correct", "strict_operation_correct",
        "year", "window_correct", "strict_correct", "enriched_location_score",
    ]].to_pickle(output_dir / "enriched-location-scores.pkl")
    (output_dir / "operation-feature-names.json").write_text(
        json.dumps(operation_features, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "location-feature-names.json").write_text(
        json.dumps(row_features, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
