#!/usr/bin/env python3
"""Train a file-OOF standalone pairwise event-package adjudicator.

This is an end-to-end selector, not a product-error detector.  Every attempt is
scored by the same operation tournament and, for local events, by the same
within-identity location tournament.  The existing product suggestion is only
one immutable candidate package and has no fallback or preservation privilege.
"""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
from typing import Iterable

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
OPERATION_EVIDENCE_FAMILIES = {
    "counterfactual": (
        "rawGain",
        "differenceGain",
        "combinedGain",
        "sideMinimumAdvantage",
        "sideStepScore",
        "correctedSideSupport",
        "localSideStepScore",
    ),
    "transition": ("rawTransition_", "cofechaTransition_"),
    "cumulative": ("cumulative_",),
    "piecewise": ("piecewise_",),
    "reference": (
        "referenceChange_",
        "referenceTransition_",
        "perReference_",
    ),
    "boundary": ("boundaryLocal_", "partialLocal_"),
}
FORBIDDEN_FEATURE_COLUMNS = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "identity_group",
    "candidate_year",
    "operation_correct",
    "identity_operation_correct",
    "location_correct",
    "location_relevance",
    "location_error_years",
    "package_relevance",
    "workflow_correct",
    "strict_correct",
    "product_correct",
    "product_strict_correct",
    "truth_year",
}


def pair_classifier(seed: int, *, location: bool) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=600 if location else 500,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=28 if location else 24,
        subsample=0.88,
        colsample_bytree=0.82,
        reg_alpha=1.5,
        reg_lambda=7.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def operation_feature_columns(frame: pd.DataFrame) -> list[str]:
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
        "operation_meta_score",
        "operation_meta_percentile",
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
        if column not in FORBIDDEN_FEATURE_COLUMNS
        and (
            column in exact
            or column.startswith("source_count_")
            or column.startswith("support_")
            or column.startswith("operation_family_")
        )
    ]


def append_operation_evidence_consensus(frame: pd.DataFrame) -> pd.DataFrame:
    """Balance operation evidence families within each diagnosis attempt.

    Raw channels use incomparable scales and several are strongly duplicated.
    Each useful positive-direction channel is first converted to an in-attempt
    percentile.  Families then contribute the same compact statistics, so the
    operation head sees agreement among physical mechanisms rather than the
    number of fields emitted by one mechanism.
    """

    positive_terms = (
        "probability",
        "reciprocal",
        "gain",
        "advantage",
        "score",
        "support",
        "fraction",
        "kernel",
        "vote",
        "cusum",
        "contrast",
        "objective",
        "correlation",
    )
    excluded_terms = ("deficit", "distance", "standarddeviation")
    evidence_columns = [
        column
        for column in frame
        if column.startswith("max_evidence_")
        and pd.api.types.is_numeric_dtype(frame[column])
        and any(term in column.lower() for term in positive_terms)
        and not any(term in column.lower() for term in excluded_terms)
    ]
    if not evidence_columns:
        return frame

    grouped = frame.groupby("attempt_id", sort=False)
    percentiles = grouped[evidence_columns].rank(pct=True)
    additions: dict[str, pd.Series] = {}
    used_columns: set[str] = set()
    for family, prefixes in OPERATION_EVIDENCE_FAMILIES.items():
        selected = [
            column
            for column in evidence_columns
            if any(
                column.removeprefix("max_evidence_").startswith(prefix)
                for prefix in prefixes
            )
        ]
        if not selected:
            continue
        used_columns.update(selected)
        values = percentiles[selected]
        prefix = f"operation_family_{family}"
        additions[f"{prefix}_count"] = values.notna().sum(axis=1).astype(
            np.float32
        )
        additions[f"{prefix}_mean"] = values.mean(axis=1).astype(np.float32)
        additions[f"{prefix}_median"] = values.median(axis=1).astype(
            np.float32
        )
        additions[f"{prefix}_minimum"] = values.min(axis=1).astype(np.float32)
        additions[f"{prefix}_maximum"] = values.max(axis=1).astype(np.float32)
        denominator = values.notna().sum(axis=1).clip(lower=1)
        for threshold in (0.75, 0.9):
            suffix = str(threshold).replace(".", "")
            additions[f"{prefix}_above_{suffix}_fraction"] = (
                values.ge(threshold).sum(axis=1) / denominator
            ).astype(np.float32)

    remaining = [column for column in evidence_columns if column not in used_columns]
    if remaining:
        values = percentiles[remaining]
        additions["operation_family_other_mean"] = values.mean(axis=1).astype(
            np.float32
        )
        additions["operation_family_other_median"] = values.median(axis=1).astype(
            np.float32
        )
        additions["operation_family_other_maximum"] = values.max(axis=1).astype(
            np.float32
        )

    family_means = [
        value
        for name, value in additions.items()
        if name.endswith("_mean") and name != "operation_family_other_mean"
    ]
    if family_means:
        family_table = pd.concat(family_means, axis=1)
        additions["operation_family_consensus_mean"] = family_table.mean(
            axis=1
        ).astype(np.float32)
        additions["operation_family_consensus_minimum"] = family_table.min(
            axis=1
        ).astype(np.float32)
        additions["operation_family_consensus_spread"] = family_table.std(
            axis=1
        ).astype(np.float32)
    return pd.concat([frame, pd.DataFrame(additions, index=frame.index)], axis=1)


