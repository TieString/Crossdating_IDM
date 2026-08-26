#!/usr/bin/env python3
"""Train a file-OOF full-profile location head after operation selection."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
SHAPE_COLUMNS = (
    "rawGain",
    "differenceGain",
    "combinedGain",
    "sideMinimumAdvantage",
    "sideStepScore",
    "localSideStepScore11",
    "localSideStepScore21",
    "localSideStepScore31",
    "rawTransition_normalizedSplitGain",
    "rawTransition_balancedAdvantage",
    "cofechaTransition_normalizedSplitGain",
    "cofechaTransition_balancedAdvantage",
    "cumulative_combinedCusum",
    "cumulative_referenceMedianCusum",
    "cumulative_referenceVoteCusum",
    "piecewise_combinedGain",
    "referenceChange_weightedSupport",
    "referenceChange_positiveGainFraction",
    "referenceTransition_weightedRankMean",
    "referenceTransition_peakKernel9",
    "referenceTransition_weightedWindowVote25",
    "perReference_differenceGainWeighted",
    "perReference_fixedLagStepWeighted",
    "perReference_fixedLagStepPeakKernel9",
    "boundaryLocal_stepMinimum5",
    "boundaryLocal_stepMean5",
    "partialLocal_multiScale",
)
LABEL_COLUMNS = {
    "attempt_id",
    "source_attempt_id",
    "identity_group",
    "cluster_id",
    "file_id",
    "family",
    "truth_year",
    "year",
    "product_correct",
    "product_strict_correct",
    "operation_correct",
    "strict_operation_correct",
    "selected_operation_correct",
    "window_correct",
    "strict_correct",
    "top_exact",
    "location_relevance",
    "location_error_years",
}


def ranker(seed: int, *, graded: bool) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="rank_xendcg",
        metric="ndcg",
        label_gain=[0, 1, 3, 7] if graded else [0, 1],
        n_estimators=850,
        learning_rate=0.018,
        num_leaves=23,
        min_child_samples=45,
        subsample=0.9,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=8.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def clustered_lower(selected: pd.DataFrame, seed: int, repetitions: int) -> float:
    files = np.array(sorted(selected["cluster_id"].unique()))
    grouped = {
        file_id: selected[selected["cluster_id"].eq(file_id)][
            "final_correct"
        ].to_numpy(dtype=float)
        for file_id in files
    }
    rng = np.random.default_rng(seed)
    values = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sampled = rng.choice(files, size=len(files), replace=True)
        values[index] = np.concatenate([grouped[file_id] for file_id in sampled]).mean()
    return float(np.quantile(values, 0.05, method="lower"))


def add_shape_features(rows: pd.DataFrame) -> pd.DataFrame:
    ordered = rows.sort_values(["identity_group", "year"]).copy()
    grouped = ordered.groupby("identity_group", sort=False)
    additions: dict[str, pd.Series] = {}
    for column in SHAPE_COLUMNS:
        if column not in ordered:
            continue
        values = pd.to_numeric(ordered[column], errors="coerce")
        older = grouped[column].shift(1)
        newer = grouped[column].shift(-1)
        neighbor_mean = (older + newer) / 2
        additions[f"shape_{column}_older_delta"] = values - older
        additions[f"shape_{column}_newer_delta"] = newer - values
        additions[f"shape_{column}_slope"] = (newer - older) / 2
        additions[f"shape_{column}_peak_over_neighbors"] = values - neighbor_mean

    percentile_columns = [
        column
        for column in ordered
        if column.startswith("identity_") and column.endswith("_percentile")
    ]
    if percentile_columns:
        percentile_values = ordered[percentile_columns].to_numpy(
            dtype=np.float32, copy=True
        )
        finite = np.isfinite(percentile_values)
        count = finite.sum(axis=1)
        safe = np.where(finite, percentile_values, np.nan)
        valid = count > 0
        mean = np.full(len(ordered), np.nan, dtype=np.float32)
        median = np.full(len(ordered), np.nan, dtype=np.float32)
        spread = np.full(len(ordered), np.nan, dtype=np.float32)
        if valid.any():
            mean[valid] = np.nanmean(safe[valid], axis=1)
            median[valid] = np.nanmedian(safe[valid], axis=1)
            spread[valid] = np.nanstd(safe[valid], axis=1)
        additions["shape_channel_consensus_count"] = pd.Series(count, index=ordered.index)
        additions["shape_channel_consensus_mean"] = pd.Series(mean, index=ordered.index)
        additions["shape_channel_consensus_median"] = pd.Series(
            median, index=ordered.index
        )
        additions["shape_channel_consensus_spread"] = pd.Series(
            spread, index=ordered.index
        )
        denominator = np.maximum(1, count)
        for threshold in (0.5, 0.75, 0.9):
            suffix = str(threshold).replace(".", "")
            additions[f"shape_channel_above_{suffix}_fraction"] = pd.Series(
                ((safe >= threshold) & finite).sum(axis=1) / denominator,
                index=ordered.index,
            )
    return pd.concat(
        [ordered, pd.DataFrame(additions, index=ordered.index)], axis=1
    ).reset_index(drop=True)


def load_selected_rows(
    specifications: list[str],
    operation_top: pd.DataFrame,
    candidate_modes: dict[str, pd.DataFrame],
    search_radius: int,
) -> pd.DataFrame:
    selected_frames = []
    for specification in specifications:
        prefix, path_text = specification.split("=", 1)
        selected = operation_top[
            operation_top["attempt_id"].str.startswith(f"{prefix}:")
            & operation_top["event_type"].isin(LOCAL_EVENT_TYPES)
        ].copy()
        selected["source_attempt_id"] = selected["attempt_id"].str.split(
            ":", n=1
        ).str[1]
        keys = selected[[
            "source_attempt_id", "event_type", "shift_years",
            "operation_correct",
        ]].rename(columns={
            "source_attempt_id": "attempt_id",
            "operation_correct": "selected_operation_correct",
        })
        source = pd.read_pickle(Path(path_text).resolve())
        source = source.merge(
            keys,
            on=["attempt_id", "event_type", "shift_years"],
            how="inner",
            validate="many_to_one",
        )
        source = source.rename(columns={"attempt_id": "source_attempt_id"})
        source["attempt_id"] = prefix + ":" + source["source_attempt_id"].astype(str)
        source["cluster_id"] = prefix + "|" + source["file_id"].astype(str)
        source["identity_group"] = (
            source["attempt_id"].astype(str)
            + "|" + source["event_type"].astype(str)
            + "|" + source["shift_years"].astype(int).astype(str)
        )
        mode_features = []
        for identity_group, group in source.groupby("identity_group", sort=False):
            modes = candidate_modes.get(identity_group)
            if modes is None or modes.empty:
                continue
            mode_years = modes["candidate_year"].to_numpy(dtype=float)
            row_years = group["year"].to_numpy(dtype=float)
            distances = row_years[:, None] - mode_years[None, :]
            nearest_positions = np.abs(distances).argmin(axis=1)
            nearest_distance = distances[
                np.arange(len(group)), nearest_positions
            ]
            retained = np.abs(nearest_distance) <= search_radius
            if not retained.any():
                continue
            features = group.loc[group.index[retained]].copy()
            retained_distances = distances[retained]
            features["mode_nearest_signed_distance"] = nearest_distance[retained]
            features["mode_nearest_absolute_distance"] = np.abs(
                nearest_distance[retained]
            )
            features["mode_count"] = len(mode_years)
            for radius in (3, 6, 9, 13, 20):
                features[f"mode_support_within_{radius}"] = (
                    np.abs(retained_distances) <= radius
                ).sum(axis=1)
            retained_nearest = nearest_positions[retained]
            features["mode_nearest_source"] = modes.iloc[
                retained_nearest
            ]["candidate_source"].to_numpy()
            mode_features.append(features)
        if not mode_features:
            continue
        source = pd.concat(mode_features, ignore_index=True, sort=False)
        error = (source["year"] - source["truth_year"]).abs()
        source["location_error_years"] = error
        source["location_relevance"] = np.select(
            [error.le(1), error.le(3), error.le(6)], [3, 2, 1], default=0
        ).astype(np.int8)
        selected_frames.append(source)
    return pd.concat(selected_frames, ignore_index=True, sort=False)


def load_candidate_modes(paths: list[str]) -> dict[str, pd.DataFrame]:
    frames = []
    for path_text in paths:
        table = pd.read_pickle(Path(path_text).resolve())[[
            "attempt_id", "event_type", "shift_years", "candidate_year",
            "candidate_source",
        ]].dropna(subset=["candidate_year"])
        table["identity_group"] = (
            table["attempt_id"].astype(str)
            + "|" + table["event_type"].astype(str)
            + "|" + table["shift_years"].astype(int).astype(str)
        )
        frames.append(table)
    candidates = pd.concat(frames, ignore_index=True, sort=False).drop_duplicates(
        ["identity_group", "candidate_year", "candidate_source"]
    )
    return {
        identity_group: group.sort_values("candidate_year").reset_index(drop=True)
        for identity_group, group in candidates.groupby("identity_group", sort=False)
    }


def encode(rows: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    columns = [column for column in rows if column not in LABEL_COLUMNS]
    raw = rows[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--row-cache", action="append", required=True)
    parser.add_argument("--candidate-table", action="append", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--search-radius", type=int, default=20)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operation_top = pd.read_csv(Path(args.operation_top).resolve())
    candidate_modes = load_candidate_modes(args.candidate_table)
    rows = add_shape_features(load_selected_rows(
        args.row_cache,
        operation_top,
        candidate_modes,
        max(6, args.search_radius),
    ))
    values, feature_names = encode(rows)
    files = np.array(sorted(rows["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    score_columns = [
        "location_binary_global_score",
        "location_binary_typed_score",
        "location_graded_global_score",
        "location_graded_typed_score",
    ]
    predictions = {column: np.full(len(rows), np.nan) for column in score_columns}

    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        test_mask = rows["cluster_id"].isin(held_files)
        train_mask = ~test_mask & rows["selected_operation_correct"].eq(1)
        for graded_index, graded in enumerate((False, True)):
            label = "location_relevance" if graded else "window_correct"
            name = "graded" if graded else "binary"
            train = rows.index[train_mask].to_numpy(dtype=int)
            ordered = rows.loc[train].sort_values("identity_group").index.to_numpy(
                dtype=int
            )
            groups = rows.loc[ordered].groupby(
                "identity_group", sort=False
            ).size().to_numpy()
            global_model = ranker(96000 + fold * 20 + graded_index, graded=graded)
            global_model.fit(values.loc[ordered], rows.loc[ordered, label], group=groups)
            test = rows.index[test_mask].to_numpy(dtype=int)
            predictions[f"location_{name}_global_score"][test] = global_model.predict(
                values.loc[test]
            )
            for event_index, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
                typed_train = rows.index[
                    train_mask & rows["event_type"].eq(event_type)
                ].to_numpy(dtype=int)
                typed_ordered = rows.loc[typed_train].sort_values(
                    "identity_group"
                ).index.to_numpy(dtype=int)
                typed_groups = rows.loc[typed_ordered].groupby(
                    "identity_group", sort=False
                ).size().to_numpy()
                typed_model = ranker(
                    96500 + fold * 20 + graded_index * 5 + event_index,
                    graded=graded,
                )
                typed_model.fit(
                    values.loc[typed_ordered],
                    rows.loc[typed_ordered, label],
                    group=typed_groups,
                )
                typed_test = rows.index[
                    test_mask & rows["event_type"].eq(event_type)
                ].to_numpy(dtype=int)
                predictions[f"location_{name}_typed_score"][typed_test] = (
                    typed_model.predict(values.loc[typed_test])
                )

    for column, prediction in predictions.items():
        if np.isnan(prediction).any():
            raise RuntimeError(f"missing OOF predictions for {column}")
        rows[column] = prediction
        rows[f"{column}_percentile"] = rows.groupby(
            "identity_group", sort=False
        )[column].rank(pct=True)

    weights = (0.0, 0.25, 0.5, 0.75, 1.0)
    location_tops = {}
    for typed_weight in weights:
        binary = (
            rows["location_binary_global_score_percentile"] * (1 - typed_weight)
            + rows["location_binary_typed_score_percentile"] * typed_weight
        )
        graded = (
            rows["location_graded_global_score_percentile"] * (1 - typed_weight)
            + rows["location_graded_typed_score_percentile"] * typed_weight
        )
        for graded_weight in weights:
            score = binary * (1 - graded_weight) + graded * graded_weight
            location_tops[(typed_weight, graded_weight)] = rows.assign(
                location_score=score
            ).sort_values(
                ["identity_group", "location_score"], ascending=[True, False]
            ).groupby("identity_group", sort=False).head(1).set_index(
                "identity_group"
            )

    grid_rows = []
    selections = {}
    for weights_key, location_top in location_tops.items():
        selected = operation_top.copy()
        local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
        selected["location_correct"] = selected["identity_group"].map(
            location_top["window_correct"]
        )
        selected.loc[local, "selected_candidate_year"] = selected.loc[
            local, "identity_group"
        ].map(location_top["year"])
        selected.loc[local, "selected_candidate_source"] = "fullYearProfile"
        selected["final_correct"] = selected["operation_correct"].astype(int)
        selected.loc[local, "final_correct"] = (
            selected.loc[local, "operation_correct"].astype(bool)
            & selected.loc[local, "location_correct"].fillna(0).astype(bool)
        ).astype(int)
        event = selected[selected["family"] != "Clean"]
        family_accuracy = {
            family: float(event[event["family"].eq(family)]["final_correct"].mean())
            for family in "ABCD"
        }
        grid_rows.append({
            "typedWeight": weights_key[0],
            "gradedWeight": weights_key[1],
            "correct": int(event["final_correct"].sum()),
            "minimumFamilyAccuracy": min(family_accuracy.values()),
            **{f"accuracy{family}": value for family, value in family_accuracy.items()},
        })
        selections[weights_key] = selected

    grid = pd.DataFrame(grid_rows)
    best = grid.sort_values(
        ["minimumFamilyAccuracy", "correct"], ascending=[False, False]
    ).iloc[0]
    weights_key = (float(best["typedWeight"]), float(best["gradedWeight"]))
    selected = selections[weights_key]
    event = selected[selected["family"] != "Clean"]
    clean = selected[selected["family"] == "Clean"]
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["final_correct"].mean()),
            "oneSided95FileClusterLower": clustered_lower(
                group, 97000 + ord(family), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family")
    }
    summary = {
        "schemaVersion": 1,
        "files": int(rows["cluster_id"].nunique()),
        "yearRows": len(rows),
        "locationFeatures": len(feature_names),
        "searchRadius": max(6, args.search_radius),
        "weights": {"typed": weights_key[0], "graded": weights_key[1]},
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneAccuracy": float(event["final_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "overallOneSided95FileClusterLower": clustered_lower(
            event, 97999, args.bootstrap_repetitions
        ),
        "byFamily": by_family,
    }
    rows[[
        "attempt_id", "identity_group", "cluster_id", "file_id", "family",
        "event_type", "shift_years", "year", "window_correct",
        "location_relevance", "location_error_years", *score_columns,
        *[f"{column}_percentile" for column in score_columns],
    ]].to_pickle(output_dir / "full-year-location-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-full-year-location-top.csv", index=False)
    grid.to_csv(output_dir / "full-year-location-grid.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
