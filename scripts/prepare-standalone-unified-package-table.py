#!/usr/bin/env python3
"""Build immutable standalone package candidates from truth-blind runtime evidence."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
ROW_LABEL_COLUMNS = {
    "attempt_id",
    "identity_key",
    "file_id",
    "family",
    "product_correct",
    "product_strict_correct",
    "truth_year",
    "operation_correct",
    "strict_operation_correct",
    "window_correct",
    "strict_correct",
    "top_exact",
}
IDENTITY_LABEL_COLUMNS = {
    "identity_key",
    "attempt_id",
    "file_id",
    "family",
    "event_type",
    "shift_years",
    "operation_correct",
    "strict_operation_correct",
    "product_correct",
    "product_strict_correct",
}
NUMERIC_NOTE = re.compile(
    r"^([A-Za-z][A-Za-z0-9_]*)=(-?(?:\d+(?:\.\d*)?|\.\d+))(?:$|[,;])"
)

ANCHOR_FAMILY_KEYWORDS = {
    "all": (),
    "path": ("path", "transition", "boundary", "staircase", "joint"),
    "frontier": ("frontier", "head", "preferred", "selected"),
    "reference": ("reference", "paired", "vote", "consensus"),
    "profile": ("profile", "scan", "local", "window", "neighbor"),
    "partial": ("partial", "fixed", "moved", "gap"),
    "unit": ("unit", "missing", "sequential"),
    "false": ("false",),
    "endpoint": ("endpoint", "terminal"),
}

# Independent year-wise evidence heads.  Each contributes only its strongest
# physical mode; the downstream location head still chooses one shared window.
PROJECTION_SCORE_COLUMNS = (
    "identity_rawTransition_normalizedSplitGain_percentile",
    "identity_cofechaTransition_normalizedSplitGain_percentile",
    "identity_cumulative_combinedCusum_percentile",
    "identity_cumulative_referenceMedianCusum_percentile",
    "identity_cumulative_referenceVoteCusum_percentile",
    "identity_piecewise_combinedGain_percentile",
    "identity_referenceChange_positiveGainFraction_percentile",
    "identity_referenceTransition_weightedWindowVote25_percentile",
    "identity_perReference_differenceGainWeighted_percentile",
    "identity_localSideStepScore21_percentile",
    "identity_localSideStepScore31_percentile",
)


def boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return False
    return str(value).strip().lower() in {"1", "true", "yes"}


def event_json(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else None


def runtime_event_features(event: dict[str, Any] | None) -> dict[str, Any]:
    if event is None:
        return {
            "runtime_score": np.nan,
            "runtime_score_margin": np.nan,
            "runtime_confidence": "none",
            "runtime_window_width": 0,
            "runtime_source_count": 0,
            "runtime_note_count": 0,
            "runtime_review_only": 0,
        }
    start = event.get("startYear")
    end = event.get("endYear")
    features: dict[str, Any] = {
        "runtime_score": event.get("score"),
        "runtime_score_margin": event.get("scoreMargin"),
        "runtime_confidence": str(event.get("confidence") or "none"),
        "runtime_window_width": (
            int(end) - int(start) + 1
            if isinstance(start, (int, float)) and isinstance(end, (int, float))
            else 0
        ),
        "runtime_source_count": len(event.get("sources") or []),
        "runtime_note_count": len(event.get("notes") or []),
        "runtime_review_only": int(boolean(event.get("reviewOnly"))),
    }
    for source in event.get("sources") or []:
        features[f"runtime_source__{source}"] = 1
    for note in event.get("notes") or []:
        match = NUMERIC_NOTE.match(str(note))
        if match:
            features[f"runtime_note__{match.group(1)}"] = float(match.group(2))
    return features


def location_training_labels(
    *,
    year: int | None,
    truth_year: int | None,
    location_correct: bool,
    workflow_correct: bool,
    bundle_alternative: dict[str, Any] | None,
) -> tuple[int, float]:
    """Create graded labels without exposing truth to inference features."""

    if not workflow_correct:
        return (0, np.nan)
    candidate_years = [year] if year is not None else []
    if bundle_alternative is not None:
        alternative_top = bundle_alternative.get("topYear")
        if isinstance(alternative_top, (int, float)):
            candidate_years.append(int(alternative_top))
    if truth_year is None or not candidate_years:
        return (int(location_correct), np.nan)
    error = min(abs(candidate - truth_year) for candidate in candidate_years)
    if error <= 1:
        relevance = 3
    elif error <= 3:
        relevance = 2
    elif error <= 6 or location_correct:
        relevance = 1
    else:
        relevance = 0
    return relevance, float(error)


def select_location_modes(
    rows: pd.DataFrame,
    score_columns: list[str],
    modes_per_score: int,
    minimum_distance: int,
) -> pd.DataFrame:
    selected: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    group_columns = ["attempt_id", "event_type", "shift_years"]
    for score_column in score_columns:
        for _, group in rows.groupby(group_columns, sort=False):
            years: list[int] = []
            rank = 0
            for index, row in group.sort_values(score_column, ascending=False).iterrows():
                year = int(row["year"])
                if any(abs(year - selected_year) < minimum_distance for selected_year in years):
                    continue
                rank += 1
                key = (
                    str(row["attempt_id"]),
                    str(row["event_type"]),
                    int(row["shift_years"]),
                    year,
                )
                entry = selected.setdefault(key, {
                    "index": index,
                    "sources": [],
                    "best_rank": rank,
                })
                entry["sources"].append(score_column)
                entry["best_rank"] = min(int(entry["best_rank"]), rank)
                years.append(year)
                if rank >= modes_per_score:
                    break
    output = rows.loc[[entry["index"] for entry in selected.values()]].copy()
    metadata = {
        key: entry for key, entry in selected.items()
    }
    output["location_mode_sources"] = [
        "+".join(metadata[(
            str(row["attempt_id"]),
            str(row["event_type"]),
            int(row["shift_years"]),
            int(row["year"]),
        )]["sources"])
        for _, row in output.iterrows()
    ]
    output["location_mode_rank"] = [
        metadata[(
            str(row["attempt_id"]),
            str(row["event_type"]),
            int(row["shift_years"]),
            int(row["year"]),
        )]["best_rank"]
        for _, row in output.iterrows()
    ]
    return output


def select_projection_heads(
    rows: pd.DataFrame,
    score_columns: list[str],
) -> pd.DataFrame:
    """Project one peak per evidence head without repeatedly scanning each group."""

    group_columns = ["attempt_id", "event_type", "shift_years"]
    selected: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    for score_column in score_columns:
        valid = rows[pd.to_numeric(rows[score_column], errors="coerce").notna()]
        if valid.empty:
            continue
        indices = valid.groupby(group_columns, sort=False)[score_column].idxmax()
        for index in indices.to_numpy(dtype=int):
            row = rows.loc[index]
            key = (
                str(row["attempt_id"]),
                str(row["event_type"]),
                int(row["shift_years"]),
                int(row["year"]),
            )
            entry = selected.setdefault(key, {"index": index, "sources": []})
            entry["sources"].append(score_column)
    output = rows.loc[[entry["index"] for entry in selected.values()]].copy()
    output["location_mode_sources"] = [
        "+".join(entry["sources"]) for entry in selected.values()
    ]
    output["location_mode_rank"] = 1
    return output


def is_calendar_anchor(column: str) -> bool:
    return column.startswith("runtime_note__") and (
        column.endswith("_year")
        or column.endswith("_top_year")
        or column.endswith("_first_fixed_year")
        or column.endswith("_boundary_year")
    )


def append_location_geometry(table: pd.DataFrame) -> pd.DataFrame:
    """Describe candidate positions relative to truth-blind runtime anchors.

    Absolute calendar years are deliberately not exposed as model features.  The
    location head instead sees where each candidate sits among the generated modes
    and how closely independent runtime evidence anchors agree with that candidate.
    """

    geometry = pd.DataFrame(index=table.index)
    candidate_years = pd.to_numeric(table["candidate_year"], errors="coerce")
    identity_columns = ["attempt_id", "event_type", "shift_years"]

    for _, group in table.groupby(identity_columns, sort=False):
        valid = group[candidate_years.loc[group.index].notna()]
        if valid.empty:
            continue
        unique_years = np.array(
            sorted(candidate_years.loc[valid.index].astype(int).unique()),
            dtype=float,
        )
        year_to_rank = {int(year): rank for rank, year in enumerate(unique_years)}
        denominator = max(1, len(unique_years) - 1)
        for index in valid.index:
            year = int(candidate_years.loc[index])
            rank = year_to_rank[year]
            geometry.loc[index, "geometry_identity_mode_count"] = len(unique_years)
            geometry.loc[index, "geometry_rank_from_oldest"] = rank
            geometry.loc[index, "geometry_rank_from_newest"] = len(unique_years) - rank - 1
            geometry.loc[index, "geometry_relative_recency"] = rank / denominator
            geometry.loc[index, "geometry_distance_from_oldest"] = year - unique_years[0]
            geometry.loc[index, "geometry_distance_from_newest"] = unique_years[-1] - year
            if rank > 0:
                geometry.loc[index, "geometry_gap_to_older_mode"] = year - unique_years[rank - 1]
            if rank + 1 < len(unique_years):
                geometry.loc[index, "geometry_gap_to_newer_mode"] = unique_years[rank + 1] - year

    product_rows = table[table["candidate_source"].isin(
        ["productPrimary", "productAlternative"]
    )]
    for source in ("productPrimary", "productAlternative"):
        source_rows = product_rows[product_rows["candidate_source"].eq(source)]
        if source_rows.empty:
            continue
        source_year = source_rows.groupby("attempt_id", sort=False)[
            "candidate_year"
        ].first()
        anchor = table["attempt_id"].map(source_year)
        delta = candidate_years - pd.to_numeric(anchor, errors="coerce")
        prefix = f"geometry_{source}_top"
        geometry[f"{prefix}_signed_distance"] = delta.astype(np.float32)
        geometry[f"{prefix}_absolute_distance"] = delta.abs().astype(np.float32)

        source_type = source_rows.groupby("attempt_id", sort=False)["event_type"].first()
        source_shift = source_rows.groupby("attempt_id", sort=False)["shift_years"].first()
        geometry[f"{prefix}_same_identity"] = (
            table["event_type"].eq(table["attempt_id"].map(source_type))
            & table["shift_years"].eq(table["attempt_id"].map(source_shift))
        ).astype(np.int8)

    anchor_columns = [column for column in table.columns if is_calendar_anchor(column)]
    anchor_sources: dict[str, dict[str, dict[str, np.ndarray]]] = {}
    for source in ("productPrimary", "productAlternative"):
        source_rows = product_rows[product_rows["candidate_source"].eq(source)]
        by_attempt: dict[str, dict[str, np.ndarray]] = {}
        for _, row in source_rows.iterrows():
            attempt_anchors: dict[str, np.ndarray] = {}
            for family, keywords in ANCHOR_FAMILY_KEYWORDS.items():
                columns = [
                    column for column in anchor_columns
                    if not keywords
                    or any(keyword in column.lower() for keyword in keywords)
                ]
                values = pd.to_numeric(row[columns], errors="coerce").to_numpy(dtype=float)
                values = values[np.isfinite(values) & (values >= 500) & (values <= 3000)]
                if values.size:
                    attempt_anchors[family] = values
            by_attempt[str(row["attempt_id"])] = attempt_anchors
        anchor_sources[source] = by_attempt

    statistic_names = (
        "anchor_count",
        "unique_anchor_count",
        "exact_fraction",
        "within_1_fraction",
        "within_2_fraction",
        "within_4_fraction",
        "within_6_fraction",
        "within_13_fraction",
        "minimum_absolute_distance",
        "median_absolute_distance",
        "median_signed_distance",
        "older_anchor_fraction",
        "newer_anchor_fraction",
        "modal_year_fraction",
    )
    geometry_records: dict[str, np.ndarray] = {}
    source_families = [
        (source, family)
        for source in ("productPrimary", "productAlternative")
        for family in ANCHOR_FAMILY_KEYWORDS
    ]
    for source, family in source_families:
        prefix = f"geometry_{source}_{family}"
        for statistic in statistic_names:
            geometry_records[f"{prefix}_{statistic}"] = np.full(
                len(table), np.nan, dtype=np.float32
            )

    for position, (index, row) in enumerate(table.iterrows()):
        year_value = candidate_years.loc[index]
        if pd.isna(year_value):
            continue
        year = float(year_value)
        attempt_id = str(row["attempt_id"])
        for source, family in source_families:
            anchors = anchor_sources[source].get(attempt_id, {}).get(family)
            if anchors is None or anchors.size == 0:
                continue
            delta = year - anchors
            absolute = np.abs(delta)
            rounded, counts = np.unique(np.rint(anchors).astype(int), return_counts=True)
            values = (
                float(anchors.size),
                float(rounded.size),
                float(np.mean(absolute <= 0.5)),
                float(np.mean(absolute <= 1)),
                float(np.mean(absolute <= 2)),
                float(np.mean(absolute <= 4)),
                float(np.mean(absolute <= 6)),
                float(np.mean(absolute <= 13)),
                float(np.min(absolute)),
                float(np.median(absolute)),
                float(np.median(delta)),
                float(np.mean(delta > 0)),
                float(np.mean(delta < 0)),
                float(np.max(counts) / anchors.size),
            )
            prefix = f"geometry_{source}_{family}"
            for statistic, value in zip(statistic_names, values, strict=True):
                geometry_records[f"{prefix}_{statistic}"][position] = value

    if geometry_records:
        anchor_geometry = pd.DataFrame(geometry_records, index=table.index)
        geometry = pd.concat([geometry, anchor_geometry], axis=1)
    primary_rows = product_rows[
        product_rows["candidate_source"].eq("productPrimary")
    ].drop_duplicates("attempt_id").set_index("attempt_id")
    shared_scalar_columns = [
        column for column in table.columns
        if (
            column.startswith("runtime_note__")
            and not is_calendar_anchor(column)
            and "segment_start" not in column
            and "segment_end" not in column
            and not column.endswith("_center")
        )
        or column in {
            "runtime_score",
            "runtime_score_margin",
            "runtime_window_width",
            "runtime_source_count",
            "runtime_note_count",
        }
    ]
    if not primary_rows.empty and shared_scalar_columns:
        shared = primary_rows[shared_scalar_columns].reindex(
            table["attempt_id"]
        ).reset_index(drop=True)
        shared.index = table.index
        shared = shared.apply(pd.to_numeric, errors="coerce").astype(np.float32)
        shared.columns = [
            f"geometry_productPrimary_context__{column.removeprefix('runtime_note__')}"
            for column in shared.columns
        ]
        geometry = pd.concat([geometry, shared], axis=1)
    return pd.concat([table, geometry], axis=1)


def attach_equivalent_bundle(table: pd.DataFrame) -> pd.DataFrame:
    """Attach an equivalent interpretation only to the same immutable package."""

    output = table.copy()
    output["_bundle_identity"] = (
        output["attempt_id"].astype(str)
        + "|" + output["event_type"].astype(str)
        + "|" + output["shift_years"].astype(int).astype(str)
        + "|" + output["candidate_year"].fillna("none").astype(str)
    )
    primary = output[
        output["candidate_source"].eq("productPrimary")
        & output["bundle_has_alternative"].eq(1)
    ].drop_duplicates("_bundle_identity").set_index("_bundle_identity")
    if primary.empty:
        return output.drop(columns="_bundle_identity")
    matched = output["_bundle_identity"].isin(primary.index)
    bundle_columns = [column for column in output if column.startswith("bundle_")]
    for column in bundle_columns:
        output.loc[matched, column] = output.loc[
            matched, "_bundle_identity"
        ].map(primary[column]).to_numpy()
    for label in ("operation_correct", "location_correct", "workflow_correct"):
        inherited = output.loc[matched, "_bundle_identity"].map(
            primary[label]
        ).fillna(0).astype(int).to_numpy()
        output.loc[matched, label] = np.maximum(
            output.loc[matched, label].astype(int).to_numpy(), inherited
        )
    return output.drop(columns="_bundle_identity")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--enriched-rows", required=True)
    parser.add_argument("--hierarchical-scores", required=True)
    parser.add_argument("--classifier-scores", required=True)
    parser.add_argument("--operation-identities", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--modes-per-score", type=int, default=2)
    parser.add_argument("--minimum-mode-distance", type=int, default=7)
    parser.add_argument("--enable-evidence-projection", action="store_true")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    steps = pd.read_json(run_dir / "steps.json")
    rows = pd.read_pickle(Path(args.enriched_rows).resolve()).copy()
    hierarchical = pd.read_pickle(Path(args.hierarchical_scores).resolve())
    classifier = pd.read_pickle(Path(args.classifier_scores).resolve())
    identities = pd.read_csv(Path(args.operation_identities).resolve())
    row_keys = ["attempt_id", "event_type", "shift_years", "year"]
    hierarchical_columns = row_keys + ["enriched_location_score"]
    classifier_columns = row_keys + [
        "classifier_percentile",
        "typed_classifier_percentile",
    ]
    rows = rows.merge(
        hierarchical[hierarchical_columns],
        on=row_keys,
        how="left",
        validate="one_to_one",
    ).merge(
        classifier[classifier_columns],
        on=row_keys,
        how="left",
        validate="one_to_one",
    )
    rows["location_classifier_blend"] = (
        rows["classifier_percentile"] + rows["typed_classifier_percentile"]
    ) / 2
    identity_feature_columns = [
        column for column in identities.columns
        if column not in IDENTITY_LABEL_COLUMNS
    ]
    identity_features = identities[[
        "attempt_id",
        "event_type",
        "shift_years",
        *identity_feature_columns,
    ]].rename(columns={
        column: f"identity_{column}" for column in identity_feature_columns
    })
    rows = rows.merge(
        identity_features,
        on=["attempt_id", "event_type", "shift_years"],
        how="left",
        validate="many_to_one",
    )
    selected_modes = select_location_modes(
        rows,
        ["enriched_location_score", "location_classifier_blend"],
        max(1, args.modes_per_score),
        max(1, args.minimum_mode_distance),
    )
    projection_columns = [
        column for column in PROJECTION_SCORE_COLUMNS if column in rows.columns
    ]
    if projection_columns and args.enable_evidence_projection:
        projected_modes = select_projection_heads(rows, projection_columns)
        selected_modes = pd.concat(
            [selected_modes, projected_modes], ignore_index=False, sort=False
        ).sort_values("location_mode_rank").drop_duplicates(
            ["attempt_id", "event_type", "shift_years", "year"], keep="first"
        )
    row_feature_columns = [
        column for column in selected_modes.columns
        if column not in ROW_LABEL_COLUMNS
        and column not in {"event_type", "shift_years", "year"}
    ]
    row_groups = {
        key: group
        for key, group in rows.groupby(
            ["attempt_id", "event_type", "shift_years"], sort=False
        )
    }
    selected_modes_by_attempt = {
        attempt_id: group
        for attempt_id, group in selected_modes.groupby("attempt_id", sort=False)
    }

    step_by_attempt = {
        f"evaluation:{int(step['caseIndex'])}:{int(step['step'])}": step
        for _, step in steps.iterrows()
    }
    records: list[dict[str, Any]] = []

    def append_candidate(
        *,
        step: pd.Series,
        attempt_id: str,
        source: str,
        event_type: str,
        shift_years: int,
        year: int | None,
        truth_year: int | None,
        operation_correct: bool,
        location_correct: bool,
        workflow_correct: bool,
        strict_correct: bool,
        evidence: pd.Series | None,
        runtime_event: dict[str, Any] | None,
        bundle_alternative: dict[str, Any] | None = None,
    ) -> None:
        location_relevance, location_error_years = location_training_labels(
            year=year,
            truth_year=truth_year,
            location_correct=location_correct,
            workflow_correct=workflow_correct,
            bundle_alternative=bundle_alternative,
        )
        record: dict[str, Any] = {
            "attempt_id": f"{args.dataset_id}:{attempt_id}",
            "file_id": str(step["fileId"]),
            "family": str(step["family"]),
            "is_clean": int(str(step["family"]) == "Clean"),
            "candidate_source": source,
            "event_type": event_type,
            "shift_years": int(shift_years),
            "shift_abs": abs(int(shift_years)),
            "candidate_has_response": int(event_type != "noEvent"),
            "candidate_year_present": int(year is not None),
            "candidate_year": year,
            "operation_correct": int(operation_correct),
            "location_correct": int(location_correct),
            "location_relevance": location_relevance,
            "location_error_years": location_error_years,
            "workflow_correct": int(workflow_correct),
            "strict_correct": int(strict_correct),
            "context_cofecha_flagged": int(boolean(step.get("cofechaFlagged"))),
            "context_reference_mode": str(step.get("referenceMode") or "none"),
            "context_reference_anchor_count": float(
                step.get("referenceAnchorCount") or 0
            ),
            "bundle_has_alternative": int(bundle_alternative is not None),
        }
        if bundle_alternative is not None:
            alternative_type = str(
                bundle_alternative.get("eventType") or "noEvent"
            )
            alternative_shift = int(bundle_alternative.get("shiftYears") or 0)
            alternative_start = bundle_alternative.get("startYear")
            alternative_end = bundle_alternative.get("endYear")
            alternative_top = bundle_alternative.get("topYear")
            record.update({
                "bundle_alternative_shift_years": alternative_shift,
                "bundle_alternative_shift_abs": abs(alternative_shift),
                "bundle_alternative_changes_operation": int(
                    alternative_type != event_type
                    or alternative_shift != int(shift_years)
                ),
                "bundle_alternative_window_width": (
                    int(alternative_end) - int(alternative_start) + 1
                    if isinstance(alternative_start, (int, float))
                    and isinstance(alternative_end, (int, float))
                    else 0
                ),
                "bundle_alternative_top_signed_distance": (
                    int(alternative_top) - int(year)
                    if isinstance(alternative_top, (int, float))
                    and year is not None
                    else np.nan
                ),
            })
            record["bundle_alternative_top_absolute_distance"] = abs(
                record["bundle_alternative_top_signed_distance"]
            )
            record[f"bundle_alternative_event__{alternative_type}"] = 1
        record.update(runtime_event_features(runtime_event))
        for column in row_feature_columns:
            record[f"evidence_{column}"] = (
                evidence[column]
                if evidence is not None and column in evidence.index
                else np.nan
            )
        records.append(record)

    for attempt_id, step in step_by_attempt.items():
        family = str(step["family"])
        is_clean = family == "Clean"
        append_candidate(
            step=step,
            attempt_id=attempt_id,
            source="noEvent",
            event_type="noEvent",
            shift_years=0,
            year=None,
            truth_year=None,
            operation_correct=is_clean,
            location_correct=is_clean,
            workflow_correct=is_clean,
            strict_correct=is_clean,
            evidence=None,
            runtime_event=None,
        )

        alternative_bundle = event_json(step.get("alternative"))
        for source, event_column, operation_column, window_column in (
            ("productPrimary", "primary", "primaryOperationCorrect", "primaryWindowCovered"),
            (
                "productAlternative",
                "alternative",
                "alternativeOperationCorrect",
                "alternativeWindowCovered",
            ),
        ):
            event = event_json(step.get(event_column))
            if event is None:
                continue
            event_type = str(event.get("eventType") or "noEvent")
            shift_years = int(event.get("shiftYears") or 0)
            top_year = event.get("topYear")
            year = int(top_year) if isinstance(top_year, (int, float)) else None
            strict_operation_correct = boolean(step.get(operation_column))
            operation_correct = (
                boolean(step.get("workflowEquivalentOperationCorrect"))
                if source == "productPrimary"
                else strict_operation_correct
            )
            truth_year_value = step.get("diagnosedTruthYear")
            truth_year = (
                int(truth_year_value)
                if isinstance(truth_year_value, (int, float))
                and not pd.isna(truth_year_value)
                else None
            )
            start_year = event.get("startYear")
            end_year = event.get("endYear")
            window_correct = True
            if event_type in LOCAL_EVENT_TYPES:
                window_correct = (
                    truth_year is not None
                    and isinstance(start_year, (int, float))
                    and isinstance(end_year, (int, float))
                    and int(start_year) <= truth_year <= int(end_year)
                )
                if source == "productPrimary":
                    window_correct = boolean(
                        step.get("workflowEquivalentWindowCovered")
                    )
            group = row_groups.get((attempt_id, event_type, shift_years))
            evidence = None
            if group is not None and not group.empty:
                evidence = (
                    group.loc[(group["year"] - year).abs().idxmin()]
                    if year is not None
                    else group.sort_values(
                        "enriched_location_score", ascending=False
                    ).iloc[0]
                )
            append_candidate(
                step=step,
                attempt_id=attempt_id,
                source=source,
                event_type=event_type,
                shift_years=shift_years,
                year=year,
                truth_year=truth_year,
                operation_correct=operation_correct,
                location_correct=window_correct,
                workflow_correct=(
                    boolean(step.get("workflowSuggestionCorrect"))
                    if source == "productPrimary"
                    else operation_correct and window_correct
                ),
                strict_correct=strict_operation_correct and (
                    truth_year is None
                    or event_type not in LOCAL_EVENT_TYPES
                    or (
                        isinstance(start_year, (int, float))
                        and isinstance(end_year, (int, float))
                        and int(start_year) <= truth_year <= int(end_year)
                    )
                ),
                evidence=evidence,
                runtime_event=event,
                bundle_alternative=(
                    alternative_bundle if source == "productPrimary" else None
                ),
            )

        for _, proposal in selected_modes_by_attempt.get(
            attempt_id, pd.DataFrame()
        ).iterrows():
            append_candidate(
                step=step,
                attempt_id=attempt_id,
                source="enrichedProposal",
                event_type=str(proposal["event_type"]),
                shift_years=int(proposal["shift_years"]),
                year=int(proposal["year"]),
                truth_year=(
                    int(proposal["truth_year"])
                    if pd.notna(proposal["truth_year"])
                    else None
                ),
                operation_correct=boolean(proposal["operation_correct"]),
                location_correct=(
                    abs(int(proposal["year"]) - int(proposal["truth_year"])) <= 6
                    if pd.notna(proposal["truth_year"])
                    else False
                ),
                workflow_correct=boolean(proposal["window_correct"]),
                strict_correct=boolean(proposal["strict_correct"]),
                evidence=proposal,
                runtime_event=None,
            )

    table = append_location_geometry(attach_equivalent_bundle(pd.DataFrame(records)))
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    table.to_pickle(output)
    summary = {
        "schemaVersion": 1,
        "datasetId": args.dataset_id,
        "files": int(table["file_id"].nunique()),
        "attempts": int(table["attempt_id"].nunique()),
        "rows": len(table),
        "candidateOracleCorrect": int(
            table[table["family"] != "Clean"]
            .groupby("attempt_id")["workflow_correct"].max().sum()
        ),
        "eventAttempts": int(
            table[table["family"] != "Clean"]["attempt_id"].nunique()
        ),
        "cleanAttempts": int(
            table[table["family"] == "Clean"]["attempt_id"].nunique()
        ),
    }
    output.with_suffix(".summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(output), **summary}))


if __name__ == "__main__":
    main()
