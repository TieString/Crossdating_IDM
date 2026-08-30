#!/usr/bin/env python3
"""Prepare truth-blind top operation identities for residual evaluation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def choose_operation_shortlist(
    scores: pd.DataFrame,
    locations: pd.DataFrame,
    identity_metadata: pd.DataFrame,
    top_count: int,
    maximum_attempts: int | None = None,
) -> pd.DataFrame:
    required_scores = {
        "identity_group", "meta_oof_score", "pair_oof_score",
        "selection_oof_score",
    }
    if missing := sorted(required_scores - set(scores.columns)):
        raise ValueError(f"operation scores missing columns: {missing}")
    required_locations = {"attempt_id", "event_type", "shift_years"}
    if missing := sorted(required_locations - set(locations.columns)):
        raise ValueError(f"location scores missing columns: {missing}")
    year_column = "year" if "year" in locations else "candidate_year"
    if year_column not in locations:
        raise ValueError("location scores miss year/candidate_year")
    if {"pairwise_score", "listwise_score"}.issubset(locations.columns):
        location_score_columns = ("pairwise_score", "listwise_score")
    elif "location_score" in locations:
        location_score_columns = ("location_score",)
    else:
        raise ValueError("location scores miss frozen ranking columns")
    required_metadata = {
        "identity_group", "attempt_id", "file_id", "family", "event_type",
        "shift_years",
    }
    if missing := sorted(required_metadata - set(identity_metadata.columns)):
        raise ValueError(f"identity metadata missing columns: {missing}")

    ranked = scores.copy()
    ranked["attempt_id"] = ranked["identity_group"].str.rsplit(
        "|", n=2
    ).str[0]
    if maximum_attempts is not None:
        attempts = sorted(ranked["attempt_id"].unique())[:maximum_attempts]
        ranked = ranked[ranked["attempt_id"].isin(attempts)].copy()
    ranked = ranked.sort_values(
        ["attempt_id", "selection_oof_score", "meta_oof_score"],
        ascending=[True, False, False],
        kind="mergesort",
    ).groupby("attempt_id", sort=False).head(top_count)
    metadata = identity_metadata[list(required_metadata)].drop_duplicates(
        "identity_group"
    )
    ranked = ranked.merge(
        metadata,
        on=["identity_group", "attempt_id"],
        how="left",
        validate="one_to_one",
    )
    if ranked["file_id"].isna().any():
        raise RuntimeError("top operation identity misses file metadata")

    local = locations.copy()
    local["identity_group"] = (
        local["attempt_id"].astype(str)
        + "|" + local["event_type"].astype(str)
        + "|" + local["shift_years"].astype(int).astype(str)
    )
    local = local[local["identity_group"].isin(set(ranked["identity_group"]))]
    local = local[pd.to_numeric(local[year_column], errors="coerce").notna()]
    local = local.sort_values(
        ["identity_group", *location_score_columns, year_column],
        ascending=[True, *([False] * len(location_score_columns)), False],
        kind="mergesort",
    ).drop_duplicates("identity_group")
    year_by_identity = local.set_index("identity_group")[year_column]
    ranked["year"] = ranked["identity_group"].map(year_by_identity)
    is_local = ranked["event_type"].isin(LOCAL_EVENT_TYPES)
    if ranked.loc[is_local, "year"].isna().any():
        raise RuntimeError("local operation identity misses frozen location Top1")
    ranked.loc[~is_local, "year"] = 0
    ranked["year"] = ranked["year"].astype(int)
    ranked["proposal_id"] = (
        ranked["attempt_id"].astype(str)
        + "|" + ranked["event_type"].astype(str)
        + "|" + ranked["shift_years"].astype(int).astype(str)
        + "|" + ranked["year"].astype(str)
    )
    return ranked[[
        "proposal_id", "attempt_id", "file_id", "family", "event_type",
        "shift_years", "year", "identity_group", "selection_oof_score",
        "meta_oof_score", "pair_oof_score",
    ]].sort_values(
        ["attempt_id", "selection_oof_score"],
        ascending=[True, False],
        kind="mergesort",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--identity-metadata", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--top", type=int, default=2)
    parser.add_argument("--maximum-attempts", type=int)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    scores = pd.read_pickle(Path(args.operation_scores).resolve())
    locations = pd.read_pickle(Path(args.location_scores).resolve())
    metadata = pd.read_pickle(Path(args.identity_metadata).resolve())
    shortlist = choose_operation_shortlist(
        scores, locations, metadata, args.top, args.maximum_attempts
    )
    shortlist.to_csv(output_dir / "proposals.csv", index=False)
    summary = {
        "schemaVersion": 2,
        "truthBlind": True,
        "locationIdentityImmutable": True,
        "topOperationIdentities": args.top,
        "maximumAttempts": args.maximum_attempts,
        "attempts": int(shortlist["attempt_id"].nunique()),
        "proposals": int(len(shortlist)),
        "byOperation": {
            str(name): int(count)
            for name, count in shortlist["event_type"].value_counts().items()
        },
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
