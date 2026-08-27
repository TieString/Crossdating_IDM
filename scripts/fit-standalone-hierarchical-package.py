#!/usr/bin/env python3
"""Fit the frozen standalone hierarchy on development files and predict a target set."""

from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
TRAINER = load_module(
    "fit_standalone_hierarchy_trainer",
    ROOT / "train-standalone-hierarchical-package.py",
)


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def encode_train_target(
    training: pd.DataFrame,
    target: pd.DataFrame,
    columns: list[str],
) -> tuple[pd.DataFrame, pd.DataFrame, list[str]]:
    """One-hot encode from development only and ignore unseen target categories."""
    train_raw = training.reindex(columns=columns).copy()
    target_raw = target.reindex(columns=columns).copy()
    categorical = [
        column for column in columns if train_raw[column].dtype == object
    ]
    train_values = pd.get_dummies(
        train_raw, columns=categorical, dtype=np.float32
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    target_values = pd.get_dummies(
        target_raw, columns=categorical, dtype=np.float32
    ).reindex(columns=train_values.columns, fill_value=0)
    target_values = target_values.replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)
    return train_values, target_values, list(train_values.columns)


def fit_ranker(
    estimator,
    values: pd.DataFrame,
    frame: pd.DataFrame,
    label: str,
    group: str,
):
    ordered = frame.sort_values(group).index.to_numpy(dtype=int)
    groups = frame.loc[ordered].groupby(group, sort=False).size().to_numpy()
    estimator.fit(values.loc[ordered], frame.loc[ordered, label], group=groups)
    return estimator


def save_model(estimator, path: Path) -> None:
    booster = getattr(estimator, "booster_", None)
    if booster is not None:
        path.write_text(booster.model_to_string(), encoding="utf8")


def add_identity_columns(packages: pd.DataFrame) -> pd.DataFrame:
    output = packages.copy()
    output["cluster_id"] = output["file_id"].astype(str)
    output["identity_group"] = (
        output["attempt_id"].astype(str)
        + "|" + output["event_type"].astype(str)
        + "|" + output["shift_years"].astype(int).astype(str)
    )
    return output


