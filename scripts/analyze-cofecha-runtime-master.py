"""Identify which captured COFECHA stage feeds the saved master series."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import OrderedDict, defaultdict
from pathlib import Path
from statistics import fmean


DATA_LINE = re.compile(r"^(.{1,8})\s+(-?\d{1,4})(.*)$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rwl", required=True, type=Path)
    parser.add_argument("--runtime-stages", required=True, type=Path)
    parser.add_argument("--master", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def parse_rwl(path: Path) -> list[dict[str, object]]:
    series: OrderedDict[str, dict[int, float]] = OrderedDict()
    for line in path.read_text(encoding="ascii", errors="replace").splitlines():
        match = DATA_LINE.match(line)
        if not match:
            continue
        ident = match.group(1).strip()
        year = int(match.group(2))
        if not ident or not 1000 <= year <= 3000:
            continue
        widths = [int(value) for value in re.findall(r"-?\d+", match.group(3))]
        if not widths:
            continue
        target = series.setdefault(ident.upper(), {})
        for offset, width in enumerate(widths):
            if width in (-9999, 999):
                break
            target[year + offset] = width
    result = []
    for ident, by_year in series.items():
        if not by_year:
            continue
        start_year = min(by_year)
        end_year = max(by_year)
        result.append({
            "ident": ident,
            "startYear": start_year,
            "endYear": end_year,
            "values": [by_year.get(year, 0) for year in range(start_year, end_year + 1)],
        })
    return result


def parse_master(path: Path) -> dict[int, float]:
    result: dict[int, float] = {}
    for line in path.read_text(encoding="ascii", errors="replace").splitlines():
        fields = line.split()
        if len(fields) == 2:
            try:
                result[int(fields[0])] = float(fields[1])
            except ValueError:
                pass
    return result


def standardize(values: dict[int, float], sample: bool) -> dict[int, float]:
    rows = list(values.values())
    average = fmean(rows)
    denominator = len(rows) - (1 if sample else 0)
    scale = math.sqrt(sum((value - average) ** 2 for value in rows) / denominator)
    return {year: (value - average) / scale for year, value in values.items()}


def compare(expected: dict[int, float], actual: dict[int, float]) -> dict[str, float | int]:
    years = sorted(expected.keys() & actual.keys())
    expected_values = [expected[year] for year in years]
    actual_values = [actual[year] for year in years]
    expected_mean = fmean(expected_values)
    actual_mean = fmean(actual_values)
    covariance = sum(
        (expected[year] - expected_mean) * (actual[year] - actual_mean)
        for year in years
    )
    expected_variance = sum((value - expected_mean) ** 2 for value in expected_values)
    actual_variance = sum((value - actual_mean) ** 2 for value in actual_values)
    errors = [actual[year] - expected[year] for year in years]
    return {
        "years": len(years),
        "correlation": covariance / math.sqrt(expected_variance * actual_variance),
        "rmse": math.sqrt(fmean(error * error for error in errors)),
        "maxAbsoluteError": max(abs(error) for error in errors),
        "exactFourDecimals": sum(
            f"{actual[year]:.4f}" == f"{expected[year]:.4f}" for year in years
        ),
    }


def aggregate_stage(
    records: list[dict[str, object]],
    series: list[dict[str, object]],
    omit_absent: bool,
) -> dict[int, float] | None:
    if len(records) != len(series):
        return None
    values_by_year: dict[int, list[float]] = defaultdict(list)
    for record, tree in zip(records, series):
        output = record.get("output")
        source = tree["values"]
        if not isinstance(output, list) or len(output) != len(source):
            return None
        start_year = int(tree["startYear"])
        for index, value in enumerate(output):
            if omit_absent and source[index] == 0:
                continue
            values_by_year[start_year + index].append(float(value))
    return {
        year: fmean(values)
        for year, values in sorted(values_by_year.items())
        if values
    }


def main() -> None:
    args = parse_args()
    trees = parse_rwl(args.rwl)
    runtime = json.loads(args.runtime_stages.read_text(encoding="utf-8"))
    expected = parse_master(args.master)
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for record in runtime["records"]:
        if record.get("stage") == "standardize":
            grouped[str(record.get("callerOffset"))].append(record)

    variants = []
    for caller, records in sorted(grouped.items()):
        for omit_absent in (False, True):
            raw = aggregate_stage(records, trees, omit_absent)
            if raw is None:
                continue
            for master_standardization in ("none", "population", "sample"):
                actual = raw if master_standardization == "none" else standardize(
                    raw,
                    sample=master_standardization == "sample",
                )
                variants.append({
                    "callerOffset": caller,
                    "omitAbsent": omit_absent,
                    "masterStandardization": master_standardization,
                    **compare(expected, actual),
                })
    variants.sort(key=lambda row: (-row["correlation"], row["rmse"]))
    output = {
        "schemaVersion": 1,
        "sourceRwl": str(args.rwl.resolve()),
        "runtimeStages": str(args.runtime_stages.resolve()),
        "master": str(args.master.resolve()),
        "seriesCount": len(trees),
        "bestVariants": variants[:30],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(variants[0], ensure_ascii=False))


if __name__ == "__main__":
    main()
