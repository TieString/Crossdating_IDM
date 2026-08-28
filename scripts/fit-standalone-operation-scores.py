#!/usr/bin/env python3
"""Fit standalone operation heads on development files and score a target set."""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path

import numpy as np
import pandas as pd

import importlib.util
import sys


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FIT = load_module(
    "standalone_hierarchy_fit_helpers",
    ROOT / "fit-standalone-hierarchical-package.py",
)
TRAINER = FIT.TRAINER


def prepare_operations(
    packages: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    packages["cluster_id"] = packages["file_id"].astype(str)
    packages["identity_group"] = (
        packages["attempt_id"].astype(str)
        + "|" + packages["event_type"].astype(str)
        + "|" + packages["shift_years"].astype(int).astype(str)
    )
    operations = TRAINER.operation_table(
        packages, enable_support_features=True
    )
    return operations, TRAINER.operation_type_table(operations)


def fit_operation_heads(
    development: pd.DataFrame,
    target: pd.DataFrame,
    development_oof_dir: Path,
    output_dir: Path,
) -> tuple[pd.DataFrame, dict[str, list[str]]]:
    operations, operation_types = prepare_operations(development)
    target_operations, target_types = prepare_operations(target)
    del development, target
    gc.collect()
    feature_names: dict[str, list[str]] = {}

    operation_train, operation_target, feature_names["operation"] = (
        FIT.encode_train_target(
            operations,
            target_operations,
            FIT.operation_columns(operations),
        )
    )
    operation_ranker = FIT.fit_ranker(
        TRAINER.ranker(81000),
        operation_train,
        operations,
        "operation_correct",
        "attempt_id",
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
    FIT.save_model(operation_ranker, output_dir / "operation-ranker.txt")
    FIT.save_model(operation_classifier, output_dir / "operation-classifier.txt")

    type_train, type_target, feature_names["operationType"] = (
        FIT.encode_train_target(
            operation_types,
            target_types,
            FIT.type_columns(operation_types),
        )
    )
    type_ranker = FIT.fit_ranker(
        TRAINER.ranker(81750),
        type_train,
        operation_types,
        "operation_correct",
        "attempt_id",
    )
    type_classifier = TRAINER.classifier(
        operation_types["operation_correct"], 81850
    )
    type_classifier.fit(type_train, operation_types["operation_correct"])
    target_types["type_rank_score"] = type_ranker.predict(type_target)
    target_types["type_classifier_probability"] = (
        type_classifier.predict_proba(type_target)[:, 1]
    )
    FIT.save_model(type_ranker, output_dir / "operation-type-ranker.txt")
    FIT.save_model(type_classifier, output_dir / "operation-type-classifier.txt")
    del type_train, type_target

    operation_groups = target_operations.groupby("attempt_id", sort=False)
    target_operations["operation_rank_percentile"] = operation_groups[
        "operation_rank_score"
    ].rank(pct=True)
    target_operations["operation_classifier_percentile"] = operation_groups[
        "operation_classifier_probability"
    ].rank(pct=True)
    type_groups = target_types.groupby("attempt_id", sort=False)
    target_types["type_rank_percentile"] = type_groups[
        "type_rank_score"
    ].rank(pct=True)
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
        groups = subset.loc[ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
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
        FIT.save_model(ranker, output_dir / f"shift-{event_type}-ranker.txt")
        FIT.save_model(
            classifier, output_dir / f"shift-{event_type}-classifier.txt"
        )

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
    del operation_train, operation_target, operation_types, target_types
    gc.collect()

    development_meta = pd.read_pickle(
        development_oof_dir / "operation-oof-scores.pkl"
    )
    columns = TRAINER.operation_meta_columns(development_meta)
    train_values, target_values, feature_names["operationMeta"] = (
        FIT.encode_train_target(
            development_meta, target_operations, columns
        )
    )
    meta_ranker = FIT.fit_ranker(
        TRAINER.meta_ranker(83500, location=False),
        train_values,
        development_meta,
        "operation_correct",
        "attempt_id",
    )
    target_operations["operation_meta_score"] = meta_ranker.predict(
        target_values
    )
    target_operations["operation_meta_percentile"] = (
        target_operations.groupby("attempt_id", sort=False)[
            "operation_meta_score"
        ].rank(pct=True)
    )
    FIT.save_model(meta_ranker, output_dir / "operation-meta-ranker.txt")
    return target_operations, feature_names


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-tables", required=True, nargs="+")
    parser.add_argument("--target-table", required=True)
    parser.add_argument("--development-oof-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development = pd.concat(
        [pd.read_pickle(Path(path).resolve()) for path in args.development_tables],
        ignore_index=True,
        sort=False,
    )
    target = pd.read_pickle(Path(args.target_table).resolve())
    operations, features = fit_operation_heads(
        development,
        target,
        Path(args.development_oof_dir).resolve(),
        output_dir,
    )
    operations.to_pickle(output_dir / "target-operation-scores.pkl")
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "standalone_operation_only_fit_predict",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "targetAttempts": int(operations["attempt_id"].nunique()),
        "targetOperationIdentities": len(operations),
        "targetFiles": int(operations["file_id"].nunique()),
        "features": {key: len(value) for key, value in features.items()},
    }
    for name, columns in features.items():
        (output_dir / f"{name}-feature-names.json").write_text(
            json.dumps(columns, indent=2) + "\n", encoding="utf8"
        )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
