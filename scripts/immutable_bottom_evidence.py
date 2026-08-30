#!/usr/bin/env python3
"""Truth-blind bottom evidence for immutable diagnosis packages.

The candidate generator owns operation identities and physical window packages.
This module only projects the already-cached full-year evidence onto those
packages.  Every generated value is relative to one diagnosis identity; file,
series, calendar-year and benchmark labels are deliberately absent.
"""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
IDENTITY_COLUMNS = ("attempt_key", "event_type", "shift_years")
STANDARD_WINDOW_WIDTHS = (5, 7, 9, 13)

EVIDENCE_FAMILIES: dict[str, tuple[str, ...]] = {
    "counterfactual": (
        "rawGain",
        "differenceGain",
        "combinedGain",
        "sideMinimumAdvantage",
        "sideStepScore",
        "correctedSideSupport",
        "localSideStepScore",
    ),
    "transition": ("rawTransition_", "cofechaTransition_"),
    "cumulative": ("cumulative_",),
    "piecewise": ("piecewise_",),
    "reference": (
        "referenceChange_",
        "referenceTransition_",
        "perReference_",
    ),
    "boundary": ("boundaryLocal_", "partialLocal_"),
}

REFERENCE_STABILITY_COLUMNS = (
    "referenceChange_supportFraction",
    "referenceChange_positiveGainFraction",
    "referenceTransition_positiveGainFraction",
    "referenceTransition_baselineModeFraction",
    "perReference_positiveDifferenceGainFraction",
    "perReference_positiveWhitenedGainFraction",
    "perReference_positiveSideStepFraction",
    "perReference_lagStepPositiveFraction",
    "perReference_fixedLagStepPositiveFraction",
)

UNIT_REFERENCE_EVIDENCE_COLUMNS = (
    "referenceChange_supportFraction",
    "referenceChange_positiveGainFraction",
    "referenceTransition_positiveGainFraction",
    "perReference_positiveDifferenceGainFraction",
    "perReference_positiveWhitenedGainFraction",
)

PARTIAL_REFERENCE_EVIDENCE_COLUMNS = (
    "referenceTransition_positiveGainFraction",
    "referenceTransition_baselineModeFraction",
    "perReference_positiveSideStepFraction",
    "perReference_lagStepPositiveFraction",
    "perReference_fixedLagStepPositiveFraction",
)

OPERATION_PROFILE_FAMILIES: dict[str, tuple[str, ...]] = {
    "counterfactual": (
        "identity_rawGain_percentile",
        "identity_differenceGain_percentile",
        "identity_combinedGain_percentile",
        "identity_sideMinimumAdvantage_percentile",
        "identity_sideStepScore_percentile",
        "identity_correctedSideSupport_percentile",
        "identity_localSideStepScore11_percentile",
        "identity_localSideStepScore21_percentile",
        "identity_localSideStepScore31_percentile",
    ),
    "transition": (
        "identity_rawTransition_normalizedSplitGain_percentile",
        "identity_rawTransition_balancedAdvantage_percentile",
        "identity_rawTransition_localGain31_percentile",
        "identity_cofechaTransition_normalizedSplitGain_percentile",
        "identity_cofechaTransition_balancedAdvantage_percentile",
        "identity_cofechaTransition_localGain31_percentile",
    ),
    "path": (
        "identity_cumulative_combinedCusum_percentile",
        "identity_cumulative_combinedContrast_percentile",
        "identity_cumulative_referenceMedianCusum_percentile",
        "identity_cumulative_referenceVoteCusum_percentile",
        "identity_piecewise_combinedObjective_percentile",
        "identity_piecewise_combinedGain_percentile",
    ),
    "reference": (
        "identity_referenceChange_weightedSupport_percentile",
        "identity_referenceChange_positiveGainFraction_percentile",
        "identity_referenceTransition_weightedRankMean_percentile",
        "identity_referenceTransition_peakKernel9_percentile",
        "identity_referenceTransition_weightedWindowVote25_percentile",
        "identity_perReference_differenceGainWeighted_percentile",
        "identity_perReference_fixedLagStepWeighted_percentile",
        "identity_perReference_fixedLagStepPeakKernel9_percentile",
    ),
    "boundary": (
        "identity_boundaryLocal_stepMinimum5_percentile",
        "identity_boundaryLocal_stepMean5_percentile",
        "identity_partialLocal_multiScale_percentile",
    ),
}

CROSS_OPERATION_PROFILE_FAMILIES: dict[str, tuple[str, ...]] = {
    "counterfactual": (
        "cross_rawGain_percentile",
        "cross_differenceGain_percentile",
        "cross_combinedGain_percentile",
        "cross_sideMinimumAdvantage_percentile",
        "cross_sideStepScore_percentile",
        "cross_correctedSideSupport_percentile",
        "cross_localSideStepScore11_percentile",
        "cross_localSideStepScore21_percentile",
        "cross_localSideStepScore31_percentile",
    ),
    "transition": (
        "cross_rawTransition_normalizedSplitGain_percentile",
        "cross_rawTransition_balancedAdvantage_percentile",
        "cross_rawTransition_localGain31_percentile",
        "cross_cofechaTransition_normalizedSplitGain_percentile",
        "cross_cofechaTransition_balancedAdvantage_percentile",
        "cross_cofechaTransition_localGain31_percentile",
    ),
    "path": (
        "cross_cumulative_combinedCusum_percentile",
        "cross_cumulative_combinedContrast_percentile",
        "cross_cumulative_referenceMedianCusum_percentile",
        "cross_cumulative_referenceVoteCusum_percentile",
        "cross_piecewise_combinedObjective_percentile",
        "cross_piecewise_combinedGain_percentile",
    ),
    "reference": (
        "cross_referenceChange_weightedSupport_percentile",
        "cross_referenceChange_positiveGainFraction_percentile",
        "cross_referenceTransition_weightedRankMean_percentile",
        "cross_referenceTransition_peakKernel9_percentile",
        "cross_referenceTransition_weightedWindowVote25_percentile",
        "cross_perReference_differenceGainWeighted_percentile",
        "cross_perReference_fixedLagStepWeighted_percentile",
        "cross_perReference_fixedLagStepPeakKernel9_percentile",
    ),
    "boundary": (
        "cross_boundaryLocal_stepMinimum5_percentile",
        "cross_boundaryLocal_stepMean5_percentile",
        "cross_partialLocal_multiScale_percentile",
    ),
}

TRANSITION_CHANNELS = (
    (
        "raw",
        "rawTransition_olderLag",
        "rawTransition_newerLag",
        (
            "identity_rawTransition_normalizedSplitGain_percentile",
            "identity_rawTransition_balancedAdvantage_percentile",
        ),
    ),
    (
        "raw_local",
        "rawTransition_localOlderLag",
        "rawTransition_localNewerLag",
        (
            "identity_rawTransition_localGain31_percentile",
            "identity_rawTransition_balancedAdvantage_percentile",
        ),
    ),
    (
        "cofecha",
        "cofechaTransition_olderLag",
        "cofechaTransition_newerLag",
        (
            "identity_cofechaTransition_normalizedSplitGain_percentile",
            "identity_cofechaTransition_balancedAdvantage_percentile",
        ),
    ),
    (
        "cofecha_local",
        "cofechaTransition_localOlderLag",
        "cofechaTransition_localNewerLag",
        (
            "identity_cofechaTransition_localGain31_percentile",
            "identity_cofechaTransition_balancedAdvantage_percentile",
        ),
    ),
)

OPERATION_RELATIVE_SOURCES = (
    "bottom_candidate_baseline_match",
    "bottom_candidate_primary_baseline_match",
    "bottom_candidate_primary_baseline_weighted",
    "bottom_candidate_tail_baseline_match",
    "bottom_candidate_tail_baseline_weighted",
    "bottom_operation_counterfactual_profile_max",
    "bottom_operation_transition_profile_max",
    "bottom_operation_path_profile_max",
    "bottom_operation_reference_profile_max",
    "bottom_operation_boundary_profile_max",
    "bottom_operation_lag_match_consensus",
    "bottom_operation_state_match_consensus",
    "bottom_operation_joint_match_consensus",
    "bottom_operation_reference_consensus",
    "bottom_operation_cross_consensus_peak",
    "bottom_operation_cross_minimum_peak",
    "bottom_operation_cross_agreement_peak",
    "bottom_operation_cross_same_year_margin",
    "bottom_operation_frontier_clearance",
    "bottom_primary_baseline_local_margin",
    "bottom_attempt_quietness",
)


