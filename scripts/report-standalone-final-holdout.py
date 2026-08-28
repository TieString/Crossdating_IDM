#!/usr/bin/env python3
"""Summarize a frozen standalone final-holdout evaluation without tuning it."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def source_attempt_id(value: object) -> str:
    text = str(value)
    marker = "evaluation:"
    index = text.find(marker)
    return text[index:] if index >= 0 else text


def load_top(path: Path) -> pd.DataFrame:
    table = pd.read_csv(path)
    table["source_attempt_id"] = table["attempt_id"].map(source_attempt_id)
    return table


def top1_metrics(path: Path, truth: pd.DataFrame) -> dict[str, object]:
    top = load_top(path).merge(
        truth[["source_attempt_id", "truth_year"]],
        on="source_attempt_id",
        how="left",
        validate="one_to_one",
    )
    local = top[top["truth_year"].notna()].copy()
    exact = pd.to_numeric(
        local["selected_candidate_year"], errors="coerce"
    ).eq(pd.to_numeric(local["truth_year"], errors="coerce"))
    workflow_exact = exact & local["operation_correct"].eq(1)
    return {
        "localEvents": len(local),
        "yearTop1Correct": int(exact.sum()),
        "yearTop1": float(exact.mean()),
        "workflowTop1Correct": int(workflow_exact.sum()),
        "workflowTop1": float(workflow_exact.mean()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--final-dir", required=True)
    parser.add_argument("--product-top", required=True)
    parser.add_argument("--package-table", required=True)
    parser.add_argument("--ranker-top", required=True)
    parser.add_argument("--pair-top", required=True)
    parser.add_argument("--profile-top", required=True)
    parser.add_argument("--fusion-top", required=True)
    parser.add_argument("--transition-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    final_dir = Path(args.final_dir).resolve()
    final = load_top(final_dir / "standalone-whole-projection-top.csv")
    summary = json.loads((final_dir / "summary.json").read_text(encoding="utf8"))

    product = pd.read_csv(Path(args.product_top).resolve())[[
        "attempt_id", "product_correct", "product_strict_correct", "truth_year"
    ]].drop_duplicates("attempt_id")
    product = product.rename(columns={"attempt_id": "source_attempt_id"})
    final = final.merge(
        product,
        on="source_attempt_id",
        how="left",
        validate="one_to_one",
    )

    packages = pd.read_pickle(Path(args.package_table).resolve())
    oracle = packages.groupby("attempt_id", sort=False).agg(
        candidate_oracle_correct=("workflow_correct", "max"),
        strict_candidate_oracle_correct=("strict_correct", "max"),
    ).reset_index()
    oracle["source_attempt_id"] = oracle["attempt_id"].map(source_attempt_id)
    final = final.merge(
        oracle[[
            "source_attempt_id", "candidate_oracle_correct",
            "strict_candidate_oracle_correct",
        ]],
        on="source_attempt_id",
        how="left",
        validate="one_to_one",
    )

    event = final[final["family"].ne("Clean")].copy()
    clean = final[final["family"].eq("Clean")].copy()
    event["failure_reason"] = np.select(
        [
            event["final_correct"].eq(1),
            event["candidate_has_response"].eq(0),
            event["candidate_oracle_correct"].eq(0),
            event["operation_correct"].eq(0),
            event["location_correct"].fillna(0).eq(0),
        ],
        [
            "correct", "refused", "evidence_projection_loss",
            "operation_or_shift", "window_location",
        ],
        default="other",
    )
    failures = event[event["final_correct"].eq(0)].copy()
    failures[[
        "source_attempt_id", "file_id", "family", "event_type", "shift_years",
        "selected_candidate_year", "selected_candidate_source",
        "operation_correct", "location_correct", "candidate_has_response",
        "candidate_oracle_correct", "product_correct", "failure_reason",
    ]].to_csv(output_dir / "final-failures.csv", index=False)

    regressions = event[
        event["product_correct"].eq(1) & event["final_correct"].eq(0)
    ].copy()
    regressions[[
        "source_attempt_id", "file_id", "family", "event_type", "shift_years",
        "selected_candidate_year", "operation_correct", "location_correct",
        "failure_reason",
    ]].to_csv(output_dir / "product-correct-regressions.csv", index=False)

    transition = load_top(Path(args.transition_top).resolve())
    comparison = final[[
        "source_attempt_id", "final_correct", "event_type", "shift_years",
    ]].merge(
        transition[[
            "source_attempt_id", "final_correct", "event_type", "shift_years",
        ]],
        on="source_attempt_id",
        suffixes=("_safe", "_transition"),
        validate="one_to_one",
    )
    changed = comparison[
        comparison["event_type_safe"].ne(comparison["event_type_transition"])
        | comparison["shift_years_safe"].ne(comparison["shift_years_transition"])
    ].copy()
    changed["outcome"] = np.select(
        [
            changed["final_correct_safe"].eq(0)
            & changed["final_correct_transition"].eq(1),
            changed["final_correct_safe"].eq(1)
            & changed["final_correct_transition"].eq(0),
        ],
        ["wrong_to_correct", "correct_to_wrong"],
        default="unchanged_correctness",
    )
    changed.to_csv(output_dir / "unsafe-transition-switches.csv", index=False)

    top1 = {
        "ranker": top1_metrics(Path(args.ranker_top).resolve(), final),
        "pair": top1_metrics(Path(args.pair_top).resolve(), final),
        "profile": top1_metrics(Path(args.profile_top).resolve(), final),
        "fusion": top1_metrics(Path(args.fusion_top).resolve(), final),
        "final": top1_metrics(
            final_dir / "standalone-whole-projection-top.csv", final
        ),
    }
    by_family = {}
    for family, group in event.groupby("family", sort=True):
        by_family[family] = {
            "events": len(group),
            "workflowCorrect": int(group["final_correct"].sum()),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictCorrect": int(group["final_strict_correct"].sum()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": summary["byFamily"][family][
                "oneSided95FileClusterLower"
            ],
            "failures": int(group["final_correct"].eq(0).sum()),
        }

    product_correct = event["product_correct"].eq(1)
    report = {
        "schemaVersion": 1,
        "model": "standalone_three_proposal_plus_frozen_whole_projection_v34",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "files": int(event["file_id"].nunique()),
        "events": len(event),
        "workflowCorrect": int(event["final_correct"].sum()),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "strictCorrect": int(event["final_strict_correct"].sum()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanAttempts": len(clean),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "candidateOracleCorrect": int(event["candidate_oracle_correct"].sum()),
        "candidateOracleAccuracy": float(event["candidate_oracle_correct"].mean()),
        "productCorrect": int(product_correct.sum()),
        "productCorrectRetained": int(
            (product_correct & event["final_correct"].eq(1)).sum()
        ),
        "productCorrectRetention": float(
            event.loc[product_correct, "final_correct"].mean()
        ),
        "productCorrectToWrong": len(regressions),
        "productWrongToCorrect": int(
            (event["product_correct"].eq(0) & event["final_correct"].eq(1)).sum()
        ),
        "overallOneSided95FileClusterLower": summary[
            "overallOneSided95FileClusterLower"
        ],
        "failureReasons": {
            str(key): int(value)
            for key, value in failures["failure_reason"].value_counts().items()
        },
        "selectedRoles": {
            str(key): int(value)
            for key, value in event["selected_proposal_role"].value_counts().items()
        },
        "top1": top1,
        "byFamily": by_family,
        "unsafeTransition": {
            "switches": len(changed),
            "correctToWrong": int(changed["outcome"].eq("correct_to_wrong").sum()),
            "wrongToCorrect": int(changed["outcome"].eq("wrong_to_correct").sum()),
        },
    }
    (output_dir / "summary.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **report}))


if __name__ == "__main__":
    main()
