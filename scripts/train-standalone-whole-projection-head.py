#!/usr/bin/env python3
"""Calibrate the standalone whole-projection operation head on file-OOF scores."""

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
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--threshold-step", type=float, default=0.05)
    parser.add_argument("--max-clean-false-positives", type=int, default=1)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base = pd.read_csv(Path(args.base_top).resolve())
    operations = pd.read_pickle(Path(args.operation_scores).resolve())
    labels = HEAD.load_whole_labels([
        Path(path).resolve() for path in args.package_tables
    ])
    competition = HEAD.build_competition(base, operations, labels)
    threshold, threshold_audit = HEAD.calibrate_threshold(
        base,
        competition,
        step=args.threshold_step,
        max_clean_false_positives=args.max_clean_false_positives,
    )
    selected = HEAD.apply_threshold(base, competition, threshold)
    metrics = HEAD.summarize(
        selected, base, args.bootstrap_repetitions
    )
    config = {
        "schemaVersion": 1,
        "modelType": "standalone_whole_projection_operation_head",
        "scoreColumn": HEAD.SCORE_COLUMN,
        "marginDefinition": "whole_operation_score-base_operation_score",
        "minimumScoreMargin": threshold,
        "negativeWholeOnly": True,
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
    }
    summary = {
        **config,
        **metrics,
        "selectionPolicy": "single_frozen_whole_projection_competition",
        "thresholdStep": args.threshold_step,
    }
    (output_dir / "whole-projection-head.json").write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    competition.to_csv(output_dir / "whole-projection-competition.csv", index=False)
    threshold_audit.to_csv(output_dir / "threshold-audit.csv", index=False)
    selected.to_csv(output_dir / "standalone-whole-projection-top.csv", index=False)
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
