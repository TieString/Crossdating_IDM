"""Evaluate one-window changepoint posteriors on frozen arbitrary-year audits.

This is an offline experiment. It reconstructs each corrupted target, calibrates
reference reliability only from the newest anchored end, and scores the calendar
boundary implied by each candidate operation. Offsets 0-7 select fixed scoring
and posterior settings; offsets 8-12 remain a file-disjoint holdout.
"""

from __future__ import annotations

import math
import os
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

import numpy as np
from scipy.linalg import solve_banded

from train_local_boundary_ranker import (
    EVENT_TYPES,
    ITRDB_ROOT,
    TEST_OFFSETS,
    TRAIN_OFFSETS,
    corrupt,
    differences,
    false_mode_for_case,
    iter_audits,
    overlap,
    parse_rwl,
    standardize,
    whiten,
    zscore,
)


WINDOW_WIDTHS = (5, 7, 9)
TEMPERATURES = (0.25, 0.5, 0.75, 1.0, 1.5, 2.0)
PRIOR_WEIGHTS = (0.0, 0.2, 0.4, 0.6, 0.8)
PRIOR_SCALES = (1.0, 2.0, 4.0)
ANCHOR_YEARS = 18
REFERENCE_LIMIT = 24


def smoothing_lambda(
    rigidity_years: int = 32,
    frequency_response: float = 0.5,
) -> float:
    eigenvalue = 16 * math.sin(math.pi / max(3, rigidity_years)) ** 4
    return ((1 / frequency_response) - 1) / max(eigenvalue, 1e-12)


def spline_trend(values: np.ndarray) -> np.ndarray:
    length = len(values)
    if length <= 2:
        return values.copy()
    weight = smoothing_lambda()
    diagonal = np.full(length, 1 + 6 * weight, dtype=float)
    diagonal[0] = diagonal[-1] = 1 + weight
    if length > 2:
        diagonal[1] = diagonal[-2] = 1 + 5 * weight
    first = np.full(length - 1, -4 * weight, dtype=float)
    first[0] = first[-1] = -2 * weight
    second = np.full(length - 2, weight, dtype=float)
    banded = np.zeros((5, length), dtype=float)
    banded[0, 2:] = second
    banded[1, 1:] = first
    banded[2] = diagonal
    banded[3, :-1] = first
    banded[4, :-2] = second
    try:
        trend = solve_banded((2, 2), banded, values)
    except np.linalg.LinAlgError:
        return values.copy()
    return np.maximum(1e-6, trend)


