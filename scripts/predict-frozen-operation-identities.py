#!/usr/bin/env python3
"""Generate target operation identities using one immutable frozen model."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import pandas as pd


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
TRAINER = load_module(
    "frozen_identity_candidate_rows",
    ROOT / "train-unified-diagnosis-adjudicator.py",
)
HIERARCHICAL = load_module(
    "frozen_identity_aggregation",
    ROOT / "train-hierarchical-unified-adjudicator.py",
)
FROZEN = load_module(
    "frozen_model_identity_helpers",
    ROOT / "frozen_model_inference.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-run-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--runtime-manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--run-tag", default="evaluation")
    args = parser.parse_args()

    run_dir = Path(args.target_run_dir).resolve()
    model_dir = Path(args.model_dir).resolve()
    runtime_dir = Path(args.runtime_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    runtime_verification = FROZEN.verify_runtime_manifest(
        runtime_dir,
        Path(args.runtime_manifest).resolve(),
    )
    candidates, attempts = TRAINER.make_candidate_rows(run_dir, args.run_tag)
    candidates["dataset_role"] = "evaluation"
    raw_values, _ = TRAINER.encoded_features(candidates)
    feature_names = FROZEN.load_feature_names(model_dir / "feature-names.json")
    values = raw_values.reindex(columns=feature_names, fill_value=0).astype("float32")
    identities, identity_values, _ = HIERARCHICAL.build_identities(candidates, values)
    identities["operation_probability"] = FROZEN.predict(
        model_dir / "operation-model.txt",
        identity_values,
    )
    evaluation = identities.copy()
    top = evaluation.sort_values(
        ["attempt_id", "operation_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()

    evaluation.to_csv(output_dir / "operation-identities.csv", index=False)
    top.to_csv(output_dir / "operation-top.csv", index=False)
    attempts.to_csv(output_dir / "attempts.csv", index=False)
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "frozen_operation_identity_predict_only",
        "trainingCalls": 0,
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "runDir": str(run_dir),
        "targetCandidateRows": len(candidates),
        "targetAttempts": len(attempts),
        "targetFiles": int(candidates["file_id"].nunique()),
        "targetOperationIdentities": len(evaluation),
        "features": len(feature_names),
        "runtimeVerification": runtime_verification,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
