#!/usr/bin/env python3
"""Shared helpers for the immutable two-stage diagnosis adjudicator.

The operation head selects an ``event_type + shift_years`` identity.  The
location head can then rank packages only inside that exact identity.  Raw
numeric evidence is never passed to a model directly: every value is projected
to an in-diagnosis percentile, z score, and winner margin first.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import lightgbm as lgb
import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = frozenset({"missingRing", "falseRing", "partialMove"})
IDENTITY_COLUMNS = ("attempt_id", "event_type", "shift_years")
FORBIDDEN_TOKENS = (
    "truth",
    "correct",
    "relevance",
    "error_year",
    "family",
    "file_id",
    "series_id",
    "target_id",
    "case_id",
)
METADATA_COLUMNS = frozenset({
    "identity_group",
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "candidate_year",
    "year",
})


@dataclass(frozen=True)
class FeatureSpec:
    numeric_columns: tuple[str, ...]
    categorical_columns: tuple[str, ...]
    categorical_levels: dict[str, tuple[str, ...]]
    group_column: str

    def to_json(self) -> dict:
        return {
            "numericColumns": list(self.numeric_columns),
            "categoricalColumns": list(self.categorical_columns),
            "categoricalLevels": {
                key: list(values)
                for key, values in self.categorical_levels.items()
            },
            "groupColumn": self.group_column,
        }


def sha256(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def identity_keys(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["attempt_id"].astype(str)
        + "|"
        + frame["event_type"].astype(str)
        + "|"
        + pd.to_numeric(frame["shift_years"], errors="coerce")
        .fillna(0)
        .astype(int)
        .astype(str)
    )


def ensure_identity_group(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    expected = identity_keys(output)
    if "identity_group" in output:
        existing = output["identity_group"].astype(str)
        if not existing.eq(expected).all():
            raise RuntimeError("candidate identity_group violates the immutable identity")
    output["identity_group"] = expected
    return output


def _safe_feature_name(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    if not normalized:
        raise ValueError("proposal anchor name must contain a letter or number")
    return normalized


def _categorical_feature_name(column: str, level: str) -> str:
    digest = hashlib.sha256(level.encode("utf-8")).hexdigest()[:10]
    return f"{_safe_feature_name(column)}__{_safe_feature_name(level)}__{digest}"


def add_location_proposal_anchors(
    frame: pd.DataFrame,
    anchors: dict[str, pd.DataFrame],
) -> tuple[pd.DataFrame, tuple[str, ...]]:
    """Attach truth-blind geometry from already-frozen location proposals.

    Proposal heads are treated as independent evidence channels.  They do not
    add packages: every output row retains the exact input candidate identity
    and year.  Absolute proposal years are immediately reduced to offsets from
    the candidate year and are never exposed to the model.
    """

    output = ensure_identity_group(frame).copy()
    candidate_year = pd.to_numeric(output["candidate_year"], errors="coerce")
    generated: list[str] = []
    matching_offsets: list[pd.Series] = []

    for raw_name, raw_anchor in anchors.items():
        name = _safe_feature_name(raw_name)
        required = {"attempt_id", "event_type", "shift_years"}
        missing = required.difference(raw_anchor.columns)
        if missing:
            raise RuntimeError(
                f"proposal anchor {raw_name!r} is missing columns {sorted(missing)}"
            )
        anchor = ensure_identity_group(raw_anchor)
        if anchor["attempt_id"].duplicated().any():
            raise RuntimeError(
                f"proposal anchor {raw_name!r} must contain one row per diagnosis"
            )
        year_column = (
            "selected_candidate_year"
            if "selected_candidate_year" in anchor
            else "candidate_year"
            if "candidate_year" in anchor
            else None
        )
        if year_column is None:
            raise RuntimeError(
                f"proposal anchor {raw_name!r} has no selected candidate year"
            )
        by_attempt = anchor.set_index("attempt_id")
        anchor_identity = output["attempt_id"].map(by_attempt["identity_group"])
        anchor_year = pd.to_numeric(
            output["attempt_id"].map(by_attempt[year_column]), errors="coerce"
        )
        identity_match = output["identity_group"].eq(anchor_identity)
        valid = identity_match & candidate_year.notna() & anchor_year.notna()
        signed_offset = candidate_year.sub(anchor_year).where(valid)
        distance = signed_offset.abs()
        matching_offsets.append(signed_offset)

        prefix = f"proposal_anchor_{name}"
        columns = {
            f"{prefix}_identity_match": identity_match.astype(np.float32),
            f"{prefix}_signed_offset": signed_offset.astype(np.float32),
            f"{prefix}_distance": distance.astype(np.float32),
            f"{prefix}_exact": distance.eq(0).where(valid, False).astype(np.float32),
            f"{prefix}_within_1": distance.le(1).where(valid, False).astype(np.float32),
            f"{prefix}_within_3": distance.le(3).where(valid, False).astype(np.float32),
            f"{prefix}_within_6": distance.le(6).where(valid, False).astype(np.float32),
        }
        for column, values in columns.items():
            output[column] = values
            generated.append(column)

    if matching_offsets:
        offset_frame = pd.concat(matching_offsets, axis=1)
        valid_count = offset_frame.notna().sum(axis=1)
        consensus = {
            "proposal_anchor_support_count": valid_count.astype(np.float32),
            "proposal_anchor_exact_count": offset_frame.eq(0).sum(axis=1).astype(np.float32),
            "proposal_anchor_within_1_count": offset_frame.abs().le(1).sum(axis=1).astype(np.float32),
            "proposal_anchor_within_3_count": offset_frame.abs().le(3).sum(axis=1).astype(np.float32),
            "proposal_anchor_within_6_count": offset_frame.abs().le(6).sum(axis=1).astype(np.float32),
            "proposal_anchor_median_signed_offset": offset_frame.median(axis=1).astype(np.float32),
            "proposal_anchor_median_distance": offset_frame.abs().median(axis=1).astype(np.float32),
            "proposal_anchor_max_distance": offset_frame.abs().max(axis=1).astype(np.float32),
        }
        for column, values in consensus.items():
            output[column] = values.where(valid_count.gt(0))
            generated.append(column)

    return output, tuple(generated)


def append_frozen_proposal_packages(
    frame: pd.DataFrame,
    proposals: pd.DataFrame,
) -> pd.DataFrame:
    """Restore already-generated proposal years as immutable location packages.

    The proposal generator is upstream and frozen.  This function only prevents
    its chosen year from being rounded to the nearest row in the dense evidence
    table.  Evidence is inherited from that nearest same-identity row, while the
    proposal's own truth-blind consensus fields remain available to adjudication.
    """

    base = ensure_identity_group(frame).copy()
    proposal = ensure_identity_group(proposals).copy()
    required = {
        "attempt_id",
        "identity_group",
        "event_type",
        "shift_years",
        "candidate_year",
        "proposal_role",
        "proposal_correct",
        "operation_correct",
    }
    missing = required.difference(proposal.columns)
    if missing:
        raise RuntimeError(f"frozen proposal table is missing {sorted(missing)}")
    duplicate_key = ["attempt_id", "identity_group", "proposal_role"]
    if proposal.duplicated(duplicate_key).any():
        raise RuntimeError("frozen proposal table contains duplicate proposal roles")
    proposal = proposal[
        proposal["event_type"].isin(LOCAL_EVENT_TYPES)
        & pd.to_numeric(proposal["candidate_year"], errors="coerce").notna()
    ].reset_index(drop=True)
    if proposal.empty:
        return base

    base_index = base[["identity_group", "candidate_year"]].reset_index(
        names="_base_index"
    )
    mapping = proposal[["identity_group", "candidate_year"]].reset_index(
        names="_proposal_index"
    ).merge(base_index, on="identity_group", how="left", suffixes=("_proposal", "_base"))
    if mapping["_base_index"].isna().any():
        missing_identities = mapping.loc[
            mapping["_base_index"].isna(), "identity_group"
        ].drop_duplicates()
        raise RuntimeError(
            "frozen proposal has no same-identity evidence package: "
            + ", ".join(missing_identities.head(3).astype(str))
        )
    mapping["_projection_distance"] = (
        pd.to_numeric(mapping["candidate_year_proposal"], errors="coerce")
        - pd.to_numeric(mapping["candidate_year_base"], errors="coerce")
    ).abs()
    nearest = (
        mapping.sort_values(
            ["_proposal_index", "_projection_distance", "_base_index"],
            kind="stable",
        )
        .drop_duplicates("_proposal_index")
        .sort_values("_proposal_index")
    )
    synthetic = base.loc[nearest["_base_index"].astype(int)].reset_index(drop=True)
    proposal = proposal.loc[nearest["_proposal_index"].astype(int)].reset_index(drop=True)

    # Only truth-blind proposal evidence is copied as model input.  Correctness
    # fields below are labels used by file-isolated training and evaluation.
    proposal_evidence = [
        column
        for column in proposal.columns
        if column.startswith("proposal_")
        and not any(token in column.lower() for token in ("correct", "truth"))
    ]
    for column in proposal_evidence:
        synthetic[column] = proposal[column].to_numpy()
    synthetic["proposal_role"] = proposal["proposal_role"].astype(str).to_numpy()
    synthetic["frozen_proposal_available"] = np.float32(1)
    synthetic["candidate_source"] = (
        "frozenProposal:" + proposal["proposal_role"].astype(str)
    ).to_numpy()
    synthetic["candidate_year"] = pd.to_numeric(
        proposal["candidate_year"], errors="raise"
    ).to_numpy()
    synthetic["identity_operation_correct"] = pd.to_numeric(
        proposal["operation_correct"], errors="coerce"
    ).fillna(0).astype(np.int8).to_numpy()
    proposal_correct = pd.to_numeric(
        proposal["proposal_correct"], errors="coerce"
    ).fillna(0).astype(np.int8)
    synthetic["workflow_correct"] = proposal_correct.to_numpy()
    synthetic["location_correct"] = proposal_correct.to_numpy()
    synthetic["location_relevance"] = proposal_correct.mul(3).to_numpy()

    base["proposal_role"] = "densePackage"
    base["frozen_proposal_available"] = np.float32(0)
    for column in proposal_evidence:
        if column not in base:
            base[column] = np.nan
    combined = pd.concat([base, synthetic], ignore_index=True, sort=False)
    if len(combined) != len(base) + len(proposal):
        raise RuntimeError("frozen proposal projection changed package cardinality")
    if not identity_keys(synthetic).eq(synthetic["identity_group"].astype(str)).all():
        raise RuntimeError("frozen proposal projection crossed operation identity")
    return combined


def _allowed_numeric(column: str) -> bool:
    lowered = column.lower()
    return (
        column not in METADATA_COLUMNS
        and not any(token in lowered for token in FORBIDDEN_TOKENS)
        and not lowered.endswith("_year")
        and not lowered.endswith("_years")
        and not lowered.startswith("runtime_note__")
    )


def select_numeric_columns(
    frame: pd.DataFrame,
    *,
    maximum: int,
    preferred: Iterable[str] = (),
) -> tuple[str, ...]:
    """Select evidence channels without consulting labels or dataset identity."""

    candidates = [
        column
        for column in frame.columns
        if _allowed_numeric(column)
        and pd.api.types.is_numeric_dtype(frame[column])
    ]
    preferred_set = {column for column in preferred if column in candidates}
    ranked: list[tuple[float, str]] = []
    for column in candidates:
        values = pd.to_numeric(frame[column], errors="coerce")
        coverage = float(values.notna().mean())
        unique = int(values.nunique(dropna=True))
        if coverage <= 0 or unique <= 1:
            continue
        finite = values[np.isfinite(values)]
        spread = float(finite.std()) if len(finite) > 1 else 0.0
        # This is deliberately label-free.  Coverage and variation only remove
        # dead/sparse duplicate channels from the very wide evidence table.
        quality = coverage * np.log2(unique + 1) * (1.0 + min(spread, 10.0))
        if column in preferred_set:
            quality += 1_000_000.0
        ranked.append((quality, column))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return tuple(column for _, column in ranked[:maximum])


def make_feature_spec(
    frame: pd.DataFrame,
    *,
    group_column: str,
    maximum_numeric: int,
    categorical_columns: Iterable[str],
    preferred_numeric: Iterable[str] = (),
) -> FeatureSpec:
    categorical = tuple(
        column for column in categorical_columns if column in frame.columns
    )
    levels = {
        column: tuple(sorted(frame[column].fillna("missing").astype(str).unique()))
        for column in categorical
    }
    return FeatureSpec(
        numeric_columns=select_numeric_columns(
            frame, maximum=maximum_numeric, preferred=preferred_numeric
        ),
        categorical_columns=categorical,
        categorical_levels=levels,
        group_column=group_column,
    )


def project_relative_features(
    frame: pd.DataFrame,
    spec: FeatureSpec,
) -> pd.DataFrame:
    """Project raw evidence to diagnosis-internal relative coordinates."""

    if spec.group_column not in frame:
        raise RuntimeError(f"missing feature group column {spec.group_column}")
    groups = frame.groupby(spec.group_column, sort=False)
    output: dict[str, pd.Series | np.ndarray] = {}
    for column in spec.numeric_columns:
        values = pd.to_numeric(
            frame[column]
            if column in frame
            else pd.Series(np.nan, index=frame.index),
            errors="coerce",
        )
        grouped_values = values.groupby(frame[spec.group_column], sort=False)
        mean = grouped_values.transform("mean")
        standard_deviation = grouped_values.transform("std").replace(0, np.nan)
        maximum = grouped_values.transform("max")
        output[f"{column}__rank"] = grouped_values.rank(
            pct=True, method="average"
        ).astype(np.float32)
        output[f"{column}__z"] = (
            (values - mean) / standard_deviation
        ).clip(-8, 8).astype(np.float32)
        output[f"{column}__winner_margin"] = (
            (values - maximum) / standard_deviation
        ).clip(-12, 0).astype(np.float32)
        output[f"{column}__missing"] = values.isna().astype(np.float32)

    for column in spec.categorical_columns:
        values = (
            frame[column]
            if column in frame
            else pd.Series("missing", index=frame.index)
        ).fillna("missing").astype(str)
        for level in spec.categorical_levels[column]:
            output[_categorical_feature_name(column, level)] = values.eq(level).astype(
                np.float32
            )

    # Identity geometry is not a score and is safe to expose directly.  Exact
    # years and file/series labels remain excluded.
    if "shift_years" in frame:
        shift = pd.to_numeric(frame["shift_years"], errors="coerce").fillna(0)
        output["identity_shift_abs_log1p"] = np.log1p(shift.abs()).astype(np.float32)
        output["identity_shift_is_unit"] = shift.abs().eq(1).astype(np.float32)
        output["identity_shift_is_negative"] = shift.lt(0).astype(np.float32)
    features = pd.DataFrame(output, index=frame.index)
    return features.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)


def project_operation_hierarchy_features(
    frame: pd.DataFrame,
    spec: FeatureSpec,
) -> pd.DataFrame:
    """Add truth-blind within-operation competition to relative evidence.

    A flat listwise row can see whether it wins an evidence channel globally,
    but mixed diagnoses also need to distinguish two separate questions: which
    shift wins inside one operation type, and which operation envelope wins the
    diagnosis.  Every added value remains a rank or standardized margin inside
    the current diagnosis; no file, series, calendar year, or label is exposed.
    """

    if "event_type" not in frame:
        raise RuntimeError("operation hierarchy requires event_type")
    features = project_relative_features(frame, spec)
    attempt = frame[spec.group_column]
    event_type = frame["event_type"].fillna("missing").astype(str)
    typed_group = pd.MultiIndex.from_arrays([attempt, event_type])
    extra: dict[str, pd.Series | np.ndarray] = {}

    type_size = event_type.groupby(typed_group, sort=False).transform("size")
    attempt_size = attempt.groupby(attempt, sort=False).transform("size")
    extra["operation_type_candidate_fraction"] = (
        type_size.div(attempt_size.replace(0, np.nan)).astype(np.float32)
    )
    extra["operation_type_candidate_count_rank"] = type_size.groupby(
        attempt, sort=False
    ).rank(pct=True, method="average").astype(np.float32)

    for column in spec.numeric_columns:
        values = pd.to_numeric(
            frame[column]
            if column in frame
            else pd.Series(np.nan, index=frame.index),
            errors="coerce",
        )
        typed = values.groupby(typed_group, sort=False)
        typed_mean = typed.transform("mean")
        typed_std = typed.transform("std").replace(0, np.nan)
        typed_max = typed.transform("max")
        typed_min = typed.transform("min")
        extra[f"{column}__operation_rank"] = typed.rank(
            pct=True, method="average"
        ).astype(np.float32)
        extra[f"{column}__operation_z"] = (
            (values - typed_mean) / typed_std
        ).clip(-8, 8).astype(np.float32)
        extra[f"{column}__operation_max_margin"] = (
            (values - typed_max) / typed_std
        ).clip(-12, 0).astype(np.float32)
        extra[f"{column}__operation_min_margin"] = (
            (typed_min - values) / typed_std
        ).clip(-12, 0).astype(np.float32)

        # Broadcast each operation type's envelope, then rank the envelopes
        # against the other operation identities in this diagnosis.
        extra[f"{column}__operation_max_envelope_rank"] = typed_max.groupby(
            attempt, sort=False
        ).rank(pct=True, method="average").astype(np.float32)
        extra[f"{column}__operation_min_envelope_rank"] = typed_min.groupby(
            attempt, sort=False
        ).rank(pct=True, method="average").astype(np.float32)

    hierarchy = pd.DataFrame(extra, index=frame.index)
    combined = pd.concat([features, hierarchy], axis=1)
    return combined.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)


def ranker(seed: int, *, graded: bool = False) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 3, 7] if graded else [0, 1],
        n_estimators=650,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=28,
        subsample=0.85,
        colsample_bytree=0.72,
        reg_alpha=2.0,
        reg_lambda=7.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def pair_classifier(seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=600,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=24,
        subsample=0.85,
        colsample_bytree=0.72,
        reg_alpha=2.0,
        reg_lambda=7.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def fit_ranker(
    estimator: lgb.LGBMRanker,
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
) -> lgb.LGBMRanker:
    ordered = frame.sort_values(group).index.to_numpy(dtype=int)
    group_sizes = frame.loc[ordered].groupby(group, sort=False).size().to_numpy()
    estimator.fit(values.loc[ordered], frame.loc[ordered, label], group=group_sizes)
    return estimator


def seed_percentile(frame: pd.DataFrame, *, group: str, columns: Iterable[str]) -> pd.Series:
    available = [column for column in columns if column in frame]
    if not available:
        return frame.groupby(group, sort=False).cumcount().mul(0).astype(float)
    ranks = [
        pd.to_numeric(frame[column], errors="coerce")
        .groupby(frame[group], sort=False)
        .rank(pct=True)
        for column in available
    ]
    return pd.concat(ranks, axis=1).mean(axis=1).fillna(0)


def build_pair_training(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
    seed_score: pd.Series,
    maximum_positives: int,
    maximum_negatives: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Build balanced positive/negative ordered hard-negative comparisons."""

    matrix = values.to_numpy(dtype=np.float32, copy=False)
    differences: list[np.ndarray] = []
    labels: list[int] = []
    for _, indices in frame.groupby(group, sort=False).groups.items():
        positions = np.asarray(list(indices), dtype=int)
        positive = positions[frame.loc[positions, label].to_numpy(dtype=float) > 0]
        negative = positions[frame.loc[positions, label].to_numpy(dtype=float) <= 0]
        if not len(positive) or not len(negative):
            continue
        positive = positive[np.argsort(-seed_score.loc[positive].to_numpy())][
            :maximum_positives
        ]
        negative = negative[np.argsort(-seed_score.loc[negative].to_numpy())][
            :maximum_negatives
        ]
        for positive_index in positive:
            for negative_index in negative:
                delta = matrix[positive_index] - matrix[negative_index]
                differences.append(delta)
                labels.append(1)
                differences.append(-delta)
                labels.append(0)
    if not differences:
        raise RuntimeError("no pairwise hard-negative rows were generated")
    return np.asarray(differences, dtype=np.float32), np.asarray(labels, dtype=np.int8)


