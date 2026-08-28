#!/usr/bin/env python3
"""Run the complete frozen standalone v34 package model without fitting."""

from __future__ import annotations

import argparse
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
FIT = load_module("frozen_standalone_fit_contract", ROOT / "fit-standalone-hierarchical-package.py")
PAIR_FIT = load_module("frozen_pair_fit_contract", ROOT / "fit-standalone-pairwise-adjudicator.py")
PAIRWISE = PAIR_FIT.PAIRWISE
FULL_FIT = load_module("frozen_full_year_fit_contract", ROOT / "fit-standalone-full-year-location-head.py")
PROFILE = FULL_FIT.PROFILE
FUSION_FIT = load_module("frozen_proposal_fit_contract", ROOT / "fit-standalone-proposal-fusion.py")
FUSION = FUSION_FIT.FUSION
WHOLE = load_module("frozen_whole_projection_contract", ROOT / "standalone_whole_projection_head.py")
FROZEN = load_module("frozen_standalone_helpers", ROOT / "frozen_model_inference.py")
TRAINER = FIT.TRAINER


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def read_summary(directory: Path) -> dict[str, object]:
    return json.loads((directory / "summary.json").read_text(encoding="utf8"))


def score_base(
    package_table: Path,
    model_dir: Path,
    output_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict[str, object]]:
    packages = pd.read_pickle(package_table)
    locations, operations, operation_types = FIT.prepare_tables(packages)

    operation_features = FROZEN.load_feature_names(model_dir / "operation-feature-names.json")
    operation_values = FROZEN.encode_frame(
        operations,
        FIT.operation_columns(operations),
        operation_features,
    )
    operations["operation_rank_score"] = FROZEN.predict(
        model_dir / "operation-ranker.txt", operation_values
    )
    operations["operation_classifier_probability"] = FROZEN.predict(
        model_dir / "operation-classifier.txt", operation_values
    )

    type_features = FROZEN.load_feature_names(model_dir / "operationType-feature-names.json")
    type_values = FROZEN.encode_frame(
        operation_types,
        FIT.type_columns(operation_types),
        type_features,
    )
    operation_types["type_rank_score"] = FROZEN.predict(
        model_dir / "operation-type-ranker.txt", type_values
    )
    operation_types["type_classifier_probability"] = FROZEN.predict(
        model_dir / "operation-type-classifier.txt", type_values
    )

    operation_groups = operations.groupby("attempt_id", sort=False)
    operations["operation_rank_percentile"] = operation_groups[
        "operation_rank_score"
    ].rank(pct=True)
    operations["operation_classifier_percentile"] = operation_groups[
        "operation_classifier_probability"
    ].rank(pct=True)
    type_groups = operation_types.groupby("attempt_id", sort=False)
    operation_types["type_rank_percentile"] = type_groups[
        "type_rank_score"
    ].rank(pct=True)
    operation_types["type_classifier_percentile"] = type_groups[
        "type_classifier_probability"
    ].rank(pct=True)
    type_rank = operation_types.set_index("type_group")["type_rank_percentile"]
    type_classifier = operation_types.set_index("type_group")[
        "type_classifier_percentile"
    ]
    operations["type_group"] = (
        operations["attempt_id"].astype(str)
        + "|" + operations["event_type"].astype(str)
    )
    operations["shift_rank_score"] = 1.0
    operations["shift_classifier_probability"] = 1.0
    for event_type in sorted(operations["event_type"].unique()):
        ranker_path = model_dir / f"shift-{event_type}-ranker.txt"
        classifier_path = model_dir / f"shift-{event_type}-classifier.txt"
        if not ranker_path.exists() or not classifier_path.exists():
            continue
        indices = operations.index[operations["event_type"].eq(event_type)].to_numpy(dtype=int)
        operations.loc[indices, "shift_rank_score"] = FROZEN.predict(
            ranker_path, operation_values.loc[indices]
        )
        operations.loc[indices, "shift_classifier_probability"] = FROZEN.predict(
            classifier_path, operation_values.loc[indices]
        )
    shift_groups = operations.groupby(["attempt_id", "event_type"], sort=False)
    operations["shift_rank_percentile"] = shift_groups[
        "shift_rank_score"
    ].rank(pct=True)
    operations["shift_classifier_percentile"] = shift_groups[
        "shift_classifier_probability"
    ].rank(pct=True)
    operations["typed_operation_rank_percentile"] = (
        operations["type_group"].map(type_rank) * 0.75
        + operations["shift_rank_percentile"] * 0.25
    )
    operations["typed_operation_classifier_percentile"] = (
        operations["type_group"].map(type_classifier) * 0.75
        + operations["shift_classifier_percentile"] * 0.25
    )

    operation_meta_features = FROZEN.load_feature_names(
        model_dir / "operationMeta-feature-names.json"
    )
    operation_meta_values = FROZEN.encode_frame(
        operations,
        TRAINER.operation_meta_columns(operations),
        operation_meta_features,
    )
    operations["operation_meta_score"] = FROZEN.predict(
        model_dir / "operation-meta-ranker.txt", operation_meta_values
    )
    operations["operation_meta_percentile"] = operations.groupby(
        "attempt_id", sort=False
    )["operation_meta_score"].rank(pct=True)

    location_features = FROZEN.load_feature_names(model_dir / "location-feature-names.json")
    location_values = FROZEN.encode_frame(
        locations,
        FIT.location_columns(locations),
        location_features,
    )
    local = locations["event_type"].isin(LOCAL_EVENT_TYPES)
    local_indices = locations.index[local].to_numpy(dtype=int)
    locations["location_global_score"] = np.nan
    locations["location_global_classifier_probability"] = np.nan
    locations["location_typed_score"] = np.nan
    locations["location_typed_classifier_probability"] = np.nan
    locations.loc[local_indices, "location_global_score"] = FROZEN.predict(
        model_dir / "location-global-ranker.txt", location_values.loc[local_indices]
    )
    locations.loc[local_indices, "location_global_classifier_probability"] = FROZEN.predict(
        model_dir / "location-global-classifier.txt", location_values.loc[local_indices]
    )
    for event_type in sorted(LOCAL_EVENT_TYPES):
        indices = locations.index[locations["event_type"].eq(event_type)].to_numpy(dtype=int)
        locations.loc[indices, "location_typed_score"] = FROZEN.predict(
            model_dir / f"location-{event_type}-ranker.txt", location_values.loc[indices]
        )
        locations.loc[indices, "location_typed_classifier_probability"] = FROZEN.predict(
            model_dir / f"location-{event_type}-classifier.txt", location_values.loc[indices]
        )
    local_groups = locations.loc[local].groupby("identity_group", sort=False)
    for source, destination in (
        ("location_global_score", "location_global_percentile"),
        ("location_typed_score", "location_typed_percentile"),
        ("location_global_classifier_probability", "location_global_classifier_percentile"),
        ("location_typed_classifier_probability", "location_typed_classifier_percentile"),
    ):
        locations.loc[local, destination] = local_groups[source].rank(pct=True)

    location_meta_features = FROZEN.load_feature_names(
        model_dir / "locationMeta-feature-names.json"
    )
    location_meta_values = FROZEN.encode_frame(
        locations,
        TRAINER.location_meta_columns(locations),
        location_meta_features,
    )
    locations["location_meta_score"] = np.nan
    locations.loc[local_indices, "location_meta_score"] = FROZEN.predict(
        model_dir / "location-meta-ranker.txt",
        location_meta_values.loc[local_indices],
    )
    locations.loc[local, "location_meta_percentile"] = locations.loc[
        local
    ].groupby("identity_group", sort=False)["location_meta_score"].rank(pct=True)

    frozen = read_summary(model_dir)
    selected = FIT.select_target(locations, operations, frozen["weights"])
    operations.to_pickle(output_dir / "target-operation-scores.pkl")
    locations.to_pickle(output_dir / "target-location-scores.pkl")
    selected.to_csv(output_dir / "target-standalone-hierarchical-top.csv", index=False)
    return locations, operations, selected, frozen


