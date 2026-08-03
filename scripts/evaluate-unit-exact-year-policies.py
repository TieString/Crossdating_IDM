"""Evaluate preselected exact-year blends without refitting or retuning them."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import median
from typing import Any, Iterable


EVENT_TYPES = ("missingRing", "falseRing")


def percentile_ranks(values: Iterable[float]) -> list[float]:
    rows = list(values)
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
    return result


def shifted(values: list[float], shift: int) -> list[float]:
    floor = min(values) - max(1.0, abs(max(values) - min(values)))
    return [
        values[index - shift] if 0 <= index - shift < len(values) else floor
        for index in range(len(values))
    ]


def summarize(rows: list[dict[str, Any]], score_rows: list[list[float]]) -> dict[str, float]:
    exact = within_one = top_three = 0
    reciprocal = bias = absolute_error = 0.0
    ranks: list[int] = []
    for row, scores in zip(rows, score_rows, strict=True):
        years = [int(year) for year in row["years"]]
        truth_year = int(row["truthYear"])
        order = sorted(
            range(len(years)),
            key=lambda index: (-scores[index], -years[index]),
        )
        ranked = [years[index] for index in order]
        top_year = ranked[0]
        truth_rank = ranked.index(truth_year) + 1
        error = top_year - truth_year
        exact += int(error == 0)
        within_one += int(abs(error) <= 1)
        top_three += int(truth_rank <= 3)
        reciprocal += 1 / truth_rank
        bias += error
        absolute_error += abs(error)
        ranks.append(truth_rank)
    count = max(1, len(rows))
    return {
        "cases": len(rows),
        "top1": exact / count,
        "withinOne": within_one / count,
        "top3": top_three / count,
        "medianRank": float(median(ranks)) if ranks else 0.0,
        "mrr": reciprocal / count,
        "bias": bias / count,
        "meanAbsoluteError": absolute_error / count,
    }


def baseline_scores(row: dict[str, Any]) -> list[float]:
    score_by_year = {
        int(item["year"]): float(item["score"])
        for item in row["baselineRanked"]
    }
    return percentile_ranks(score_by_year[int(year)] for year in row["years"])


def source_scores(row: dict[str, Any], source: dict[str, Any]) -> list[float]:
    if source["kind"] == "fixed":
        values = [
            float(features[source["name"]])
            for features in row["fixedFeatures"]
        ]
    else:
        values = [float(value) for value in row["profileScores"][source["name"]]]
    return percentile_ranks(shifted(values, int(source["shift"])))


def policy_scores(row: dict[str, Any], policy: dict[str, Any]) -> list[float]:
    baseline = baseline_scores(row)
    first = source_scores(row, policy["first"])
    second = source_scores(row, policy["second"])
    first_weight = float(policy["firstWeight"])
    second_weight = float(policy["secondWeight"])
    baseline_weight = 1 - first_weight - second_weight
    return [
        baseline[index] * baseline_weight
        + first[index] * first_weight
        + second[index] * second_weight
        for index in range(len(baseline))
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--policies", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--top", type=int, default=20)
    args = parser.parse_args()

    rows = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    policy_report = json.loads(Path(args.policies).read_text(encoding="utf-8"))
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in EVENT_TYPES:
        typed = [row for row in rows if row.get("eventType") == event_type]
        baseline = summarize(typed, [baseline_scores(row) for row in typed])
        candidates = []
        for index, policy in enumerate(
            policy_report["eventTypes"][event_type]["candidates"][:args.top]
        ):
            metrics = summarize(typed, [policy_scores(row, policy) for row in typed])
            candidates.append({
                "sourceRank": index + 1,
                "first": policy["first"],
                "firstWeight": policy["firstWeight"],
                "second": policy["second"],
                "secondWeight": policy["secondWeight"],
                "metrics": metrics,
                "delta": {
                    name: metrics[name] - baseline[name]
                    for name in ("top1", "withinOne", "top3", "mrr")
                },
            })
        report["eventTypes"][event_type] = {
            "baseline": baseline,
            "candidates": candidates,
        }
        print(json.dumps({
            "eventType": event_type,
            "baseline": baseline,
            "candidates": candidates,
        }, indent=2))
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