def autoregressive_residual(values: np.ndarray) -> tuple[np.ndarray, int]:
    if len(values) < 8:
        return values.copy(), 0
    center = float(values.mean())
    centered = values - center
    best: tuple[float, int, np.ndarray] | None = None
    maximum_order = min(5, len(values) // 3)
    for order in range(1, maximum_order + 1):
        autocovariance = np.asarray(
            [
                float(np.dot(centered[lag:], centered[:len(centered) - lag]))
                / len(centered)
                for lag in range(order + 1)
            ]
        )
        toeplitz = np.asarray(
            [
                [autocovariance[abs(row - column)] for column in range(order)]
                for row in range(order)
            ]
        )
        try:
            coefficients = np.linalg.solve(toeplitz, autocovariance[1:])
        except np.linalg.LinAlgError:
            continue
        predicted = np.asarray(
            [
                float(
                    np.dot(
                        coefficients,
                        centered[index - order:index][::-1],
                    )
                )
                for index in range(order, len(centered))
            ]
        )
        residual = centered[order:] - predicted
        rss = float(np.dot(residual, residual))
        if rss <= 0:
            continue
        aic = len(residual) * math.log(rss / len(residual)) + 2 * order
        if best is None or aic < best[0]:
            best = aic, order, residual + center
    return (best[2], best[1]) if best is not None else (values.copy(), 0)


def cofecha_transform(
    series: dict[int, float],
    use_ar: bool,
    use_log: bool,
) -> dict[int, float]:
    rows = sorted(
        (year, value)
        for year, value in series.items()
        if math.isfinite(value) and value > 0
    )
    if not rows:
        return {}
    years = np.asarray([year for year, _ in rows], dtype=int)
    widths = np.asarray([max(1e-6, value) for _, value in rows], dtype=float)
    transformed = widths / spline_trend(widths)
    if use_ar:
        transformed, order = autoregressive_residual(transformed)
        years = years[order:]
    if use_log and len(transformed) > 0:
        mean_value = float(transformed.mean())
        constant = mean_value / 6
        minimum = float(transformed.min())
        shift = abs(minimum + constant) + 1e-6 if minimum + constant <= 0 else 0
        transformed = np.log(transformed + constant + shift)
    return standardize(
        {
            int(year): float(value)
            for year, value in zip(years, transformed)
        }
    )


def cases_from_formal_audit(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("sampling") != "calendar-position-stratified-signal-independent":
        raise RuntimeError(f"{path} is not a formal arbitrary-year audit")
    offset = int(payload["offset"])
    file_cache: dict[str, dict[str, dict[int, float]]] = {}
    cases = []
    for outcome in payload.get("eventCaseOutcomes", []):
        context = outcome["context"]
        relative = str(context["file"]).lstrip("/\\")
        if relative not in file_cache:
            file_cache[relative] = parse_rwl(ITRDB_ROOT / relative)
        all_series = file_cache[relative]
        target_id = str(context["target"])
        correct = all_series.get(target_id)
        if not correct:
            continue
        start = min(correct) + 15
        end = max(correct) - 15
        if end < start:
            continue
        event_type = str(outcome["eventType"])
        rows = []
        shifts = (-3, -2, 2, 3) if event_type == "partialMove" else (None,)
        for shift in shifts:
            rows.extend(
                {
                    "year": year,
                    **({"shiftYears": shift} if shift is not None else {}),
                }
                for year in range(start, end + 1)
            )
        current_range = outcome.get("primaryPredictionRange")
        cases.append(
            {
                "groupId": (
                    f"{context['file']}:{target_id}:{event_type}"
                ),
                "eventType": event_type,
                "truthYear": int(context["year"]),
                "truthShiftYears": outcome.get("truthShiftYears"),
                "currentTopYear": outcome.get("primaryPredictionTopYear"),
                "currentRange": list(current_range) if current_range else None,
                "currentShiftYears": outcome.get("primaryPredictionShiftYears"),
                "context": context,
                "rows": rows,
                "offset": offset,
            }
        )
    return cases


def correlation(
    left: dict[int, float],
    right: dict[int, float],
    start: int,
    end: int,
    lag: int = 0,
    minimum_pairs: int = 8,
) -> tuple[float, int]:
    pairs = [
        (left[year], right[year + lag])
        for year in range(start, end + 1)
        if year in left and year + lag in right
    ]
    if len(pairs) < minimum_pairs:
        return 0.0, len(pairs)
    a = np.asarray([pair[0] for pair in pairs], dtype=float)
    b = np.asarray([pair[1] for pair in pairs], dtype=float)
    if a.std() <= 0 or b.std() <= 0:
        return 0.0, len(pairs)
    value = float(np.corrcoef(a, b)[0, 1])
    return (value if math.isfinite(value) else 0.0), len(pairs)


def huber(value: float, transition: float = 1.5) -> float:
    absolute = abs(value)
    if absolute <= transition:
        return 0.5 * absolute * absolute
    return transition * (absolute - transition * 0.5)


def transformed_views(series: dict[int, float]) -> dict[str, dict[int, float]]:
    raw = zscore(series)
    return {
        "raw": raw,
        "difference": differences(raw),
        "whitened": whiten(raw),
        "spline": cofecha_transform(series, use_ar=False, use_log=False),
        "splineLog": cofecha_transform(series, use_ar=False, use_log=True),
        "cofecha": cofecha_transform(series, use_ar=True, use_log=True),
    }


def reference_views(
    all_series: dict[str, dict[int, float]],
    target_id: str,
    corrupted: dict[int, float],
) -> list[dict[str, Any]]:
    target = transformed_views(corrupted)
    end = max(corrupted)
    start = end - ANCHOR_YEARS + 1
    references = [
        (series_id, values)
        for series_id, values in all_series.items()
        if series_id != target_id
        and overlap(values, corrupted) >= 80
    ]
    references.sort(key=lambda item: -overlap(item[1], corrupted))
    prepared = []
    target_stem = target_id[:-1].lower()
    for series_id, values in references[:REFERENCE_LIMIT]:
        views = transformed_views(values)
        anchor_rows = {}
        qualities = []
        for view_name in (
            "raw",
            "difference",
            "whitened",
            "spline",
            "splineLog",
            "cofecha",
        ):
            value, pairs = correlation(
                target[view_name],
                views[view_name],
                start,
                end,
                minimum_pairs=7,
            )
            shrink = math.sqrt(max(0, pairs - 3) / max(1, pairs + 5))
            quality = max(0.0, value) * shrink
            anchor_rows[view_name] = quality
            qualities.append(quality)
        global_quality = max(
            correlation(
                target["raw"],
                views["raw"],
                min(corrupted),
                end,
                lag=lag,
                minimum_pairs=20,
            )[0]
            for lag in range(-3, 4)
        )
        paired = series_id[:-1].lower() == target_stem
        prepared.append(
            {
                "id": series_id,
                "views": views,
                "quality": max(0.02, float(np.mean(qualities))),
                "globalQuality": max(0.0, global_quality) + 0.15,
                "viewQuality": anchor_rows,
                "paired": paired,
            }
        )
    for reference in prepared:
        pairwise = []
        for other in prepared:
            if other is reference:
                continue
            start_year = max(
                min(reference["views"]["raw"]),
                min(other["views"]["raw"]),
            )
            end_year = min(
                max(reference["views"]["raw"]),
                max(other["views"]["raw"]),
            )
            value, pairs = correlation(
                reference["views"]["raw"],
                other["views"]["raw"],
                start_year,
                end_year,
                minimum_pairs=30,
            )
            if pairs >= 30:
                pairwise.append(value)
        positive = sorted((value for value in pairwise if value > 0), reverse=True)
        central = float(np.mean(positive[: max(1, len(positive) // 2)])) if positive else 0.0
        reference["networkQuality"] = max(0.0, central) + 0.15
    return prepared


def make_master(
    references: list[dict[str, Any]],
    view_name: str,
    weight_mode: str,
) -> dict[int, float]:
    buckets: dict[int, list[tuple[float, float]]] = defaultdict(list)
    has_paired = any(reference["paired"] for reference in references)
    for reference in references:
        if weight_mode == "pairedOnly" and has_paired and not reference["paired"]:
            continue
        if weight_mode == "equal":
            weight = 1.0
        elif weight_mode == "global":
            weight = reference["globalQuality"]
        elif weight_mode == "globalEndpoint":
            weight = reference["globalQuality"] * (0.5 + reference["quality"])
        elif weight_mode == "pairedGlobal":
            weight = reference["globalQuality"] * (2.5 if reference["paired"] else 1.0)
        elif weight_mode == "pairedGlobal5":
            weight = reference["globalQuality"] * (5.0 if reference["paired"] else 1.0)
        elif weight_mode == "pairedGlobal10":
            weight = reference["globalQuality"] * (10.0 if reference["paired"] else 1.0)
        elif weight_mode == "pairedOnly":
            weight = reference["globalQuality"]
        elif weight_mode == "network":
            weight = reference["networkQuality"]
        elif weight_mode == "pairedNetwork":
            weight = reference["networkQuality"] * (2.5 if reference["paired"] else 1.0)
        elif weight_mode == "paired":
            weight = reference["quality"] * (2.5 if reference["paired"] else 1.0)
        else:
            weight = reference["quality"]
        source_view = (
            reference["views"][view_name]
            if view_name in ("spline", "splineLog", "cofecha")
            else reference["views"]["raw"]
        )
        for year, value in source_view.items():
            buckets[year].append((value, weight))
    raw_master = {}
    for year, rows in buckets.items():
        if weight_mode == "median":
            raw_master[year] = float(np.median([value for value, _ in rows]))
        elif weight_mode == "trimmed":
            values = sorted(value for value, _ in rows)
            trim = min(len(values) // 4, max(0, (len(values) - 3) // 2))
            kept = values[trim:len(values) - trim] if trim > 0 else values
            raw_master[year] = float(np.mean(kept))
        else:
            denominator = sum(weight for _, weight in rows)
            if denominator > 0:
                raw_master[year] = sum(value * weight for value, weight in rows) / denominator
    master_raw = standardize(raw_master)
    master_views = {
        "raw": master_raw,
        "difference": differences(master_raw),
        "whitened": whiten(master_raw),
        "spline": master_raw,
        "splineLog": master_raw,
        "cofecha": master_raw,
    }
    return master_views[view_name]


def bivariate_preference(
    target: float,
    zero: float,
    shifted: float,
    rho: float,
) -> float:
    bounded = max(0.05, min(0.85, rho))
    denominator = max(1e-6, 1 - bounded * bounded)

    def log_likelihood(reference: float) -> float:
        return -0.5 * (
            math.log(denominator)
            + (target * target - 2 * bounded * target * reference + reference * reference)
            / denominator
        )

    return log_likelihood(shifted) - log_likelihood(zero)


def preference_profile(
    target: dict[int, float],
    reference: dict[int, float],
    lag: int,
    rho: float,
    mode: str,
    reliability: dict[int, float] | None = None,
    reliability_power: float = 0.0,
) -> tuple[dict[int, float], dict[int, float]]:
    preferences = {}
    null_losses = {}
    for year, value in target.items():
        zero = reference.get(year)
        shifted = reference.get(year + lag)
        if zero is None or shifted is None:
            continue
        if mode == "bivariate":
            preference = bivariate_preference(value, zero, shifted, rho)
        elif mode == "cross":
            preference = value * (shifted - zero)
        else:
            preference = huber(value - zero) - huber(value - shifted)
        if reliability and reliability_power > 0:
            pair_reliability = math.sqrt(
                reliability.get(year, 1.0)
                * reliability.get(year + lag, 1.0)
            )
            preference *= pair_reliability ** reliability_power
        preferences[year] = preference
        null_losses[year] = min(huber(value - zero), huber(value - shifted)) * (
            reliability.get(year, 1.0) ** reliability_power
            if reliability and reliability_power > 0
            else 1.0
        )
    return preferences, null_losses


def year_reliability(
    references: list[dict[str, Any]],
    view_name: str,
) -> dict[int, float]:
    buckets: dict[int, list[float]] = defaultdict(list)
    for reference in references:
        for year, value in reference["views"][view_name].items():
            buckets[year].append(value)
    raw = {}
    for year, values in buckets.items():
        if len(values) < 3:
            continue
        center = float(np.median(values))
        mad = float(np.median(np.abs(np.asarray(values) - center))) * 1.4826
        raw[year] = math.sqrt(len(values)) / (0.35 + mad)
    if not raw:
        return {}
    median_value = float(np.median(list(raw.values()))) or 1.0
    return {
        year: max(0.25, min(3.0, value / median_value))
        for year, value in raw.items()
    }


def prefix_score(
    preferences: dict[int, float],
    null_losses: dict[int, float],
    year: int,
    false_ring: bool,
    false_bonus: float,
) -> float:
    older_end = year - 1 if false_ring else year
    score = sum(
        value
        for candidate_year, value in preferences.items()
        if candidate_year <= older_end
    )
    if false_ring:
        score += false_bonus * null_losses.get(year, 0.0)
    return score


def boundary_scores(
    preferences: dict[int, float],
    null_losses: dict[int, float],
    candidate_years: list[int],
    false_ring: bool,
    false_bonus: float,
) -> dict[int, float]:
    ordered_preferences = sorted(preferences.items())
    result = {}
    running = 0.0
    preference_index = 0
    for candidate_year in sorted(set(candidate_years)):
        older_end = candidate_year - 1 if false_ring else candidate_year
        while (
            preference_index < len(ordered_preferences)
            and ordered_preferences[preference_index][0] <= older_end
        ):
            running += ordered_preferences[preference_index][1]
            preference_index += 1
        result[candidate_year] = running + (
            false_bonus * null_losses.get(candidate_year, 0.0)
            if false_ring
            else 0.0
        )
    return result


def candidate_scores(
    case: dict[str, Any],
    all_series: dict[str, dict[int, float]],
    model: dict[str, Any],
) -> list[dict[str, Any]]:
    target_id = case["context"]["target"]
    correct = all_series[target_id]
    corrupted = corrupt(
        correct,
        case["eventType"],
        int(case["truthYear"]),
        case.get("truthShiftYears"),
        false_mode_for_case(case),
    )
    target_views = transformed_views(corrupted)
    references = reference_views(all_series, target_id, corrupted)
    reliability_power = float(os.environ.get("ENDPOINT_RELIABILITY_POWER", "0"))
    end = max(corrupted)
    anchor_start = end - ANCHOR_YEARS + 1
    view_weights = model["viewWeights"]
    rows = []
    candidate_years = [int(row["year"]) for row in case["rows"]]
    profile_cache: dict[tuple[str, int], dict[int, float]] = {}
    reference_profile_cache: dict[
        tuple[str, int, str],
        dict[int, float],
    ] = {}
    reliability_cache: dict[str, dict[int, float]] = {}

    for audit_row in case["rows"]:
        lag = (
            -1
            if case["eventType"] == "missingRing"
            else 1
            if case["eventType"] == "falseRing"
            else int(audit_row.get("shiftYears") or 0)
        )
        total = 0.0
        weight_total = 0.0
        for view_name, view_weight in view_weights.items():
            if view_weight <= 0:
                continue
            cache_key = (view_name, lag)
            if cache_key not in profile_cache:
                master = make_master(references, view_name, model["referenceWeight"])
                reliability = reliability_cache.setdefault(
                    view_name,
                    year_reliability(references, view_name),
                )
                rho, _ = correlation(
                    target_views[view_name],
                    master,
                    anchor_start,
                    end,
                    minimum_pairs=7,
                )
                profile_cache[cache_key] = preference_profile(
                    target_views[view_name],
                    master,
                    lag,
                    max(0.05, rho),
                    model["loss"],
                    reliability,
                    reliability_power,
                )
                preferences, null_losses = profile_cache[cache_key]
                profile_cache[cache_key] = boundary_scores(
                    preferences,
                    null_losses,
                    candidate_years,
                    case["eventType"] == "falseRing",
                    model["falseBonus"],
                )
            score = profile_cache[cache_key][int(audit_row["year"])]

            if model["individualWeight"] > 0:
                individual = []
                for reference in references:
                    reference_key = (view_name, lag, reference["id"])
                    if reference_key not in reference_profile_cache:
                        rho = reference["viewQuality"][view_name]
                        preferences, null_losses = preference_profile(
                            target_views[view_name],
                            reference["views"][view_name],
                            lag,
                            max(0.05, rho),
                            model["loss"],
                        )
                        reference_profile_cache[reference_key] = boundary_scores(
                            preferences,
                            null_losses,
                            candidate_years,
                            case["eventType"] == "falseRing",
                            model["falseBonus"],
                        )
                    reference_score = reference_profile_cache[reference_key][
                        int(audit_row["year"])
                    ]
                    reference_weight = reference["quality"] * (
                        2.5
                        if model["referenceWeight"] in ("paired", "pairedGlobal")
                        and reference["paired"]
                        else 1.0
                    )
                    individual.append((reference_score, reference_weight))
                denominator = sum(weight for _, weight in individual)
                if denominator > 0:
                    mean_score = sum(
                        score_value * weight
                        for score_value, weight in individual
                    ) / denominator
                    score = (
                        score * (1 - model["individualWeight"])
                        + mean_score * model["individualWeight"]
                    )
            total += score * view_weight
            weight_total += view_weight
        rows.append(
            {
                "year": int(audit_row["year"]),
                "shiftYears": audit_row.get("shiftYears"),
                "score": total / max(1e-9, weight_total),
            }
        )
    return rows


def normalize(values: np.ndarray) -> np.ndarray:
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    scale = max(1e-6, mad * 1.4826, float(values.std()) * 0.25)
    return (values - median) / scale


def choose_window(
    rows: list[dict[str, Any]],
    width: int,
    temperature: float,
    current_top_year: int | None = None,
    prior_weight: float = 0.0,
    prior_scale: float = 2.0,
) -> tuple[int, int, int, int | None]:
    scores = np.asarray([row["score"] for row in rows], dtype=float)
    standardized = normalize(scores)
    posterior = np.exp(np.clip(standardized * temperature, -30, 30))
    mass_by_year: dict[int, float] = defaultdict(float)
    for row, mass in zip(rows, posterior):
        mass_by_year[row["year"]] += float(mass)
    years = sorted(mass_by_year)
    posterior_total = sum(mass_by_year.values())
    posterior_by_year = {
        year: mass / max(1e-12, posterior_total)
        for year, mass in mass_by_year.items()
    }
    if current_top_year is not None and prior_weight > 0:
        prior_by_year = {
            year: math.exp(-abs(year - current_top_year) / prior_scale)
            for year in years
        }
        prior_total = sum(prior_by_year.values())
        mass_by_year = {
            year: (
                posterior_by_year[year] * (1 - prior_weight)
                + prior_by_year[year] / max(1e-12, prior_total) * prior_weight
            )
            for year in years
        }
    else:
        mass_by_year = posterior_by_year
    best_start = years[0]
    best_mass = -1.0
    for start in years:
        end = start + width - 1
        mass = sum(value for year, value in mass_by_year.items() if start <= year <= end)
        if mass > best_mass:
            best_mass = mass
            best_start = start
    ranking = sorted(
        rows,
        key=lambda row: (
            mass_by_year[row["year"]],
            row["score"],
            row["year"],
        ),
        reverse=True,
    )
    top = ranking[0]
    return best_start, best_start + width - 1, top["year"], top["shiftYears"]


def posterior_window_profile(
    rows: list[dict[str, Any]],
    temperature: float,
    minimum_width: int = 3,
    maximum_width: int = 15,
) -> dict[str, Any]:
    scores = np.asarray([row["score"] for row in rows], dtype=float)
    standardized = normalize(scores)
    posterior = np.exp(np.clip(standardized * temperature, -30, 30))
    raw_mass: dict[int, float] = defaultdict(float)
    for row, mass in zip(rows, posterior):
        raw_mass[int(row["year"])] += float(mass)
    minimum_year = min(raw_mass)
    maximum_year = max(raw_mass)
    total = sum(raw_mass.values())
    mass_by_year = {
        year: raw_mass.get(year, 0.0) / max(1e-12, total)
        for year in range(minimum_year, maximum_year + 1)
    }
    prefix = [0.0]
    for year in range(minimum_year, maximum_year + 1):
        prefix.append(prefix[-1] + mass_by_year[year])

    windows = []
    for width in range(minimum_width, maximum_width + 1, 2):
        best_start = minimum_year
        best_mass = -1.0
        for start in range(minimum_year, maximum_year - width + 2):
            left = start - minimum_year
            mass = prefix[left + width] - prefix[left]
            if mass > best_mass:
                best_start = start
                best_mass = mass
        windows.append(
            {
                "width": width,
                "start": best_start,
                "end": best_start + width - 1,
                "mass": best_mass,
            }
        )
    ranking = sorted(
        rows,
        key=lambda row: (
            mass_by_year[int(row["year"])],
            row["score"],
            row["year"],
        ),
        reverse=True,
    )
    return {
        "windows": windows,
        "topYear": int(ranking[0]["year"]),
        "topShift": ranking[0]["shiftYears"],
    }


def adaptive_window_for_mass(
    profile: dict[str, Any],
    minimum_mass: float,
) -> dict[str, Any]:
    return next(
        (
            window
            for window in profile["windows"]
            if window["mass"] >= minimum_mass
        ),
        profile["windows"][-1],
    )


def adaptive_window_metrics(
    cases: list[dict[str, Any]],
    minimum_mass: float,
) -> dict[str, float | int]:
    outcomes = []
    for case in cases:
        profile = case["adaptiveProfile"]
        window = adaptive_window_for_mass(profile, minimum_mass)
        answered = (
            isinstance(case.get("currentRange"), list)
            and len(case["currentRange"]) == 2
        )
        shift_matches = (
            case["eventType"] != "partialMove"
            or profile["topShift"] == case.get("truthShiftYears")
        )
        hit = (
            window["start"] <= case["truthYear"] <= window["end"]
            and shift_matches
        )
        outcomes.append(
            {
                "answered": answered,
                "hit": hit,
                "emittedHit": answered and hit,
                "width": int(window["width"]),
            }
        )
    widths = sorted(row["width"] for row in outcomes if row["answered"])
    count = len(outcomes)
    answered_count = sum(row["answered"] for row in outcomes)
    percentile_index = lambda fraction: min(
        max(0, len(widths) - 1),
        int(math.ceil(len(widths) * fraction)) - 1,
    )
    return {
        "cases": count,
        "minimumMass": minimum_mass,
        "coverage": sum(row["hit"] for row in outcomes) / max(1, count),
        "emittedCoverage": (
            sum(row["emittedHit"] for row in outcomes) / max(1, count)
        ),
        "answeredCoverage": (
            sum(row["emittedHit"] for row in outcomes) / max(1, answered_count)
        ),
        "responseRate": answered_count / max(1, count),
        "meanWidth": (
            sum(widths) / max(1, len(widths))
        ),
        "medianWidth": widths[percentile_index(0.5)] if widths else 0,
        "p90Width": widths[percentile_index(0.9)] if widths else 0,
        "maximumWidth": max(widths) if widths else 0,
    }


def calibrate_adaptive_window(
    training: list[dict[str, Any]],
    testing: list[dict[str, Any]],
    temperature: float,
    target_answered_coverage: float = 0.9,
) -> dict[str, Any]:
    for case in (*training, *testing):
        case["adaptiveProfile"] = posterior_window_profile(
            case["scores"],
            temperature,
        )
    thresholds = sorted(
        {
            0.0,
            *(
                float(window["mass"])
                for case in training
                for window in case["adaptiveProfile"]["windows"]
            ),
        }
    )
    candidates = [
        (
            threshold,
            adaptive_window_metrics(training, threshold),
        )
        for threshold in thresholds
    ]
    feasible = [
        row
        for row in candidates
        if row[1]["answeredCoverage"] >= target_answered_coverage
    ]
    selected = min(
        feasible or candidates,
        key=lambda row: (
            row[1]["meanWidth"] if feasible else -row[1]["answeredCoverage"],
            row[1]["p90Width"],
            -row[1]["answeredCoverage"],
            row[0],
        ),
    )
    return {
        "targetAnsweredCoverage": target_answered_coverage,
        "train": selected[1],
        "test": adaptive_window_metrics(testing, selected[0]),
    }


def shrink_window_metrics(
    cases: list[dict[str, Any]],
    retained_mass_threshold: float,
    require_current_top: bool,
) -> dict[str, float | int]:
    outcomes = []
    for case in cases:
        profile = case["adaptiveProfile"]
        by_width = {
            int(window["width"]): window
            for window in profile["windows"]
        }
        narrow = by_width[7]
        wide = by_width[9]
        current_top = case.get("currentTopYear")
        current_supports_narrow = (
            isinstance(current_top, (int, float))
            and narrow["start"] <= current_top <= narrow["end"]
        )
        retained_mass = narrow["mass"] / max(1e-12, wide["mass"])
        use_narrow = (
            retained_mass >= retained_mass_threshold
            and (not require_current_top or current_supports_narrow)
        )
        window = narrow if use_narrow else wide
        answered = (
            isinstance(case.get("currentRange"), list)
            and len(case["currentRange"]) == 2
        )
        shift_matches = (
            case["eventType"] != "partialMove"
            or profile["topShift"] == case.get("truthShiftYears")
        )
        hit = (
            window["start"] <= case["truthYear"] <= window["end"]
            and shift_matches
        )
        outcomes.append(
            {
                "answered": answered,
                "hit": hit,
                "emittedHit": answered and hit,
                "width": int(window["width"]),
                "narrow": use_narrow,
            }
        )
    answered = [row for row in outcomes if row["answered"]]
    count = len(outcomes)
    return {
        "cases": count,
        "retainedMassThreshold": retained_mass_threshold,
        "requireCurrentTop": require_current_top,
        "coverage": sum(row["hit"] for row in outcomes) / max(1, count),
        "emittedCoverage": (
            sum(row["emittedHit"] for row in outcomes) / max(1, count)
        ),
        "answeredCoverage": (
            sum(row["emittedHit"] for row in outcomes) / max(1, len(answered))
        ),
        "meanWidth": (
            sum(row["width"] for row in answered) / max(1, len(answered))
        ),
        "narrowRate": (
            sum(row["narrow"] for row in answered) / max(1, len(answered))
        ),
    }


def calibrate_shrink_window(
    training: list[dict[str, Any]],
    testing: list[dict[str, Any]],
    maximum_answered_coverage_loss: float = 0.01,
) -> dict[str, Any]:
    baseline = shrink_window_metrics(training, 2.0, False)
    minimum_coverage = (
        float(baseline["answeredCoverage"]) - maximum_answered_coverage_loss
    )
    thresholds = sorted(
        {
            0.0,
            1.0,
            *(
                float(
                    next(
                        row for row in case["adaptiveProfile"]["windows"]
                        if row["width"] == 7
                    )["mass"]
                    / max(
                        1e-12,
                        next(
                            row for row in case["adaptiveProfile"]["windows"]
                            if row["width"] == 9
                        )["mass"],
                    )
                )
                for case in training
            ),
        }
    )
    candidates = [
        shrink_window_metrics(training, threshold, require_current_top)
        for require_current_top in (False, True)
        for threshold in thresholds
    ]
    feasible = [
        row
        for row in candidates
        if row["answeredCoverage"] >= minimum_coverage
    ]
    selected = min(
        feasible or candidates,
        key=lambda row: (
            row["meanWidth"],
            -row["answeredCoverage"],
            -row["retainedMassThreshold"],
            not row["requireCurrentTop"],
        ),
    )
    return {
        "maximumAnsweredCoverageLoss": maximum_answered_coverage_loss,
        "baselineTrainAnsweredCoverage": baseline["answeredCoverage"],
        "train": selected,
        "test": shrink_window_metrics(
            testing,
            float(selected["retainedMassThreshold"]),
            bool(selected["requireCurrentTop"]),
        ),
    }


def metrics(
    cases: list[dict[str, Any]],
    width: int,
    temperature: float,
    prior_weight: float = 0.0,
    prior_scale: float = 2.0,
) -> dict[str, float | int]:
    outcomes = []
    for case in cases:
        start, end, top_year, shift = choose_window(
            case["scores"],
            width,
            temperature,
            (
                int(case["currentTopYear"])
                if isinstance(case.get("currentTopYear"), (int, float))
                else None
            ),
            prior_weight,
            prior_scale,
        )
        shift_matches = (
            case["eventType"] != "partialMove"
            or shift == case.get("truthShiftYears")
        )
        answered = (
            isinstance(case.get("currentRange"), list)
            and len(case["currentRange"]) == 2
        )
        current_hit = (
            answered
            and case["currentRange"][0] <= case["truthYear"] <= case["currentRange"][1]
            and (
                case["eventType"] != "partialMove"
                or case.get("currentShiftYears") == case.get("truthShiftYears")
            )
        )
        outcomes.append(
            {
                "hit": start <= case["truthYear"] <= end,
                "joint": start <= case["truthYear"] <= end and shift_matches,
                "answered": answered,
                "answeredJoint": (
                    answered
                    and start <= case["truthYear"] <= end
                    and shift_matches
                ),
                "currentHit": current_hit,
                "centeredHit": (
                    top_year - width // 2
                    <= case["truthYear"]
                    <= top_year + width // 2
                ),
                "exact": top_year == case["truthYear"] and shift_matches,
                "withinOne": abs(top_year - case["truthYear"]) <= 1 and shift_matches,
                "shift": shift_matches,
            }
        )
    count = len(outcomes)
    return {
        "cases": count,
        "responseRate": sum(row["answered"] for row in outcomes) / max(1, count),
        "coverage": sum(row["hit"] for row in outcomes) / max(1, count),
        "jointCoverage": sum(row["joint"] for row in outcomes) / max(1, count),
        "emittedJointCoverage": (
            sum(row["answeredJoint"] for row in outcomes) / max(1, count)
        ),
        "answeredJointCoverage": (
            sum(row["answeredJoint"] for row in outcomes)
            / max(1, sum(row["answered"] for row in outcomes))
        ),
        "currentCoverage": (
            sum(row["currentHit"] for row in outcomes) / max(1, count)
        ),
        "centeredCoverage": sum(row["centeredHit"] for row in outcomes) / max(1, count),
        "exact": sum(row["exact"] for row in outcomes) / max(1, count),
        "withinOne": sum(row["withinOne"] for row in outcomes) / max(1, count),
        "shiftAccuracy": sum(row["shift"] for row in outcomes) / max(1, count),
    }


def model_grid() -> list[dict[str, Any]]:
    view_options = {
        "raw": {"raw": 1.0, "difference": 0.0, "whitened": 0.0},
        "difference": {"raw": 0.0, "difference": 1.0, "whitened": 0.0},
        "whitened": {"raw": 0.0, "difference": 0.0, "whitened": 1.0},
        "spline": {"spline": 1.0},
        "splineLog": {"splineLog": 1.0},
        "cofecha": {"cofecha": 1.0},
        "balancedCofecha": {
            "difference": 0.3,
            "whitened": 0.2,
            "cofecha": 0.5,
        },
        "cofechaHeavy": {
            "difference": 0.2,
            "whitened": 0.15,
            "cofecha": 0.65,
        },
        "cofechaMedium": {
            "raw": 0.1,
            "difference": 0.35,
            "whitened": 0.2,
            "cofecha": 0.35,
        },
        "splineCofecha": {
            "difference": 0.3,
            "splineLog": 0.2,
            "cofecha": 0.5,
        },
        "balanced": {"raw": 0.25, "difference": 0.4, "whitened": 0.35},
        "rawDifference": {"raw": 0.35, "difference": 0.65, "whitened": 0.0},
    }
    result = []
    for view_name, view_weights in view_options.items():
        for loss in ("bivariate", "huber", "cross"):
            for reference_weight in (
                "equal",
                "quality",
                "global",
                "globalEndpoint",
                "paired",
                "pairedGlobal",
                "pairedGlobal5",
                "pairedGlobal10",
                "pairedOnly",
                "network",
                "pairedNetwork",
                "median",
                "trimmed",
            ):
                for individual_weight in (0.0, 0.5):
                    for false_bonus in (0.0, 0.5, 1.0):
                        result.append(
                            {
                                "name": (
                                    f"{view_name}:{loss}:{reference_weight}:"
                                    f"individual{individual_weight}:false{false_bonus}"
                                ),
                                "viewWeights": view_weights,
                                "loss": loss,
                                "referenceWeight": reference_weight,
                                "individualWeight": individual_weight,
                                "falseBonus": false_bonus,
                            }
                        )
    return result


def main() -> None:
    file_cache: dict[str, dict[str, dict[int, float]]] = {}
    external_audit = os.environ.get("ENDPOINT_EXTERNAL_AUDIT")
    development_cases = list(iter_audits())
    if external_audit:
        external_cases = cases_from_formal_audit(Path(external_audit))
        raw_cases = [
            case
            for case in development_cases
            if case["offset"] in TRAIN_OFFSETS
        ] + external_cases
        test_offsets = {int(case["offset"]) for case in external_cases}
    else:
        raw_cases = development_cases
        test_offsets = TEST_OFFSETS
    event_filter = os.environ.get("ENDPOINT_EVENT")
    model_filter = os.environ.get("ENDPOINT_MODEL")
    models = [
        model
        for model in model_grid()
        if not model_filter or model_filter in model["name"]
    ]
    maximum_models = int(os.environ.get("ENDPOINT_MAX_MODELS", "0"))
    if maximum_models > 0:
        models = models[:maximum_models]
    prior_weights = (
        (0.0,)
        if os.environ.get("ENDPOINT_DISABLE_PRIOR") == "1"
        else PRIOR_WEIGHTS
    )
    prior_scales = (1.0,) if len(prior_weights) == 1 else PRIOR_SCALES
    reports = {}
    for event_type in EVENT_TYPES:
        if event_filter and event_type != event_filter:
            continue
        event_cases = [case for case in raw_cases if case["eventType"] == event_type]
        model_reports = []
        for model_index, model in enumerate(models, start=1):
            scored = []
            for case in event_cases:
                relative = case["context"]["file"].lstrip("/\\")
                if relative not in file_cache:
                    if len(file_cache) >= 8:
                        file_cache.pop(next(iter(file_cache)))
                    file_cache[relative] = parse_rwl(ITRDB_ROOT / relative)
                scored.append(
                    {
                        **case,
                        "scores": candidate_scores(case, file_cache[relative], model),
                    }
                )
            train = [case for case in scored if case["offset"] in TRAIN_OFFSETS]
            test = [case for case in scored if case["offset"] in test_offsets]
            settings = [
                (
                    width,
                    temperature,
                    prior_weight,
                    prior_scale,
                    metrics(
                        train,
                        width,
                        temperature,
                        prior_weight,
                        prior_scale,
                    ),
                )
                for width in WINDOW_WIDTHS
                for temperature in TEMPERATURES
                for prior_weight in prior_weights
                for prior_scale in prior_scales
            ]
            width, temperature, prior_weight, prior_scale, train_metrics = sorted(
                settings,
                key=lambda item: (
                    item[4]["jointCoverage"],
                    item[4]["exact"],
                    -item[0],
                    -item[2],
                ),
                reverse=True,
            )[0]
            test_metrics = metrics(
                test,
                width,
                temperature,
                prior_weight,
                prior_scale,
            )
            adaptive = calibrate_adaptive_window(
                train,
                test,
                temperature,
            )
            shrink = calibrate_shrink_window(
                train,
                test,
                float(os.environ.get("ENDPOINT_SHRINK_MAX_LOSS", "0.01")),
            )
            model_reports.append(
                {
                    "model": model["name"],
                    "width": width,
                    "temperature": temperature,
                    "priorWeight": prior_weight,
                    "priorScale": prior_scale,
                    "train": train_metrics,
                    "test": test_metrics,
                    "adaptive": adaptive,
                    "shrink": shrink,
                }
            )
            if model_index % 30 == 0:
                print(
                    f"{event_type}: evaluated {model_index}/{len(models)} models",
                    flush=True,
                )
        reports[event_type] = sorted(
            model_reports,
            key=lambda row: (
                row["train"]["jointCoverage"],
                row["train"]["exact"],
            ),
            reverse=True,
        )[:12]

    for event_type, rows in reports.items():
        print(f"\n{event_type}")
        for row in rows:
            train = row["train"]
            test = row["test"]
            adaptive = row["adaptive"]
            shrink = row["shrink"]
            print(
                f"{row['model']} width={row['width']} temp={row['temperature']} "
                f"prior={row['priorWeight']}@{row['priorScale']}: "
                f"train cov={train['jointCoverage']:.3f} exact={train['exact']:.3f}; "
                f"test cov={test['jointCoverage']:.3f} exact={test['exact']:.3f} "
                f"emitted={test['emittedJointCoverage']:.3f} "
                f"answered={test['answeredJointCoverage']:.3f} "
                f"current={test['currentCoverage']:.3f} "
                f"centered={test['centeredCoverage']:.3f} "
                f"within1={test['withinOne']:.3f} shift={test['shiftAccuracy']:.3f}"
            )
            print(
                "  adaptive "
                f"mass={adaptive['train']['minimumMass']:.6f}: "
                f"train answered={adaptive['train']['answeredCoverage']:.3f} "
                f"mean/p90={adaptive['train']['meanWidth']:.2f}/"
                f"{adaptive['train']['p90Width']}; "
                f"test answered={adaptive['test']['answeredCoverage']:.3f} "
                f"emitted={adaptive['test']['emittedCoverage']:.3f} "
                f"mean/p90={adaptive['test']['meanWidth']:.2f}/"
                f"{adaptive['test']['p90Width']}"
            )
            print(
                "  shrink7/9 "
                f"threshold={shrink['train']['retainedMassThreshold']:.6f} "
                f"currentTop={shrink['train']['requireCurrentTop']}: "
                f"train answered={shrink['train']['answeredCoverage']:.3f} "
                f"mean={shrink['train']['meanWidth']:.2f}; "
                f"test answered={shrink['test']['answeredCoverage']:.3f} "
                f"emitted={shrink['test']['emittedCoverage']:.3f} "
                f"mean={shrink['test']['meanWidth']:.2f} "
                f"narrow={shrink['test']['narrowRate']:.3f}"
            )


if __name__ == "__main__":
    main()