def prepare_tables(
    packages: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    packages = add_identity_columns(packages)
    operations = TRAINER.operation_table(packages, enable_support_features=True)
    operation_types = TRAINER.operation_type_table(operations)
    identity_correct = operations.set_index("identity_group")["operation_correct"]
    packages["identity_operation_correct"] = packages["identity_group"].map(
        identity_correct
    ).fillna(0).astype(int)
    packages["package_relevance"] = np.where(
        packages["workflow_correct"].eq(1),
        packages["location_relevance"],
        0,
    ).astype(np.int8)
    packages = TRAINER.append_year_evidence_consensus(packages)
    return packages, operations, operation_types


def operation_columns(frame: pd.DataFrame) -> list[str]:
    return [
        column for column in frame.columns
        if column not in {
            "identity_group", "attempt_id", "cluster_id", "file_id", "family",
            "is_clean", "operation_correct",
        }
    ]


def type_columns(frame: pd.DataFrame) -> list[str]:
    return [
        column for column in frame.columns
        if column not in {
            "type_group", "attempt_id", "cluster_id", "file_id", "family",
            "is_clean", "operation_correct",
        }
    ]


def location_columns(frame: pd.DataFrame) -> list[str]:
    return [
        column for column in frame.columns
        if column not in TRAINER.LABEL_COLUMNS
        and column not in {"identity_group", "candidate_year"}
        and not column.startswith("runtime_note__")
        and (
            column in {
                "candidate_source", "event_type", "shift_years", "shift_abs",
                "candidate_has_response", "candidate_year_present",
                "context_reference_mode", "runtime_confidence",
            }
            or column.startswith("context_")
            or column.startswith("runtime_source__")
            or column.startswith("geometry_")
            or column.startswith("bundle_")
            or TRAINER.is_candidate_relative_evidence(column)
        )
    ]


def fit_base_heads(
    development_packages: pd.DataFrame,
    target_packages: pd.DataFrame,
    output_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, list[str]]]:
    development, operations, operation_types = prepare_tables(development_packages)
    target, target_operations, target_types = prepare_tables(target_packages)
    feature_names: dict[str, list[str]] = {}

    operation_train, operation_target, feature_names["operation"] = (
        encode_train_target(operations, target_operations, operation_columns(operations))
    )
    operation_ranker = fit_ranker(
        TRAINER.ranker(81000), operation_train, operations,
        "operation_correct", "attempt_id",
    )
    operation_classifier = TRAINER.classifier(
        operations["operation_correct"], 81500
    )
    operation_classifier.fit(operation_train, operations["operation_correct"])
    target_operations["operation_rank_score"] = operation_ranker.predict(
        operation_target
    )
    target_operations["operation_classifier_probability"] = (
        operation_classifier.predict_proba(operation_target)[:, 1]
    )
    save_model(operation_ranker, output_dir / "operation-ranker.txt")
    save_model(operation_classifier, output_dir / "operation-classifier.txt")

    type_train, type_target, feature_names["operationType"] = encode_train_target(
        operation_types, target_types, type_columns(operation_types)
    )
    type_ranker = fit_ranker(
        TRAINER.ranker(81750), type_train, operation_types,
        "operation_correct", "attempt_id",
    )
    type_classifier = TRAINER.classifier(
        operation_types["operation_correct"], 81850
    )
    type_classifier.fit(type_train, operation_types["operation_correct"])
    target_types["type_rank_score"] = type_ranker.predict(type_target)
    target_types["type_classifier_probability"] = type_classifier.predict_proba(
        type_target
    )[:, 1]
    save_model(type_ranker, output_dir / "operation-type-ranker.txt")
    save_model(type_classifier, output_dir / "operation-type-classifier.txt")
    del type_train, type_target

    operation_groups = target_operations.groupby("attempt_id", sort=False)
    target_operations["operation_rank_percentile"] = operation_groups[
        "operation_rank_score"
    ].rank(pct=True)
    target_operations["operation_classifier_percentile"] = operation_groups[
        "operation_classifier_probability"
    ].rank(pct=True)
    type_groups = target_types.groupby("attempt_id", sort=False)
    target_types["type_rank_percentile"] = type_groups["type_rank_score"].rank(
        pct=True
    )
    target_types["type_classifier_percentile"] = type_groups[
        "type_classifier_probability"
    ].rank(pct=True)
    type_rank = target_types.set_index("type_group")["type_rank_percentile"]
    type_classifier_score = target_types.set_index("type_group")[
        "type_classifier_percentile"
    ]
    target_operations["type_group"] = (
        target_operations["attempt_id"].astype(str)
        + "|" + target_operations["event_type"].astype(str)
    )

    correct_type = operations.groupby(
        ["attempt_id", "event_type"], sort=False
    )["operation_correct"].transform("max").eq(1)
    target_operations["shift_rank_score"] = np.nan
    target_operations["shift_classifier_probability"] = np.nan
    for offset, event_type in enumerate(sorted(operations["event_type"].unique())):
        train_indices = operations.index[
            operations["event_type"].eq(event_type) & correct_type
        ].to_numpy(dtype=int)
        target_indices = target_operations.index[
            target_operations["event_type"].eq(event_type)
        ].to_numpy(dtype=int)
        if not len(target_indices):
            continue
        labels = operations.loc[train_indices, "operation_correct"]
        if labels.nunique() < 2:
            constant = float(labels.mean())
            target_operations.loc[target_indices, "shift_rank_score"] = constant
            target_operations.loc[
                target_indices, "shift_classifier_probability"
            ] = constant
            continue
        subset = operations.loc[train_indices]
        ordered = subset.sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = subset.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        ranker = TRAINER.ranker(81900 + offset)
        ranker.fit(
            operation_train.loc[ordered],
            operations.loc[ordered, "operation_correct"],
            group=groups,
        )
        classifier = TRAINER.classifier(labels, 81950 + offset)
        classifier.fit(operation_train.loc[train_indices], labels)
        target_operations.loc[target_indices, "shift_rank_score"] = ranker.predict(
            operation_target.loc[target_indices]
        )
        target_operations.loc[
            target_indices, "shift_classifier_probability"
        ] = classifier.predict_proba(operation_target.loc[target_indices])[:, 1]
        save_model(ranker, output_dir / f"shift-{event_type}-ranker.txt")
        save_model(classifier, output_dir / f"shift-{event_type}-classifier.txt")

    shift_groups = target_operations.groupby(
        ["attempt_id", "event_type"], sort=False
    )
    target_operations["shift_rank_percentile"] = shift_groups[
        "shift_rank_score"
    ].rank(pct=True)
    target_operations["shift_classifier_percentile"] = shift_groups[
        "shift_classifier_probability"
    ].rank(pct=True)
    target_operations["typed_operation_rank_percentile"] = (
        target_operations["type_group"].map(type_rank) * 0.75
        + target_operations["shift_rank_percentile"] * 0.25
    )
    target_operations["typed_operation_classifier_percentile"] = (
        target_operations["type_group"].map(type_classifier_score) * 0.75
        + target_operations["shift_classifier_percentile"] * 0.25
    )
    del operation_train, operation_target
    gc.collect()

    location_train, location_target, feature_names["location"] = encode_train_target(
        development, target, location_columns(development)
    )
    local_train_mask = (
        development["event_type"].isin(LOCAL_EVENT_TYPES)
        & development["identity_operation_correct"].eq(1)
    )
    local_target_mask = target["event_type"].isin(LOCAL_EVENT_TYPES)
    train_indices = development.index[local_train_mask].to_numpy(dtype=int)
    target_indices = target.index[local_target_mask].to_numpy(dtype=int)
    train_subset = development.loc[train_indices]
    ordered = train_subset.sort_values("identity_group").index.to_numpy(dtype=int)
    groups = train_subset.loc[ordered].groupby(
        "identity_group", sort=False
    ).size().to_numpy()
    global_ranker = TRAINER.ranker(82000, location=True)
    global_ranker.fit(
        location_train.loc[ordered], development.loc[ordered, "package_relevance"],
        group=groups,
    )
    group_size = development.loc[train_indices].groupby(
        "identity_group"
    )["identity_group"].transform("size")
    global_classifier = TRAINER.classifier(
        development.loc[train_indices, "workflow_correct"], 82250
    )
    global_classifier.fit(
        location_train.loc[train_indices],
        development.loc[train_indices, "workflow_correct"],
        sample_weight=(1 / group_size).to_numpy(dtype=float),
    )
    target.loc[target_indices, "location_global_score"] = global_ranker.predict(
        location_target.loc[target_indices]
    )
    target.loc[
        target_indices, "location_global_classifier_probability"
    ] = global_classifier.predict_proba(location_target.loc[target_indices])[:, 1]
    save_model(global_ranker, output_dir / "location-global-ranker.txt")
    save_model(global_classifier, output_dir / "location-global-classifier.txt")

    target["location_typed_score"] = np.nan
    target["location_typed_classifier_probability"] = np.nan
    for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
        typed_train = development.index[
            local_train_mask & development["event_type"].eq(event_type)
        ].to_numpy(dtype=int)
        typed_target = target.index[
            local_target_mask & target["event_type"].eq(event_type)
        ].to_numpy(dtype=int)
        subset = development.loc[typed_train]
        ordered = subset.sort_values("identity_group").index.to_numpy(dtype=int)
        groups = subset.loc[ordered].groupby(
            "identity_group", sort=False
        ).size().to_numpy()
        ranker = TRAINER.ranker(82500 + offset, location=True)
        ranker.fit(
            location_train.loc[ordered],
            development.loc[ordered, "package_relevance"],
            group=groups,
        )
        group_size = development.loc[typed_train].groupby(
            "identity_group"
        )["identity_group"].transform("size")
        classifier = TRAINER.classifier(
            development.loc[typed_train, "workflow_correct"], 82750 + offset
        )
        classifier.fit(
            location_train.loc[typed_train],
            development.loc[typed_train, "workflow_correct"],
            sample_weight=(1 / group_size).to_numpy(dtype=float),
        )
        target.loc[typed_target, "location_typed_score"] = ranker.predict(
            location_target.loc[typed_target]
        )
        target.loc[
            typed_target, "location_typed_classifier_probability"
        ] = classifier.predict_proba(location_target.loc[typed_target])[:, 1]
        save_model(ranker, output_dir / f"location-{event_type}-ranker.txt")
        save_model(classifier, output_dir / f"location-{event_type}-classifier.txt")

    local_groups = target[local_target_mask].groupby("identity_group", sort=False)
    for source, destination in (
        ("location_global_score", "location_global_percentile"),
        ("location_typed_score", "location_typed_percentile"),
        (
            "location_global_classifier_probability",
            "location_global_classifier_percentile",
        ),
        (
            "location_typed_classifier_probability",
            "location_typed_classifier_percentile",
        ),
    ):
        target.loc[local_target_mask, destination] = local_groups[source].rank(pct=True)

    del location_train, location_target, development, operations, operation_types
    gc.collect()
    return target, target_operations, feature_names


