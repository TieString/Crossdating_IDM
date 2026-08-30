#!/usr/bin/env python3
"""Fit one deployable shadow pack from the frozen v6/v12 evidence protocol."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib

from applied_residual_unified_shadow import fit_model_pack, write_manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-proposals", required=True)
    parser.add_argument("--operation-residual", required=True)
    parser.add_argument("--identity-metadata", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--location-residual", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    inputs = {
        "operationProposals": Path(args.operation_proposals).resolve(),
        "operationResidual": Path(args.operation_residual).resolve(),
        "identityMetadata": Path(args.identity_metadata).resolve(),
        "operationTop": Path(args.operation_top).resolve(),
        "locationScores": Path(args.location_scores).resolve(),
        "locationResidual": Path(args.location_residual).resolve(),
    }
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    pack, summary = fit_model_pack(
        operation_proposals=inputs["operationProposals"],
        operation_residual=inputs["operationResidual"],
        identity_metadata=inputs["identityMetadata"],
        operation_top=inputs["operationTop"],
        location_scores=inputs["locationScores"],
        location_residual=inputs["locationResidual"],
    )
    model_path = output_dir / "model.joblib"
    joblib.dump(pack, model_path, compress=3)
    manifest = write_manifest(
        output_dir / "manifest.json",
        model_path,
        summary,
        inputs,
    )
    print(json.dumps({"outputDir": str(output_dir), **manifest}))


if __name__ == "__main__":
    main()
