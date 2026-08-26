#!/usr/bin/env python3
"""Factor location ranking into within-source and cross-source OOF heads."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
LABEL_COLUMNS = {
    "attempt_id", "cluster_id", "file_id", "family", "is_clean",
    "identity_group", "candidate_year", "operation_correct",
    "identity_operation_correct", "location_correct", "location_relevance",
    "location_error_years", "package_relevance", "workflow_correct",
    "strict_correct",
}


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="rank_xendcg",
        metric="ndcg",
        label_gain=[0, 1, 3, 7],
        n_estimators=700,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=24,
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


def classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=700,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=24,
        subsample=0.9,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=8.0,
        scale_pos_weight=min(20.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def feature_columns(packages: pd.DataFrame) -> list[str]:
    return [
        column for column in packages
        if column not in LABEL_COLUMNS
        and not column.startswith("runtime_note__")
        and (
            column in {
                "candidate_source", "event_type", "shift_years", "shift_abs",
                "candidate_has_response", "candidate_year_present",
                "context_reference_mode", "runtime_confidence",
                "location_global_score", "location_typed_score",
                "location_global_percentile", "location_typed_percentile",
                "location_global_classifier_probability",
                "location_typed_classifier_probability",
                "location_global_classifier_percentile",
                "location_typed_classifier_percentile",
                "source_location_global_score", "source_location_typed_score",
                "source_location_global_percentile",
                "source_location_typed_percentile",
                "source_typed_weight",
            }
            or column.startswith("context_")
            or column.startswith("runtime_source__")
            or column.startswith("geometry_")
            or column.startswith("bundle_")
            or (
                column.startswith("evidence_")
                and not column.startswith("evidence_identity_")
            )
        )
    ]


def encode(packages: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    raw = packages[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    return pd.get_dummies(raw, columns=categorical, dtype=float).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)


def fit_oof_heads(
    packages: pd.DataFrame,
    values: pd.DataFrame,
    files: np.ndarray,
    *,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    global_predictions = np.full(len(packages), np.nan)
    typed_predictions = np.full(len(packages), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train_mask = (
            ~packages["cluster_id"].isin(held_files)
            & packages["identity_operation_correct"].eq(1)
        )
        test_mask = packages["cluster_id"].isin(held_files)
        train = packages.index[train_mask].to_numpy(dtype=int)
        ordered = packages.loc[train].sort_values(
            "identity_group"
        ).index.to_numpy(dtype=int)
        groups = packages.loc[ordered].groupby(
            "identity_group", sort=False
        ).size().to_numpy()
        global_model = ranker(seed + fold * 20)
        global_model.fit(
            values.loc[ordered], packages.loc[ordered, "package_relevance"],
            group=groups,
        )
        test = packages.index[test_mask].to_numpy(dtype=int)
        global_predictions[test] = global_model.predict(values.loc[test])
        for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
            typed_train = packages.index[
                train_mask & packages["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            typed_ordered = packages.loc[typed_train].sort_values(
                "identity_group"
            ).index.to_numpy(dtype=int)
            typed_groups = packages.loc[typed_ordered].groupby(
                "identity_group", sort=False
            ).size().to_numpy()
            typed_model = ranker(seed + fold * 20 + 5 + offset)
            typed_model.fit(
                values.loc[typed_ordered],
                packages.loc[typed_ordered, "package_relevance"],
                group=typed_groups,
            )
            typed_test = packages.index[
                test_mask & packages["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            typed_predictions[typed_test] = typed_model.predict(
                values.loc[typed_test]
            )
    return global_predictions, typed_predictions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--hierarchical-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    hierarchical = pd.read_csv(Path(args.hierarchical_top).resolve())
    packages = pd.read_pickle(Path(args.location_scores).resolve()).copy()
    packages = packages[packages["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    packages = packages.reset_index(drop=True)
    files = np.array(sorted(packages["cluster_id"].unique()))

    enriched = packages[packages["candidate_source"].eq("enrichedProposal")].copy()
    enriched = enriched.reset_index().rename(columns={"index": "package_index"})
    enriched_values = encode(enriched, feature_columns(enriched))
    source_global, source_typed = fit_oof_heads(
        enriched, enriched_values, files, seed=100000
    )
    if np.isnan(source_global).any() or np.isnan(source_typed).any():
        raise RuntimeError("missing within-source OOF predictions")
    enriched["source_location_global_score"] = source_global
    enriched["source_location_typed_score"] = source_typed
    source_groups = enriched.groupby("identity_group", sort=False)
    enriched["source_location_global_percentile"] = source_groups[
        "source_location_global_score"
    ].rank(pct=True)
    enriched["source_location_typed_percentile"] = source_groups[
        "source_location_typed_score"
    ].rank(pct=True)

    reduced_parts = [packages[packages["candidate_source"].ne("enrichedProposal")]]
    for typed_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        score = (
            enriched["source_location_global_percentile"] * (1 - typed_weight)
            + enriched["source_location_typed_percentile"] * typed_weight
        )
        top = enriched.assign(_source_score=score).sort_values(
            ["identity_group", "_source_score"], ascending=[True, False]
        ).groupby("identity_group", sort=False).head(1).copy()
        top["source_typed_weight"] = typed_weight
        reduced_parts.append(top[packages.columns.intersection(top.columns).tolist() + [
            column for column in (
                "source_location_global_score", "source_location_typed_score",
                "source_location_global_percentile",
                "source_location_typed_percentile", "source_typed_weight",
            ) if column in top
        ]])
    reduced = pd.concat(reduced_parts, ignore_index=True, sort=False).drop_duplicates(
        ["identity_group", "candidate_source", "candidate_year"], keep="last"
    ).reset_index(drop=True)
    reduced_values = encode(reduced, feature_columns(reduced))
    global_scores, typed_scores = fit_oof_heads(
        reduced, reduced_values, files, seed=101000
    )
    if np.isnan(global_scores).any() or np.isnan(typed_scores).any():
        raise RuntimeError("missing cross-source OOF predictions")
    reduced["factorized_global_score"] = global_scores
    reduced["factorized_typed_score"] = typed_scores
    reduced_groups = reduced.groupby("identity_group", sort=False)
    reduced["factorized_global_percentile"] = reduced_groups[
        "factorized_global_score"
    ].rank(pct=True)
    reduced["factorized_typed_percentile"] = reduced_groups[
        "factorized_typed_score"
    ].rank(pct=True)

    selections = {}
    grid_rows = []
    for typed_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        score = (
            reduced["factorized_global_percentile"] * (1 - typed_weight)
            + reduced["factorized_typed_percentile"] * typed_weight
        )
        location_top = reduced.assign(_score=score).sort_values(
            ["identity_group", "_score"], ascending=[True, False]
        ).groupby("identity_group", sort=False).head(1).set_index("identity_group")
        selected = hierarchical.copy()
        local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
        selected["selected_package_correct"] = selected["identity_group"].map(
            location_top["workflow_correct"]
        )
        selected["location_correct"] = selected["identity_group"].map(
            location_top["location_correct"]
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
            "typedWeight": typed_weight,
            "correct": int(event["final_correct"].sum()),
            "minimumFamilyAccuracy": min(family_accuracy.values()),
            **{f"accuracy{family}": value for family, value in family_accuracy.items()},
        })
        selections[typed_weight] = selected
    grid = pd.DataFrame(grid_rows)
    best = grid.sort_values(
        ["minimumFamilyAccuracy", "correct"], ascending=[False, False]
    ).iloc[0]
    typed_weight = float(best["typedWeight"])
    selected = selections[typed_weight]
    event = selected[selected["family"] != "Clean"]
    baseline = hierarchical[hierarchical["family"] != "Clean"].set_index("attempt_id")
    final = event.set_index("attempt_id")
    summary = {
        "schemaVersion": 1,
        "files": int(packages["cluster_id"].nunique()),
        "enrichedRows": len(enriched),
        "reducedRows": len(reduced),
        "typedWeight": typed_weight,
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
    enriched.to_pickle(output_dir / "within-source-oof-scores.pkl")
    reduced.to_pickle(output_dir / "cross-source-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-source-factorized-top.csv", index=False)
    grid.to_csv(output_dir / "source-factorized-grid.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
