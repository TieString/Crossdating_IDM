#!/usr/bin/env python3
"""Audit frozen external predictions by correlation without changing the model."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
PROPOSAL_FILES = {
    "unifiedBaseProposal": "base/target-standalone-hierarchical-top.csv",
    "unifiedPairProposal": "pair/target-standalone-pairwise-top.csv",
    "unifiedFullYearProposal": "profile/target-standalone-full-year-top.csv",
}
CORRELATION_DIMENSIONS = {
    "fileCorrelation": "file_correlation_bin",
    "targetMasterCorrelation": "target_correlation_bin",
}


def normalize_attempt_id(value: object) -> str:
    text = str(value)
    marker = "evaluation:"
    index = text.find(marker)
    return text[index:] if index >= 0 else text


def integer(value: object) -> int | None:
    try:
        if value is None or pd.isna(value):
            return None
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def truth_ids(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if value is None or pd.isna(value):
        return []
    parsed = ast.literal_eval(str(value))
    return [str(item) for item in parsed]


def stable_seed(value: str) -> int:
    return int(hashlib.sha256(value.encode("utf8")).hexdigest()[:8], 16)


def clustered_lower(
    frame: pd.DataFrame,
    value_column: str,
    repetitions: int,
    seed_key: str,
) -> float | None:
    if frame.empty:
        return None
    grouped = frame.groupby("file_id", sort=True)[value_column].agg(["sum", "count"])
    values = grouped.to_numpy(dtype=float)
    rng = np.random.default_rng(stable_seed(seed_key))
    estimates = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sample = values[rng.integers(0, len(values), size=len(values))]
        estimates[index] = sample[:, 0].sum() / sample[:, 1].sum()
    return float(np.quantile(estimates, 0.05, method="lower"))


def event_matches(
    event: dict[str, Any],
    *,
    event_type: str,
    shift_years: int | None,
    top_year: int | None,
) -> bool:
    return (
        event.get("eventType") == event_type
        and integer(event.get("shiftYears")) == shift_years
        and integer(event.get("topYear")) == top_year
    )


def centered_event(event_type: str, shift_years: int, year: int | None) -> dict[str, Any]:
    return {
        "eventType": event_type,
        "shiftYears": shift_years,
        "startYear": year - 6 if year is not None else None,
        "endYear": year + 6 if year is not None else None,
        "topYear": year,
    }


def load_proposal_sources(model_dir: Path) -> dict[str, dict[str, dict[str, str]]]:
    result: dict[str, dict[str, dict[str, str]]] = {}
    columns = {
        "attempt_id",
        "selected_candidate_source",
        "event_type",
        "shift_years",
        "selected_candidate_year",
    }
    for proposal_source, relative_path in PROPOSAL_FILES.items():
        records: dict[str, dict[str, str]] = {}
        for chunk in pd.read_csv(
            model_dir / relative_path,
            usecols=lambda column: column in columns,
            chunksize=2000,
        ):
            for record in chunk.fillna("").to_dict("records"):
                records[normalize_attempt_id(record["attempt_id"])] = record
        result[proposal_source] = records
    return result


def selected_interpretations(
    row: pd.Series,
    step: dict[str, Any],
    proposal_sources: dict[str, dict[str, dict[str, str]]],
) -> tuple[str, list[dict[str, Any]]]:
    """Reconstruct the immutable selected package and its review interpretations."""

    attempt = normalize_attempt_id(row["attempt_id"])
    proposal_source = str(row.get("selected_candidate_source") or "")
    proposal = proposal_sources.get(proposal_source, {}).get(attempt, {})
    original_source = str(proposal.get("selected_candidate_source") or "")
    event_type = str(row.get("event_type") or "noEvent")
    shift_years = integer(row.get("shift_years")) or 0
    selected_year = integer(row.get("selected_candidate_year"))

    exact_event: dict[str, Any] | None = None
    if original_source in {"productPrimary", "productAlternative"}:
        key = "primary" if original_source == "productPrimary" else "alternative"
        candidate = step.get(key)
        if isinstance(candidate, dict) and event_matches(
            candidate,
            event_type=event_type,
            shift_years=shift_years,
            top_year=selected_year,
        ):
            exact_event = dict(candidate)

    main = exact_event or centered_event(event_type, shift_years, selected_year)
    main["reviewPath"] = [event_type]
    main["windowOrigin"] = "runtimePackage" if exact_event else "selected13YearMode"
    interpretations = [main]

    if original_source == "productPrimary" and exact_event is not None:
        alternative = step.get("alternative")
        if isinstance(alternative, dict):
            explicit = dict(alternative)
            explicit["reviewPath"] = [event_type, str(explicit.get("eventType"))]
            explicit["windowOrigin"] = "runtimePackageAlternative"
            interpretations.append(explicit)

    for interpretation in list(interpretations):
        if (
            interpretation.get("eventType") == "partialMove"
            and interpretation.get("shiftSide", "older") == "older"
            and (integer(interpretation.get("shiftYears")) or 0) <= -2
        ):
            reviewed = dict(interpretation)
            reviewed["eventType"] = "missingRing"
            reviewed["shiftYears"] = -1
            reviewed["reviewPath"] = [
                *interpretation["reviewPath"],
                "missingRing",
            ]
            reviewed["windowOrigin"] = f"{interpretation['windowOrigin']}TransitiveReview"
            interpretations.append(reviewed)

    deduplicated: list[dict[str, Any]] = []
    keys: set[tuple[object, ...]] = set()
    for interpretation in interpretations:
        key = (
            interpretation.get("eventType"),
            integer(interpretation.get("shiftYears")),
            integer(interpretation.get("startYear")),
            integer(interpretation.get("endYear")),
            tuple(interpretation.get("reviewPath", [])),
        )
        if key not in keys:
            keys.add(key)
            deduplicated.append(interpretation)
    return original_source, deduplicated


def interpretation_matches_truth(
    interpretation: dict[str, Any], truth: dict[str, Any]
) -> bool:
    if interpretation.get("eventType") != truth.get("eventType"):
        return False
    if integer(interpretation.get("shiftYears")) != integer(truth.get("shiftYears")):
        return False
    if truth.get("eventType") == "wholeSeriesMove":
        return True
    year = integer(truth.get("year"))
    start = integer(interpretation.get("startYear"))
    end = integer(interpretation.get("endYear"))
    return year is not None and start is not None and end is not None and start <= year <= end


def downstream_matches(
    row: pd.Series,
    case: dict[str, Any],
    interpretations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    current = str(row.get("diagnosedTruthId") or "")
    remaining = set(truth_ids(row.get("remainingTruthIds"))) - {current}
    truths = {
        str(truth["truthId"]): truth
        for truth in case.get("truths", [])
        if str(truth["truthId"]) in remaining
    }
    matches: list[dict[str, Any]] = []
    for truth_id, truth in truths.items():
        for interpretation in interpretations:
            if interpretation_matches_truth(interpretation, truth):
                matches.append({
                    "truthId": truth_id,
                    "truthType": truth.get("eventType"),
                    "truthYear": truth.get("year"),
                    "truthShiftYears": truth.get("shiftYears"),
                    "reviewPath": interpretation.get("reviewPath", []),
                    "windowStart": interpretation.get("startYear"),
                    "windowEnd": interpretation.get("endYear"),
                    "windowOrigin": interpretation.get("windowOrigin"),
                })
    return matches


def failure_category(row: pd.Series) -> str:
    if int(row["model_workflow_correct"]) == 1:
        return "correct"
    if int(row["model_response"]) == 0:
        return "refusal"
    if bool(row["frontier_error"]):
        return "frontier_selection"
    if int(row["model_operation_correct"]) == 0:
        return "operation_or_shift"
    if integer(row.get("location_correct")) == 0:
        return "window_location"
    return "package_projection_inconsistency"


def stage_category(row: pd.Series) -> str:
    if int(row["model_workflow_correct"]) == 1:
        return (
            "post_package_projection_recovery"
            if int(row["candidate_oracle"]) == 0
            else "correct"
        )
    return (
        "adjudication_ranking_loss"
        if int(row["candidate_oracle"]) == 1
        else "candidate_oracle_miss"
    )


def grouped_row(
    dimension: str,
    level: str,
    family: str,
    frame: pd.DataFrame,
    repetitions: int,
) -> dict[str, Any]:
    oracle_hits = int(frame["candidate_oracle"].sum())
    correct = int(frame["model_workflow_correct"].sum())
    failures = frame.loc[frame["model_workflow_correct"].eq(0)]
    failure_counts = failures["failure_category"].value_counts()
    ranking_losses = int(failures["candidate_oracle"].sum())
    oracle_miss_failures = int(failures["candidate_oracle"].eq(0).sum())
    return {
        "dimension": dimension,
        "level": level,
        "family": family,
        "files": int(frame["file_id"].nunique()),
        "events": len(frame),
        "workflow_correct": correct,
        "workflow_accuracy": correct / len(frame),
        "workflow_one_sided_95_file_cluster_lower": clustered_lower(
            frame,
            "model_workflow_correct",
            repetitions,
            f"{dimension}:{level}:{family}:workflow",
        ),
        "candidate_oracle_hits": oracle_hits,
        "candidate_oracle_accuracy": oracle_hits / len(frame),
        "candidate_oracle_one_sided_95_file_cluster_lower": clustered_lower(
            frame,
            "candidate_oracle",
            repetitions,
            f"{dimension}:{level}:{family}:oracle",
        ),
        "adjudication_ranking_losses": ranking_losses,
        "candidate_oracle_miss_failures": oracle_miss_failures,
        "post_package_projection_recoveries": int(
            frame["stage_category"].eq("post_package_projection_recovery").sum()
        ),
        "operation_or_shift_errors": int(failure_counts.get("operation_or_shift", 0)),
        "window_location_errors": int(failure_counts.get("window_location", 0)),
        "frontier_selection_errors": int(failure_counts.get("frontier_selection", 0)),
        "refusals": int(failure_counts.get("refusal", 0)),
        "package_projection_inconsistencies": int(
            failure_counts.get("package_projection_inconsistency", 0)
        ),
    }


def percentage(value: float | None) -> str:
    return "-" if value is None else f"{value:.2%}"


def markdown_table(rows: pd.DataFrame, dimension: str) -> list[str]:
    overall = rows.loc[(rows["dimension"] == dimension) & (rows["family"] == "Overall")]
    lines = [
        "| Correlation | Events | Workflow | Candidate Oracle | Oracle lower | Ranking loss | Oracle-miss failures | Operation/shift | Window | Frontier | Refusal |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in overall.to_dict("records"):
        lines.append(
            f"| {row['level']} | {row['events']} | {percentage(row['workflow_accuracy'])} | "
            f"{row['candidate_oracle_hits']}/{row['events']} "
            f"({percentage(row['candidate_oracle_accuracy'])}) | "
            f"{percentage(row['candidate_oracle_one_sided_95_file_cluster_lower'])} | "
            f"{row['adjudication_ranking_losses']} | "
            f"{row['candidate_oracle_miss_failures']} | "
            f"{row['operation_or_shift_errors']} | {row['window_location_errors']} | "
            f"{row['frontier_selection_errors']} | {row['refusals']} |"
        )
    return lines


def oracle_family_table(rows: pd.DataFrame, dimension: str) -> list[str]:
    subset = rows.loc[rows["dimension"].eq(dimension)]
    levels = list(dict.fromkeys(subset["level"].tolist()))
    lines = [
        "| Correlation | A | B | C | D | Overall |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for level in levels:
        values = []
        for family in ("A", "B", "C", "D", "Overall"):
            match = subset.loc[
                subset["level"].eq(level) & subset["family"].eq(family),
                "candidate_oracle_accuracy",
            ]
            values.append(percentage(float(match.iloc[0])) if not match.empty else "-")
        lines.append(f"| {level} | " + " | ".join(values) + " |")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-attempts", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--model-output-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    event = pd.read_csv(Path(args.event_attempts).resolve())
    run_dir = Path(args.run_dir).resolve()
    model_dir = Path(args.model_output_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    steps = {
        f"evaluation:{int(step['caseIndex'])}:{int(step['step'])}": step
        for step in json.loads((run_dir / "steps.json").read_text(encoding="utf8"))
    }
    cases = {
        str(case["index"]): case
        for case in json.loads((run_dir / "resolved-cases.json").read_text(encoding="utf8"))
    }
    proposals = load_proposal_sources(model_dir)

    frontier_details: list[dict[str, Any]] = []
    frontier_flags: list[bool] = []
    original_sources: list[str] = []
    for _, row in event.iterrows():
        attempt = normalize_attempt_id(row["attempt_id"])
        original_source, interpretations = selected_interpretations(
            row,
            steps[attempt],
            proposals,
        )
        matches = []
        if int(row["model_response"]) == 1 and int(row["model_workflow_correct"]) == 0:
            matches = downstream_matches(row, cases[str(int(row["caseIndex"]))], interpretations)
        frontier_flags.append(bool(matches))
        original_sources.append(original_source)
        if matches:
            frontier_details.append({
                "attempt_id": attempt,
                "caseIndex": int(row["caseIndex"]),
                "family": row["family"],
                "step": int(row["step"]),
                "file_id": row["file_id"],
                "target_id": row["target_id"],
                "file_correlation_bin": row["file_correlation_bin"],
                "target_correlation_bin": row["target_correlation_bin"],
                "candidate_oracle": int(row["candidate_oracle"]),
                "current_truth_id": row["diagnosedTruthId"],
                "current_truth_type": row["truth_type"],
                "current_truth_year": integer(row["truth_year"]),
                "current_truth_shift_years": integer(row["truth_shift_years"]),
                "selected_event_type": row["event_type"],
                "selected_shift_years": integer(row["shift_years"]),
                "selected_candidate_year": integer(row["selected_candidate_year"]),
                "selected_proposal_source": row["selected_candidate_source"],
                "selected_package_source": original_source,
                "matched_downstream_truths": json.dumps(matches, ensure_ascii=False),
            })

    event["selected_package_source"] = original_sources
    event["frontier_error"] = frontier_flags
    event["failure_category"] = event.apply(failure_category, axis=1)
    event["stage_category"] = event.apply(stage_category, axis=1)

    grouped: list[dict[str, Any]] = []
    repetitions = int(args.bootstrap_repetitions)
    for dimension, column in CORRELATION_DIMENSIONS.items():
        for family, family_frame in [("Overall", event), *event.groupby("family", sort=True)]:
            for level, frame in family_frame.groupby(column, sort=True):
                grouped.append(grouped_row(
                    dimension,
                    str(level),
                    str(family),
                    frame,
                    repetitions,
                ))
    grouped_table = pd.DataFrame(grouped)
    grouped_table.to_csv(output_dir / "correlation-oracle-errors.csv", index=False)
    pd.DataFrame(frontier_details).to_csv(output_dir / "frontier-errors.csv", index=False)

    failures = event.loc[event["model_workflow_correct"].eq(0)]
    cross = pd.crosstab(failures["stage_category"], failures["failure_category"])
    summary = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "trainingCalls": 0,
        "eventAttempts": len(event),
        "workflowCorrect": int(event["model_workflow_correct"].sum()),
        "candidateOracleHits": int(event["candidate_oracle"].sum()),
        "candidateOracleAccuracy": float(event["candidate_oracle"].mean()),
        "postPackageProjectionRecoveries": int(
            event["stage_category"].eq("post_package_projection_recovery").sum()
        ),
        "adjudicationRankingLosses": int(
            event["stage_category"].eq("adjudication_ranking_loss").sum()
        ),
        "candidateOracleMissFailures": int(
            event["stage_category"].eq("candidate_oracle_miss").sum()
        ),
        "failureCategories": {
            str(key): int(value)
            for key, value in failures["failure_category"].value_counts().items()
        },
        "failureStageByCategory": {
            str(stage): {str(category): int(value) for category, value in values.items()}
            for stage, values in cross.to_dict(orient="index").items()
        },
        "frontierErrors": len(frontier_details),
        "frontierErrorsByFamily": {
            str(key): int(value)
            for key, value in Counter(item["family"] for item in frontier_details).items()
        },
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )

    lines = [
        "# Frozen External Correlation and Candidate Oracle Audit",
        "",
        "This is a read-only analysis of the frozen external predictions. No model, "
        "threshold, calibration, file, or scenario was changed.",
        "",
        "Candidate Oracle means that the immutable package contained at least one "
        "workflow-correct package for the current frontier. Ranking loss means Oracle "
        "was available but the final adjudicator did not select it.",
        "",
        "Frontier errors conservatively require the selected immutable package, an "
        "explicit package alternative, or the product's partialMove-to-missingRing "
        "review path to cover another unresolved truth instead of the current frontier.",
        "",
        "## File correlation",
        "",
        *markdown_table(grouped_table, "fileCorrelation"),
        "",
        "Candidate Oracle by family:",
        "",
        *oracle_family_table(grouped_table, "fileCorrelation"),
        "",
        "## Target/master correlation",
        "",
        *markdown_table(grouped_table, "targetMasterCorrelation"),
        "",
        "Candidate Oracle by family:",
        "",
        *oracle_family_table(grouped_table, "targetMasterCorrelation"),
        "",
        "## Failure decomposition",
        "",
        f"- Candidate Oracle: {summary['candidateOracleHits']}/{summary['eventAttempts']} "
        f"({summary['candidateOracleAccuracy']:.2%}).",
        f"- Oracle-hit ranking/adjudication losses: {summary['adjudicationRankingLosses']}.",
        f"- Oracle-miss failures: {summary['candidateOracleMissFailures']}.",
        f"- Post-package projection recoveries: {summary['postPackageProjectionRecoveries']}.",
        f"- Operation or exact-shift errors: {summary['failureCategories'].get('operation_or_shift', 0)}.",
        f"- Window-location errors: {summary['failureCategories'].get('window_location', 0)}.",
        f"- Workflow-equivalent frontier errors: {summary['failureCategories'].get('frontier_selection', 0)}.",
        f"- Refusals: {summary['failureCategories'].get('refusal', 0)}.",
        f"- Final package-projection inconsistencies: "
        f"{summary['failureCategories'].get('package_projection_inconsistency', 0)}.",
        "",
        "The complete family-by-bin table is `correlation-oracle-errors.csv`; "
        "the individually matched frontier failures are `frontier-errors.csv`.",
    ]
    (output_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps({"outputDir": str(output_dir), **summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