def location_feature_columns(frame: pd.DataFrame) -> list[str]:
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
        "location_meta_score",
        "location_meta_percentile",
    }
    evidence_terms = (
        "percentile",
        "consensus",
        "posterior",
        "normalized",
        "relative",
        "distance",
        "agreement",
        "support",
        "margin",
        "gain",
        "vote",
        "cusum",
        "contrast",
    )

    def compact_geometry(column: str) -> bool:
        if not column.startswith("geometry_"):
            return False
        if column.startswith(("geometry_newer_", "geometry_older_")):
            return True
        if column in {
            "geometry_identity_mode_count",
            "geometry_rank_from_oldest",
            "geometry_rank_from_newest",
            "geometry_relative_recency",
            "geometry_distance_from_oldest",
            "geometry_distance_from_newest",
            "geometry_gap_to_older_mode",
            "geometry_gap_to_newer_mode",
            "geometry_frontier_support_balance",
            "geometry_productPrimary_top_signed_distance",
            "geometry_productPrimary_top_absolute_distance",
            "geometry_productPrimary_top_same_identity",
            "geometry_productAlternative_top_signed_distance",
            "geometry_productAlternative_top_absolute_distance",
            "geometry_productAlternative_top_same_identity",
        }:
            return True
        return column.startswith((
            "geometry_productPrimary_",
            "geometry_productAlternative_",
        )) and column.endswith((
            "_anchor_count",
            "_unique_anchor_count",
            "_exact_fraction",
            "_within_2_fraction",
            "_within_4_fraction",
            "_within_6_fraction",
            "_minimum_absolute_distance",
            "_median_absolute_distance",
            "_median_signed_distance",
            "_modal_year_fraction",
            "_older_anchor_fraction",
            "_newer_anchor_fraction",
        ))
    return [
        column
        for column in frame.columns
        if column not in FORBIDDEN_FEATURE_COLUMNS
        and (
            column in exact
            or compact_geometry(column)
            or column.startswith("evidence_consensus_")
            or column.startswith("runtime_source__")
            or (
                column.startswith("evidence_")
                and not column.startswith("evidence_identity_")
                and any(term in column.lower() for term in evidence_terms)
            )
        )
    ]


def encode(frame: pd.DataFrame, columns: list[str]) -> tuple[pd.DataFrame, list[str]]:
    forbidden = sorted(set(columns) & FORBIDDEN_FEATURE_COLUMNS)
    if forbidden:
        raise RuntimeError(f"forbidden standalone features: {','.join(forbidden)}")
    raw = frame[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=np.float32)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def base_operation_score(
    frame: pd.DataFrame, weights: dict[str, float]
) -> pd.Series:
    operation_weight = float(weights.get("operationClassifier", 0.5))
    typed_weight = float(weights.get("typedOperation", 0.0))
    if operation_weight == 2.0 and typed_weight == 2.0:
        return frame["operation_meta_percentile"].fillna(0)
    global_score = (
        frame["operation_rank_percentile"] * (1 - operation_weight)
        + frame["operation_classifier_percentile"] * operation_weight
    )
    if "typed_operation_rank_percentile" not in frame:
        return global_score.fillna(0)
    typed_score = (
        frame["typed_operation_rank_percentile"] * (1 - operation_weight)
        + frame["typed_operation_classifier_percentile"] * operation_weight
    )
    return (
        global_score * (1 - typed_weight) + typed_score * typed_weight
    ).fillna(0)


