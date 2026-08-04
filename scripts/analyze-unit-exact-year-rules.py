"""Audit deterministic exact-year rules on consumed unit-event cohorts.

This script never fits a model and never changes event acceptance or the frozen window.
It compares production Top1 with explainable score ensembles, then searches conservative
promotion gates that must avoid an exact-Top1 regression in every supplied cohort.
"""

from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np


EVENT_TYPES = ("missingRing", "falseRing")
FALSE_PROFILES = (
    "differenceReferenceWeightedHuber31",
    "differenceReferencePeakKernel5",
    "differenceReferencePeakKernel9",
    "differenceReferenceRankMean31",
)


@dataclass(frozen=True)
class RankingCase:
    dataset: str
    event_type: str
    truth_year: int
    years: np.ndarray
    baseline: np.ndarray
    candidate: np.ndarray
    profile_scores: tuple[np.ndarray, ...]
    anchors: tuple[int, ...]
    named_profiles: dict[str, np.ndarray]
    false_ring_mode: str | None


@dataclass(frozen=True)
class Dataset:
    name: str
    cases: dict[str, list[RankingCase]]
    denominators: dict[str, int]


def finite(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values), dtype=float)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = 0.5 if len(values) <= 1 else (start + end - 1) / (2 * (len(values) - 1))
        result[order[start:end]] = rank
        start = end
    return result


def rank_order(years: np.ndarray, scores: np.ndarray) -> np.ndarray:
    return np.lexsort((-years, -scores))


def top_index(case: RankingCase, scores: np.ndarray) -> int:
    return int(rank_order(case.years, scores)[0])


def score_margin(case: RankingCase, scores: np.ndarray) -> float:
    order = rank_order(case.years, scores)
    return float(scores[order[0]] - scores[order[1]]) if len(order) > 1 else 1.0


def case_key(context: dict[str, Any], event_type: str) -> tuple[str, str, str]:
    return (
        event_type,
        str(context.get("groupId", context.get("file", ""))),
        str(context.get("target", "")),
    )


def ranking_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row["eventType"]),
        str(row["groupId"]),
        str(row.get("seriesId", "")),
    )


def build_false_candidate(
    years: np.ndarray,
    locator: dict[str, Any],
) -> tuple[np.ndarray, tuple[np.ndarray, ...]] | None:
    by_year = {
        int(row["year"]): row.get("profiles", {})
        for row in locator.get("unitCounterfactualRows") or []
    }
    profile_scores: list[np.ndarray] = []
    for profile in FALSE_PROFILES:
        if any(profile not in by_year.get(int(year), {}) for year in years):
            return None
        values = np.asarray([
            finite(by_year[int(year)][profile]) for year in years
        ], dtype=float)
        profile_scores.append(percentile_ranks(values))
    operation_year = (locator.get("selectedOperation") or {}).get("bestYear")
    operation_exact = np.asarray([
        1.0 if operation_year is not None and int(year) == int(operation_year) else 0.0
        for year in years
    ])
    candidate = np.mean(np.column_stack([*profile_scores, operation_exact]), axis=1)
    return candidate, tuple(profile_scores)


def build_missing_candidate(
    years: np.ndarray,
    locator: dict[str, Any],
    baseline: np.ndarray,
) -> tuple[np.ndarray, tuple[np.ndarray, ...]] | None:
    profiles = locator.get("unitBoundaryLikelihoodProfiles") or {}
    annual = profiles.get("combinedAnnualStepMean2")
    if not isinstance(annual, list) or len(annual) != len(years):
        return None
    annual_rank = percentile_ranks(np.asarray([finite(value) for value in annual]))
    candidate = percentile_ranks(baseline) * 0.6 + annual_rank * 0.4
    return candidate, (annual_rank,)


