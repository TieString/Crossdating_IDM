#!/usr/bin/env python3
"""Freeze deployment-only upstream heads for unified v12 authority."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib

from applied_residual_unified_shadow import read_location_rows, sha256
from authoritative_unified_upstream import (
    fit_location_anchor_pack,
    fit_operation_stack_pack,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--operation-bottom-evidence", required=True)
    parser.add_argument("--identity-metadata", required=True)
    parser.add_argument("--operation-oof-cache", required=True)
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--location-residual", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operation_pack, operation_summary = fit_operation_stack_pack(
        operation_scores=Path(args.operation_scores).resolve(),
        bottom_evidence=Path(args.operation_bottom_evidence).resolve(),
        identity_metadata=Path(args.identity_metadata).resolve(),
        oof_cache_dir=Path(args.operation_oof_cache).resolve(),
    )
    operation_path = output_dir / "operation-upstream.joblib"
    joblib.dump(operation_pack, operation_path, compress=3)

    location_path = Path(args.location_scores).resolve()
    residual_path = Path(args.location_residual).resolve()
    location_rows = read_location_rows(location_path, residual_path)
    # read_location_rows has already attached residual columns.  Split the
    # frame back into immutable package and residual views to reuse the same
    # merge assertions as live inference.
    package_columns = [
        column for column in location_rows if not column.startswith("residual_")
    ]
    residual_columns = [
        column for column in location_rows
        if column == "proposal_id" or column.startswith("residual_")
    ]
    location_pack, location_summary = fit_location_anchor_pack(
        location_rows[package_columns],
        location_rows[residual_columns],
    )
    location_model_path = output_dir / "location-anchor.joblib"
    joblib.dump(location_pack, location_model_path, compress=3)

    manifest = {
        "schemaVersion": 1,
        "kind": "authoritative-unified-v12-upstream",
        "truthBlind": True,
        "trainingProtocolFrozen": True,
        "operationModel": operation_path.name,
        "operationModelSha256": sha256(operation_path),
        "locationAnchorModel": location_model_path.name,
        "locationAnchorModelSha256": sha256(location_model_path),
        **operation_summary,
        **location_summary,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **manifest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