OPERATION_CORE_FEATURES = (
    "bottom_candidate_primary_baseline_distance",
    "bottom_candidate_primary_baseline_match",
    "bottom_candidate_primary_baseline_weighted",
    "bottom_candidate_primary_baseline_exact",
    "bottom_candidate_primary_baseline_near",
    "bottom_candidate_tail_baseline_distance",
    "bottom_candidate_tail_baseline_match",
    "bottom_candidate_tail_baseline_weighted",
    "bottom_candidate_tail_baseline_exact",
    "bottom_candidate_tail_baseline_near",
    "bottom_tail_consensus_baseline_support",
    "bottom_tail_consensus_baseline_state_count",
    "bottom_tail_consensus_baseline_entropy",
    "bottom_tail_baseline_nonzero_strength",
    "bottom_operation_counterfactual_profile_max",
    "bottom_operation_counterfactual_profile_q95",
    "bottom_operation_transition_profile_max",
    "bottom_operation_transition_profile_q95",
    "bottom_operation_path_profile_max",
    "bottom_operation_path_profile_q95",
    "bottom_operation_reference_profile_max",
    "bottom_operation_reference_profile_q95",
    "bottom_operation_boundary_profile_max",
    "bottom_operation_boundary_profile_q95",
    "bottom_operation_strength_consensus",
    "bottom_operation_strength_channel_agreement",
    "bottom_operation_lag_match_consensus",
    "bottom_operation_lag_match_channel_agreement",
    "bottom_operation_state_match_consensus",
    "bottom_operation_state_match_channel_agreement",
    "bottom_operation_joint_match_consensus",
    "bottom_operation_joint_match_channel_agreement",
    "bottom_operation_reference_consensus",
    "bottom_operation_reference_channel_agreement",
    "bottom_operation_raw_joint_match_max",
    "bottom_operation_raw_joint_match_q95",
    "bottom_operation_raw_state_match_max",
    "bottom_operation_raw_state_match_q95",
    "bottom_operation_raw_top_exact",
    "bottom_operation_raw_local_joint_match_max",
    "bottom_operation_raw_local_joint_match_q95",
    "bottom_operation_raw_local_state_match_max",
    "bottom_operation_raw_local_state_match_q95",
    "bottom_operation_raw_local_top_exact",
    "bottom_operation_cofecha_joint_match_max",
    "bottom_operation_cofecha_joint_match_q95",
    "bottom_operation_cofecha_state_match_max",
    "bottom_operation_cofecha_state_match_q95",
    "bottom_operation_cofecha_top_exact",
    "bottom_operation_cross_consensus_peak",
    "bottom_operation_cross_minimum_peak",
    "bottom_operation_cross_agreement_peak",
    "bottom_operation_cross_same_year_margin",
    "bottom_operation_newer_competitor_support",
    "bottom_operation_newer_competitor_advantage",
    "bottom_operation_newer_stronger_distance",
    "bottom_operation_newer_unit_competitor_support",
    "bottom_operation_newer_unit_competitor_advantage",
    "bottom_operation_frontier_veto_strength",
    "bottom_operation_frontier_clearance",
    "bottom_attempt_local_cross_peak",
    "bottom_attempt_local_cross_q95",
    "bottom_candidate_cross_peak_deficit",
    "bottom_primary_baseline_local_margin",
    "bottom_tail_baseline_local_margin",
    "bottom_attempt_quietness",
    "bottom_candidate_tail_baseline_match_attempt_rank",
    "bottom_candidate_tail_baseline_match_attempt_z",
    "bottom_candidate_tail_baseline_match_attempt_deficit",
    "bottom_operation_cross_consensus_peak_attempt_rank",
    "bottom_operation_cross_consensus_peak_attempt_z",
    "bottom_operation_cross_consensus_peak_attempt_deficit",
    "bottom_operation_frontier_clearance_attempt_rank",
    "bottom_operation_frontier_clearance_attempt_z",
    "bottom_operation_frontier_clearance_attempt_deficit",
)


def normalize_attempt_id(value: object) -> str:
    text = str(value)
    marker = "evaluation:"
    index = text.find(marker)
    return text[index:] if index >= 0 else text


