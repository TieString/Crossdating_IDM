#!/usr/bin/env python3
"""Blindly arbitrate package-mode and coarse-to-fine location proposals."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.02,
        num_leaves=7,
        min_child_samples=28,
        subsample=0.9,
        colsample_bytree=0.8,
        reg_alpha=2.0,
        reg_lambda=10.0,
        scale_pos_weight=min(10.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def selected_base_features(
    locations: pd.DataFrame,
    top: pd.DataFrame,
    summary: dict,
) -> pd.DataFrame:
    typed_weight = float(summary["weights"]["typedLocation"])
    classifier_weight = float(summary["weights"]["locationClassifier"])
    rank_score = (
        locations["location_global_percentile"] * (1 - typed_weight)
        + locations["location_typed_percentile"] * typed_weight
    )
    classifier_score = (
        locations["location_global_classifier_percentile"] * (1 - typed_weight)
        + locations["location_typed_classifier_percentile"] * typed_weight
    )
    locations = locations.assign(
        base_rank_score=rank_score,
        base_classifier_score=classifier_score,
        base_blend_score=(
            rank_score * (1 - classifier_weight)
            + classifier_score * classifier_weight
        ),
    )
    sorted_scores = locations.sort_values(
        ["identity_group", "base_blend_score"], ascending=[True, False]
    )
    score_summary = sorted_scores.groupby("identity_group", sort=False).agg(
        base_mode_count=("candidate_year", "size"),
        base_score_maximum=("base_blend_score", "max"),
        base_score_mean=("base_blend_score", "mean"),
        base_score_standard_deviation=("base_blend_score", "std"),
    )
    second = sorted_scores.groupby("identity_group", sort=False).nth(1)[
        "base_blend_score"
    ]
    score_summary["base_score_margin"] = (
        score_summary["base_score_maximum"] - second
    ).fillna(1)

    by_identity = locations.groupby("identity_group", sort=False)
    rows = []
    for _, selected in top.iterrows():
        if selected["event_type"] not in LOCAL_EVENT_TYPES:
            continue
        group = by_identity.get_group(selected["identity_group"])
        match = group[
            group["candidate_source"].eq(selected["selected_candidate_source"])
            & group["candidate_year"].eq(selected["selected_candidate_year"])
        ]
        if match.empty:
            match = group[group["candidate_year"].eq(
                selected["selected_candidate_year"]
            )]
        row = (match if not match.empty else group.sort_values(
            "base_blend_score", ascending=False
        )).iloc[0]
        record = {
            "attempt_id": selected["attempt_id"],
            "identity_group": selected["identity_group"],
            "cluster_id": selected["cluster_id"],
            "file_id": selected["file_id"],
            "family": selected["family"],
            "event_type": selected["event_type"],
            "shift_years": selected["shift_years"],
            "base_year": selected["selected_candidate_year"],
            "base_source": selected["selected_candidate_source"],
            "base_correct": int(selected["final_correct"]),
            "operation_correct": int(selected["operation_correct"]),
        }
        for column in (
            "base_rank_score", "base_classifier_score", "base_blend_score",
            "location_global_percentile", "location_typed_percentile",
            "location_global_classifier_percentile",
            "location_typed_classifier_percentile", "runtime_score",
            "runtime_score_margin", "runtime_window_width",
            "geometry_relative_recency", "geometry_rank_from_oldest",
            "geometry_rank_from_newest", "geometry_identity_mode_count",
            "geometry_productPrimary_all_within_6_fraction",
            "geometry_productPrimary_frontier_within_6_fraction",
            "geometry_productPrimary_reference_within_6_fraction",
            "geometry_productPrimary_profile_within_6_fraction",
        ):
            if column in row:
                record[f"base__{column}"] = row[column]
        record.update(score_summary.loc[selected["identity_group"]].to_dict())
        rows.append(record)
    return pd.DataFrame(rows).set_index("attempt_id")


def selected_profile_features(
    scores: pd.DataFrame,
    top: pd.DataFrame,
    summary: dict,
) -> pd.DataFrame:
    typed_weight = float(summary["weights"]["typed"])
    graded_weight = float(summary["weights"]["graded"])
    binary = (
        scores["location_binary_global_score_percentile"] * (1 - typed_weight)
        + scores["location_binary_typed_score_percentile"] * typed_weight
    )
    graded = (
        scores["location_graded_global_score_percentile"] * (1 - typed_weight)
        + scores["location_graded_typed_score_percentile"] * typed_weight
    )
    scores = scores.assign(
        profile_binary_score=binary,
        profile_graded_score=graded,
        profile_blend_score=(
            binary * (1 - graded_weight) + graded * graded_weight
        ),
    )
    sorted_scores = scores.sort_values(
        ["identity_group", "profile_blend_score"], ascending=[True, False]
    )
    score_summary = sorted_scores.groupby("identity_group", sort=False).agg(
        profile_year_count=("year", "size"),
        profile_score_maximum=("profile_blend_score", "max"),
        profile_score_mean=("profile_blend_score", "mean"),
        profile_score_standard_deviation=("profile_blend_score", "std"),
    )
    second = sorted_scores.groupby("identity_group", sort=False).nth(1)[
        "profile_blend_score"
    ]
    score_summary["profile_score_margin"] = (
        score_summary["profile_score_maximum"] - second
    ).fillna(1)

    by_identity = scores.groupby("identity_group", sort=False)
    rows = []
    for _, selected in top.iterrows():
        if selected["event_type"] not in LOCAL_EVENT_TYPES:
            continue
        group = by_identity.get_group(selected["identity_group"])
        match = group[group["year"].eq(selected["selected_candidate_year"])]
        row = (match if not match.empty else group.sort_values(
            "profile_blend_score", ascending=False
        )).iloc[0]
        record = {
            "attempt_id": selected["attempt_id"],
            "profile_year": selected["selected_candidate_year"],
            "profile_correct": int(selected["final_correct"]),
        }
        for column in (
            "profile_binary_score", "profile_graded_score", "profile_blend_score",
            "location_binary_global_score_percentile",
            "location_binary_typed_score_percentile",
            "location_graded_global_score_percentile",
            "location_graded_typed_score_percentile",
        ):
            record[f"profile__{column}"] = row[column]
        record.update(score_summary.loc[selected["identity_group"]].to_dict())
        rows.append(record)
    return pd.DataFrame(rows).set_index("attempt_id")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-location-scores", required=True)
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--profile-scores", required=True)
    parser.add_argument("--profile-top", required=True)
    parser.add_argument("--maximum-correct-to-wrong", type=int, default=0)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base_top_path = Path(args.base_top).resolve()
    profile_top_path = Path(args.profile_top).resolve()
    base_top = pd.read_csv(base_top_path)
    profile_top = pd.read_csv(profile_top_path)
    base = selected_base_features(
        pd.read_pickle(Path(args.base_location_scores).resolve()),
        base_top,
        json.loads((base_top_path.parent / "summary.json").read_text(encoding="utf8")),
    )
    profile = selected_profile_features(
        pd.read_pickle(Path(args.profile_scores).resolve()),
        profile_top,
        json.loads((profile_top_path.parent / "summary.json").read_text(encoding="utf8")),
    )
    table = base.join(profile, how="inner")
    table["proposal_year_delta"] = table["profile_year"] - table["base_year"]
    table["proposal_year_absolute_delta"] = table["proposal_year_delta"].abs()
    table["profile_better"] = (
        table["profile_correct"].eq(1) & table["base_correct"].eq(0)
    ).astype(int)
    table["discordant"] = table["profile_correct"].ne(table["base_correct"])

    labels = {
        "attempt_id", "identity_group", "cluster_id", "file_id", "family",
        "base_correct", "profile_correct", "operation_correct",
        "profile_better", "discordant", "base_year", "profile_year",
    }
    raw = table[[column for column in table if column not in labels]].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)
    files = np.array(sorted(table["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    global_predictions = np.full(len(table), np.nan)
    typed_predictions = np.full(len(table), np.nan)
    table = table.reset_index()
    values = values.reset_index(drop=True)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train = table.index[
            ~table["cluster_id"].isin(held_files) & table["discordant"]
        ].to_numpy(dtype=int)
        test = table.index[table["cluster_id"].isin(held_files)].to_numpy(dtype=int)
        global_model = classifier(table.loc[train, "profile_better"], 98000 + fold)
        global_model.fit(values.loc[train], table.loc[train, "profile_better"])
        global_predictions[test] = global_model.predict_proba(values.loc[test])[:, 1]
        for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
            typed_train = table.index[
                ~table["cluster_id"].isin(held_files)
                & table["discordant"]
                & table["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            typed_test = table.index[
                table["cluster_id"].isin(held_files)
                & table["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            typed_model = classifier(
                table.loc[typed_train, "profile_better"],
                98500 + fold * 10 + offset,
            )
            typed_model.fit(
                values.loc[typed_train], table.loc[typed_train, "profile_better"]
            )
            typed_predictions[typed_test] = typed_model.predict_proba(
                values.loc[typed_test]
            )[:, 1]
    if np.isnan(global_predictions).any() or np.isnan(typed_predictions).any():
        raise RuntimeError("missing profile fusion OOF predictions")
    table["profile_global_probability"] = global_predictions
    table["profile_typed_probability"] = typed_predictions

    threshold_rows = []
    selected_by_type = {}
    for event_type in sorted(LOCAL_EVENT_TYPES):
        typed = table[table["event_type"].eq(event_type)].copy()
        best = None
        for typed_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            probability = (
                typed["profile_global_probability"] * (1 - typed_weight)
                + typed["profile_typed_probability"] * typed_weight
            )
            thresholds = sorted(set(
                probability.quantile(np.linspace(0, 1, 501)).astype(float).tolist()
                + [1.01]
            ))
            for threshold in thresholds:
                use_profile = probability.ge(threshold)
                final_correct = typed["base_correct"].copy()
                final_correct.loc[use_profile] = typed.loc[
                    use_profile, "profile_correct"
                ]
                correct_to_wrong = int((
                    typed["base_correct"].eq(1)
                    & final_correct.eq(0)
                ).sum())
                if correct_to_wrong > args.maximum_correct_to_wrong:
                    continue
                key = (int(final_correct.sum()), -int(use_profile.sum()))
                if best is None or key > best[0]:
                    result = typed.copy()
                    result["use_profile"] = use_profile
                    result["final_correct"] = final_correct
                    best = (key, typed_weight, float(threshold), result)
        assert best is not None
        selected_by_type[event_type] = best[3]
        threshold_rows.append({
            "eventType": event_type,
            "typedWeight": best[1],
            "threshold": best[2],
            "correct": best[0][0],
            "overrides": -best[0][1],
        })

    selected = base_top.copy().set_index("attempt_id")
    selected["profile_location_override"] = False
    for event_type, typed in selected_by_type.items():
        typed = typed.set_index("attempt_id")
        attempts = selected.index.intersection(typed.index)
        override = typed.loc[attempts, "use_profile"]
        selected.loc[attempts, "final_correct"] = typed.loc[
            attempts, "final_correct"
        ]
        selected.loc[attempts, "profile_location_override"] = override
        override_attempts = attempts[override.to_numpy(dtype=bool)]
        selected.loc[override_attempts, "selected_candidate_year"] = typed.loc[
            override_attempts, "profile_year"
        ]
        selected.loc[override_attempts, "selected_candidate_source"] = (
            "fullYearProfile"
        )
    selected = selected.reset_index()
    event = selected[selected["family"] != "Clean"]
    baseline = base_top[base_top["family"] != "Clean"].set_index("attempt_id")
    final = event.set_index("attempt_id")
    summary = {
        "schemaVersion": 1,
        "files": int(table["cluster_id"].nunique()),
        "features": len(values.columns),
        "discordant": int(table["discordant"].sum()),
        "candidateOracleCorrect": int((
            table["base_correct"].astype(bool)
            | table["profile_correct"].astype(bool)
        ).sum()) + int(event[~event["event_type"].isin(LOCAL_EVENT_TYPES)][
            "final_correct"
        ].sum()),
        "baselineCorrect": int(baseline["final_correct"].sum()),
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneAccuracy": float(event["final_correct"].mean()),
        "wrongToCorrect": int((
            baseline["final_correct"].eq(0) & final["final_correct"].eq(1)
        ).sum()),
        "correctToWrong": int((
            baseline["final_correct"].eq(1) & final["final_correct"].eq(0)
        ).sum()),
        "cleanFalsePositives": int(selected[
            selected["family"].eq("Clean")
        ]["candidate_has_response"].sum()),
        "byFamily": {
            family: {
                "correct": int(group["final_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["final_correct"].mean()),
            }
            for family, group in event.groupby("family")
        },
    }
    table.to_pickle(output_dir / "profile-fusion-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-profile-fusion-top.csv", index=False)
    pd.DataFrame(threshold_rows).to_csv(
        output_dir / "profile-fusion-thresholds.csv", index=False
    )
    (output_dir / "feature-names.json").write_text(
        json.dumps(list(values.columns), indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