def base_location_score(
    frame: pd.DataFrame, weights: dict[str, float]
) -> pd.Series:
    typed_weight = float(weights.get("typedLocation", 0.5))
    classifier_weight = float(weights.get("locationClassifier", 0.0))
    if typed_weight == 2.0 and classifier_weight == 2.0:
        return frame["location_meta_percentile"].fillna(0)
    rank_score = (
        frame["location_global_percentile"] * (1 - typed_weight)
        + frame["location_typed_percentile"] * typed_weight
    )
    classifier_score = (
        frame["location_global_classifier_percentile"] * (1 - typed_weight)
        + frame["location_typed_classifier_percentile"] * typed_weight
    )
    return (
        rank_score * (1 - classifier_weight)
        + classifier_score * classifier_weight
    ).fillna(0)


def anchor_indices(
    group: pd.DataFrame,
    score_columns: Iterable[str],
    maximum: int,
) -> list[int]:
    anchors: list[int] = []
    group_indices = group.index.to_numpy(dtype=int)

    def strongest(column: str, count: int = 2) -> list[int]:
        numeric = pd.to_numeric(group[column], errors="coerce").to_numpy(
            dtype=float
        )
        finite = np.isfinite(numeric)
        if not finite.any():
            return []
        positions = np.flatnonzero(finite)
        order = positions[np.argsort(-numeric[positions], kind="stable")]
        return group_indices[order[:count]].tolist()

    for column in score_columns:
        if column not in group:
            continue
        for value in strongest(column):
            if value not in anchors:
                anchors.append(value)
            if len(anchors) >= maximum:
                return anchors
    for value in strongest("base_score", len(group)):
        if value not in anchors:
            anchors.append(value)
        if len(anchors) >= maximum:
            break
    return anchors


def training_pairs(
    frame: pd.DataFrame,
    *,
    group_column: str,
    label_column: str,
    score_columns: list[str],
    hard_negatives: int,
    positive_limit: int,
) -> pd.DataFrame:
    records: list[dict[str, int | str]] = []
    for group_id, group in frame.groupby(group_column, sort=False):
        positives = group[group[label_column].eq(1)].sort_values(
            "base_score", ascending=False
        ).index[:positive_limit]
        negatives = group[group[label_column].eq(0)]
        if len(positives) == 0 or negatives.empty:
            continue
        hard: list[int] = []
        for column in score_columns:
            if column not in negatives:
                continue
            for index in negatives.sort_values(column, ascending=False).index[:3]:
                value = int(index)
                if value not in hard:
                    hard.append(value)
                if len(hard) >= hard_negatives:
                    break
            if len(hard) >= hard_negatives:
                break
        if len(hard) < hard_negatives:
            for index in negatives.sort_values("base_score", ascending=False).index:
                value = int(index)
                if value not in hard:
                    hard.append(value)
                if len(hard) >= hard_negatives:
                    break
        for positive in positives:
            for negative in hard:
                positive_year = frame.loc[positive].get("candidate_year")
                negative_year = frame.loc[negative].get("candidate_year")
                year_delta = (
                    float(positive_year) - float(negative_year)
                    if pd.notna(positive_year) and pd.notna(negative_year)
                    else 0.0
                )
                metadata = {
                    "group_id": str(group_id),
                    "cluster_id": str(group.iloc[0]["cluster_id"]),
                    "event_type": str(group.iloc[0].get("event_type", "all")),
                }
                records.append({
                    **metadata,
                    "left_index": int(positive),
                    "right_index": int(negative),
                    "left_better": 1,
                    "year_delta": year_delta,
                })
                records.append({
                    **metadata,
                    "left_index": int(negative),
                    "right_index": int(positive),
                    "left_better": 0,
                    "year_delta": -year_delta,
                })
    return pd.DataFrame(records)


