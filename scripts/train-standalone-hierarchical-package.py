#!/usr/bin/env python3
"""Train operation/shift and same-identity location heads with file-OOF isolation."""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from standalone_location_evidence import (
    append_year_evidence_consensus,
    candidate_percentile_columns,
    is_candidate_relative_evidence,
)


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
LABEL_COLUMNS = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "candidate_year",
    "operation_correct",
    "identity_operation_correct",
    "location_correct",
    "location_relevance",
    "location_error_years",
    "package_relevance",
    "workflow_correct",
    "strict_correct",
}


def ranker(seed: int, *, location: bool = False) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 3, 7] if location else [0, 1],
        n_estimators=650 if location else 750,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=24 if location else 28,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.25,
        reg_lambda=6.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=750,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=28,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.25,
        reg_lambda=6.0,
        scale_pos_weight=min(40.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def cluster_ids(packages: pd.DataFrame, *, by_file_id: bool) -> pd.Series:
    if by_file_id:
        return packages["file_id"].astype(str)
    return (
        packages["attempt_id"].str.split(":", n=1).str[0]
        + "|" + packages["file_id"].astype(str)
    )


def meta_ranker(seed: int, *, location: bool) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 3, 7] if location else [0, 1],
        n_estimators=500 if location else 400,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=60 if location else 36,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.5,
        reg_lambda=7.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def operation_meta_columns(frame: pd.DataFrame) -> list[str]:
    exact = {
        "event_type",
        "shift_years",
        "shift_abs",
        "candidate_count",
        "operation_rank_score",
        "operation_classifier_probability",
        "operation_rank_percentile",
        "operation_classifier_percentile",
        "typed_operation_rank_percentile",
        "typed_operation_classifier_percentile",
        "shift_rank_score",
        "shift_classifier_probability",
        "shift_rank_percentile",
        "shift_classifier_percentile",
        "max_runtime_score",
        "max_runtime_score_margin",
        "max_evidence_operation_probability",
        "max_evidence_operation_rank_reciprocal",
        "max_evidence_package_identity",
        "max_evidence_baseline_lag",
        "max_evidence_shift_baseline_distance",
        "max_context_reference_anchor_count",
        "max_context_cofecha_flagged",
        "max_bundle_has_alternative",
    }
    return [
        column
        for column in frame.columns
        if column in exact
        or column.startswith("source_count_")
        or column.startswith("support_")
    ]


def location_meta_columns(frame: pd.DataFrame) -> list[str]:
    exact = {
        "candidate_source",
        "event_type",
        "shift_years",
        "shift_abs",
        "candidate_has_response",
        "candidate_year_present",
        "context_reference_mode",
        "runtime_confidence",
        "runtime_score",
        "runtime_score_margin",
        "runtime_window_width",
        "evidence_year_fraction",
        "evidence_distance_from_operation_best",
        "evidence_distance_from_side_best",
        "evidence_enriched_location_score",
        "evidence_classifier_percentile",
        "evidence_typed_classifier_percentile",
        "evidence_location_classifier_blend",
        "location_global_score",
        "location_typed_score",
        "location_global_classifier_probability",
        "location_typed_classifier_probability",
        "location_global_percentile",
        "location_typed_percentile",
        "location_global_classifier_percentile",
        "location_typed_classifier_percentile",
    }
    relative = set(candidate_percentile_columns(frame))
    return [
        column
        for column in frame.columns
        if column in exact
        or column in relative
        or column.startswith("geometry_")
        or column.startswith("evidence_consensus_")
        or column.startswith("runtime_source__")
    ]


