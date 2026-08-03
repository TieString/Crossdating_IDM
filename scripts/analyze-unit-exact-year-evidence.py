"""Rank exact-year evidence without touching a frozen holdout."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Iterable


EVENT_TYPES = ("missingRing", "falseRing")
SHIFTS = (-2, -1, 0, 1, 2)
BLENDS = (0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0)


@dataclass(frozen=True)
class Case:
    split: str
    event_type: str
    truth_year: int
    years: tuple[int, ...]
    baseline: tuple[float, ...]
    fixed: dict[str, tuple[float, ...]]
    profiles: dict[str, tuple[float, ...]]


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


def load_cases(path: Path) -> list[Case]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    result: list[Case] = []
    for row in raw:
        event_type = str(row.get("eventType", ""))
        if event_type not in EVENT_TYPES:
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
        fixed_names = set.intersection(*(
            set(item) for item in row["fixedFeatures"]
        ))
        fixed = {
            name: tuple(float(item[name]) for item in row["fixedFeatures"])
            for name in fixed_names
        }
        profiles = {
            str(name): tuple(float(value) for value in values)
            for name, values in row["profileScores"].items()
            if len(values) == len(years)
        }
        result.append(Case(
            split=str(row["split"]),
            event_type=event_type,
            truth_year=truth_year,
            years=years,
            baseline=tuple(baseline_by_year[year] for year in years),
            fixed=fixed,
            profiles=profiles,
        ))
    return result


def shifted(values: tuple[float, ...], shift: int) -> list[float]:
    floor = min(values) - max(1.0, abs(max(values) - min(values)))
    return [
        values[index - shift] if 0 <= index - shift < len(values) else floor
        for index in range(len(values))
    ]


def ranked_years(case: Case, scores: list[float]) -> list[int]:
    return [
        case.years[index]
        for index in sorted(
            range(len(case.years)),
            key=lambda index: (-scores[index], -case.years[index]),
        )
    ]


def summarize(cases: list[Case], scores_by_case: list[list[float]]) -> dict[str, float]:
    exact = within_one = top_three = 0
    ranks: list[int] = []
    errors: list[int] = []
    for case, scores in zip(cases, scores_by_case, strict=True):
        ordered = ranked_years(case, scores)
        top_year = ordered[0]
        rank = ordered.index(case.truth_year) + 1
        error = top_year - case.truth_year
        exact += int(error == 0)
        within_one += int(abs(error) <= 1)
        top_three += int(rank <= 3)
        ranks.append(rank)
        errors.append(error)
    count = max(1, len(cases))
    return {
        "cases": len(cases),
        "top1": exact / count,
        "withinOne": within_one / count,
        "top3": top_three / count,
        "medianRank": float(median(ranks)) if ranks else 0.0,
        "mrr": sum(1 / rank for rank in ranks) / count,
        "bias": sum(errors) / count,
        "meanAbsoluteError": sum(abs(error) for error in errors) / count,
    }


def score_source(
    cases: list[Case],
    source_kind: str,
    source_name: str,
    shift: int,
    blend: float,
) -> list[list[float]]:
    result: list[list[float]] = []
    for case in cases:
        source = case.fixed[source_name] if source_kind == "fixed" else case.profiles[source_name]
        evidence = percentile_ranks(shifted(source, shift))
        baseline = percentile_ranks(case.baseline)
        result.append([
            baseline[index] * (1 - blend) + evidence[index] * blend
            for index in range(len(case.years))
        ])
    return result


def delta(metrics: dict[str, float], baseline: dict[str, float], name: str) -> float:
    return metrics[name] - baseline[name]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--top", type=int, default=100)
    args = parser.parse_args()

    all_cases = load_cases(Path(args.dataset))
    report: dict[str, object] = {
        "schemaVersion": 1,
        "dataset": args.dataset,
        "eventTypes": {},
    }
    for event_type in EVENT_TYPES:
        by_split = {
            split: [
                case for case in all_cases
                if case.event_type == event_type and case.split == split
            ]
            for split in ("train", "calibration")
        }
        baselines = {
            split: summarize(cases, [list(case.baseline) for case in cases])
            for split, cases in by_split.items()
        }
        if any(not cases for cases in by_split.values()):
            continue
        fixed_names = sorted(set.intersection(*(
            set(case.fixed) for case in [*by_split["train"], *by_split["calibration"]]
        )))
        profile_names = sorted(set.intersection(*(
            set(case.profiles) for case in [*by_split["train"], *by_split["calibration"]]
        )))
        candidates = []
        for source_kind, names in (("fixed", fixed_names), ("profile", profile_names)):
            for source_name in names:
                for shift in SHIFTS:
                    for blend in BLENDS:
                        metrics = {
                            split: summarize(
                                cases,
                                score_source(cases, source_kind, source_name, shift, blend),
                            )
                            for split, cases in by_split.items()
                        }
                        train_delta = delta(metrics["train"], baselines["train"], "top1")
                        calibration_delta = delta(
                            metrics["calibration"], baselines["calibration"], "top1"
                        )
                        if train_delta <= 0 or calibration_delta <= 0:
                            continue
                        score = (
                            min(train_delta, calibration_delta),
                            train_delta + calibration_delta,
                            min(
                                delta(metrics["train"], baselines["train"], "mrr"),
                                delta(
                                    metrics["calibration"],
                                    baselines["calibration"],
                                    "mrr",
                                ),
                            ),
                            -abs(metrics["calibration"]["bias"]),
                        )
                        candidates.append({
                            "selectionScore": score,
                            "sourceKind": source_kind,
                            "sourceName": source_name,
                            "shift": shift,
                            "blend": blend,
                            "metrics": metrics,
                        })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        report["eventTypes"][event_type] = {
            "counts": {split: len(cases) for split, cases in by_split.items()},
            "baseline": baselines,
            "candidates": candidates[: args.top],
        }
        print(json.dumps({
            "eventType": event_type,
            "counts": report["eventTypes"][event_type]["counts"],
            "baseline": baselines,
            "topCandidates": candidates[:10],
        }, indent=2))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
