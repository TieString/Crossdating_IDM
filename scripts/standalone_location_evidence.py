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
