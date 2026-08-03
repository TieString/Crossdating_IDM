"""Audit a full year distribution assembled from every coarse hypothesis.

Only cases whose production window is already 13 years are eligible to move,
so this experiment cannot widen a displayed window or change response rate.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Sequence


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


def family(name: str) -> str:
    lowered = name.lower()
    if "reference" in lowered:
        return "reference"
    if "master" in lowered:
        return "master"
    if "predictive" in lowered:
        return "predictive"
    return "other"


@dataclass(frozen=True)
class Window:
    start: int
    end: int

    def contains(self, year: int) -> bool:
        return self.start <= year <= self.end


@dataclass(frozen=True)
class Case:
    dataset: str
    event_type: str
    group: str
    truth: int
    final: Window
    mode: Window
    scores: dict[str, dict[int, float]]


def aggregate_scores(audited: Sequence[dict[str, Any]]) -> dict[str, dict[int, float]]:
    rank_values: dict[str, dict[int, list[float]]] = {}
    peak_values: dict[str, dict[int, list[float]]] = {}
    observed_years = sorted({
        int(row["year"])
        for candidate in audited
        for row in candidate.get("rows", [])
    })
    for candidate in audited:
        rows = candidate.get("rows", [])
        names = sorted({
            name for row in rows for name in (row.get("profiles") or {})
        })
        for name in names:
            values = [float((row.get("profiles") or {}).get(name, -10)) for row in rows]
            ranks = percentile_ranks(values)
            selected_family = family(name)
            peak_index = max(range(len(values)), key=lambda index: (values[index], index))
            peak_year = int(rows[peak_index]["year"])
            for index, row in enumerate(rows):
                year = int(row["year"])
                for selected in ("all", selected_family):
                    rank_values.setdefault(selected, {}).setdefault(year, []).append(
                        ranks[index]
                    )
                    for radius in (2, 4, 6):
                        value = max(0.0, 1 - abs(year - peak_year) / (radius + 1))
                        peak_values.setdefault(
                            f"{selected}:kernel{radius * 2 + 1}", {}
                        ).setdefault(year, []).append(value)
    result: dict[str, dict[int, float]] = {}
    for selected_family, by_year in rank_values.items():
        result[f"rank:{selected_family}:mean"] = {
            year: mean(by_year.get(year, [])) for year in observed_years
        }
        result[f"rank:{selected_family}:median"] = {
            year: median(by_year.get(year, [0])) for year in observed_years
        }
        result[f"rank:{selected_family}:topVote"] = {
            year: mean(value >= 0.8 for value in by_year.get(year, []))
            for year in observed_years
        }
    for name, by_year in peak_values.items():
        result[f"peak:{name}"] = {
            year: mean(by_year.get(year, [])) for year in observed_years
        }
    return result


def load(path: Path, dataset: str) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = []
    seen = set()
    for source in payload.get("counterfactualLocatorCases", []):
        context = source.get("context", {})
        event_type = source.get("eventType")
        final = source.get("finalWindow")
        mode = source.get("modeWindow")
        audited = source.get("coarseCandidateCounterfactuals") or []
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
            or not final
            or not mode
            or not audited
        ):
            continue
        seen.add(key)
        result.append(Case(
            dataset=dataset,
            event_type=str(event_type),
            group=key[0],
            truth=key[2],
            final=Window(int(final["startYear"]), int(final["endYear"])),
            mode=Window(int(mode["startYear"]), int(mode["endYear"])),
            scores=aggregate_scores(audited),
        ))
    return result


def mass(profile: dict[int, float], start: int, width: int = 13) -> float:
    return sum(profile.get(year, 0) for year in range(start, start + width)) / width


def select_window(case: Case, rule: str) -> tuple[Window, float]:
    profile = case.scores[rule]
    minimum = min(profile)
    maximum = max(profile)
    baseline_center = (case.mode.start + case.mode.end) / 2
    rows = []
    for start in range(minimum, maximum - 11):
        score = mass(profile, start)
        center = start + 6
        rows.append((score, -abs(center - baseline_center), center, start))
    selected = max(rows)
    baseline_score = mass(profile, case.mode.start)
    return Window(selected[3], selected[3] + 12), selected[0] - baseline_score


def summarize(
    cases: Sequence[Case],
    rule: str,
    threshold: float,
    maximum_distance: int,
) -> dict[str, int]:
    old_hits = sum(case.final.contains(case.truth) for case in cases)
    new_hits = 0
    changes = 0
    gains = 0
    losses = 0
    eligible = 0
    for case in cases:
        old_hit = case.final.contains(case.truth)
        selected, margin = select_window(case, rule)
        old_center = (case.mode.start + case.mode.end) / 2
        new_center = (selected.start + selected.end) / 2
        can_change = (
            case.final.end - case.final.start + 1 == 13
            and selected != case.mode
            and margin >= threshold
            and abs(new_center - old_center) <= maximum_distance
        )
        eligible += case.final.end - case.final.start + 1 == 13
        hit = selected.contains(case.truth) if can_change else old_hit
        new_hits += hit
        changes += can_change
        gains += can_change and not old_hit and hit
        losses += can_change and old_hit and not hit
    return {
        "cases": len(cases),
        "eligible": eligible,
        "oldHits": old_hits,
        "newHits": new_hits,
        "delta": new_hits - old_hits,
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
        default=".tmp-unit-counterfactual-year-distribution-report.json",
    )
    args = parser.parse_args()
    cases = [
        *load(Path(args.train), "train"),
        *load(Path(args.calibration), "calibration"),
    ]
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in ("missingRing", "falseRing"):
        train = [case for case in cases if case.dataset == "train" and case.event_type == event_type]
        calibration = [
            case for case in cases
            if case.dataset == "calibration" and case.event_type == event_type
        ]
        rules = sorted(set.intersection(*(
            set(case.scores) for case in [*train, *calibration]
        )))
        candidates = []
        for rule in rules:
            for threshold in (0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2):
                for maximum_distance in (4, 6, 8, 12, 20, 40):
                    train_summary = summarize(train, rule, threshold, maximum_distance)
                    calibration_summary = summarize(
                        calibration, rule, threshold, maximum_distance
                    )
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
                        "rule": rule,
                        "threshold": threshold,
                        "maximumDistance": maximum_distance,
                        "train": train_summary,
                        "calibration": calibration_summary,
                    })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        report["eventTypes"][event_type] = {"candidates": candidates[:100]}
        print(json.dumps({event_type: candidates[:8]}, indent=2))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
