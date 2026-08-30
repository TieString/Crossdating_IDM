#!/usr/bin/env python3
"""File-OOF same-identity reranking with post-correction residual evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


pair = load_module(
    "immutable_residual_pair",
    SCRIPT_DIR / "immutable_two_stage_adjudicator.py",
)

LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
IDENTITY_KEYS = ("attempt_id", "event_type", "shift_years")
CORE_LOCATION_SCORE_COLUMNS = (
    "listwise_score",
    "pairwise_score",
)
EXTRA_FROZEN_LOCATION_SCORE_COLUMNS = (
    "location_score",
    "location_meta_score",
    "location_typed_score",
    "location_global_score",
)
BOTTOM_LOCATION_EVIDENCE_PREFIXES = (
    "evidence_rawTransition_",
    "evidence_referenceChange_",
    "evidence_referenceTransition_",
    "evidence_perReference_",
    "evidence_boundaryLocal_",
    "evidence_partialLocal_",
)
PHYSICAL_MODE_TOKENS = (
    "frontierconsistency_",
    "transitiondelta_localnormalizedsplitgain",
    "transitiondelta_localbalancedadvantage",
    "transitiondelta_localgain31",
    "newerside_transitiondelta_strongestnormalizedsplitgain",
    "newerside_pathdelta_eventcount",
    "operationspecific_afterregionallagstep",
    "operationspecific_afternearestboundarystep",
    "operationspecific_afterthreeboundarystep",
)


def physical_mode_signal(
    column: str,
    values: pd.Series,
    *,
    orient_residuals: bool,
) -> pd.Series:
    """Orient every mode signal so a larger value means a cleaner correction."""

    if not orient_residuals or column in CORE_LOCATION_SCORE_COLUMNS \
            or column in EXTRA_FROZEN_LOCATION_SCORE_COLUMNS:
        return values
    lowered = column.lower()
    if any(token in lowered for token in (
        "operationspecific_afterregionallagstep",
        "operationspecific_afternearestboundarystep",
        "operationspecific_afterthreeboundarystep",
    )):
        return values.abs().mul(-1)
    # These channels are unresolved residuals or after-before deltas.  A more
    # negative delta and a smaller residual both mean the virtual correction
    # removed more of the newer-side transition.
    return values.mul(-1)


def read_residual_frame(path: Path) -> pd.DataFrame:
    if path.is_dir():
        parts = sorted(path.glob("part-*.ndjson"))
        if not parts:
            raise ValueError(f"residual directory has no part files: {path}")
        return pd.concat(
            [pd.read_json(part, lines=True) for part in parts],
            ignore_index=True,
            sort=False,
        )
    payload = json.loads(path.read_text(encoding="utf8"))
    if rows_path := payload.get("rowsNdjsonPath"):
        resolved = Path(rows_path)
        if not resolved.is_absolute():
            resolved = path.parent / resolved
        return pd.read_json(resolved, lines=True)
    return pd.DataFrame(payload["rows"])


def proposal_id(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["attempt_id"].astype(str)
        + "|"
        + frame["event_type"].astype(str)
        + "|"
        + frame["shift_years"].astype(int).astype(str)
        + "|"
        + frame["year"].astype(int).astype(str)
    )


def add_relative_year_distances(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    year_columns = [
        column
        for column in output.columns
        if column.startswith("residual_")
        and (column.endswith("Year") or column.endswith("_firstYear"))
        and "Delta_" not in column
    ]
    distance_columns: dict[str, pd.Series] = {}
    for column in year_columns:
        values = pd.to_numeric(output[column], errors="coerce")
        valid = values.notna() & values.ne(0)
        distance = values.sub(output["year"]).where(valid)
        distance_columns[f"{column}_signed_distance"] = distance
        distance_columns[f"{column}_absolute_distance"] = distance.abs()
        distance_columns[f"{column}_present"] = valid.astype(np.int8)
    return pd.concat([
        output.drop(columns=year_columns),
        pd.DataFrame(distance_columns, index=output.index),
    ], axis=1)


def residual_features(
    frame: pd.DataFrame,
    excluded_prefixes: tuple[str, ...] = (),
    *,
    include_physical_modes: bool = True,
    include_all_frozen_views: bool = False,
    include_typed_physical_modes: bool = False,
    orient_physical_residuals: bool = False,
    include_bottom_evidence: bool = False,
    include_anchor_oof_evidence: bool = False,
) -> pd.DataFrame:
    """Use only diagnosis-relative values plus within-identity rank/z/margin."""

    source = add_relative_year_distances(frame)
    location_score_columns = CORE_LOCATION_SCORE_COLUMNS
    if include_all_frozen_views:
        location_score_columns += EXTRA_FROZEN_LOCATION_SCORE_COLUMNS
    numeric_columns = []
    for column in source.columns:
        if any(column.startswith(prefix) for prefix in excluded_prefixes):
            continue
        bottom_evidence = include_bottom_evidence and column.startswith(
            BOTTOM_LOCATION_EVIDENCE_PREFIXES
        )
        anchor_evidence = (
            include_anchor_oof_evidence
            and column == "anchor_location_oof_score"
        )
        if column in location_score_columns or column.startswith(
            "residual_"
        ) or bottom_evidence or anchor_evidence:
            values = pd.to_numeric(source[column], errors="coerce")
            if values.notna().any():
                source[column] = values.astype(np.float64)
                numeric_columns.append(column)
    group = source.groupby(list(IDENTITY_KEYS), sort=False)
    features: dict[str, pd.Series] = {}
    ranks_by_column: dict[str, pd.Series] = {}
    for column in numeric_columns:
        values = source[column]
        grouped = group[column]
        ranks = grouped.rank(pct=True, method="average")
        ranks_by_column[column] = ranks
        means = grouped.transform("mean")
        standard = grouped.transform("std").replace(0, np.nan)
        maximum = grouped.transform("max")
        features[f"{column}__rank"] = ranks
        features[f"{column}__z"] = values.sub(means).div(standard).fillna(0)
        features[f"{column}__winner_margin"] = values.sub(maximum)
        if "Delta" in column or column.endswith("pathEventReduction"):
            features[f"{column}__relative_value"] = values
    mode_columns = []
    if include_physical_modes:
        mode_columns = [
            column for column in numeric_columns
            if column in location_score_columns
            or any(token in column.lower() for token in PHYSICAL_MODE_TOKENS)
        ]
    for column in mode_columns:
        oriented = physical_mode_signal(
            column,
            source[column],
            orient_residuals=orient_physical_residuals,
        )
        ranks = oriented.groupby(
            [source[key] for key in IDENTITY_KEYS], sort=False
        ).rank(pct=True, method="average")
        features[f"{column}__physical_rank"] = ranks
        mode_mean = {
            radius: pd.Series(0.0, index=source.index)
            for radius in (2, 4, 6)
        }
        mode_maximum = {
            radius: pd.Series(0.0, index=source.index)
            for radius in (2, 4, 6)
        }
        adjacent_margin = pd.Series(0.0, index=source.index)
        for indices in group.groups.values():
            positions = list(indices)
            years = pd.to_numeric(
                source.loc[positions, "year"], errors="coerce"
            ).to_numpy(dtype=float)
            values = ranks.loc[positions].to_numpy(dtype=float)
            for offset, position in enumerate(positions):
                distances = np.abs(years - years[offset])
                for radius in (2, 4, 6):
                    nearby = values[distances <= radius]
                    mode_mean[radius].loc[position] = float(nearby.mean())
                    mode_maximum[radius].loc[position] = float(nearby.max())
                adjacent = values[(distances <= 1) & (distances > 0)]
                if len(adjacent) > 0:
                    adjacent_margin.loc[position] = float(
                        values[offset] - adjacent.max()
                    )
        for radius in (2, 4, 6):
            width = radius * 2 + 1
            features[f"{column}__physical_mode{width}_mean"] = (
                mode_mean[radius]
            )
            features[f"{column}__physical_mode{width}_maximum"] = (
                mode_maximum[radius]
            )
        features[f"{column}__adjacent_year_margin"] = adjacent_margin
    if include_typed_physical_modes:
        physical_feature_names = [
            name for name in features
            if "__physical_" in name or "__adjacent_year_margin" in name
        ]
        for event_type in sorted(LOCAL_EVENT_TYPES):
            mask = source["event_type"].eq(event_type).astype(np.float32)
            for name in physical_feature_names:
                features[f"{name}__for_{event_type}"] = features[name].mul(mask)
    output = pd.DataFrame(features, index=source.index)
    return output.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)


def select_top(frame: pd.DataFrame, scores: pd.Series) -> pd.DataFrame:
    return (
        frame.assign(_score=scores)
        .sort_values(
            [*IDENTITY_KEYS, "_score", "pairwise_score"],
            ascending=[True, True, True, False, False],
            kind="mergesort",
        )
        .drop_duplicates(list(IDENTITY_KEYS))
    )


def fuse_listwise_pairwise_scores(
    frame: pd.DataFrame,
    listwise_scores: pd.Series | np.ndarray,
    pairwise_scores: pd.Series | np.ndarray,
) -> np.ndarray:
    """Equal-rank fusion avoids comparing incompatible raw model scales."""

    listwise_rank = pair.within_group_percentile(
        frame, listwise_scores, "attempt_id"
    )
    pairwise_rank = pair.within_group_percentile(
        frame, pairwise_scores, "attempt_id"
    )
    return listwise_rank.add(pairwise_rank).div(2).to_numpy(np.float32)


def project_final(operation_top: pd.DataFrame, location_top: pd.DataFrame) -> pd.DataFrame:
    selected = operation_top.copy()
    local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    location = location_top.set_index("attempt_id")
    selected["final_correct"] = selected["operation_correct"].astype(np.int8)
    selected.loc[local, "final_correct"] = (
        selected.loc[local, "operation_correct"].astype(bool)
        & selected.loc[local, "attempt_id"]
        .map(location["window_correct"])
        .fillna(0)
        .astype(bool)
    ).astype(np.int8)
    selected.loc[local, "selected_candidate_year"] = selected.loc[
        local, "attempt_id"
    ].map(location["year"])
    selected["candidate_has_response"] = selected["event_type"].ne(
        "noEvent"
    ).astype(np.int8)
    selected["final_strict_correct"] = selected["final_correct"]
    return selected


def normalize_operation_top(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    if "operation_correct" in output:
        return output
    for column in ("identity_workflow_oracle", "identity_operation_correct"):
        if column in output:
            output["operation_correct"] = pd.to_numeric(
                output[column], errors="coerce"
            ).fillna(0).astype(np.int8)
            return output
    raise ValueError("operation top misses a correctness label")


def file_cluster_lower(
    frame: pd.DataFrame,
    value_column: str,
    *,
    repetitions: int = 20_000,
    seed: str = "location-residual",
) -> float:
    grouped = frame.groupby("file_id", sort=True)[value_column].agg(
        ["sum", "count"]
    )
    if grouped.empty:
        return 0.0
    digest = hashlib.sha256(seed.encode("utf8")).digest()
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
    indices = rng.integers(
        0, len(grouped), size=(repetitions, len(grouped)), endpoint=False
    )
    numerators = grouped["sum"].to_numpy(dtype=float)[indices].sum(axis=1)
    denominators = grouped["count"].to_numpy(dtype=float)[indices].sum(axis=1)
    return float(np.quantile(numerators / denominators, 0.05))


def summarize(selected: pd.DataFrame, baseline: pd.DataFrame) -> dict:
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    comparison = event[["attempt_id", "final_correct"]].merge(
        baseline[["attempt_id", "final_correct"]].rename(
            columns={"final_correct": "baseline_correct"}
        ),
        on="attempt_id",
        validate="one_to_one",
    )
    return {
        "correct": int(event["final_correct"].sum()),
        "events": int(len(event)),
        "accuracy": float(event["final_correct"].mean()),
        "fileClusterOneSided95Lower": file_cluster_lower(
            event, "final_correct"
        ),
        "responseRate": float(event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "repairs": int(
            (comparison["baseline_correct"].eq(0)
             & comparison["final_correct"].eq(1)).sum()
        ),
        "regressions": int(
            (comparison["baseline_correct"].eq(1)
             & comparison["final_correct"].eq(0)).sum()
        ),
        "byFamily": {
            str(family): {
                "correct": int(group["final_correct"].sum()),
                "events": int(len(group)),
                "accuracy": float(group["final_correct"].mean()),
                "fileClusterOneSided95Lower": file_cluster_lower(
                    group,
                    "final_correct",
                    seed=f"location-residual:{family}",
                ),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }


def failure_layer(row: pd.Series) -> str:
    if int(row["final_correct"]) == 1:
        return "correct"
    if int(row["candidate_has_response"]) == 0:
        return "refusal"
    if int(row["operation_correct"]) == 0:
        oracle = pd.to_numeric(
            row.get("full_candidate_oracle", np.nan), errors="coerce"
        )
        if pd.notna(oracle) and int(oracle) == 0:
            return "candidate_oracle_missing"
        return "operation_or_frontier"
    if row["event_type"] in LOCAL_EVENT_TYPES:
        return "window"
    return "other"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--residual-evidence", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--outer-splits", type=int, default=5)
    parser.add_argument("--exclude-feature-prefix", action="append", default=[])
    parser.add_argument("--disable-physical-modes", action="store_true")
    parser.add_argument("--include-all-frozen-location-views", action="store_true")
    parser.add_argument("--enable-listwise-pairwise-fusion", action="store_true")
    parser.add_argument("--enable-typed-physical-modes", action="store_true")
    parser.add_argument("--orient-physical-residuals", action="store_true")
    parser.add_argument("--include-bottom-evidence", action="store_true")
    parser.add_argument("--include-anchor-oof-evidence", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    location = pd.read_pickle(Path(args.location_scores).resolve())
    location["proposal_id"] = proposal_id(location)
    residual = read_residual_frame(Path(args.residual_evidence).resolve())
    residual_columns = [
        column
        for column in residual.columns
        if column == "proposal_id" or column.startswith("residual_")
    ]
    rows = location.merge(
        residual[residual_columns],
        on="proposal_id",
        how="inner",
        validate="one_to_one",
    )
    operation_top = normalize_operation_top(
        pd.read_csv(Path(args.operation_top).resolve())
    )
    operation_correct = operation_top.set_index("attempt_id")["operation_correct"]
    rows["selected_operation_correct"] = (
        rows["attempt_id"].map(operation_correct).fillna(0).astype(np.int8)
    )
    excluded_prefixes = tuple(args.exclude_feature_prefix)
    values = residual_features(
        rows,
        excluded_prefixes,
        include_physical_modes=not args.disable_physical_modes,
        include_all_frozen_views=args.include_all_frozen_location_views,
        include_typed_physical_modes=args.enable_typed_physical_modes,
        orient_physical_residuals=args.orient_physical_residuals,
        include_bottom_evidence=args.include_bottom_evidence,
        include_anchor_oof_evidence=args.include_anchor_oof_evidence,
    )
    predictions = np.full(len(rows), np.nan, dtype=np.float32)
    feature_importance = np.zeros(values.shape[1], dtype=np.float64)
    splitter = GroupKFold(
        n_splits=min(args.outer_splits, rows["file_id"].nunique())
    )
    for fold, (train_index, test_index) in enumerate(
        splitter.split(rows, groups=rows["file_id"])
    ):
        train_index = np.asarray(train_index, dtype=int)
        test_index = np.asarray(test_index, dtype=int)
        train_index = train_index[
            rows.loc[train_index, "selected_operation_correct"].eq(1).to_numpy()
        ]
        train_frame = rows.loc[train_index].reset_index(drop=True)
        train_values = values.loc[train_index].reset_index(drop=True)
        pair_values, pair_labels = pair.build_pair_training(
            train_frame,
            train_values,
            label="window_correct",
            group="attempt_id",
            seed_score=train_frame["pairwise_score"],
            maximum_positives=3,
            maximum_negatives=12,
        )
        estimator = pair.pair_classifier(830000 + fold)
        estimator.fit(pair_values, pair_labels)
        booster = getattr(estimator, "booster_", None)
        if booster is not None:
            feature_importance += booster.feature_importance(
                importance_type="gain"
            )
        test_frame = rows.loc[test_index].reset_index(drop=True)
        test_values = values.loc[test_index].reset_index(drop=True)
        pairwise_predictions = pair.pair_tournament_scores(
            test_frame,
            test_values,
            estimator,
            group="attempt_id",
            shortlist_score=test_frame["pairwise_score"],
            shortlist_size=16,
        )
        if args.enable_listwise_pairwise_fusion:
            rank_estimator = pair.ranker(840000 + fold)
            pair.fit_ranker(
                rank_estimator,
                train_frame,
                train_values,
                label="window_correct",
                group="attempt_id",
            )
            rank_predictions = rank_estimator.predict(test_values)
            predictions[test_index] = fuse_listwise_pairwise_scores(
                test_frame,
                rank_predictions,
                pairwise_predictions,
            )
            rank_booster = getattr(rank_estimator, "booster_", None)
            if rank_booster is not None:
                feature_importance += rank_booster.feature_importance(
                    importance_type="gain"
                )
        else:
            predictions[test_index] = pairwise_predictions
        print(json.dumps({"completedOuterFold": fold}), flush=True)
    if np.isnan(predictions).any():
        raise RuntimeError("residual location OOF left candidates without scores")

    baseline_location = select_top(location, location["pairwise_score"])
    residual_location = select_top(
        rows, pd.Series(predictions, index=rows.index)
    )
    baseline = project_final(operation_top, baseline_location)
    selected = project_final(operation_top, residual_location)
    selected["failure_layer"] = selected.apply(failure_layer, axis=1)
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "strictFileOof": True,
        "truthBlindResidualGeneration": True,
        "operationIdentityImmutable": True,
        "candidateWindowsImmutable": True,
        "excludedFeaturePrefixes": list(excluded_prefixes),
        "physicalModesEnabled": not args.disable_physical_modes,
        "allFrozenLocationViewsEnabled": args.include_all_frozen_location_views,
        "listwisePairwiseFusionEnabled": args.enable_listwise_pairwise_fusion,
        "typedPhysicalModesEnabled": args.enable_typed_physical_modes,
        "physicalResidualOrientationEnabled": args.orient_physical_residuals,
        "bottomEvidenceEnabled": args.include_bottom_evidence,
        "anchorOofEvidenceEnabled": args.include_anchor_oof_evidence,
        "featureCount": int(values.shape[1]),
        "attemptsWithResidual": int(rows["attempt_id"].nunique()),
        "residualCandidates": int(len(rows)),
        "baseline": summarize(baseline, baseline),
        "residualPairwise": summarize(selected, baseline),
        "remainingFailureLayers": {
            str(layer): int(count)
            for layer, count in selected[
                selected["family"].ne("Clean")
                & selected["final_correct"].eq(0)
            ]["failure_layer"].value_counts().sort_index().items()
        },
    }
    selected.to_csv(output_dir / "residual-location-top.csv", index=False)
    rows[[
        "proposal_id", "attempt_id", "file_id", "family", "event_type",
        "shift_years", "year", "window_correct", "listwise_score",
        "pairwise_score",
    ]].assign(residual_oof_score=predictions).to_pickle(
        output_dir / "residual-location-oof-scores.pkl"
    )
    pd.DataFrame({
        "feature": values.columns,
        "gain": feature_importance,
    }).sort_values("gain", ascending=False, kind="mergesort").to_csv(
        output_dir / "feature-importance.csv", index=False
    )
    selected[selected["family"].ne("Clean") & selected["final_correct"].eq(0)].to_csv(
        output_dir / "remaining-location-failures.csv", index=False
    )
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
