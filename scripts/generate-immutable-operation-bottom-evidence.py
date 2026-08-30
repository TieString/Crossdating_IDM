#!/usr/bin/env python3
"""Generate truth-blind baseline-conditioned operation evidence."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from immutable_bottom_evidence import (  # noqa: E402
    append_operation_bottom_evidence,
    forbidden_bottom_feature_columns,
    select_operation_core_bottom_evidence,
)
from immutable_two_stage_adjudicator import ensure_identity_group, sha256  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--row-cache", required=True)
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--feature-set", choices=("all", "core"), default="all"
    )
    args = parser.parse_args()

    row_path = Path(args.row_cache).resolve()
    operation_path = Path(args.operation_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    operations = ensure_identity_group(pd.read_pickle(operation_path))
    rows = pd.read_pickle(row_path)
    evidence = append_operation_bottom_evidence(operations, rows)
    if args.feature_set == "core":
        evidence = select_operation_core_bottom_evidence(evidence)
    if evidence["identity_group"].duplicated().any():
        raise RuntimeError("operation bottom evidence must be unique per identity")
    if set(evidence["identity_group"]) != set(operations["identity_group"]):
        raise RuntimeError("operation bottom evidence changed immutable identities")
    forbidden = forbidden_bottom_feature_columns(evidence)
    if forbidden:
        raise RuntimeError(
            "operation bottom evidence admitted forbidden fields: "
            + ", ".join(forbidden)
        )
    feature_columns = [
        column for column in evidence if column.startswith("bottom_")
    ]
    if not feature_columns:
        raise RuntimeError("operation bottom evidence generation produced no features")

    output_path = output_dir / "operation-bottom-evidence.pkl"
    evidence.to_pickle(output_path)
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "candidateGeneratorFrozen": True,
        "adjudicatorWeightsFrozen": True,
        "featureSet": args.feature_set,
        "rowCacheSha256": sha256(row_path),
        "operationScoresSha256": sha256(operation_path),
        "operationIdentities": len(evidence),
        "bottomFeatureCount": len(feature_columns),
        "projectedCoverage": float(
            evidence[feature_columns].notna().any(axis=1).mean()
        ),
        "outputSha256": sha256(output_path),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output_dir), **payload}, ensure_ascii=False))


if __name__ == "__main__":
    main()
