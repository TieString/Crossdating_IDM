#!/usr/bin/env python3
"""Fit the operation proposal fusion on development and predict target files."""

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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FUSION = load_module(
    "standalone_operation_proposal_training",
    ROOT / "train-standalone-operation-proposal-fusion.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-operation-scores", required=True)
    parser.add_argument("--development-base-top", required=True)
    parser.add_argument("--target-operation-scores", required=True)
    parser.add_argument("--target-base-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-type", choices=("ranker", "classifier"), default="ranker")
    parser.add_argument("--ensemble-members", type=int, default=1)
    parser.add_argument("--seed-base", type=int, default=154000)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()
    if args.ensemble_members < 1:
        raise ValueError("ensemble members must be positive")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development = FUSION.proposal_rows(
        pd.read_pickle(Path(args.development_operation_scores).resolve()),
        pd.read_csv(Path(args.development_base_top).resolve()),
    )
    target_base = pd.read_csv(Path(args.target_base_top).resolve())
    target = FUSION.proposal_rows(
        pd.read_pickle(Path(args.target_operation_scores).resolve()),
        target_base,
    )
    train_values, target_values, names = FUSION.encode_train_target(
        development, target
    )
    ordered = development.sort_values("attempt_id").index.to_numpy(dtype=int)
    groups = development.loc[ordered].groupby(
        "attempt_id", sort=False
    ).size().to_numpy()
    scores = 0
    for member in range(args.ensemble_members):
        seed = args.seed_base + member * 1009
        if args.model_type == "classifier":
            model = FUSION.classifier(seed)
            model.fit(
                train_values,
                development["operation_correct"],
                sample_weight=FUSION.sample_weights(development),
            )
            scores = scores + model.predict_proba(target_values)[:, 1]
        else:
            model = FUSION.ranker(seed)
            model.fit(
                train_values.loc[ordered],
                development.loc[ordered, "operation_correct"],
                group=groups,
            )
            scores = scores + model.predict(target_values)
    scores = scores / args.ensemble_members
    top = FUSION.select_top(target, scores)
    event = top.loc[~top["is_clean"].astype(bool)].copy()
    clean = top.loc[top["is_clean"].astype(bool)].copy()
    baseline = target_base.set_index("attempt_id")["operation_correct"].astype(bool)
    before = event["attempt_id"].map(baseline).fillna(False).astype(bool)
    after = event["operation_correct"].astype(bool)
    by_family = {
        str(family): {
            "correct": int(group["operation_correct"].sum()),
            "events": len(group),
            "operationAccuracy": float(group["operation_correct"].mean()),
            "oneSided95FileClusterLower": FUSION.clustered_lower(
                group, 154000 + ord(str(family)[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family", sort=True)
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": f"standalone_operation_proposal_fit_{args.model_type}",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "developmentFiles": int(development["cluster_id"].nunique()),
        "targetFiles": int(target["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "proposalRows": len(target),
        "features": len(names),
        "operationCorrect": int(after.sum()),
        "operationAccuracy": float(after.mean()),
        "candidateOracleCorrect": int(
            target.loc[~target["is_clean"].astype(bool)]
            .groupby("attempt_id")["operation_correct"].max().sum()
        ),
        "correctToWrong": int((before & ~after).sum()),
        "wrongToCorrect": int((~before & after).sum()),
        "cleanFalsePositives": int(clean["event_type"].ne("noEvent").sum()),
        "overallOneSided95FileClusterLower": FUSION.clustered_lower(
            event, 154999, args.bootstrap_repetitions
        ),
        "byFamily": by_family,
    }
    target.assign(proposal_score=scores).to_pickle(
        output_dir / "target-operation-proposal-scores.pkl"
    )
    top.to_csv(output_dir / "target-operation-proposal-top.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
