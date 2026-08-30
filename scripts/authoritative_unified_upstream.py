#!/usr/bin/env python3
"""Deployable upstream heads for the authoritative unified diagnosis model.

The frozen v12 residual heads expect three operation-stack scores and one
location-anchor score.  The file-isolated experiment originally retained only
their OOF predictions.  This module freezes the corresponding all-file models
and exposes inference without labels or benchmark metadata.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module {name}: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


TRAINER = load_module(
    "authoritative_two_stage_trainer",
    SCRIPT_DIR / "train-immutable-two-stage-adjudicator.py",
)
STACK = load_module(
    "authoritative_nested_stack",
    SCRIPT_DIR / "audit-immutable-operation-nested-stack.py",
)
LOCATION = load_module(
    "authoritative_location_residual",
    SCRIPT_DIR / "audit-applied-residual-location-oof.py",
)
BOTTOM = load_module(
    "authoritative_bottom_evidence",
    SCRIPT_DIR / "immutable_bottom_evidence.py",
)


OPERATION_VARIANTS = (
    "base512",
    "all",
    "hierarchy",
    "top1",
    "xendcg",
    "capacity",
    "workflow_base",
    "workflow_all",
)


def _merge_operation_inputs(
    operation_scores: pd.DataFrame,
    bottom_evidence: pd.DataFrame,
    identity_metadata: pd.DataFrame,
) -> pd.DataFrame:
    operations = TRAINER.prepare_operation(operation_scores)
    if bottom_evidence["identity_group"].duplicated().any():
        raise RuntimeError("bottom evidence must be unique per operation identity")
    forbidden = BOTTOM.forbidden_bottom_feature_columns(bottom_evidence)
    if forbidden:
        raise RuntimeError(
            "bottom evidence admitted forbidden columns: " + ", ".join(forbidden)
        )
    bottom_columns = [
        column for column in bottom_evidence if column.startswith("bottom_")
    ]
    operations = operations.merge(
        bottom_evidence[["identity_group", *bottom_columns]],
        on="identity_group",
        how="left",
        validate="one_to_one",
    )
    labels = identity_metadata[[
        "identity_group",
        "identity_workflow_oracle",
    ]].drop_duplicates("identity_group")
    operations = operations.merge(
        labels,
        on="identity_group",
        how="left",
        validate="one_to_one",
    )
    operations["identity_workflow_correct"] = operations[
        "identity_workflow_oracle"
    ].fillna(operations["operation_correct"]).astype(np.int8)
    return operations


def _variant_label(variant: str) -> str:
    return (
        "identity_workflow_correct"
        if variant.startswith("workflow_")
        else "operation_correct"
    )


def _variant_family(variant: str) -> str:
    normalized = variant.removeprefix("workflow_")
    return "base512" if normalized in {"base", "base512", "top1", "xendcg", "capacity"} else normalized


def _operation_feature_spec(
    operations: pd.DataFrame,
    family: str,
):
    maximum = 2048 if family == "all" else 512
    return TRAINER.make_feature_spec(
        operations,
        group_column="attempt_id",
        maximum_numeric=maximum,
        categorical_columns=("event_type",),
        preferred_numeric=(
            *TRAINER.OPERATION_PREFERRED,
            *(
                column
                for column in operations.columns
                if column.startswith("bottom_")
            ),
        ),
    )


def _project_operation_features(
    operations: pd.DataFrame,
    spec,
    family: str,
) -> pd.DataFrame:
    return (
        TRAINER.project_operation_hierarchy_features(operations, spec)
        if family == "hierarchy"
        else TRAINER.project_relative_features(operations, spec)
    )


def _outer_oof_view_scores(
    operations: pd.DataFrame,
    cache_dir: Path,
    variants: tuple[str, ...],
    outer_splits: int,
) -> dict[str, np.ndarray]:
    output = {
        variant: np.full(len(operations), np.nan, dtype=np.float32)
        for variant in variants
    }
    splitter = GroupKFold(
        n_splits=min(outer_splits, operations["file_id"].nunique())
    )
    for fold, (_, test_index) in enumerate(
        splitter.split(operations, groups=operations["file_id"])
    ):
        cached = pd.read_pickle(cache_dir / f"outer-fold-{fold}.pkl")
        if not operations["identity_group"].equals(cached["identity_group"]):
            raise RuntimeError("nested operation cache identities changed")
        for variant in variants:
            output[variant][test_index] = cached.loc[
                test_index, f"score_{variant}"
            ].to_numpy(dtype=np.float32)
    missing = [name for name, values in output.items() if np.isnan(values).any()]
    if missing:
        raise RuntimeError("nested OOF views are incomplete: " + ", ".join(missing))
    return output


def fit_operation_stack_pack(
    *,
    operation_scores: Path,
    bottom_evidence: Path,
    identity_metadata: Path,
    oof_cache_dir: Path,
    outer_splits: int = 5,
    disagreement_weight: float = 1.0,
    pair_weight: float = 0.25,
    pair_shortlist_size: int = 2,
) -> tuple[dict[str, Any], dict[str, Any]]:
    operations = _merge_operation_inputs(
        pd.read_pickle(operation_scores),
        pd.read_pickle(bottom_evidence),
        pd.read_pickle(identity_metadata),
    ).reset_index(drop=True)
    variants = OPERATION_VARIANTS
    oof_scores = _outer_oof_view_scores(
        operations,
        oof_cache_dir,
        variants,
        outer_splits,
    )
    oof_stacked, generated = STACK.attach_scores(operations, oof_scores)

    meta_spec = TRAINER.make_feature_spec(
        oof_stacked,
        group_column="attempt_id",
        maximum_numeric=len(generated),
        categorical_columns=("event_type",),
        preferred_numeric=generated,
    )
    meta_values = TRAINER.project_relative_features(oof_stacked, meta_spec)
    ordered = oof_stacked.sort_values("attempt_id").index.to_numpy(dtype=int)
    group_sizes = oof_stacked.loc[ordered].groupby(
        "attempt_id", sort=False
    ).size().to_numpy()
    consensus = oof_stacked.groupby("attempt_id", sort=False)[
        "stack_top1_vote_fraction"
    ].transform("max")
    weights = 1 + max(0.0, disagreement_weight) * (1 - consensus)
    meta_model = TRAINER.ranker(159999, graded=False)
    meta_model.fit(
        meta_values.loc[ordered],
        oof_stacked.loc[ordered, "identity_workflow_correct"],
        group=group_sizes,
        sample_weight=weights.loc[ordered],
    )

    specs: dict[str, Any] = {}
    models: dict[str, Any] = {}
    values_by_family: dict[str, pd.DataFrame] = {}
    for index, variant in enumerate(variants):
        family = _variant_family(variant)
        if family not in specs:
            specs[family] = _operation_feature_spec(operations, family)
            values_by_family[family] = _project_operation_features(
                operations, specs[family], family
            )
        estimator = STACK.make_ranker(variant, 149000 + index * 100)
        models[variant] = TRAINER.fit_ranker(
            estimator,
            operations,
            values_by_family[family],
            label=_variant_label(variant),
            group="attempt_id",
        )

    pair_values = values_by_family["base512"]
    pair_training, pair_labels = TRAINER.build_pair_training(
        oof_stacked,
        pair_values,
        label="identity_workflow_correct",
        group="attempt_id",
        seed_score=oof_stacked["stack_rank_mean"].astype(float),
        maximum_positives=1,
        maximum_negatives=1,
    )
    pair_model = TRAINER.pair_classifier(155999)
    pair_model.fit(pair_training, pair_labels)

    pack = {
        "schemaVersion": 1,
        "kind": "authoritative-operation-upstream-v1",
        "variants": variants,
        "specs": specs,
        "models": models,
        "metaSpec": meta_spec,
        "metaModel": meta_model,
        "pairModel": pair_model,
        "pairFeatureFamily": "base512",
        "pairWeight": float(pair_weight),
        "pairShortlistSize": int(pair_shortlist_size),
        "bottomColumns": tuple(
            column for column in operations if column.startswith("bottom_")
        ),
    }
    summary = {
        "operationRows": int(len(operations)),
        "operationVariants": list(variants),
        "metaFeatures": int(meta_values.shape[1]),
        "pairFeatures": int(pair_values.shape[1]),
        "pairRows": int(len(pair_labels)),
    }
    return pack, summary


def score_operation_stack_pack(
    pack: dict[str, Any],
    operation_scores: pd.DataFrame,
    bottom_evidence: pd.DataFrame,
) -> pd.DataFrame:
    operations = TRAINER.prepare_operation(operation_scores)
    bottom_columns = list(pack["bottomColumns"])
    operations = operations.merge(
        bottom_evidence[["identity_group", *bottom_columns]],
        on="identity_group",
        how="left",
        validate="one_to_one",
    ).reset_index(drop=True)
    score_by_view: dict[str, np.ndarray] = {}
    values_by_family: dict[str, pd.DataFrame] = {}
    for variant in pack["variants"]:
        family = _variant_family(variant)
        if family not in values_by_family:
            values_by_family[family] = _project_operation_features(
                operations,
                pack["specs"][family],
                family,
            )
        score_by_view[variant] = pack["models"][variant].predict(
            values_by_family[family]
        )
    stacked, _ = STACK.attach_scores(operations, score_by_view)
    meta_values = TRAINER.project_relative_features(stacked, pack["metaSpec"])
    meta_score = pack["metaModel"].predict(meta_values)
    meta_percentile = TRAINER.within_group_percentile(
        stacked, meta_score, "attempt_id"
    )
    pair_values = values_by_family[pack["pairFeatureFamily"]]
    shortlist_score = meta_percentile.mul(0.7).add(
        stacked["stack_rank_mean"].astype(float).mul(0.3)
    )
    pair_score = TRAINER.pair_tournament_scores(
        stacked,
        pair_values,
        pack["pairModel"],
        group="attempt_id",
        shortlist_score=shortlist_score,
        shortlist_size=int(pack["pairShortlistSize"]),
    )
    pair_percentile = TRAINER.within_group_percentile(
        stacked, pair_score, "attempt_id"
    )
    pair_weight = float(pack["pairWeight"])
    selection = meta_percentile.mul(1 - pair_weight).add(
        pair_percentile.mul(pair_weight)
    )
    return operations.assign(
        meta_oof_score=np.asarray(meta_score, dtype=np.float32),
        pair_oof_score=np.asarray(pair_score, dtype=np.float32),
        selection_oof_score=np.asarray(selection, dtype=np.float32),
    )


def fit_location_anchor_pack(
    location_rows: pd.DataFrame,
    residual_rows: pd.DataFrame,
) -> tuple[dict[str, Any], dict[str, Any]]:
    residual_columns = [
        column for column in residual_rows
        if column == "proposal_id" or column.startswith("residual_")
    ]
    rows = location_rows.merge(
        residual_rows[residual_columns],
        on="proposal_id",
        how="inner",
        validate="one_to_one",
    )
    labels = pd.to_numeric(
        rows["anchor_location_oof_score"], errors="coerce"
    )
    train = labels.notna()
    if int(train.sum()) < 100:
        raise RuntimeError("location anchor distillation has too few rows")
    values = LOCATION.residual_features(
        rows,
        excluded_prefixes=("residual_perReference_",),
        include_physical_modes=True,
        include_all_frozen_views=True,
        include_typed_physical_modes=True,
        include_anchor_oof_evidence=False,
        include_compact_per_reference_location=True,
    )
    model = lgb.LGBMRegressor(
        objective="regression_l1",
        n_estimators=700,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=20,
        subsample=0.85,
        colsample_bytree=0.72,
        reg_alpha=2.0,
        reg_lambda=7.0,
        random_state=839999,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )
    model.fit(values.loc[train], labels.loc[train])
    pack = {
        "schemaVersion": 1,
        "kind": "authoritative-location-anchor-distillation-v1",
        "model": model,
        "features": list(values.columns),
    }
    predictions = model.predict(values.loc[train])
    summary = {
        "locationRows": int(len(rows)),
        "anchorTrainingRows": int(train.sum()),
        "anchorFeatures": int(values.shape[1]),
        "anchorMedianAbsoluteReplayError": float(
            np.median(np.abs(predictions - labels.loc[train].to_numpy()))
        ),
    }
    return pack, summary


def score_location_anchor_pack(
    pack: dict[str, Any],
    location_rows: pd.DataFrame,
    residual_rows: pd.DataFrame,
) -> pd.DataFrame:
    residual_columns = [
        column for column in residual_rows
        if column == "proposal_id" or column.startswith("residual_")
    ]
    rows = location_rows.merge(
        residual_rows[residual_columns],
        on="proposal_id",
        how="inner",
        validate="one_to_one",
    )
    values = LOCATION.residual_features(
        rows,
        excluded_prefixes=("residual_perReference_",),
        include_physical_modes=True,
        include_all_frozen_views=True,
        include_typed_physical_modes=True,
        include_anchor_oof_evidence=False,
        include_compact_per_reference_location=True,
    ).reindex(columns=pack["features"], fill_value=0)
    rows["anchor_location_oof_score"] = pack["model"].predict(values)
    return rows


def load_pack(path: Path) -> dict[str, Any]:
    return joblib.load(path)
