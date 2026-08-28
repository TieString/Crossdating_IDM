"""Pairwise operation transition calibration for the standalone model."""

from __future__ import annotations

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def build_competition(
    base: pd.DataFrame,
    operations: pd.DataFrame,
    identity_locations: pd.DataFrame,
) -> pd.DataFrame:
    base_scores = base[["attempt_id", "identity_group"]].merge(
        operations[[
            "attempt_id", "identity_group", "operation_meta_score",
        ]],
        on=["attempt_id", "identity_group"],
        how="left",
        validate="one_to_one",
    ).rename(columns={
        "identity_group": "base_identity_group",
        "operation_meta_score": "base_operation_score",
    })
    if base_scores["base_operation_score"].isna().any():
        missing = base_scores.loc[
            base_scores["base_operation_score"].isna(), "attempt_id"
        ].head(5).tolist()
        raise ValueError(f"base operation scores missing: {missing}")
    challenger = (
        operations.sort_values(
            ["attempt_id", "operation_meta_score"], ascending=[True, False]
        )
        .groupby("attempt_id", sort=False)
        .head(1)[[
            "attempt_id", "identity_group", "event_type", "shift_years",
            "operation_correct", "operation_meta_score",
        ]]
        .copy()
        .rename(columns={
            "identity_group": "challenger_identity_group",
            "event_type": "challenger_event_type",
            "shift_years": "challenger_shift_years",
            "operation_correct": "challenger_operation_correct",
            "operation_meta_score": "challenger_operation_score",
        })
    )
    location_columns = [
        column for column in (
            "identity_group", "candidate_source", "candidate_year",
            "candidate_has_response", "workflow_correct", "strict_correct",
            "identity_location_score",
        )
        if column in identity_locations
    ]
    locations = identity_locations[location_columns].rename(columns={
        "identity_group": "challenger_identity_group",
        "candidate_source": "challenger_candidate_source",
        "candidate_year": "challenger_candidate_year",
        "candidate_has_response": "challenger_location_has_response",
        "workflow_correct": "challenger_location_workflow_correct",
        "strict_correct": "challenger_location_strict_correct",
        "identity_location_score": "challenger_location_score",
    })
    challenger = challenger.merge(
        locations,
        on="challenger_identity_group",
        how="left",
        validate="one_to_one",
    )
    local = challenger["challenger_event_type"].isin(LOCAL_EVENT_TYPES)
    challenger["challenger_final_correct"] = challenger[
        "challenger_operation_correct"
    ].fillna(0).astype(int)
    challenger["challenger_strict_correct"] = challenger[
        "challenger_operation_correct"
    ].fillna(0).astype(int)
    challenger.loc[local, "challenger_final_correct"] = challenger.loc[
        local, "challenger_location_workflow_correct"
    ].fillna(0).astype(int)
    challenger.loc[local, "challenger_strict_correct"] = challenger.loc[
        local, "challenger_location_strict_correct"
    ].fillna(0).astype(int)
    challenger["challenger_has_response"] = challenger[
        "challenger_event_type"
    ].ne("noEvent").astype(int)
    competition = base_scores.merge(
        challenger, on="attempt_id", how="left", validate="one_to_one"
    )
    base_types = base.set_index("attempt_id")["event_type"]
    competition["base_event_type"] = competition["attempt_id"].map(base_types)
    competition["operation_transition"] = (
        competition["base_event_type"].astype(str)
        + ">" + competition["challenger_event_type"].astype(str)
    )
    competition["operation_score_margin"] = (
        competition["challenger_operation_score"]
        - competition["base_operation_score"]
    )
    competition["identity_changed"] = competition[
        "base_identity_group"
    ].ne(competition["challenger_identity_group"])
    return competition


def calibrate_policies(
    base: pd.DataFrame,
    competition: pd.DataFrame,
    minimum_fixes: int = 1,
) -> tuple[list[dict[str, object]], pd.DataFrame]:
    base_correct = base.set_index("attempt_id")["final_correct"].astype(bool)
    rows: list[dict[str, object]] = []
    policies: list[dict[str, object]] = []
    changed = competition.loc[competition["identity_changed"]].copy()
    for transition, group in changed.groupby("operation_transition", sort=True):
        before = group["attempt_id"].map(base_correct).fillna(False).astype(bool)
        challenger = group["challenger_final_correct"].fillna(0).astype(bool)
        candidates: list[dict[str, object]] = []
        for threshold in sorted(group["operation_score_margin"].dropna().unique()):
            switched = group["operation_score_margin"].ge(float(threshold))
            record = {
                "operationTransition": str(transition),
                "minimumScoreMargin": float(threshold),
                "switches": int(switched.sum()),
                "wrongToCorrect": int((switched & ~before & challenger).sum()),
                "correctToWrong": int((switched & before & ~challenger).sum()),
                "wrongToWrong": int((switched & ~before & ~challenger).sum()),
                "correctToCorrect": int((switched & before & challenger).sum()),
            }
            rows.append(record)
            if (
                record["correctToWrong"] == 0
                and record["wrongToCorrect"] >= minimum_fixes
            ):
                candidates.append(record)
        if not candidates:
            continue
        best = sorted(
            candidates,
            key=lambda row: (
                -int(row["wrongToCorrect"]),
                int(row["wrongToWrong"]),
                int(row["switches"]),
                -float(row["minimumScoreMargin"]),
            ),
        )[0]
        policies.append(best)
    return policies, pd.DataFrame(rows)


def apply_policies(
    base: pd.DataFrame,
    competition: pd.DataFrame,
    policies: list[dict[str, object]],
) -> pd.DataFrame:
    result = base.merge(
        competition,
        on="attempt_id",
        how="left",
        validate="one_to_one",
        suffixes=("", "_transition"),
    )
    thresholds = {
        str(policy["operationTransition"]): float(policy["minimumScoreMargin"])
        for policy in policies
    }
    required = result["operation_transition"].map(thresholds)
    switched = (
        result["identity_changed"].fillna(False).astype(bool)
        & required.notna()
        & result["operation_score_margin"].ge(required)
    )
    result["operation_transition_switched"] = switched.astype(int)
    result["pre_transition_identity_group"] = result["identity_group"]
    result["pre_transition_event_type"] = result["event_type"]
    result["pre_transition_shift_years"] = result["shift_years"]
    replacements = {
        "identity_group": "challenger_identity_group",
        "event_type": "challenger_event_type",
        "shift_years": "challenger_shift_years",
        "operation_correct": "challenger_operation_correct",
        "final_correct": "challenger_final_correct",
        "final_strict_correct": "challenger_strict_correct",
        "strict_correct": "challenger_strict_correct",
        "candidate_has_response": "challenger_has_response",
        "selected_candidate_source": "challenger_candidate_source",
        "selected_candidate_year": "challenger_candidate_year",
    }
    for destination, source in replacements.items():
        if destination in result and source in result:
            result.loc[switched, destination] = result.loc[switched, source]
    if "selected_proposal_role" in result:
        result.loc[switched, "selected_proposal_role"] = (
            "pairwise_operation_transition_head"
        )
    return result