def score_pair(
    locations: pd.DataFrame,
    operations: pd.DataFrame,
    base_top: pd.DataFrame,
    base_weights: dict[str, float],
    model_dir: Path,
    output_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    target = locations[locations["event_type"].isin(LOCAL_EVENT_TYPES)].copy().reset_index(drop=True)
    target["base_score"] = PAIRWISE.base_location_score(target, base_weights)
    columns = PAIRWISE.location_feature_columns(target)
    feature_names = FROZEN.load_feature_names(model_dir / "location-feature-names.json")
    values = FROZEN.encode_frame(target, columns, feature_names)
    score_columns = [
        column for column in (
            "location_meta_percentile", "location_global_percentile",
            "location_typed_percentile", "location_global_classifier_percentile",
            "location_typed_classifier_percentile",
            "evidence_consensus_family_mean_percentile",
        ) if column in target
    ]
    comparisons = PAIRWISE.comparison_pairs(
        target,
        group_column="identity_group",
        score_columns=score_columns,
        anchor_count=6,
    )
    pair_values = PAIRWISE.pair_values(values, comparisons, include_year_delta=True)
    predictions = np.full(len(comparisons), np.nan)
    for event_type in sorted(LOCAL_EVENT_TYPES):
        indices = comparisons.index[comparisons["event_type"].eq(event_type)].to_numpy(dtype=int)
        predictions[indices] = FROZEN.predict(
            model_dir / f"location-{event_type}-pair-classifier.txt",
            pair_values.loc[indices],
        )
    if np.isnan(predictions).any():
        raise RuntimeError("frozen pair head left unscored comparisons")
    target["pairwise_score"] = PAIR_FIT.aggregate_pair_scores(
        len(target), comparisons, predictions
    )
    target["pairwise_percentile"] = target.groupby(
        "identity_group", sort=False
    )["pairwise_score"].rank(pct=True)
    pair_weights = read_summary(model_dir)["weights"]
    selected = PAIR_FIT.select_target(
        operations,
        target,
        base_weights,
        pair_weights,
    )
    target.to_pickle(output_dir / "target-location-pairwise-scores.pkl")
    selected.to_csv(output_dir / "target-standalone-pairwise-top.csv", index=False)
    return target, selected


def score_profile(
    row_cache: Path,
    package_table: Path,
    base_top: pd.DataFrame,
    model_dir: Path,
    output_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    modes = PROFILE.load_candidate_modes([str(package_table)])
    package_attempt = str(base_top.iloc[0]["attempt_id"])
    dataset_id = package_attempt.split(":evaluation:", 1)[0]
    rows = PROFILE.add_shape_features(PROFILE.load_selected_rows(
        [f"{dataset_id}={row_cache / 'rows.pkl'}"],
        base_top,
        modes,
        20,
        True,
    ))
    feature_names = FROZEN.load_feature_names(model_dir / "feature-names.json")
    columns = [column for column in rows if column not in PROFILE.LABEL_COLUMNS]
    values = FROZEN.encode_frame(rows, columns, feature_names)
    score_columns = [
        "location_binary_global_score",
        "location_binary_typed_score",
        "location_graded_global_score",
        "location_graded_typed_score",
    ]
    for graded in (False, True):
        name = "graded" if graded else "binary"
        rows[f"location_{name}_global_score"] = FROZEN.predict(
            model_dir / f"location-{name}-global-ranker.txt", values
        )
        rows[f"location_{name}_typed_score"] = np.nan
        for event_type in sorted(LOCAL_EVENT_TYPES):
            indices = rows.index[rows["event_type"].eq(event_type)].to_numpy(dtype=int)
            rows.loc[indices, f"location_{name}_typed_score"] = FROZEN.predict(
                model_dir / f"location-{name}-{event_type}-ranker.txt",
                values.loc[indices],
            )
    if rows[score_columns].isna().any().any():
        raise RuntimeError("frozen full-year head left unscored rows")
    grouped = rows.groupby("identity_group", sort=False)
    for column in score_columns:
        rows[f"{column}_percentile"] = grouped[column].rank(pct=True)
    selected = FULL_FIT.select_target(base_top, rows, read_summary(model_dir)["weights"])
    rows[[
        "attempt_id", "identity_group", "cluster_id", "file_id", "family",
        "event_type", "shift_years", "year", "window_correct", "strict_correct",
        "location_relevance", "location_error_years", *score_columns,
        *[f"{column}_percentile" for column in score_columns],
    ]].to_pickle(output_dir / "target-full-year-location-scores.pkl")
    selected.to_csv(output_dir / "target-standalone-full-year-top.csv", index=False)
    return rows, selected


def score_fusion(
    base_top_path: Path,
    pair_top_path: Path,
    profile_top_path: Path,
    base_location_path: Path,
    pair_location_path: Path,
    profile_location_path: Path,
    base_weights: dict[str, float],
    model_dir: Path,
    output_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    base = pd.read_csv(base_top_path)
    pair = pd.read_csv(pair_top_path)
    profile = pd.read_csv(profile_top_path)
    proposals = FUSION.append_agreement_features(
        FUSION.proposal_rows(base, pair, profile)
    )
    raw = FUSION_FIT.target_feature_frame(
        proposals,
        base_location_path,
        pair_location_path,
        profile_location_path,
        base_weights,
    )
    feature_names_path = model_dir / "feature-names.json"
    feature_names = (
        FROZEN.load_feature_names(feature_names_path)
        if feature_names_path.exists()
        else FROZEN.load_model_feature_names(model_dir / "proposal-classifier.txt")
    )
    values, _ = FUSION.encode(raw)
    values = values.reindex(columns=feature_names, fill_value=0).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)
    proposals["proposal_score"] = FROZEN.predict(
        model_dir / "proposal-classifier.txt", values
    )
    margins = FUSION_FIT.proposal_margins(proposals)
    top = proposals.sort_values(
        ["attempt_id", "proposal_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    top["proposal_margin"] = top["attempt_id"].map(margins)
    selected = FUSION_FIT.apply_top(base, top)
    proposals.to_pickle(output_dir / "target-proposal-fusion-scores.pkl")
    top.to_csv(output_dir / "target-proposal-top.csv", index=False)
    selected.to_csv(output_dir / "target-standalone-proposal-top.csv", index=False)
    return proposals, top, selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-table", required=True)
    parser.add_argument("--row-cache", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--runtime-manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    package_table = Path(args.package_table).resolve()
    row_cache = Path(args.row_cache).resolve()
    runtime_dir = Path(args.runtime_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    base_dir = output_dir / "base"
    pair_dir = output_dir / "pair"
    profile_dir = output_dir / "profile"
    fusion_dir = output_dir / "fusion"
    final_dir = output_dir / "final"
    for directory in (base_dir, pair_dir, profile_dir, fusion_dir, final_dir):
        directory.mkdir(parents=True, exist_ok=True)

    verification = FROZEN.verify_runtime_manifest(
        runtime_dir, Path(args.runtime_manifest).resolve()
    )
    base_model_dir = runtime_dir / "calibration-standalone-whole-modes8-fit-v38"
    pair_model_dir = runtime_dir / "calibration-standalone-pairwise-fit-v22"
    profile_model_dir = runtime_dir / "calibration-standalone-full-year-fit-v24"
    fusion_model_dir = runtime_dir / "calibration-proposal-fusion-fit-v29"
    whole_config_dir = runtime_dir / "calibration-whole-projection-modes8-fit-v34"

    locations, operations, base_top, base_summary = score_base(
        package_table, base_model_dir, base_dir
    )
    pair_locations, pair_top = score_pair(
        locations,
        operations,
        base_top,
        base_summary["weights"],
        pair_model_dir,
        pair_dir,
    )
    profile_rows, profile_top = score_profile(
        row_cache, package_table, base_top, profile_model_dir, profile_dir
    )
    _, _, fusion_top = score_fusion(
        base_dir / "target-standalone-hierarchical-top.csv",
        pair_dir / "target-standalone-pairwise-top.csv",
        profile_dir / "target-standalone-full-year-top.csv",
        base_dir / "target-location-scores.pkl",
        pair_dir / "target-location-pairwise-scores.pkl",
        profile_dir / "target-full-year-location-scores.pkl",
        base_summary["weights"],
        fusion_model_dir,
        fusion_dir,
    )
    config = read_summary(whole_config_dir)
    labels = WHOLE.load_whole_labels([package_table])
    competition = WHOLE.build_competition(fusion_top, operations, labels)
    final = WHOLE.apply_threshold(
        fusion_top,
        competition,
        float(config["minimumScoreMargin"]),
    )
    metrics = WHOLE.summarize(final, fusion_top, args.bootstrap_repetitions)
    final.to_csv(final_dir / "standalone-whole-projection-top.csv", index=False)
    competition.to_csv(final_dir / "whole-projection-competition.csv", index=False)
    summary = {
        **config,
        **metrics,
        "selectionPolicy": "frozen_v34_standalone_predict_only",
        "trainingCalls": 0,
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "runtimeVerification": verification,
        "packageTable": str(package_table),
        "rowCache": str(row_cache),
        "baseRows": len(locations),
        "operationIdentities": len(operations),
        "pairRows": len(pair_locations),
        "profileRows": len(profile_rows),
    }
    (final_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
