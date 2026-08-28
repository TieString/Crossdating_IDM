#!/usr/bin/env python3
"""Analyze one frozen external run without changing models or thresholds."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def stable_seed(value: str) -> int:
    return int(hashlib.sha256(value.encode("utf8")).hexdigest()[:8], 16)


def clustered_lower(
    frame: pd.DataFrame,
    numerator: str,
    denominator: str,
    repetitions: int,
    seed_key: str,
) -> float | None:
    usable = frame.loc[frame[denominator].gt(0)].copy()
    if usable.empty:
        return None
    grouped = usable.groupby("file_id", sort=True)[[numerator, denominator]].sum()
    values = grouped.to_numpy(dtype=float)
    rng = np.random.default_rng(stable_seed(seed_key))
    estimates = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sample = values[rng.integers(0, len(values), size=len(values))]
        estimates[index] = sample[:, 0].sum() / sample[:, 1].sum()
    return float(np.quantile(estimates, 0.05, method="lower"))


def metric(
    frame: pd.DataFrame,
    value_column: str,
    repetitions: int,
    seed_key: str,
) -> dict[str, object]:
    work = frame[["file_id", value_column]].copy()
    work["numerator"] = work[value_column].fillna(0).astype(float)
    work["denominator"] = 1
    numerator = int(work["numerator"].sum())
    denominator = len(work)
    return {
        "numerator": numerator,
        "denominator": denominator,
        "estimate": numerator / denominator if denominator else None,
        "oneSided95FileClusterLower": clustered_lower(
            work,
            "numerator",
            "denominator",
            repetitions,
            seed_key,
        ),
        "files": int(work["file_id"].nunique()),
    }


def correlation_bin(value: float, *, target: bool) -> str:
    if target:
        if value < 0.70:
            return "0.60-0.70"
        if value < 0.80:
            return "0.70-0.80"
        return ">=0.80"
    if value < 0.60:
        return "0.50-0.60"
    if value < 0.70:
        return "0.60-0.70"
    if value < 0.80:
        return "0.70-0.80"
    return ">=0.80"


def length_bin(value: int) -> str:
    if value < 200:
        return "100-199"
    if value < 300:
        return "200-299"
    return ">=300"


def reference_depth_bin(value: int) -> str:
    if value < 10:
        return "6-9"
    if value < 20:
        return "10-19"
    if value < 40:
        return "20-39"
    return ">=40"


def attempt_id(case_index: int, step: int) -> str:
    return f"evaluation:{int(case_index)}:{int(step)}"


def normalize_attempt_id(value: object) -> str:
    text = str(value)
    marker = "evaluation:"
    marker_index = text.find(marker)
    return text[marker_index:] if marker_index >= 0 else text


def top1_summary(
    name: str,
    path: Path,
    attempts: pd.DataFrame,
) -> dict[str, object]:
    top = pd.read_csv(path)
    top["attempt_id"] = top["attempt_id"].map(normalize_attempt_id)
    joined = attempts[["attempt_id", "truth_type", "truth_year"]].merge(
        top[[
            "attempt_id", "event_type", "operation_correct",
            "selected_candidate_year",
        ]],
        on="attempt_id",
        how="left",
    )
    local = joined["truth_type"].isin(LOCAL_EVENT_TYPES)
    exact = (
        pd.to_numeric(joined.loc[local, "selected_candidate_year"], errors="coerce")
        .eq(pd.to_numeric(joined.loc[local, "truth_year"], errors="coerce"))
    )
    operation_exact = exact & joined.loc[local, "operation_correct"].fillna(0).astype(bool)
    return {
        "name": name,
        "top1": int(exact.sum()),
        "operationCorrectTop1": int(operation_exact.sum()),
        "localEvents": int(local.sum()),
        "top1Rate": float(exact.mean()) if local.any() else None,
        "operationCorrectTop1Rate": float(operation_exact.mean()) if local.any() else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--package-table", required=True)
    parser.add_argument("--model-output-dir", required=True)
    parser.add_argument("--protocol-lock", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    model_dir = Path(args.model_output_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    repetitions = int(args.bootstrap_repetitions)

    steps = pd.DataFrame(json.loads((run_dir / "steps.json").read_text(encoding="utf8")))
    steps["attempt_id"] = [
        attempt_id(case_index, step)
        for case_index, step in zip(steps["caseIndex"], steps["step"])
    ]
    steps = steps.rename(columns={
        "fileId": "file_id",
        "targetId": "target_id",
        "diagnosedTruthType": "truth_type",
        "diagnosedTruthYear": "truth_year",
        "diagnosedTruthShiftYears": "truth_shift_years",
        "referenceAnchorCount": "reference_depth",
    })
    cases = pd.DataFrame(json.loads(
        (run_dir / "resolved-cases.json").read_text(encoding="utf8")
    )).rename(columns={
        "index": "caseIndex",
        "seriesYears": "series_years",
        "masterCorrelation": "master_correlation",
        "eventCount": "event_count",
        "frontierPositionBand": "position_band",
    })
    manifest = json.loads(Path(args.manifest).resolve().read_text(encoding="utf8"))
    file_rows = []
    target_rows = []
    for file in manifest["files"]:
        file_rows.append({
            "file_id": file["fileId"],
            "file_correlation": float(file["seriesIntercorrelation"]),
            "file_series_count": int(file["totalSeries"]),
        })
        for target in file["eligibleTargets"]:
            target_rows.append({
                "file_id": file["fileId"],
                "target_id": target["targetId"],
                "manifest_series_years": int(target["seriesYears"]),
                "target_master_correlation": float(target["masterCorrelation"]),
            })
    files = pd.DataFrame(file_rows)
    targets = pd.DataFrame(target_rows)

    final = pd.read_csv(model_dir / "final" / "standalone-whole-projection-top.csv")
    final["attempt_id"] = final["attempt_id"].map(normalize_attempt_id)
    predictions = steps.merge(final, on="attempt_id", how="left", suffixes=("", "_model"))
    predictions = predictions.merge(
        cases[[
            "caseIndex", "series_years", "master_correlation", "event_count",
            "position_band",
        ]],
        on="caseIndex",
        how="left",
    ).merge(files, on="file_id", how="left").merge(
        targets,
        on=["file_id", "target_id"],
        how="left",
    )
    predictions["is_clean"] = predictions["family"].eq("Clean")
    predictions["model_response"] = predictions[
        "candidate_has_response"
    ].fillna(0).astype(int)
    predictions["model_workflow_correct"] = predictions[
        "final_correct"
    ].fillna(0).astype(int)
    predictions["model_strict_correct"] = predictions[
        "final_strict_correct"
    ].fillna(0).astype(int)
    predictions["model_operation_correct"] = predictions[
        "operation_correct"
    ].fillna(0).astype(int)
    predictions["product_workflow_correct"] = predictions[
        "workflowSuggestionCorrect"
    ].fillna(False).astype(int)
    predictions["file_correlation_bin"] = predictions["file_correlation"].map(
        lambda value: correlation_bin(float(value), target=False)
    )
    predictions["target_correlation_bin"] = predictions[
        "target_master_correlation"
    ].map(lambda value: correlation_bin(float(value), target=True))
    predictions["length_bin"] = predictions["series_years"].map(
        lambda value: length_bin(int(value))
    )
    predictions["reference_depth_bin"] = predictions["reference_depth"].map(
        lambda value: reference_depth_bin(int(value))
    )

    event = predictions.loc[~predictions["is_clean"]].copy()
    clean = predictions.loc[predictions["is_clean"]].copy()
    package = pd.read_pickle(Path(args.package_table).resolve())
    package["attempt_id"] = package["attempt_id"].map(normalize_attempt_id)
    oracle = package.groupby("attempt_id", sort=False).agg(
        candidate_oracle=("workflow_correct", "max"),
        strict_candidate_oracle=("strict_correct", "max"),
    )
    event = event.merge(oracle, on="attempt_id", how="left")
    event["candidate_oracle"] = event["candidate_oracle"].fillna(0).astype(int)

    failure_reason = np.select(
        [
            event["model_response"].eq(0),
            event["candidate_oracle"].eq(0),
            event["model_operation_correct"].eq(0),
            event["model_workflow_correct"].eq(0),
        ],
        [
            "refusal",
            "evidence_projection_loss",
            "operation_or_shift_selection",
            "location_selection",
        ],
        default="correct",
    )
    event["failure_reason"] = failure_reason

    family_metrics: dict[str, object] = {}
    for family, group in event.groupby("family", sort=True):
        family_metrics[str(family)] = {
            "workflowAccuracy": metric(
                group, "model_workflow_correct", repetitions, f"family:{family}:workflow"
            ),
            "strictAccuracy": metric(
                group, "model_strict_correct", repetitions, f"family:{family}:strict"
            ),
            "operationAccuracy": metric(
                group, "model_operation_correct", repetitions, f"family:{family}:operation"
            ),
            "responseRate": metric(
                group, "model_response", repetitions, f"family:{family}:response"
            ),
        }

    event = event.sort_values(["caseIndex", "step"])
    event["direct_prefix_correct"] = 0
    complete_cases = 0
    for _, group in event.groupby("caseIndex", sort=False):
        values = group["model_workflow_correct"].to_numpy(dtype=int)
        prefix = np.cumprod(values)
        event.loc[group.index, "direct_prefix_correct"] = prefix
        complete_cases += int(prefix.sum() == len(prefix))
    direct_by_family = {}
    for family, group in event.groupby("family", sort=True):
        direct_by_family[str(family)] = metric(
            group,
            "direct_prefix_correct",
            repetitions,
            f"family:{family}:direct-prefix",
        )

    strata_rows: list[dict[str, object]] = []
    strata = {
        "fileCorrelation": "file_correlation_bin",
        "targetMasterCorrelation": "target_correlation_bin",
        "targetLength": "length_bin",
        "frontierPosition": "position_band",
        "eventCount": "event_count",
        "referenceDepth": "reference_depth_bin",
    }
    for stratum, column in strata.items():
        for family_name, family_group in [("Overall", event), *list(event.groupby("family", sort=True))]:
            for level, group in family_group.groupby(column, sort=True, dropna=False):
                result = metric(
                    group,
                    "model_workflow_correct",
                    repetitions,
                    f"stratum:{stratum}:{family_name}:{level}",
                )
                strata_rows.append({
                    "stratum": stratum,
                    "level": str(level),
                    "family": str(family_name),
                    **result,
                })
    strata_table = pd.DataFrame(strata_rows)

    proposal_top1 = [
        top1_summary(
            "ranker",
            model_dir / "base" / "target-standalone-hierarchical-top.csv",
            event,
        ),
        top1_summary(
            "pair",
            model_dir / "pair" / "target-standalone-pairwise-top.csv",
            event,
        ),
        top1_summary(
            "fullYear",
            model_dir / "profile" / "target-standalone-full-year-top.csv",
            event,
        ),
        top1_summary(
            "fusion",
            model_dir / "fusion" / "target-standalone-proposal-top.csv",
            event,
        ),
        top1_summary(
            "final",
            model_dir / "final" / "standalone-whole-projection-top.csv",
            event,
        ),
    ]

    product_correct = event["product_workflow_correct"].astype(bool)
    model_correct = event["model_workflow_correct"].astype(bool)
    overall = {
        "workflowAccuracy": metric(
            event, "model_workflow_correct", repetitions, "overall:workflow"
        ),
        "strictAccuracy": metric(
            event, "model_strict_correct", repetitions, "overall:strict"
        ),
        "operationAccuracy": metric(
            event, "model_operation_correct", repetitions, "overall:operation"
        ),
        "responseRate": metric(event, "model_response", repetitions, "overall:response"),
        "refusalRate": 1 - float(event["model_response"].mean()),
        "directSerialRecovery": metric(
            event, "direct_prefix_correct", repetitions, "overall:direct-prefix"
        ),
        "completeSerialCases": complete_cases,
        "completeSerialCaseRate": complete_cases / int(event["caseIndex"].nunique()),
        "cleanFalsePositives": int(clean["model_response"].sum()),
        "cleanAttempts": len(clean),
        "correctRetention": float(model_correct[product_correct].mean()) if product_correct.any() else 1.0,
        "correctToWrong": int((product_correct & ~model_correct).sum()),
        "wrongToCorrect": int((~product_correct & model_correct).sum()),
        "candidateOracleAccuracy": float(event["candidate_oracle"].mean()),
        "failureReasons": event.loc[
            event["failure_reason"].ne("correct"), "failure_reason"
        ].value_counts().to_dict(),
    }
    report = {
        "schemaVersion": 1,
        "protocol": "frozen-external-50-files-v1",
        "analysisOnly": True,
        "trainingCalls": 0,
        "calibrationChanges": 0,
        "thresholdChanges": 0,
        "caseReplacements": 0,
        "protocolLock": json.loads(
            Path(args.protocol_lock).resolve().read_text(encoding="utf8")
        ),
        "files": int(event["file_id"].nunique()),
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "overall": overall,
        "byFamily": family_metrics,
        "directSerialByFamily": direct_by_family,
        "proposalTop1": proposal_top1,
        "referenceDepth": {
            "median": float(event["reference_depth"].median()),
            "p10": float(event["reference_depth"].quantile(0.10)),
            "p90": float(event["reference_depth"].quantile(0.90)),
        },
    }

    event.to_csv(output_dir / "event-attempts.csv", index=False)
    clean.to_csv(output_dir / "clean-attempts.csv", index=False)
    event.loc[event["failure_reason"].ne("correct")].to_csv(
        output_dir / "failures.csv", index=False
    )
    strata_table.to_csv(output_dir / "strata.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf8"
    )

    lines = [
        "# Frozen External Test",
        "",
        "The model, weights, thresholds, files, and scenarios were frozen before inference.",
        "No training, calibration, threshold update, or case replacement was performed.",
        "",
        "| Family | Correct / events | Workflow | One-sided 95% lower | Strict | Response | Direct serial |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for family in ("A", "B", "C", "D"):
        workflow = family_metrics[family]["workflowAccuracy"]
        strict = family_metrics[family]["strictAccuracy"]
        response = family_metrics[family]["responseRate"]
        direct = direct_by_family[family]
        lines.append(
            f"| {family} | {workflow['numerator']}/{workflow['denominator']} | "
            f"{workflow['estimate']:.2%} | {workflow['oneSided95FileClusterLower']:.2%} | "
            f"{strict['estimate']:.2%} | {response['estimate']:.2%} | {direct['estimate']:.2%} |"
        )
    lines.extend([
        "",
        f"Overall workflow accuracy: {overall['workflowAccuracy']['estimate']:.2%}.",
        f"Overall one-sided 95% file-cluster lower bound: "
        f"{overall['workflowAccuracy']['oneSided95FileClusterLower']:.2%}.",
        f"Clean false positives: {overall['cleanFalsePositives']}/{overall['cleanAttempts']}.",
        f"Direct serial recovery: {overall['directSerialRecovery']['estimate']:.2%}.",
        "",
        "Detailed fixed strata are in `strata.csv`; individual attempts and failures are in the adjacent CSV files.",
    ])
    (output_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps({"outputDir": str(output_dir), **report}))


if __name__ == "__main__":
    main()
