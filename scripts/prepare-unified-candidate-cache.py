#!/usr/bin/env python3
"""Extract immutable diagnosis candidates without training a selector."""

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
UNIFIED = load_module(
    "prepare_unified_candidate_rows",
    ROOT / "train-unified-diagnosis-adjudicator.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-tag", default="evaluation")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    output = Path(args.output).resolve()
    attempts_output = output.with_name(f"{output.stem}-attempts.pkl")
    metadata_output = output.with_suffix(".json")
    output.parent.mkdir(parents=True, exist_ok=True)

    candidates, attempts = UNIFIED.make_candidate_rows(run_dir, args.run_tag)
    candidates["dataset_role"] = "evaluation"
    candidates.to_pickle(output)
    attempts.to_pickle(attempts_output)
    metadata = {
        "identity": {
            "schemaVersion": 3,
            "runDirectories": [str(run_dir)],
        },
        "developmentAttempts": 0,
        "runTag": args.run_tag,
        "candidates": len(candidates),
        "attempts": len(attempts),
    }
    metadata_output.write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "output": str(output),
        "candidates": len(candidates),
        "attempts": len(attempts),
    }))


if __name__ == "__main__":
    main()
