#!/usr/bin/env python3
"""Apply a frozen whole-projection operation head to an independent target set."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

import standalone_whole_projection_head as HEAD


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--package-tables", required=True, nargs="+")
    parser.add_argument("--model-config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    config = json.loads(
        Path(args.model_config).resolve().read_text(encoding="utf8")
    )
    if config.get("modelType") != "standalone_whole_projection_operation_head":
        raise ValueError("unexpected whole projection model type")
    base = pd.read_csv(Path(args.base_top).resolve())
    operations = pd.read_pickle(Path(args.operation_scores).resolve())
    labels = HEAD.load_whole_labels([
        Path(path).resolve() for path in args.package_tables
    ])
    competition = HEAD.build_competition(base, operations, labels)
    selected = HEAD.apply_threshold(
        base, competition, float(config["minimumScoreMargin"])
    )
    metrics = HEAD.summarize(
        selected, base, args.bootstrap_repetitions
    )
    summary = {
        **config,
        **metrics,
        "selectionPolicy": "frozen_whole_projection_competition_predict",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    competition.to_csv(output_dir / "whole-projection-competition.csv", index=False)
    selected.to_csv(output_dir / "standalone-whole-projection-top.csv", index=False)
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