def fit_meta_heads(
    target_packages: pd.DataFrame,
    target_operations: pd.DataFrame,
    development_oof_dir: Path,
    output_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, list[str]]]:
    feature_names: dict[str, list[str]] = {}
    development_operations = pd.read_pickle(
        development_oof_dir / "operation-oof-scores.pkl"
    )
    columns = TRAINER.operation_meta_columns(development_operations)
    train_values, target_values, feature_names["operationMeta"] = (
        encode_train_target(development_operations, target_operations, columns)
    )
    operation_meta = fit_ranker(
        TRAINER.meta_ranker(83500, location=False),
        train_values,
        development_operations,
        "operation_correct",
        "attempt_id",
    )
    target_operations["operation_meta_score"] = operation_meta.predict(target_values)
    target_operations["operation_meta_percentile"] = target_operations.groupby(
        "attempt_id", sort=False
    )["operation_meta_score"].rank(pct=True)
    save_model(operation_meta, output_dir / "operation-meta-ranker.txt")
    del development_operations, train_values, target_values
    gc.collect()

    development_locations = pd.read_pickle(
        development_oof_dir / "location-oof-scores.pkl"
    )
    columns = TRAINER.location_meta_columns(development_locations)
    keep = list(dict.fromkeys([
        "identity_group", "event_type", "identity_operation_correct",
        "package_relevance", *columns,
    ]))
    development_locations = development_locations[keep].copy()
    train_values, target_values, feature_names["locationMeta"] = (
        encode_train_target(development_locations, target_packages, columns)
    )
    train_mask = (
        development_locations["event_type"].isin(LOCAL_EVENT_TYPES)
        & development_locations["identity_operation_correct"].eq(1)
    )
    target_mask = target_packages["event_type"].isin(LOCAL_EVENT_TYPES)
    train_indices = development_locations.index[train_mask].to_numpy(dtype=int)
    subset = development_locations.loc[train_indices]
    ordered = subset.sort_values("identity_group").index.to_numpy(dtype=int)
    groups = subset.loc[ordered].groupby(
        "identity_group", sort=False
    ).size().to_numpy()
    location_meta = TRAINER.meta_ranker(84000, location=True)
    location_meta.fit(
        train_values.loc[ordered],
        development_locations.loc[ordered, "package_relevance"],
        group=groups,
    )
    target_indices = target_packages.index[target_mask].to_numpy(dtype=int)
    target_packages.loc[target_indices, "location_meta_score"] = (
        location_meta.predict(target_values.loc[target_indices])
    )
    target_packages.loc[target_mask, "location_meta_percentile"] = (
        target_packages[target_mask].groupby("identity_group", sort=False)[
            "location_meta_score"
        ].rank(pct=True)
    )
    save_model(location_meta, output_dir / "location-meta-ranker.txt")
    del development_locations, train_values, target_values
    gc.collect()
    return target_packages, target_operations, feature_names


