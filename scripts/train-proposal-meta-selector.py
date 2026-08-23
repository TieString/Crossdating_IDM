#!/usr/bin/env python3
"""Select complete hierarchical proposals using only file-OOF base predictions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


def model(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=350,
        learning_rate=0.025,
        num_leaves=11,
        min_child_samples=30,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.5,
        reg_lambda=4.0,
        scale_pos_weight=min(40.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def file_oof(values: pd.DataFrame, labels: pd.Series, files: pd.Series, seed: int) -> np.ndarray:
    unique_files = np.array(sorted(files.unique()))
    predictions = np.full(len(values), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(unique_files)),
        groups=unique_files,
    )):
        test_files = set(unique_files[test_file_indices])
        train = np.flatnonzero(~files.isin(test_files).to_numpy())
        test = np.flatnonzero(files.isin(test_files).to_numpy())
        estimator = model(labels.iloc[train], seed + fold)
        estimator.fit(values.iloc[train], labels.iloc[train])
        predictions[test] = estimator.predict_proba(values.iloc[test])[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("missing proposal meta OOF predictions")
    return predictions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--yearly-dir", required=True)
    parser.add_argument("--hierarchical-dir", required=True)
    parser.add_argument("--package-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    yearly_dir = Path(args.yearly_dir).resolve()
    hierarchical_dir = Path(args.hierarchical_dir).resolve()
    package_dir = Path(args.package_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    top = pd.read_csv(yearly_dir / "yearly-location-top.csv")
    location_scores = pd.read_csv(yearly_dir / "yearly-location-scores.csv")
    location_ranked = location_scores.sort_values(
        ["attempt_id", "location_score"],
        ascending=[True, False],
    )
    location_second = location_ranked.groupby("attempt_id")["location_score"].apply(
        lambda values: values.iloc[1] if len(values) > 1 else -10,
    )
    top["location_second_score"] = top["attempt_id"].map(location_second).fillna(-10)
    top["location_margin"] = top["location_score"] - top["location_second_score"]

    identities = pd.read_csv(hierarchical_dir / "operation-identities.csv")
    identity_ranked = identities.sort_values(
        ["attempt_id", "operation_probability"],
        ascending=[True, False],
    )
    operation_second = identity_ranked.groupby("attempt_id")[
        "operation_probability"
    ].apply(lambda values: values.iloc[1] if len(values) > 1 else -10)
    top["operation_second_score"] = top["attempt_id"].map(operation_second).fillna(-10)
    top["operation_margin"] = (
        top["operation_probability"] - top["operation_second_score"]
    )

    package = pd.read_csv(package_dir / "package-error-oof.csv")
    top = top.merge(
        package[["attempt_id", "package_error_probability"]],
        on="attempt_id",
        how="inner",
        validate="one_to_one",
    )
    top["proposal_correct"] = (
        top["operation_correct"].eq(1) & top["window_correct"].eq(1)
    )
    top["benefit"] = top["product_correct"].eq(0) & top["proposal_correct"]
    top["harm"] = top["product_correct"].eq(1) & ~top["proposal_correct"]

    forbidden = {
        "attempt_id",
        "file_id",
        "family",
        "product_correct",
        "operation_correct",
        "strict_operation_correct",
        "window_correct",
        "top_exact",
        "truth_year",
        "year",
        "proposal_correct",
        "benefit",
        "harm",
    }
    feature_columns = [column for column in top.columns if column not in forbidden]
    values = pd.get_dummies(
        top[feature_columns],
        columns=["event_type"],
        dtype=float,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(float)
    feature_names = list(values.columns)
    top["benefit_probability"] = file_oof(
        values,
        top["benefit"].astype(int),
        top["file_id"],
        28000,
    )
    top["harm_probability"] = file_oof(
        values,
        top["harm"].astype(int),
        top["file_id"],
        28100,
    )
    score_formulas = {
        "benefit": top["benefit_probability"],
        "benefit_times_safety": (
            top["benefit_probability"] * (1 - top["harm_probability"])
        ),
        "benefit_minus_harm": (
            top["benefit_probability"] - top["harm_probability"]
        ),
        "minimum_safety": np.minimum(
            top["benefit_probability"],
            1 - top["harm_probability"],
        ),
    }
    options = []
    for name, score in score_formulas.items():
        for event_type, group_indices in top.groupby("event_type").groups.items():
            selected_score = score.loc[group_indices]
            thresholds = sorted(set(
                np.linspace(float(selected_score.min()), float(selected_score.max()), 250).tolist()
                + selected_score.quantile(np.linspace(0, 1, 100)).tolist()
                + [float("inf")]
            ))
            for threshold in thresholds:
                chosen = selected_score >= threshold
                rows = top.loc[group_indices]
                harm = int((chosen & rows["harm"]).sum())
                benefit = int((chosen & rows["benefit"]).sum())
                if harm:
                    continue
                options.append({
                    "formula": name,
                    "eventType": event_type,
                    "threshold": threshold,
                    "benefit": benefit,
                    "selected": int(chosen.sum()),
                })
    selected_parts = []
    gates = {}
    for event_type in sorted(top["event_type"].unique()):
        choices = [option for option in options if option["eventType"] == event_type]
        best = max(
            choices,
            key=lambda option: (
                option["benefit"],
                -option["selected"],
                option["threshold"],
            ),
        )
        gates[event_type] = best
        score = score_formulas[best["formula"]]
        rows = top[top["event_type"] == event_type].copy()
        rows["selector_score"] = score.loc[rows.index]
        rows["selected"] = rows["selector_score"] >= best["threshold"]
        selected_parts.append(rows)
    selected = pd.concat(selected_parts, ignore_index=True)
    summary = {
        "schemaVersion": 1,
        "attempts": len(top),
        "features": len(feature_names),
        "proposalBenefits": int(top["benefit"].sum()),
        "selectedBenefits": int((selected["selected"] & selected["benefit"]).sum()),
        "selectedHarms": int((selected["selected"] & selected["harm"]).sum()),
        "selectedTotal": int(selected["selected"].sum()),
        "gates": gates,
    }
    selected.to_csv(output_dir / "proposal-meta-oof.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