def attach_attempt_key(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    output["attempt_key"] = output["attempt_id"].map(normalize_attempt_id)
    return output


def identity_key(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["attempt_key"].astype(str)
        + "|"
        + frame["event_type"].astype(str)
        + "|"
        + pd.to_numeric(frame["shift_years"], errors="coerce")
        .fillna(0)
        .astype(int)
        .astype(str)
    )


def _family_percentile_columns(
    frame: pd.DataFrame,
    prefixes: Iterable[str],
) -> list[str]:
    selected = []
    for column in frame.columns:
        if not column.startswith("identity_") or not column.endswith("_percentile"):
            continue
        if column.startswith("identity_operation_"):
            continue
        core = column.removeprefix("identity_").removesuffix("_percentile")
        if any(core.startswith(prefix) for prefix in prefixes):
            selected.append(column)
    return selected


def _calendar_shift(
    values: pd.Series,
    years: pd.Series,
    groups: pd.Series,
    offset: int,
) -> pd.Series:
    shifted = values.groupby(groups, sort=False).shift(offset)
    shifted_year = years.groupby(groups, sort=False).shift(offset)
    return shifted.where(years.sub(shifted_year).eq(offset))


def _calendar_neighbours(
    values: pd.Series,
    years: pd.Series,
    groups: pd.Series,
    offsets: Iterable[int],
) -> pd.DataFrame:
    return pd.concat(
        [_calendar_shift(values, years, groups, offset) for offset in offsets],
        axis=1,
    )


def _remote_newer_maximum(
    values: pd.Series,
    years: pd.Series,
    groups: pd.Series,
    minimum_gap: int,
) -> pd.Series:
    output = np.full(len(values), np.nan, dtype=np.float32)
    numeric_values = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
    numeric_years = pd.to_numeric(years, errors="coerce").to_numpy(dtype=float)
    positions = pd.Series(np.arange(len(values)), index=values.index)
    for _, indices in positions.groupby(groups, sort=False):
        index = indices.to_numpy(dtype=int)
        group_years = numeric_years[index]
        group_values = numeric_values[index]
        finite_values = np.where(np.isfinite(group_values), group_values, -np.inf)
        suffix_maximum = np.maximum.accumulate(finite_values[::-1])[::-1]
        for local_index, year in enumerate(group_years):
            if not np.isfinite(year):
                continue
            newer = int(np.searchsorted(group_years, year + minimum_gap, side="left"))
            if newer < len(index) and np.isfinite(suffix_maximum[newer]):
                output[index[local_index]] = suffix_maximum[newer]
    return pd.Series(output, index=values.index)


def append_full_year_bottom_evidence(rows: pd.DataFrame) -> pd.DataFrame:
    """Generate relative full-year boundary evidence for local operations."""

    required = {"attempt_id", "event_type", "shift_years", "year"}
    missing = required.difference(rows.columns)
    if missing:
        raise RuntimeError(f"full-year evidence misses columns: {sorted(missing)}")

    frame = attach_attempt_key(rows)
    frame = frame[frame["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    frame["shift_years"] = pd.to_numeric(
        frame["shift_years"], errors="coerce"
    ).fillna(0).astype(int)
    frame["year"] = pd.to_numeric(frame["year"], errors="coerce")
    frame["bottom_identity_key"] = identity_key(frame)
    frame = frame.sort_values(["bottom_identity_key", "year"]).reset_index(drop=True)
    groups = frame["bottom_identity_key"]
    years = frame["year"]

    features: dict[str, pd.Series] = {}
    family_scores: list[str] = []
    family_adjacent_wins: list[str] = []
    family_boundary_wins: list[str] = []
    family_remote_residuals: list[str] = []
    family_peak_distances: list[str] = []
    family_one_year_margins: list[str] = []
    family_mode_ratios: dict[int, list[str]] = {
        width: [] for width in STANDARD_WINDOW_WIDTHS
    }
    family_posterior_masses: dict[int, list[str]] = {
        width: [] for width in STANDARD_WINDOW_WIDTHS
    }
    family_window_means: dict[int, list[str]] = {
        width: [] for width in STANDARD_WINDOW_WIDTHS
    }

    shift = pd.to_numeric(frame["shift_years"], errors="coerce").fillna(0)
    lag_match_columns: list[str] = []
    lag_weighted_columns: list[str] = []
    for channel, older_column, newer_column, support_column in (
        (
            "raw",
            "rawTransition_olderLag",
            "rawTransition_newerLag",
            "identity_rawTransition_normalizedSplitGain_percentile",
        ),
        (
            "raw_local",
            "rawTransition_localOlderLag",
            "rawTransition_localNewerLag",
            "identity_rawTransition_localGain31_percentile",
        ),
        (
            "cofecha",
            "cofechaTransition_olderLag",
            "cofechaTransition_newerLag",
            "identity_cofechaTransition_normalizedSplitGain_percentile",
        ),
        (
            "cofecha_local",
            "cofechaTransition_localOlderLag",
            "cofechaTransition_localNewerLag",
            "identity_cofechaTransition_localGain31_percentile",
        ),
    ):
        if older_column not in frame or newer_column not in frame:
            continue
        delta = pd.to_numeric(frame[older_column], errors="coerce").sub(
            pd.to_numeric(frame[newer_column], errors="coerce")
        )
        distance = delta.sub(shift).abs()
        match_name = f"bottom_lag_delta_{channel}_match"
        distance_name = f"bottom_lag_delta_{channel}_distance"
        exact_name = f"bottom_lag_delta_{channel}_exact"
        features[distance_name] = distance.astype(np.float32)
        features[match_name] = distance.add(1.0).rdiv(1.0).astype(
            np.float32
        )
        features[exact_name] = distance.le(0.25).astype(np.float32)
        lag_match_columns.append(match_name)
        if support_column in frame:
            support = pd.to_numeric(frame[support_column], errors="coerce")
            weighted_name = f"bottom_lag_delta_{channel}_weighted"
            features[weighted_name] = features[match_name].mul(support).astype(
                np.float32
            )
            lag_weighted_columns.append(weighted_name)

    if lag_match_columns:
        lag_match_frame = pd.DataFrame({
            name: features[name] for name in lag_match_columns
        }, index=frame.index)
        features["bottom_lag_delta_consensus"] = lag_match_frame.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features["bottom_lag_delta_exact_fraction"] = lag_match_frame.ge(
            0.8
        ).mean(axis=1).astype(np.float32)
        if lag_weighted_columns:
            weighted_frame = pd.DataFrame({
                name: features[name] for name in lag_weighted_columns
            }, index=frame.index)
            features["bottom_lag_delta_weighted_consensus"] = weighted_frame.median(
                axis=1, skipna=True
            ).astype(np.float32)
        lag_score = features.get(
            "bottom_lag_delta_weighted_consensus",
            features["bottom_lag_delta_consensus"],
        )
        remote_lag = _remote_newer_maximum(
            lag_score, years, groups, minimum_gap=7
        )
        features["bottom_lag_delta_newer_residual"] = remote_lag.sub(
            lag_score
        ).astype(np.float32)
        for width in STANDARD_WINDOW_WIDTHS:
            radius = width // 2
            neighbourhood = _calendar_neighbours(
                lag_score,
                years,
                groups,
                range(-radius, radius + 1),
            )
            features[f"bottom_lag_delta_window{width}_maximum"] = (
                neighbourhood.max(axis=1, skipna=True).astype(np.float32)
            )
            features[f"bottom_lag_delta_window{width}_mean"] = (
                neighbourhood.mean(axis=1, skipna=True).astype(np.float32)
            )

    for family, prefixes in EVIDENCE_FAMILIES.items():
        columns = _family_percentile_columns(frame, prefixes)
        if not columns:
            continue
        values = frame[columns].apply(pd.to_numeric, errors="coerce")
        score_name = f"bottom_{family}_score"
        dispersion_name = f"bottom_{family}_dispersion"
        score = values.median(axis=1, skipna=True).astype(np.float32)
        features[score_name] = score
        features[dispersion_name] = values.std(axis=1, skipna=True).astype(
            np.float32
        )
        family_scores.append(score_name)
        score_rank = score.groupby(groups, sort=False).rank(
            pct=True, method="average"
        )
        posterior_raw = np.exp(4.0 * score_rank.sub(1.0)).astype(np.float32)
        posterior = posterior_raw.div(
            posterior_raw.groupby(groups, sort=False).transform("sum")
            .replace(0, np.nan)
        ).astype(np.float32)
        features[f"bottom_{family}_posterior"] = posterior

        older3 = _calendar_neighbours(score, years, groups, (1, 2, 3)).mean(
            axis=1, skipna=True
        )
        newer3 = _calendar_neighbours(score, years, groups, (-1, -2, -3)).mean(
            axis=1, skipna=True
        )
        older1 = _calendar_shift(score, years, groups, 1)
        newer1 = _calendar_shift(score, years, groups, -1)
        adjacent = pd.concat([newer1, older1], axis=1)
        older_advantage = score.sub(older3)
        newer_advantage = score.sub(newer3)
        older1_advantage = score.sub(older1)
        newer1_advantage = score.sub(newer1)
        one_year_minimum = pd.Series(
            np.minimum(older1_advantage, newer1_advantage), index=frame.index
        )
        minimum_advantage = pd.Series(
            np.minimum(older_advantage, newer_advantage), index=frame.index
        )
        features[f"bottom_{family}_older1_advantage"] = older1_advantage
        features[f"bottom_{family}_newer1_advantage"] = newer1_advantage
        features[f"bottom_{family}_one_year_minimum_advantage"] = one_year_minimum
        features[f"bottom_{family}_one_year_asymmetry"] = (
            older1_advantage.sub(newer1_advantage)
        )
        features[f"bottom_{family}_older3_advantage"] = older_advantage
        features[f"bottom_{family}_newer3_advantage"] = newer_advantage
        features[f"bottom_{family}_minimum_side_advantage"] = minimum_advantage
        features[f"bottom_{family}_side_asymmetry"] = older3.sub(newer3)
        features[f"bottom_{family}_adjacent_margin"] = score.sub(
            adjacent.max(axis=1, skipna=True)
        )
        adjacent_win = f"bottom_{family}_adjacent_win"
        boundary_win = f"bottom_{family}_boundary_win"
        features[adjacent_win] = score.gt(adjacent.max(axis=1, skipna=True)).astype(
            np.float32
        )
        features[boundary_win] = minimum_advantage.gt(0).astype(np.float32)
        family_adjacent_wins.append(adjacent_win)
        family_boundary_wins.append(boundary_win)
        one_year_margin_name = f"bottom_{family}_one_year_minimum_advantage"
        family_one_year_margins.append(one_year_margin_name)

        peak = score.groupby(groups, sort=False).transform("max")
        peak_year = years.where(score.eq(peak) & score.notna()).groupby(
            groups, sort=False
        ).transform("median")
        peak_distance_name = f"bottom_{family}_peak_distance"
        features[peak_distance_name] = years.sub(peak_year).abs().astype(
            np.float32
        )
        family_peak_distances.append(peak_distance_name)

        remote = _remote_newer_maximum(score, years, groups, minimum_gap=7)
        residual_name = f"bottom_{family}_newer_residual"
        features[residual_name] = remote.sub(score).astype(np.float32)
        family_remote_residuals.append(residual_name)

        for width in STANDARD_WINDOW_WIDTHS:
            radius = width // 2
            neighbourhood = _calendar_neighbours(
                score,
                years,
                groups,
                range(-radius, radius + 1),
            )
            window_name = f"bottom_{family}_window{width}_mean"
            window_mean = neighbourhood.mean(axis=1, skipna=True).astype(
                np.float32
            )
            features[window_name] = window_mean
            maximum = window_mean.groupby(groups, sort=False).transform(
                "max"
            )
            mode_name = f"bottom_{family}_window{width}_mode_ratio"
            features[mode_name] = window_mean.div(
                maximum.replace(0, np.nan)
            ).astype(np.float32)
            family_window_means[width].append(window_name)
            family_mode_ratios[width].append(mode_name)
            posterior_name = f"bottom_{family}_window{width}_posterior_mass"
            features[posterior_name] = _calendar_neighbours(
                posterior,
                years,
                groups,
                range(-radius, radius + 1),
            ).sum(axis=1, min_count=1).astype(np.float32)
            family_posterior_masses[width].append(posterior_name)

    if not family_scores:
        raise RuntimeError("full-year cache has no usable relative evidence families")

    family_frame = pd.DataFrame(
        {name: features[name] for name in family_scores}, index=frame.index
    )
    adjacent_frame = pd.DataFrame(
        {name: features[name] for name in family_adjacent_wins}, index=frame.index
    )
    boundary_frame = pd.DataFrame(
        {name: features[name] for name in family_boundary_wins}, index=frame.index
    )
    residual_frame = pd.DataFrame(
        {name: features[name] for name in family_remote_residuals}, index=frame.index
    )
    one_year_frame = pd.DataFrame(
        {name: features[name] for name in family_one_year_margins}, index=frame.index
    )
    peak_distance_frame = pd.DataFrame(
        {name: features[name] for name in family_peak_distances}, index=frame.index
    )
    features["bottom_consensus_score"] = family_frame.median(
        axis=1, skipna=True
    ).astype(np.float32)
    features["bottom_consensus_dispersion"] = family_frame.std(
        axis=1, skipna=True
    ).astype(np.float32)
    features["bottom_adjacent_win_fraction"] = adjacent_frame.mean(
        axis=1, skipna=True
    ).astype(np.float32)
    features["bottom_boundary_win_fraction"] = boundary_frame.mean(
        axis=1, skipna=True
    ).astype(np.float32)
    features["bottom_one_year_minimum_consensus"] = one_year_frame.median(
        axis=1, skipna=True
    ).astype(np.float32)
    features["bottom_one_year_win_fraction"] = one_year_frame.gt(0).mean(
        axis=1
    ).astype(np.float32)
    features["bottom_evidence_peak_median_distance"] = peak_distance_frame.median(
        axis=1, skipna=True
    ).astype(np.float32)
    features["bottom_evidence_peak_maximum_distance"] = peak_distance_frame.max(
        axis=1, skipna=True
    ).astype(np.float32)
    for radius in (1, 2, 4, 6):
        features[f"bottom_evidence_peak_support_within_{radius}"] = (
            peak_distance_frame.le(radius).mean(axis=1).astype(np.float32)
        )
    features["bottom_newer_residual_fraction"] = residual_frame.gt(0.05).mean(
        axis=1
    ).astype(np.float32)
    features["bottom_newer_residual_median"] = residual_frame.median(
        axis=1, skipna=True
    ).astype(np.float32)
    positive_newer_residual = residual_frame.clip(lower=0)
    features["bottom_frontier_veto_strength"] = positive_newer_residual.median(
        axis=1, skipna=True
    ).mul(
        features["bottom_newer_residual_fraction"]
    ).astype(np.float32)
    features["bottom_frontier_clearance"] = features[
        "bottom_frontier_veto_strength"
    ].add(1.0).rdiv(1.0).astype(np.float32)

    for width in STANDARD_WINDOW_WIDTHS:
        window_frame = pd.DataFrame({
            name: features[name] for name in family_window_means[width]
        }, index=frame.index)
        mode_frame = pd.DataFrame({
            name: features[name] for name in family_mode_ratios[width]
        }, index=frame.index)
        posterior_frame = pd.DataFrame({
            name: features[name] for name in family_posterior_masses[width]
        }, index=frame.index)
        features[f"bottom_window{width}_consensus"] = window_frame.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features[f"bottom_window{width}_mode_consensus"] = mode_frame.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features[f"bottom_window{width}_mode_support"] = mode_frame.ge(0.9).mean(
            axis=1
        ).astype(np.float32)
        features[f"bottom_window{width}_posterior_mass"] = posterior_frame.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features[f"bottom_window{width}_posterior_agreement"] = (
            1.0 - posterior_frame.std(axis=1, skipna=True)
        ).clip(0, 1).astype(np.float32)
        features[f"bottom_window{width}_posterior_geometric_mean"] = np.exp(
            np.log(posterior_frame.clip(lower=1e-8)).mean(axis=1, skipna=True)
        ).astype(np.float32)
        features[f"bottom_window{width}_posterior_minimum"] = posterior_frame.min(
            axis=1, skipna=True
        ).astype(np.float32)
        features[f"bottom_window{width}_posterior_lower_quartile"] = (
            posterior_frame.quantile(0.25, axis=1).astype(np.float32)
        )
        posterior_rank = posterior_frame.groupby(groups, sort=False).rank(
            pct=True, method="average"
        )
        features[f"bottom_window{width}_posterior_support"] = posterior_rank.ge(
            0.9
        ).mean(axis=1).astype(np.float32)

    stability = [column for column in REFERENCE_STABILITY_COLUMNS if column in frame]
    if stability:
        stability_values = frame[stability].apply(pd.to_numeric, errors="coerce")
        features["bottom_reference_stability"] = stability_values.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features["bottom_reference_stability_dispersion"] = stability_values.std(
            axis=1, skipna=True
        ).astype(np.float32)
        stability_ranks = stability_values.groupby(groups, sort=False).rank(
            pct=True, method="average"
        )
        stability_mean = stability_values.groupby(groups, sort=False).transform(
            "mean"
        )
        stability_std = stability_values.groupby(groups, sort=False).transform(
            "std"
        ).replace(0, np.nan)
        stability_z = stability_values.sub(stability_mean).div(stability_std).clip(
            -8, 8
        )
        stability_max = stability_values.groupby(groups, sort=False).transform(
            "max"
        )
        stability_margin = stability_values.sub(stability_max).div(
            stability_std
        ).clip(-12, 0)
        features["bottom_reference_rank_consensus"] = stability_ranks.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features["bottom_reference_rank_agreement"] = (
            1.0 - stability_ranks.std(axis=1, skipna=True)
        ).clip(0, 1).astype(np.float32)
        features["bottom_reference_z_consensus"] = stability_z.median(
            axis=1, skipna=True
        ).astype(np.float32)
        features["bottom_reference_winner_margin_consensus"] = (
            stability_margin.median(axis=1, skipna=True).astype(np.float32)
        )

        reference_adjacent_margins: list[pd.Series] = []
        for column in stability:
            values = stability_values[column]
            older = _calendar_shift(values, years, groups, 1)
            newer = _calendar_shift(values, years, groups, -1)
            reference_adjacent_margins.append(pd.Series(
                np.minimum(values.sub(older), values.sub(newer)),
                index=frame.index,
            ))
        reference_adjacent = pd.concat(reference_adjacent_margins, axis=1)
        features["bottom_reference_one_year_minimum_consensus"] = (
            reference_adjacent.median(axis=1, skipna=True).astype(np.float32)
        )
        features["bottom_reference_one_year_win_fraction"] = (
            reference_adjacent.gt(0).mean(axis=1).astype(np.float32)
        )

        unit_columns = [
            column for column in UNIT_REFERENCE_EVIDENCE_COLUMNS if column in frame
        ]
        partial_columns = [
            column for column in PARTIAL_REFERENCE_EVIDENCE_COLUMNS if column in frame
        ]
        unit_score = frame[unit_columns].apply(
            pd.to_numeric, errors="coerce"
        ).median(axis=1, skipna=True)
        partial_score = frame[partial_columns].apply(
            pd.to_numeric, errors="coerce"
        ).median(axis=1, skipna=True)
        operation_score = unit_score.where(
            frame["event_type"].ne("partialMove"), partial_score
        )
        operation_group = operation_score.groupby(groups, sort=False)
        operation_mean = operation_group.transform("mean")
        operation_std = operation_group.transform("std").replace(0, np.nan)
        operation_max = operation_group.transform("max")
        operation_rank = operation_group.rank(pct=True, method="average")
        features["bottom_operation_reference_score"] = operation_score.astype(
            np.float32
        )
        features["bottom_operation_reference_rank"] = operation_rank.astype(
            np.float32
        )
        features["bottom_operation_reference_z"] = operation_score.sub(
            operation_mean
        ).div(operation_std).clip(-8, 8).astype(np.float32)
        features["bottom_operation_reference_winner_margin"] = operation_score.sub(
            operation_max
        ).div(operation_std).clip(-12, 0).astype(np.float32)
        operation_older = _calendar_shift(operation_score, years, groups, 1)
        operation_newer = _calendar_shift(operation_score, years, groups, -1)
        operation_adjacent = pd.Series(
            np.minimum(
                operation_score.sub(operation_older),
                operation_score.sub(operation_newer),
            ),
            index=frame.index,
        )
        features["bottom_operation_reference_one_year_minimum"] = (
            operation_adjacent.astype(np.float32)
        )
        features["bottom_operation_reference_one_year_win"] = (
            operation_adjacent.gt(0).astype(np.float32)
        )
        reference_count_columns = [
            column
            for column in (
                "referenceChange_referenceCount",
                "referenceTransition_referenceCount",
                "perReference_referenceCount",
            )
            if column in frame
        ]
        if reference_count_columns:
            counts = frame[reference_count_columns].apply(
                pd.to_numeric, errors="coerce"
            )
            features["bottom_reference_count_log"] = np.log1p(
                counts.median(axis=1, skipna=True).clip(lower=0)
            ).astype(np.float32)

    keys = frame[[
        "attempt_key",
        "event_type",
        "shift_years",
        "year",
        "bottom_identity_key",
    ]]
    output = pd.DataFrame(features, index=frame.index)
    return pd.concat([keys, output], axis=1).replace(
        [np.inf, -np.inf], np.nan
    )


def project_year_evidence_to_packages(
    packages: pd.DataFrame,
    yearly: pd.DataFrame,
) -> pd.DataFrame:
    """Project full-year evidence onto existing immutable package centres."""

    package_keys = attach_attempt_key(packages)
    package_keys["shift_years"] = pd.to_numeric(
        package_keys["shift_years"], errors="coerce"
    ).fillna(0).astype(int)
    package_keys["candidate_year"] = pd.to_numeric(
        package_keys["candidate_year"], errors="coerce"
    )
    package_keys["bottom_identity_key"] = identity_key(package_keys)
    evidence_columns = [
        column
        for column in yearly.columns
        if column.startswith("bottom_") and column != "bottom_identity_key"
    ]
    lookup = yearly[["bottom_identity_key", "year", *evidence_columns]].rename(
        columns={"year": "candidate_year"}
    )
    if lookup.duplicated(["bottom_identity_key", "candidate_year"]).any():
        lookup = lookup.groupby(
            ["bottom_identity_key", "candidate_year"], sort=False, as_index=False
        )[evidence_columns].mean()
    projected = package_keys[[
        "identity_group", "candidate_year", "bottom_identity_key"
    ]].merge(
        lookup,
        on=["bottom_identity_key", "candidate_year"],
        how="left",
        validate="many_to_one",
    )
    projected = projected.drop(columns="bottom_identity_key")
    return projected.drop_duplicates(
        ["identity_group", "candidate_year"], keep="first"
    ).reset_index(drop=True)


def append_overlapping_package_mode_evidence(packages: pd.DataFrame) -> pd.DataFrame:
    """Aggregate mutually supporting immutable proposals in a local mode.

    The operation identity and every candidate centre remain unchanged.  The
    generated features only describe how many independent frozen proposals and
    evidence heads support the same 5--13 year physical neighbourhood.
    """

    required = {"identity_group", "candidate_year", "candidate_source"}
    missing = required.difference(packages.columns)
    if missing:
        raise RuntimeError(f"package mode evidence misses columns: {sorted(missing)}")
    output: dict[str, np.ndarray] = {}
    numeric_channels = [
        column
        for column in (
            "location_meta_percentile",
            "location_global_percentile",
            "location_typed_percentile",
            "location_global_classifier_percentile",
            "location_typed_classifier_percentile",
            "bottom_consensus_score",
            "bottom_window5_posterior_mass",
            "bottom_window9_posterior_mass",
            "bottom_window13_posterior_mass",
            "bottom_reference_stability",
        )
        if column in packages
    ]
    years = pd.to_numeric(packages["candidate_year"], errors="coerce").to_numpy(
        dtype=float
    )
    sources = packages["candidate_source"].fillna("missing").astype(str).to_numpy()
    numeric_frame = packages[numeric_channels].apply(pd.to_numeric, errors="coerce")
    seed_columns = [
        column for column in numeric_channels if column.startswith("location_")
    ]
    bottom_columns = [
        column for column in numeric_channels if column.startswith("bottom_")
    ]
    seed_values = (
        numeric_frame[seed_columns].median(axis=1, skipna=True).to_numpy(dtype=float)
        if seed_columns else np.full(len(packages), np.nan)
    )
    bottom_values = (
        numeric_frame[bottom_columns].median(axis=1, skipna=True).to_numpy(dtype=float)
        if bottom_columns else np.full(len(packages), np.nan)
    )
    positions = pd.Series(np.arange(len(packages)), index=packages.index)
    radii = (2, 4, 6)
    for radius in radii:
        for suffix in (
            "center_count",
            "source_count",
            "primary_support",
            "seed_mean",
            "seed_max",
            "seed_kernel",
            "bottom_mean",
            "bottom_max",
            "bottom_kernel",
        ):
            output[f"bottom_package_mode{radius}_{suffix}"] = np.full(
                len(packages), np.nan, dtype=np.float32
            )

    for _, indices in positions.groupby(packages["identity_group"], sort=False):
        index = indices.to_numpy(dtype=int)
        group_years = years[index]
        group_sources = sources[index]
        group_seed = seed_values[index]
        group_bottom = bottom_values[index]
        valid_years = np.isfinite(group_years)
        distance = np.abs(group_years[:, None] - group_years[None, :])
        source_levels = np.unique(group_sources)
        source_matrix = group_sources[:, None] == source_levels[None, :]
        primary = group_sources == "productPrimary"
        for radius in radii:
            mask = (
                valid_years[:, None]
                & valid_years[None, :]
                & (distance <= radius)
            )
            prefix = f"bottom_package_mode{radius}"
            output[f"{prefix}_center_count"][index] = mask.sum(axis=1)
            output[f"{prefix}_source_count"][index] = (
                mask.astype(np.int16) @ source_matrix.astype(np.int16) > 0
            ).sum(axis=1)
            output[f"{prefix}_primary_support"][index] = (
                mask.astype(np.int16) @ primary.astype(np.int16) > 0
            )
            kernel = np.where(mask, 1.0 - distance / (radius + 1.0), 0.0)
            for label, values in (("seed", group_seed), ("bottom", group_bottom)):
                finite = np.isfinite(values)
                valid_mask = mask & finite[None, :]
                counts = valid_mask.sum(axis=1)
                sums = valid_mask.astype(float) @ np.where(finite, values, 0.0)
                means = np.divide(
                    sums,
                    counts,
                    out=np.full(len(index), np.nan),
                    where=counts > 0,
                )
                masked_values = np.where(valid_mask, values[None, :], -np.inf)
                maximums = masked_values.max(axis=1)
                maximums[~np.isfinite(maximums)] = np.nan
                weights = kernel * finite[None, :]
                weight_sum = weights.sum(axis=1)
                weighted = np.divide(
                    weights @ np.where(finite, values, 0.0),
                    weight_sum,
                    out=np.full(len(index), np.nan),
                    where=weight_sum > 0,
                )
                output[f"{prefix}_{label}_mean"][index] = means
                output[f"{prefix}_{label}_max"][index] = maximums
                output[f"{prefix}_{label}_kernel"][index] = weighted
    appended = pd.DataFrame(output, index=packages.index)
    duplicate = [column for column in appended if column in packages]
    if duplicate:
        packages = packages.drop(columns=duplicate)
    return pd.concat([packages, appended], axis=1)


def _mode_summary(
    frame: pd.DataFrame,
    group_columns: list[str],
    value_column: str,
    prefix: str,
) -> pd.DataFrame:
    """Return a deterministic integer mode and its concentration."""

    values = frame[[*group_columns, value_column]].copy()
    values[value_column] = pd.to_numeric(values[value_column], errors="coerce")
    values = values.dropna(subset=[value_column])
    if values.empty:
        return pd.DataFrame(columns=[
            *group_columns,
            f"{prefix}_mode",
            f"{prefix}_support",
            f"{prefix}_state_count",
            f"{prefix}_entropy",
        ])
    values[value_column] = values[value_column].round().astype(int)
    counts = (
        values.groupby([*group_columns, value_column], sort=False)
        .size()
        .rename("_count")
        .reset_index()
    )
    totals = counts.groupby(group_columns, sort=False)["_count"].transform("sum")
    counts["_probability"] = counts["_count"].div(totals)
    counts["_entropy_term"] = -counts["_probability"].mul(
        np.log(counts["_probability"].clip(lower=1e-12))
    )
    summaries = counts.groupby(group_columns, sort=False).agg(
        **{
            f"{prefix}_state_count": (value_column, "size"),
            f"{prefix}_entropy": ("_entropy_term", "sum"),
        }
    ).reset_index()
    counts["_absolute_value"] = counts[value_column].abs()
    top = (
        counts.sort_values(
            [*group_columns, "_count", "_absolute_value", value_column],
            ascending=[*[True] * len(group_columns), False, True, True],
            kind="stable",
        )
        .drop_duplicates(group_columns)
        .rename(columns={
            value_column: f"{prefix}_mode",
            "_probability": f"{prefix}_support",
        })
    )
    return summaries.merge(
        top[[
            *group_columns,
            f"{prefix}_mode",
            f"{prefix}_support",
        ]],
        on=group_columns,
        how="left",
        validate="one_to_one",
    )


def _tail_baseline_evidence(frame: pd.DataFrame) -> pd.DataFrame:
    """Estimate the fixed-side whole baseline before scoring local events.

    Candidate rows duplicate the same calendar boundary for many operation and
    shift hypotheses.  We first collapse those duplicates to one robust lag
    state per year, then vote only over recent fixed-side context.  This keeps
    a long older-side cumulative staircase from becoming the whole baseline.
    """

    channel_columns = (
        ("raw", "rawTransition_newerLag"),
        ("cofecha", "cofechaTransition_newerLag"),
    )
    attempt = pd.DataFrame({
        "attempt_key": frame["attempt_key"].drop_duplicates()
    })
    votes: list[pd.DataFrame] = []
    for channel, column in channel_columns:
        if column not in frame:
            continue
        yearly = _mode_summary(
            frame,
            ["attempt_key", "year"],
            column,
            f"_bottom_{channel}_year_state",
        )
        if yearly.empty:
            continue
        state_column = f"_bottom_{channel}_year_state_mode"
        yearly["_latest_year"] = yearly.groupby(
            "attempt_key", sort=False
        )["year"].transform("max")
        yearly["_distance_from_latest"] = yearly["_latest_year"].sub(
            pd.to_numeric(yearly["year"], errors="coerce")
        )
        for years in (25, 50):
            recent = yearly.loc[
                yearly["_distance_from_latest"].between(0, years - 1)
            ]
            prefix = f"bottom_tail_{channel}{years}_baseline"
            summary = _mode_summary(
                recent,
                ["attempt_key"],
                state_column,
                prefix,
            )
            if summary.empty:
                continue
            attempt = attempt.merge(
                summary,
                on="attempt_key",
                how="left",
                validate="one_to_one",
            )
            votes.append(
                summary[["attempt_key", f"{prefix}_mode"]].rename(
                    columns={f"{prefix}_mode": "_baseline"}
                )
            )
    if votes:
        consensus = _mode_summary(
            pd.concat(votes, ignore_index=True),
            ["attempt_key"],
            "_baseline",
            "bottom_tail_consensus_baseline",
        )
        attempt = attempt.merge(
            consensus,
            on="attempt_key",
            how="left",
            validate="one_to_one",
        )
    return attempt


def _identity_score_summary(
    frame: pd.DataFrame,
    score: pd.Series,
    prefix: str,
) -> pd.DataFrame:
    values = frame[["bottom_identity_key"]].copy()
    values["_score"] = pd.to_numeric(score, errors="coerce")
    grouped = values.groupby("bottom_identity_key", sort=False)["_score"]
    summary = grouped.agg(["max", "mean", "std"]).rename(columns={
        "max": f"{prefix}_max",
        "mean": f"{prefix}_mean",
        "std": f"{prefix}_dispersion",
    })
    summary[f"{prefix}_q95"] = grouped.quantile(0.95)
    ranks = grouped.rank(pct=True, method="average")
    values["_peak"] = ranks.ge(0.9).astype(np.float32)
    summary[f"{prefix}_peak_fraction"] = values.groupby(
        "bottom_identity_key", sort=False
    )["_peak"].mean()
    return summary.reset_index()


def _cross_operation_peak_evidence(
    frame: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Build co-located operation support and newer-frontier competition.

    Cross-operation percentiles compare hypotheses at the same diagnostic year.
    Keeping their families co-located prevents unrelated maxima from different
    years being assembled into one apparently strong operation identity.
    """

    family_columns: list[str] = []
    for family, columns in CROSS_OPERATION_PROFILE_FAMILIES.items():
        available = [column for column in columns if column in frame]
        if not available:
            continue
        destination = f"_bottom_cross_{family}"
        frame[destination] = frame[available].apply(
            pd.to_numeric, errors="coerce"
        ).median(axis=1, skipna=True)
        family_columns.append(destination)
    if not family_columns:
        return (
            pd.DataFrame({
                "bottom_identity_key": frame["bottom_identity_key"].unique()
            }),
            pd.DataFrame({"attempt_key": frame["attempt_key"].unique()}),
        )

    family_values = frame[family_columns]
    frame["_bottom_cross_consensus"] = family_values.median(
        axis=1, skipna=True
    )
    frame["_bottom_cross_minimum"] = family_values.min(
        axis=1, skipna=True
    )
    frame["_bottom_cross_agreement"] = (
        1.0 - family_values.std(axis=1, skipna=True)
    ).clip(0, 1)

    identity_parts = [
        _identity_score_summary(
            frame,
            frame["_bottom_cross_consensus"],
            "bottom_operation_cross_consensus",
        ),
        _identity_score_summary(
            frame,
            frame["_bottom_cross_minimum"],
            "bottom_operation_cross_minimum",
        ),
        _identity_score_summary(
            frame,
            frame["_bottom_cross_agreement"],
            "bottom_operation_cross_agreement",
        ),
    ]
    for family, column in (
        (name.removeprefix("_bottom_cross_"), name)
        for name in family_columns
    ):
        identity_parts.append(
            _identity_score_summary(
                frame,
                frame[column],
                f"bottom_operation_cross_{family}",
            )
        )

    best_index = frame.groupby(
        "bottom_identity_key", sort=False
    )["_bottom_cross_consensus"].idxmax()
    peak_columns = [
        "attempt_key",
        "bottom_identity_key",
        "event_type",
        "year",
        "_bottom_cross_consensus",
        "_bottom_cross_minimum",
        "_bottom_cross_agreement",
        *family_columns,
    ]
    peaks = frame.loc[best_index, peak_columns].copy()
    peaks = peaks.rename(columns={
        "_bottom_cross_consensus": "bottom_operation_cross_consensus_peak",
        "_bottom_cross_minimum": "bottom_operation_cross_minimum_peak",
        "_bottom_cross_agreement": "bottom_operation_cross_agreement_peak",
        **{
            column: (
                "bottom_operation_cross_"
                + column.removeprefix("_bottom_cross_")
                + "_peak"
            )
            for column in family_columns
        },
    })

    competition_rows: list[dict[str, float | str]] = []
    row_columns = [
        "bottom_identity_key",
        "event_type",
        "year",
        "_bottom_cross_consensus",
    ]
    peaks_by_attempt = {
        attempt_key: attempt_peaks
        for attempt_key, attempt_peaks in peaks.groupby(
            "attempt_key", sort=False, observed=True
        )
    }
    for attempt_key, attempt_frame in frame.groupby(
        "attempt_key", sort=False, observed=True
    ):
        attempt_peaks = peaks_by_attempt.get(attempt_key)
        if attempt_peaks is None:
            continue
        attempt_rows = attempt_frame[row_columns].copy()
        attempt_rows["year"] = pd.to_numeric(
            attempt_rows["year"], errors="coerce"
        )
        attempt_rows["_bottom_cross_consensus"] = pd.to_numeric(
            attempt_rows["_bottom_cross_consensus"], errors="coerce"
        )
        for _, peak in attempt_peaks.iterrows():
            identity = str(peak["bottom_identity_key"])
            peak_year = float(peak["year"])
            own_support = float(peak["bottom_operation_cross_consensus_peak"])
            other = attempt_rows.loc[
                attempt_rows["bottom_identity_key"].ne(identity)
            ]
            same_year = other.loc[other["year"].eq(peak_year)]
            same_year_support = pd.to_numeric(
                same_year["_bottom_cross_consensus"], errors="coerce"
            ).max()
            newer = other.loc[other["year"].gt(peak_year)]
            newer_support = pd.to_numeric(
                newer["_bottom_cross_consensus"], errors="coerce"
            ).max()
            newer_unit = newer.loc[
                newer["event_type"].isin(("missingRing", "falseRing"))
            ]
            newer_unit_support = pd.to_numeric(
                newer_unit["_bottom_cross_consensus"], errors="coerce"
            ).max()
            stronger = newer.loc[
                pd.to_numeric(
                    newer["_bottom_cross_consensus"], errors="coerce"
                ).gt(own_support)
            ]
            stronger_distance = (
                pd.to_numeric(stronger["year"], errors="coerce")
                .sub(peak_year)
                .min()
            )
            competition_rows.append({
                "bottom_identity_key": identity,
                "bottom_operation_cross_same_year_margin": (
                    own_support - same_year_support
                    if pd.notna(same_year_support)
                    else own_support
                ),
                "bottom_operation_newer_competitor_support": newer_support,
                "bottom_operation_newer_competitor_advantage": (
                    newer_support - own_support
                    if pd.notna(newer_support)
                    else -own_support
                ),
                "bottom_operation_newer_stronger_distance": stronger_distance,
                "bottom_operation_newer_unit_competitor_support": (
                    newer_unit_support
                ),
                "bottom_operation_newer_unit_competitor_advantage": (
                    newer_unit_support - own_support
                    if pd.notna(newer_unit_support)
                    else -own_support
                ),
            })

    identity = peaks.drop(columns=["attempt_key", "event_type", "year"])
    for part in identity_parts:
        new_columns = [
            column
            for column in part.columns
            if column == "bottom_identity_key" or column not in identity
        ]
        identity = identity.merge(
            part[new_columns],
            on="bottom_identity_key",
            how="left",
            validate="one_to_one",
        )
    competition = pd.DataFrame(competition_rows)
    identity = identity.merge(
        competition,
        on="bottom_identity_key",
        how="left",
        validate="one_to_one",
    )
    positive_advantage = pd.to_numeric(
        identity["bottom_operation_newer_competitor_advantage"],
        errors="coerce",
    ).clip(lower=0)
    unit_advantage = pd.to_numeric(
        identity["bottom_operation_newer_unit_competitor_advantage"],
        errors="coerce",
    ).clip(lower=0)
    identity["bottom_operation_frontier_veto_strength"] = pd.concat(
        [positive_advantage, unit_advantage], axis=1
    ).max(axis=1, skipna=True)
    identity["bottom_operation_frontier_clearance"] = identity[
        "bottom_operation_frontier_veto_strength"
    ].add(1.0).rdiv(1.0)

    attempt = frame.groupby("attempt_key", sort=False).agg(
        bottom_attempt_local_cross_peak=("_bottom_cross_consensus", "max"),
        bottom_attempt_local_cross_q95=(
            "_bottom_cross_consensus", lambda values: values.quantile(0.95)
        ),
        bottom_attempt_local_cross_minimum_peak=("_bottom_cross_minimum", "max"),
    ).reset_index()
    return identity, attempt


def append_operation_bottom_evidence(
    operations: pd.DataFrame,
    rows: pd.DataFrame,
) -> pd.DataFrame:
    """Project baseline-conditioned operation evidence onto immutable identities.

    The full-year rows are used only as a truth-blind diagnostic profile.  The
    resulting table never creates an operation or a calendar location; it adds
    baseline, transition compatibility and within-diagnosis relative features
    to the identities already frozen by the candidate generator.
    """

    required_rows = {"attempt_id", "event_type", "shift_years", "year"}
    missing_rows = required_rows.difference(rows.columns)
    if missing_rows:
        raise RuntimeError(
            f"operation evidence misses row columns: {sorted(missing_rows)}"
        )
    required_operations = {
        "attempt_id",
        "identity_group",
        "event_type",
        "shift_years",
    }
    missing_operations = required_operations.difference(operations.columns)
    if missing_operations:
        raise RuntimeError(
            "operation packages miss columns: " + ", ".join(
                sorted(missing_operations)
            )
        )

    frame = attach_attempt_key(rows)
    frame = frame[frame["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    frame["shift_years"] = pd.to_numeric(
        frame["shift_years"], errors="coerce"
    ).fillna(0).astype(int)
    frame["bottom_identity_key"] = identity_key(frame)
    frame["year"] = pd.to_numeric(frame["year"], errors="coerce")

    reference_columns = [
        column for column in REFERENCE_STABILITY_COLUMNS if column in frame
    ]
    reference_stability = (
        frame[reference_columns].apply(pd.to_numeric, errors="coerce").median(
            axis=1, skipna=True
        )
        if reference_columns
        else pd.Series(np.nan, index=frame.index)
    )
    frame["_bottom_reference_stability_row"] = reference_stability
    cross_identity_evidence, cross_attempt_evidence = (
        _cross_operation_peak_evidence(frame)
    )
    tail_baseline_evidence = _tail_baseline_evidence(frame)

    baseline_sources: list[pd.DataFrame] = []
    attempt_parts: list[pd.DataFrame] = [
        cross_attempt_evidence,
        tail_baseline_evidence,
    ]
    if "baseline_lag" in frame:
        identity_baseline = frame.groupby(
            ["attempt_key", "bottom_identity_key"], sort=False, as_index=False
        )["baseline_lag"].median()
        context_baseline = _mode_summary(
            identity_baseline,
            ["attempt_key"],
            "baseline_lag",
            "bottom_context_baseline",
        )
        attempt_parts.append(context_baseline)
        baseline_sources.append(
            context_baseline[[
                "attempt_key", "bottom_context_baseline_mode"
            ]].rename(columns={"bottom_context_baseline_mode": "_baseline"})
        )

    primary_baseline = pd.DataFrame(columns=[
        "attempt_key",
        "bottom_primary_baseline_mode",
        "bottom_primary_baseline_support",
    ])
    if "rawTransition_newerLag" in frame:
        raw_baseline = _mode_summary(
            frame,
            ["attempt_key"],
            "rawTransition_newerLag",
            "bottom_raw_all_baseline",
        )
        attempt_parts.append(raw_baseline)
        baseline_sources.append(
            raw_baseline[[
                "attempt_key", "bottom_raw_all_baseline_mode"
            ]].rename(columns={"bottom_raw_all_baseline_mode": "_baseline"})
        )
        primary_baseline = raw_baseline.rename(columns={
            "bottom_raw_all_baseline_mode": "bottom_primary_baseline_mode",
            "bottom_raw_all_baseline_support": "bottom_primary_baseline_support",
            "bottom_raw_all_baseline_state_count": (
                "bottom_primary_baseline_state_count"
            ),
            "bottom_raw_all_baseline_entropy": "bottom_primary_baseline_entropy",
        })
        attempt_parts.append(primary_baseline)

        strong_column = "identity_rawTransition_normalizedSplitGain_percentile"
        if strong_column in frame:
            strong_rows = frame.loc[
                pd.to_numeric(frame[strong_column], errors="coerce").ge(0.9)
            ]
            raw_strong_baseline = _mode_summary(
                strong_rows,
                ["attempt_key"],
                "rawTransition_newerLag",
                "bottom_raw_strong_baseline",
            )
            attempt_parts.append(raw_strong_baseline)
            baseline_sources.append(
                raw_strong_baseline[[
                    "attempt_key", "bottom_raw_strong_baseline_mode"
                ]].rename(
                    columns={"bottom_raw_strong_baseline_mode": "_baseline"}
                )
            )

        partial_rows = frame.loc[frame["event_type"].eq("partialMove")]
        raw_partial_baseline = _mode_summary(
            partial_rows,
            ["attempt_key"],
            "rawTransition_newerLag",
            "bottom_raw_partial_baseline",
        )
        attempt_parts.append(raw_partial_baseline)
        baseline_sources.append(
            raw_partial_baseline[[
                "attempt_key", "bottom_raw_partial_baseline_mode"
            ]].rename(
                columns={"bottom_raw_partial_baseline_mode": "_baseline"}
            )
        )

    channel_scores: dict[str, pd.Series] = {}
    for channel, older_column, newer_column, score_columns in TRANSITION_CHANNELS:
        available_scores = [column for column in score_columns if column in frame]
        if older_column not in frame or newer_column not in frame or not available_scores:
            continue
        strength = frame[available_scores].apply(
            pd.to_numeric, errors="coerce"
        ).median(axis=1, skipna=True)
        channel_scores[channel] = strength
        rank_source = pd.DataFrame({
            "bottom_identity_key": frame["bottom_identity_key"],
            "_strength": strength.fillna(-np.inf),
        })
        best_index = rank_source.groupby(
            "bottom_identity_key", sort=False
        )["_strength"].idxmax()
        best = frame.loc[
            best_index, [
                "attempt_key",
                "event_type",
                "bottom_identity_key",
                newer_column,
            ]
        ].copy()
        event_mode = _mode_summary(
            best,
            ["attempt_key", "event_type"],
            newer_column,
            f"_bottom_{channel}_event_fixed",
        )
        fixed_mode_column = f"_bottom_{channel}_event_fixed_mode"
        channel_baseline = _mode_summary(
            event_mode,
            ["attempt_key"],
            fixed_mode_column,
            f"bottom_{channel}_fixed_baseline",
        )
        attempt_parts.append(channel_baseline)
        baseline_sources.append(
            channel_baseline[[
                "attempt_key", f"bottom_{channel}_fixed_baseline_mode"
            ]].rename(
                columns={
                    f"bottom_{channel}_fixed_baseline_mode": "_baseline"
                }
            )
        )

    if baseline_sources:
        baseline_votes = pd.concat(baseline_sources, ignore_index=True)
        consensus_baseline = _mode_summary(
            baseline_votes,
            ["attempt_key"],
            "_baseline",
            "bottom_consensus_baseline",
        )
        attempt_parts.append(consensus_baseline)
    else:
        consensus_baseline = pd.DataFrame(columns=[
            "attempt_key", "bottom_consensus_baseline_mode"
        ])

    attempt_evidence = pd.DataFrame({
        "attempt_key": frame["attempt_key"].drop_duplicates()
    })
    for part in attempt_parts:
        duplicate_columns = [
            column for column in part.columns
            if column != "attempt_key" and column in attempt_evidence
        ]
        if duplicate_columns:
            part = part.drop(columns=duplicate_columns)
        attempt_evidence = attempt_evidence.merge(
            part, on="attempt_key", how="left", validate="one_to_one"
        )

    frame = frame.merge(
        attempt_evidence[[
            "attempt_key",
            "bottom_consensus_baseline_mode",
            "bottom_primary_baseline_mode",
            "bottom_tail_consensus_baseline_mode",
        ]],
        on="attempt_key",
        how="left",
        validate="many_to_one",
    )
    reference_stability = pd.to_numeric(
        frame["_bottom_reference_stability_row"], errors="coerce"
    )

    identity_parts: list[pd.DataFrame] = [cross_identity_evidence]
    for family, columns in OPERATION_PROFILE_FAMILIES.items():
        available = [column for column in columns if column in frame]
        if not available:
            continue
        score = frame[available].apply(pd.to_numeric, errors="coerce").median(
            axis=1, skipna=True
        )
        identity_parts.append(
            _identity_score_summary(
                frame, score, f"bottom_operation_{family}_profile"
            )
        )

    channel_feature_names: dict[str, list[str]] = {
        "strength": [],
        "lag_match": [],
        "state_match": [],
        "joint_match": [],
        "reference": [],
    }
    shift = pd.to_numeric(frame["shift_years"], errors="coerce").fillna(0)
    baseline = pd.to_numeric(
        frame["bottom_tail_consensus_baseline_mode"], errors="coerce"
    ).combine_first(
        pd.to_numeric(frame["bottom_primary_baseline_mode"], errors="coerce")
    ).combine_first(
        pd.to_numeric(frame["bottom_consensus_baseline_mode"], errors="coerce")
    )
    for channel, older_column, newer_column, _ in TRANSITION_CHANNELS:
        if channel not in channel_scores:
            continue
        older = pd.to_numeric(frame[older_column], errors="coerce")
        newer = pd.to_numeric(frame[newer_column], errors="coerce")
        strength = channel_scores[channel].reindex(frame.index)
        lag_distance = older.sub(newer).sub(shift).abs()
        lag_match = lag_distance.add(1.0).rdiv(1.0)
        fixed_distance = newer.sub(baseline).abs()
        older_distance = older.sub(baseline.add(shift)).abs()
        state_match = fixed_distance.add(older_distance).add(1.0).rdiv(1.0)
        joint_match = lag_match.mul(state_match).mul(
            strength.clip(lower=0).fillna(0)
        )
        joint_match = joint_match.mul(
            reference_stability.clip(0, 1).fillna(0).mul(0.5).add(0.5)
        )
        channel_values = {
            "strength": strength,
            "lag_match": lag_match,
            "state_match": state_match,
            "joint_match": joint_match,
            "reference": reference_stability.where(lag_distance.le(0.25)),
        }
        for label, values in channel_values.items():
            prefix = f"bottom_operation_{channel}_{label}"
            identity_parts.append(_identity_score_summary(frame, values, prefix))
            channel_feature_names[label].append(f"{prefix}_max")

        top_mask = strength.groupby(
            frame["bottom_identity_key"], sort=False
        ).rank(pct=True, method="average").ge(0.9)
        exact = lag_distance.le(0.25).where(top_mask)
        exact_summary = pd.DataFrame({
            "bottom_identity_key": frame["bottom_identity_key"],
            f"bottom_operation_{channel}_top_exact": exact,
        }).groupby("bottom_identity_key", sort=False, as_index=False).mean()
        identity_parts.append(exact_summary)

    identity_evidence = frame[[
        "bottom_identity_key", "attempt_key", "event_type", "shift_years"
    ]].drop_duplicates("bottom_identity_key")
    for part in identity_parts:
        duplicate_columns = [
            column for column in part.columns
            if column != "bottom_identity_key" and column in identity_evidence
        ]
        if duplicate_columns:
            part = part.drop(columns=duplicate_columns)
        identity_evidence = identity_evidence.merge(
            part,
            on="bottom_identity_key",
            how="left",
            validate="one_to_one",
        )

    for label, columns in channel_feature_names.items():
        available = [column for column in columns if column in identity_evidence]
        if not available:
            continue
        values = identity_evidence[available].apply(pd.to_numeric, errors="coerce")
        identity_evidence[f"bottom_operation_{label}_consensus"] = values.median(
            axis=1, skipna=True
        )
        identity_evidence[f"bottom_operation_{label}_channel_agreement"] = (
            1.0 - values.std(axis=1, skipna=True)
        ).clip(0, 1)

    package_keys = attach_attempt_key(operations)
    package_keys["shift_years"] = pd.to_numeric(
        package_keys["shift_years"], errors="coerce"
    ).fillna(0).astype(int)
    package_keys["bottom_identity_key"] = identity_key(package_keys)
    output = package_keys[[
        "identity_group",
        "attempt_key",
        "event_type",
        "shift_years",
        "bottom_identity_key",
    ]].merge(
        attempt_evidence,
        on="attempt_key",
        how="left",
        validate="many_to_one",
    ).merge(
        identity_evidence.drop(columns=[
            "attempt_key", "event_type", "shift_years"
        ]),
        on="bottom_identity_key",
        how="left",
        validate="many_to_one",
    )

    candidate_shift = pd.to_numeric(output["shift_years"], errors="coerce")
    baseline_mode = pd.to_numeric(
        output.get("bottom_consensus_baseline_mode"), errors="coerce"
    )
    baseline_distance = candidate_shift.sub(baseline_mode).abs()
    output["bottom_candidate_baseline_distance"] = baseline_distance
    output["bottom_candidate_baseline_match"] = baseline_distance.add(1.0).rdiv(1.0)
    output["bottom_baseline_zero_distance"] = baseline_mode.abs()
    output["bottom_baseline_nonzero_strength"] = baseline_mode.abs().div(
        baseline_mode.abs().add(1.0)
    ).mul(
        pd.to_numeric(
            output.get("bottom_consensus_baseline_support"), errors="coerce"
        ).fillna(0)
    )
    primary_baseline_mode = pd.to_numeric(
        output.get("bottom_primary_baseline_mode"), errors="coerce"
    )
    primary_distance = candidate_shift.sub(primary_baseline_mode).abs()
    output["bottom_candidate_primary_baseline_distance"] = primary_distance
    output["bottom_candidate_primary_baseline_match"] = primary_distance.add(
        1.0
    ).rdiv(1.0)
    primary_support = pd.to_numeric(
        output.get("bottom_primary_baseline_support"), errors="coerce"
    ).fillna(0)
    output["bottom_candidate_primary_baseline_weighted"] = output[
        "bottom_candidate_primary_baseline_match"
    ].mul(primary_support)
    output["bottom_candidate_primary_baseline_exact"] = primary_distance.le(
        0.25
    ).astype(np.float32)
    output["bottom_candidate_primary_baseline_near"] = primary_distance.le(
        1.0
    ).astype(np.float32)
    output["bottom_primary_baseline_zero_distance"] = primary_baseline_mode.abs()
    output["bottom_primary_baseline_nonzero_strength"] = (
        primary_baseline_mode.abs().div(primary_baseline_mode.abs().add(1.0)).mul(
            pd.to_numeric(
                output.get("bottom_primary_baseline_support"), errors="coerce"
            ).fillna(0)
        )
    )
    tail_baseline_mode = pd.to_numeric(
        output.get("bottom_tail_consensus_baseline_mode"), errors="coerce"
    )
    tail_distance = candidate_shift.sub(tail_baseline_mode).abs()
    tail_support = pd.to_numeric(
        output.get("bottom_tail_consensus_baseline_support"), errors="coerce"
    ).fillna(0)
    output["bottom_candidate_tail_baseline_distance"] = tail_distance
    output["bottom_candidate_tail_baseline_match"] = tail_distance.add(
        1.0
    ).rdiv(1.0)
    output["bottom_candidate_tail_baseline_weighted"] = output[
        "bottom_candidate_tail_baseline_match"
    ].mul(tail_support)
    output["bottom_candidate_tail_baseline_exact"] = tail_distance.le(
        0.25
    ).astype(np.float32)
    output["bottom_candidate_tail_baseline_near"] = tail_distance.le(
        1.0
    ).astype(np.float32)
    output["bottom_tail_baseline_zero_distance"] = tail_baseline_mode.abs()
    output["bottom_tail_baseline_nonzero_strength"] = (
        tail_baseline_mode.abs().div(tail_baseline_mode.abs().add(1.0)).mul(
            tail_support
        )
    )
    candidate_cross_peak = pd.to_numeric(
        output.get(
            "bottom_operation_cross_consensus_peak",
            pd.Series(np.nan, index=output.index),
        ),
        errors="coerce",
    )
    attempt_cross_peak = pd.to_numeric(
        output.get(
            "bottom_attempt_local_cross_peak",
            pd.Series(np.nan, index=output.index),
        ),
        errors="coerce",
    )
    output["bottom_candidate_cross_peak_deficit"] = attempt_cross_peak.sub(
        candidate_cross_peak
    )
    output["bottom_primary_baseline_local_margin"] = pd.to_numeric(
        output["bottom_candidate_primary_baseline_weighted"], errors="coerce"
    ).sub(attempt_cross_peak)
    output["bottom_tail_baseline_local_margin"] = pd.to_numeric(
        output["bottom_candidate_tail_baseline_weighted"], errors="coerce"
    ).sub(attempt_cross_peak)
    local_strength = attempt_cross_peak.clip(0, 1).fillna(0)
    baseline_strength = pd.to_numeric(
        output["bottom_primary_baseline_nonzero_strength"], errors="coerce"
    ).clip(0, 1).fillna(0)
    output["bottom_attempt_quietness"] = (
        1.0 - pd.concat([local_strength, baseline_strength], axis=1).max(axis=1)
    ).clip(0, 1)

    relative_sources = [
        column for column in OPERATION_RELATIVE_SOURCES if column in output
    ]
    groups = output["attempt_key"]
    for column in relative_sources:
        values = pd.to_numeric(output[column], errors="coerce")
        mean = values.groupby(groups, sort=False).transform("mean")
        deviation = values.groupby(groups, sort=False).transform("std")
        output[f"{column}_attempt_rank"] = values.groupby(
            groups, sort=False
        ).rank(pct=True, method="average")
        output[f"{column}_attempt_z"] = values.sub(mean).div(
            deviation.replace(0, np.nan)
        )
        maximum = values.groupby(groups, sort=False).transform("max")
        output[f"{column}_attempt_deficit"] = maximum.sub(values)

    output = output.drop(columns=[
        "attempt_key", "event_type", "shift_years", "bottom_identity_key"
    ])
    return output.replace([np.inf, -np.inf], np.nan)


def forbidden_bottom_feature_columns(frame: pd.DataFrame) -> list[str]:
    forbidden_tokens = (
        "truth",
        "correct",
        "family",
        "file_id",
        "series_id",
        "target_id",
        "case_id",
    )
    return [
        column
        for column in frame.columns
        if column.startswith("bottom_")
        and (
            any(token in column.lower() for token in forbidden_tokens)
            or column.lower().endswith(("_year", "_years"))
        )
    ]


def select_operation_core_bottom_evidence(frame: pd.DataFrame) -> pd.DataFrame:
    """Keep the compact, physically interpretable operation evidence view."""

    if "identity_group" not in frame:
        raise RuntimeError("operation core evidence misses identity_group")
    available = [column for column in OPERATION_CORE_FEATURES if column in frame]
    if not available:
        raise RuntimeError("operation core evidence has no usable feature columns")
    return frame[["identity_group", *available]].copy()
