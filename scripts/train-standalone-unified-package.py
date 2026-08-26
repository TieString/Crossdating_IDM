#!/usr/bin/env python3
"""Train a file-OOF standalone immutable-package adjudicator."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


FORBIDDEN = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "candidate_year",
    "operation_correct",
    "location_correct",
    "location_relevance",
    "location_error_years",
    "workflow_correct",
    "strict_correct",
}


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=700,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=28,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=6.0,
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
        min_child_samples=28,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=6.0,
        scale_pos_weight=min(40.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def encode(
    table: pd.DataFrame, feature_profile: str
) -> tuple[pd.DataFrame, list[str]]:
    columns = [column for column in table.columns if column not in FORBIDDEN]
    if feature_profile == "core":
        columns = [
            column for column in columns
            if not column.startswith("runtime_note__")
        ]
    raw = table[columns].copy()
    categorical = [
        column for column in raw.columns if raw[column].dtype == object
    ]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def clustered_lower_bound(
    selected: pd.DataFrame,
    repetitions: int,
    seed: int,
) -> float:
    files = np.array(sorted(selected["cluster_id"].unique()))
    if len(files) == 0:
        return 0.0
    grouped = {
        file_id: selected[selected["cluster_id"].eq(file_id)][
            "workflow_correct"
        ].to_numpy(dtype=float)
        for file_id in files
    }
    rng = np.random.default_rng(seed)
    values = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sampled = rng.choice(files, size=len(files), replace=True)
        outcomes = np.concatenate([grouped[file_id] for file_id in sampled])
        values[index] = outcomes.mean()
    return float(np.quantile(values, 0.05, method="lower"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tables", required=True, nargs="+")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--feature-profile", choices=("core", "full"), default="core")
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    table = pd.concat(
        [pd.read_pickle(Path(path).resolve()) for path in args.tables],
        ignore_index=True,
        sort=False,
    )
    table["cluster_id"] = (
        table["attempt_id"].str.split(":", n=1).str[0]
        + "|" + table["file_id"].astype(str)
    )
    values, feature_names = encode(table, args.feature_profile)
    files = np.array(sorted(table["cluster_id"].unique()))
    folds = min(5, len(files))
    if folds < 2:
        raise RuntimeError("standalone training requires at least two complete files")
    splitter = GroupKFold(n_splits=folds)
    rank_predictions = np.full(len(table), np.nan)
    classifier_predictions = np.full(len(table), np.nan)

    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train = table.index[~table["cluster_id"].isin(held_files)].to_numpy(dtype=int)
        test = table.index[table["cluster_id"].isin(held_files)].to_numpy(dtype=int)
        ordered = table.loc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = table.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        rank_model = ranker(61000 + fold)
        rank_model.fit(
            values.loc[ordered],
            table.loc[ordered, "workflow_correct"],
            group=groups,
        )
        rank_predictions[test] = rank_model.predict(values.loc[test])
        classifier_model = classifier(
            table.loc[train, "workflow_correct"], 61500 + fold
        )
        classifier_model.fit(
            values.loc[train], table.loc[train, "workflow_correct"]
        )
        classifier_predictions[test] = classifier_model.predict_proba(
            values.loc[test]
        )[:, 1]

    if np.isnan(rank_predictions).any() or np.isnan(classifier_predictions).any():
        raise RuntimeError("missing standalone package OOF predictions")
    table["rank_score"] = rank_predictions
    table["classifier_probability"] = classifier_predictions
    groups = table.groupby("attempt_id", sort=False)
    table["rank_percentile"] = groups["rank_score"].rank(pct=True)
    table["classifier_percentile"] = groups["classifier_probability"].rank(pct=True)

    selected_by_weight: dict[float, pd.DataFrame] = {}
    grid_rows = []
    for weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        score = (
            table["rank_percentile"] * (1 - weight)
            + table["classifier_percentile"] * weight
        )
        selected = table.assign(standalone_score=score).sort_values(
            ["attempt_id", "standalone_score"], ascending=[True, False]
        ).groupby("attempt_id", sort=False).head(1)
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
    eligible = grid[grid["cleanFalsePositives"].le(1)]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["eventCorrect", "eventStrictCorrect", "cleanFalsePositives"],
        ascending=[False, False, True],
    ).iloc[0]
    weight = float(best["classifierWeight"])
    selected = selected_by_weight[weight].copy()
    event = selected[selected["family"] != "Clean"]
    clean = selected[selected["family"] == "Clean"]
    by_family = {}
    for family, group in event.groupby("family"):
        by_family[family] = {
            "correct": int(group["workflow_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["workflow_correct"].mean()),
            "strictAccuracy": float(group["strict_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": clustered_lower_bound(
                group,
                args.bootstrap_repetitions,
                62000 + ord(family[0]),
            ),
        }
    product = table[table["candidate_source"].isin(
        ["productPrimary", "productAlternative"]
    )].groupby("attempt_id")["workflow_correct"].max()
    event_attempts = event["attempt_id"]
    summary = {
        "schemaVersion": 1,
        "files": int(table["cluster_id"].nunique()),
        "attempts": int(table["attempt_id"].nunique()),
        "eventAttempts": len(event),
        "candidateRows": len(table),
        "features": len(feature_names),
        "featureProfile": args.feature_profile,
        "classifierWeight": weight,
        "productPackageCorrect": int(product.reindex(event_attempts).fillna(0).sum()),
        "candidateOracleCorrect": int(
            table[table["family"] != "Clean"]
            .groupby("attempt_id")["workflow_correct"].max().sum()
        ),
        "standaloneCorrect": int(event["workflow_correct"].sum()),
        "standaloneAccuracy": float(event["workflow_correct"].mean()),
        "strictAccuracy": float(event["strict_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "cleanAttempts": len(clean),
        "overallOneSided95FileClusterLower": clustered_lower_bound(
            event, args.bootstrap_repetitions, 62999
        ),
        "byFamily": by_family,
    }
    table.to_pickle(output_dir / "standalone-package-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-package-top.csv", index=False)
    grid.to_csv(output_dir / "standalone-package-grid.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