def load_dataset(path: Path) -> Dataset:
    source = json.loads(path.read_text(encoding="utf-8"))
    rankings = {ranking_key(row): row for row in source.get("rankingCases", [])}
    outcomes = source.get("formalEventCaseOutcomes", [])
    formal_keys = {
        case_key(row["context"], str(row["eventType"]))
        for row in outcomes
        if row["eventType"] in EVENT_TYPES
    }
    denominators = {
        event_type: sum(row["eventType"] == event_type for row in outcomes)
        for event_type in EVENT_TYPES
    }
    cases = {event_type: [] for event_type in EVENT_TYPES}
    for locator in source.get("counterfactualLocatorCases", []):
        event_type = str(locator.get("eventType"))
        window = locator.get("finalWindow")
        if event_type not in EVENT_TYPES or not window:
            continue
        key = case_key(locator["context"], event_type)
        ranking = rankings.get(key)
        if key not in formal_keys or ranking is None:
            continue
        start = int(window["startYear"])
        end = int(window["endYear"])
        truth = int(locator["truthYear"])
        if not start <= truth <= end:
            continue
        years = np.arange(start, end + 1, dtype=int)
        baseline_by_year = {
            int(row["year"]): finite(row["score"])
            for row in ranking.get("rankedYears", [])
        }
        if any(int(year) not in baseline_by_year for year in years):
            continue
        baseline = np.asarray([baseline_by_year[int(year)] for year in years])
        named_profiles: dict[str, np.ndarray] = {}
        all_years = [int(year) for year in locator.get("years", [])]
        all_year_index = {year: index for index, year in enumerate(all_years)}
        if all(int(year) in all_year_index for year in years):
            for name, values in (locator.get("ranks") or {}).items():
                if len(values) != len(all_years):
                    continue
                named_profiles[f"profile:{name}"] = np.asarray([
                    finite(values[all_year_index[int(year)]]) for year in years
                ])
        counterfactual_by_year = {
            int(row["year"]): row.get("profiles", {})
            for row in locator.get("unitCounterfactualRows") or []
        }
        counterfactual_names = sorted({
            name
            for row in counterfactual_by_year.values()
            for name in row
        })
        for name in counterfactual_names:
            if all(name in counterfactual_by_year.get(int(year), {}) for year in years):
                named_profiles[f"counterfactual:{name}"] = np.asarray([
                    finite(counterfactual_by_year[int(year)][name]) for year in years
                ])
        for name, values in (
            locator.get("unitBoundaryLikelihoodProfiles") or {}
        ).items():
            if isinstance(values, list) and len(values) == len(years):
                named_profiles[f"annual:{name}"] = np.asarray([
                    finite(value) for value in values
                ])
        for name, values in (locator.get("unitExactYearProfiles") or {}).items():
            if isinstance(values, list) and len(values) == len(years):
                named_profiles[f"exact:{name}"] = np.asarray([
                    finite(value) for value in values
                ])
        local_correction_ranks = locator.get("unitLocalCorrectionRanks")
        if (
            isinstance(local_correction_ranks, list)
            and len(local_correction_ranks) == len(years)
        ):
            named_profiles["unit:localCorrectionRank"] = np.asarray([
                finite(value) for value in local_correction_ranks
            ])
        final_year_scores = locator.get("unitFinalYearScores")
        if isinstance(final_year_scores, list) and len(final_year_scores) == len(years):
            named_profiles["unit:finalYearScore"] = np.asarray([
                finite(value) for value in final_year_scores
            ])
        built = build_missing_candidate(years, locator, baseline) \
            if event_type == "missingRing" \
            else build_false_candidate(years, locator)
        if built is None:
            candidate, profile_scores = baseline.copy(), ()
        else:
            candidate, profile_scores = built
        operation = locator.get("selectedOperation") or {}
        anchors = tuple(int(value) for value in (
            locator.get("currentPrimaryYear"),
            operation.get("bestYear"),
            operation.get("sideStepBestYear"),
        ) if value is not None)
        for name, value in (
            ("anchor:current", locator.get("currentPrimaryYear")),
            ("anchor:operation", operation.get("bestYear")),
            ("anchor:sideStep", operation.get("sideStepBestYear")),
        ):
            if value is not None:
                named_profiles[name] = np.asarray([
                    1.0 if int(year) == int(value) else 0.0 for year in years
                ])
        cases[event_type].append(RankingCase(
            dataset=path.stem,
            event_type=event_type,
            truth_year=truth,
            years=years,
            baseline=baseline,
            candidate=candidate,
            profile_scores=profile_scores,
            anchors=anchors,
            named_profiles=named_profiles,
            false_ring_mode=(
                str(locator["falseRingMode"])
                if locator.get("falseRingMode") is not None
                else None
            ),
        ))
    return Dataset(path.stem, cases, denominators)


