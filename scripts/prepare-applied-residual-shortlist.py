#!/usr/bin/env python3
"""Build a truth-blind shortlist for virtual post-correction residual scoring."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd


REQUIRED_COLUMNS = (
    "attempt_id",
    "file_id",
    "family",
    "event_type",
    "shift_years",
    "year",
    "listwise_score",
    "pairwise_score",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def top_indices(table: pd.DataFrame, score: str, count: int) -> set[int]:
    if count <= 0:
        return set()
    ranked = table.sort_values(
        ["attempt_id", score, "year"],
        ascending=[True, False, False],
        kind="mergesort",
    )
    return set(ranked.groupby("attempt_id", sort=False).head(count).index)


def build_shortlist(
    table: pd.DataFrame,
    listwise_count: int,
    pairwise_count: int,
    maximum_attempts: int | None = None,
) -> pd.DataFrame:
    missing = sorted(set(REQUIRED_COLUMNS) - set(table.columns))
    if missing:
        raise ValueError(f"location score columns missing: {missing}")
    source = table.loc[:, REQUIRED_COLUMNS].copy()
    if maximum_attempts is not None:
        attempts = sorted(source["attempt_id"].unique())[:maximum_attempts]
        source = source[source["attempt_id"].isin(attempts)].copy()
    selected = top_indices(source, "listwise_score", listwise_count)
    selected.update(top_indices(source, "pairwise_score", pairwise_count))
    output = source.loc[sorted(selected)].copy()
    output = output.drop_duplicates(
        ["attempt_id", "event_type", "shift_years", "year"],
        keep="first",
    )
    output["proposal_id"] = (
        output["attempt_id"].astype(str)
        + "|"
        + output["event_type"].astype(str)
        + "|"
        + output["shift_years"].astype(int).astype(str)
        + "|"
        + output["year"].astype(int).astype(str)
    )
    return output[[
        "proposal_id",
        "attempt_id",
        "file_id",
        "family",
        "event_type",
        "shift_years",
        "year",
        "listwise_score",
        "pairwise_score",
    ]].sort_values(["attempt_id", "proposal_id"], kind="mergesort")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--listwise-top", type=int, default=2)
    parser.add_argument("--pairwise-top", type=int, default=2)
    parser.add_argument("--maximum-attempts", type=int)
    args = parser.parse_args()

    source_path = Path(args.location_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    table = pd.read_pickle(source_path)
    shortlist = build_shortlist(
        table,
        args.listwise_top,
        args.pairwise_top,
        args.maximum_attempts,
    )
    shortlist.to_csv(output_dir / "proposals.csv", index=False)
    summary = {
        "schemaVersion": 1,
        "truthBlind": True,
        "source": str(source_path),
        "sourceSha256": sha256_file(source_path),
        "listwiseTop": args.listwise_top,
        "pairwiseTop": args.pairwise_top,
        "maximumAttempts": args.maximum_attempts,
        "attempts": int(shortlist["attempt_id"].nunique()),
        "proposals": int(len(shortlist)),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
