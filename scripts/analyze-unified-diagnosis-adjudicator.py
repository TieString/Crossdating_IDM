#!/usr/bin/env python3
"""Summarize a frozen unified-adjudicator OOF run without retuning it."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


def rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def as_bool(values: pd.Series) -> pd.Series:
    if values.dtype == bool:
        return values
    return values.astype("string").fillna("false").str.lower().eq("true")


def cluster_bootstrap(
    events: pd.DataFrame,
    family: str | None,
    repetitions: int,
    seed: int,
) -> dict[str, Any]:
    selected = events if family is None else events[events["family"] == family]
    grouped = selected.groupby("file_id").agg(
        attempts=("attempt_id", "size"),
        product=("product_correct", "sum"),
        model=("model_workflow_correct", "sum"),
    )
    rng = np.random.default_rng(seed)
    samples = rng.integers(0, len(grouped), size=(repetitions, len(grouped)))
    attempts = grouped["attempts"].to_numpy(dtype=float)[samples].sum(axis=1)
    product = grouped["product"].to_numpy(dtype=float)[samples].sum(axis=1) / attempts
    model = grouped["model"].to_numpy(dtype=float)[samples].sum(axis=1) / attempts
    gain = model - product
    return {
        "files": len(grouped),
        "attempts": len(selected),
        "productAccuracy": float(selected["product_correct"].mean()),
        "modelAccuracy": float(selected["model_workflow_correct"].mean()),
        "gain": float(
            selected["model_workflow_correct"].mean()
            - selected["product_correct"].mean()
        ),
        "modelOneSided95Lower": float(np.quantile(model, 0.05)),
        "gainOneSided95Lower": float(np.quantile(gain, 0.05)),
        "modelTwoSided95": [
            float(np.quantile(model, 0.025)),
            float(np.quantile(model, 0.975)),
        ],
        "gainTwoSided95": [
            float(np.quantile(gain, 0.025)),
            float(np.quantile(gain, 0.975)),
        ],
    }


def percent(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.2f}%"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--oracle-dir", required=True)
    parser.add_argument("--ranker-dir")
    parser.add_argument("--output-dir")
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    oracle_dir = Path(args.oracle_dir).resolve()
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else model_dir / "analysis"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    attempts = pd.read_csv(model_dir / "attempts.csv")
    decisions = pd.read_csv(model_dir / "decisions.csv")
    attempts["product_correct"] = as_bool(attempts["product_correct"])
    attempts["product_response"] = as_bool(attempts["product_response"])
    decisions["selected"] = as_bool(decisions["selected"])
    decisions["overridden"] = as_bool(decisions["overridden"])
    decisions["model_workflow_correct"] = as_bool(
        decisions["model_workflow_correct"]
    )
    decisions["pair_label"] = decisions["pair_label"].fillna(0).astype(int)
    decisions["pair_harm"] = decisions["pair_harm"].fillna(0).astype(int)
    merged = attempts.merge(
        decisions[[
            "attempt_id",
            "selected",
            "overridden",
            "model_workflow_correct",
            "decision_head",
            "pair_label",
            "pair_harm",
            "selected_event_type",
            "selected_shift_years",
            "selected_start_year",
            "selected_end_year",
            "selected_top_year",
        ]],
        on="attempt_id",
        how="left",
    )
    for column in ("selected", "overridden", "model_workflow_correct"):
        merged[column] = as_bool(merged[column])
    merged["decision_head"] = merged["decision_head"].fillna("refused")
    merged["pair_label"] = merged["pair_label"].fillna(0).astype(int)
    merged["pair_harm"] = merged["pair_harm"].fillna(0).astype(int)

    oracle = pd.read_csv(oracle_dir / "attempts.csv")
    oracle["attempt_id"] = (
        "evaluation:"
        + oracle["caseIndex"].astype(str)
        + ":"
        + oracle["step"].astype(str)
    )
    for column in (
        "strictOracle",
        "relaxedOracle",
        "operationOracle",
        "locationOracle",
        "gridOracle",
    ):
        oracle[column] = as_bool(oracle[column])
    merged = merged.merge(
        oracle[[
            "attempt_id",
            "category",
            "strictOracle",
            "relaxedOracle",
            "operationOracle",
            "locationOracle",
            "gridOracle",
            "oracleSource",
            "oracleType",
            "oracleShiftYears",
            "oracleStartYear",
            "oracleEndYear",
        ]],
        on="attempt_id",
        how="left",
    )
    for column in (
        "strictOracle",
        "relaxedOracle",
        "operationOracle",
        "locationOracle",
        "gridOracle",
    ):
        merged[column] = as_bool(merged[column])

    events = merged[merged["is_clean"] == 0].copy()
    clean = merged[merged["is_clean"] == 1].copy()
    bootstrap = {
        key: cluster_bootstrap(
            events,
            None if key == "overall" else key,
            args.bootstrap_repetitions,
            20260823 + index,
        )
        for index, key in enumerate(("overall", "A", "B", "C", "D"))
    }

    product_correct = events["product_correct"]
    model_correct = events["model_workflow_correct"]
    newly_corrected = ~product_correct & model_correct
    harmed = product_correct & ~model_correct
    preserved = product_correct & model_correct
    remaining = events[~model_correct].copy()
    remaining["oracleGap"] = np.select(
        [
            remaining["strictOracle"],
            remaining["relaxedOracle"],
            remaining["operationOracle"] & remaining["locationOracle"],
            remaining["operationOracle"],
        ],
        [
            "complete_strict_candidate",
            "complete_equivalent_candidate",
            "operation_and_location_separate",
            "operation_only",
        ],
        default="no_complete_evidence",
    )
    remaining.to_csv(output_dir / "remaining-failures.csv", index=False)

    ranker_summary = None
    if args.ranker_dir:
        ranker_summary = json.loads(
            (Path(args.ranker_dir).resolve() / "summary.json").read_text(
                encoding="utf8"
            )
        )

    summary = {
        "schemaVersion": 1,
        "modelDir": str(model_dir),
        "oracleDir": str(oracle_dir),
        "events": len(events),
        "clean": len(clean),
        "productCorrect": int(product_correct.sum()),
        "modelCorrect": int(model_correct.sum()),
        "oracleStrictCorrect": int(events["strictOracle"].sum()),
        "productAccuracy": float(product_correct.mean()),
        "modelAccuracy": float(model_correct.mean()),
        "oracleStrictAccuracy": float(events["strictOracle"].mean()),
        "newlyCorrected": int(newly_corrected.sum()),
        "harmed": int(harmed.sum()),
        "preservedCorrect": int(preserved.sum()),
        "preservationRate": rate(int(preserved.sum()), int(product_correct.sum())),
        "responseRate": float(events["selected"].mean()),
        "cleanProductFalsePositives": int(clean["product_response"].sum()),
        "cleanModelFalsePositives": int(clean["selected"].sum()),
        "decisionHeads": {
            str(key): int(value)
            for key, value in merged["decision_head"].value_counts().items()
        },
        "remainingFailures": len(remaining),
        "remainingByCategory": {
            str(key): int(value)
            for key, value in remaining["category"].value_counts().items()
        },
        "remainingByOracleGap": {
            str(key): int(value)
            for key, value in remaining["oracleGap"].value_counts().items()
        },
        "bootstrap": bootstrap,
        "ranker": ranker_summary,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )

    lines = [
        "# Unified diagnosis adjudicator experiment",
        "",
        "This report evaluates frozen file-level out-of-fold predictions. No model or threshold was retuned from this analysis.",
        "",
        "## Accuracy",
        "",
        "| Group | Events | Product | Unified model | Strict Oracle | Gain | Model one-sided 95% lower | Gain one-sided 95% lower |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for key in ("overall", "A", "B", "C", "D"):
        selected = events if key == "overall" else events[events["family"] == key]
        boot = bootstrap[key]
        lines.append(
            f"| {key} | {len(selected)} | {percent(float(selected['product_correct'].mean()))} "
            f"| {percent(float(selected['model_workflow_correct'].mean()))} "
            f"| {percent(float(selected['strictOracle'].mean()))} "
            f"| {percent(boot['gain'])} | {percent(boot['modelOneSided95Lower'])} "
            f"| {percent(boot['gainOneSided95Lower'])} |"
        )
    lines.extend([
        "",
        "## Safety",
        "",
        f"- Corrected failures: {int(newly_corrected.sum())}.",
        f"- Correct to incorrect: {int(harmed.sum())}.",
        f"- Existing correct suggestions retained: {int(preserved.sum())}/{int(product_correct.sum())} ({percent(summary['preservationRate'])}).",
        f"- Event response rate: {percent(summary['responseRate'])}.",
        f"- Clean false positives: {summary['cleanModelFalsePositives']}/{len(clean)} (product baseline {summary['cleanProductFalsePositives']}/{len(clean)}).",
        "",
        "## Decision heads",
        "",
    ])
    for head, count in summary["decisionHeads"].items():
        lines.append(f"- `{head}`: {count}")
    lines.extend([
        "",
        "## Remaining failures",
        "",
        f"{len(remaining)} event opportunities remain incorrect or refused.",
        "",
        "| Oracle availability | Cases |",
        "| --- | ---: |",
    ])
    for category, count in summary["remainingByOracleGap"].items():
        lines.append(f"| {category} | {count} |")
    lines.extend([
        "",
        "| Pipeline loss category | Cases |",
        "| --- | ---: |",
    ])
    for category, count in summary["remainingByCategory"].items():
        lines.append(f"| {category} | {count} |")
    if ranker_summary:
        lines.extend([
            "",
            "## Ranker audit",
            "",
            f"LambdaRank placed a correct operation candidate first in {ranker_summary['topCorrectFailures']}/{ranker_summary['recoverableFailures']} recoverable product failures ({percent(ranker_summary['topCorrectRateAmongRecoverable'])}).",
            f"Correct-candidate median/P90 rank: {ranker_summary['correctCandidateMedianRank']:.1f}/{ranker_summary['correctCandidateP90Rank']:.1f}.",
        ])
    (output_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps({
        "outputDir": str(output_dir),
        "modelAccuracy": summary["modelAccuracy"],
        "gain": bootstrap["overall"]["gain"],
        "gainOneSided95Lower": bootstrap["overall"]["gainOneSided95Lower"],
        "harmed": summary["harmed"],
        "cleanFalsePositives": summary["cleanModelFalsePositives"],
    }))


if __name__ == "__main__":
    main()