def select_target(
    packages: pd.DataFrame,
    operations: pd.DataFrame,
    weights: dict[str, float],
) -> pd.DataFrame:
    operation_weight = float(weights["operationClassifier"])
    typed_operation_weight = float(weights["typedOperation"])
    if operation_weight == 2.0 and typed_operation_weight == 2.0:
        operation_score = operations["operation_meta_percentile"].fillna(0)
    else:
        global_operation_score = (
            operations["operation_rank_percentile"] * (1 - operation_weight)
            + operations["operation_classifier_percentile"] * operation_weight
        )
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
    operation_top = operations.assign(operation_score=operation_score).sort_values(
        ["attempt_id", "operation_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    local = packages["event_type"].isin(LOCAL_EVENT_TYPES)
    typed_weight = float(weights["typedLocation"])
    classifier_weight = float(weights["locationClassifier"])
    rank_score = (
        packages["location_global_percentile"] * (1 - typed_weight)
        + packages["location_typed_percentile"] * typed_weight
    )
    classifier_score = (
        packages["location_global_classifier_percentile"] * (1 - typed_weight)
        + packages["location_typed_classifier_percentile"] * typed_weight
    )
    packages["location_score"] = (
        rank_score * (1 - classifier_weight)
        + classifier_score * classifier_weight
    )
    location_top = packages[local].sort_values(
        ["identity_group", "location_score"], ascending=[True, False]
    ).groupby("identity_group", sort=False).head(1).set_index("identity_group")
    selected = operation_top[[
        "attempt_id", "cluster_id", "file_id", "family", "identity_group",
        "event_type", "shift_years", "operation_correct",
    ]].copy()
    for output, source in (
        ("location_correct", "location_correct"),
        ("selected_package_correct", "workflow_correct"),
        ("strict_package_correct", "strict_correct"),
        ("selected_candidate_source", "candidate_source"),
        ("selected_candidate_year", "candidate_year"),
    ):
        selected[output] = selected["identity_group"].map(location_top[source])
    local_selected = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    selected["final_correct"] = selected["operation_correct"].astype(int)
    selected.loc[local_selected, "final_correct"] = selected.loc[
        local_selected, "selected_package_correct"
    ].fillna(0).astype(int)
    strict_identity = packages.groupby("identity_group", sort=False)[
        "strict_correct"
    ].max()
    selected["strict_correct"] = selected["identity_group"].map(
        strict_identity
    ).fillna(0).astype(int)
    selected.loc[local_selected, "strict_correct"] = selected.loc[
        local_selected, "strict_package_correct"
    ].fillna(0).astype(int)
    selected["candidate_has_response"] = selected["event_type"].ne(
        "noEvent"
    ).astype(int)
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-tables", required=True, nargs="+")
    parser.add_argument("--target-table", required=True)
    parser.add_argument("--development-oof-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_oof_dir = Path(args.development_oof_dir).resolve()
    frozen_summary = json.loads(
        (development_oof_dir / "summary.json").read_text(encoding="utf8")
    )
    weights = frozen_summary["weights"]

    development = pd.concat(
        [pd.read_pickle(Path(path).resolve()) for path in args.development_tables],
        ignore_index=True,
        sort=False,
    )
    target = pd.read_pickle(Path(args.target_table).resolve())
    target, operations, base_features = fit_base_heads(
        development, target, output_dir
    )
    del development
    gc.collect()
    target, operations, meta_features = fit_meta_heads(
        target, operations, development_oof_dir, output_dir
    )
    selected = select_target(target, operations, weights)
    event = selected[selected["family"] != "Clean"].copy()
    clean = selected[selected["family"] == "Clean"].copy()
    product = target[
        target["candidate_source"].eq("productPrimary")
    ].groupby("attempt_id", sort=False)["workflow_correct"].max()
    event["product_correct"] = event["attempt_id"].map(product).fillna(0).astype(int)
    event["correct_to_wrong"] = (
        event["product_correct"].eq(1) & event["final_correct"].eq(0)
    ).astype(int)
    event["wrong_to_correct"] = (
        event["product_correct"].eq(0) & event["final_correct"].eq(1)
    ).astype(int)
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group["strict_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": TRAINER.clustered_lower(
                group, 85000 + ord(family[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family", sort=True)
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "standalone_hierarchical_fit_predict",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "developmentFiles": int(frozen_summary["files"]),
        "targetFiles": int(target["file_id"].nunique()),
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "weights": weights,
        "workflowCorrect": int(event["final_correct"].sum()),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "strictAccuracy": float(event["strict_correct"].mean()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "correctToWrong": int(event["correct_to_wrong"].sum()),
        "wrongToCorrect": int(event["wrong_to_correct"].sum()),
        "overallOneSided95FileClusterLower": TRAINER.clustered_lower(
            event, 85999, args.bootstrap_repetitions
        ),
        "byFamily": by_family,
        "baseFeatures": {key: len(value) for key, value in base_features.items()},
        "metaFeatures": {key: len(value) for key, value in meta_features.items()},
    }
    operations.to_pickle(output_dir / "target-operation-scores.pkl")
    target.to_pickle(output_dir / "target-location-scores.pkl")
    selected.to_csv(output_dir / "target-standalone-hierarchical-top.csv", index=False)
    event.to_csv(output_dir / "target-event-evaluation.csv", index=False)
    for family, names in {**base_features, **meta_features}.items():
        (output_dir / f"{family}-feature-names.json").write_text(
            json.dumps(names, indent=2) + "\n", encoding="utf8"
        )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
