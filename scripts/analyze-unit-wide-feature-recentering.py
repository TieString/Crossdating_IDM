"""Search conservative feature-directed shifts for 13-year unit-event modes."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence


EVENT_TYPES = ("missingRing", "falseRing")
WINDOW_WIDTH = 13


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


def hit(window: Sequence[int], truth: int) -> bool:
    return window[0] <= truth <= window[1]


def prepare_case(source: dict[str, Any], feature: str, maximum_shift: int):
    current = list(map(int, source["primaryRange"]))
    if current[1] - current[0] + 1 != WINDOW_WIDTH:
        return None
    coarse = list(map(int, source["coarseRange"]))
    rows = source["rows"]
    years = [int(row["year"]) for row in rows]
    ranks = percentile_ranks([float(row["features"][feature]) for row in rows])
    index_by_year = {year: index for index, year in enumerate(years)}
    current_center = round((current[0] + current[1]) / 2)
    possible_centers = [
        year for year in years
        if year - WINDOW_WIDTH // 2 >= coarse[0]
        and year + WINDOW_WIDTH // 2 <= coarse[1]
    ]
    if not possible_centers or current_center not in index_by_year:
        return None
    peak_year = max(
        possible_centers,
        key=lambda year: (ranks[index_by_year[year]], year),
    )
    direction = (peak_year > current_center) - (peak_year < current_center)
    shift = direction * min(maximum_shift, abs(peak_year - current_center))
    selected = [current[0] + shift, current[1] + shift]
    if selected[0] < coarse[0] or selected[1] > coarse[1] or shift == 0:
        return None
    peak_score = ranks[index_by_year[peak_year]]
    current_score = ranks[index_by_year[current_center]]
    remote = [
        ranks[index_by_year[year]]
        for year in possible_centers
        if abs(year - peak_year) > WINDOW_WIDTH // 2
    ]
    return {
        "key": source["key"],
        "dataset": source["split"],
        "file": source["file"],
        "target": source["target"],
        "truth": int(source["truthYear"]),
        "current": current,
        "selected": selected,
        "peakYear": peak_year,
        "shift": shift,
        "distance": abs(peak_year - current_center),
        "advantage": peak_score - current_score,
        "remoteMargin": peak_score - max(remote, default=peak_score),
    }


def use(row: dict[str, Any], gate: dict[str, float]) -> bool:
    return (
        row["distance"] >= gate["minimumDistance"]
        and row["advantage"] >= gate["minimumAdvantage"]
        and row["remoteMargin"] >= gate["minimumRemoteMargin"]
    )


def metrics(rows: Iterable[dict[str, Any]], gate: dict[str, float]):
    result = {
        "cases": 0,
        "oldHits": 0,
        "newHits": 0,
        "gains": 0,
        "losses": 0,
        "changes": 0,
    }
    for row in rows:
        result["cases"] += 1
        changed = use(row, gate)
        old_hit = hit(row["current"], row["truth"])
        new_hit = hit(row["selected"], row["truth"]) if changed else old_hit
        result["oldHits"] += int(old_hit)
        result["newHits"] += int(new_hit)
        result["gains"] += int(changed and new_hit and not old_hit)
        result["losses"] += int(changed and old_hit and not new_hit)
        result["changes"] += int(changed)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    features = sorted(raw[0]["rows"][0]["features"])
    datasets = sorted({str(row["split"]) for row in raw})
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}

    for event_type in EVENT_TYPES:
        sources = [row for row in raw if row["eventType"] == event_type]
        candidates = []
        for feature in features:
            for maximum_shift in (1, 2):
                rows = [
                    row for source in sources
                    if (row := prepare_case(source, feature, maximum_shift))
                ]
                for minimum_distance in (1, 2, 3, 5, 7):
                    for minimum_advantage in (0, 0.02, 0.05, 0.1, 0.15, 0.2):
                        for minimum_remote_margin in (-math.inf, 0, 0.05, 0.1):
                            gate = {
                                "minimumDistance": minimum_distance,
                                "minimumAdvantage": minimum_advantage,
                                "minimumRemoteMargin": minimum_remote_margin,
                            }
                            total = metrics(rows, gate)
                            if total["gains"] == 0 or total["losses"] > 0:
                                continue
                            candidates.append({
                                "feature": feature,
                                "maximumShift": maximum_shift,
                                "gate": gate,
                                "total": total,
                                "byDataset": {
                                    name: metrics(
                                        (row for row in rows if row["dataset"] == name),
                                        gate,
                                    )
                                    for name in datasets
                                },
                            })
        candidates.sort(key=lambda row: (
            row["total"]["gains"],
            -row["total"]["changes"],
        ), reverse=True)
        selected = candidates[0] if candidates else None
        changes = []
        if selected:
            rows = [
                row for source in sources
                if (row := prepare_case(
                    source,
                    selected["feature"],
                    selected["maximumShift"],
                ))
            ]
            changes = [{
                **row,
                "oldHit": hit(row["current"], row["truth"]),
                "newHit": hit(row["selected"], row["truth"]),
            } for row in rows if use(row, selected["gate"])]
        report["eventTypes"][event_type] = {
            "selected": selected,
            "changes": changes,
            "candidates": candidates[:100],
            "bestByDataset": {
                name: sorted(
                    (
                        row for row in candidates
                        if row["byDataset"][name]["gains"] > 0
                    ),
                    key=lambda row: (
                        row["byDataset"][name]["gains"],
                        sum(
                            summary["gains"] > 0
                            for summary in row["byDataset"].values()
                        ),
                        row["total"]["gains"],
                        -row["total"]["changes"],
                    ),
                    reverse=True,
                )[:25]
                for name in datasets
            },
        }
        print(json.dumps({event_type: candidates[:5]}, indent=2))

    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
