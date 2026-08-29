#!/usr/bin/env python3
"""Score a frozen immutable two-stage shadow model without fitting anything."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import joblib
import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
TRAINER_SPEC = importlib.util.spec_from_file_location(
    "immutable_two_stage_trainer",
    SCRIPT_DIR / "train-immutable-two-stage-adjudicator.py",
)
trainer = importlib.util.module_from_spec(TRAINER_SPEC)
TRAINER_SPEC.loader.exec_module(trainer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--target-operation-scores", required=True)
    parser.add_argument("--target-location-scores", required=True)
    parser.add_argument("--target-location-proposals", required=True)
    parser.add_argument("--target-current-top", required=True)
    parser.add_argument(
        "--target-location-anchor",
        action="append",
        default=[],
        metavar="NAME=CSV_PATH",
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    operation_path = Path(args.target_operation_scores).resolve()
    location_path = Path(args.target_location_scores).resolve()
    proposal_path = Path(args.target_location_proposals).resolve()
    current_path = Path(args.target_current_top).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    model = joblib.load(model_path)
    required_model_keys = {
        "operationRanker",
        "locationRanker",
        "proposalRanker",
        "operationSpec",
        "locationSpec",
        "proposalSpec",
        "operationPairWeight",
        "locationPairWeight",
        "proposalPairWeight",
        "safetyCalibration",
    }
    missing = required_model_keys.difference(model)
    if missing:
        raise RuntimeError(f"shadow model is missing {sorted(missing)}")
    anchor_paths = trainer.parse_anchor_paths(args.target_location_anchor)
    expected_anchor_names = set(model.get("proposalAnchorNames", ()))
    if set(anchor_paths) != expected_anchor_names:
        raise RuntimeError(
            "target proposal anchor names do not match the frozen model contract"
        )

    target_operations = pd.read_pickle(operation_path)
    target_proposals = pd.read_pickle(proposal_path)
    baseline = pd.read_csv(current_path)
    # Load the very wide table last.  The scorer filters operation identities
    # before adding proposal anchors or projecting model features.
    target_locations = pd.read_pickle(location_path)
    selected, operations, runtime_safety = trainer.score_target_safe_two_stage(
        target_operations,
        target_locations,
        target_proposals,
        baseline,
        operation_spec=model["operationSpec"],
        location_spec=model["locationSpec"],
        proposal_spec=model["proposalSpec"],
        operation_ranker=model["operationRanker"],
        location_ranker=model["locationRanker"],
        proposal_ranker=model["proposalRanker"],
        operation_weight=float(model["operationPairWeight"]),
        location_weight=float(model["locationPairWeight"]),
        proposal_weight=float(model["proposalPairWeight"]),
        safety_calibration=model["safetyCalibration"],
        location_anchor_tables=trainer.load_anchor_tables(anchor_paths),
    )
    summary = trainer.summarize(
        selected,
        target_locations,
        repetitions=args.bootstrap_repetitions,
        current_path=current_path,
    )
    summary.update({
        "schemaVersion": 1,
        "modelType": "immutable_two_stage_safe_listwise_pairwise",
        "files": int(selected["file_id"].nunique()),
        "candidateGeneratorFrozen": True,
        "modelSha256": trainer.sha256(model_path),
        "operationScoresSha256": trainer.sha256(operation_path),
        "candidatePackageSha256": trainer.sha256(location_path),
        "frozenProposalPackageSha256": trainer.sha256(proposal_path),
        "proposalAnchorSha256": {
            name: trainer.sha256(path) for name, path in anchor_paths.items()
        },
        "safetyCalibration": model["safetyCalibration"],
        "runtimeSafety": runtime_safety,
        "trainingCallsOnTarget": 0,
        "truthAwareRuntimeSwitches": 0,
    })
    selected.to_csv(output_dir / "target-shadow-top.csv", index=False)
    trainer.operation_confusion(selected, operations).to_csv(
        output_dir / "target-operation-confusion.csv", index=False
    )
    trainer.write_json(output_dir / "target-summary.json", summary)
    print(json.dumps({"outputDir": str(output_dir), "target": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
