#!/usr/bin/env python3
"""File-OOF all-pairs tournament for immutable same-identity packages."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from standalone_location_evidence import is_candidate_relative_evidence


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=750,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=28,
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


def encode(
    packages: pd.DataFrame,
    *,
    feature_set: str,
) -> tuple[pd.DataFrame, list[str]]:
    evidence_terms = (
        "score", "margin", "gain", "advantage", "support", "cusum",
        "contrast", "objective", "kernel", "vote", "percentile", "deficit",
    )

    def allowed(column: str) -> bool:
        if column in {
            "candidate_source", "event_type", "shift_years", "shift_abs",
            "candidate_has_response", "candidate_year_present",
            "context_reference_mode", "runtime_confidence",
            "location_global_score", "location_typed_score",
            "location_global_percentile", "location_typed_percentile",
            "location_global_classifier_probability",
            "location_typed_classifier_probability",
            "location_global_classifier_percentile",
            "location_typed_classifier_percentile",
        }:
            return True
        if column.startswith(("context_", "bundle_")):
            return True
        if feature_set == "full":
            return (
                column.startswith(("runtime_source__", "geometry_"))
                or (
                    column.startswith("evidence_")
                    and not column.startswith("evidence_identity_")
                )
            )
        if column.startswith("geometry_"):
            return any(term in column.lower() for term in (
                "rank_", "relative_", "distance", "gap_", "within_",
                "exact_", "modal_", "anchor_count",
            ))
        if column.startswith("runtime_source__"):
            return any(term in column.lower() for term in (
                "frontier", "staircase", "reference", "counterfactual",
                "partial", "false", "endpoint", "path", "consensus",
            ))
        return is_candidate_relative_evidence(column) and any(
            term in column.lower() for term in evidence_terms
        )

    columns = [
        column for column in packages
        if allowed(column)
    ]
    raw = packages[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)
    return values, list(values.columns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--hierarchical-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--feature-set", choices=("compact", "full"), default="compact")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    hierarchical_path = Path(args.hierarchical_top).resolve()
    hierarchical = pd.read_csv(hierarchical_path)
    summary = json.loads(
        (hierarchical_path.parent / "summary.json").read_text(encoding="utf8")
    )
    typed_weight = float(summary["weights"]["typedLocation"])
    classifier_weight = float(summary["weights"]["locationClassifier"])
    packages = pd.read_pickle(Path(args.location_scores).resolve()).copy()
    packages = packages[packages["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    packages = packages.reset_index(drop=True)
    rank_score = (
        packages["location_global_percentile"] * (1 - typed_weight)
        + packages["location_typed_percentile"] * typed_weight
    )
    classifier_score = (
        packages["location_global_classifier_percentile"] * (1 - typed_weight)
        + packages["location_typed_classifier_percentile"] * typed_weight
    )
    packages["existing_location_score"] = (
        rank_score * (1 - classifier_weight)
        + classifier_score * classifier_weight
    )
    values, feature_names = encode(packages, feature_set=args.feature_set)

    pair_records = []
    for identity_group, group in packages.groupby("identity_group", sort=False):
        if not bool(group["identity_operation_correct"].max()) or len(group) < 2:
            continue
        indices = group.index.to_numpy(dtype=int)
        for left in indices:
            for right in indices:
                if left == right:
                    continue
                pair_records.append({
                    "identity_group": identity_group,
                    "attempt_id": group.iloc[0]["attempt_id"],
                    "cluster_id": group.iloc[0]["cluster_id"],
                    "file_id": group.iloc[0]["file_id"],
                    "family": group.iloc[0]["family"],
                    "event_type": group.iloc[0]["event_type"],
                    "left_index": left,
                    "right_index": right,
                    "left_correct": int(packages.loc[left, "workflow_correct"]),
                    "right_correct": int(packages.loc[right, "workflow_correct"]),
                    "year_delta": float(
                        packages.loc[left, "candidate_year"]
                        - packages.loc[right, "candidate_year"]
                    ),
                })
    pairs = pd.DataFrame(pair_records)
    pair_values = (
        values.loc[pairs["left_index"]].reset_index(drop=True)
        - values.loc[pairs["right_index"]].reset_index(drop=True)
    )
    pair_values.columns = [f"delta_{column}" for column in pair_values]
    pair_values["pair_year_delta"] = pairs["year_delta"].to_numpy(np.float32)
    pair_values["pair_year_absolute_delta"] = pairs["year_delta"].abs().to_numpy(
        np.float32
    )
    pair_values["pair_year_direction"] = np.sign(
        pairs["year_delta"].to_numpy(np.float32)
    )
    pairs["left_better"] = (
        pairs["left_correct"].eq(1) & pairs["right_correct"].eq(0)
    ).astype(int)
    pairs["discordant"] = pairs["left_correct"].ne(pairs["right_correct"])

    files = np.array(sorted(pairs["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    predictions = np.full(len(pairs), np.nan)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
            train = pairs.index[
                ~pairs["cluster_id"].isin(held_files)
                & pairs["event_type"].eq(event_type)
                & pairs["discordant"]
            ].to_numpy(dtype=int)
            test = pairs.index[
                pairs["cluster_id"].isin(held_files)
                & pairs["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            model = classifier(
                pairs.loc[train, "left_better"], 99000 + fold * 10 + offset
            )
            model.fit(pair_values.loc[train], pairs.loc[train, "left_better"])
            predictions[test] = model.predict_proba(pair_values.loc[test])[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("missing location tournament OOF predictions")
    pairs["left_win_probability"] = predictions
    wins = pairs.groupby("left_index", sort=False)["left_win_probability"].agg(
        ["mean", "median", "min", "max", "std"]
    ).add_prefix("tournament_")
    packages = packages.join(wins)
    tournament_groups = packages.groupby("identity_group", sort=False)
    packages["tournament_percentile"] = tournament_groups[
        "tournament_mean"
    ].rank(pct=True)

    weights = (0.0, 0.25, 0.5, 0.75, 1.0)
    selections = {}
    grid_rows = []
    for tournament_weight in weights:
        location_score = (
            packages["existing_location_score"] * (1 - tournament_weight)
            + packages["tournament_percentile"] * tournament_weight
        )
        location_top = packages.assign(location_score=location_score).sort_values(
            ["identity_group", "location_score"], ascending=[True, False]
        ).groupby("identity_group", sort=False).head(1).set_index("identity_group")
        selected = hierarchical.copy()
        local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
        selected["location_correct"] = selected["identity_group"].map(
            location_top["location_correct"]
        )
        selected["selected_package_correct"] = selected["identity_group"].map(
            location_top["workflow_correct"]
        )
        selected.loc[local, "selected_candidate_year"] = selected.loc[
            local, "identity_group"
        ].map(location_top["candidate_year"])
        selected.loc[local, "selected_candidate_source"] = selected.loc[
            local, "identity_group"
        ].map(location_top["candidate_source"])
        selected["final_correct"] = selected["operation_correct"].astype(int)
        selected.loc[local, "final_correct"] = selected.loc[
            local, "selected_package_correct"
        ].fillna(0).astype(int)
        event = selected[selected["family"] != "Clean"]
        family_accuracy = {
            family: float(event[event["family"].eq(family)]["final_correct"].mean())
            for family in "ABCD"
        }
        grid_rows.append({
            "tournamentWeight": tournament_weight,
            "correct": int(event["final_correct"].sum()),
            "minimumFamilyAccuracy": min(family_accuracy.values()),
            **{f"accuracy{family}": value for family, value in family_accuracy.items()},
        })
        selections[tournament_weight] = selected
    grid = pd.DataFrame(grid_rows)
    best = grid.sort_values(
        ["minimumFamilyAccuracy", "correct"], ascending=[False, False]
    ).iloc[0]
    tournament_weight = float(best["tournamentWeight"])
    selected = selections[tournament_weight]
    event = selected[selected["family"] != "Clean"]
    baseline = hierarchical[hierarchical["family"] != "Clean"].set_index("attempt_id")
    final = event.set_index("attempt_id")
    result = {
        "schemaVersion": 1,
        "files": int(pairs["cluster_id"].nunique()),
        "pairs": len(pairs),
        "discordantPairs": int(pairs["discordant"].sum()),
        "features": len(feature_names),
        "featureSet": args.feature_set,
        "tournamentWeight": tournament_weight,
        "baselineCorrect": int(baseline["final_correct"].sum()),
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneAccuracy": float(event["final_correct"].mean()),
        "wrongToCorrect": int((
            baseline["final_correct"].eq(0) & final["final_correct"].eq(1)
        ).sum()),
        "correctToWrong": int((
            baseline["final_correct"].eq(1) & final["final_correct"].eq(0)
        ).sum()),
        "cleanFalsePositives": int(selected[selected["family"].eq("Clean")][
            "candidate_has_response"
        ].sum()),
        "byFamily": {
            family: {
                "correct": int(group["final_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["final_correct"].mean()),
            }
            for family, group in event.groupby("family")
        },
    }
    pairs.to_pickle(output_dir / "location-tournament-oof-pairs.pkl")
    packages.to_pickle(output_dir / "location-tournament-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-location-tournament-top.csv", index=False)
    grid.to_csv(output_dir / "location-tournament-grid.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **result}))


if __name__ == "__main__":
    main()