def comparison_pairs(
    frame: pd.DataFrame,
    *,
    group_column: str,
    score_columns: list[str],
    anchor_count: int,
) -> pd.DataFrame:
    left_chunks: list[np.ndarray] = []
    right_chunks: list[np.ndarray] = []
    cluster_chunks: list[np.ndarray] = []
    event_chunks: list[np.ndarray] = []
    year_delta_chunks: list[np.ndarray] = []
    candidate_years = pd.to_numeric(
        frame.get("candidate_year"), errors="coerce"
    ) if "candidate_year" in frame else pd.Series(np.nan, index=frame.index)
    for group_id, group in frame.groupby(group_column, sort=False):
        anchors = anchor_indices(group, score_columns, anchor_count)
        if len(group) == 1:
            continue
        indices = group.index.to_numpy(dtype=int)
        anchor_array = np.asarray(anchors, dtype=int)
        left = np.repeat(indices, len(anchor_array))
        right = np.tile(anchor_array, len(indices))
        retained = left != right
        left = left[retained]
        right = right[retained]
        if len(left) == 0:
            continue
        left_year = candidate_years.loc[left].to_numpy(dtype=float)
        right_year = candidate_years.loc[right].to_numpy(dtype=float)
        year_delta = np.where(
            np.isfinite(left_year) & np.isfinite(right_year),
            left_year - right_year,
            0.0,
        )
        left_chunks.append(left)
        right_chunks.append(right)
        cluster_chunks.append(np.full(
            len(left), str(group.iloc[0]["cluster_id"]), dtype=object
        ))
        event_chunks.append(np.full(
            len(left), str(group.iloc[0].get("event_type", "all")), dtype=object
        ))
        year_delta_chunks.append(year_delta)
    return pd.DataFrame({
        "cluster_id": np.concatenate(cluster_chunks),
        "event_type": np.concatenate(event_chunks),
        "left_index": np.concatenate(left_chunks),
        "right_index": np.concatenate(right_chunks),
        "year_delta": np.concatenate(year_delta_chunks),
    })


def pair_values(
    values: pd.DataFrame,
    pairs: pd.DataFrame,
    *,
    include_year_delta: bool,
) -> pd.DataFrame:
    left = values.loc[pairs["left_index"].to_numpy(dtype=int)].to_numpy(
        dtype=np.float32, copy=False
    )
    right = values.loc[pairs["right_index"].to_numpy(dtype=int)].to_numpy(
        dtype=np.float32, copy=False
    )
    delta = left - right
    output = pd.DataFrame(
        np.concatenate([delta, np.abs(delta)], axis=1),
        columns=(
            [f"delta_{column}" for column in values.columns]
            + [f"absolute_delta_{column}" for column in values.columns]
        ),
    )
    if include_year_delta:
        year_delta = pairs["year_delta"].to_numpy(dtype=np.float32)
        output["pair_year_delta"] = year_delta
        output["pair_year_absolute_delta"] = np.abs(year_delta)
        output["pair_year_direction"] = np.sign(year_delta)
    return output


