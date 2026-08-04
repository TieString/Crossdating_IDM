"""Evaluate a compact left/center/right false-ring window arbiter.

This is an analysis-only script.  It never uses the synthetic false-ring mode;
each 29-year coarse interval is represented by three overlapping 13-year
windows and ranked from evidence available to the TypeScript runtime.
"""

from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np


WIDTH = 13
PROFILE_SETS = {
    "compact": (
        "cumulativeReferenceMean",
        "cumulativeReferenceMedian",
        "reference:rankMedian",
        "whitenedFull",
        "comboFull",
        "differenceFull",
        "transitionSplitGain",
        "cumulativeDifference",
        "cumulativeCombined",
        "pairPeakKernel5",
    ),
    "state": (
        "cumulativeReferenceMean",
        "cumulativeReferenceMedian",
        "cumulativeReferenceVote",
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeCombinedCusum",
        "cumulativeDifferenceCusum",
        "cumulativeRawCusum",
        "cumulativeWhitenedCusum",
        "piecewiseCombinedObjective",
        "transitionSplitGain",
    ),
}
CF_PROFILES = (
    "rawMasterR31",
    "differenceMasterR21",
    "differenceMasterR31",
    "whitenedMasterR31",
    "differenceReferenceWeightedR21",
    "differenceReferenceWeightedR31",
    "differenceMasterHuber31",
    "whitenedMasterHuber31",
    "differenceReferenceWeightedHuber31",
    "differenceMasterHuber21",
    "falseMergeOlderRawMasterR31",
    "falseMergeOlderDifferenceMasterR31",
    "falseMergeOlderDifferenceMasterHuber31",
    "falseMergeOlderRawMasterR31Advantage",
    "falseMergeOlderDifferenceMasterR31Advantage",
    "differenceReferenceRankMean31",
    "differenceReferenceRankMedian31",
    "differenceReferencePeakKernel5",
    "differenceReferencePeakKernel9",
    "differenceReferenceTopVote3",
)


@dataclass(frozen=True)
class Candidate:
    start: int
    center: int
    features: np.ndarray
    relevance: int


@dataclass(frozen=True)
class Case:
    split: str
    key: str
    truth: int
    baseline: tuple[int, int]
    candidates: tuple[Candidate, ...]


def identity(row: dict[str, Any]) -> str:
    context = row.get("context") or {}
    return "|".join((
        str(context.get("file", context.get("groupId", ""))).lower(),
        str(context.get("target", "")),
        str(int(row.get("truthYear", 0))),
    ))


def finite(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if np.isfinite(result) else 0.0


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values), dtype=np.float32)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        result[order[start:end]] = (
            (start + end - 1) / (2 * max(1, len(values) - 1))
        )
        start = end
    return result


def profile_candidate_features(
    years: np.ndarray,
    values: np.ndarray,
    start: int,
) -> list[float]:
    ranked = percentile_ranks(values)
    indexes = np.where((years >= start) & (years < start + WIDTH))[0]
    if len(indexes) == 0:
        return [0.0] * 7
    window = ranked[indexes]
    outside = ranked[np.where((years < start) | (years >= start + WIDTH))[0]]
    peak_year = int(years[int(np.argmax(ranked))])
    center = start + WIDTH // 2
    return [
        float(np.mean(window)),
        float(np.max(window)),
        float(np.sum(window) / max(1e-8, np.sum(ranked))),
        float(np.mean(window) - np.mean(outside)) if len(outside) else 0.0,
        (center - peak_year) / max(1, int(years[-1] - years[0])),
        abs(center - peak_year) / max(1, int(years[-1] - years[0])),
        float(start <= peak_year < start + WIDTH),
    ]


def anchor_features(center: int, value: Any, span: int) -> list[float]:
    if value is None:
        return [0.0, 0.0, 1.0, 0.0, 0.0]
    delta = center - int(value)
    return [
        1.0,
        delta / span,
        abs(delta) / span,
        float(abs(delta) <= 4),
        float(abs(delta) <= 6),
    ]


def overlap(start: int, window: dict[str, Any] | None) -> float:
    if not window:
        return 0.0
    return max(
        0,
        min(start + WIDTH - 1, int(window["endYear"]))
        - max(start, int(window["startYear"]))
        + 1,
    ) / WIDTH


