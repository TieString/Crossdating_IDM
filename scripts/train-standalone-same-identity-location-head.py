#!/usr/bin/env python3
"""Train a file-OOF location head without changing the selected operation identity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


LABEL_COLUMNS = {
    "attempt_id",
    "file_id",
    "family",
    "is_clean",
    "workflow_correct",
    "strict_correct",
    "base_correct",
    "base_strict_correct",
}
LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def location_features(table: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    columns = [
        column for column in table.columns
        if column not in LABEL_COLUMNS
        and (
            column in {
                "candidate_source",
                "candidate_is_base",
                "event_type",
                "shift_years",
                "shift_abs",
                "candidate_year_present",
            }
            or (
                column.startswith("yearly_")
                and "identity_aggregate_" not in column
            )
        )
    ]
    raw = table[columns].copy()
    categorical = [
        column for column in raw.columns if raw[column].dtype == object
    ]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=650,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=24,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.0,
        reg_lambda=5.0,
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
        n_estimators=650,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=24,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.0,
        reg_lambda=5.0,
        scale_pos_weight=min(30.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-table", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    table = pd.read_pickle(Path(args.package_table).resolve()).copy()
    table = table[table["event_type"].isin(LOCAL_EVENT_TYPES)].copy().reset_index(
        drop=True
    )
    table["identity_group"] = (
        table["attempt_id"].astype(str)
        + "|" + table["event_type"].astype(str)
        + "|" + table["shift_years"].astype(int).astype(str)
    )
    values, feature_names = location_features(table)
    files = np.array(sorted(table["file_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    rank_predictions = np.full(len(table), np.nan)
    classifier_predictions = np.full(len(table), np.nan)

    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train_mask = ~table["file_id"].isin(held_files)
        test_mask = table["file_id"].isin(held_files)
        train = table.index[train_mask].to_numpy(dtype=int)
        test = table.index[test_mask].to_numpy(dtype=int)
        ordered = table.loc[train].sort_values("identity_group").index.to_numpy(dtype=int)
        groups = table.loc[ordered].groupby("identity_group", sort=False).size().to_numpy()

        rank_model = ranker(51000 + fold)
        rank_model.fit(
            values.loc[ordered],
            table.loc[ordered, "workflow_correct"],
            group=groups,
        )
        rank_predictions[test] = rank_model.predict(values.loc[test])

        fold_predictions = []
        for offset in range(3):
            model = classifier(
                table.loc[train, "workflow_correct"],
                51500 + fold * 10 + offset,
            )
            model.fit(values.loc[train], table.loc[train, "workflow_correct"])
            fold_predictions.append(model.predict_proba(values.loc[test])[:, 1])
        classifier_predictions[test] = np.mean(np.stack(fold_predictions), axis=0)

    if np.isnan(rank_predictions).any() or np.isnan(classifier_predictions).any():
        raise RuntimeError("missing same-identity location OOF predictions")

    table["location_rank_score"] = rank_predictions
    table["location_classifier_probability"] = classifier_predictions
    groups = table.groupby("identity_group", sort=False)
    table["location_rank_percentile"] = groups["location_rank_score"].rank(pct=True)
    table["location_classifier_percentile"] = groups[
        "location_classifier_probability"
    ].rank(pct=True)

    operation_top = pd.read_csv(Path(args.operation_top).resolve())
    operation_top["identity_group"] = (
        operation_top["attempt_id"].astype(str)
        + "|" + operation_top["event_type"].astype(str)
        + "|" + operation_top["shift_years"].astype(int).astype(str)
    )
    selected_by_weight: dict[float, pd.DataFrame] = {}
    grid_rows = []
    for weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        scores = (
            table["location_rank_percentile"] * (1 - weight)
            + table["location_classifier_percentile"] * weight
        )
        identity_top = table.assign(location_score=scores).sort_values(
            ["identity_group", "location_score"], ascending=[True, False]
        ).groupby("identity_group", sort=False).head(1)
        location_by_identity = identity_top.set_index("identity_group")
        selected = operation_top.copy()
        replacements = selected["identity_group"].map(
            location_by_identity["workflow_correct"]
        )
        strict_replacements = selected["identity_group"].map(
            location_by_identity["strict_correct"]
        )
        replaceable = replacements.notna()
        selected.loc[replaceable, "workflow_correct"] = replacements[replaceable].astype(int)
        selected.loc[replaceable, "strict_correct"] = strict_replacements[
            replaceable
        ].astype(int)
        selected["location_head_used"] = replaceable
        event = selected[selected["family"] != "Clean"]
        clean = selected[selected["family"] == "Clean"]
        grid_rows.append({
            "classifierWeight": weight,
            "eventCorrect": int(event["workflow_correct"].sum()),
            "eventStrictCorrect": int(event["strict_correct"].sum()),
            "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        })
        selected_by_weight[weight] = selected

    grid = pd.DataFrame(grid_rows)
    eligible = grid[grid["cleanFalsePositives"].eq(0)]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["eventCorrect", "eventStrictCorrect", "cleanFalsePositives"],
        ascending=[False, False, True],
    ).iloc[0]
    weight = float(best["classifierWeight"])
    selected = selected_by_weight[weight]
    event = selected[selected["family"] != "Clean"]
    baseline_event = operation_top[operation_top["family"] != "Clean"]
    transitions = pd.crosstab(
        baseline_event["workflow_correct"].astype(int),
        event["workflow_correct"].astype(int),
    )
    by_family = {
        family: {
            "correct": int(group["workflow_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["workflow_correct"].mean()),
        }
        for family, group in event.groupby("family")
    }
    summary = {
        "schemaVersion": 1,
        "files": int(table["file_id"].nunique()),
        "operationAttempts": len(operation_top),
        "locationCandidates": len(table),
        "features": len(feature_names),
        "classifierWeight": weight,
        "baselineCorrect": int(baseline_event["workflow_correct"].sum()),
        "standaloneCorrect": int(event["workflow_correct"].sum()),
        "standaloneAccuracy": float(event["workflow_correct"].mean()),
        "correctToWrong": int(transitions.get(0, pd.Series()).get(1, 0)),
        "wrongToCorrect": int(transitions.get(1, pd.Series()).get(0, 0)),
        "byFamily": by_family,
    }
    table.to_pickle(output_dir / "same-identity-location-scores.pkl")
    selected.to_csv(output_dir / "standalone-location-top.csv", index=False)
    grid.to_csv(output_dir / "location-head-grid.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
