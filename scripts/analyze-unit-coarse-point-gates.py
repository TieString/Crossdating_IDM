"""Search conservative gates for a coarse-window annual point localizer.

Rules are selected only on named development splits. Other splits are reported but never
used for ordering. This script is exploratory and does not alter production behavior.
"""

from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np


PREDICTORS = (
    ("differenceMasterR31", "mass3", 1),
    ("differenceMasterR21", "point", 0),
    ("differenceMasterHuber21", "mass5", 0),
    ("differenceReferenceWeightedR21", "mass5", 0),
    ("differenceReferenceWeightedR31", "mass5", 0),
    ("whitenedMasterR31", "mass3", 1),
)


@dataclass(frozen=True)
class Case:
    split: str
    mode: str
    truth: int
    years: np.ndarray
    features: dict[str, np.ndarray]
    final_start: int
    final_end: int
    anchors: tuple[int, ...]

    @property
    def center(self) -> int:
        return (self.final_start + self.final_end) // 2

    @property
    def radius(self) -> int:
        return (self.final_end - self.final_start) // 2


@dataclass(frozen=True)
class Candidate:
    year: int
    normalized_remote_margin: float
    consensus_within_one: int
    consensus_within_two: int
    anchor_within_two: int


@dataclass(frozen=True)
class Rule:
    predictor: int
    modes: tuple[str, ...]
    minimum_center_distance: int
    maximum_center_distance: int
    minimum_edge_position: int
    consensus_radius: int
    minimum_consensus: int
    minimum_anchor_count: int
    minimum_remote_margin: float
    move_limit: int


