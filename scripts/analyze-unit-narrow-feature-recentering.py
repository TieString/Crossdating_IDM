"""Search same-width, feature-directed recentering rules for narrow unit windows."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence


EVENT_TYPES = ("missingRing", "falseRing")


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
    final = list(map(int, source["finalRange"]))
    mode = list(map(int, source["primaryRange"]))
    width = final[1] - final[0] + 1
    if width >= 13:
        return None
    rows = source["rows"]
    years = [int(row["year"]) for row in rows]
    ranks = percentile_ranks([float(row["features"][feature]) for row in rows])
    index_by_year = {year: index for index, year in enumerate(years)}
    current_center = round((final[0] + final[1]) / 2)
    possible_centers = [
        year for year in years
        if year - width // 2 >= mode[0]
        and year + width // 2 <= mode[1]
    ]
    if not possible_centers or current_center not in index_by_year:
        return None
    peak_year = max(
        possible_centers,
        key=lambda year: (ranks[index_by_year[year]], year),
    )
    direction = (peak_year > current_center) - (peak_year < current_center)
    shift = direction * min(maximum_shift, abs(peak_year - current_center))
    selected = [final[0] + shift, final[1] + shift]
    if selected[0] < mode[0] or selected[1] > mode[1] or shift == 0:
        return None
    current_score = ranks[index_by_year[current_center]]
    peak_score = ranks[index_by_year[peak_year]]
    remote = [
        ranks[index_by_year[year]]
        for year in possible_centers
        if abs(year - peak_year) > width // 2
    ]
    remote_margin = peak_score - max(remote, default=peak_score)
    return {
        "key": source["key"],
        "dataset": source["split"],
        "file": source["file"],
        "target": source["target"],
        "truth": int(source["truthYear"]),
        "width": width,
        "current": final,
        "mode": mode,
        "selected": selected,
        "peakYear": peak_year,
        "shift": shift,
        "distance": abs(peak_year - current_center),
        "advantage": peak_score - current_score,
        "remoteMargin": remote_margin,
        "peakOutsideCurrent": not hit(final, peak_year),
    }


def metrics(rows: Iterable[dict[str, Any]], gate: dict[str, Any]):
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
        use = (
            row["distance"] >= gate["minimumDistance"]
            and row["advantage"] >= gate["minimumAdvantage"]
            and row["remoteMargin"] >= gate["minimumRemoteMargin"]
            and (
                not gate["requirePeakOutsideCurrent"]
                or row["peakOutsideCurrent"]
            )
        )
        old_hit = hit(row["current"], row["truth"])
        new_hit = hit(row["selected"], row["truth"]) if use else old_hit
        result["oldHits"] += int(old_hit)
        result["newHits"] += int(new_hit)
        result["gains"] += int(use and new_hit and not old_hit)
        result["losses"] += int(use and old_hit and not new_hit)
        result["changes"] += int(use)
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
                for minimum_distance in (1, 2, 3, 5):
                    for minimum_advantage in (0, 0.02, 0.05, 0.1, 0.15, 0.2):
                        for minimum_remote_margin in (-math.inf, 0, 0.05, 0.1):
                            for require_outside in (False, True):
                                gate = {
                                    "minimumDistance": minimum_distance,
                                    "minimumAdvantage": minimum_advantage,
                                    "minimumRemoteMargin": minimum_remote_margin,
                                    "requirePeakOutsideCurrent": require_outside,
                                }
                                total = metrics(rows, gate)
                                if total["gains"] == 0 or total["losses"] > 0:
                                    continue
                                by_dataset = {
                                    name: metrics(
                                        (row for row in rows if row["dataset"] == name),
                                        gate,
                                    )
                                    for name in datasets
                                }
                                candidates.append({
                                    "feature": feature,
                                    "maximumShift": maximum_shift,
                                    "gate": gate,
                                    "total": total,
                                    "byDataset": by_dataset,
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
            gate = selected["gate"]
            for row in rows:
                use = (
                    row["distance"] >= gate["minimumDistance"]
                    and row["advantage"] >= gate["minimumAdvantage"]
                    and row["remoteMargin"] >= gate["minimumRemoteMargin"]
                    and (
                        not gate["requirePeakOutsideCurrent"]
                        or row["peakOutsideCurrent"]
                    )
                )
                if use:
                    changes.append({
                        **row,
                        "oldHit": hit(row["current"], row["truth"]),
                        "newHit": hit(row["selected"], row["truth"]),
                    })
        report["eventTypes"][event_type] = {
            "selected": selected,
            "changes": changes,
            "candidates": candidates[:100],
        }
        print(json.dumps({event_type: candidates[:5]}, indent=2))

    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