def grouped_oof_meta_rank(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
    train_mask: pd.Series,
    predict_mask: pd.Series,
    location: bool,
    seed: int,
) -> np.ndarray:
    predictions = np.full(len(frame), np.nan)
    files = np.array(sorted(frame["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train = frame.index[
            train_mask & ~frame["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        test = frame.index[
            predict_mask & frame["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        ordered = frame.loc[train].sort_values(group).index.to_numpy(dtype=int)
        groups = frame.loc[ordered].groupby(group, sort=False).size().to_numpy()
        estimator = meta_ranker(seed + fold, location=location)
        estimator.fit(
            values.loc[ordered],
            frame.loc[ordered, label],
            group=groups,
        )
        predictions[test] = estimator.predict(values.loc[test])
    return predictions


def encode(frame: pd.DataFrame, columns: list[str]) -> tuple[pd.DataFrame, list[str]]:
    raw = frame[columns].copy()
    categorical = [column for column in raw.columns if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def append_operation_support_features(operations: pd.DataFrame) -> pd.DataFrame:
    """Normalize operation evidence by the overlap it retains within an attempt.

    A large raw gain supported by a short surviving overlap must not be compared
    as if it had the same evidential weight as a gain seen across both sides of a
    well-supported boundary.  Ratios are computed only against competing runtime
    hypotheses from the same attempt, so no corpus or truth metadata is exposed.
    """

    output = operations.copy()
    grouped = output.groupby("attempt_id", sort=False)
    support_columns = [
        column
        for column in (
            "max_evidence_samplePairs",
            "max_evidence_differencePairs",
            "max_evidence_olderSamplePairs",
            "max_evidence_newerSamplePairs",
            "max_evidence_olderDifferencePairs",
            "max_evidence_newerDifferencePairs",
            "max_evidence_rawTransition_samplePairs",
            "max_evidence_cofechaTransition_samplePairs",
            "max_evidence_piecewise_olderPairs",
            "max_evidence_piecewise_newerPairs",
            "max_evidence_referenceChange_referenceCount",
            "max_evidence_referenceTransition_referenceCount",
            "max_evidence_perReference_referenceCount",
        )
        if column in output.columns
    ]
    for column in support_columns:
        values = pd.to_numeric(output[column], errors="coerce")
        maximum = grouped[column].transform("max")
        denominator = pd.to_numeric(maximum, errors="coerce").where(
            pd.to_numeric(maximum, errors="coerce") > 0
        )
        prefix = f"support_{column.removeprefix('max_evidence_')}"
        output[f"{prefix}_attempt_ratio"] = (values / denominator).astype(
            np.float32
        )
        output[f"{prefix}_attempt_percentile"] = grouped[column].rank(
            pct=True
        ).astype(np.float32)

    for name, older_column, newer_column in (
        (
            "raw_pairs",
            "max_evidence_olderSamplePairs",
            "max_evidence_newerSamplePairs",
        ),
        (
            "difference_pairs",
            "max_evidence_olderDifferencePairs",
            "max_evidence_newerDifferencePairs",
        ),
        (
            "piecewise_pairs",
            "max_evidence_piecewise_olderPairs",
            "max_evidence_piecewise_newerPairs",
        ),
    ):
        if older_column not in output or newer_column not in output:
            continue
        older = pd.to_numeric(output[older_column], errors="coerce")
        newer = pd.to_numeric(output[newer_column], errors="coerce")
        maximum = np.maximum(older, newer).replace(0, np.nan)
        output[f"support_{name}_side_balance"] = (
            np.minimum(older, newer) / maximum
        ).astype(np.float32)
        output[f"support_{name}_minimum"] = np.minimum(older, newer).astype(
            np.float32
        )

    raw_ratio = output.get("support_samplePairs_attempt_ratio")
    difference_ratio = output.get("support_differencePairs_attempt_ratio")
    for gain_column, ratio in (
        ("max_evidence_rawGain", raw_ratio),
        ("max_evidence_differenceGain", difference_ratio),
        (
            "max_evidence_combinedGain",
            (
                (raw_ratio.fillna(0) + difference_ratio.fillna(0)) / 2
                if raw_ratio is not None and difference_ratio is not None
                else raw_ratio if raw_ratio is not None else difference_ratio
            ),
        ),
    ):
        if gain_column not in output or ratio is None:
            continue
        output[f"support_weighted_{gain_column.removeprefix('max_evidence_')}"] = (
            pd.to_numeric(output[gain_column], errors="coerce")
            * np.sqrt(np.clip(ratio, 0, 1))
        ).astype(np.float32)
    return output


def operation_table(
    packages: pd.DataFrame, *, enable_support_features: bool = False
) -> pd.DataFrame:
    packages = packages.copy()
    packages["identity_group"] = (
        packages["attempt_id"].astype(str)
        + "|" + packages["event_type"].astype(str)
        + "|" + packages["shift_years"].astype(int).astype(str)
    )
    numeric = [
        column for column in packages.columns
        if column not in LABEL_COLUMNS
        and column not in {
            "identity_group",
            "candidate_source",
            "event_type",
            "context_reference_mode",
            "runtime_confidence",
            "evidence_location_mode_sources",
        }
        and pd.api.types.is_numeric_dtype(packages[column])
        and not column.startswith("runtime_note__")
        and not column.startswith("geometry_")
    ]
    grouped = packages.groupby("identity_group", sort=False)
    aggregate = grouped[numeric].max().add_prefix("max_")
    metadata = grouped.agg(
        attempt_id=("attempt_id", "first"),
        cluster_id=("cluster_id", "first"),
        file_id=("file_id", "first"),
        family=("family", "first"),
        is_clean=("is_clean", "first"),
        event_type=("event_type", "first"),
        shift_years=("shift_years", "first"),
        operation_correct=("operation_correct", "max"),
        candidate_count=("candidate_source", "size"),
    )
    source_counts = pd.crosstab(
        packages["identity_group"], packages["candidate_source"]
    ).add_prefix("source_count_")
    output = metadata.join(aggregate).join(source_counts).reset_index()
    output["shift_abs"] = output["shift_years"].abs()
    return (
        append_operation_support_features(output)
        if enable_support_features
        else output
    )


def operation_type_table(operations: pd.DataFrame) -> pd.DataFrame:
    """Collapse shift identities into a separate operation-type hypothesis."""

    table = operations.copy()
    table["type_group"] = (
        table["attempt_id"].astype(str) + "|" + table["event_type"].astype(str)
    )
    excluded = {
        "identity_group",
        "type_group",
        "attempt_id",
        "cluster_id",
        "file_id",
        "family",
        "event_type",
        "operation_correct",
    }
    numeric = [
        column
        for column in table.columns
        if column not in excluded
        and pd.api.types.is_numeric_dtype(table[column])
    ]
    grouped = table.groupby("type_group", sort=False)
    aggregate = grouped[numeric].max().add_prefix("type_max_")
    metadata = grouped.agg(
        attempt_id=("attempt_id", "first"),
        cluster_id=("cluster_id", "first"),
        file_id=("file_id", "first"),
        family=("family", "first"),
        is_clean=("is_clean", "first"),
        event_type=("event_type", "first"),
        operation_correct=("operation_correct", "max"),
        shift_identity_count=("shift_years", "size"),
        shift_minimum=("shift_years", "min"),
        shift_maximum=("shift_years", "max"),
        shift_mean=("shift_years", "mean"),
        shift_standard_deviation=("shift_years", "std"),
    )
    return metadata.join(aggregate).reset_index()


def clustered_lower(selected: pd.DataFrame, seed: int, repetitions: int) -> float:
    files = np.array(sorted(selected["cluster_id"].unique()))
    grouped = {
        file_id: selected[selected["cluster_id"].eq(file_id)][
            "final_correct"
        ].to_numpy(dtype=float)
        for file_id in files
    }
    rng = np.random.default_rng(seed)
    values = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sampled = rng.choice(files, size=len(files), replace=True)
        values[index] = np.concatenate([grouped[file_id] for file_id in sampled]).mean()
    return float(np.quantile(values, 0.05, method="lower"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tables", required=True, nargs="+")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    parser.add_argument("--maximum-clean-false-positives", type=int, default=1)
    parser.add_argument("--exclude-candidate-sources", nargs="*", default=[])
    parser.add_argument("--enable-relative-evidence", action="store_true")
    parser.add_argument("--enable-factorized-operation", action="store_true")
    parser.add_argument("--enable-operation-support", action="store_true")
    parser.add_argument(
        "--enable-oof-meta-heads",
        action="store_true",
        help="Learn file-OOF fusion heads over independent base-head predictions.",
    )
    parser.add_argument(
        "--cluster-by-file-id",
        action="store_true",
        help="Keep every scenario derived from the same RWL file in one OOF fold.",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    packages = pd.concat(
        [pd.read_pickle(Path(path).resolve()) for path in args.tables],
        ignore_index=True,
        sort=False,
    )
    if args.exclude_candidate_sources:
        packages = packages[
            ~packages["candidate_source"].isin(args.exclude_candidate_sources)
        ].reset_index(drop=True)
    packages = packages.copy()
    packages["cluster_id"] = cluster_ids(
        packages,
        by_file_id=args.cluster_by_file_id,
    )
    packages["identity_group"] = (
        packages["attempt_id"].astype(str)
        + "|" + packages["event_type"].astype(str)
        + "|" + packages["shift_years"].astype(int).astype(str)
    )
    operations = operation_table(
        packages, enable_support_features=args.enable_operation_support
    )
    operation_types = (
        operation_type_table(operations)
        if args.enable_factorized_operation
        else pd.DataFrame()
    )
    identity_operation_correct = operations.set_index("identity_group")[
        "operation_correct"
    ]
    packages["identity_operation_correct"] = packages["identity_group"].map(
        identity_operation_correct
    ).fillna(0).astype(int)
    packages["package_relevance"] = np.where(
        packages["workflow_correct"].eq(1),
        packages["location_relevance"],
        0,
    ).astype(np.int8)
    if args.enable_relative_evidence:
        packages = append_year_evidence_consensus(packages)
    operation_columns = [
        column for column in operations.columns
        if column not in {
            "identity_group",
            "attempt_id",
            "cluster_id",
            "file_id",
            "family",
            "is_clean",
            "operation_correct",
        }
    ]
    operation_values, operation_features = encode(operations, operation_columns)
    if args.enable_factorized_operation:
        type_columns = [
            column
            for column in operation_types.columns
            if column not in {
                "type_group",
                "attempt_id",
                "cluster_id",
                "file_id",
                "family",
                "is_clean",
                "operation_correct",
            }
        ]
        type_values, type_features = encode(operation_types, type_columns)
    else:
        type_values = pd.DataFrame()
        type_features = []

    location_columns = [
        column for column in packages.columns
        if column not in LABEL_COLUMNS
        and column not in {"identity_group", "candidate_year"}
        and not column.startswith("runtime_note__")
        and (
            column in {
                "candidate_source",
                "event_type",
                "shift_years",
                "shift_abs",
                "candidate_has_response",
                "candidate_year_present",
                "context_reference_mode",
                "runtime_confidence",
            }
            or column.startswith("context_")
            or column.startswith("runtime_source__")
            or column.startswith("geometry_")
            or column.startswith("bundle_")
            or (
                is_candidate_relative_evidence(column)
                if args.enable_relative_evidence
                else (
                    column.startswith("evidence_")
                    and not column.startswith("evidence_identity_")
                )
            )
        )
    ]
    location_values, location_features = encode(packages, location_columns)
    files = np.array(sorted(packages["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    operation_rank_predictions = np.full(len(operations), np.nan)
    operation_classifier_predictions = np.full(len(operations), np.nan)
    type_rank_predictions = np.full(len(operation_types), np.nan)
    type_classifier_predictions = np.full(len(operation_types), np.nan)
    shift_rank_predictions = np.full(len(operations), np.nan)
    shift_classifier_predictions = np.full(len(operations), np.nan)
    location_global_predictions = np.full(len(packages), np.nan)
    location_typed_predictions = np.full(len(packages), np.nan)
    location_global_classifier_predictions = np.full(len(packages), np.nan)
    location_typed_classifier_predictions = np.full(len(packages), np.nan)

    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        operation_train = operations.index[
            ~operations["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        operation_test = operations.index[
            operations["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        ordered = operations.loc[operation_train].sort_values(
            "attempt_id"
        ).index.to_numpy(dtype=int)
        groups = operations.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        operation_ranker = ranker(71000 + fold)
        operation_ranker.fit(
            operation_values.loc[ordered],
            operations.loc[ordered, "operation_correct"],
            group=groups,
        )
        operation_rank_predictions[operation_test] = operation_ranker.predict(
            operation_values.loc[operation_test]
        )
        operation_classifier = classifier(
            operations.loc[operation_train, "operation_correct"], 71500 + fold
        )
        operation_classifier.fit(
            operation_values.loc[operation_train],
            operations.loc[operation_train, "operation_correct"],
        )
        operation_classifier_predictions[operation_test] = (
            operation_classifier.predict_proba(
                operation_values.loc[operation_test]
            )[:, 1]
        )
        if args.enable_factorized_operation:
            type_train = operation_types.index[
                ~operation_types["cluster_id"].isin(held_files)
            ].to_numpy(dtype=int)
            type_test = operation_types.index[
                operation_types["cluster_id"].isin(held_files)
            ].to_numpy(dtype=int)
            type_ordered = operation_types.loc[type_train].sort_values(
                "attempt_id"
            ).index.to_numpy(dtype=int)
            type_groups = operation_types.loc[type_ordered].groupby(
                "attempt_id", sort=False
            ).size().to_numpy()
            type_ranker = ranker(71750 + fold)
            type_ranker.fit(
                type_values.loc[type_ordered],
                operation_types.loc[type_ordered, "operation_correct"],
                group=type_groups,
            )
            type_rank_predictions[type_test] = type_ranker.predict(
                type_values.loc[type_test]
            )
            type_classifier = classifier(
                operation_types.loc[type_train, "operation_correct"],
                71850 + fold,
            )
            type_classifier.fit(
                type_values.loc[type_train],
                operation_types.loc[type_train, "operation_correct"],
            )
            type_classifier_predictions[type_test] = type_classifier.predict_proba(
                type_values.loc[type_test]
            )[:, 1]

            correct_type = operations.groupby(
                ["attempt_id", "event_type"], sort=False
            )["operation_correct"].transform("max").eq(1)
            for offset, event_type in enumerate(sorted(operations["event_type"].unique())):
                shift_train = operations.index[
                    ~operations["cluster_id"].isin(held_files)
                    & operations["event_type"].eq(event_type)
                    & correct_type
                ].to_numpy(dtype=int)
                shift_test = operations.index[
                    operations["cluster_id"].isin(held_files)
                    & operations["event_type"].eq(event_type)
                ].to_numpy(dtype=int)
                labels = operations.loc[shift_train, "operation_correct"]
                if labels.nunique() < 2:
                    shift_rank_predictions[shift_test] = float(labels.mean())
                    shift_classifier_predictions[shift_test] = float(labels.mean())
                    continue
                shift_ordered = operations.loc[shift_train].sort_values(
                    "attempt_id"
                ).index.to_numpy(dtype=int)
                shift_groups = operations.loc[shift_ordered].groupby(
                    "attempt_id", sort=False
                ).size().to_numpy()
                shift_ranker = ranker(71900 + fold * 10 + offset)
                shift_ranker.fit(
                    operation_values.loc[shift_ordered],
                    operations.loc[shift_ordered, "operation_correct"],
                    group=shift_groups,
                )
                shift_rank_predictions[shift_test] = shift_ranker.predict(
                    operation_values.loc[shift_test]
                )
                shift_classifier = classifier(labels, 71950 + fold * 10 + offset)
                shift_classifier.fit(
                    operation_values.loc[shift_train], labels
                )
                shift_classifier_predictions[shift_test] = (
                    shift_classifier.predict_proba(
                        operation_values.loc[shift_test]
                    )[:, 1]
                )

        local = packages["event_type"].isin(LOCAL_EVENT_TYPES)
        location_train_mask = (
            ~packages["cluster_id"].isin(held_files)
            & local
            & packages["identity_operation_correct"].eq(1)
        )
        location_test_mask = packages["cluster_id"].isin(held_files) & local
        location_train = packages.index[location_train_mask].to_numpy(dtype=int)
        location_test = packages.index[location_test_mask].to_numpy(dtype=int)
        location_ordered = packages.loc[location_train].sort_values(
            "identity_group"
        ).index.to_numpy(dtype=int)
        location_groups = packages.loc[location_ordered].groupby(
            "identity_group", sort=False
        ).size().to_numpy()
        global_location = ranker(72000 + fold, location=True)
        global_location.fit(
            location_values.loc[location_ordered],
            packages.loc[location_ordered, "package_relevance"],
            group=location_groups,
        )
        location_global_predictions[location_test] = global_location.predict(
            location_values.loc[location_test]
        )
        location_group_size = packages.loc[location_train].groupby(
            "identity_group"
        )["identity_group"].transform("size")
        global_location_classifier = classifier(
            packages.loc[location_train, "workflow_correct"], 72250 + fold
        )
        global_location_classifier.fit(
            location_values.loc[location_train],
            packages.loc[location_train, "workflow_correct"],
            sample_weight=(1 / location_group_size).to_numpy(dtype=float),
        )
        location_global_classifier_predictions[location_test] = (
            global_location_classifier.predict_proba(
                location_values.loc[location_test]
            )[:, 1]
        )
        for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
            typed_train = packages.index[
                location_train_mask & packages["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            typed_test = packages.index[
                location_test_mask & packages["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            typed_ordered = packages.loc[typed_train].sort_values(
                "identity_group"
            ).index.to_numpy(dtype=int)
            typed_groups = packages.loc[typed_ordered].groupby(
                "identity_group", sort=False
            ).size().to_numpy()
            typed_location = ranker(72500 + fold * 10 + offset, location=True)
            typed_location.fit(
                location_values.loc[typed_ordered],
                packages.loc[typed_ordered, "package_relevance"],
                group=typed_groups,
            )
            location_typed_predictions[typed_test] = typed_location.predict(
                location_values.loc[typed_test]
            )
            typed_group_size = packages.loc[typed_train].groupby(
                "identity_group"
            )["identity_group"].transform("size")
            typed_location_classifier = classifier(
                packages.loc[typed_train, "workflow_correct"],
                72750 + fold * 10 + offset,
            )
            typed_location_classifier.fit(
                location_values.loc[typed_train],
                packages.loc[typed_train, "workflow_correct"],
                sample_weight=(1 / typed_group_size).to_numpy(dtype=float),
            )
            location_typed_classifier_predictions[typed_test] = (
                typed_location_classifier.predict_proba(
                    location_values.loc[typed_test]
                )[:, 1]
            )

    if (
        np.isnan(operation_rank_predictions).any()
        or np.isnan(operation_classifier_predictions).any()
        or (
            args.enable_factorized_operation
            and (
                np.isnan(type_rank_predictions).any()
                or np.isnan(type_classifier_predictions).any()
                or np.isnan(shift_rank_predictions).any()
                or np.isnan(shift_classifier_predictions).any()
            )
        )
        or np.isnan(location_global_predictions[
            packages["event_type"].isin(LOCAL_EVENT_TYPES)
        ]).any()
        or np.isnan(location_typed_predictions[
            packages["event_type"].isin(LOCAL_EVENT_TYPES)
        ]).any()
        or np.isnan(location_global_classifier_predictions[
            packages["event_type"].isin(LOCAL_EVENT_TYPES)
        ]).any()
        or np.isnan(location_typed_classifier_predictions[
            packages["event_type"].isin(LOCAL_EVENT_TYPES)
        ]).any()
    ):
        raise RuntimeError("missing hierarchical standalone OOF predictions")

    # The encoded base matrices are the largest objects in the 33-file run and
    # are no longer needed once every base head has emitted its OOF scores.
    # Releasing them before encoding the meta heads prevents both generations
    # from coexisting at the process memory peak.
    del operation_values, location_values
    if args.enable_factorized_operation:
        del type_values
    gc.collect()

    operations["operation_rank_score"] = operation_rank_predictions
    operations["operation_classifier_probability"] = operation_classifier_predictions
    operation_groups = operations.groupby("attempt_id", sort=False)
    operations["operation_rank_percentile"] = operation_groups[
        "operation_rank_score"
    ].rank(pct=True)
    operations["operation_classifier_percentile"] = operation_groups[
        "operation_classifier_probability"
    ].rank(pct=True)
    if args.enable_factorized_operation:
        operation_types["type_rank_score"] = type_rank_predictions
        operation_types["type_classifier_probability"] = type_classifier_predictions
        type_groups = operation_types.groupby("attempt_id", sort=False)
        operation_types["type_rank_percentile"] = type_groups[
            "type_rank_score"
        ].rank(pct=True)
        operation_types["type_classifier_percentile"] = type_groups[
            "type_classifier_probability"
        ].rank(pct=True)
        type_rank_by_group = operation_types.set_index("type_group")[
            "type_rank_percentile"
        ]
        type_classifier_by_group = operation_types.set_index("type_group")[
            "type_classifier_percentile"
        ]
        operations["type_group"] = (
            operations["attempt_id"].astype(str)
            + "|"
            + operations["event_type"].astype(str)
        )
        operations["shift_rank_score"] = shift_rank_predictions
        operations["shift_classifier_probability"] = shift_classifier_predictions
        shift_groups = operations.groupby(
            ["attempt_id", "event_type"], sort=False
        )
        operations["shift_rank_percentile"] = shift_groups[
            "shift_rank_score"
        ].rank(pct=True)
        operations["shift_classifier_percentile"] = shift_groups[
            "shift_classifier_probability"
        ].rank(pct=True)
        operations["typed_operation_rank_percentile"] = (
            operations["type_group"].map(type_rank_by_group) * 0.75
            + operations["shift_rank_percentile"] * 0.25
        )
        operations["typed_operation_classifier_percentile"] = (
            operations["type_group"].map(type_classifier_by_group) * 0.75
            + operations["shift_classifier_percentile"] * 0.25
        )
    packages["location_global_score"] = location_global_predictions
    packages["location_typed_score"] = location_typed_predictions
    packages["location_global_classifier_probability"] = (
        location_global_classifier_predictions
    )
    packages["location_typed_classifier_probability"] = (
        location_typed_classifier_predictions
    )
    local_mask = packages["event_type"].isin(LOCAL_EVENT_TYPES)
    local_groups = packages[local_mask].groupby("identity_group", sort=False)
    packages.loc[local_mask, "location_global_percentile"] = local_groups[
        "location_global_score"
    ].rank(pct=True)
    packages.loc[local_mask, "location_typed_percentile"] = local_groups[
        "location_typed_score"
    ].rank(pct=True)
    packages.loc[local_mask, "location_global_classifier_percentile"] = local_groups[
        "location_global_classifier_probability"
    ].rank(pct=True)
    packages.loc[local_mask, "location_typed_classifier_percentile"] = local_groups[
        "location_typed_classifier_probability"
    ].rank(pct=True)

    operation_meta_features: list[str] = []
    location_meta_features: list[str] = []
    if args.enable_oof_meta_heads:
        operation_meta_columns_selected = operation_meta_columns(operations)
        operation_meta_values, operation_meta_features = encode(
            operations, operation_meta_columns_selected
        )
        operation_meta_predictions = grouped_oof_meta_rank(
            operations,
            operation_meta_values,
            label="operation_correct",
            group="attempt_id",
            train_mask=pd.Series(True, index=operations.index),
            predict_mask=pd.Series(True, index=operations.index),
            location=False,
            seed=73500,
        )
        if np.isnan(operation_meta_predictions).any():
            raise RuntimeError("missing operation meta-head OOF predictions")
        operations["operation_meta_score"] = operation_meta_predictions
        operations["operation_meta_percentile"] = operations.groupby(
            "attempt_id", sort=False
        )["operation_meta_score"].rank(pct=True)

        packages = append_year_evidence_consensus(packages)
        location_meta_columns_selected = location_meta_columns(packages)
        location_meta_values, location_meta_features = encode(
            packages, location_meta_columns_selected
        )
        meta_train_mask = (
            local_mask & packages["identity_operation_correct"].eq(1)
        )
        location_meta_predictions = grouped_oof_meta_rank(
            packages,
            location_meta_values,
            label="package_relevance",
            group="identity_group",
            train_mask=meta_train_mask,
            predict_mask=local_mask,
            location=True,
            seed=74000,
        )
        if np.isnan(location_meta_predictions[local_mask]).any():
            raise RuntimeError("missing location meta-head OOF predictions")
        packages["location_meta_score"] = location_meta_predictions
        packages.loc[local_mask, "location_meta_percentile"] = packages[
            local_mask
        ].groupby("identity_group", sort=False)["location_meta_score"].rank(
            pct=True
        )
        del operation_meta_values, location_meta_values
        gc.collect()

    location_tops: dict[tuple[float, float], pd.DataFrame] = {}
    for typed_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        rank_score = (
            packages["location_global_percentile"] * (1 - typed_weight)
            + packages["location_typed_percentile"] * typed_weight
        )
        classifier_score = (
            packages["location_global_classifier_percentile"] * (1 - typed_weight)
            + packages["location_typed_classifier_percentile"] * typed_weight
        )
        for classifier_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            location_score = (
                rank_score * (1 - classifier_weight)
                + classifier_score * classifier_weight
            )
            location_tops[(typed_weight, classifier_weight)] = (
                packages.assign(location_score=location_score)
                .sort_values(
                    ["identity_group", "location_score"],
                    ascending=[True, False],
                )
                .groupby("identity_group", sort=False)
                .head(1)
                [[
                    "identity_group",
                    "location_correct",
                    "workflow_correct",
                    "candidate_source",
                    "candidate_year",
                ]]
                .set_index("identity_group")
            )
    if args.enable_oof_meta_heads:
        location_tops[(2.0, 2.0)] = (
            packages.assign(location_score=packages["location_meta_percentile"])
            .sort_values(
                ["identity_group", "location_score"],
                ascending=[True, False],
            )
            .groupby("identity_group", sort=False)
            .head(1)
            [[
                "identity_group",
                "location_correct",
                "workflow_correct",
                "candidate_source",
                "candidate_year",
            ]]
            .set_index("identity_group")
        )

    operation_score_options: list[tuple[float, float, pd.Series]] = []
    for operation_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        global_operation_score = (
            operations["operation_rank_percentile"] * (1 - operation_weight)
            + operations["operation_classifier_percentile"] * operation_weight
        )
        typed_operation_weights = (
            (0.0, 0.25, 0.5, 0.75, 1.0)
            if args.enable_factorized_operation
            else (0.0,)
        )
        for typed_operation_weight in typed_operation_weights:
            if args.enable_factorized_operation:
                typed_operation_score = (
                    operations["typed_operation_rank_percentile"]
                    * (1 - operation_weight)
                    + operations["typed_operation_classifier_percentile"]
                    * operation_weight
                )
                operation_score = (
                    global_operation_score * (1 - typed_operation_weight)
                    + typed_operation_score * typed_operation_weight
                )
            else:
                operation_score = global_operation_score
            operation_score_options.append((
                operation_weight,
                typed_operation_weight,
                operation_score,
            ))
    if args.enable_oof_meta_heads:
        operation_score_options.append((
            2.0,
            2.0,
            operations["operation_meta_percentile"],
        ))

    selected_operation_columns = [
        "attempt_id",
        "cluster_id",
        "file_id",
        "family",
        "is_clean",
        "identity_group",
        "event_type",
        "shift_years",
        "operation_correct",
    ]

    def select_operation_top(operation_score: pd.Series) -> pd.DataFrame:
        return (
            operations.assign(operation_score=operation_score)
            .sort_values(
                ["attempt_id", "operation_score"], ascending=[True, False]
            )
            .groupby("attempt_id", sort=False)
            .head(1)[selected_operation_columns]
            .copy()
        )

    def project_selected(
        operation_top: pd.DataFrame,
        location_top: pd.DataFrame,
    ) -> pd.DataFrame:
        selected = operation_top.copy()
        selected["location_correct"] = selected["identity_group"].map(
            location_top["location_correct"]
        )
        selected["selected_package_correct"] = selected[
            "identity_group"
        ].map(location_top["workflow_correct"])
        selected["selected_candidate_source"] = selected[
            "identity_group"
        ].map(location_top["candidate_source"])
        selected["selected_candidate_year"] = selected[
            "identity_group"
        ].map(location_top["candidate_year"])
        local_selected = selected["event_type"].isin(LOCAL_EVENT_TYPES)
        selected["final_correct"] = selected["operation_correct"].astype(int)
        selected.loc[local_selected, "final_correct"] = (
            selected.loc[local_selected, "selected_package_correct"]
            .fillna(0)
            .astype(int)
        )
        selected["candidate_has_response"] = selected["event_type"].ne(
            "noEvent"
        ).astype(int)
        return selected

    grid_rows = []
    for (
        operation_weight,
        typed_operation_weight,
        operation_score,
    ) in operation_score_options:
        operation_top = select_operation_top(operation_score)
        for (typed_weight, classifier_weight), location_top in location_tops.items():
            selected = project_selected(operation_top, location_top)
            event = selected[selected["family"] != "Clean"]
            clean = selected[selected["family"] == "Clean"]
            grid_rows.append({
                "operationClassifierWeight": operation_weight,
                "typedOperationWeight": typed_operation_weight,
                "typedLocationWeight": typed_weight,
                "locationClassifierWeight": classifier_weight,
                "eventCorrect": int(event["final_correct"].sum()),
                "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
            })

    grid = pd.DataFrame(grid_rows)
    eligible = grid[
        grid["cleanFalsePositives"].le(args.maximum_clean_false_positives)
    ]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["eventCorrect", "cleanFalsePositives"], ascending=[False, True]
    ).iloc[0]
    weights = (
        float(best["operationClassifierWeight"]),
        float(best["typedOperationWeight"]),
        float(best["typedLocationWeight"]),
        float(best["locationClassifierWeight"]),
    )
    selected_operation_score = next(
        score
        for operation_weight, typed_operation_weight, score
        in operation_score_options
        if operation_weight == weights[0]
        and typed_operation_weight == weights[1]
    )
    selected = project_selected(
        select_operation_top(selected_operation_score),
        location_tops[(weights[2], weights[3])],
    )
    event = selected[selected["family"] != "Clean"]
    clean = selected[selected["family"] == "Clean"]
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["final_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": clustered_lower(
                group, 73000 + ord(family[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family")
    }
    summary = {
        "schemaVersion": 1,
        "files": int(packages["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "operationIdentities": len(operations),
        "operationTypes": len(operation_types),
        "locationPackages": len(packages),
        "operationFeatures": len(operation_features),
        "operationTypeFeatures": len(type_features),
        "locationFeatures": len(location_features),
        "operationMetaFeatures": len(operation_meta_features),
        "locationMetaFeatures": len(location_meta_features),
        "weights": {
            "operationClassifier": weights[0],
            "typedOperation": weights[1],
            "typedLocation": weights[2],
            "locationClassifier": weights[3],
        },
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneAccuracy": float(event["final_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "overallOneSided95FileClusterLower": clustered_lower(
            event, 73999, args.bootstrap_repetitions
        ),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "byFamily": by_family,
    }
    operations.to_pickle(output_dir / "operation-oof-scores.pkl")
    if args.enable_factorized_operation:
        operation_types.to_pickle(output_dir / "operation-type-oof-scores.pkl")
    packages.to_pickle(output_dir / "location-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-hierarchical-top.csv", index=False)
    grid.to_csv(output_dir / "hierarchical-grid.csv", index=False)
    (output_dir / "operation-feature-names.json").write_text(
        json.dumps(operation_features, indent=2) + "\n", encoding="utf8"
    )
    if args.enable_factorized_operation:
        (output_dir / "operation-type-feature-names.json").write_text(
            json.dumps(type_features, indent=2) + "\n", encoding="utf8"
        )
    (output_dir / "location-feature-names.json").write_text(
        json.dumps(location_features, indent=2) + "\n", encoding="utf8"
    )
    if args.enable_oof_meta_heads:
        (output_dir / "operation-meta-feature-names.json").write_text(
            json.dumps(operation_meta_features, indent=2) + "\n", encoding="utf8"
        )
        (output_dir / "location-meta-feature-names.json").write_text(
            json.dumps(location_meta_features, indent=2) + "\n", encoding="utf8"
        )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