def metrics(
    cases: Sequence[RankingCase],
    denominator: int,
    select_scores: Callable[[RankingCase], np.ndarray],
) -> dict[str, Any]:
    exact = within_one = top_three = 0
    reciprocal = 0.0
    ranks: list[int] = []
    center_offsets: list[float] = []
    for case in cases:
        scores = select_scores(case)
        order = rank_order(case.years, scores)
        selected = int(case.years[order[0]])
        truth_index = int(np.where(case.years[order] == case.truth_year)[0][0])
        truth_rank = truth_index + 1
        exact += selected == case.truth_year
        within_one += abs(selected - case.truth_year) <= 1
        top_three += truth_rank <= 3
        reciprocal += 1 / truth_rank
        ranks.append(truth_rank)
        center_offsets.append(selected - float(np.mean(case.years)))
    return {
        "formalCases": denominator,
        "coveredCases": len(cases),
        "exactCount": exact,
        "withinOneCount": within_one,
        "topThreeCount": top_three,
        "reciprocalRankSum": reciprocal,
        "top1All": exact / max(1, denominator),
        "top1Covered": exact / max(1, len(cases)),
        "top1WithinOneAll": within_one / max(1, denominator),
        "top3All": top_three / max(1, denominator),
        "medianTruthRankCovered": float(np.median(ranks)) if ranks else 0,
        "mrrAll": reciprocal / max(1, denominator),
        "meanTopYearCenterOffset": float(np.mean(center_offsets)) if center_offsets else 0,
    }


def change_counts(
    cases: Sequence[RankingCase],
    select_scores: Callable[[RankingCase], np.ndarray],
) -> dict[str, int]:
    result = {"changed": 0, "gains": 0, "losses": 0, "wrongToWrong": 0}
    for case in cases:
        baseline_year = int(case.years[top_index(case, case.baseline)])
        selected_year = int(case.years[top_index(case, select_scores(case))])
        if selected_year == baseline_year:
            continue
        result["changed"] += 1
        if selected_year == case.truth_year and baseline_year != case.truth_year:
            result["gains"] += 1
        elif baseline_year == case.truth_year and selected_year != case.truth_year:
            result["losses"] += 1
        else:
            result["wrongToWrong"] += 1
    return result


@dataclass(frozen=True)
class Gate:
    maximum_distance: int
    minimum_candidate_margin: float
    maximum_baseline_margin: float
    minimum_profile_votes: int
    minimum_exact_anchors: int

    @property
    def name(self) -> str:
        return (
            f"distance<={self.maximum_distance}:candidateMargin>={self.minimum_candidate_margin:g}:"
            f"baselineMargin<={self.maximum_baseline_margin:g}:"
            f"profileVotes>={self.minimum_profile_votes}:exactAnchors>={self.minimum_exact_anchors}"
        )


def gate_accepts(case: RankingCase, gate: Gate) -> bool:
    baseline_index = top_index(case, case.baseline)
    candidate_index = top_index(case, case.candidate)
    baseline_year = int(case.years[baseline_index])
    candidate_year = int(case.years[candidate_index])
    if candidate_year == baseline_year:
        return False
    profile_votes = sum(
        int(case.years[top_index(case, scores)] == candidate_year)
        for scores in case.profile_scores
    )
    exact_anchors = sum(anchor == candidate_year for anchor in case.anchors)
    return (
        abs(candidate_year - baseline_year) <= gate.maximum_distance
        and score_margin(case, case.candidate) + 1e-12 >= gate.minimum_candidate_margin
        and score_margin(case, percentile_ranks(case.baseline)) <= gate.maximum_baseline_margin + 1e-12
        and profile_votes >= gate.minimum_profile_votes
        and exact_anchors >= gate.minimum_exact_anchors
    )


def gated_scores(gate: Gate) -> Callable[[RankingCase], np.ndarray]:
    return lambda case: case.candidate if gate_accepts(case, gate) else case.baseline


def shift_profile(values: np.ndarray, year_shift: int) -> np.ndarray:
    floor = float(np.min(values) - max(1.0, np.ptp(values)))
    result = np.full(len(values), floor, dtype=float)
    for target_index in range(len(values)):
        source_index = target_index - year_shift
        if 0 <= source_index < len(values):
            result[target_index] = values[source_index]
    return result


def profile_selector(
    profile_name: str,
    year_shift: int,
    blend: float,
) -> Callable[[RankingCase], np.ndarray]:
    def select(case: RankingCase) -> np.ndarray:
        values = case.named_profiles.get(profile_name)
        if values is None:
            return case.baseline
        return (
            percentile_ranks(case.baseline) * (1 - blend)
            + percentile_ranks(shift_profile(values, year_shift)) * blend
        )
    return select


