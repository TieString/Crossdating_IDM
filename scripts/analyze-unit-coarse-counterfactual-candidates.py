"""Compare explainable coarse-candidate counterfactual selectors.

This is an audit-only search. It never changes the production locator. Rules are
chosen on the train file split and reported separately on the calibration split.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Callable, Iterable, Sequence


@dataclass(frozen=True)
class Candidate:
    start: int
    end: int
    source: str
    profiles: dict[str, dict[str, float]]
    peak_median: float
    peak_mad: float


@dataclass(frozen=True)
class Case:
    dataset: str
    event_type: str
    group: str
    truth: int
    current_start: int
    current_end: int
    baseline_index: int
    candidates: tuple[Candidate, ...]

    @property
    def current_hit(self) -> bool:
        return self.current_start <= self.truth <= self.current_end

    def candidate_hit(self, index: int) -> bool:
        candidate = self.candidates[index]
        return candidate.start <= self.truth <= candidate.end


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def percentile_ranks(values: Sequence[float]) -> list[float]:
    if len(values) <= 1:
        return [0.5] * len(values)
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + end - 1) / (2 * (len(order) - 1))
        for index in order[start:end]:
            result[index] = rank
        start = end
    return result


def profile_family(name: str) -> str:
    lowered = name.lower()
    if "reference" in lowered:
        return "reference"
    if "master" in lowered:
        return "master"
    if "predictive" in lowered:
        return "predictive"
    return "other"


def summarize_rows(rows: Sequence[dict[str, Any]]) -> tuple[
    dict[str, dict[str, float]], float, float
]:
    profile_names = sorted({
        name
        for row in rows
        for name in (row.get("profiles") or {}).keys()
    })
    summaries: dict[str, dict[str, float]] = {}
    peak_years = []
    for name in profile_names:
        values = [
            (int(row["year"]), float((row.get("profiles") or {}).get(name, -10)))
            for row in rows
        ]
        ordered = sorted((value for _, value in values), reverse=True)
        selected_year, maximum = max(values, key=lambda row: (row[1], row[0]))
        center = median(value for _, value in values)
        deviation = math.sqrt(mean((value - mean(ordered)) ** 2 for value in ordered))
        summaries[name] = {
            "maximum": maximum,
            "mean": mean(ordered),
            "top3": mean(ordered[:3]),
            "top5": mean(ordered[:5]),
            "prominence": maximum - center,
            "deviation": deviation,
            "peakYear": float(selected_year),
        }
        peak_years.append(float(selected_year))
    peak_center = median(peak_years) if peak_years else 0.0
    peak_mad = median(abs(value - peak_center) for value in peak_years) \
        if peak_years else 0.0
    return summaries, peak_center, peak_mad


def overlap_ratio(left: tuple[int, int], right: tuple[int, int]) -> float:
    intersection = max(0, min(left[1], right[1]) - max(left[0], right[0]) + 1)
    union = max(left[1], right[1]) - min(left[0], right[0]) + 1
    return intersection / max(1, union)


def load(path: Path, dataset: str) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = []
    seen = set()
    for source in payload.get("counterfactualLocatorCases", []):
        context = source.get("context", {})
        event_type = source.get("eventType")
        audited = source.get("coarseCandidateCounterfactuals") or []
        candidates = source.get("candidates") or []
        key = (
            str(context.get("file", "")).lower(),
            str(context.get("target", "")).lower(),
            int(source.get("truthYear", 0)),
            event_type,
        )
        if (
            key in seen
            or context.get("baselineFlagged", True)
            or event_type not in ("missingRing", "falseRing")
            or source.get("correctionYears") != source.get("truthCorrectionYears")
            or not audited
            or not candidates
        ):
            continue
        seen.add(key)
        prepared = []
        for row in audited:
            index = int(row["candidateIndex"])
            candidate = candidates[index]
            score_window = row["scoreWindow"]
            summaries, peak_center, peak_mad = summarize_rows(row.get("rows") or [])
            prepared.append(Candidate(
                start=int(score_window["startYear"]),
                end=int(score_window["endYear"]),
                source=str(candidate.get("source", row.get("source", ""))),
                profiles=summaries,
                peak_median=peak_center,
                peak_mad=peak_mad,
            ))
        coarse = source["coarseWindow"]
        coarse_range = (int(coarse["startYear"]), int(coarse["endYear"]))
        coarse_source = str(source.get("coarseSource", ""))
        baseline_index = max(
            range(len(prepared)),
            key=lambda index: (
                prepared[index].source == coarse_source,
                overlap_ratio(
                    (prepared[index].start, prepared[index].end),
                    coarse_range,
                ),
            ),
        )
        result.append(Case(
            dataset=dataset,
            event_type=str(event_type),
            group=key[0],
            truth=key[2],
            current_start=coarse_range[0],
            current_end=coarse_range[1],
            baseline_index=baseline_index,
            candidates=tuple(prepared),
        ))
    return result


ScoreRule = Callable[[Case], list[float]]


def build_rules(cases: Sequence[Case]) -> dict[str, ScoreRule]:
    profile_names = sorted({
        name for case in cases for candidate in case.candidates
        for name in candidate.profiles
    })
    rules: dict[str, ScoreRule] = {}
    statistics = ("maximum", "top3", "top5", "prominence", "deviation")

    def ranked_stat(
        case: Case,
        names: Sequence[str],
        statistic: str,
    ) -> list[float]:
        per_profile = []
        for name in names:
            values = [
                candidate.profiles.get(name, {}).get(statistic, -10)
                for candidate in case.candidates
            ]
            per_profile.append(percentile_ranks(values))
        return [
            mean(profile[index] for profile in per_profile)
            for index in range(len(case.candidates))
        ]

    for name in profile_names:
        for statistic in statistics:
            rules[f"profile:{name}:{statistic}"] = (
                lambda case, selected=name, stat=statistic: ranked_stat(
                    case, (selected,), stat
                )
            )
    for family in ("all", "master", "reference", "predictive"):
        names = profile_names if family == "all" else [
            name for name in profile_names if profile_family(name) == family
        ]
        if not names:
            continue
        for statistic in statistics:
            rules[f"family:{family}:{statistic}"] = (
                lambda case, selected=tuple(names), stat=statistic: ranked_stat(
                    case, selected, stat
                )
            )
    rules["peak:agreement"] = lambda case: percentile_ranks([
        -candidate.peak_mad for candidate in case.candidates
    ])
    rules["peak:centered"] = lambda case: percentile_ranks([
        -abs(candidate.peak_median - (candidate.start + candidate.end) / 2)
        for candidate in case.candidates
    ])
    rules["combined:all"] = lambda case: [
        mean(rows[index] for rows in (
            ranked_stat(case, profile_names, "maximum"),
            ranked_stat(case, profile_names, "top3"),
            ranked_stat(case, profile_names, "prominence"),
            rules["peak:agreement"](case),
            rules["peak:centered"](case),
        ))
        for index in range(len(case.candidates))
    ]
    return rules


def apply_rule(case: Case, rule: ScoreRule, threshold: float) -> tuple[int, bool]:
    scores = rule(case)
    selected = max(
        range(len(scores)),
        key=lambda index: (
            scores[index],
            index == case.baseline_index,
            -index,
        ),
    )
    margin = scores[selected] - scores[case.baseline_index]
    changed = selected != case.baseline_index and margin >= threshold
    return (selected if changed else case.baseline_index), changed


def summarize(cases: Sequence[Case], rule: ScoreRule, threshold: float) -> dict[str, Any]:
    current = sum(case.current_hit for case in cases)
    selected = []
    changes = 0
    gains = 0
    losses = 0
    for case in cases:
        index, changed = apply_rule(case, rule, threshold)
        hit = case.candidate_hit(index) if changed else case.current_hit
        selected.append(hit)
        changes += changed
        gains += changed and not case.current_hit and hit
        losses += changed and case.current_hit and not hit
    return {
        "cases": len(cases),
        "currentHits": current,
        "newHits": sum(selected),
        "delta": sum(selected) - current,
        "gains": gains,
        "losses": losses,
        "changes": changes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument(
        "--report",
        default=".tmp-unit-coarse-counterfactual-candidate-report.json",
    )
    args = parser.parse_args()
    cases = [
        *load(Path(args.train), "train"),
        *load(Path(args.calibration), "calibration"),
    ]
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in ("missingRing", "falseRing"):
        train = [
            case for case in cases
            if case.dataset == "train" and case.event_type == event_type
        ]
        calibration = [
            case for case in cases
            if case.dataset == "calibration" and case.event_type == event_type
        ]
        rules = build_rules(train)
        candidates = []
        for name, rule in rules.items():
            for threshold in (0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5):
                train_summary = summarize(train, rule, threshold)
                calibration_summary = summarize(calibration, rule, threshold)
                if train_summary["delta"] <= 0:
                    continue
                score = (
                    min(train_summary["delta"], calibration_summary["delta"]),
                    calibration_summary["delta"],
                    train_summary["delta"],
                    -calibration_summary["losses"],
                    -train_summary["losses"],
                    -train_summary["changes"],
                )
                candidates.append({
                    "selectionScore": score,
                    "rule": name,
                    "threshold": threshold,
                    "train": train_summary,
                    "calibration": calibration_summary,
                })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        oracle = {}
        for dataset, selected_cases in (("train", train), ("calibration", calibration)):
            oracle[dataset] = {
                "cases": len(selected_cases),
                "currentHits": sum(case.current_hit for case in selected_cases),
                "oracleHits": sum(
                    any(case.candidate_hit(index) for index in range(len(case.candidates)))
                    for case in selected_cases
                ),
            }
        report["eventTypes"][event_type] = {
            "oracle": oracle,
            "candidates": candidates[:100],
        }
        print(json.dumps({
            event_type: {
                "oracle": oracle,
                "top": candidates[:5],
            },
        }, indent=2))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
