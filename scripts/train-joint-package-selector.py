#!/usr/bin/env python3
"""Select a joint operation-year proposal without rewriting a correct immutable package."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold


JOINT_RUNTIME_COLUMNS = (
    "product_response",
    "cofecha_flagged",
    "reference_anchor_count",
    "primary_event_type",
    "primary_shift_years",
    "primary_score",
    "primary_score_margin",
    "event_type",
    "shift_years",
    "shift_abs",
    "operation_probability",
    "operation_rank",
    "operation_rank_reciprocal",
    "package_identity",
    "baseline_lag",
    "shift_baseline_distance",
    "year_fraction",
    "distance_from_operation_best",
    "distance_from_side_best",
    "rawCorrelation",
    "differenceCorrelation",
    "combinedCorrelation",
    "samplePairs",
    "differencePairs",
    "sideOlderAdvantage",
    "sideNewerAdvantage",
    "sideMinimumAdvantage",
    "sideStepScore",
    "correctedSideSupport",
    "localSideOlderAdvantage11",
    "localSideNewerAdvantage11",
    "localSideStepScore11",
    "localSideOlderAdvantage21",
    "localSideNewerAdvantage21",
    "localSideStepScore21",
    "localSideOlderAdvantage31",
    "localSideNewerAdvantage31",
    "localSideStepScore31",
    "olderSamplePairs",
    "newerSamplePairs",
    "olderDifferencePairs",
    "newerDifferencePairs",
    "rawGain",
    "differenceGain",
    "combinedGain",
    "operation_probability_deficit",
    "joint_score",
    "joint_margin",
    "blend_score",
    "blend_margin",
)
BASE_RUNTIME_COLUMNS = (
    "same_operation_identity",
    "is_product_package_member",
    "override_probability",
    "pair_probability",
    "alternative_probability",
    "product_probability",
    "score_name",
    "overridden",
    "selected_event_type",
    "selected_shift_years",
    "operation_overridden",
    "location_overridden",
    "decision_head",
)


def classifier(labels: pd.Series, seed: int, small: bool = False) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=320 if small else 450,
        learning_rate=0.025,
        num_leaves=7 if small else 15,
        min_child_samples=18 if small else 35,
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


def file_oof(
    values: pd.DataFrame,
    labels: pd.Series,
    files: pd.Series,
    seed: int,
    training_mask: pd.Series | None = None,
    small: bool = False,
) -> np.ndarray:
    unique_files = np.array(sorted(files.unique()))
    predictions = np.full(len(values), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(unique_files)), groups=unique_files
    )):
        test_files = set(unique_files[test_file_indices])
        train_mask = ~files.isin(test_files)
        if training_mask is not None:
            train_mask &= training_mask
        train = np.flatnonzero(train_mask.to_numpy())
        test = np.flatnonzero(files.isin(test_files).to_numpy())
        estimator = classifier(labels.iloc[train], seed + fold, small=small)
        estimator.fit(values.iloc[train], labels.iloc[train])
        predictions[test] = estimator.predict_proba(values.iloc[test])[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("missing joint package selector OOF predictions")
    return predictions


def boolean_series(series: pd.Series) -> pd.Series:
    return series.fillna(False).astype(str).str.lower().isin(("true", "1"))


def safe_auc(labels: pd.Series, scores: pd.Series) -> float | None:
    return float(roc_auc_score(labels, scores)) if labels.nunique() > 1 else None


def report_gate(gate: dict) -> dict:
    output = dict(gate)
    threshold = float(output["threshold"])
    output["threshold"] = threshold if np.isfinite(threshold) else None
    output["disabled"] = not np.isfinite(threshold)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--joint-top", required=True)
    parser.add_argument("--safe-dir", required=True)
    parser.add_argument("--candidate-cache")
    parser.add_argument("--operation-identities")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    joint = pd.read_csv(Path(args.joint_top).resolve())
    if args.operation_identities:
        operation_identities = pd.read_csv(
            Path(args.operation_identities).resolve()
        )
        operation_columns = [
            column for column in (
                "identity_key",
                "enriched_operation_probability",
                "enriched_operation_rank_score",
                "operation_classifier_percentile",
                "operation_ranker_percentile",
            )
            if column in operation_identities.columns
        ]
        if "identity_key" in operation_columns and "identity_key" in joint.columns:
            joint = joint.merge(
                operation_identities[operation_columns],
                on="identity_key",
                how="left",
                validate="many_to_one",
            )
    safe_dir = Path(args.safe_dir).resolve()
    attempts = pd.read_csv(safe_dir / "attempts.csv")
    decisions = pd.read_csv(safe_dir / "decisions.csv")
    base_columns = [
        "attempt_id",
        *BASE_RUNTIME_COLUMNS,
        "alternative_candidate_index",
        "product_candidate_index",
        "selected_top_year",
        "model_workflow_correct",
    ]
    table = joint.merge(
        attempts[["attempt_id", "is_clean"]],
        on="attempt_id",
        how="inner",
        validate="one_to_one",
    ).merge(
        decisions[[column for column in base_columns if column in decisions.columns]],
        on="attempt_id",
        how="left",
        validate="one_to_one",
    )
    table["is_clean"] = boolean_series(table["is_clean"])
    table["base_correct"] = np.where(
        table["is_clean"],
        True,
        boolean_series(table["model_workflow_correct"]),
    )
    proposal_label = (
        table["proposal_correct"]
        if "proposal_correct" in table.columns
        else table["window_correct"]
    )
    table["proposal_correct"] = boolean_series(proposal_label)
    table["benefit"] = ~table["base_correct"] & table["proposal_correct"]
    table["harm"] = table["base_correct"] & ~table["proposal_correct"]
    table["discordant"] = table["benefit"] | table["harm"]
    table["base_incorrect"] = ~table["base_correct"]

    runtime_columns = [
        column for column in (*JOINT_RUNTIME_COLUMNS, *BASE_RUNTIME_COLUMNS)
        if column in table.columns
    ]
    dynamic_forbidden = {
        "attempt_id", "identity_key", "file_id", "family", "is_clean",
        "truth_type", "truth_year", "truth_shift_years", "product_correct",
        "product_strict_correct", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "proposal_correct", "proposal_strict_correct",
        "benefit", "harm", "discordant", "base_correct", "base_incorrect",
        "model_workflow_correct", "year",
        "alternative_candidate_index", "product_candidate_index",
        "identity_product_candidate_index", "selected_start_year",
        "selected_end_year", "selected_top_year", "candidate_start_year",
        "candidate_end_year", "candidate_top_year",
    }
    runtime_columns.extend(
        column for column in table.columns
        if column not in dynamic_forbidden
        and column not in runtime_columns
        and not column.endswith((
            "_workflow", "_strict", "_relaxed", "_operation", "_location",
        ))
    )
    features = table[runtime_columns].copy()
    features["same_selected_operation"] = (
        table["event_type"].astype(str)
        == table["selected_event_type"].fillna("").astype(str)
    ).astype(int)
    features["selected_shift_distance"] = (
        pd.to_numeric(table["shift_years"], errors="coerce").fillna(0)
        - pd.to_numeric(table["selected_shift_years"], errors="coerce").fillna(0)
    ).abs()
    features["selected_window_distance"] = (
        pd.to_numeric(table["year"], errors="coerce").fillna(0)
        - pd.to_numeric(table["selected_top_year"], errors="coerce").fillna(0)
    ).abs()
    if args.candidate_cache:
        candidates = pd.read_pickle(Path(args.candidate_cache).resolve())
        candidates = candidates[candidates["dataset_role"].eq("evaluation")].copy()
        candidate_for_index = candidates
        candidate_groups = {
            key: group
            for key, group in candidates.groupby(
                ["attempt_id", "candidate_event_type", "candidate_shift_years"],
                sort=False,
            )
        }
        selected_candidates = []
        proposal_candidates = []
        for _, row in table.iterrows():
            decision_overridden = str(row.get("overridden", "false")).lower() in (
                "true", "1"
            )
            selected_index = row.get(
                "alternative_candidate_index"
                if decision_overridden else "product_candidate_index"
            )
            if selected_index is None or pd.isna(selected_index):
                selected_candidates.append(None)
            else:
                index = int(float(selected_index))
                selected_candidates.append(
                    candidate_for_index.loc[index]
                    if index in candidate_for_index.index else None
                )
            key = (
                row["attempt_id"],
                row["event_type"],
                int(row["shift_years"]),
            )
            group = candidate_groups.get(key)
            if group is None or group.empty:
                proposal_candidates.append(None)
            else:
                distance = (
                    pd.to_numeric(group["candidate_top_year"], errors="coerce")
                    - float(row["year"])
                ).abs()
                proposal_candidates.append(group.loc[distance.idxmin()])

        candidate_forbidden = {
            "attempt_id", "case_index", "case_id", "step", "file_id", "family",
            "target_id", "is_clean", "truth_type", "truth_year",
            "truth_shift_years", "product_correct", "candidate_start_year",
            "candidate_end_year", "candidate_top_year", "label_strict",
            "label_relaxed", "label_workflow", "operation_correct",
            "location_correct", "dataset_role",
        }
        candidate_columns = [
            column for column in candidates.columns
            if column not in candidate_forbidden
        ]
        candidate_feature_data: dict[str, list | pd.Series] = {}
        candidate_values: dict[tuple[str, str], pd.Series] = {}
        for prefix, rows in (
            ("base_candidate", selected_candidates),
            ("proposal_candidate", proposal_candidates),
        ):
            candidate_feature_data[f"{prefix}_present"] = [
                int(row is not None) for row in rows
            ]
            for column in candidate_columns:
                values_for_column = pd.Series([
                    row[column] if row is not None else np.nan
                    for row in rows
                ], index=features.index)
                candidate_values[(prefix, column)] = values_for_column
                candidate_feature_data[f"{prefix}_{column}"] = values_for_column
        numeric_candidate_columns = [
            column for column in candidate_columns
            if pd.api.types.is_numeric_dtype(candidates[column])
        ]
        for column in numeric_candidate_columns:
            candidate_feature_data[f"candidate_delta_{column}"] = (
                pd.to_numeric(
                    candidate_values[("proposal_candidate", column)],
                    errors="coerce",
                )
                - pd.to_numeric(
                    candidate_values[("base_candidate", column)],
                    errors="coerce",
                )
            )
        features = pd.concat([
            features,
            pd.DataFrame(candidate_feature_data, index=features.index),
        ], axis=1)
    categorical = [
        column for column in features.columns
        if features[column].dtype == object
    ]
    values = pd.get_dummies(features, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(float)
    feature_names = list(values.columns)

    table["benefit_probability"] = file_oof(
        values, table["benefit"].astype(int), table["file_id"], 33000
    )
    table["base_error_probability"] = file_oof(
        values, table["base_incorrect"].astype(int), table["file_id"], 33100
    )
    table["proposal_correct_probability"] = file_oof(
        values, table["proposal_correct"].astype(int), table["file_id"], 33200
    )
    table["discordant_benefit_probability"] = file_oof(
        values,
        table["benefit"].astype(int),
        table["file_id"],
        33300,
        training_mask=table["discordant"],
        small=True,
    )

    score_formulas = {
        "benefit": table["benefit_probability"],
        "factorized": (
            table["base_error_probability"]
            * table["proposal_correct_probability"]
        ),
        "discordant": table["discordant_benefit_probability"],
        "discordant_factorized": (
            table["discordant_benefit_probability"]
            * table["base_error_probability"]
            * table["proposal_correct_probability"]
        ),
        "minimum": pd.Series(np.minimum.reduce([
            table["discordant_benefit_probability"].to_numpy(),
            table["base_error_probability"].to_numpy(),
            table["proposal_correct_probability"].to_numpy(),
        ]), index=table.index),
    }
    gate_options = []
    for formula, score in score_formulas.items():
        for scope, indices in {
            "all": table.index,
            **{
                str(event_type): group.index
                for event_type, group in table.groupby("event_type", sort=True)
            },
        }.items():
            scoped = score.loc[indices]
            thresholds = sorted(set(
                scoped.quantile(np.linspace(0, 1, 501)).astype(float).tolist()
                + [float(scoped.max()) + 1e-12, float("inf")]
            ))
            rows = table.loc[indices]
            for threshold in thresholds:
                chosen = scoped >= threshold
                harms = int((chosen & rows["harm"]).sum())
                clean_false_positives = int((chosen & rows["is_clean"]).sum())
                if harms or clean_false_positives:
                    continue
                gate_options.append({
                    "formula": formula,
                    "scope": scope,
                    "threshold": threshold,
                    "benefits": int((chosen & rows["benefit"]).sum()),
                    "selected": int(chosen.sum()),
                })
    global_gate = max(
        (gate for gate in gate_options if gate["scope"] == "all"),
        key=lambda gate: (gate["benefits"], -gate["selected"], gate["threshold"]),
    )
    global_score = score_formulas[global_gate["formula"]]
    table["selected_global"] = global_score >= global_gate["threshold"]

    type_gates = {}
    selected_by_type = pd.Series(False, index=table.index)
    for event_type, group in table.groupby("event_type", sort=True):
        choices = [
            gate for gate in gate_options if gate["scope"] == str(event_type)
        ]
        best = max(
            choices,
            key=lambda gate: (gate["benefits"], -gate["selected"], gate["threshold"]),
        )
        type_gates[str(event_type)] = best
        score = score_formulas[best["formula"]]
        selected_by_type.loc[group.index] = score.loc[group.index] >= best["threshold"]
    table["selected_by_type"] = selected_by_type

    strategies = {}
    for name in ("selected_global", "selected_by_type"):
        selected = table[name]
        benefits = int((selected & table["benefit"]).sum())
        harms = int((selected & table["harm"]).sum())
        clean_false_positives = int((selected & table["is_clean"]).sum())
        base_correct = int(table["base_correct"].sum())
        strategies[name] = {
            "selected": int(selected.sum()),
            "benefits": benefits,
            "harms": harms,
            "cleanFalsePositives": clean_false_positives,
            "finalCorrect": base_correct + benefits - harms,
            "eventFinalAccuracy": (
                base_correct + benefits - harms - int(table["is_clean"].sum())
            ) / max(1, int((~table["is_clean"]).sum())),
        }
    summary = {
        "schemaVersion": 1,
        "attempts": len(table),
        "eventAttempts": int((~table["is_clean"]).sum()),
        "cleanAttempts": int(table["is_clean"].sum()),
        "features": len(feature_names),
        "baseEventCorrect": int((table["base_correct"] & ~table["is_clean"]).sum()),
        "availableBenefits": int(table["benefit"].sum()),
        "potentialHarms": int(table["harm"].sum()),
        "auc": {
            "benefit": safe_auc(table["benefit"], table["benefit_probability"]),
            "baseError": safe_auc(
                table["base_incorrect"], table["base_error_probability"]
            ),
            "proposalCorrect": safe_auc(
                table["proposal_correct"], table["proposal_correct_probability"]
            ),
            "discordantBenefit": safe_auc(
                table.loc[table["discordant"], "benefit"],
                table.loc[table["discordant"], "discordant_benefit_probability"],
            ),
        },
        "globalGate": report_gate(global_gate),
        "typeGates": {
            event_type: report_gate(gate)
            for event_type, gate in type_gates.items()
        },
        "strategies": strategies,
    }
    table.to_csv(output_dir / "joint-package-selector-oof.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
