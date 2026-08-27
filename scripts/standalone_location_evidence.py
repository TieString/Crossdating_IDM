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