def finite(value: Any, fallback: float = -10.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def load_cases(path: Path) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    cases = []
    for row in payload:
        if row.get("eventType") != "falseRing":
            continue
        years = np.asarray([int(point["year"]) for point in row["rows"]])
        names = set.intersection(*(set(point["features"]) for point in row["rows"]))
        features = {
            name: np.asarray([
                finite(point["features"].get(name)) for point in row["rows"]
            ])
            for name in names
        }
        final_start, final_end = map(int, row["finalRange"])
        anchors = tuple(int(value) for value in (
            row.get("primaryTopYear"),
            row.get("operationBestYear"),
            row.get("sideStepBestYear"),
        ) if value is not None)
        cases.append(Case(
            split=str(row["split"]),
            mode=str(row.get("falseRingMode") or "unknown"),
            truth=int(row["truthYear"]),
            years=years,
            features=features,
            final_start=final_start,
            final_end=final_end,
            anchors=anchors,
        ))
    return cases


def moving_mean(values: np.ndarray, radius: int) -> np.ndarray:
    return np.asarray([
        float(np.mean(values[max(0, index - radius):index + radius + 1]))
        for index in range(len(values))
    ])


def transform(values: np.ndarray, name: str) -> np.ndarray:
    if name == "point":
        return values
    if name == "mass3":
        return moving_mean(values, 1)
    if name == "mass5":
        return moving_mean(values, 2)
    raise ValueError(name)


def prediction(case: Case, spec: tuple[str, str, int]) -> tuple[int, np.ndarray]:
    name, shape, shift = spec
    scores = transform(case.features[name], shape)
    order = np.lexsort((-case.years, -scores))
    return int(case.years[order[0]]) + shift, scores


def normalize(values: np.ndarray) -> np.ndarray:
    low = float(np.percentile(values, 10))
    high = float(np.percentile(values, 90))
    return (values - low) / max(1e-9, high - low)


def candidate_for(
    case: Case,
    predictor_index: int,
    predictions: Sequence[int],
    scores: np.ndarray,
) -> Candidate:
    year = predictions[predictor_index]
    normalized = normalize(scores)
    source_year = year - PREDICTORS[predictor_index][2]
    source_index = int(np.argmin(np.abs(case.years - source_year)))
    remote = [
        normalized[index] for index, other_year in enumerate(case.years)
        if abs(int(other_year) - source_year) > 2
    ]
    margin = float(normalized[source_index] - max(remote, default=normalized[source_index]))
    return Candidate(
        year=year,
        normalized_remote_margin=margin,
        consensus_within_one=sum(abs(other - year) <= 1 for other in predictions),
        consensus_within_two=sum(abs(other - year) <= 2 for other in predictions),
        anchor_within_two=sum(abs(anchor - year) <= 2 for anchor in case.anchors),
    )


def accepts(case: Case, candidate: Candidate, rule: Rule) -> bool:
    distance = abs(candidate.year - case.center)
    edge_position = distance - case.radius
    consensus = (
        candidate.consensus_within_one
        if rule.consensus_radius == 1
        else candidate.consensus_within_two
    )
    return (
        case.mode in rule.modes
        and rule.minimum_center_distance <= distance <= rule.maximum_center_distance
        and edge_position >= rule.minimum_edge_position
        and consensus >= rule.minimum_consensus
        and candidate.anchor_within_two >= rule.minimum_anchor_count
        and candidate.normalized_remote_margin >= rule.minimum_remote_margin
    )


def moved_center(case: Case, candidate: Candidate, rule: Rule) -> int:
    if not accepts(case, candidate, rule):
        return case.center
    delta = candidate.year - case.center
    return case.center + int(np.sign(delta)) * min(abs(delta), rule.move_limit)


def metrics(
    cases: Sequence[Case],
    candidates: Sequence[Candidate],
    rule: Rule,
    indexes: Sequence[int],
) -> dict[str, Any]:
    baseline = selected = gains = losses = changed = 0
    for index in indexes:
        case = cases[index]
        candidate = candidates[index]
        baseline_hit = case.final_start <= case.truth <= case.final_end
        center = moved_center(case, candidate, rule)
        selected_hit = abs(center - case.truth) <= case.radius
        baseline += baseline_hit
        selected += selected_hit
        gains += selected_hit and not baseline_hit
        losses += baseline_hit and not selected_hit
        changed += center != case.center
    return {
        "cases": len(indexes),
        "baseline": baseline,
        "selected": selected,
        "gain": gains,
        "loss": losses,
        "changed": changed,
    }


def oracle_metrics(
    cases: Sequence[Case],
    predictions: Sequence[Sequence[int]],
    indexes: Sequence[int],
    move_limit: int,
) -> dict[str, int]:
    baseline = recovered = 0
    for index in indexes:
        case = cases[index]
        baseline_hit = case.final_start <= case.truth <= case.final_end
        baseline += baseline_hit
        alternatives = []
        for candidate in predictions[index]:
            delta = candidate - case.center
            center = case.center + int(np.sign(delta)) * min(abs(delta), move_limit)
            alternatives.append(abs(center - case.truth) <= case.radius)
        recovered += baseline_hit or any(alternatives)
    return {
        "cases": len(indexes),
        "baseline": baseline,
        "oracle": recovered,
        "recoverableMisses": recovered - baseline,
        "remainingMisses": len(indexes) - recovered,
    }


def rule_name(rule: Rule) -> str:
    predictor = ":".join(map(str, PREDICTORS[rule.predictor]))
    return (
        f"{predictor}|modes={','.join(rule.modes)}|distance="
        f"{rule.minimum_center_distance}..{rule.maximum_center_distance}|"
        f"edge>={rule.minimum_edge_position}|consensus{rule.consensus_radius}>="
        f"{rule.minimum_consensus}|anchors>={rule.minimum_anchor_count}|"
        f"margin>={rule.minimum_remote_margin:g}|move<={rule.move_limit}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--selection-split", action="append", required=True)
    parser.add_argument(
        "--ignore-physical-mode",
        action="store_true",
        help="Do not use the synthetic false-ring construction mode as a gate",
    )
    parser.add_argument("--top", type=int, default=30)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    cases = load_cases(args.dataset)
    predictions_by_case = [
        [prediction(case, spec)[0] for spec in PREDICTORS]
        for case in cases
    ]
    candidates_by_predictor = []
    for predictor_index, spec in enumerate(PREDICTORS):
        predictor_candidates = []
        for case_index, case in enumerate(cases):
            _, scores = prediction(case, spec)
            predictor_candidates.append(candidate_for(
                case,
                predictor_index,
                predictions_by_case[case_index],
                scores,
            ))
        candidates_by_predictor.append(predictor_candidates)

    split_indexes = {
        split: [index for index, case in enumerate(cases) if case.split == split]
        for split in sorted({case.split for case in cases})
    }
    selection_indexes = [
        index for index, case in enumerate(cases)
        if case.split in args.selection_split
    ]
    observed_modes = tuple(sorted({case.mode for case in cases}))
    mode_sets = (observed_modes,) if args.ignore_physical_mode else (
        ("average", "moderate", "splitLike"),
        ("moderate",),
        ("average", "moderate"),
    )
    rules = (
        Rule(*values)
        for values in itertools.product(
            range(len(PREDICTORS)),
            mode_sets,
            (1, 2, 3),
            (4, 6, 100),
            (-1, 0, 1),
            (2,),
            (3, 4, 5),
            (0, 1, 2),
            (-100.0, 0.0, 0.1),
            (2, 4, 100),
        )
        if values[2] <= values[3]
    )
    rows = []
    for rule in rules:
        candidates = candidates_by_predictor[rule.predictor]
        selection = metrics(cases, candidates, rule, selection_indexes)
        if selection["changed"] == 0:
            continue
        splits = {
            name: metrics(cases, candidates, rule, indexes)
            for name, indexes in split_indexes.items()
        }
        development_splits = [splits[name] for name in args.selection_split]
        if any(row["selected"] < row["baseline"] for row in development_splits):
            continue
        rows.append({
            "rule": rule_name(rule),
            "selection": selection,
            "splits": splits,
            "_signature": tuple(
                moved_center(case, candidates[index], rule)
                for index, case in enumerate(cases)
            ),
        })
    rows.sort(key=lambda row: (
        row["selection"]["selected"],
        -row["selection"]["loss"],
        -row["selection"]["changed"],
    ), reverse=True)
    unique_rows = []
    seen_signatures = set()
    for row in rows:
        signature = row.pop("_signature")
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        unique_rows.append(row)
        if len(unique_rows) >= args.top:
            break
    mode_indexes = {
        mode: [index for index, case in enumerate(cases) if case.mode == mode]
        for mode in sorted({case.mode for case in cases})
    }
    report = {
        "selectionSplits": args.selection_split,
        "caseCount": len(cases),
        "predictors": PREDICTORS,
        "eligibleRuleCount": len(rows),
        "oracle": {
            str(move_limit): {
                "overall": oracle_metrics(
                    cases,
                    predictions_by_case,
                    range(len(cases)),
                    move_limit,
                ),
                "splits": {
                    name: oracle_metrics(cases, predictions_by_case, indexes, move_limit)
                    for name, indexes in split_indexes.items()
                },
                "modes": {
                    name: oracle_metrics(cases, predictions_by_case, indexes, move_limit)
                    for name, indexes in mode_indexes.items()
                },
            }
            for move_limit in (2, 4, 100)
        },
        "top": unique_rows,
    }
    rendered = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
