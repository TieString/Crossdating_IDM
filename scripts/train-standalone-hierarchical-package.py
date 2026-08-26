#!/usr/bin/env python3
"""Train operation/shift and same-identity location heads with file-OOF isolation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from standalone_location_evidence import (
    append_year_evidence_consensus,
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


def encode(frame: pd.DataFrame, columns: list[str]) -> tuple[pd.DataFrame, list[str]]:
    raw = frame[columns].copy()
    categorical = [column for column in raw.columns if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def operation_table(packages: pd.DataFrame) -> pd.DataFrame:
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
    return output


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
    parser.add_argument("--enable-relative-evidence", action="store_true")
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    packages = pd.concat(
        [pd.read_pickle(Path(path).resolve()) for path in args.tables],
        ignore_index=True,
        sort=False,
    )
    packages = packages.copy()
    packages["cluster_id"] = (
        packages["attempt_id"].str.split(":", n=1).str[0]
        + "|" + packages["file_id"].astype(str)
    )
    packages["identity_group"] = (
        packages["attempt_id"].astype(str)
        + "|" + packages["event_type"].astype(str)
        + "|" + packages["shift_years"].astype(int).astype(str)
    )
    operations = operation_table(packages)
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

    operations["operation_rank_score"] = operation_rank_predictions
    operations["operation_classifier_probability"] = operation_classifier_predictions
    operation_groups = operations.groupby("attempt_id", sort=False)
    operations["operation_rank_percentile"] = operation_groups[
        "operation_rank_score"
    ].rank(pct=True)
    operations["operation_classifier_percentile"] = operation_groups[
        "operation_classifier_probability"
    ].rank(pct=True)
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
                .set_index("identity_group")
            )

    selections: dict[tuple[float, float, float], pd.DataFrame] = {}
    grid_rows = []
    for operation_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        operation_score = (
            operations["operation_rank_percentile"] * (1 - operation_weight)
            + operations["operation_classifier_percentile"] * operation_weight
        )
        operation_top = operations.assign(operation_score=operation_score).sort_values(
            ["attempt_id", "operation_score"], ascending=[True, False]
        ).groupby("attempt_id", sort=False).head(1)
        for (typed_weight, classifier_weight), location_top in location_tops.items():
            selected = operation_top.copy()
            selected["location_correct"] = selected["identity_group"].map(
                location_top["location_correct"]
            )
            selected["selected_package_correct"] = selected["identity_group"].map(
                location_top["workflow_correct"]
            )
            selected["selected_candidate_source"] = selected["identity_group"].map(
                location_top["candidate_source"]
            )
            selected["selected_candidate_year"] = selected["identity_group"].map(
                location_top["candidate_year"]
            )
            local_selected = selected["event_type"].isin(LOCAL_EVENT_TYPES)
            selected["final_correct"] = selected["operation_correct"].astype(int)
            selected.loc[local_selected, "final_correct"] = (
                selected.loc[local_selected, "selected_package_correct"]
                .fillna(0)
                .astype(int)
            )
            selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(int)
            event = selected[selected["family"] != "Clean"]
            clean = selected[selected["family"] == "Clean"]
            grid_rows.append({
                "operationClassifierWeight": operation_weight,
                "typedLocationWeight": typed_weight,
                "locationClassifierWeight": classifier_weight,
                "eventCorrect": int(event["final_correct"].sum()),
                "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
            })
            selections[(operation_weight, typed_weight, classifier_weight)] = selected

    grid = pd.DataFrame(grid_rows)
    eligible = grid[
        grid["cleanFalsePositives"].le(args.maximum_clean_false_positives)
    ]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["eventCorrect", "cleanFalsePositives"], ascending=[False, True]
    ).iloc[0]
    weights = (
        float(best["operationClassifierWeight"]),
        float(best["typedLocationWeight"]),
        float(best["locationClassifierWeight"]),
    )
    selected = selections[weights]
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
        "locationPackages": len(packages),
        "operationFeatures": len(operation_features),
        "locationFeatures": len(location_features),
        "weights": {
            "operationClassifier": weights[0],
            "typedLocation": weights[1],
            "locationClassifier": weights[2],
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
    packages.to_pickle(output_dir / "location-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-hierarchical-top.csv", index=False)
    grid.to_csv(output_dir / "hierarchical-grid.csv", index=False)
    (output_dir / "operation-feature-names.json").write_text(
        json.dumps(operation_features, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "location-feature-names.json").write_text(
        json.dumps(location_features, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