def pair_tournament_scores(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    estimator: lgb.LGBMClassifier,
    *,
    group: str,
    shortlist_score: pd.Series,
    shortlist_size: int,
) -> np.ndarray:
    matrix = values.to_numpy(dtype=np.float32, copy=False)
    scores = np.zeros(len(frame), dtype=np.float32)
    wins = np.zeros(len(frame), dtype=np.float64)
    comparisons = np.zeros(len(frame), dtype=np.int32)
    pending_left: list[int] = []
    pending_right: list[int] = []

    def flush() -> None:
        if not pending_left:
            return
        left_array = np.asarray(pending_left, dtype=int)
        right_array = np.asarray(pending_right, dtype=int)
        differences = matrix[left_array] - matrix[right_array]
        booster = getattr(estimator, "booster_", None)
        probabilities = (
            booster.predict(differences)
            if booster is not None
            else estimator.predict_proba(differences)[:, 1]
        )
        np.add.at(wins, left_array, probabilities)
        np.add.at(wins, right_array, 1 - probabilities)
        np.add.at(comparisons, left_array, 1)
        np.add.at(comparisons, right_array, 1)
        pending_left.clear()
        pending_right.clear()

    for _, indices in frame.groupby(group, sort=False).groups.items():
        positions = np.asarray(list(indices), dtype=int)
        if len(positions) == 1:
            scores[positions[0]] = 1.0
            continue
        ordered = positions[np.argsort(-shortlist_score.loc[positions].to_numpy())]
        selected = ordered[:shortlist_size]
        for offset, left_index in enumerate(selected[:-1]):
            for right_index in selected[offset + 1 :]:
                pending_left.append(int(left_index))
                pending_right.append(int(right_index))
        if len(selected) < 2:
            scores[selected[0]] = 1.0
        if len(pending_left) >= 20_000:
            flush()
    flush()
    compared = comparisons > 0
    scores[compared] = (wins[compared] / comparisons[compared]).astype(np.float32)
    return scores


def within_group_percentile(
    frame: pd.DataFrame, values: pd.Series | np.ndarray, group: str
) -> pd.Series:
    series = pd.Series(values, index=frame.index)
    return series.groupby(frame[group], sort=False).rank(pct=True, method="average")


def select_top(frame: pd.DataFrame, score: pd.Series, group: str) -> pd.DataFrame:
    return (
        frame.assign(_selection_score=score)
        .sort_values([group, "_selection_score"], ascending=[True, False])
        .groupby(group, sort=False)
        .head(1)
        .drop(columns="_selection_score")
    )


def assert_same_identity_projection(
    operation_top: pd.DataFrame,
    location_top: pd.DataFrame,
) -> None:
    operation_identity = operation_top.set_index("attempt_id")["identity_group"]
    projected = location_top[location_top["attempt_id"].isin(operation_identity.index)]
    expected = projected["attempt_id"].map(operation_identity)
    if not projected["identity_group"].eq(expected).all():
        raise RuntimeError("location head crossed the immutable operation identity")


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