def profile_leaderboard(
    datasets: Sequence[Dataset],
    event_type: str,
    top: int,
    profile_filter: str,
) -> list[dict[str, Any]]:
    all_cases = [case for dataset in datasets for case in dataset.cases[event_type]]
    denominator = sum(dataset.denominators[event_type] for dataset in datasets)
    baseline_folds = {
        dataset.name: metrics(
            dataset.cases[event_type],
            dataset.denominators[event_type],
            lambda case: case.baseline,
        )
        for dataset in datasets
    }
    modes = sorted({
        case.false_ring_mode
        for case in all_cases
        if case.false_ring_mode is not None
    })
    cases_by_mode = {
        mode: [case for case in all_cases if case.false_ring_mode == mode]
        for mode in modes
    }
    baseline_by_mode = {
        mode: metrics(cases, len(cases), lambda case: case.baseline)
        for mode, cases in cases_by_mode.items()
    }
    profile_names = sorted({
        name for case in all_cases for name in case.named_profiles
    }).copy()
    if profile_filter:
        profile_names = [
            name for name in profile_names if profile_filter in name
        ]
    rows = []
    for profile_name, year_shift, blend in itertools.product(
        profile_names,
        range(-3, 4),
        (0.25, 0.5, 0.75, 1.0),
    ):
        available = sum(profile_name in case.named_profiles for case in all_cases)
        if available < len(all_cases) * 0.8:
            continue
        selector = profile_selector(profile_name, year_shift, blend)
        pooled = metrics(all_cases, denominator, selector)
        fold_deltas = {}
        for dataset in datasets:
            fold = metrics(
                dataset.cases[event_type],
                dataset.denominators[event_type],
                selector,
            )
            fold_deltas[dataset.name] = {
                "exact": fold["exactCount"]
                    - baseline_folds[dataset.name]["exactCount"],
                "withinOne": fold["withinOneCount"]
                    - baseline_folds[dataset.name]["withinOneCount"],
                "topThree": fold["topThreeCount"]
                    - baseline_folds[dataset.name]["topThreeCount"],
                "mrr": fold["mrrAll"] - baseline_folds[dataset.name]["mrrAll"],
            }
        rows.append({
            "profile": profile_name,
            "yearShift": year_shift,
            "blend": blend,
            "available": available,
            "metrics": pooled,
            "changes": change_counts(all_cases, selector),
            "foldDeltas": fold_deltas,
            "minimumFoldExactDelta": min(
                row["exact"] for row in fold_deltas.values()
            ),
            **({
                "modeDeltas": {
                    mode: {
                        "cases": len(mode_cases),
                        "exact": selected["exactCount"]
                            - baseline_by_mode[mode]["exactCount"],
                        "withinOne": selected["withinOneCount"]
                            - baseline_by_mode[mode]["withinOneCount"],
                        "topThree": selected["topThreeCount"]
                            - baseline_by_mode[mode]["topThreeCount"],
                    }
                    for mode, mode_cases in cases_by_mode.items()
                    for selected in [metrics(mode_cases, len(mode_cases), selector)]
                },
            } if event_type == "falseRing" else {}),
        })
    rows.sort(key=lambda row: (
        row["metrics"]["exactCount"],
        row["minimumFoldExactDelta"],
        row["metrics"]["mrrAll"],
    ), reverse=True)
    return rows[:top]


