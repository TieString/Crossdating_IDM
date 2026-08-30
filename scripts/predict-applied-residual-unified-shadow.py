#!/usr/bin/env python3
"""Pure inference for the frozen applied-residual unified shadow pack."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib

from applied_residual_unified_shadow import (
    read_location_rows,
    read_operation_rows,
    score_model_pack,
    sha256,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--operation-proposals", required=True)
    parser.add_argument("--operation-residual", required=True)
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--location-residual", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    manifest = json.loads(
        (model_dir / "manifest.json").read_text(encoding="utf8")
    )
    model_path = model_dir / manifest["modelFile"]
    if sha256(model_path) != manifest["modelSha256"]:
        raise RuntimeError("unified shadow model hash mismatch")
    pack = joblib.load(model_path)
    operation_rows = read_operation_rows(
        Path(args.operation_proposals).resolve(),
        Path(args.operation_residual).resolve(),
    )
    location_rows = read_location_rows(
        Path(args.location_scores).resolve(),
        Path(args.location_residual).resolve(),
    )
    selected = score_model_pack(pack, operation_rows, location_rows)
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    selected.to_csv(output_dir / "shadow-top.csv", index=False)
    summary = {
        "schemaVersion": 1,
        "modelVersion": manifest["modelVersion"],
        "modelSha256": manifest["modelSha256"],
        "trainingCalls": 0,
        "truthAwareRuntimeSwitches": 0,
        "attempts": int(len(selected)),
        "responses": int(selected["status"].eq("selected").sum()),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
