#!/usr/bin/env python3
"""Rank base, pairwise, and full-year locations as ordinary OOF proposals."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
LABEL_COLUMNS = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "identity_group",
    "candidate_year",
    "proposal_correct",
    "proposal_strict_correct",
    "operation_correct",
    "truth_year",
    "workflow_correct",
    "strict_correct",
    "location_correct",
    "location_relevance",
    "location_error_years",
}


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="rank_xendcg",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=700,
        learning_rate=0.02,
        num_leaves=9,
        min_child_samples=20,
        subsample=0.9,
        colsample_bytree=0.8,
        reg_alpha=2.0,
        reg_lambda=9.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def classifier(seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary",
        metric="binary_logloss",
        n_estimators=500,
        learning_rate=0.02,
        num_leaves=7,
        min_child_samples=20,
        subsample=0.9,
        colsample_bytree=0.8,
        reg_alpha=2.0,
        reg_lambda=9.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
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
    }:
        return True
    return column.startswith((
        "geometry_productPrimary_",
        "geometry_productAlternative_",
    )) and column.endswith((
        "_anchor_count",
        "_exact_fraction",
        "_within_2_fraction",
        "_within_4_fraction",
        "_within_6_fraction",
        "_median_absolute_distance",
        "_median_signed_distance",
        "_modal_year_fraction",
        "_older_anchor_fraction",
        "_newer_anchor_fraction",
    ))


def location_feature_columns(frame: pd.DataFrame) -> list[str]:
    exact = {
        "candidate_source",
        "event_type",
        "shift_years",
        "shift_abs",
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
    return [
        column
        for column in frame
        if column not in LABEL_COLUMNS
        and (
            column in exact
            or compact_geometry(column)
            or column.startswith("evidence_consensus_")
            or (
                column.startswith("evidence_identity_")
                and column.endswith("_percentile")
                and "evidence_identity_operation_" not in column
            )
        )
    ]


def unique_columns(columns: list[str]) -> list[str]:
    """Preserve feature order while keeping join keys exactly once."""

    return list(dict.fromkeys(columns))


def proposal_sample_weights(proposals: pd.DataFrame) -> pd.Series:
    """Give every event attempt equal total weight regardless of proposal count."""

    counts = proposals.groupby("attempt_id")["attempt_id"].transform("size")
    return (1.0 / counts).astype(np.float32)


def encode(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    duplicates = frame.columns[frame.columns.duplicated()].unique().tolist()
    if duplicates:
        raise RuntimeError(
            f"duplicate proposal features: {','.join(map(str, duplicates))}"
        )
    columns = [column for column in frame if column not in LABEL_COLUMNS]
    forbidden = sorted(set(columns) & LABEL_COLUMNS)
    if forbidden:
        raise RuntimeError(f"forbidden proposal features: {','.join(forbidden)}")
    raw = frame[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=np.float32)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def base_location_score(frame: pd.DataFrame, weights: dict[str, float]) -> pd.Series:
    typed = float(weights.get("typedLocation", 0.5))
    classifier = float(weights.get("locationClassifier", 0.0))
    if typed == 2.0 and classifier == 2.0:
        return frame["location_meta_percentile"].fillna(0)
    rank_score = (
        frame["location_global_percentile"] * (1 - typed)
        + frame["location_typed_percentile"] * typed
    )
    classifier_score = (
        frame["location_global_classifier_percentile"] * (1 - typed)
        + frame["location_typed_classifier_percentile"] * typed
    )
    return (
        rank_score * (1 - classifier) + classifier_score * classifier
    ).fillna(0)


def proposal_rows(
    base: pd.DataFrame,
    pair: pd.DataFrame,
    profile: pd.DataFrame,
) -> pd.DataFrame:
    rows = []
    for role, frame in (("base", base), ("pair", pair), ("profile", profile)):
        local = frame[frame["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
        strict_column = next(
            (
                column
                for column in (
                    "final_strict_correct",
                    "selected_package_strict_correct",
                    "selected_package_correct",
                    "final_correct",
                )
                if column in local
            ),
            "final_correct",
        )
        for _, row in local.iterrows():
            rows.append({
                "attempt_id": str(row["attempt_id"]),
                "cluster_id": str(row["cluster_id"]),
                "file_id": str(row["file_id"]),
                "family": str(row["family"]),
                "identity_group": str(row["identity_group"]),
                "event_type": str(row["event_type"]),
                "shift_years": int(row["shift_years"]),
                "candidate_year": float(row["selected_candidate_year"]),
                "candidate_source": str(
                    row.get("selected_candidate_source") or role
                ),
                "proposal_role": role,
                "proposal_correct": int(row["final_correct"]),
                "proposal_strict_correct": int(row[strict_column]),
                "operation_correct": int(row["operation_correct"]),
            })
    return pd.DataFrame(rows)


def append_agreement_features(proposals: pd.DataFrame) -> pd.DataFrame:
    output = proposals.copy()
    grouped = output.groupby("attempt_id", sort=False)
    output["proposal_count"] = grouped["proposal_role"].transform("size")
    output["proposal_unique_year_count"] = grouped["candidate_year"].transform(
        "nunique"
    )
    median = grouped["candidate_year"].transform("median")
    minimum = grouped["candidate_year"].transform("min")
    maximum = grouped["candidate_year"].transform("max")
    output["proposal_signed_distance_from_median"] = (
        output["candidate_year"] - median
    )
    output["proposal_absolute_distance_from_median"] = output[
        "proposal_signed_distance_from_median"
    ].abs()
    output["proposal_distance_from_oldest"] = output["candidate_year"] - minimum
    output["proposal_distance_from_newest"] = maximum - output["candidate_year"]
    output["proposal_recency_rank"] = grouped["candidate_year"].rank(pct=True)

    for radius in (0, 1, 2, 4, 6):
        support = np.zeros(len(output), dtype=np.float32)
        for _, group in grouped:
            years = group["candidate_year"].to_numpy(dtype=float)
            distances = np.abs(years[:, None] - years[None, :])
            support[group.index.to_numpy(dtype=int)] = (
                distances <= radius
            ).mean(axis=1)
        output[f"proposal_support_within_{radius}"] = support
    return output


def match_location_rows(
    proposals: pd.DataFrame,
    locations: pd.DataFrame,
) -> pd.DataFrame:
    locations = locations.copy()
    location_groups = {
        identity: group
        for identity, group in locations.groupby("identity_group", sort=False)
    }
    selected_indices: list[int] = []
    exact_source: list[int] = []
    exact_year: list[int] = []
    year_distance: list[float] = []
    for _, proposal in proposals.iterrows():
        group = location_groups[str(proposal["identity_group"])]
        distance = (
            pd.to_numeric(group["candidate_year"], errors="coerce")
            - float(proposal["candidate_year"])
        ).abs()
        source_match = group["candidate_source"].eq(
            str(proposal["candidate_source"])
        )
        year_match = distance.eq(0)
        priority = source_match.astype(int) * 2 + year_match.astype(int)
        best_priority = int(priority.max())
        candidates = group[priority.eq(best_priority)]
        candidate_distance = distance.loc[candidates.index]
        candidates = candidates[candidate_distance.eq(candidate_distance.min())]
        index = int(candidates["frozen_base_score"].idxmax())
        selected_indices.append(index)
        exact_source.append(int(source_match.loc[index]))
        exact_year.append(int(year_match.loc[index]))
        year_distance.append(float(distance.loc[index]))

    features = locations.loc[selected_indices].reset_index(drop=True)
    features["matched_base_exact_source"] = exact_source
    features["matched_base_exact_year"] = exact_year
    features["matched_base_year_distance"] = year_distance
    return features


def attach_pair_scores(
    proposals: pd.DataFrame,
    pair_scores: pd.DataFrame,
) -> pd.DataFrame:
    scores = pair_scores.copy()
    scores["candidate_year"] = pd.to_numeric(scores["candidate_year"])
    by_identity = {
        identity: group
        for identity, group in scores.groupby("identity_group", sort=False)
    }
    rows = []
    for _, proposal in proposals.iterrows():
        group = by_identity[str(proposal["identity_group"])]
        distance = (
            group["candidate_year"] - float(proposal["candidate_year"])
        ).abs()
        candidates = group[distance.eq(distance.min())]
        row = candidates.sort_values("pairwise_percentile", ascending=False).iloc[0]
        rows.append({
            "pair_candidate_base_score": row["base_score"],
            "pair_candidate_score": row["pairwise_score"],
            "pair_candidate_percentile": row["pairwise_percentile"],
            "pair_candidate_year_distance": float(distance.loc[row.name]),
        })
    return pd.DataFrame(rows)


def attach_profile_scores(
    proposals: pd.DataFrame,
    profile_scores: pd.DataFrame,
) -> pd.DataFrame:
    by_identity = {
        identity: group
        for identity, group in profile_scores.groupby("identity_group", sort=False)
    }
    score_columns = [
        column
        for column in profile_scores
        if column.startswith("location_")
    ]
    rows = []
    for _, proposal in proposals.iterrows():
        group = by_identity[str(proposal["identity_group"])]
        distance = (
            pd.to_numeric(group["year"], errors="coerce")
            - float(proposal["candidate_year"])
        ).abs()
        row = group.loc[distance.idxmin()]
        record = {
            f"profile_candidate_{column}": row[column]
            for column in score_columns
        }
        record["profile_candidate_year_distance"] = float(distance.loc[row.name])
        rows.append(record)
    return pd.DataFrame(rows)


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
        values[index] = np.concatenate(
            [grouped[file_id] for file_id in sampled]
        ).mean()
    return float(np.quantile(values, 0.05, method="lower"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--pair-top", required=True)
    parser.add_argument("--profile-top", required=True)
    parser.add_argument("--base-location-scores", required=True)
    parser.add_argument("--pair-location-scores", required=True)
    parser.add_argument("--profile-location-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=3000)
    parser.add_argument(
        "--ensemble-members",
        type=int,
        default=1,
        help="Average independent file-OOF rankers within each held-out fold.",
    )
    parser.add_argument(
        "--model-type",
        choices=("ranker", "classifier"),
        default="ranker",
        help="Direct proposal scorer used in every held-out file.",
    )
    parser.add_argument("--seed-base", type=int, default=131000)
    args = parser.parse_args()
    if args.ensemble_members < 1:
        raise ValueError("--ensemble-members must be at least 1")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base_path = Path(args.base_top).resolve()
    base = pd.read_csv(base_path)
    pair = pd.read_csv(Path(args.pair_top).resolve())
    profile = pd.read_csv(Path(args.profile_top).resolve())
    proposals = append_agreement_features(proposal_rows(base, pair, profile))

    locations = pd.read_pickle(Path(args.base_location_scores).resolve())
    locations = locations[locations["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    base_summary = json.loads(
        (base_path.parent / "summary.json").read_text(encoding="utf8")
    )
    locations["frozen_base_score"] = base_location_score(
        locations, base_summary.get("weights", {})
    )
    location_columns = location_feature_columns(locations)
    matched = match_location_rows(
        proposals,
        locations[unique_columns([
            "identity_group",
            "candidate_source",
            "candidate_year",
            "frozen_base_score",
            *location_columns,
        ])],
    )
    matched_feature_columns = [f"base_{column}" for column in location_columns]
    matched = matched.rename(columns={
        column: f"base_{column}" for column in location_columns
    })
    del locations

    pair_scores = pd.read_pickle(Path(args.pair_location_scores).resolve())
    profile_scores = pd.read_pickle(Path(args.profile_location_scores).resolve())
    pair_features = attach_pair_scores(proposals, pair_scores)
    profile_features = attach_profile_scores(proposals, profile_scores)
    del pair_scores, profile_scores

    feature_frame = pd.concat([
        proposals[[
            "proposal_role",
            "event_type",
            "shift_years",
            "proposal_count",
            "proposal_unique_year_count",
            "proposal_signed_distance_from_median",
            "proposal_absolute_distance_from_median",
            "proposal_distance_from_oldest",
            "proposal_distance_from_newest",
            "proposal_recency_rank",
            "proposal_support_within_0",
            "proposal_support_within_1",
            "proposal_support_within_2",
            "proposal_support_within_4",
            "proposal_support_within_6",
        ]].reset_index(drop=True),
        matched[matched_feature_columns + [
            "matched_base_exact_source",
            "matched_base_exact_year",
            "matched_base_year_distance",
        ]].reset_index(drop=True),
        pair_features,
        profile_features,
    ], axis=1)
    values, feature_names = encode(feature_frame)

    files = np.array(sorted(proposals["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    predictions = np.full(len(proposals), np.nan)
    for fold, (_, test_file_indices) in enumerate(
        splitter.split(np.zeros(len(files)), groups=files)
    ):
        held_files = set(files[test_file_indices])
        train = proposals.index[
            ~proposals["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        test = proposals.index[
            proposals["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        ordered = proposals.loc[train].sort_values("attempt_id").index.to_numpy(
            dtype=int
        )
        groups = proposals.loc[ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
        fold_predictions = np.zeros(len(test), dtype=float)
        for member in range(args.ensemble_members):
            seed = args.seed_base + fold + member * 1009
            if args.model_type == "classifier":
                estimator = classifier(seed)
                estimator.fit(
                    values.loc[ordered],
                    proposals.loc[ordered, "proposal_correct"],
                    sample_weight=proposal_sample_weights(
                        proposals.loc[ordered]
                    ),
                )
                fold_predictions += estimator.predict_proba(
                    values.loc[test]
                )[:, 1]
            else:
                estimator = ranker(seed)
                estimator.fit(
                    values.loc[ordered],
                    proposals.loc[ordered, "proposal_correct"],
                    group=groups,
                )
                fold_predictions += estimator.predict(values.loc[test])
        predictions[test] = fold_predictions / args.ensemble_members
    if np.isnan(predictions).any():
        raise RuntimeError("missing proposal-fusion OOF predictions")
    proposals["proposal_score"] = predictions
    top = proposals.sort_values(
        ["attempt_id", "proposal_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).set_index("attempt_id")

    selected = base.copy().set_index("attempt_id")
    if "final_strict_correct" not in selected:
        selected["final_strict_correct"] = (
            selected["selected_package_correct"]
            if "selected_package_correct" in selected
            else selected["final_correct"]
        )
    attempts = selected.index.intersection(top.index)
    selected.loc[attempts, "final_correct"] = top.loc[
        attempts, "proposal_correct"
    ].astype(int)
    if "final_strict_correct" in selected:
        selected.loc[attempts, "final_strict_correct"] = top.loc[
            attempts, "proposal_strict_correct"
        ].astype(int)
    selected.loc[attempts, "operation_correct"] = top.loc[
        attempts, "operation_correct"
    ].astype(int)
    selected.loc[attempts, "selected_candidate_year"] = top.loc[
        attempts, "candidate_year"
    ]
    selected.loc[attempts, "selected_candidate_source"] = top.loc[
        attempts, "proposal_role"
    ].map({
        "base": "unifiedBaseProposal",
        "pair": "unifiedPairProposal",
        "profile": "unifiedFullYearProposal",
    })
    selected.loc[attempts, "selected_proposal_role"] = top.loc[
        attempts, "proposal_role"
    ]
    selected = selected.reset_index()
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    baseline = base[base["family"].ne("Clean")].set_index("attempt_id")
    final = event.set_index("attempt_id")
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "operationAccuracy": float(group["operation_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": clustered_lower(
                group, 132000 + ord(family), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family")
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": f"standalone_unified_three_proposal_{args.model_type}",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "files": int(proposals["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "proposalRows": len(proposals),
        "features": len(feature_names),
        "modelType": args.model_type,
        "seedBase": args.seed_base,
        "ensembleMembers": args.ensemble_members,
        "candidateOracleCorrect": int(
            proposals.groupby("attempt_id")["proposal_correct"].max().sum()
        ) + int(event[~event["event_type"].isin(LOCAL_EVENT_TYPES)][
            "final_correct"
        ].sum()),
        "baselineCorrect": int(baseline["final_correct"].sum()),
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneWorkflowAccuracy": float(event["final_correct"].mean()),
        "standaloneStrictAccuracy": float(
            event["final_strict_correct"].mean()
        ),
        "standaloneOperationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "overallOneSided95FileClusterLower": clustered_lower(
            event, 132999, args.bootstrap_repetitions
        ),
        "wrongToCorrect": int((
            baseline["final_correct"].eq(0) & final["final_correct"].eq(1)
        ).sum()),
        "correctToWrong": int((
            baseline["final_correct"].eq(1) & final["final_correct"].eq(0)
        ).sum()),
        "selectedRoles": top["proposal_role"].value_counts().to_dict(),
        "byFamily": by_family,
    }
    feature_table = pd.concat([
        proposals.reset_index(drop=True),
        values.add_prefix("feature__").reset_index(drop=True),
    ], axis=1)
    feature_table.to_pickle(output_dir / "proposal-fusion-feature-table.pkl")
    proposals.to_pickle(output_dir / "proposal-fusion-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-proposal-fusion-top.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
