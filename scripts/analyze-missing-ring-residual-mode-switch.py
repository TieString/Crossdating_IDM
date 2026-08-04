"""Evaluate a missing-ring residual mode switch without truth-derived features.

The production locator remains the baseline. The learner only decides whether a
13-year candidate inside the accepted coarse interval is safer than that baseline.
Development predictions are leave-one-dataset-out; a separate validation dataset
does not participate in model or gate selection.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import lightgbm as lgb
import numpy as np


WIDTH = 13
HALF = WIDTH // 2
RULES = (
    "mode_mass",
    "corroborated_point_peak",
    "missing_direct_mode_ranker",
    "missing_direct_anchor_consensus",
    "missing_boundary_feature_recenter",
    "missing_boundary_anchor_recenter",
    "missing_mode_side_corrector",
    "missing_evidence_profile_mode",
    "missing_physical_profile_mode",
    "missing_family_profile_mode",
    "missing_family_remote_mode",
    "missing_predictive_remote_mode",
    "missing_current_anchor_recovery",
)


@dataclass(frozen=True)
class Candidate:
    start: int
    features: np.ndarray
    hit: bool


@dataclass(frozen=True)
class Case:
    dataset: str
    key: str
    group: str
    truth: int
    baseline: tuple[int, int]
    candidates: tuple[Candidate, ...]

    @property
    def baseline_hit(self) -> bool:
        return self.baseline[0] <= self.truth <= self.baseline[1]


def finite(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def identity(context: dict[str, Any]) -> str:
    return "|".join((
        str(context.get("groupId", context.get("file", ""))).lower(),
        str(context.get("target", "")),
        str(int(context.get("year", 0))),
    ))


def percentile_ranks(values: Sequence[float]) -> np.ndarray:
    raw = np.asarray(values, dtype=np.float32)
    order = np.argsort(raw, kind="stable")
    result = np.zeros(len(raw), dtype=np.float32)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and raw[order[end]] == raw[order[start]]:
            end += 1
        result[order[start:end]] = (
            (start + end - 1) / (2 * max(1, len(order) - 1))
        )
        start = end
    return result


def profile_maps(row: dict[str, Any]) -> dict[str, dict[int, float]]:
    years = [int(year) for year in row.get("years") or []]
    result: dict[str, dict[int, float]] = {}
    for name, values in (row.get("ranks") or {}).items():
        if isinstance(values, list) and len(values) == len(years):
            result[f"rank:{name}"] = dict(zip(years, map(finite, values)))
    counterfactual_rows = row.get("unitCounterfactualRows") or []
    raw_profiles: dict[str, dict[int, float]] = {}
    for source in counterfactual_rows:
        year = int(source["year"])
        for name, value in (source.get("profiles") or {}).items():
            raw_profiles.setdefault(f"cf:{name}", {})[year] = finite(value, -10)
    for name, values_by_year in raw_profiles.items():
        ordered_years = sorted(values_by_year)
        ranks = percentile_ranks([values_by_year[year] for year in ordered_years])
        result[name] = dict(zip(ordered_years, map(float, ranks)))
    return result


def common_profile_names(rows: Sequence[dict[str, Any]]) -> tuple[str, ...]:
    availability = [set(profile_maps(row)) for row in rows]
    return tuple(sorted(set.intersection(*availability))) if availability else ()


def candidate_source_names(rows: Sequence[dict[str, Any]]) -> tuple[str, ...]:
    return tuple(sorted({
        str(candidate.get("source") or "")
        for row in rows
        for candidate in row.get("candidates") or []
        if candidate.get("source")
    }))


def window_values(
    values_by_year: dict[int, float] | None,
    start: int,
) -> np.ndarray | None:
    if not values_by_year:
        return None
    values = [values_by_year.get(year) for year in range(start, start + WIDTH)]
    if any(value is None for value in values):
        return None
    return np.asarray(values, dtype=np.float32)


def aggregate_profile(
    values_by_year: dict[int, float] | None,
    start: int,
    current_start: int,
) -> list[float]:
    candidate = window_values(values_by_year, start)
    current = window_values(values_by_year, current_start)
    if candidate is None or current is None:
        return [0.0] * 10
    older = candidate[:4]
    newer = candidate[-4:]
    mass = float(np.sum(candidate))
    current_mass = float(np.sum(current))
    return [
        float(np.mean(candidate)),
        float(np.max(candidate)),
        float(candidate[HALF]),
        float(np.mean(older)),
        float(np.mean(newer)),
        float(np.mean(newer) - np.mean(older)),
        mass - current_mass,
        float(np.max(candidate) - np.max(current)),
        float(candidate[HALF] - current[HALF]),
        float(np.mean(np.abs(np.diff(candidate)))),
    ]


def centered_start(year: Any, first: int, last: int) -> int | None:
    if year is None:
        return None
    return max(first, min(int(round(float(year))) - HALF, last))


def build_case(
    dataset: str,
    row: dict[str, Any],
    profile_names: Sequence[str],
    source_names: Sequence[str],
    equal_width_baseline: bool = False,
    search_domain: str = "coarse",
) -> Case | None:
    coarse = row.get("coarseWindow")
    final = row.get("finalWindow")
    years = [int(year) for year in row.get("years") or []]
    if not coarse or not final or len(years) < WIDTH:
        return None
    global_first = years[0]
    global_last = years[-1] - WIDTH + 1
    coarse_first = max(int(coarse["startYear"]), global_first)
    coarse_last = min(int(coarse["endYear"]) - WIDTH + 1, global_last)
    if global_last < global_first or coarse_last < coarse_first:
        return None
    final_center = (int(final["startYear"]) + int(final["endYear"])) / 2
    current_start = max(
        global_first,
        min(round(final_center) - HALF, global_last),
    )
    baseline = (
        (current_start, current_start + WIDTH - 1)
        if equal_width_baseline
        else (int(final["startYear"]), int(final["endYear"]))
    )
    coarse_center = (int(coarse["startYear"]) + int(coarse["endYear"])) / 2
    span = max(1, years[-1] - years[0])
    profiles = profile_maps(row)
    operation = row.get("selectedOperation") or {}
    anchors = (
        row.get("currentPrimaryYear"),
        operation.get("bestYear"),
        operation.get("sideStepBestYear"),
    )
    rule = str(row.get("windowCenteringRule") or "")
    coarse_source = str(row.get("coarseSource") or "")
    truth = int(row["truthYear"])
    internal_candidates = row.get("candidates") or []
    if search_domain == "coarse":
        starts = list(range(coarse_first, coarse_last + 1))
    elif search_domain == "candidate-union":
        starts = [
            start
            for start in range(global_first, global_last + 1)
            if (
                int(coarse["startYear"]) <= start + HALF
                    <= int(coarse["endYear"])
                or any(
                    int(candidate["startYear"]) <= start + HALF
                        <= int(candidate["endYear"])
                    for candidate in internal_candidates
                )
            )
        ]
    elif search_domain == "all":
        starts = list(range(global_first, global_last + 1))
    else:
        raise ValueError(f"Unknown search domain: {search_domain}")
    if current_start not in starts:
        starts.append(current_start)
        starts.sort()
    candidates = []
    for start in starts:
        center = start + HALF
        delta = center - final_center
        features: list[float] = [
            delta / span,
            abs(delta) / span,
            float(start <= int(final["startYear"]) and start + WIDTH - 1 >= int(final["endYear"])),
            (center - coarse_center) / span,
            abs(center - coarse_center) / span,
            (center - global_first) / max(1, years[-1] - global_first),
            float(
                int(coarse["startYear"]) <= center
                    <= int(coarse["endYear"])
            ),
            float(int(final["endYear"]) - int(final["startYear"]) + 1),
            finite(row.get("learnedWindowMargin")),
            finite(row.get("learnedWindowRemoteMargin")),
            finite(row.get("nineYearSafety")),
            finite(row.get("nineYearSafetyThreshold")),
            finite(row.get("coarseModelMargin")),
            finite(row.get("coarseModelScore")),
            finite(operation.get("bestRawGain")),
            finite(operation.get("bestDifferenceGain")),
            finite(operation.get("bestCombinedGain")),
            finite(operation.get("topThreeDifferenceGain")),
            finite(operation.get("remoteDifferenceMargin")),
            finite(operation.get("bestSideStepScore")),
            finite(operation.get("topThreeSideStepScore")),
            finite(operation.get("bestSideMinimumAdvantage")),
            finite(operation.get("bestCorrectedSideSupport")),
            finite(operation.get("sideStepRemoteMargin")),
            *[float(rule == name) for name in RULES],
            float(coarse_source == "current_event"),
            float(coarse_source == "lag_transition"),
            float(coarse_source.startswith("reference_transition:")),
            float(coarse_source.startswith("profile:")),
        ]
        for anchor in anchors:
            if anchor is None:
                features.extend((0.0, 0.0, 0.0, 0.0))
            else:
                distance = center - int(anchor)
                features.extend((
                    distance / span,
                    abs(distance) / span,
                    float(abs(distance) <= HALF),
                    float(abs(distance) <= 4),
                ))
        supporting = [
            candidate for candidate in internal_candidates
            if int(candidate["startYear"]) <= center <= int(candidate["endYear"])
        ]
        features.extend((
            len(supporting) / max(1, len(internal_candidates)),
            max((finite(candidate.get("aggregateScore")) for candidate in supporting), default=0),
            max((finite(candidate.get("overlapConsensus")) for candidate in supporting), default=0),
        ))
        for source_name in source_names:
            matching = [
                candidate for candidate in internal_candidates
                if str(candidate.get("source") or "") == source_name
            ]
            distances = [
                abs(
                    center
                    - (
                        int(candidate["startYear"])
                        + int(candidate["endYear"])
                    ) / 2
                )
                for candidate in matching
            ]
            overlaps = [
                max(
                    0,
                    min(start + WIDTH - 1, int(candidate["endYear"]))
                        - max(start, int(candidate["startYear"]))
                        + 1,
                ) / WIDTH
                for candidate in matching
            ]
            features.extend((
                float(bool(matching)),
                max(overlaps, default=0),
                min(distances, default=span) / span,
                float(any(
                    int(candidate["startYear"]) <= center
                        <= int(candidate["endYear"])
                    for candidate in matching
                )),
                max((
                    finite(candidate.get("aggregateScore"))
                    for candidate in matching
                ), default=0),
                max((
                    finite(candidate.get("overlapConsensus"))
                    for candidate in matching
                ), default=0),
            ))
        for name in profile_names:
            features.extend(aggregate_profile(
                profiles.get(name),
                start,
                current_start,
            ))
        candidates.append(Candidate(
            start=start,
            features=np.asarray(features, dtype=np.float32),
            hit=start <= truth <= start + WIDTH - 1,
        ))
    context = row.get("context") or {}
    return Case(
        dataset=dataset,
        key=identity(context),
        group=str(context.get("groupId", context.get("file", ""))).lower(),
        truth=truth,
        baseline=baseline,
        candidates=tuple(candidates),
    )


def load_rows(arguments: Iterable[str]):
    datasets: dict[str, dict[str, int]] = {}
    rows: list[tuple[str, dict[str, Any]]] = []
    for argument in arguments:
        name, raw_path = argument.split("=", 1)
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        formal = {
            identity(outcome.get("context") or {}): outcome
            for outcome in payload.get("formalEventCaseOutcomes", [])
            if outcome.get("eventType") == "missingRing"
        }
        datasets[name] = {
            "denominator": len(formal),
            "baselineHits": sum(bool(outcome.get("primaryMatched")) for outcome in formal.values()),
        }
        seen = set()
        for row in payload.get("counterfactualLocatorCases", []):
            if row.get("eventType") != "missingRing":
                continue
            key = identity(row.get("context") or {})
            outcome = formal.get(key)
            if not outcome or not outcome.get("answered") or key in seen:
                continue
            rows.append((name, row))
            seen.add(key)
    return datasets, rows


def training_rows(cases: Sequence[Case]):
    x: list[np.ndarray] = []
    y: list[int] = []
    weights: list[float] = []
    for case in cases:
        baseline_hit = case.baseline_hit
        for candidate in case.candidates:
            x.append(candidate.features)
            y.append(int(candidate.hit))
            if not baseline_hit and candidate.hit:
                weights.append(4.0)
            elif baseline_hit and not candidate.hit:
                weights.append(3.0)
            elif not baseline_hit:
                weights.append(1.5)
            else:
                weights.append(0.5)
    if not x or len(set(y)) < 2:
        raise RuntimeError("Residual switch training needs both gains and losses")
    return np.vstack(x), np.asarray(y), np.asarray(weights)


def fit_model(cases: Sequence[Case], seed: int, variant: str):
    settings = {
        "small": dict(n_estimators=60, num_leaves=5, max_depth=3, min_child_samples=24),
        "medium": dict(n_estimators=90, num_leaves=7, max_depth=3, min_child_samples=20),
        "wide": dict(n_estimators=120, num_leaves=9, max_depth=4, min_child_samples=20),
    }[variant]
    model = lgb.LGBMClassifier(
        objective="binary",
        learning_rate=0.025,
        max_bin=63,
        reg_lambda=40,
        reg_alpha=8,
        colsample_bytree=0.65,
        subsample=0.85,
        subsample_freq=1,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
        **settings,
    )
    x, y, weights = training_rows(cases)
    model.fit(x, y, sample_weight=weights)
    return model


def predict(model: Any, cases: Sequence[Case]):
    result = []
    for case in cases:
        matrix = np.vstack([candidate.features for candidate in case.candidates])
        probabilities = np.asarray(model.predict_proba(matrix)[:, 1], dtype=float)
        selected_index = int(np.argmax(probabilities))
        selected = case.candidates[selected_index]
        current_center = sum(case.baseline) / 2
        current_index = min(
            range(len(case.candidates)),
            key=lambda index: abs(case.candidates[index].start + HALF - current_center),
        )
        result.append({
            "dataset": case.dataset,
            "key": case.key,
            "baselineHit": case.baseline_hit,
            "baselineWidth": case.baseline[1] - case.baseline[0] + 1,
            "candidateHit": selected.hit,
            "candidateReachable": any(candidate.hit for candidate in case.candidates),
            "candidateStart": selected.start,
            "candidateProbability": float(probabilities[selected_index]),
            "advantage": float(probabilities[selected_index] - probabilities[current_index]),
            "distance": abs((selected.start + HALF) - current_center),
        })
    return result


def summarize(rows: Sequence[dict[str, Any]], gate: dict[str, float]):
    old = new = gains = losses = changes = 0
    for row in rows:
        accepted = (
            row["candidateProbability"] >= gate["minimumProbability"]
            and row["advantage"] >= gate["minimumAdvantage"]
            and row["distance"] <= gate["maximumDistance"]
            and (gate["width"] == 0 or row["baselineWidth"] == gate["width"])
        )
        old_hit = bool(row["baselineHit"])
        new_hit = bool(row["candidateHit"]) if accepted else old_hit
        old += old_hit
        new += new_hit
        gains += new_hit and not old_hit
        losses += old_hit and not new_hit
        changes += accepted
    return {
        "cases": len(rows),
        "oldHits": old,
        "newHits": new,
        "delta": new - old,
        "gains": gains,
        "losses": losses,
        "changes": changes,
    }


def select_gate(rows: Sequence[dict[str, Any]], datasets: Sequence[str]):
    probabilities = np.asarray([row["candidateProbability"] for row in rows])
    advantages = np.asarray([row["advantage"] for row in rows])
    probability_thresholds = sorted(set((
        0.5, 0.6, 0.7, 0.8, 0.9,
        *[float(np.quantile(probabilities, q)) for q in (0.5, 0.7, 0.8, 0.9, 0.95)],
    )))
    advantage_thresholds = sorted(set((
        0.0, 0.02, 0.05, 0.1, 0.2,
        *[float(np.quantile(advantages, q)) for q in (0.5, 0.7, 0.8, 0.9, 0.95)],
    )))
    options = []
    for probability in probability_thresholds:
        for advantage in advantage_thresholds:
            for distance in (2, 4, 6, 8, 12, 20, 10_000):
                for width in (0, 9, 13):
                    gate = {
                        "minimumProbability": probability,
                        "minimumAdvantage": advantage,
                        "maximumDistance": distance,
                        "width": width,
                    }
                    folds = {
                        dataset: summarize(
                            [row for row in rows if row["dataset"] == dataset],
                            gate,
                        )
                        for dataset in datasets
                    }
                    if any(fold["delta"] < 0 for fold in folds.values()):
                        continue
                    overall = summarize(rows, gate)
                    options.append(((
                        overall["delta"],
                        min(fold["delta"] for fold in folds.values()),
                        -overall["losses"],
                        -overall["changes"],
                    ), gate, overall, folds))
    return max(options, key=lambda item: item[0]) if options else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development", action="append", required=True)
    parser.add_argument("--validation", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument(
        "--equal-width-baseline",
        action="store_true",
        help=(
            "Compare each 13-year candidate with a 13-year window centered "
            "on the production result, so widening cannot count as a gain."
        ),
    )
    parser.add_argument(
        "--search-domain",
        choices=("coarse", "candidate-union", "all"),
        default="coarse",
        help="Calendar years considered by the residual 13-year localizer.",
    )
    parser.add_argument(
        "--variants",
        default="small,medium,wide",
        help="Comma-separated model sizes to evaluate.",
    )
    args = parser.parse_args()
    development_stats, development_rows = load_rows(args.development)
    validation_stats, validation_rows = load_rows([args.validation])
    all_rows = [row for _, row in (*development_rows, *validation_rows)]
    profile_names = common_profile_names(all_rows)
    source_names = candidate_source_names(all_rows)
    development_cases = [
        case
        for dataset, row in development_rows
        for case in [build_case(
            dataset,
            row,
            profile_names,
            source_names,
            args.equal_width_baseline,
            args.search_domain,
        )]
        if case is not None
    ]
    validation_cases = [
        case
        for dataset, row in validation_rows
        for case in [build_case(
            dataset,
            row,
            profile_names,
            source_names,
            args.equal_width_baseline,
            args.search_domain,
        )]
        if case is not None
    ]
    development_names = sorted(development_stats)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "profileCount": len(profile_names),
        "profiles": profile_names,
        "candidateSources": source_names,
        "evaluationBaseline": (
            "production_centered_13"
            if args.equal_width_baseline
            else "production_window"
        ),
        "searchDomain": args.search_domain,
        "development": development_stats,
        "validation": validation_stats,
        "variants": {},
    }
    variants = [
        variant.strip()
        for variant in args.variants.split(",")
        if variant.strip() in {"small", "medium", "wide"}
    ]
    if not variants:
        raise ValueError("At least one valid model variant is required")
    for variant_index, variant in enumerate(variants):
        oof = []
        for fold_index, held in enumerate(development_names):
            held_groups = {case.group for case in development_cases if case.dataset == held}
            train = [
                case for case in development_cases
                if case.dataset != held and case.group not in held_groups
            ]
            test = [case for case in development_cases if case.dataset == held]
            model = fit_model(train, 20260804 + variant_index * 10 + fold_index, variant)
            oof.extend(predict(model, test))
        gate = select_gate(oof, development_names)
        model = fit_model(development_cases, 20260901 + variant_index, variant)
        validation_predictions = predict(model, validation_cases)
        accept_all = {
            "minimumProbability": float("-inf"),
            "minimumAdvantage": float("-inf"),
            "maximumDistance": float("inf"),
            "width": 0,
        }
        report["variants"][variant] = {
            "gate": gate[1] if gate else None,
            "developmentOverall": gate[2] if gate else None,
            "developmentFolds": gate[3] if gate else None,
            "validationLocated": len(validation_predictions),
            "validationReachable": sum(
                bool(row["candidateReachable"])
                for row in validation_predictions
            ),
            "validationUngated": summarize(
                validation_predictions,
                accept_all,
            ),
            "validationGated": summarize(validation_predictions, gate[1]) if gate else None,
        }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
