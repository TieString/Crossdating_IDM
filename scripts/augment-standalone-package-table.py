#!/usr/bin/env python3
"""Append truth-blind experimental evidence to a frozen package table."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from standalone_location_evidence import append_frontier_competition_features


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--frontier-competition", action="store_true")
    args = parser.parse_args()

    table = pd.read_pickle(Path(args.input).resolve())
    if args.frontier_competition:
        table = append_frontier_competition_features(table)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    table.to_pickle(output)
    summary = {
        "schemaVersion": 1,
        "rows": len(table),
        "attempts": int(table["attempt_id"].nunique()),
        "files": int(table["file_id"].nunique()),
        "frontierCompetition": bool(args.frontier_competition),
    }
    output.with_suffix(".summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(output), **summary}))


if __name__ == "__main__":
    main()
