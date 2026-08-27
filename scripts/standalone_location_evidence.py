#!/usr/bin/env python3
"""Truth-blind relative evidence features for standalone event locations."""

from __future__ import annotations

import numpy as np
import pandas as pd


EVIDENCE_FAMILIES = {
    "counterfactual": (
        "rawGain_",
        "differenceGain_",
        "combinedGain_",
        "sideMinimumAdvantage_",
        "sideStepScore_",
        "correctedSideSupport_",
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

IDENTITY_COLUMNS = ["attempt_id", "event_type", "shift_years"]


def append_local_year_shape_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Append truth-blind boundary shape features to the full yearly table.

    Correlation-derived evidence is often a broad plateau.  The absolute peak is
    therefore a weak discriminator between adjacent years, while the local shape
    around a physical boundary remains informative.  We first balance channels
    within their physical evidence families, then compare every year with its
    immediate older/newer neighbours inside the same operation identity.
    """

    columns = physical_percentile_columns(frame)
    required = [*IDENTITY_COLUMNS, "year"]
    if not columns or not all(column in frame for column in required):
        return frame

    ordered = frame[required].copy()
    family_columns: list[str] = []
    for family, prefixes in EVIDENCE_FAMILIES.items():
        selected = [
            column
            for column in columns
            if any(
                column.removeprefix("identity_").startswith(prefix)
                for prefix in prefixes
            )
        ]
        if not selected:
            continue
        column = f"shape_{family}_family_score"
        ordered[column] = frame[selected].mean(axis=1, skipna=True).astype(
            np.float32
        )
        family_columns.append(column)

    if not family_columns:
        return frame

    ordered = ordered.sort_values(IDENTITY_COLUMNS + ["year"])
    grouped = ordered.groupby(IDENTITY_COLUMNS, sort=False)
    shape_columns: list[str] = []
    for column in family_columns:
        family = column.removeprefix("shape_").removesuffix("_family_score")
        neighbours: dict[int, pd.Series] = {}
        for offset in (-3, -2, -1, 1, 2, 3):
            neighbours[offset] = grouped[column].shift(-offset)
        older = pd.concat(
            [neighbours[-2], neighbours[-1]], axis=1
        ).mean(axis=1, skipna=True)
        newer = pd.concat(
            [neighbours[1], neighbours[2]], axis=1
        ).mean(axis=1, skipna=True)
        local = pd.concat(list(neighbours.values()), axis=1)
        prefix = f"shape_{family}"
        ordered[f"{prefix}_older_advantage"] = ordered[column] - older
        ordered[f"{prefix}_newer_advantage"] = ordered[column] - newer
        ordered[f"{prefix}_minimum_side_advantage"] = np.minimum(
            ordered[f"{prefix}_older_advantage"],
            ordered[f"{prefix}_newer_advantage"],
        )
        ordered[f"{prefix}_centered_advantage_3"] = (
            ordered[column] - local.mean(axis=1, skipna=True)
        )
        ordered[f"{prefix}_local_peak_margin_3"] = (
            ordered[column] - local.max(axis=1, skipna=True)
        )
        ordered[f"{prefix}_side_asymmetry"] = older - newer
        shape_columns.extend([
            f"{prefix}_older_advantage",
            f"{prefix}_newer_advantage",
            f"{prefix}_minimum_side_advantage",
            f"{prefix}_centered_advantage_3",
            f"{prefix}_local_peak_margin_3",
            f"{prefix}_side_asymmetry",
        ])

    values = ordered[shape_columns].to_numpy(dtype=np.float32)
    finite = np.isfinite(values)
    denominator = np.maximum(1, finite.sum(axis=1))
    ordered["shape_consensus_positive_fraction"] = (
        ((values > 0) & finite).sum(axis=1) / denominator
    ).astype(np.float32)
    peak_columns = [
        column for column in shape_columns if column.endswith("local_peak_margin_3")
    ]
    ordered["shape_consensus_peak_fraction"] = (
        ordered[peak_columns].gt(0).sum(axis=1) / max(1, len(peak_columns))
    ).astype(np.float32)
    ordered["shape_consensus_score"] = ordered[[
        column
        for column in shape_columns
        if column.endswith("centered_advantage_3")
    ]].median(axis=1, skipna=True).astype(np.float32)

    appended = ordered.sort_index()[
        family_columns
        + shape_columns
        + [
            "shape_consensus_positive_fraction",
            "shape_consensus_peak_fraction",
            "shape_consensus_score",
        ]
    ]
    return pd.concat([frame, appended], axis=1)


def is_candidate_relative_evidence(column: str) -> bool:
    """Return whether an evidence feature may vary by year within an identity."""

    if not column.startswith("evidence_"):
        return False
    if not column.startswith("evidence_identity_"):
        return True
    return (
        "evidence_identity_operation_" not in column
        and column.endswith(("_percentile", "_deficit"))
    )


def candidate_percentile_columns(frame: pd.DataFrame) -> list[str]:
    return [
        column
        for column in frame.columns
        if column.startswith("evidence_identity_")
        and "evidence_identity_operation_" not in column
        and column.endswith("_percentile")
        and pd.api.types.is_numeric_dtype(frame[column])
    ]


def physical_percentile_columns(frame: pd.DataFrame) -> list[str]:
    """Return full-year physical channels before package feature prefixing."""

    return [
        column
        for column in frame.columns
        if column.startswith("identity_")
        and not column.startswith("identity_operation_")
        and column.endswith("_percentile")
        and pd.api.types.is_numeric_dtype(frame[column])
    ]


def append_physical_year_posterior(frame: pd.DataFrame) -> pd.DataFrame:
    """Build a balanced posterior from independent full-year evidence families.

    Individual correlation-derived channels are highly redundant.  Averaging all
    of them would let a large family overwhelm the reference or boundary heads.
    This function first combines channels within each physical family, converts
    each family to a within-identity percentile, and only then takes a robust
    cross-family consensus.  All inputs are available at inference time.
    """

    columns = physical_percentile_columns(frame)
    if not columns or not all(column in frame for column in IDENTITY_COLUMNS):
        return frame

    output = pd.DataFrame(index=frame.index)
    family_percentiles: list[str] = []
    for family, prefixes in EVIDENCE_FAMILIES.items():
        selected = [
            column
            for column in columns
            if any(
                column.removeprefix("identity_").startswith(prefix)
                for prefix in prefixes
            )
        ]
        if not selected:
            continue
        family_score = frame[selected].mean(axis=1, skipna=True)
        score_column = f"physical_{family}_score"
        percentile_column = f"physical_{family}_percentile"
        output[score_column] = family_score.astype(np.float32)
        output[percentile_column] = family_score.groupby(
            [frame[column] for column in IDENTITY_COLUMNS], sort=False
        ).rank(pct=True)
        family_percentiles.append(percentile_column)

    if not family_percentiles:
        return frame
    family_values = output[family_percentiles].to_numpy(dtype=np.float32)
    output["physical_consensus_score"] = np.nanmedian(
        family_values, axis=1
    ).astype(np.float32)
    output["physical_consensus_family_count"] = np.isfinite(
        family_values
    ).sum(axis=1).astype(np.float32)
    denominator = np.maximum(1, output["physical_consensus_family_count"])
    for threshold in (0.75, 0.9):
        suffix = str(threshold).replace(".", "")
        output[f"physical_consensus_support_{suffix}"] = (
            np.sum(family_values >= threshold, axis=1) / denominator
        ).astype(np.float32)

    ordered = pd.concat([
        frame[IDENTITY_COLUMNS + ["year"]], output
    ], axis=1).sort_values(IDENTITY_COLUMNS + ["year"])
    ordered["physical_consensus_smoothed13"] = ordered.groupby(
        IDENTITY_COLUMNS, sort=False
    )["physical_consensus_score"].transform(
        lambda values: values.rolling(3, center=True, min_periods=1).mean()
    )
    ordered["physical_consensus_sharpness"] = (
        ordered["physical_consensus_score"]
        - ordered["physical_consensus_smoothed13"]
    )
    output = ordered.sort_index()[output.columns.tolist() + [
        "physical_consensus_smoothed13",
        "physical_consensus_sharpness",
    ]]
    return pd.concat([frame, output], axis=1)


def append_frontier_competition_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Describe stronger older/newer modes without selecting one by rule."""

    score_columns = candidate_percentile_columns(frame)
    score_columns.extend([
        column
        for column in (
            "evidence_enriched_location_score",
            "evidence_location_classifier_blend",
        )
        if column in frame.columns
    ])
    score_columns = list(dict.fromkeys(score_columns))
    required = [*IDENTITY_COLUMNS, "candidate_year"]
    if not score_columns or not all(column in frame for column in required):
        return frame

    feature_names = [
        f"geometry_{side}_{statistic}"
        for side in ("newer", "older")
        for statistic in (
            "mode_count",
            "stronger_channel_fraction",
            "median_evidence_advantage",
            "maximum_evidence_advantage",
            "nearest_stronger_mode_distance",
        )
    ]
    output = pd.DataFrame(
        np.nan,
        index=frame.index,
        columns=feature_names,
        dtype=float,
    )
    years = pd.to_numeric(frame["candidate_year"], errors="coerce")
    scores = frame[score_columns].apply(pd.to_numeric, errors="coerce")

    for _, group in frame.groupby(IDENTITY_COLUMNS, sort=False):
        valid_indices = group.index[years.loc[group.index].notna()]
        if len(valid_indices) < 2:
            continue
        group_years = years.loc[valid_indices].to_numpy(dtype=float)
        group_scores = scores.loc[valid_indices].to_numpy(dtype=float)
        for position, index in enumerate(valid_indices):
            current_year = group_years[position]
            current_scores = group_scores[position]
            for side, side_mask in (
                ("newer", group_years > current_year + 6),
                ("older", group_years < current_year - 6),
            ):
                side_years = group_years[side_mask]
                output.loc[index, f"geometry_{side}_mode_count"] = len(
                    np.unique(side_years)
                )
                if side_years.size == 0:
                    continue
                with np.errstate(all="ignore"):
                    side_maximum = np.nanmax(group_scores[side_mask], axis=0)
                finite = np.isfinite(current_scores) & np.isfinite(side_maximum)
                if not finite.any():
                    continue
                advantage = side_maximum[finite] - current_scores[finite]
                output.loc[
                    index, f"geometry_{side}_stronger_channel_fraction"
                ] = np.mean(advantage > 0)
                output.loc[
                    index, f"geometry_{side}_median_evidence_advantage"
                ] = np.median(advantage)
                output.loc[
                    index, f"geometry_{side}_maximum_evidence_advantage"
                ] = np.max(advantage)
                side_rows = group_scores[side_mask][:, finite]
                stronger_rows = np.any(
                    side_rows > current_scores[finite], axis=1
                )
                if stronger_rows.any():
                    distances = np.abs(side_years[stronger_rows] - current_year)
                    output.loc[
                        index, f"geometry_{side}_nearest_stronger_mode_distance"
                    ] = np.min(distances)

    output["geometry_frontier_support_balance"] = (
        output["geometry_older_stronger_channel_fraction"]
        - output["geometry_newer_stronger_channel_fraction"]
    )
    return pd.concat([frame, output], axis=1)


def append_year_evidence_consensus(frame: pd.DataFrame) -> pd.DataFrame:
    """Append compact agreement features across independent yearly channels."""

    columns = candidate_percentile_columns(frame)
    if not columns:
        return frame

    output: dict[str, np.ndarray] = {}

    def append_statistics(name: str, selected: list[str]) -> None:
        if not selected:
            return
        values = frame[selected].to_numpy(dtype=np.float32, copy=True)
        finite = np.isfinite(values)
        counts = finite.sum(axis=1)
        safe = np.where(finite, values, np.nan)
        valid_rows = counts > 0
        output[f"evidence_consensus_{name}_count"] = counts.astype(np.float32)
        for statistic in (
            "mean", "median", "maximum", "minimum", "standard_deviation"
        ):
            output[f"evidence_consensus_{name}_{statistic}"] = np.full(
                len(frame), np.nan, dtype=np.float32
            )
        if valid_rows.any():
            valid = safe[valid_rows]
            output[f"evidence_consensus_{name}_mean"][valid_rows] = np.nanmean(
                valid, axis=1
            )
            output[f"evidence_consensus_{name}_median"][valid_rows] = np.nanmedian(
                valid, axis=1
            )
            output[f"evidence_consensus_{name}_maximum"][valid_rows] = np.nanmax(
                valid, axis=1
            )
            output[f"evidence_consensus_{name}_minimum"][valid_rows] = np.nanmin(
                valid, axis=1
            )
            output[f"evidence_consensus_{name}_standard_deviation"][valid_rows] = (
                np.nanstd(valid, axis=1)
            )
        denominator = np.maximum(1, counts)
        for threshold in (0.5, 0.75, 0.9):
            suffix = str(threshold).replace(".", "")
            output[f"evidence_consensus_{name}_above_{suffix}_fraction"] = (
                ((safe >= threshold) & finite).sum(axis=1) / denominator
            ).astype(np.float32)

    append_statistics("all", columns)
    for family, prefixes in EVIDENCE_FAMILIES.items():
        selected = [
            column
            for column in columns
            if any(
                column.removeprefix("evidence_identity_").startswith(prefix)
                for prefix in prefixes
            )
        ]
        append_statistics(family, selected)

    consensus = pd.DataFrame(output, index=frame.index).replace(
        [np.inf, -np.inf], np.nan
    )
    return pd.concat([frame, consensus], axis=1)
