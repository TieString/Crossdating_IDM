"""Find conservative gates for fixed exact-year evidence policies."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Iterable


EVENT_TYPES = ("missingRing", "falseRing")
MAXIMUM_TOP_DISTANCES = (1, 2, 3, 5, 99)
MINIMUM_POLICY_MARGINS = (0.0, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2)
MAXIMUM_BASELINE_MARGINS = (0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 1.0)
MINIMUM_TOP_ADVANTAGES = (0.0, 0.025, 0.05, 0.075, 0.1)


@dataclass(frozen=True)
class Case:
    group: str
    event_type: str
    truth_year: int
    years: tuple[int, ...]
    baseline: tuple[float, ...]
    raw: dict[str, Any]


def percentile_ranks(values: Iterable[float]) -> tuple[float, ...]:
    rows = tuple(values)
    ordered = sorted(range(len(rows)), key=lambda index: (rows[index], index))
    result = [0.0] * len(rows)
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and rows[ordered[end]] == rows[ordered[start]]:
            end += 1
        rank = 0.5 if len(rows) <= 1 else (start + end - 1) / (2 * (len(rows) - 1))
        for offset in range(start, end):
            result[ordered[offset]] = rank
        start = end
    return tuple(result)


def shifted(values: tuple[float, ...], shift: int) -> tuple[float, ...]:
    floor = min(values) - max(1.0, abs(max(values) - min(values)))
    return tuple(
        values[index - shift] if 0 <= index - shift < len(values) else floor
        for index in range(len(values))
    )


def group_for(label: str, row: dict[str, Any]) -> str:
    if label != "development":
        return label
    split = str(row.get("split", "development"))
    source = str(row.get("sourceAudit", "")).lower()
    for offset in (31, 47):
        if f"{split}{offset}" in source:
            return f"{split}{offset}"
    return split


def load_cases(sources: list[str]) -> list[Case]:
    result: list[Case] = []
    for source in sources:
        label, raw_path = source.split("=", 1)
        rows = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        for row in rows:
            event_type = str(row.get("eventType", ""))
            if event_type not in EVENT_TYPES:
                continue
            years = tuple(int(year) for year in row["years"])
            truth_year = int(row["truthYear"])
            if truth_year not in years:
                continue
            by_year = {
                int(item["year"]): float(item["score"])
                for item in row["baselineRanked"]
            }
            if any(year not in by_year for year in years):
                continue
            result.append(Case(
                group=group_for(label, row),
                event_type=event_type,
                truth_year=truth_year,
                years=years,
                baseline=percentile_ranks(by_year[year] for year in years),
                raw=row,
            ))
    return result


def source_scores(case: Case, source: dict[str, Any]) -> tuple[float, ...]:
    if source["kind"] == "fixed":
        values = tuple(
            float(features[source["name"]])
            for features in case.raw["fixedFeatures"]
        )
    else:
        values = tuple(
            float(value)
            for value in case.raw["profileScores"][source["name"]]
        )
    return percentile_ranks(shifted(values, int(source["shift"])))


def policy_scores(case: Case, policy: dict[str, Any]) -> tuple[float, ...]:
    first = source_scores(case, policy["first"])
    second = source_scores(case, policy["second"])
    first_weight = float(policy["firstWeight"])
    second_weight = float(policy["secondWeight"])
    baseline_weight = 1 - first_weight - second_weight
    return tuple(
        case.baseline[index] * baseline_weight
        + first[index] * first_weight
        + second[index] * second_weight
        for index in range(len(case.years))
    )


def order(scores: tuple[float, ...], years: tuple[int, ...]) -> list[int]:
    return sorted(
        range(len(years)),
        key=lambda index: (-scores[index], -years[index]),
    )


def gated_scores(
    case: Case,
    policy: tuple[float, ...],
    gate: dict[str, float],
) -> tuple[float, ...]:
    baseline_order = order(case.baseline, case.years)
    policy_order = order(policy, case.years)
    baseline_top = baseline_order[0]
    policy_top = policy_order[0]
    if baseline_top == policy_top:
        return case.baseline
    baseline_margin = case.baseline[baseline_top] - case.baseline[baseline_order[1]]
    policy_margin = policy[policy_top] - policy[policy_order[1]]
    top_advantage = policy[policy_top] - policy[baseline_top]
    use_policy = (
        abs(case.years[policy_top] - case.years[baseline_top])
        <= gate["maximumTopDistance"]
        and policy_margin >= gate["minimumPolicyMargin"]
        and baseline_margin <= gate["maximumBaselineMargin"]
        and top_advantage >= gate["minimumTopAdvantage"]
    )
    return policy if use_policy else case.baseline


def summarize(
    cases: list[Case],
    score_rows: list[tuple[float, ...]],
) -> dict[str, float]:
    exact = within_one = top_three = changes = gains = losses = 0
    reciprocal = bias = absolute_error = 0.0
    ranks: list[int] = []
    for case, scores in zip(cases, score_rows, strict=True):
        baseline_top = order(case.baseline, case.years)[0]
        selected_order = order(scores, case.years)
        top_index = selected_order[0]
        top_year = case.years[top_index]
        truth_rank = [case.years[index] for index in selected_order].index(
            case.truth_year
        ) + 1
        error = top_year - case.truth_year
        was_exact = case.years[baseline_top] == case.truth_year
        is_exact = error == 0
        exact += int(is_exact)
        within_one += int(abs(error) <= 1)
        top_three += int(truth_rank <= 3)
        changes += int(top_index != baseline_top)
        gains += int(is_exact and not was_exact)
        losses += int(was_exact and not is_exact)
        reciprocal += 1 / truth_rank
        bias += error
        absolute_error += abs(error)
        ranks.append(truth_rank)
    count = max(1, len(cases))
    return {
        "cases": len(cases),
        "top1": exact / count,
        "withinOne": within_one / count,
        "top3": top_three / count,
        "medianRank": float(median(ranks)) if ranks else 0.0,
        "mrr": reciprocal / count,
        "bias": bias / count,
        "meanAbsoluteError": absolute_error / count,
        "changes": changes,
        "gains": gains,
        "losses": losses,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--policies", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--top-policies", type=int, default=20)
    parser.add_argument("--top", type=int, default=100)
    args = parser.parse_args()

    all_cases = load_cases(args.source)
    policy_report = json.loads(Path(args.policies).read_text(encoding="utf-8"))
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in EVENT_TYPES:
        typed = [case for case in all_cases if case.event_type == event_type]
        group_names = sorted({case.group for case in typed})
        groups = {
            name: [case for case in typed if case.group == name]
            for name in group_names
        }
        baselines = {
            name: summarize(rows, [case.baseline for case in rows])
            for name, rows in groups.items()
        }
        candidates = []
        for policy_index, policy in enumerate(
            policy_report["eventTypes"][event_type]["candidates"][
                :args.top_policies
            ]
        ):
            policy_by_case = {
                id(case): policy_scores(case, policy)
                for case in typed
            }
            for maximum_distance in MAXIMUM_TOP_DISTANCES:
                for minimum_margin in MINIMUM_POLICY_MARGINS:
                    for maximum_baseline_margin in MAXIMUM_BASELINE_MARGINS:
                        for minimum_advantage in MINIMUM_TOP_ADVANTAGES:
                            gate = {
                                "maximumTopDistance": maximum_distance,
                                "minimumPolicyMargin": minimum_margin,
                                "maximumBaselineMargin": maximum_baseline_margin,
                                "minimumTopAdvantage": minimum_advantage,
                            }
                            metrics = {
                                name: summarize(rows, [
                                    gated_scores(case, policy_by_case[id(case)], gate)
                                    for case in rows
                                ])
                                for name, rows in groups.items()
                            }
                            top1_deltas = [
                                metrics[name]["top1"] - baselines[name]["top1"]
                                for name in group_names
                            ]
                            within_one_deltas = [
                                metrics[name]["withinOne"]
                                - baselines[name]["withinOne"]
                                for name in group_names
                            ]
                            top_three_deltas = [
                                metrics[name]["top3"] - baselines[name]["top3"]
                                for name in group_names
                            ]
                            if min(top1_deltas, default=0.0) < 0:
                                continue
                            if min(within_one_deltas, default=0.0) < 0:
                                continue
                            if min(top_three_deltas, default=0.0) < 0:
                                continue
                            mrr_deltas = [
                                metrics[name]["mrr"] - baselines[name]["mrr"]
                                for name in group_names
                            ]
                            candidates.append({
                                "selectionScore": (
                                    min(top1_deltas),
                                    min(within_one_deltas),
                                    min(top_three_deltas),
                                    sum(top1_deltas),
                                    sum(within_one_deltas),
                                    sum(top_three_deltas),
                                    min(mrr_deltas),
                                    sum(mrr_deltas),
                                    -sum(row["changes"] for row in metrics.values()),
                                ),
                                "sourceRank": policy_index + 1,
                                "first": policy["first"],
                                "firstWeight": policy["firstWeight"],
                                "second": policy["second"],
                                "secondWeight": policy["secondWeight"],
                                "gate": gate,
                                "metrics": metrics,
                            })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        report["eventTypes"][event_type] = {
            "counts": {name: len(rows) for name, rows in groups.items()},
            "baselines": baselines,
            "candidates": candidates[:args.top],
        }
        print(json.dumps({
            "eventType": event_type,
            "counts": report["eventTypes"][event_type]["counts"],
            "topCandidates": candidates[:5],
        }, indent=2))
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
