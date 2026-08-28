#!/usr/bin/env python3
"""Calibrate pairwise operation-transition margins on development OOF data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

import standalone_operation_transition_head as TRANSITION
import standalone_whole_projection_head as METRICS


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--identity-location-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--minimum-transition-fixes", type=int, default=1)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base = pd.read_csv(Path(args.base_top).resolve())
    competition = TRANSITION.build_competition(
        base,
        pd.read_pickle(Path(args.operation_scores).resolve()),
        pd.read_pickle(Path(args.identity_location_top).resolve()),
    )
    policies, audit = TRANSITION.calibrate_policies(
        base, competition, args.minimum_transition_fixes
    )
    selected = TRANSITION.apply_policies(base, competition, policies)
    metrics = METRICS.summarize(
        selected, base, args.bootstrap_repetitions
    )
    config = {
        "schemaVersion": 1,
        "modelType": "standalone_pairwise_operation_transition_head",
        "scoreColumn": "operation_meta_score",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "policies": policies,
    }
    summary = {
        **config,
        **metrics,
        "operationTransitionSwitches": int(
            selected["operation_transition_switched"].sum()
        ),
        "selectionPolicy": "file_oof_pairwise_operation_transition_calibration",
    }
    (output_dir / "operation-transition-head.json").write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    competition.to_csv(output_dir / "operation-transition-competition.csv", index=False)
    audit.to_csv(output_dir / "operation-transition-threshold-audit.csv", index=False)
    selected.to_csv(output_dir / "standalone-operation-transition-top.csv", index=False)
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
