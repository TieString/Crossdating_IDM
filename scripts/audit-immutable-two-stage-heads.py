#!/usr/bin/env python3
"""Compare frozen listwise and pairwise head Top1 results without training."""

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


def head_result(
    frame: pd.DataFrame,
    rank_score,
    pair_score,
    *,
    group: str,
    label: str,
) -> dict:
    result = {}
    for name, score in (("listwise", rank_score), ("pairwise", pair_score)):
        top = trainer.select_top(
            frame, pd.Series(score, index=frame.index), group
        )
        event = top[top["family"].ne("Clean")]
        result[name] = {
            "correct": int(event[label].sum()),
            "attempts": len(event),
            "accuracy": float(event[label].mean()),
            "byFamily": {
                str(family): {
                    "correct": int(values[label].sum()),
                    "attempts": len(values),
                    "accuracy": float(values[label].mean()),
                }
                for family, values in event.groupby("family", sort=True)
            },
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--proposal-scores", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    model = joblib.load(args.model)
    operations = trainer.prepare_operation(pd.read_pickle(args.operation_scores))
    operation_values = trainer.project_relative_features(
        operations, model["operationSpec"]
    )
    operation_seed = trainer.seed_percentile(
        operations, group="attempt_id", columns=trainer.OPERATION_SEED
    )
    operation_rank = model["operationRanker"].predict(operation_values)
    operation_rank_pct = trainer.within_group_percentile(
        operations, operation_rank, "attempt_id"
    )
    operation_pair = trainer.pair_tournament_scores(
        operations,
        operation_values,
        model["operationPair"],
        group="attempt_id",
        shortlist_score=operation_rank_pct.mul(0.7).add(operation_seed.mul(0.3)),
        shortlist_size=16,
    )

    proposals = trainer.prepare_proposals(pd.read_pickle(args.proposal_scores))
    proposal_values = trainer.project_relative_features(
        proposals, model["proposalSpec"]
    )
    proposal_seed = trainer.seed_percentile(
        proposals,
        group="identity_group",
        columns=(
            "proposal_score",
            "proposal_support_within_0",
            "proposal_support_within_1",
            "proposal_support_within_2",
            "proposal_support_within_4",
            "proposal_support_within_6",
        ),
    )
    proposal_rank = model["proposalRanker"].predict(proposal_values)
    proposal_rank_pct = trainer.within_group_percentile(
        proposals, proposal_rank, "identity_group"
    )
    proposal_pair = trainer.pair_tournament_scores(
        proposals,
        proposal_values,
        model["proposalPair"],
        group="identity_group",
        shortlist_score=proposal_rank_pct.mul(0.7).add(proposal_seed.mul(0.3)),
        shortlist_size=3,
    )
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "trainingCalls": 0,
        "operation": head_result(
            operations,
            operation_rank,
            operation_pair,
            group="attempt_id",
            label="operation_correct",
        ),
        "proposalLocation": head_result(
            proposals,
            proposal_rank,
            proposal_pair,
            group="identity_group",
            label="proposal_correct",
        ),
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