def gates(event_type: str) -> Sequence[Gate]:
    profile_count = 1 if event_type == "missingRing" else len(FALSE_PROFILES)
    return [
        Gate(*values)
        for values in itertools.product(
            (1, 2, 99),
            (0.0, 0.025, 0.05, 0.075, 0.1),
            (0.05, 0.1, 0.15, 0.25, 1.0),
            range(0, profile_count + 1),
            range(0, 3),
        )
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audits", nargs="+", type=Path)
    parser.add_argument("--top", type=int, default=12)
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--profile-leaderboard", action="store_true")
    parser.add_argument("--profile-filter", default="")
    args = parser.parse_args()
    datasets = [load_dataset(path) for path in args.audits]
    if args.profile_leaderboard:
        print(json.dumps({
            event_type: profile_leaderboard(
                datasets,
                event_type,
                args.top,
                args.profile_filter,
            )
            for event_type in EVENT_TYPES
        }, ensure_ascii=False, indent=2))
        return
    output: dict[str, Any] = {"datasets": [dataset.name for dataset in datasets]}
    for event_type in EVENT_TYPES:
        all_cases = [case for dataset in datasets for case in dataset.cases[event_type]]
        total_denominator = sum(dataset.denominators[event_type] for dataset in datasets)
        baseline = metrics(all_cases, total_denominator, lambda case: case.baseline)
        baseline_folds = {
            dataset.name: metrics(
                dataset.cases[event_type],
                dataset.denominators[event_type],
                lambda case: case.baseline,
            )
            for dataset in datasets
        }
        candidate = metrics(all_cases, total_denominator, lambda case: case.candidate)
        candidate_folds = {
            dataset.name: {
                "metrics": metrics(
                    dataset.cases[event_type],
                    dataset.denominators[event_type],
                    lambda case: case.candidate,
                ),
                "changes": change_counts(
                    dataset.cases[event_type],
                    lambda case: case.candidate,
                ),
            }
            for dataset in datasets
        }
        rows = []
        for gate in gates(event_type):
            selector = gated_scores(gate)
            pooled = metrics(all_cases, total_denominator, selector)
            fold_rows = {
                dataset.name: {
                    "metrics": metrics(
                        dataset.cases[event_type],
                        dataset.denominators[event_type],
                        selector,
                    ),
                    "changes": change_counts(dataset.cases[event_type], selector),
                }
                for dataset in datasets
            }
            fold_exact_deltas = [
                row["metrics"]["exactCount"]
                - baseline_folds[name]["exactCount"]
                for name, row in fold_rows.items()
            ]
            if min(fold_exact_deltas, default=0) < 0:
                continue
            changes = change_counts(all_cases, selector)
            if changes["gains"] <= changes["losses"]:
                continue
            rows.append({
                "gate": gate.name,
                "metrics": pooled,
                "changes": changes,
                "foldExactDeltas": fold_exact_deltas,
                "folds": fold_rows,
                "allRankingMetricsNonRegressing": all(
                    row["metrics"][metric] + 1e-12 >= baseline_folds[name][metric]
                    for name, row in fold_rows.items()
                    for metric in (
                        "exactCount",
                        "withinOneCount",
                        "topThreeCount",
                        "reciprocalRankSum",
                    )
                ),
            })
        rows.sort(key=lambda row: (
            row["metrics"]["exactCount"] - baseline["exactCount"],
            min(row["foldExactDeltas"]),
            row["metrics"]["mrrAll"] - baseline["mrrAll"],
            -row["changes"]["changed"],
        ), reverse=True)
        output[event_type] = {
            "baseline": baseline,
            "baselineFolds": baseline_folds,
            "ungatedCandidate": candidate,
            "ungatedChanges": change_counts(all_cases, lambda case: case.candidate),
            "ungatedFolds": candidate_folds,
            "stableGates": rows[: args.top],
            "bestStableGateByDistance": {
                str(distance): next(
                    (
                        row for row in rows
                        if row["gate"].startswith(f"distance<={distance}:")
                    ),
                    None,
                )
                for distance in (1, 2, 99)
            },
            "bestAllMetricsNonRegressingGate": next(
                (row for row in rows if row["allRankingMetricsNonRegressing"]),
                None,
            ),
        }
    if args.summary:
        def compact_metrics(row: dict[str, Any]) -> dict[str, Any]:
            return {
                key: row[key]
                for key in (
                    "formalCases",
                    "coveredCases",
                    "exactCount",
                    "withinOneCount",
                    "topThreeCount",
                    "top1All",
                    "top1WithinOneAll",
                    "top3All",
                    "medianTruthRankCovered",
                    "mrrAll",
                    "meanTopYearCenterOffset",
                )
            }

        def compact_rule(row: dict[str, Any] | None) -> dict[str, Any] | None:
            if row is None:
                return None
            return {
                "gate": row["gate"],
                "metrics": compact_metrics(row["metrics"]),
                "changes": row["changes"],
                "foldExactDeltas": row["foldExactDeltas"],
                "allRankingMetricsNonRegressing": row[
                    "allRankingMetricsNonRegressing"
                ],
                "folds": {
                    name: {
                        "metrics": compact_metrics(fold["metrics"]),
                        "changes": fold["changes"],
                    }
                    for name, fold in row["folds"].items()
                },
            }

        output = {
            "datasets": output["datasets"],
            **{
                event_type: {
                    "baseline": compact_metrics(output[event_type]["baseline"]),
                    "baselineFolds": {
                        name: compact_metrics(row)
                        for name, row in output[event_type]["baselineFolds"].items()
                    },
                    "ungatedCandidate": compact_metrics(
                        output[event_type]["ungatedCandidate"]
                    ),
                    "ungatedChanges": output[event_type]["ungatedChanges"],
                    "bestStableGateByDistance": {
                        distance: compact_rule(row)
                        for distance, row in output[event_type][
                            "bestStableGateByDistance"
                        ].items()
                    },
                    "bestAllMetricsNonRegressingGate": compact_rule(
                        output[event_type]["bestAllMetricsNonRegressingGate"]
                    ),
                }
                for event_type in EVENT_TYPES
            },
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
