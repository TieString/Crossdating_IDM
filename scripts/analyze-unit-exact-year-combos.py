"""Search small, explainable exact-year evidence blends across independent cohorts."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Iterable


EVENT_TYPES = ("missingRing", "falseRing")
WEIGHTS = (0.1, 0.2, 0.3, 0.4, 0.5)


@dataclass(frozen=True)
class Source:
    kind: str
    name: str
    shift: int


@dataclass(frozen=True)
class Case:
    split: str
    cohort: str
    event_type: str
    truth_year: int
    years: tuple[int, ...]
    baseline: tuple[float, ...]
    sources: dict[Source, tuple[float, ...]]


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


def cohort_for(path: str, split: str) -> str:
    lowered = path.lower()
    for offset in (31, 47):
        if f"{split}{offset}" in lowered:
            return f"{split}{offset}"
    return split


def selected_sources(report: dict[str, Any], event_type: str, limit: int) -> list[Source]:
    result: list[Source] = []
    seen: set[Source] = set()
    for row in report["eventTypes"][event_type]["candidates"]:
        source = Source(
            kind=str(row["sourceKind"]),
            name=str(row["sourceName"]),
            shift=int(row["shift"]),
        )
        if source in seen:
            continue
        seen.add(source)
        result.append(source)
        if len(result) >= limit:
            break
    return result


def load_cases(
    dataset_path: Path,
    report: dict[str, Any],
    candidate_limit: int,
) -> dict[str, list[Case]]:
    raw = json.loads(dataset_path.read_text(encoding="utf-8"))
    sources_by_type = {
        event_type: selected_sources(report, event_type, candidate_limit)
        for event_type in EVENT_TYPES
    }
    result = {event_type: [] for event_type in EVENT_TYPES}
    for row in raw:
        event_type = str(row.get("eventType", ""))
        if event_type not in result:
            continue
        years = tuple(int(year) for year in row["years"])
        truth_year = int(row["truthYear"])
        if truth_year not in years:
            continue
        baseline_by_year = {
            int(item["year"]): float(item["score"])
            for item in row["baselineRanked"]
        }
        if any(year not in baseline_by_year for year in years):
            continue
        fixed = {
            name: tuple(float(item[name]) for item in row["fixedFeatures"])
            for name in row["fixedFeatures"][0]
        }
        profiles = {
            str(name): tuple(float(value) for value in values)
            for name, values in row["profileScores"].items()
            if len(values) == len(years)
        }
        source_values: dict[Source, tuple[float, ...]] = {}
        for source in sources_by_type[event_type]:
            available = fixed if source.kind == "fixed" else profiles
            if source.name not in available:
                break
            source_values[source] = percentile_ranks(shifted(
                available[source.name],
                source.shift,
            ))
        else:
            split = str(row["split"])
            result[event_type].append(Case(
                split=split,
                cohort=cohort_for(str(row.get("sourceAudit", "")), split),
                event_type=event_type,
                truth_year=truth_year,
                years=years,
                baseline=percentile_ranks(baseline_by_year[year] for year in years),
                sources=source_values,
            ))
    return result


def scores_for(
    case: Case,
    first: Source,
    first_weight: float,
    second: Source | None = None,
    second_weight: float = 0.0,
) -> list[float]:
    baseline_weight = 1 - first_weight - second_weight
    return [
        case.baseline[index] * baseline_weight
        + case.sources[first][index] * first_weight
        + (case.sources[second][index] * second_weight if second else 0.0)
        for index in range(len(case.years))
    ]


def summarize(
    cases: list[Case],
    score_rows: list[list[float]] | None = None,
) -> dict[str, float]:
    exact = within_one = top_three = 0
    reciprocal = bias = absolute_error = 0.0
    ranks: list[int] = []
    for case_index, case in enumerate(cases):
        scores = score_rows[case_index] if score_rows is not None else case.baseline
        order = sorted(
            range(len(case.years)),
            key=lambda index: (-scores[index], -case.years[index]),
        )
        ranked = [case.years[index] for index in order]
        top_year = ranked[0]
        truth_rank = ranked.index(case.truth_year) + 1
        error = top_year - case.truth_year
        exact += int(error == 0)
        within_one += int(abs(error) <= 1)
        top_three += int(truth_rank <= 3)
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
    }


def delta(metrics: dict[str, float], baseline: dict[str, float], name: str) -> float:
    return metrics[name] - baseline[name]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--candidate-limit", type=int, default=40)
    parser.add_argument("--top", type=int, default=100)
    args = parser.parse_args()

    candidate_report = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    by_type = load_cases(
        Path(args.dataset),
        candidate_report,
        args.candidate_limit,
    )
    output: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type, cases in by_type.items():
        sources = selected_sources(candidate_report, event_type, args.candidate_limit)
        cohorts = sorted({case.cohort for case in cases})
        groups = {
            **{cohort: [case for case in cases if case.cohort == cohort] for cohort in cohorts},
            "train": [case for case in cases if case.split == "train"],
            "calibration": [case for case in cases if case.split == "calibration"],
        }
        baselines = {name: summarize(rows) for name, rows in groups.items()}
        candidates: list[dict[str, Any]] = []
        pairs = [
            (first, second)
            for first_index, first in enumerate(sources)
            for second in sources[first_index + 1:]
        ]
        for first, second in pairs:
            for first_weight in WEIGHTS:
                for second_weight in WEIGHTS:
                    if first_weight + second_weight > 0.8:
                        continue
                    metrics = {
                        name: summarize(rows, [
                            scores_for(
                                case,
                                first,
                                first_weight,
                                second,
                                second_weight,
                            )
                            for case in rows
                        ])
                        for name, rows in groups.items()
                    }
                    cohort_deltas = [
                        delta(metrics[name], baselines[name], "top1")
                        for name in cohorts
                    ]
                    if min(cohort_deltas, default=0.0) < 0:
                        continue
                    train_delta = delta(metrics["train"], baselines["train"], "top1")
                    calibration_delta = delta(
                        metrics["calibration"],
                        baselines["calibration"],
                        "top1",
                    )
                    if train_delta <= 0 or calibration_delta <= 0:
                        continue
                    candidates.append({
                        "selectionScore": (
                            min(cohort_deltas),
                            min(train_delta, calibration_delta),
                            sum(cohort_deltas),
                            min(
                                delta(metrics["train"], baselines["train"], "mrr"),
                                delta(
                                    metrics["calibration"],
                                    baselines["calibration"],
                                    "mrr",
                                ),
                            ),
                            -abs(metrics["calibration"]["bias"]),
                        ),
                        "first": first.__dict__,
                        "firstWeight": first_weight,
                        "second": second.__dict__,
                        "secondWeight": second_weight,
                        "metrics": metrics,
                    })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        output["eventTypes"][event_type] = {
            "counts": {name: len(rows) for name, rows in groups.items()},
            "baselines": baselines,
            "candidates": candidates[:args.top],
        }
        print(json.dumps({
            "eventType": event_type,
            "counts": output["eventTypes"][event_type]["counts"],
            "baseline": {name: value["top1"] for name, value in baselines.items()},
            "topCandidates": candidates[:5],
        }, indent=2))
    Path(args.output).write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
