#!/usr/bin/env python3
"""Analyze a frozen two-stage shadow model on the external file protocol."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def normalize_attempt(value: object) -> str:
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
    if value is None or pd.isna(value):
        return []
    parsed = ast.literal_eval(str(value))
    return [str(item) for item in parsed]


def stable_seed(value: str) -> int:
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:8], 16)


def clustered_lower(
    frame: pd.DataFrame,
    value: str,
    *,
    repetitions: int,
    seed: str,
) -> float:
    grouped = frame.groupby("file_id", sort=True)[value].agg(["sum", "count"])
    matrix = grouped.to_numpy(dtype=float)
    rng = np.random.default_rng(stable_seed(seed))
    estimates = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sample = matrix[rng.integers(0, len(matrix), size=len(matrix))]
        estimates[index] = sample[:, 0].sum() / sample[:, 1].sum()
    return float(np.quantile(estimates, 0.05, method="lower"))


def selected_matches_truth(
    selected: pd.Series,
    truth: dict,
) -> bool:
    event_type = str(selected["selected_event_type"])
    shift = integer(selected["selected_shift_years"])
    truth_type = str(truth.get("eventType"))
    truth_shift = integer(truth.get("shiftYears"))
    type_match = event_type == truth_type and shift == truth_shift
    if not type_match and event_type == "partialMove" and truth_type == "missingRing":
        type_match = shift is not None and shift <= -2 and truth_shift == -1
    if not type_match:
        return False
    if truth_type == "wholeSeriesMove":
        return True
    selected_year = integer(selected.get("selected_candidate_year"))
    truth_year = integer(truth.get("year"))
    return (
        selected_year is not None
        and truth_year is not None
        and abs(selected_year - truth_year) <= 6
    )


def attach_frontier_flags(frame: pd.DataFrame, resolved_cases: Path) -> pd.Series:
    cases = {
        int(case["index"]): case
        for case in json.loads(resolved_cases.read_text(encoding="utf-8"))
    }
    flags = []
    for _, row in frame.iterrows():
        if int(row["final_correct"]) == 1 or row["selected_event_type"] == "noEvent":
            flags.append(False)
            continue
        current = str(row.get("diagnosedTruthId") or "")
        remaining = set(truth_ids(row.get("remainingTruthIds"))) - {current}
        truths = cases[int(row["caseIndex"])].get("truths", [])
        flags.append(any(
            str(truth.get("truthId")) in remaining
            and selected_matches_truth(row, truth)
            for truth in truths
        ))
    return pd.Series(flags, index=frame.index, dtype=bool)


def failure_category(row: pd.Series) -> str:
    if int(row["final_correct"]) == 1:
        return "correct"
    if int(row["candidate_oracle"]) == 0:
        return "candidate_oracle_miss"
    if row["selected_event_type"] == "noEvent":
        return "refusal"
    if bool(row["frontier_error"]):
        return "frontier_selection"
    if int(row["identity_workflow_correct"]) == 0:
        return "operation_or_shift"
    return "window_location"


def grouped_metrics(
    frame: pd.DataFrame,
    *,
    repetitions: int,
    seed: str,
) -> dict:
    failures = frame[frame["final_correct"].eq(0)]["failure_category"].value_counts()
    return {
        "files": int(frame["file_id"].nunique()),
        "events": len(frame),
        "workflowCorrect": int(frame["final_correct"].sum()),
        "workflowAccuracy": float(frame["final_correct"].mean()),
        "workflowOneSided95FileClusterLower": clustered_lower(
            frame,
            "final_correct",
            repetitions=repetitions,
            seed=f"{seed}:workflow",
        ),
        "strictAccuracy": float(frame["final_strict_correct"].mean()),
        "responseRate": float(frame["response"].mean()),
        "candidateOracleAccuracy": float(frame["candidate_oracle"].mean()),
        "identityOracleAccuracy": float(frame["identity_workflow_correct"].mean()),
        "failures": {
            name: int(failures.get(name, 0))
            for name in (
                "candidate_oracle_miss",
                "operation_or_shift",
                "window_location",
                "frontier_selection",
                "refusal",
            )
        },
    }


def head_top_metrics(
    operation_rows: pd.DataFrame,
    score_rows: pd.DataFrame,
    identity_labels: pd.DataFrame,
) -> dict:
    if not operation_rows["identity_group"].equals(score_rows["identity_group"]):
        raise RuntimeError("operation candidate scores do not match identities")
    workflow = identity_labels.set_index("identity_group")["identity_workflow_oracle"]
    operation_rows = operation_rows.copy()
    operation_rows["identity_workflow_correct"] = operation_rows[
        "identity_group"
    ].map(workflow).fillna(operation_rows["operation_correct"]).astype(np.int8)
    result = {}
    for name, column in (
        ("listwise", "meta_oof_score"),
        ("pairwise", "pair_oof_score"),
        ("fused", "selection_oof_score"),
    ):
        top = (
            operation_rows.assign(_score=score_rows[column].to_numpy())
            .sort_values(["attempt_id", "_score"], ascending=[True, False])
            .groupby("attempt_id", sort=False)
            .head(1)
        )
        event = top[top["family"].ne("Clean")]
        result[name] = {
            "identityWorkflowTop1": int(event["identity_workflow_correct"].sum()),
            "identityWorkflowAccuracy": float(
                event["identity_workflow_correct"].mean()
            ),
            "exactOperationTop1": int(event["operation_correct"].sum()),
            "exactOperationAccuracy": float(event["operation_correct"].mean()),
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-attempts", required=True)
    parser.add_argument("--resolved-cases", required=True)
    parser.add_argument("--baseline-top", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--final-top", required=True)
    parser.add_argument("--operation-rows", required=True)
    parser.add_argument("--operation-oof-scores", required=True)
    parser.add_argument("--identity-labels", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=20000)
    args = parser.parse_args()

    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    event = pd.read_csv(args.event_attempts)
    event = event.drop(columns=[
        column
        for column in (
            "identity_group",
            "event_type",
            "shift_years",
            "operation_correct",
            "selected_candidate_year",
            "final_correct",
            "final_strict_correct",
        )
        if column in event
    ])
    event["attempt_key"] = event["attempt_id"].map(normalize_attempt)
    operation = pd.read_csv(args.operation_top)
    operation["attempt_key"] = operation["attempt_id"].map(normalize_attempt)
    final = pd.read_csv(args.final_top)
    if "final_strict_correct" not in final:
        final["final_strict_correct"] = final["final_correct"]
    final["attempt_key"] = final["attempt_id"].map(normalize_attempt)
    baseline = pd.read_csv(args.baseline_top)
    baseline["attempt_key"] = baseline["attempt_id"].map(normalize_attempt)

    selected = event.merge(
        operation[[
            "attempt_key",
            "event_type",
            "shift_years",
            "identity_group",
            "operation_correct",
            "identity_workflow_correct",
        ]].rename(columns={
            "event_type": "selected_event_type",
            "shift_years": "selected_shift_years",
        }),
        on="attempt_key",
        how="inner",
        validate="one_to_one",
    ).merge(
        final[[
            "attempt_key",
            "selected_candidate_year",
            "final_correct",
            "final_strict_correct",
        ]],
        on="attempt_key",
        how="inner",
        validate="one_to_one",
    ).merge(
        baseline[["attempt_key", "final_correct"]].rename(
            columns={"final_correct": "baseline_correct"}
        ),
        on="attempt_key",
        how="inner",
        validate="one_to_one",
    )
    selected["candidate_oracle"] = pd.to_numeric(
        selected["candidate_oracle"], errors="coerce"
    ).fillna(0).astype(np.int8)
    selected["response"] = selected["selected_event_type"].ne("noEvent").astype(
        np.int8
    )
    selected["frontier_error"] = attach_frontier_flags(
        selected, Path(args.resolved_cases).resolve()
    )
    selected["failure_category"] = selected.apply(failure_category, axis=1)

    event_selected = selected[selected["family"].ne("Clean")].copy()
    overall = grouped_metrics(
        event_selected,
        repetitions=args.bootstrap_repetitions,
        seed="overall",
    )
    overall["correctToWrong"] = int((
        event_selected["baseline_correct"].eq(1)
        & event_selected["final_correct"].eq(0)
    ).sum())
    overall["wrongToCorrect"] = int((
        event_selected["baseline_correct"].eq(0)
        & event_selected["final_correct"].eq(1)
    ).sum())
    clean_operation = operation[operation["family"].eq("Clean")]
    overall["cleanFalsePositives"] = int(
        clean_operation["event_type"].ne("noEvent").sum()
    )
    overall["cleanAttempts"] = len(clean_operation)

    by_family = {
        str(family): grouped_metrics(
            group,
            repetitions=args.bootstrap_repetitions,
            seed=f"family:{family}",
        )
        for family, group in event_selected.groupby("family", sort=True)
    }
    strata_rows = []
    for dimension in ("file_correlation_bin", "target_correlation_bin"):
        for level, group in event_selected.groupby(dimension, sort=True):
            metrics = grouped_metrics(
                group,
                repetitions=args.bootstrap_repetitions,
                seed=f"{dimension}:{level}",
            )
            strata_rows.append({"dimension": dimension, "level": level, **{
                key: value for key, value in metrics.items() if key != "failures"
            }, **{
                f"failure_{key}": value
                for key, value in metrics["failures"].items()
            }})
    strata = pd.DataFrame(strata_rows)

    all_failure_rows = event_selected[event_selected["final_correct"].eq(0)]
    all_failure_confusion = pd.crosstab(
        all_failure_rows["truth_type"],
        all_failure_rows["selected_event_type"],
        margins=True,
    )
    operation_failure_rows = event_selected[
        event_selected["failure_category"].eq("operation_or_shift")
    ]
    operation_confusion = pd.crosstab(
        operation_failure_rows["truth_type"],
        operation_failure_rows["selected_event_type"],
        margins=True,
    )
    operation_rows = pd.read_pickle(args.operation_rows).reset_index(drop=True)
    operation_scores = pd.read_pickle(args.operation_oof_scores).reset_index(drop=True)
    identity_labels = pd.read_pickle(args.identity_labels)
    head_metrics = head_top_metrics(operation_rows, operation_scores, identity_labels)

    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "candidateGeneratorFrozen": True,
        "overall": overall,
        "byFamily": by_family,
        "operationHeads": head_metrics,
    }
    selected.to_csv(output / "attempts.csv", index=False)
    strata.to_csv(output / "correlation-strata.csv", index=False)
    operation_confusion.to_csv(output / "operation-confusion.csv")
    all_failure_confusion.to_csv(output / "all-failure-confusion.csv")
    (output / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output), **payload}, ensure_ascii=False))


if __name__ == "__main__":
    main()
