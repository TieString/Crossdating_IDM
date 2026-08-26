#!/usr/bin/env python3
"""Train a file-OOF nonlinear location meta-head inside fixed identities."""

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
LABEL_COLUMNS = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "identity_group",
    "candidate_year",
    "operation_correct",
    "identity_operation_correct",
    "location_correct",
    "location_relevance",
    "location_error_years",
    "workflow_correct",
    "strict_correct",
}


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="rank_xendcg",
        metric="ndcg",
        eval_at=[1, 3],
        label_gain=[0, 1, 3, 7],
        n_estimators=900,
        learning_rate=0.015,
        num_leaves=31,
        min_child_samples=14,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.5,
        reg_lambda=8.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def encode(packages: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    columns = [
        column for column in packages.columns
        if column not in LABEL_COLUMNS
        and not column.startswith("runtime_note__")
        and (
            column in {
                "candidate_source",
                "event_type",
                "shift_years",
                "shift_abs",
                "candidate_has_response",
                "candidate_year_present",
                "context_reference_mode",
                "runtime_confidence",
                "location_global_score",
                "location_typed_score",
                "location_global_percentile",
                "location_typed_percentile",
                "location_global_classifier_probability",
                "location_typed_classifier_probability",
                "location_global_classifier_percentile",
                "location_typed_classifier_percentile",
            }
            or column.startswith("context_")
            or column.startswith("runtime_source__")
            or column.startswith("geometry_")
            or column.startswith("bundle_")
            or is_candidate_relative_evidence(column)
        )
    ]
    raw = packages[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--hierarchical-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    packages = pd.read_pickle(Path(args.location_scores).resolve()).copy()
    local = packages["event_type"].isin(LOCAL_EVENT_TYPES)
    packages = packages[local].copy().reset_index(drop=True)
    values, feature_names = encode(packages)
    files = np.array(sorted(packages["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    predictions = np.full(len(packages), np.nan)

    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
            train_mask = (
                ~packages["cluster_id"].isin(held_files)
                & packages["event_type"].eq(event_type)
                & packages["identity_operation_correct"].eq(1)
            )
            test_mask = (
                packages["cluster_id"].isin(held_files)
                & packages["event_type"].eq(event_type)
            )
            train = packages.index[train_mask].to_numpy(dtype=int)
            test = packages.index[test_mask].to_numpy(dtype=int)
            ordered = packages.loc[train].sort_values(
                "identity_group"
            ).index.to_numpy(dtype=int)
            groups = packages.loc[ordered].groupby(
                "identity_group", sort=False
            ).size().to_numpy()
            model = ranker(91000 + fold * 10 + offset)
            model.fit(
                values.loc[ordered],
                packages.loc[ordered, "location_relevance"],
                group=groups,
            )
            predictions[test] = model.predict(values.loc[test])

    if np.isnan(predictions).any():
        raise RuntimeError("missing standalone location meta OOF predictions")
    packages["location_meta_score"] = predictions
    groups = packages.groupby("identity_group", sort=False)
    packages["location_meta_percentile"] = groups[
        "location_meta_score"
    ].rank(pct=True)

    hierarchical_path = Path(args.hierarchical_top).resolve()
    hierarchical = pd.read_csv(hierarchical_path)
    summary = json.loads(
        (hierarchical_path.parent / "summary.json").read_text(encoding="utf8")
    )
    typed_weight = float(summary["weights"].get("typedLocation", 0))
    classifier_weight = float(summary["weights"].get("locationClassifier", 0))
    rank_score = (
        packages["location_global_percentile"] * (1 - typed_weight)
        + packages["location_typed_percentile"] * typed_weight
    )
    classifier_score = (
        packages["location_global_classifier_percentile"] * (1 - typed_weight)
        + packages["location_typed_classifier_percentile"] * typed_weight
    )
    packages["location_base_percentile"] = (
        rank_score * (1 - classifier_weight)
        + classifier_score * classifier_weight
    )

    selected = hierarchical.copy()
    grid_rows = []
    selected_by_type: dict[str, pd.DataFrame] = {}
    for event_type in sorted(LOCAL_EVENT_TYPES):
        typed_selected = hierarchical[
            hierarchical["event_type"].eq(event_type)
        ].copy()
        typed_packages = packages[packages["event_type"].eq(event_type)]
        best = None
        for weight in np.linspace(0, 1, 21):
            score = (
                typed_packages["location_base_percentile"] * (1 - weight)
                + typed_packages["location_meta_percentile"] * weight
            )
            top = (
                typed_packages.assign(location_score=score)
                .sort_values(
                    ["identity_group", "location_score"],
                    ascending=[True, False],
                )
                .groupby("identity_group", sort=False)
                .head(1)
                .set_index("identity_group")
            )
            location_correct = typed_selected["identity_group"].map(
                top["location_correct"]
            ).fillna(0).astype(int)
            final = (
                typed_selected["operation_correct"].astype(bool)
                & location_correct.astype(bool)
            ).astype(int)
            key = (int(final.sum()), -float(weight))
            grid_rows.append({
                "eventType": event_type,
                "metaWeight": float(weight),
                "correct": key[0],
            })
            if best is None or key > best[0]:
                result = typed_selected.copy()
                result["final_correct"] = final
                result["selected_candidate_year"] = result["identity_group"].map(
                    top["candidate_year"]
                )
                result["location_meta_weight"] = float(weight)
                best = (key, result)
        assert best is not None
        selected_by_type[event_type] = best[1]

    for event_type, typed_selected in selected_by_type.items():
        replacement = typed_selected.set_index("attempt_id")
        mask = selected["event_type"].eq(event_type)
        selected.loc[mask, "final_correct"] = selected.loc[
            mask, "attempt_id"
        ].map(replacement["final_correct"]).astype(int)
        selected.loc[mask, "selected_candidate_year"] = selected.loc[
            mask, "attempt_id"
        ].map(replacement["selected_candidate_year"])
        selected.loc[mask, "location_meta_weight"] = selected.loc[
            mask, "attempt_id"
        ].map(replacement["location_meta_weight"])

    event = selected[selected["family"] != "Clean"]
    clean = selected[selected["family"] == "Clean"]
    baseline = hierarchical[hierarchical["family"] != "Clean"].set_index("attempt_id")
    final = event.set_index("attempt_id")
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["final_correct"].mean()),
        }
        for family, group in event.groupby("family")
    }
    result_summary = {
        "schemaVersion": 1,
        "files": int(packages["cluster_id"].nunique()),
        "features": len(feature_names),
        "baselineCorrect": int(baseline["final_correct"].sum()),
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneAccuracy": float(event["final_correct"].mean()),
        "wrongToCorrect": int((
            baseline["final_correct"].eq(0) & final["final_correct"].eq(1)
        ).sum()),
        "correctToWrong": int((
            baseline["final_correct"].eq(1) & final["final_correct"].eq(0)
        ).sum()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "byFamily": by_family,
    }
    packages.to_pickle(output_dir / "location-meta-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-location-meta-top.csv", index=False)
    pd.DataFrame(grid_rows).to_csv(output_dir / "location-meta-grid.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(result_summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **result_summary}))


if __name__ == "__main__":
    main()