def build_case(
    split: str,
    row: dict[str, Any],
    profile_names: Sequence[str],
    include_counterfactual: bool,
) -> Case | None:
    coarse = row.get("coarseWindow")
    final = row.get("finalWindow")
    years = np.asarray(row.get("years") or [], dtype=int)
    if not coarse or not final or len(years) < WIDTH:
        return None
    coarse_start = int(coarse["startYear"])
    coarse_end = int(coarse["endYear"])
    if coarse_end - coarse_start + 1 < WIDTH:
        return None
    starts = tuple(dict.fromkeys((
        coarse_start,
        round((coarse_start + coarse_end - WIDTH + 1) / 2),
        coarse_end - WIDTH + 1,
    )))
    ranks = row.get("ranks") or {}
    usable_profiles = [
        name for name in profile_names
        if isinstance(ranks.get(name), list) and len(ranks[name]) == len(years)
    ]
    cf_by_year = {
        int(point["year"]): point.get("profiles") or {}
        for point in row.get("unitCounterfactualRows") or []
    }
    cf_years = np.asarray(sorted(cf_by_year), dtype=int)
    usable_cf = [
        name for name in CF_PROFILES
        if include_counterfactual
        and len(cf_years) > 0
        and all(name in cf_by_year[int(year)] for year in cf_years)
    ]
    operation = row.get("selectedOperation") or {}
    anchors = (
        row.get("currentPrimaryYear"),
        operation.get("bestYear"),
        operation.get("sideStepBestYear"),
    )
    stage_windows = (
        final,
        row.get("learnedWindow"),
        row.get("modeWindow"),
        row.get("prePointModeWindow"),
        row.get("preFalseCurrentAnchorModeWindow"),
        row.get("preDirectModeWindow"),
        row.get("currentWindow"),
    )
    span = max(1, coarse_end - coarse_start)
    truth = int(row["truthYear"])
    candidates = []
    for candidate_start in starts:
        center = candidate_start + WIDTH // 2
        features: list[float] = [
            (center - coarse_start) / span,
            (center - (coarse_start + coarse_end) / 2) / span,
            abs(center - (coarse_start + coarse_end) / 2) / span,
        ]
        for anchor in anchors:
            features.extend(anchor_features(center, anchor, span))
        features.extend(overlap(candidate_start, window) for window in stage_windows)
        internal = row.get("candidates") or []
        support = [
            candidate for candidate in internal
            if int(candidate["startYear"]) <= center <= int(candidate["endYear"])
        ]
        features.extend((
            len(support) / max(1, len(internal)),
            max((finite(item.get("aggregateScore")) for item in support), default=0),
            max((finite(item.get("overlapConsensus")) for item in support), default=0),
        ))
        for name in usable_profiles:
            features.extend(profile_candidate_features(
                years,
                np.asarray(ranks[name], dtype=np.float32),
                candidate_start,
            ))
        for name in usable_cf:
            features.extend(profile_candidate_features(
                cf_years,
                np.asarray([
                    finite(cf_by_year[int(year)][name]) for year in cf_years
                ], dtype=np.float32),
                candidate_start,
            ))
        distance = abs(center - truth)
        candidates.append(Candidate(
            start=candidate_start,
            center=center,
            features=np.asarray(features, dtype=np.float32),
            relevance=max(0, WIDTH // 2 + 1 - distance),
        ))
    return Case(
        split=split,
        key=identity(row),
        truth=truth,
        baseline=(int(final["startYear"]), int(final["endYear"])),
        candidates=tuple(candidates),
    )


def load_cases(
    sources: Sequence[str],
    profile_set: str,
    include_counterfactual: bool,
) -> list[Case]:
    cases = []
    seen = set()
    for source in sources:
        split, raw_path = source.split("=", 1)
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        for row in payload.get("counterfactualLocatorCases", []):
            context = row.get("context") or {}
            if row.get("eventType") != "falseRing" or context.get("baselineFlagged", True):
                continue
            case = build_case(
                split,
                row,
                PROFILE_SETS[profile_set],
                include_counterfactual,
            )
            if case and case.key not in seen:
                seen.add(case.key)
                cases.append(case)
    return cases


def make_model(seed: int, leaves: int, depth: int, estimators: int):
    return lgb.LGBMRanker(
        objective="lambdarank",
        label_gain=[0, 1, 3, 7, 15, 31, 63, 127],
        n_estimators=estimators,
        learning_rate=0.03,
        num_leaves=leaves,
        max_depth=depth,
        min_child_samples=40,
        max_bin=31,
        reg_lambda=30,
        reg_alpha=6,
        colsample_bytree=0.7,
        subsample=0.85,
        subsample_freq=1,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def fit(cases: Sequence[Case], config: tuple[int, int, int], seed: int):
    model = make_model(seed, *config)
    model.fit(
        np.vstack([candidate.features for case in cases for candidate in case.candidates]),
        np.asarray([candidate.relevance for case in cases for candidate in case.candidates]),
        group=[len(case.candidates) for case in cases],
    )
    return model


def predict(model: Any, cases: Sequence[Case]) -> list[dict[str, Any]]:
    result = []
    for case in cases:
        scores = np.asarray(model.predict(np.vstack([
            candidate.features for candidate in case.candidates
        ])), dtype=float)
        order = sorted(
            range(len(scores)),
            key=lambda index: (scores[index], case.candidates[index].center),
            reverse=True,
        )
        selected = case.candidates[order[0]]
        baseline_center = sum(case.baseline) / 2
        result.append({
            "case": case,
            "start": selected.start,
            "hit": selected.start <= case.truth < selected.start + WIDTH,
            "baselineHit": case.baseline[0] <= case.truth <= case.baseline[1],
            "margin": float(scores[order[0]] - scores[order[1]]),
            "distance": abs(selected.center - baseline_center),
        })
    return result


def metrics(rows: Sequence[dict[str, Any]], gate: tuple[float, float, int]) -> dict[str, int]:
    minimum_margin, maximum_distance, baseline_width = gate
    old = new = gain = loss = changed = 0
    for row in rows:
        case: Case = row["case"]
        width = case.baseline[1] - case.baseline[0] + 1
        use = (
            row["margin"] >= minimum_margin
            and row["distance"] <= maximum_distance
            and (baseline_width == 0 or width == baseline_width)
        )
        old_hit = bool(row["baselineHit"])
        new_hit = bool(row["hit"]) if use else old_hit
        old += old_hit
        new += new_hit
        gain += new_hit and not old_hit
        loss += old_hit and not new_hit
        changed += use
    return {
        "cases": len(rows), "old": old, "new": new,
        "gain": gain, "loss": loss, "changed": changed,
    }


def select_gate(rows: Sequence[dict[str, Any]], splits: Sequence[str]):
    margins = np.asarray([row["margin"] for row in rows])
    thresholds = sorted(set((
        0.0,
        *[float(np.quantile(margins, q)) for q in (0.25, 0.5, 0.7, 0.8, 0.9)],
    )))
    choices = []
    for gate in itertools.product(thresholds, (2, 4, 6, 8, 12, 100), (0, 9, 13)):
        folds = {
            split: metrics(
                [row for row in rows if row["case"].split == split],
                gate,
            )
            for split in splits
        }
        if any(fold["new"] < fold["old"] for fold in folds.values()):
            continue
        overall = metrics(rows, gate)
        choices.append((
            (overall["new"], -overall["loss"], -overall["changed"]),
            gate,
            overall,
            folds,
        ))
    return max(choices, default=None, key=lambda row: row[0])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    splits = [source.split("=", 1)[0] for source in args.source]
    configs = ((3, 2, 60), (5, 3, 80), (7, 3, 100))
    search = []
    for profile_set, include_cf, config in itertools.product(
        PROFILE_SETS,
        (False, True),
        configs,
    ):
        cases = load_cases(args.source, profile_set, include_cf)
        rows = []
        for fold_index, split in enumerate(splits):
            train = [case for case in cases if case.split != split]
            test = [case for case in cases if case.split == split]
            rows.extend(predict(fit(train, config, 20260850 + fold_index), test))
        gate = select_gate(rows, splits)
        raw = metrics(rows, (0.0, 100, 0))
        search.append({
            "profileSet": profile_set,
            "includeCounterfactual": include_cf,
            "config": config,
            "featureCount": len(cases[0].candidates[0].features),
            "raw": raw,
            "gate": None if gate is None else {
                "minimumMargin": gate[1][0],
                "maximumDistance": gate[1][1],
                "baselineWidth": gate[1][2],
                "overall": gate[2],
                "folds": gate[3],
            },
        })
    search.sort(key=lambda row: (
        row["gate"]["overall"]["new"] if row["gate"] else -1,
        -(row["gate"]["overall"]["loss"] if row["gate"] else 10_000),
        row["raw"]["new"],
    ), reverse=True)
    payload = {"splits": splits, "top": search[:20]}
    Path(args.output).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
