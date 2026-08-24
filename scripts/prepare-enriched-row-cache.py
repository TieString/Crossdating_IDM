#!/usr/bin/env python3
"""Prepare a compact sampled enriched-row cache from immutable NDJSON evidence."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
JOINT = load_module(
    "prepare_enriched_joint_rows",
    ROOT / "train-joint-operation-year-adjudicator.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows-manifest", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--operation-identities", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stride", type=int, default=5)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    rows, attempts = JOINT.build_table(
        Path(args.rows_manifest).resolve(),
        Path(args.run_dir).resolve(),
        Path(args.operation_identities).resolve(),
        max(1, args.stride),
    )
    rows.to_pickle(output_dir / "rows.pkl")
    attempts.to_pickle(output_dir / "attempts.pkl")
    summary = {
        "schemaVersion": 1,
        "rows": len(rows),
        "attempts": len(attempts),
        "files": int(attempts["file_id"].nunique()),
        "features": len(rows.columns),
        "stride": max(1, args.stride),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
