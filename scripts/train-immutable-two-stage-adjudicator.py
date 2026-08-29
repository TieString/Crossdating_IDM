#!/usr/bin/env python3
"""Train and evaluate a file-isolated immutable two-stage adjudicator."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from immutable_two_stage_adjudicator import (
    LOCAL_EVENT_TYPES,
    FeatureSpec,
    add_location_proposal_anchors,
    append_frozen_proposal_packages,
    assert_same_identity_projection,
    build_pair_training,
    ensure_identity_group,
    fit_ranker,
    identity_keys,
    make_feature_spec,
    pair_classifier,
    pair_tournament_scores,
    project_relative_features,
    ranker,
    seed_percentile,
    select_top,
    sha256,
    within_group_percentile,
    write_json,
)


OPERATION_PREFERRED = (
    "operation_meta_percentile",
    "operation_rank_percentile",
    "operation_classifier_percentile",
    "typed_operation_rank_percentile",
    "typed_operation_classifier_percentile",
    "max_evidence_operation_probability",
    "max_evidence_identity_enriched_operation_probability",
    "max_evidence_identity_operation_classifier_percentile",
    "max_evidence_referenceChange_referenceCount",
    "max_evidence_referenceTransition_referenceCount",
    "max_evidence_perReference_referenceCount",
    "support_referenceChange_referenceCount_attempt_percentile",
    "support_referenceTransition_referenceCount_attempt_percentile",
    "support_perReference_referenceCount_attempt_percentile",
    "support_raw_pairs_side_balance",
    "support_difference_pairs_side_balance",
    "support_piecewise_pairs_side_balance",
)
OPERATION_SEED = (
    "operation_meta_percentile",
    "operation_rank_percentile",
    "operation_classifier_percentile",
    "typed_operation_rank_percentile",
    "typed_operation_classifier_percentile",
)
LOCATION_PREFERRED = (
    "location_meta_percentile",
    "location_global_percentile",
    "location_typed_percentile",
    "location_global_classifier_percentile",
    "location_typed_classifier_percentile",
    "evidence_classifier_percentile",
    "evidence_typed_classifier_percentile",
    "evidence_location_classifier_blend",
    "evidence_referenceChange_referenceCount",
    "evidence_referenceTransition_referenceCount",
    "evidence_perReference_referenceCount",
    "evidence_referenceChange_supportFraction",
    "evidence_referenceTransition_positiveGainFraction",
    "evidence_perReference_positiveDifferenceGainFraction",
    "evidence_perReference_positiveWhitenedGainFraction",
)
LOCATION_SEED = (
    "location_meta_percentile",
    "location_global_percentile",
    "location_typed_percentile",
    "location_global_classifier_percentile",
    "location_typed_classifier_percentile",
    "evidence_classifier_percentile",
    "evidence_typed_classifier_percentile",
    "proposal_score",
)
PROPOSAL_PREFERRED = (
    "frozen_proposal_available",
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
    "proposal_score",
)
BLEND_WEIGHTS = tuple(np.linspace(0, 1, 9))


def parse_anchor_paths(values: list[str] | None) -> dict[str, Path]:
    anchors: dict[str, Path] = {}
    for value in values or []:
        if "=" not in value:
            raise RuntimeError("proposal anchor must use NAME=CSV_PATH")
        name, raw_path = value.split("=", 1)
        name = name.strip()
        if not name or name in anchors:
            raise RuntimeError(f"invalid or duplicate proposal anchor name {name!r}")
        anchors[name] = Path(raw_path).resolve()
    return anchors


def load_anchor_tables(paths: dict[str, Path]) -> dict[str, pd.DataFrame]:
    return {name: pd.read_csv(path) for name, path in paths.items()}


def cluster_lower(frame: pd.DataFrame, seed: int, repetitions: int) -> float:
    files = np.asarray(sorted(frame["file_id"].unique()))
    grouped = {
        file_id: frame.loc[frame["file_id"].eq(file_id), "final_correct"]
        .to_numpy(dtype=float)
        for file_id in files
    }
    rng = np.random.default_rng(seed)
    samples = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        selected = rng.choice(files, size=len(files), replace=True)
        samples[index] = np.concatenate([grouped[file_id] for file_id in selected]).mean()
    return float(np.quantile(samples, 0.05, method="lower"))


def prepare_operation(frame: pd.DataFrame) -> pd.DataFrame:
    output = ensure_identity_group(frame).reset_index(drop=True)
    output["file_id"] = output["file_id"].astype(str)
    output["operation_correct"] = pd.to_numeric(
        output["operation_correct"], errors="coerce"
    ).fillna(0).astype(np.int8)
    return output


def prepare_location(frame: pd.DataFrame) -> pd.DataFrame:
    output = ensure_identity_group(frame).reset_index(drop=True)
    output["file_id"] = output["file_id"].astype(str)
    output["identity_operation_correct"] = pd.to_numeric(
        output["identity_operation_correct"], errors="coerce"
    ).fillna(0).astype(np.int8)
    output["location_relevance"] = pd.to_numeric(
        output["location_relevance"], errors="coerce"
    ).fillna(0).clip(0, 3).astype(np.int8)
    return output


def prepare_proposals(frame: pd.DataFrame) -> pd.DataFrame:
    output = ensure_identity_group(frame).reset_index(drop=True)
    output["file_id"] = output["file_id"].astype(str)
    output["proposal_correct"] = pd.to_numeric(
        output["proposal_correct"], errors="coerce"
    ).fillna(0).astype(np.int8)
    output["operation_correct"] = pd.to_numeric(
        output["operation_correct"], errors="coerce"
    ).fillna(0).astype(np.int8)
    output["location_relevance"] = output["proposal_correct"].mul(3).astype(np.int8)
    return output


def top_with_standardized_margin(
    frame: pd.DataFrame,
    score: pd.Series | np.ndarray,
    *,
    group: str,
) -> tuple[pd.DataFrame, pd.Series]:
    scored = frame.copy()
    scored["_adjudicator_score"] = np.asarray(score, dtype=float)
    ordered = scored.sort_values(
        [group, "_adjudicator_score"], ascending=[True, False], kind="stable"
    )
    top = ordered.drop_duplicates(group).copy()
    second = ordered.groupby(group, sort=False).nth(1).set_index(group)
    deviation = scored.groupby(group, sort=False)["_adjudicator_score"].std()
    second_score = top[group].map(second["_adjudicator_score"])
    margin = top["_adjudicator_score"].sub(second_score).div(
        top[group].map(deviation).replace(0, np.nan)
    ).replace([np.inf, -np.inf], np.nan).fillna(0)
    margin.index = top[group]
    return top.drop(columns="_adjudicator_score"), margin


def project_locations_into_operations(
    operation_top: pd.DataFrame,
    proposal_top: pd.DataFrame,
    dense_location_top: pd.DataFrame,
) -> pd.DataFrame:
    selected = operation_top.copy()
    if "selected_package_correct" not in selected:
        selected["selected_package_correct"] = np.nan
    if "location_correct" not in selected:
        selected["location_correct"] = np.nan
    if "selected_candidate_source" not in selected:
        selected["selected_candidate_source"] = pd.Series(
            pd.NA, index=selected.index, dtype=object
        )
    if "selected_candidate_year" not in selected:
        selected["selected_candidate_year"] = np.nan
    if "proposal_role" not in selected:
        selected["proposal_role"] = pd.Series(
            pd.NA, index=selected.index, dtype=object
        )
    local_mask = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    proposal_by_identity = proposal_top.set_index("identity_group")
    dense_by_identity = dense_location_top.set_index("identity_group")
    for row_index in selected.index[local_mask]:
        identity = selected.at[row_index, "identity_group"]
        if identity in proposal_by_identity.index:
            location = proposal_by_identity.loc[identity]
            selected.at[row_index, "selected_package_correct"] = location[
                "proposal_correct"
            ]
            selected.at[row_index, "location_correct"] = location[
                "proposal_correct"
            ]
            selected.at[row_index, "selected_candidate_source"] = location[
                "candidate_source"
            ]
            selected.at[row_index, "selected_candidate_year"] = location[
                "candidate_year"
            ]
            selected.at[row_index, "proposal_role"] = location["proposal_role"]
        elif identity in dense_by_identity.index:
            location = dense_by_identity.loc[identity]
            selected.at[row_index, "selected_package_correct"] = location[
                "workflow_correct"
            ]
            selected.at[row_index, "location_correct"] = location[
                "location_correct"
            ]
            selected.at[row_index, "selected_candidate_source"] = location[
                "candidate_source"
            ]
            selected.at[row_index, "selected_candidate_year"] = location[
                "candidate_year"
            ]
        # A wrong operation identity can legitimately have no location package
        # because the location head is trained only on correct identities.  It
        # remains an incomplete challenger and can never pass the safety gate.
    selected["final_correct"] = selected["operation_correct"].astype(np.int8)
    selected.loc[local_mask, "final_correct"] = selected.loc[
        local_mask, "selected_package_correct"
    ].fillna(0).astype(np.int8)
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(
        np.int8
    )
    return selected


def operation_override_margin(
    operations: pd.DataFrame,
    operation_score: pd.Series,
    operation_top: pd.DataFrame,
    baseline: pd.DataFrame,
) -> pd.Series:
    scored = operations[["attempt_id", "identity_group"]].copy()
    scored["score"] = np.asarray(operation_score, dtype=float)
    lookup = scored.set_index(["attempt_id", "identity_group"])["score"]
    deviation = scored.groupby("attempt_id", sort=False)["score"].std()
    baseline_identity = baseline.set_index("attempt_id")["identity_group"]
    baseline_keys = pd.MultiIndex.from_arrays([
        operation_top["attempt_id"],
        operation_top["attempt_id"].map(baseline_identity),
    ])
    baseline_score = lookup.reindex(baseline_keys).to_numpy()
    margin = operation_top.assign(
        _baseline_score=baseline_score,
        _deviation=operation_top["attempt_id"].map(deviation),
    )
    values = margin["_adjudicator_score"].sub(margin["_baseline_score"]).div(
        margin["_deviation"].replace(0, np.nan)
    ).replace([np.inf, -np.inf], np.nan).fillna(0)
    values.index = operation_top["attempt_id"]
    return values


def calibrate_no_regression_threshold(
    baseline: pd.DataFrame,
    challenger: pd.DataFrame,
    margin: pd.Series,
    *,
    baseline_correct: str,
    challenger_correct: str,
    eligible: pd.Series,
) -> float:
    baseline_by_attempt = baseline.set_index("attempt_id")
    challenger_by_attempt = challenger.set_index("attempt_id")
    attempts = challenger["attempt_id"]
    harmful = (
        attempts.map(baseline_by_attempt[baseline_correct]).eq(1)
        & challenger[challenger_correct].eq(0).to_numpy()
        & eligible.to_numpy()
    )
    harmful_margin = attempts[harmful].map(margin).dropna()
    return float(harmful_margin.max()) if not harmful_margin.empty else float("inf")


def safe_two_stage_projection(
    *,
    baseline: pd.DataFrame,
    operations: pd.DataFrame,
    operation_score: pd.Series,
    proposal_top: pd.DataFrame,
    proposal_margin: pd.Series,
    dense_location_top: pd.DataFrame,
    operation_threshold: float | None = None,
    location_threshold: float | None = None,
) -> tuple[pd.DataFrame, dict[str, float]]:
    baseline = ensure_identity_group(baseline).copy()
    operation_score = pd.Series(
        np.asarray(operation_score, dtype=float), index=operations.index
    )
    operation_top = select_top(operations, operation_score, "attempt_id").copy()
    operation_top["_adjudicator_score"] = operation_score.loc[
        operation_top.index
    ].to_numpy()
    challenger = project_locations_into_operations(
        operation_top, proposal_top, dense_location_top
    )
    operation_margin = operation_override_margin(
        operations, operation_score, operation_top, baseline
    )
    baseline_by_attempt = baseline.set_index("attempt_id")
    changed_identity = operation_top["identity_group"].ne(
        operation_top["attempt_id"].map(baseline_by_attempt["identity_group"])
    )
    complete_challenger = (
        ~challenger["event_type"].isin(LOCAL_EVENT_TYPES)
        | pd.to_numeric(
            challenger["selected_candidate_year"], errors="coerce"
        ).notna()
    )
    if operation_threshold is None:
        operation_threshold = calibrate_no_regression_threshold(
            baseline,
            challenger,
            operation_margin,
            baseline_correct="final_correct",
            challenger_correct="final_correct",
            eligible=changed_identity,
        )

    result = baseline.set_index("attempt_id").copy()
    challenger_by_attempt = challenger.set_index("attempt_id")
    operation_accept = (
        changed_identity
        & complete_challenger
        & operation_top["attempt_id"].map(operation_margin).gt(operation_threshold)
    )
    accepted_attempts = operation_top.loc[operation_accept, "attempt_id"]
    common = result.columns.intersection(challenger_by_attempt.columns)
    result.loc[accepted_attempts, common] = challenger_by_attempt.loc[
        accepted_attempts, common
    ]

    baseline_operation = baseline.copy()
    location_challenger = project_locations_into_operations(
        baseline_operation, proposal_top, dense_location_top
    )
    location_by_attempt = location_challenger.set_index("attempt_id")
    local = baseline["event_type"].isin(LOCAL_EVENT_TYPES)
    same_identity_proposal = baseline["identity_group"].eq(
        baseline["attempt_id"].map(
            proposal_top.set_index("attempt_id")["identity_group"]
        )
    )
    moved_window = pd.to_numeric(
        baseline["selected_candidate_year"], errors="coerce"
    ).ne(pd.to_numeric(location_challenger["selected_candidate_year"], errors="coerce"))
    location_eligible = local & same_identity_proposal & moved_window
    if location_threshold is None:
        location_threshold = calibrate_no_regression_threshold(
            baseline,
            location_challenger,
            proposal_margin,
            baseline_correct="final_correct",
            challenger_correct="final_correct",
            eligible=location_eligible,
        )
    operation_accepted_ids = set(accepted_attempts)
    location_accept = (
        location_eligible
        & baseline["attempt_id"].map(proposal_margin).gt(location_threshold)
        & ~baseline["attempt_id"].isin(operation_accepted_ids)
    )
    location_attempts = baseline.loc[location_accept, "attempt_id"]
    result.loc[location_attempts, common] = location_by_attempt.loc[
        location_attempts, common
    ]
    result = result.reset_index()
    result["decision_source"] = "frozen_baseline_package"
    result.loc[result["attempt_id"].isin(accepted_attempts), "decision_source"] = (
        "operation_head_override"
    )
    result.loc[result["attempt_id"].isin(location_attempts), "decision_source"] = (
        "same_identity_location_override"
    )
    result["operation_override_margin_z"] = result["attempt_id"].map(
        operation_margin
    )
    result["location_override_margin_z"] = result["attempt_id"].map(
        proposal_margin
    )
    return result, {
        "operationThresholdZ": float(operation_threshold),
        "locationThresholdZ": float(location_threshold),
        "operationOverrides": int(len(accepted_attempts)),
        "locationOverrides": int(len(location_attempts)),
    }


def train_pair(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
    seed_score: pd.Series,
    seed: int,
    positives: int,
    negatives: int,
):
    pair_values, pair_labels = build_pair_training(
        frame,
        values,
        label=label,
        group=group,
        seed_score=seed_score,
        maximum_positives=positives,
        maximum_negatives=negatives,
    )
    estimator = pair_classifier(seed)
    estimator.fit(pair_values, pair_labels)
    return estimator, len(pair_labels)


def oof_scores(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
    seed_score: pd.Series,
    graded: bool,
    seed: int,
    maximum_positives: int,
    maximum_negatives: int,
    shortlist_size: int,
) -> tuple[np.ndarray, np.ndarray, int]:
    rank_predictions = np.full(len(frame), np.nan, dtype=np.float32)
    pair_predictions = np.full(len(frame), np.nan, dtype=np.float32)
    pair_rows = 0
    splitter = GroupKFold(n_splits=min(5, frame["file_id"].nunique()))
    for fold, (train_index, test_index) in enumerate(
        splitter.split(frame, groups=frame["file_id"])
    ):
        train = frame.iloc[train_index].reset_index(drop=True)
        test = frame.iloc[test_index].reset_index(drop=True)
        train_values = values.iloc[train_index].reset_index(drop=True)
        test_values = values.iloc[test_index].reset_index(drop=True)
        train_seed = seed_score.iloc[train_index].reset_index(drop=True)
        test_seed = seed_score.iloc[test_index].reset_index(drop=True)

        listwise = fit_ranker(
            ranker(seed + fold, graded=graded),
            train,
            train_values,
            label=label,
            group=group,
        )
        fold_rank = listwise.predict(test_values)
        rank_predictions[test_index] = fold_rank
        pairwise, rows = train_pair(
            train,
            train_values,
            label=label,
            group=group,
            seed_score=train_seed,
            seed=seed + 100 + fold,
            positives=maximum_positives,
            negatives=maximum_negatives,
        )
        pair_rows += rows
        rank_percentile = within_group_percentile(test, fold_rank, group)
        shortlist = rank_percentile.mul(0.7).add(test_seed.mul(0.3))
        pair_predictions[test_index] = pair_tournament_scores(
            test,
            test_values,
            pairwise,
            group=group,
            shortlist_score=shortlist,
            shortlist_size=shortlist_size,
        )
    if np.isnan(rank_predictions).any() or np.isnan(pair_predictions).any():
        raise RuntimeError("file-OOF adjudicator left rows without predictions")
    return rank_predictions, pair_predictions, pair_rows


def fit_full_head(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
    seed_score: pd.Series,
    graded: bool,
    seed: int,
    maximum_positives: int,
    maximum_negatives: int,
):
    listwise = fit_ranker(
        ranker(seed, graded=graded), frame, values, label=label, group=group
    )
    pairwise, pair_rows = train_pair(
        frame,
        values,
        label=label,
        group=group,
        seed_score=seed_score,
        seed=seed + 100,
        positives=maximum_positives,
        negatives=maximum_negatives,
    )
    return listwise, pairwise, pair_rows


def blended_percentiles(
    frame: pd.DataFrame,
    rank_predictions: np.ndarray,
    pair_predictions: np.ndarray,
    *,
    group: str,
    weight: float,
) -> pd.Series:
    rank_pct = within_group_percentile(frame, rank_predictions, group)
    pair_pct = within_group_percentile(frame, pair_predictions, group)
    return rank_pct.mul(1 - weight).add(pair_pct.mul(weight))


def select_proposal_weight(
    proposals: pd.DataFrame,
    rank_predictions: np.ndarray,
    pair_predictions: np.ndarray,
) -> tuple[float, pd.Series, pd.DataFrame]:
    rows: list[dict[str, float | int]] = []
    scored: dict[float, pd.Series] = {}
    for weight in BLEND_WEIGHTS:
        score = blended_percentiles(
            proposals,
            rank_predictions,
            pair_predictions,
            group="identity_group",
            weight=float(weight),
        )
        top = select_top(proposals, score, "identity_group")
        scored[float(weight)] = score
        rows.append({
            "pairWeight": float(weight),
            "correct": int(top["proposal_correct"].sum()),
            "packages": len(top),
        })
    grid = pd.DataFrame(rows).sort_values(
        ["correct", "pairWeight"], ascending=[False, True]
    )
    weight = float(grid.iloc[0]["pairWeight"])
    if weight == 0:
        selected_score = pd.Series(rank_predictions, index=proposals.index)
    elif weight == 1:
        selected_score = pd.Series(pair_predictions, index=proposals.index)
    else:
        selected_score = scored[weight]
    return weight, selected_score, grid


def project_decisions(
    operations: pd.DataFrame,
    operation_score: pd.Series,
    locations: pd.DataFrame,
    location_score: pd.Series,
) -> pd.DataFrame:
    operation_top = select_top(operations, operation_score, "attempt_id").copy()
    location_top = select_top(locations, location_score, "identity_group").copy()
    local_operation = operation_top["event_type"].isin(LOCAL_EVENT_TYPES)
    local_top = operation_top[local_operation].copy()
    chosen_location = location_top.set_index("identity_group")
    local_top["selected_package_correct"] = local_top["identity_group"].map(
        chosen_location["workflow_correct"]
    )
    local_top["location_correct"] = local_top["identity_group"].map(
        chosen_location["location_correct"]
    )
    local_top["selected_candidate_source"] = local_top["identity_group"].map(
        chosen_location["candidate_source"]
    )
    local_top["selected_candidate_year"] = local_top["identity_group"].map(
        chosen_location["candidate_year"]
    )
    assert_same_identity_projection(
        local_top,
        chosen_location.loc[
            chosen_location.index.intersection(local_top["identity_group"])
        ].reset_index(),
    )

    selected = operation_top.copy()
    selected["selected_package_correct"] = np.nan
    selected["location_correct"] = np.nan
    selected["selected_candidate_source"] = pd.Series(
        pd.NA, index=selected.index, dtype=object
    )
    selected["selected_candidate_year"] = np.nan
    selected.loc[local_operation, "selected_package_correct"] = local_top[
        "selected_package_correct"
    ].to_numpy()
    selected.loc[local_operation, "location_correct"] = local_top[
        "location_correct"
    ].to_numpy()
    selected.loc[local_operation, "selected_candidate_source"] = local_top[
        "selected_candidate_source"
    ].to_numpy()
    selected.loc[local_operation, "selected_candidate_year"] = local_top[
        "selected_candidate_year"
    ].to_numpy()
    selected["final_correct"] = selected["operation_correct"].astype(np.int8)
    selected.loc[local_operation, "final_correct"] = selected.loc[
        local_operation, "selected_package_correct"
    ].fillna(0).astype(np.int8)
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(
        np.int8
    )
    return selected


def select_blend(
    operations: pd.DataFrame,
    operation_rank: np.ndarray,
    operation_pair: np.ndarray,
    locations: pd.DataFrame,
    location_rank: np.ndarray,
    location_pair: np.ndarray,
) -> tuple[float, float, pd.DataFrame, pd.DataFrame]:
    rows = []
    selected_by_weight: dict[tuple[float, float], pd.DataFrame] = {}
    for operation_weight in BLEND_WEIGHTS:
        operation_score = blended_percentiles(
            operations,
            operation_rank,
            operation_pair,
            group="attempt_id",
            weight=float(operation_weight),
        )
        for location_weight in BLEND_WEIGHTS:
            location_score = blended_percentiles(
                locations,
                location_rank,
                location_pair,
                group="identity_group",
                weight=float(location_weight),
            )
            selected = project_decisions(
                operations, operation_score, locations, location_score
            )
            event = selected[selected["family"].ne("Clean")]
            clean = selected[selected["family"].eq("Clean")]
            clean_false_positives = int(clean["candidate_has_response"].sum())
            key = (float(operation_weight), float(location_weight))
            selected_by_weight[key] = selected
            rows.append({
                "operationPairWeight": key[0],
                "locationPairWeight": key[1],
                "eventCorrect": int(event["final_correct"].sum()),
                "operationCorrect": int(event["operation_correct"].sum()),
                "cleanFalsePositives": clean_false_positives,
            })
    grid = pd.DataFrame(rows)
    eligible = grid[grid["cleanFalsePositives"].le(1)]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["eventCorrect", "operationCorrect", "cleanFalsePositives"],
        ascending=[False, False, True],
    ).iloc[0]
    key = (float(best["operationPairWeight"]), float(best["locationPairWeight"]))
    return key[0], key[1], selected_by_weight[key], grid


def current_comparison(selected: pd.DataFrame, current_path: Path | None) -> dict:
    if current_path is None:
        return {}
    current = pd.read_csv(current_path)[["attempt_id", "final_correct"]].rename(
        columns={"final_correct": "current_correct"}
    )
    joined = selected.merge(current, on="attempt_id", how="left", validate="one_to_one")
    event = joined[joined["family"].ne("Clean")]
    return {
        "currentCorrect": int(event["current_correct"].sum()),
        "correctToWrong": int(
            (event["current_correct"].eq(1) & event["final_correct"].eq(0)).sum()
        ),
        "wrongToCorrect": int(
            (event["current_correct"].eq(0) & event["final_correct"].eq(1)).sum()
        ),
        "correctRetention": float(
            event.loc[event["current_correct"].eq(1), "final_correct"].mean()
        ),
    }


def summarize(
    selected: pd.DataFrame,
    packages: pd.DataFrame,
    *,
    repetitions: int,
    current_path: Path | None,
) -> dict:
    event = selected[selected["family"].ne("Clean")].copy()
    clean = selected[selected["family"].eq("Clean")].copy()
    by_family = {}
    for family, group in event.groupby("family", sort=True):
        by_family[str(family)] = {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "operationAccuracy": float(group["operation_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": cluster_lower(
                group, 92000 + ord(str(family)[0]), repetitions
            ),
        }
    oracle = int(
        packages[packages["family"].ne("Clean")]
        .groupby("attempt_id", sort=False)["workflow_correct"]
        .max()
        .sum()
    )
    summary = {
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "workflowCorrect": int(event["final_correct"].sum()),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "candidateOracleCorrect": oracle,
        "candidateOracleAccuracy": oracle / max(1, len(event)),
        "overallOneSided95FileClusterLower": cluster_lower(
            event, 92999, repetitions
        ),
        "byFamily": by_family,
    }
    summary.update(current_comparison(selected, current_path))
    return summary


def operation_confusion(selected: pd.DataFrame, operations: pd.DataFrame) -> pd.DataFrame:
    correct_types = (
        operations[operations["operation_correct"].eq(1)]
        .groupby("attempt_id", sort=False)["event_type"]
        .agg(lambda values: "|".join(sorted(set(map(str, values)))))
    )
    event = selected[selected["family"].ne("Clean")].copy()
    event["truth_operation_set"] = event["attempt_id"].map(correct_types).fillna("oracle-miss")
    return (
        event.groupby(["truth_operation_set", "event_type"], dropna=False)
        .size()
        .rename("count")
        .reset_index()
        .sort_values("count", ascending=False)
    )


def score_target(
    target_operations: pd.DataFrame,
    target_locations: pd.DataFrame,
    *,
    operation_spec: FeatureSpec,
    location_spec: FeatureSpec,
    operation_ranker,
    operation_pair,
    location_ranker,
    location_pair,
    operation_weight: float,
    location_weight: float,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    operations = prepare_operation(target_operations)
    operation_values = project_relative_features(operations, operation_spec)
    operation_seed = seed_percentile(
        operations, group="attempt_id", columns=OPERATION_SEED
    )
    operation_rank = operation_ranker.predict(operation_values)
    operation_rank_pct = within_group_percentile(
        operations, operation_rank, "attempt_id"
    )
    operation_pair_score = pair_tournament_scores(
        operations,
        operation_values,
        operation_pair,
        group="attempt_id",
        shortlist_score=operation_rank_pct.mul(0.7).add(operation_seed.mul(0.3)),
        shortlist_size=16,
    )
    operation_score = blended_percentiles(
        operations,
        operation_rank,
        operation_pair_score,
        group="attempt_id",
        weight=operation_weight,
    )
    operation_top = select_top(operations, operation_score, "attempt_id")
    local_identities = set(
        operation_top.loc[
            operation_top["event_type"].isin(LOCAL_EVENT_TYPES), "identity_group"
        ]
    )
    locations = prepare_location(target_locations)
    selected_locations = locations[locations["identity_group"].isin(local_identities)].copy()
    if not local_identities.issubset(set(selected_locations["identity_group"])):
        raise RuntimeError("selected local operation has no immutable location package")
    selected_locations = selected_locations.reset_index(drop=True)
    location_values = project_relative_features(selected_locations, location_spec)
    location_seed = seed_percentile(
        selected_locations, group="identity_group", columns=LOCATION_SEED
    )
    location_rank = location_ranker.predict(location_values)
    location_rank_pct = within_group_percentile(
        selected_locations, location_rank, "identity_group"
    )
    location_pair_score = pair_tournament_scores(
        selected_locations,
        location_values,
        location_pair,
        group="identity_group",
        shortlist_score=location_rank_pct.mul(0.7).add(location_seed.mul(0.3)),
        shortlist_size=16,
    )
    location_score = blended_percentiles(
        selected_locations,
        location_rank,
        location_pair_score,
        group="identity_group",
        weight=location_weight,
    )
    # project_decisions expects scores for every operation identity, but only the
    # selected immutable identity is relevant in target prediction.
    selected = operation_top.copy()
    location_top = select_top(selected_locations, location_score, "identity_group")
    local_mask = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    mapped = location_top.set_index("identity_group")
    selected["selected_package_correct"] = np.nan
    selected["location_correct"] = np.nan
    selected["selected_candidate_source"] = pd.Series(
        pd.NA, index=selected.index, dtype=object
    )
    selected["selected_candidate_year"] = np.nan
    selected.loc[local_mask, "selected_package_correct"] = selected.loc[
        local_mask, "identity_group"
    ].map(mapped["workflow_correct"])
    selected.loc[local_mask, "location_correct"] = selected.loc[
        local_mask, "identity_group"
    ].map(mapped["location_correct"])
    selected.loc[local_mask, "selected_candidate_source"] = selected.loc[
        local_mask, "identity_group"
    ].map(mapped["candidate_source"])
    selected.loc[local_mask, "selected_candidate_year"] = selected.loc[
        local_mask, "identity_group"
    ].map(mapped["candidate_year"])
    assert_same_identity_projection(selected[local_mask], location_top)
    selected["final_correct"] = selected["operation_correct"].astype(np.int8)
    selected.loc[local_mask, "final_correct"] = selected.loc[
        local_mask, "selected_package_correct"
    ].fillna(0).astype(np.int8)
    selected["candidate_has_response"] = selected["event_type"].ne("noEvent").astype(
        np.int8
    )
    return selected, operations, selected_locations


def score_target_safe_two_stage(
    target_operations: pd.DataFrame,
    target_locations: pd.DataFrame,
    target_proposals: pd.DataFrame,
    baseline: pd.DataFrame,
    *,
    operation_spec: FeatureSpec,
    location_spec: FeatureSpec,
    proposal_spec: FeatureSpec,
    operation_ranker,
    location_ranker,
    proposal_ranker,
    operation_weight: float,
    location_weight: float,
    proposal_weight: float,
    safety_calibration: dict[str, float],
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, float]]:
    if any(weight != 0 for weight in (
        operation_weight, location_weight, proposal_weight
    )):
        raise RuntimeError(
            "safe target inference currently requires the frozen listwise heads"
        )
    operations = prepare_operation(target_operations)
    operation_values = project_relative_features(operations, operation_spec)
    operation_score = pd.Series(
        operation_ranker.predict(operation_values), index=operations.index
    )
    operation_top = select_top(operations, operation_score, "attempt_id")

    proposals = prepare_proposals(target_proposals)
    proposal_values = project_relative_features(proposals, proposal_spec)
    proposal_score = pd.Series(
        proposal_ranker.predict(proposal_values), index=proposals.index
    )
    proposal_top, proposal_identity_margin = top_with_standardized_margin(
        proposals, proposal_score, group="identity_group"
    )
    proposal_margin = pd.Series(
        proposal_top["identity_group"].map(proposal_identity_margin).to_numpy(),
        index=proposal_top["attempt_id"],
    )

    baseline = ensure_identity_group(baseline)
    needed_identities = set(
        operation_top.loc[
            operation_top["event_type"].isin(LOCAL_EVENT_TYPES), "identity_group"
        ]
    ) | set(
        baseline.loc[
            baseline["event_type"].isin(LOCAL_EVENT_TYPES), "identity_group"
        ]
    )
    locations = prepare_location(target_locations)
    selected_locations = locations[
        locations["identity_group"].isin(needed_identities)
    ].reset_index(drop=True)
    if selected_locations.empty:
        dense_location_top = pd.DataFrame(columns=[
            "identity_group",
            "workflow_correct",
            "location_correct",
            "candidate_source",
            "candidate_year",
        ])
    else:
        location_values = project_relative_features(
            selected_locations, location_spec
        )
        location_score = pd.Series(
            location_ranker.predict(location_values), index=selected_locations.index
        )
        dense_location_top = select_top(
            selected_locations, location_score, "identity_group"
        )

    selected, runtime_safety = safe_two_stage_projection(
        baseline=baseline,
        operations=operations,
        operation_score=operation_score,
        proposal_top=proposal_top,
        proposal_margin=proposal_margin,
        dense_location_top=dense_location_top,
        operation_threshold=float(safety_calibration["operationThresholdZ"]),
        location_threshold=float(safety_calibration["locationThresholdZ"]),
    )
    return selected, operations, runtime_safety


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-operation-scores", required=True)
    parser.add_argument("--development-location-scores", required=True)
    parser.add_argument("--development-current-top")
    parser.add_argument(
        "--development-location-anchor",
        action="append",
        default=[],
        metavar="NAME=CSV_PATH",
    )
    parser.add_argument("--development-location-proposals")
    parser.add_argument("--target-operation-scores")
    parser.add_argument("--target-location-scores")
    parser.add_argument("--target-current-top")
    parser.add_argument(
        "--target-location-anchor",
        action="append",
        default=[],
        metavar="NAME=CSV_PATH",
    )
    parser.add_argument("--target-location-proposals")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-operation-features", type=int, default=192)
    parser.add_argument("--maximum-location-features", type=int, default=224)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_operation_path = Path(args.development_operation_scores).resolve()
    development_location_path = Path(args.development_location_scores).resolve()
    operations = prepare_operation(pd.read_pickle(development_operation_path))
    base_packages = prepare_location(pd.read_pickle(development_location_path))
    packages = base_packages
    development_proposal_path = (
        Path(args.development_location_proposals).resolve()
        if args.development_location_proposals
        else None
    )
    development_proposals = None
    if development_proposal_path is not None:
        development_proposals = prepare_proposals(
            pd.read_pickle(development_proposal_path)
        )
        packages = append_frozen_proposal_packages(
            packages, development_proposals
        )
    development_anchor_paths = parse_anchor_paths(
        args.development_location_anchor
    )
    packages, anchor_features = add_location_proposal_anchors(
        packages, load_anchor_tables(development_anchor_paths)
    )

    operation_spec = make_feature_spec(
        operations,
        group_column="attempt_id",
        maximum_numeric=args.maximum_operation_features,
        categorical_columns=("event_type",),
        preferred_numeric=OPERATION_PREFERRED,
    )
    operation_values = project_relative_features(operations, operation_spec)
    operation_seed = seed_percentile(
        operations, group="attempt_id", columns=OPERATION_SEED
    )
    operation_rank, operation_pair_score, operation_pair_rows = oof_scores(
        operations,
        operation_values,
        label="operation_correct",
        group="attempt_id",
        seed_score=operation_seed,
        graded=False,
        seed=90000,
        maximum_positives=4,
        maximum_negatives=10,
        shortlist_size=16,
    )

    proposal_spec = None
    proposal_values = None
    proposal_seed = None
    proposal_rank = None
    proposal_pair_score = None
    proposal_pair_rows = 0
    proposal_weight = 0.0
    proposal_score = None
    proposal_grid = pd.DataFrame()
    if development_proposals is not None:
        proposal_spec = make_feature_spec(
            development_proposals,
            group_column="identity_group",
            maximum_numeric=64,
            categorical_columns=("event_type", "candidate_source", "proposal_role"),
            preferred_numeric=PROPOSAL_PREFERRED,
        )
        proposal_values = project_relative_features(
            development_proposals, proposal_spec
        )
        proposal_seed = seed_percentile(
            development_proposals,
            group="identity_group",
            columns=(
                "proposal_score",
                "proposal_support_within_0",
                "proposal_support_within_1",
                "proposal_support_within_2",
                "proposal_support_within_4",
                "proposal_support_within_6",
            ),
        )
        proposal_rank, proposal_pair_score, proposal_pair_rows = oof_scores(
            development_proposals,
            proposal_values,
            label="location_relevance",
            group="identity_group",
            seed_score=proposal_seed,
            graded=True,
            seed=95000,
            maximum_positives=3,
            maximum_negatives=3,
            shortlist_size=3,
        )
        proposal_weight, proposal_score, proposal_grid = select_proposal_weight(
            development_proposals, proposal_rank, proposal_pair_score
        )

    location_training = packages[
        packages["identity_operation_correct"].eq(1)
        & packages["event_type"].isin(LOCAL_EVENT_TYPES)
    ].reset_index(drop=True)
    location_spec = make_feature_spec(
        location_training,
        group_column="identity_group",
        maximum_numeric=args.maximum_location_features,
        categorical_columns=("event_type", "candidate_source", "proposal_role"),
        preferred_numeric=(
            *LOCATION_PREFERRED,
            *PROPOSAL_PREFERRED,
            *anchor_features,
        ),
    )
    location_values = project_relative_features(location_training, location_spec)
    location_seed = seed_percentile(
        location_training, group="identity_group", columns=LOCATION_SEED
    )
    location_rank, location_pair_score, location_pair_rows = oof_scores(
        location_training,
        location_values,
        label="location_relevance",
        group="identity_group",
        seed_score=location_seed,
        graded=True,
        seed=91000,
        maximum_positives=3,
        maximum_negatives=12,
        shortlist_size=16,
    )

    operation_weight, location_weight, dense_selected, grid = select_blend(
        operations,
        operation_rank,
        operation_pair_score,
        location_training,
        location_rank,
        location_pair_score,
    )
    development_current = (
        Path(args.development_current_top).resolve()
        if args.development_current_top
        else None
    )
    safety = {}
    selected = dense_selected
    if development_current is not None and development_proposals is not None:
        baseline = pd.read_csv(development_current)
        operation_score = (
            pd.Series(operation_rank, index=operations.index)
            if operation_weight == 0
            else pd.Series(operation_pair_score, index=operations.index)
            if operation_weight == 1
            else blended_percentiles(
                operations,
                operation_rank,
                operation_pair_score,
                group="attempt_id",
                weight=operation_weight,
            )
        )
        dense_location_score = blended_percentiles(
            location_training,
            location_rank,
            location_pair_score,
            group="identity_group",
            weight=location_weight,
        )
        dense_location_top = select_top(
            location_training, dense_location_score, "identity_group"
        )
        proposal_top, proposal_identity_margin = top_with_standardized_margin(
            development_proposals, proposal_score, group="identity_group"
        )
        proposal_margin = pd.Series(
            proposal_top["identity_group"].map(proposal_identity_margin).to_numpy(),
            index=proposal_top["attempt_id"],
        )
        selected, safety = safe_two_stage_projection(
            baseline=baseline,
            operations=operations,
            operation_score=operation_score,
            proposal_top=proposal_top,
            proposal_margin=proposal_margin,
            dense_location_top=dense_location_top,
        )
    oof_summary = summarize(
        selected,
        packages,
        repetitions=args.bootstrap_repetitions,
        current_path=development_current,
    )
    oof_summary.update({
        "schemaVersion": 1,
        "modelType": "immutable_two_stage_safe_listwise_pairwise",
        "files": int(operations["file_id"].nunique()),
        "operationIdentities": len(operations),
        "locationTrainingPackages": len(location_training),
        "operationInputFeatures": len(operation_spec.numeric_columns),
        "operationProjectedFeatures": operation_values.shape[1],
        "locationInputFeatures": len(location_spec.numeric_columns),
        "locationProjectedFeatures": location_values.shape[1],
        "operationPairRows": operation_pair_rows,
        "locationPairRows": location_pair_rows,
        "proposalPairRows": proposal_pair_rows,
        "operationPairWeight": operation_weight,
        "locationPairWeight": location_weight,
        "proposalPairWeight": proposal_weight,
        "safetyCalibration": safety,
        "candidateGeneratorFrozen": True,
        "candidatePackageSha256": sha256(development_location_path),
        "baseCandidateOracleCorrect": int(
            base_packages[base_packages["family"].ne("Clean")]
            .groupby("attempt_id", sort=False)["workflow_correct"]
            .max()
            .sum()
        ),
        "frozenProposalPackageSha256": (
            sha256(development_proposal_path)
            if development_proposal_path is not None
            else None
        ),
        "proposalAnchorSha256": {
            name: sha256(path)
            for name, path in development_anchor_paths.items()
        },
        "rawScoresExposedToModels": False,
        "fileIsolatedOof": True,
    })
    selected.to_csv(output_dir / "development-oof-top.csv", index=False)
    dense_selected.to_csv(
        output_dir / "development-oof-dense-head-top.csv", index=False
    )
    grid.to_csv(output_dir / "development-oof-blend-grid.csv", index=False)
    if not proposal_grid.empty:
        proposal_grid.to_csv(
            output_dir / "development-oof-proposal-blend-grid.csv", index=False
        )
    operation_confusion(selected, operations).to_csv(
        output_dir / "development-oof-operation-confusion.csv", index=False
    )
    write_json(output_dir / "development-oof-summary.json", oof_summary)

    operation_model, operation_pair_model, _ = fit_full_head(
        operations,
        operation_values,
        label="operation_correct",
        group="attempt_id",
        seed_score=operation_seed,
        graded=False,
        seed=93000,
        maximum_positives=4,
        maximum_negatives=10,
    )
    location_model, location_pair_model, _ = fit_full_head(
        location_training,
        location_values,
        label="location_relevance",
        group="identity_group",
        seed_score=location_seed,
        graded=True,
        seed=94000,
        maximum_positives=3,
        maximum_negatives=12,
    )
    proposal_model = None
    proposal_pair_model = None
    if development_proposals is not None:
        proposal_model, proposal_pair_model, _ = fit_full_head(
            development_proposals,
            proposal_values,
            label="location_relevance",
            group="identity_group",
            seed_score=proposal_seed,
            graded=True,
            seed=96000,
            maximum_positives=3,
            maximum_negatives=3,
        )
    joblib.dump(
        {
            "operationRanker": operation_model,
            "operationPair": operation_pair_model,
            "locationRanker": location_model,
            "locationPair": location_pair_model,
            "proposalRanker": proposal_model,
            "proposalPair": proposal_pair_model,
            "operationSpec": operation_spec,
            "locationSpec": location_spec,
            "proposalSpec": proposal_spec,
            "operationPairWeight": operation_weight,
            "locationPairWeight": location_weight,
            "proposalPairWeight": proposal_weight,
            "safetyCalibration": safety,
            "proposalAnchorNames": tuple(development_anchor_paths),
        },
        output_dir / "shadow-model.joblib",
        compress=3,
    )
    write_json(output_dir / "feature-contract.json", {
        "schemaVersion": 1,
        "operation": operation_spec.to_json(),
        "location": location_spec.to_json(),
        "proposal": proposal_spec.to_json() if proposal_spec is not None else None,
        "forbidden": [
            "file_id", "series_id", "family", "truth_*", "candidate_year"
        ],
        "identityContract": (
            "location(event_type,shift_years) == operation(event_type,shift_years)"
        ),
    })

    result = {"outputDir": str(output_dir), "developmentOof": oof_summary}
    if bool(args.target_operation_scores) != bool(args.target_location_scores):
        raise RuntimeError("target operation and location tables must be supplied together")
    if args.target_operation_scores:
        target_operation_path = Path(args.target_operation_scores).resolve()
        target_location_path = Path(args.target_location_scores).resolve()
        target_anchor_paths = parse_anchor_paths(args.target_location_anchor)
        if set(target_anchor_paths) != set(development_anchor_paths):
            raise RuntimeError(
                "target proposal anchor names must match development anchors"
            )
        target_packages = prepare_location(pd.read_pickle(target_location_path))
        target_proposal_path = (
            Path(args.target_location_proposals).resolve()
            if args.target_location_proposals
            else None
        )
        if bool(target_proposal_path) != bool(development_proposal_path):
            raise RuntimeError(
                "target frozen proposal table must match development configuration"
            )
        target_proposals = None
        if target_proposal_path is not None:
            target_proposals = prepare_proposals(
                pd.read_pickle(target_proposal_path)
            )
            target_packages = append_frozen_proposal_packages(
                target_packages, target_proposals
            )
        target_packages, _ = add_location_proposal_anchors(
            target_packages, load_anchor_tables(target_anchor_paths)
        )
        target_current = (
            Path(args.target_current_top).resolve() if args.target_current_top else None
        )
        if (
            target_current is not None
            and target_proposals is not None
            and proposal_model is not None
        ):
            target_selected, target_operations, target_runtime_safety = (
                score_target_safe_two_stage(
                    pd.read_pickle(target_operation_path),
                    target_packages,
                    target_proposals,
                    pd.read_csv(target_current),
                    operation_spec=operation_spec,
                    location_spec=location_spec,
                    proposal_spec=proposal_spec,
                    operation_ranker=operation_model,
                    location_ranker=location_model,
                    proposal_ranker=proposal_model,
                    operation_weight=operation_weight,
                    location_weight=location_weight,
                    proposal_weight=proposal_weight,
                    safety_calibration=safety,
                )
            )
        else:
            target_selected, target_operations, _ = score_target(
                pd.read_pickle(target_operation_path),
                target_packages,
                operation_spec=operation_spec,
                location_spec=location_spec,
                operation_ranker=operation_model,
                operation_pair=operation_pair_model,
                location_ranker=location_model,
                location_pair=location_pair_model,
                operation_weight=operation_weight,
                location_weight=location_weight,
            )
            target_runtime_safety = {}
        target_summary = summarize(
            target_selected,
            target_packages,
            repetitions=args.bootstrap_repetitions,
            current_path=target_current,
        )
        target_summary.update({
            "schemaVersion": 1,
            "modelType": "immutable_two_stage_safe_listwise_pairwise",
            "files": int(target_selected["file_id"].nunique()),
            "candidateGeneratorFrozen": True,
            "candidatePackageSha256": sha256(target_location_path),
            "frozenProposalPackageSha256": (
                sha256(target_proposal_path)
                if target_proposal_path is not None
                else None
            ),
            "proposalAnchorSha256": {
                name: sha256(path) for name, path in target_anchor_paths.items()
            },
            "operationPairWeight": operation_weight,
            "locationPairWeight": location_weight,
            "proposalPairWeight": proposal_weight,
            "safetyCalibration": safety,
            "runtimeSafety": target_runtime_safety,
            "trainingCallsOnTarget": 0,
            "truthAwareRuntimeSwitches": 0,
        })
        target_selected.to_csv(output_dir / "target-shadow-top.csv", index=False)
        operation_confusion(target_selected, target_operations).to_csv(
            output_dir / "target-operation-confusion.csv", index=False
        )
        write_json(output_dir / "target-summary.json", target_summary)
        result["target"] = target_summary
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
