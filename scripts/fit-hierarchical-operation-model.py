#!/usr/bin/env python3
"""Fit the operation-identity head on all development data and predict a target run."""

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
    "unified_adjudicator",
    ROOT / "train-unified-diagnosis-adjudicator.py",
)
HIERARCHICAL = load_module(
    "hierarchical_adjudicator",
    ROOT / "train-hierarchical-unified-adjudicator.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--development-candidate-cache",
        required=True,
        nargs="+",
        help="One or more isolated development candidate caches.",
    )
    parser.add_argument("--target-run-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_frames = []
    for index, cache_path in enumerate(args.development_candidate_cache):
        frame = pd.read_pickle(Path(cache_path).resolve())
        frame["attempt_id"] = (
            f"training-cache-{index}:" + frame["attempt_id"].astype(str)
        )
        development_frames.append(frame)
    development = pd.concat(development_frames, ignore_index=True, sort=False)
    development["dataset_role"] = "development"
    target, target_attempts = TRAINER.make_candidate_rows(
        Path(args.target_run_dir).resolve(),
        "evaluation",
    )
    target["dataset_role"] = "evaluation"
    candidates = pd.concat([development, target], ignore_index=True)
    features, feature_names = TRAINER.encoded_features(candidates)
    identities, identity_values, _ = HIERARCHICAL.build_identities(candidates, features)
    train = identities["dataset_role"].eq("development").to_numpy()
    test = identities["dataset_role"].eq("evaluation").to_numpy()
    labels = identities.loc[train, "operation_correct"]
    estimator = HIERARCHICAL.classifier(labels, 29000)
    estimator.fit(identity_values[train], labels)
    identities.loc[test, "operation_probability"] = estimator.predict_proba(
        identity_values[test]
    )[:, 1]
    evaluation = identities[test].copy()
    top = evaluation.sort_values(
        ["attempt_id", "operation_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()
    event = top[top["family"] != "Clean"]
    failures = event[event["product_correct"].eq(0)]
    recoverable = evaluation[
        (evaluation["family"] != "Clean")
        & evaluation["product_correct"].eq(0)
        & evaluation["operation_correct"].eq(1)
    ]["attempt_id"].nunique()
    summary = {
        "schemaVersion": 1,
        "developmentCandidateRows": len(development),
        "targetCandidateRows": len(target),
        "targetAttempts": len(target_attempts),
        "targetFiles": int(target["file_id"].nunique()),
        "productFailures": len(failures),
        "operationRecoverableFailures": recoverable,
        "operationTopCorrect": int(failures["operation_correct"].sum()),
        "operationTopCorrectRate": TRAINER.rate(
            int(failures["operation_correct"].sum()),
            recoverable,
        ),
        "strictOperationTopCorrect": int(failures["strict_operation_correct"].sum()),
    }
    top.to_csv(output_dir / "operation-top.csv", index=False)
    evaluation.to_csv(output_dir / "operation-identities.csv", index=False)
    target_attempts.to_csv(output_dir / "attempts.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "operation-model.txt").write_text(
        estimator.booster_.model_to_string(),
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