def file_oof_pair_scores(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    group_column: str,
    label_column: str,
    score_columns: list[str],
    hard_negatives: int,
    positive_limit: int,
    anchor_count: int,
    location: bool,
    seed: int,
) -> tuple[np.ndarray, pd.DataFrame, pd.DataFrame]:
    train_pairs = training_pairs(
        frame,
        group_column=group_column,
        label_column=label_column,
        score_columns=score_columns,
        hard_negatives=hard_negatives,
        positive_limit=positive_limit,
    )
    compare_pairs = comparison_pairs(
        frame,
        group_column=group_column,
        score_columns=score_columns,
        anchor_count=anchor_count,
    )
    train_values = pair_values(
        values, train_pairs, include_year_delta=location
    )
    compare_values = pair_values(
        values, compare_pairs, include_year_delta=location
    )
    predictions = np.full(len(compare_pairs), np.nan)
    files = np.array(sorted(frame["cluster_id"].astype(str).unique()))
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(
        splitter.split(np.zeros(len(files)), groups=files)
    ):
        held_files = set(files[test_file_indices])
        if location:
            event_types = sorted(LOCAL_EVENT_TYPES)
        else:
            event_types = ["all"]
        for offset, event_type in enumerate(event_types):
            train_mask = ~train_pairs["cluster_id"].isin(held_files)
            test_mask = compare_pairs["cluster_id"].isin(held_files)
            if location:
                train_mask &= train_pairs["event_type"].eq(event_type)
                test_mask &= compare_pairs["event_type"].eq(event_type)
            train_indices = train_pairs.index[train_mask].to_numpy(dtype=int)
            test_indices = compare_pairs.index[test_mask].to_numpy(dtype=int)
            labels = train_pairs.loc[train_indices, "left_better"]
            if labels.nunique() < 2:
                raise RuntimeError(
                    f"pair head lacks both labels for fold {fold} {event_type}"
                )
            model = pair_classifier(
                seed + fold * 10 + offset, location=location
            )
            model.fit(train_values.loc[train_indices], labels)
            predictions[test_indices] = model.predict_proba(
                compare_values.loc[test_indices]
            )[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("missing file-OOF pairwise predictions")
    compare_pairs = compare_pairs.copy()
    compare_pairs["left_win_probability"] = predictions
    aggregate = compare_pairs.groupby("left_index", sort=False)[
        "left_win_probability"
    ].agg(["mean", "median", "min", "max", "std", "count"])
    scores = np.full(len(frame), 0.5, dtype=np.float32)
    scores[aggregate.index.to_numpy(dtype=int)] = aggregate["mean"].to_numpy(
        dtype=np.float32
    )
    return scores, train_pairs, compare_pairs


def clustered_lower(
    selected: pd.DataFrame, seed: int, repetitions: int
) -> float:
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
        values[index] = np.concatenate(
            [grouped[file_id] for file_id in sampled]
        ).mean()
    return float(np.quantile(values, 0.05, method="lower"))


def choose_top(
    frame: pd.DataFrame, *, group_column: str, score: pd.Series
) -> pd.DataFrame:
    return (
        frame.assign(final_model_score=score)
        .sort_values(
            [group_column, "final_model_score"], ascending=[True, False]
        )
        .groupby(group_column, sort=False)
        .head(1)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--standalone-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--hard-negatives", type=int, default=8)
    parser.add_argument("--operation-anchor-count", type=int, default=8)
    parser.add_argument("--location-anchor-count", type=int, default=6)
    parser.add_argument("--bootstrap-repetitions", type=int, default=3000)
    parser.add_argument("--maximum-clean-false-positives", type=int, default=4)
    parser.add_argument(
        "--reuse-location-pair-scores",
        action="store_true",
        help="Treat --location-scores as frozen compact file-OOF pair scores.",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = pd.read_pickle(Path(args.operation_scores).resolve()).reset_index(
        drop=True
    )
    operations = append_operation_evidence_consensus(operations)
    packages = pd.read_pickle(Path(args.location_scores).resolve()).reset_index(
        drop=True
    )
    baseline = pd.read_csv(Path(args.standalone_top).resolve())
    baseline_summary = json.loads(
        (Path(args.standalone_top).resolve().parent / "summary.json").read_text(
            encoding="utf8"
        )
    )
    baseline_weights = baseline_summary.get("weights", {})

    strict_identity = packages.groupby("identity_group", sort=False)[
        "strict_correct"
    ].max()
    operations["identity_strict_correct"] = operations["identity_group"].map(
        strict_identity
    ).fillna(0).astype(int)
    operations["base_score"] = base_operation_score(
        operations, baseline_weights
    )
    local_mask = packages["event_type"].isin(LOCAL_EVENT_TYPES)
    if not args.reuse_location_pair_scores:
        packages["base_score"] = base_location_score(packages, baseline_weights)

    operation_columns = operation_feature_columns(operations)
    operation_values, operation_features = encode(operations, operation_columns)
    operation_score_columns = [
        column
        for column in (
            "operation_meta_percentile",
            "operation_rank_percentile",
            "operation_classifier_percentile",
            "typed_operation_rank_percentile",
            "typed_operation_classifier_percentile",
            "shift_rank_percentile",
            "shift_classifier_percentile",
        )
        if column in operations
    ]
    operation_pair_score, operation_train_pairs, operation_compare_pairs = (
        file_oof_pair_scores(
            operations,
            operation_values,
            group_column="attempt_id",
            label_column="operation_correct",
            score_columns=operation_score_columns,
            hard_negatives=args.hard_negatives,
            positive_limit=3,
            anchor_count=args.operation_anchor_count,
            location=False,
            seed=121000,
        )
    )
    operations["pairwise_score"] = operation_pair_score
    operations["pairwise_percentile"] = operations.groupby(
        "attempt_id", sort=False
    )["pairwise_score"].rank(pct=True)
    operation_training_pair_count = len(operation_train_pairs)
    operation_comparison_pair_count = len(operation_compare_pairs)
    operation_train_pairs.to_pickle(output_dir / "operation-training-pairs.pkl")
    del operation_train_pairs, operation_compare_pairs, operation_values
    gc.collect()

    local_packages = packages[local_mask].copy().reset_index(drop=True)
    del packages
    gc.collect()
    if args.reuse_location_pair_scores:
        required = {
            "base_score",
            "pairwise_score",
            "pairwise_percentile",
            "workflow_correct",
            "strict_correct",
        }
        missing = sorted(required - set(local_packages.columns))
        if missing:
            raise RuntimeError(
                f"precomputed location scores missing: {','.join(missing)}"
            )
        reused_summary_path = Path(args.location_scores).resolve().parent / "summary.json"
        reused_summary = (
            json.loads(reused_summary_path.read_text(encoding="utf8"))
            if reused_summary_path.exists()
            else {}
        )
        location_features = ["precomputed_file_oof_pair_score"]
        location_training_pair_count = int(
            reused_summary.get("locationTrainingPairs", 0)
        )
        location_comparison_pair_count = int(
            reused_summary.get("locationComparisonPairs", 0)
        )
    else:
        location_columns = location_feature_columns(local_packages)
        location_values, location_features = encode(local_packages, location_columns)
        location_score_columns = [
            column
            for column in (
                "location_meta_percentile",
                "location_global_percentile",
                "location_typed_percentile",
                "location_global_classifier_percentile",
                "location_typed_classifier_percentile",
                "evidence_consensus_family_mean_percentile",
            )
            if column in local_packages
        ]
        location_pair_score, location_train_pairs, location_compare_pairs = (
            file_oof_pair_scores(
                local_packages,
                location_values,
                group_column="identity_group",
                label_column="workflow_correct",
                score_columns=location_score_columns,
                hard_negatives=args.hard_negatives,
                positive_limit=3,
                anchor_count=args.location_anchor_count,
                location=True,
                seed=122000,
            )
        )
        local_packages["pairwise_score"] = location_pair_score
        local_packages["pairwise_percentile"] = local_packages.groupby(
            "identity_group", sort=False
        )["pairwise_score"].rank(pct=True)
        location_training_pair_count = len(location_train_pairs)
        location_comparison_pair_count = len(location_compare_pairs)
        location_train_pairs.to_pickle(output_dir / "location-training-pairs.pkl")
        del location_train_pairs, location_compare_pairs, location_values
        gc.collect()

    weights = (0.0, 0.25, 0.5, 0.75, 1.0)
    selections: dict[tuple[float, float], pd.DataFrame] = {}
    grid_rows: list[dict[str, float | int]] = []
    for operation_weight in weights:
        operation_score = (
            operations["base_score"] * (1 - operation_weight)
            + operations["pairwise_percentile"] * operation_weight
        )
        operation_top = choose_top(
            operations, group_column="attempt_id", score=operation_score
        )
        for location_weight in weights:
            location_score = (
                local_packages["base_score"] * (1 - location_weight)
                + local_packages["pairwise_percentile"] * location_weight
            )
            location_top = choose_top(
                local_packages,
                group_column="identity_group",
                score=location_score,
            ).set_index("identity_group")
            selected = operation_top.copy()
            selected["selected_candidate_source"] = selected[
                "identity_group"
            ].map(location_top["candidate_source"])
            selected["selected_candidate_year"] = selected[
                "identity_group"
            ].map(location_top["candidate_year"])
            selected["selected_package_correct"] = selected[
                "identity_group"
            ].map(location_top["workflow_correct"])
            selected["selected_package_strict_correct"] = selected[
                "identity_group"
            ].map(location_top["strict_correct"])
            local_selected = selected["event_type"].isin(LOCAL_EVENT_TYPES)
            selected["final_correct"] = selected["operation_correct"].astype(int)
            selected.loc[local_selected, "final_correct"] = selected.loc[
                local_selected, "selected_package_correct"
            ].fillna(0).astype(int)
            selected["final_strict_correct"] = selected[
                "identity_strict_correct"
            ].astype(int)
            selected.loc[local_selected, "final_strict_correct"] = selected.loc[
                local_selected, "selected_package_strict_correct"
            ].fillna(0).astype(int)
            selected["candidate_has_response"] = selected["event_type"].ne(
                "noEvent"
            ).astype(int)
            event = selected[selected["family"].ne("Clean")]
            clean = selected[selected["family"].eq("Clean")]
            family_accuracy = {
                family: float(group["final_correct"].mean())
                for family, group in event.groupby("family")
            }
            grid_rows.append({
                "operationPairWeight": operation_weight,
                "locationPairWeight": location_weight,
                "eventCorrect": int(event["final_correct"].sum()),
                "minimumFamilyAccuracy": min(family_accuracy.values()),
                "cleanFalsePositives": int(
                    clean["candidate_has_response"].sum()
                ),
                **{
                    f"accuracy{family}": accuracy
                    for family, accuracy in family_accuracy.items()
                },
            })
            selections[(operation_weight, location_weight)] = selected

    grid = pd.DataFrame(grid_rows)
    eligible = grid[
        grid["cleanFalsePositives"].le(args.maximum_clean_false_positives)
    ]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["minimumFamilyAccuracy", "eventCorrect", "cleanFalsePositives"],
        ascending=[False, False, True],
    ).iloc[0]
    chosen_weights = (
        float(best["operationPairWeight"]),
        float(best["locationPairWeight"]),
    )
    selected = selections[chosen_weights]
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    baseline_event = baseline[baseline["family"].ne("Clean")].set_index(
        "attempt_id"
    )
    final_event = event.set_index("attempt_id")
    shared = baseline_event.index.intersection(final_event.index)
    before = baseline_event.loc[shared, "final_correct"].astype(int)
    after = final_event.loc[shared, "final_correct"].astype(int)

    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": clustered_lower(
                group,
                123000 + ord(family[0]),
                args.bootstrap_repetitions,
            ),
        }
        for family, group in event.groupby("family")
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "standalone_unified_pairwise_only",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "files": int(selected["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "operationFeatures": len(operation_features),
        "locationFeatures": len(location_features),
        "operationTrainingPairs": operation_training_pair_count,
        "operationComparisonPairs": operation_comparison_pair_count,
        "locationTrainingPairs": location_training_pair_count,
        "locationComparisonPairs": location_comparison_pair_count,
        "weights": {
            "operationPair": chosen_weights[0],
            "locationPair": chosen_weights[1],
        },
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneWorkflowAccuracy": float(event["final_correct"].mean()),
        "standaloneStrictAccuracy": float(
            event["final_strict_correct"].mean()
        ),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "overallOneSided95FileClusterLower": clustered_lower(
            event, 123999, args.bootstrap_repetitions
        ),
        "baselineCorrect": int(before.sum()),
        "wrongToCorrect": int(((before.eq(0)) & (after.eq(1))).sum()),
        "correctToWrong": int(((before.eq(1)) & (after.eq(0))).sum()),
        "selectedProductPrimary": int(
            event["selected_candidate_source"].eq("productPrimary").sum()
        ),
        "byFamily": by_family,
    }

    operations[[
        "attempt_id",
        "cluster_id",
        "identity_group",
        "event_type",
        "shift_years",
        "operation_correct",
        "base_score",
        "pairwise_score",
        "pairwise_percentile",
    ]].to_pickle(output_dir / "operation-pairwise-oof-scores.pkl")
    local_packages[[
        "attempt_id",
        "cluster_id",
        "identity_group",
        "candidate_source",
        "candidate_year",
        "event_type",
        "shift_years",
        "workflow_correct",
        "strict_correct",
        "base_score",
        "pairwise_score",
        "pairwise_percentile",
    ]].to_pickle(output_dir / "location-pairwise-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-pairwise-top.csv", index=False)
    grid.to_csv(output_dir / "pairwise-weight-grid.csv", index=False)
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
