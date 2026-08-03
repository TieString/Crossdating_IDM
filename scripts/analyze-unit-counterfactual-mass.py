"""Compare direct counterfactual probability-mass windows with production windows."""

from __future__ import annotations

import argparse
import gc
import json
from collections import defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Any, Sequence


EVENT_TYPES = ("missingRing", "falseRing")
WINDOW_WIDTH = 13
PROFILE_NAMES = {
    "missingRing": (
        "differencePredictiveWeightedHuber21",
        "differencePredictiveEnsembleHuber31",
        "differencePredictiveWeightedHuber61",
        "whitenedPredictiveEnsembleHuber21",
    ),
    "falseRing": (
        "differenceMasterHuber31",
        "whitenedMasterHuber31",
        "differenceReferenceWeightedHuber31",
        "differenceMasterHuber21",
    ),
}


def dataset_name(path: Path) -> str:
    name = path.name.lower()
    if "calibration" in name:
        return "calibration"
    if "validation" in name or "independent" in name or "reserved" in name:
        return "validation"
    if "train" in name:
        return "train"
    return "other"


def percentile_ranks(values: Sequence[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    result = [0.0] * len(values)
    for rank, index in enumerate(order):
        result[index] = rank / max(1, len(values) - 1)
    return result


def standardize(values: Sequence[float]) -> list[float]:
    center = mean(values)
    variance = mean([(value - center) ** 2 for value in values])
    scale = variance ** 0.5 or 1.0
    return [(value - center) / scale for value in values]


def select_window(
    rows: Sequence[dict[str, Any]],
    transform: str,
    current_center: float,
    window_width: int = WINDOW_WIDTH,
) -> tuple[int, int, float, float]:
    names = sorted(rows[0]["profiles"])
    profiles = []
    for name in names:
        values = [float(row["profiles"].get(name, -10)) for row in rows]
        profiles.append(
            percentile_ranks(values) if transform == "rank" else standardize(values)
        )
    point_scores = [
        median([profile[index] for profile in profiles])
        for index in range(len(rows))
    ]
    windows = []
    for index in range(len(rows) - window_width + 1):
        start = int(rows[index]["year"])
        end = int(rows[index + window_width - 1]["year"])
        if end - start + 1 != window_width:
            continue
        score = sum(point_scores[index:index + window_width])
        windows.append((
            score,
            -abs((start + end) / 2 - current_center),
            start,
            end,
        ))
    if not windows:
        year = int(rows[max(range(len(point_scores)), key=point_scores.__getitem__)]["year"])
        return year - 6, year + 6, 0.0, 0.0
    windows.sort(reverse=True)
    selected = windows[0]
    remote = max(
        (row[0] for row in windows[1:] if row[3] < selected[2] or row[2] > selected[3]),
        default=selected[0],
    )
    return selected[2], selected[3], selected[0], selected[0] - remote


def select_rich_window(
    source: dict[str, Any],
    transform: str,
    current_center: float,
) -> tuple[int, int, float, float] | None:
    names = [
        name for name in PROFILE_NAMES[source["eventType"]]
        if name in source["rows"][0]["features"]
    ]
    if not names:
        return None
    rows = [{
        "year": row["year"],
        "profiles": {name: row["features"][name] for name in names},
    } for row in source["rows"]]
    return select_window(rows, transform, current_center)


def load_rich(path: Path, payload: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for source in payload:
        event_type = source.get("eventType")
        final = source.get("primaryRange")
        if event_type not in EVENT_TYPES or not final or len(source.get("rows", [])) < 13:
            continue
        truth = int(source["truthYear"])
        old_start, old_end = map(int, final)
        current_center = (old_start + old_end) / 2
        methods = {
            transform: select_rich_window(source, transform, current_center)
            for transform in ("rank", "zscore")
        }
        if any(value is None for value in methods.values()):
            continue
        source_audit = str(source.get("sourceAudit", path.name)).lower()
        dataset = (
            "reserved" if "reserved-rich" in source_audit
            else str(source.get("split") or dataset_name(Path(source_audit)))
        )
        result.append({
            "source": source_audit,
            "dataset": dataset,
            "group": str(source.get("file", "")).lower(),
            "eventType": event_type,
            "truth": truth,
            "old": (old_start, old_end),
            "oldHit": old_start <= truth <= old_end,
            "oldWidth": old_end - old_start + 1,
            "methods": methods,
        })
    return result


def load(
    path: Path,
    profile_field: str = "profiles",
    window_width: int = WINDOW_WIDTH,
) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        result = load_rich(path, payload)
        del payload
        gc.collect()
        return result
    result = []
    for row in payload.get("counterfactualLocatorCases", []):
        if row.get("eventType") not in EVENT_TYPES:
            continue
        if row.get("context", {}).get("baselineFlagged", True):
            continue
        if row.get("correctionYears") != row.get("truthCorrectionYears"):
            continue
        counterfactual = row.get("unitCounterfactualRows") or []
        final = row.get("finalWindow")
        if len(counterfactual) < WINDOW_WIDTH or not final:
            continue
        truth = int(row["truthYear"])
        old_start = int(final["startYear"])
        old_end = int(final["endYear"])
        current_center = (old_start + old_end) / 2
        selected_rows = [{
            "year": source["year"],
            "profiles": source.get(profile_field) or {},
        } for source in counterfactual]
        if not selected_rows[0]["profiles"]:
            continue
        methods = {
            transform: select_window(
                selected_rows,
                transform,
                current_center,
                window_width,
            )
            for transform in ("rank", "zscore")
        }
        result.append({
            "source": path.name,
            "dataset": dataset_name(path),
            "group": str(row["context"].get("file", "")).lower(),
            "eventType": row["eventType"],
            "truth": truth,
            "old": (old_start, old_end),
            "oldHit": old_start <= truth <= old_end,
            "oldWidth": old_end - old_start + 1,
            "methods": methods,
        })
    del payload
    gc.collect()
    return result


def summarize(rows: Sequence[dict[str, Any]], method: str, wide_only: bool) -> dict[str, Any]:
    old_hits = new_hits = gains = losses = changes = 0
    margins = []
    for row in rows:
        start, end, _score, margin = row["methods"][method]
        use = not wide_only or row["oldWidth"] == WINDOW_WIDTH
        new_hit = start <= row["truth"] <= end if use else row["oldHit"]
        old_hits += int(row["oldHit"])
        new_hits += int(new_hit)
        gains += int(use and new_hit and not row["oldHit"])
        losses += int(use and row["oldHit"] and not new_hit)
        changes += int(use and (start, end) != tuple(row["old"]))
        if use:
            margins.append(margin)
    return {
        "cases": len(rows),
        "oldHits": old_hits,
        "newHits": new_hits,
        "oldCoverage": old_hits / max(1, len(rows)),
        "newCoverage": new_hits / max(1, len(rows)),
        "delta": new_hits - old_hits,
        "gains": gains,
        "losses": losses,
        "changes": changes,
        "medianRemoteMargin": median(margins) if margins else 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--profile-field", default="profiles")
    parser.add_argument("--window-width", type=int, default=WINDOW_WIDTH)
    parser.add_argument("--report", default=".tmp-unit-counterfactual-mass-report.json")
    args = parser.parse_args()
    cases = []
    for raw_path in args.paths:
        path = Path(raw_path)
        loaded = load(path, args.profile_field, args.window_width)
        cases.extend(loaded)
        print(f"loaded {path.name}: {len(loaded)} unit cases", flush=True)
    report: dict[str, Any] = {"schemaVersion": 1, "sources": args.paths, "results": {}}
    for event_type in EVENT_TYPES:
        report["results"][event_type] = {}
        typed = [row for row in cases if row["eventType"] == event_type]
        for dataset in ("train", "calibration", "validation", "reserved", "other", "all"):
            selected = typed if dataset == "all" else [
                row for row in typed if row["dataset"] == dataset
            ]
            if not selected:
                continue
            report["results"][event_type][dataset] = {
                f"{method}:{scope}": summarize(
                    selected, method, scope == "wideOnly"
                )
                for method in ("rank", "zscore")
                for scope in ("allAnswered", "wideOnly")
            }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["results"], indent=2))


if __name__ == "__main__":
    main()
