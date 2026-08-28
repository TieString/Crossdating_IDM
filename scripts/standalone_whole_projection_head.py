"""Shared whole-series projection competition for the standalone model."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd


WHOLE_SOURCE_COLUMN = "source_count_wholeProjection"
SCORE_COLUMN = "operation_meta_score"


def clean_mask(frame: pd.DataFrame) -> pd.Series:
    if "is_clean" in frame:
        return frame["is_clean"].fillna(False).astype(bool)
    if "family" in frame:
        return frame["family"].astype(str).eq("Clean")
    raise ValueError("frame must contain is_clean or family")


def identity_group(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["attempt_id"].astype(str)
        + "|" + frame["event_type"].astype(str)
        + "|" + pd.to_numeric(frame["shift_years"]).astype(int).astype(str)
    )


def load_whole_labels(paths: list[Path]) -> pd.DataFrame:
    labels: list[pd.DataFrame] = []
    wanted = [
        "attempt_id", "event_type", "shift_years", "candidate_source",
        "workflow_correct", "strict_correct", "candidate_has_response",
    ]
    for path in paths:
        table = pd.read_pickle(path)
        table = table.loc[
            table["candidate_source"].eq("wholeProjection"), wanted
        ].copy()
        if table.empty:
            continue
        table["identity_group"] = identity_group(table)
        labels.append(
            table.groupby(["attempt_id", "identity_group"], as_index=False).agg(
                whole_workflow_correct=("workflow_correct", "max"),
                whole_strict_correct=("strict_correct", "max"),
                whole_candidate_has_response=("candidate_has_response", "max"),
            )
        )
    if not labels:
        return pd.DataFrame(columns=[
            "attempt_id", "identity_group", "whole_workflow_correct",
            "whole_strict_correct", "whole_candidate_has_response",
        ])
    return pd.concat(labels, ignore_index=True)


def build_competition(
    base: pd.DataFrame,
    operations: pd.DataFrame,
    whole_labels: pd.DataFrame,
) -> pd.DataFrame:
    required = {
        "attempt_id", "identity_group", "event_type", "shift_years",
        "operation_correct", SCORE_COLUMN, WHOLE_SOURCE_COLUMN,
    }
    missing = required.difference(operations.columns)
    if missing:
        raise ValueError(f"operation scores missing columns: {sorted(missing)}")
    base_keys = base[["attempt_id", "identity_group"]].copy()
    base_rows = base_keys.merge(
        operations[[
            "attempt_id", "identity_group", "operation_correct", SCORE_COLUMN,
        ]],
        on=["attempt_id", "identity_group"],
        how="left",
        validate="one_to_one",
    ).rename(columns={
        "identity_group": "base_identity_group",
        "operation_correct": "base_operation_correct",
        SCORE_COLUMN: "base_operation_score",
    })
    if base_rows["base_operation_score"].isna().any():
        attempts = base_rows.loc[
            base_rows["base_operation_score"].isna(), "attempt_id"
        ].head(5).tolist()
        raise ValueError(f"base identities missing operation scores: {attempts}")

    whole = operations.loc[
        operations["event_type"].eq("wholeSeriesMove")
        & operations[WHOLE_SOURCE_COLUMN].fillna(0).gt(0)
        & pd.to_numeric(operations["shift_years"]).lt(0)
    ].sort_values(
        ["attempt_id", SCORE_COLUMN], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    whole = whole.merge(
        whole_labels,
        on=["attempt_id", "identity_group"],
        how="left",
        validate="one_to_one",
    )
    whole = whole.rename(columns={
        "identity_group": "whole_identity_group",
        "event_type": "whole_event_type",
        "shift_years": "whole_shift_years",
        "operation_correct": "whole_operation_correct",
        SCORE_COLUMN: "whole_operation_score",
    })
    wanted = [
        "attempt_id", "whole_identity_group", "whole_event_type",
        "whole_shift_years", "whole_operation_correct",
        "whole_operation_score", "whole_workflow_correct",
        "whole_strict_correct", "whole_candidate_has_response",
    ]
    competition = base_rows.merge(
        whole[wanted], on="attempt_id", how="left", validate="one_to_one"
    )
    competition["whole_score_margin"] = (
        competition["whole_operation_score"]
        - competition["base_operation_score"]
    )
    return competition


def apply_threshold(
    base: pd.DataFrame,
    competition: pd.DataFrame,
    threshold: float,
) -> pd.DataFrame:
    result = base.merge(
        competition,
        on="attempt_id",
        how="left",
        validate="one_to_one",
        suffixes=("", "_gate"),
    )
    switched = (
        result["whole_identity_group"].notna()
        & result["whole_score_margin"].ge(float(threshold))
    )
    result["whole_projection_switched"] = switched.astype(int)
    result["whole_projection_threshold"] = float(threshold)
    result["pre_gate_identity_group"] = result["identity_group"]
    result["pre_gate_event_type"] = result["event_type"]
    result["pre_gate_shift_years"] = result["shift_years"]

    replacements = {
        "identity_group": "whole_identity_group",
        "event_type": "whole_event_type",
        "shift_years": "whole_shift_years",
        "operation_correct": "whole_operation_correct",
        "location_correct": "whole_operation_correct",
        "selected_package_correct": "whole_workflow_correct",
        "final_correct": "whole_workflow_correct",
        "final_strict_correct": "whole_strict_correct",
        "strict_correct": "whole_strict_correct",
        "candidate_has_response": "whole_candidate_has_response",
    }
    for destination, source in replacements.items():
        if destination in result.columns and source in result.columns:
            result.loc[switched, destination] = result.loc[switched, source]
    if "selected_candidate_source" in result.columns:
        result.loc[switched, "selected_candidate_source"] = "wholeProjection"
    if "selected_candidate_year" in result.columns:
        result.loc[switched, "selected_candidate_year"] = np.nan
    if "selected_proposal_role" in result.columns:
        result.loc[switched, "selected_proposal_role"] = (
            "whole_projection_operation_head"
        )
    return result


def calibrate_threshold(
    base: pd.DataFrame,
    competition: pd.DataFrame,
    step: float = 0.05,
    max_clean_false_positives: int = 1,
) -> tuple[float, pd.DataFrame]:
    if step <= 0:
        raise ValueError("threshold step must be positive")
    margins = competition["whole_score_margin"].dropna()
    if margins.empty:
        raise ValueError("no whole projection candidates")
    lower = np.floor(margins.min() / step) * step
    upper = np.ceil(margins.max() / step) * step + step
    rows: list[dict[str, float | int]] = []
    base_correct = base["final_correct"].fillna(0).astype(bool)
    is_clean = clean_mask(base)
    for threshold in np.arange(lower, upper + step / 2, step):
        selected = apply_threshold(base, competition, float(threshold))
        selected_correct = selected["final_correct"].fillna(0).astype(bool)
        selected_response = selected["candidate_has_response"].fillna(0).astype(bool)
        event = ~is_clean
        rows.append({
            "threshold": float(round(threshold, 10)),
            "switches": int(selected["whole_projection_switched"].sum()),
            "wrong_to_correct": int(
                ((~base_correct) & selected_correct & event).sum()
            ),
            "correct_to_wrong": int(
                (base_correct & (~selected_correct) & event).sum()
            ),
            "wrong_to_wrong_switches": int(
                ((~base_correct) & (~selected_correct) & event
                 & selected["whole_projection_switched"].astype(bool)).sum()
            ),
            "clean_false_positives": int((selected_response & is_clean).sum()),
        })
    audit = pd.DataFrame(rows)
    safe = audit.loc[
        audit["correct_to_wrong"].eq(0)
        & audit["clean_false_positives"].le(max_clean_false_positives)
    ].copy()
    if safe.empty:
        raise RuntimeError("no threshold satisfies the safety constraints")
    safe = safe.sort_values(
        ["wrong_to_correct", "wrong_to_wrong_switches", "switches", "threshold"],
        ascending=[False, True, True, False],
    )
    return float(safe.iloc[0]["threshold"]), audit


def clustered_lower(
    selected: pd.DataFrame,
    seed: int,
    repetitions: int,
) -> float:
    if selected.empty:
        return float("nan")
    cluster_column = "cluster_id" if "cluster_id" in selected else "file_id"
    files = np.array(sorted(selected[cluster_column].astype(str).unique()))
    grouped = {
        file_id: selected.loc[
            selected[cluster_column].astype(str).eq(file_id), "final_correct"
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


def summarize(
    selected: pd.DataFrame,
    base: pd.DataFrame,
    repetitions: int,
) -> dict[str, object]:
    is_clean = clean_mask(selected)
    event = selected.loc[~is_clean].copy()
    clean = selected.loc[is_clean].copy()
    baseline = base.set_index("attempt_id")["final_correct"].astype(bool)
    before = event["attempt_id"].map(baseline).fillna(False).astype(bool)
    after = event["final_correct"].fillna(0).astype(bool)
    response = event["candidate_has_response"].fillna(0).astype(bool)
    strict_column = (
        "final_strict_correct"
        if "final_strict_correct" in event
        else "strict_correct"
    )
    by_family: dict[str, object] = {}
    for family, group in event.groupby("family", sort=True):
        by_family[str(family)] = {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group[strict_column].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": clustered_lower(
                group, 151000 + ord(str(family)[0]), repetitions
            ),
        }
    clean_response = clean["candidate_has_response"].fillna(0).astype(bool)
    return {
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "workflowCorrect": int(after.sum()),
        "workflowAccuracy": float(after.mean()),
        "strictAccuracy": float(event[strict_column].mean()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(response.mean()),
        "refusalRate": float(1 - response.mean()),
        "cleanFalsePositives": int(clean_response.sum()),
        "correctToWrong": int((before & ~after).sum()),
        "wrongToCorrect": int((~before & after).sum()),
        "correctRetention": float(after[before].mean()) if before.any() else 1.0,
        "wholeProjectionSwitches": int(
            selected["whole_projection_switched"].sum()
        ),
        "overallOneSided95FileClusterLower": clustered_lower(
            event, 151999, repetitions
        ),
        "byFamily": by_family,
    }
