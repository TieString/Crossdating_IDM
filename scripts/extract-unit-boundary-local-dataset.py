"""Extract compact unit-event year-ranking cases from rich ITRDB audits."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


UNIT_EVENTS = {"missingRing", "falseRing"}


def case_key(
    file_name: str,
    target: str,
    event_type: str,
    truth_year: int,
) -> tuple[str, str, str, int]:
    return (
        file_name.replace("\\", "/").lower(),
        target,
        event_type,
        int(truth_year),
    )


def parse_numeric_notes(notes: list[str]) -> dict[str, float]:
    result: dict[str, float] = {}
    for note in notes:
        if "=" not in note:
            continue
        name, value = note.split("=", 1)
        try:
            result[name] = float(value)
        except ValueError:
            continue
    return result


def matching_window(
    source: dict[str, Any],
    start_year: int,
    end_year: int,
) -> dict[str, Any] | None:
    exact = [
        row for row in source.get("windows", [])
        if int(row["startYear"]) == start_year
        and int(row["endYear"]) == end_year
    ]
    if exact:
        return sorted(
            exact,
            key=lambda row: (
                int(row.get("eventRank", 99)),
                int(row.get("locationRank", 99)),
                str(row.get("source", "")) != "event",
            ),
        )[0]
    return None


def matching_locator(
    rows: list[dict[str, Any]],
    start_year: int,
    end_year: int,
) -> dict[str, Any] | None:
    exact = [
        row for row in rows
        if int(row.get("finalWindow", {}).get("startYear", -1)) == start_year
        and int(row.get("finalWindow", {}).get("endYear", -1)) == end_year
    ]
    return exact[0] if exact else (rows[0] if rows else None)


def profile_values(
    locator: dict[str, Any] | None,
    years: list[int],
) -> dict[str, list[float]]:
    if locator is None:
        return {}
    locator_years = [int(year) for year in locator.get("years", [])]
    indexes = {year: index for index, year in enumerate(locator_years)}
    if any(year not in indexes for year in years):
        return {}
    result: dict[str, list[float]] = {}
    for name, values in locator.get("ranks", {}).items():
        if len(values) != len(locator_years):
            continue
        result[name] = [float(values[indexes[year]]) for year in years]
    return result


def extract(path: Path, split: str) -> list[dict[str, Any]]:
    audit = json.loads(path.read_text(encoding="utf-8"))
    fixed = {
        case_key(
            row["file"],
            row["target"],
            row["eventType"],
            row["truthYear"],
        ): row
        for row in audit.get("fixedWindowCounterfactualCases", [])
        if row.get("eventType") in UNIT_EVENTS
    }
    locators: dict[tuple[str, str, str, int], list[dict[str, Any]]] = {}
    for row in audit.get("counterfactualLocatorCases", []):
        context = row.get("context", {})
        if row.get("eventType") not in UNIT_EVENTS:
            continue
        key = case_key(
            context.get("file", context.get("groupId", "")),
            context.get("target", ""),
            row["eventType"],
            row["truthYear"],
        )
        locators.setdefault(key, []).append(row)

    result: list[dict[str, Any]] = []
    for ranking in audit.get("rankingCases", []):
        event_type = ranking.get("eventType")
        if event_type not in UNIT_EVENTS:
            continue
        start_year, end_year = map(int, ranking["range"])
        truth_year = int(ranking["truthYear"])
        if not start_year <= truth_year <= end_year:
            continue
        key = case_key(
            ranking["groupId"],
            ranking["seriesId"],
            event_type,
            truth_year,
        )
        fixed_case = fixed.get(key)
        if fixed_case is None:
            continue
        window = matching_window(fixed_case, start_year, end_year)
        if window is None:
            continue
        rows = sorted(window.get("rows", []), key=lambda row: int(row["year"]))
        years = [int(row["year"]) for row in rows]
        if years != list(range(start_year, end_year + 1)):
            continue
        locator = matching_locator(locators.get(key, []), start_year, end_year)
        if locator is None or locator.get("context", {}).get("baselineFlagged") is not False:
            continue
        profiles = profile_values(locator, years)
        if not profiles:
            continue
        context = locator.get("context", {}) if locator else {}
        result.append({
            "key": "|".join([
                split,
                key[0],
                key[1],
                key[2],
                str(key[3]),
            ]),
            "split": split,
            "eventType": event_type,
            "truthYear": truth_year,
            "years": years,
            "baselineRanked": [
                {
                    "year": int(row["year"]),
                    "score": float(row["score"]),
                }
                for row in ranking["rankedYears"]
                if int(row["year"]) in set(years)
            ],
            "fixedFeatures": [row["features"] for row in rows],
            "profileScores": profiles,
            "context": context,
            "notes": parse_numeric_notes(ranking.get("notes", [])),
            "sourceAudit": str(path),
        })
    return result


def common_feature_names(cases: list[dict[str, Any]]) -> set[str]:
    feature_sets = [
        set(row)
        for case in cases
        for row in case["fixedFeatures"]
    ]
    return set.intersection(*feature_sets) if feature_sets else set()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        action="append",
        required=True,
        help="Dataset label and audit path as label=path",
    )
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    cases: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, int]] = set()
    for source in args.source:
        split, raw_path = source.split("=", 1)
        for case in extract(Path(raw_path), split):
            identity = case_key(
                case["key"].split("|")[1],
                case["key"].split("|")[2],
                case["eventType"],
                case["truthYear"],
            )
            if identity in seen:
                continue
            seen.add(identity)
            cases.append(case)

    common = common_feature_names(cases)
    for case in cases:
        case["fixedFeatures"] = [
            {name: float(row[name]) for name in sorted(common)}
            for row in case["fixedFeatures"]
        ]
    Path(args.output).write_text(
        json.dumps(cases, separators=(",", ":")),
        encoding="utf-8",
    )
    counts: dict[tuple[str, str], int] = {}
    for case in cases:
        key = (case["split"], case["eventType"])
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({
        "cases": len(cases),
        "featureCount": len(common),
        "boundaryFeatureCount": sum("Boundary" in name for name in common),
        "counts": {"/".join(key): value for key, value in sorted(counts.items())},
    }, indent=2))


if __name__ == "__main__":
    main()
