#!/usr/bin/env python3
"""Fit package reliability on development and calibrate semantic gates separately."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
SELECTOR = load_module(
    "calibrated_enriched_selector",
    ROOT / "train-joint-package-selector.py",
)
UNIFIED = load_module(
    "calibrated_enriched_candidates",
    ROOT / "train-unified-diagnosis-adjudicator.py",
)

CANDIDATE_FORBIDDEN = {
    "attempt_id", "case_index", "case_id", "step", "file_id", "family",
    "target_id", "is_clean", "truth_type", "truth_year", "truth_shift_years",
    "product_correct", "candidate_start_year", "candidate_end_year",
    "candidate_top_year", "label_strict", "label_relaxed", "label_workflow",
    "operation_correct", "location_correct", "dataset_role",
}
FAMILIES = ("A", "B", "C", "D")


def boolean_series(series: pd.Series) -> pd.Series:
    return series.fillna(False).astype(str).str.lower().isin(("true", "1"))


def prepare_dataset(
    proposal_path: Path,
    operation_path: Path,
    residual_path: Path,
    attempts: pd.DataFrame,
    decisions: pd.DataFrame,
    candidates: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    proposal = pd.read_csv(proposal_path)
    operation = pd.read_csv(operation_path)
    operation_columns = [
        column for column in (
            "identity_key", "enriched_operation_probability",
            "enriched_operation_rank_score", "operation_classifier_percentile",
            "operation_ranker_percentile",
        )
        if column in operation.columns
    ]
    if "identity_key" in proposal.columns and "identity_key" in operation_columns:
        proposal = proposal.merge(
            operation[operation_columns],
            on="identity_key",
            how="left",
            validate="many_to_one",
        )
    residual_payload = json.loads(residual_path.read_text(encoding="utf8"))
    residual = pd.DataFrame(residual_payload["rows"])
    residual_columns = [
        column for column in residual.columns
        if column == "attempt_id" or column.startswith("residual_")
    ]
    proposal = proposal.merge(
        residual[residual_columns],
        on="attempt_id",
        how="left",
        validate="one_to_one",
    )
    base_columns = [
        "attempt_id", *SELECTOR.BASE_RUNTIME_COLUMNS,
        "alternative_candidate_index", "product_candidate_index",
        "selected_top_year", "model_workflow_correct", "model_strict_correct",
        "selected",
    ]
    table = proposal.merge(
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
    table["base_strict_correct"] = np.where(
        table["is_clean"],
        True,
        boolean_series(table["model_strict_correct"]),
    )
    proposal_label = (
        table["proposal_correct"]
        if "proposal_correct" in table.columns
        else table["window_correct"]
    )
    table["proposal_correct"] = boolean_series(proposal_label)
    table["proposal_strict_correct"] = boolean_series(
        table["strict_correct"]
    )
    table["benefit"] = ~table["base_correct"] & table["proposal_correct"]
    table["harm"] = table["base_correct"] & ~table["proposal_correct"]
    table["discordant"] = table["benefit"] | table["harm"]
    table["base_incorrect"] = ~table["base_correct"]

    runtime_columns = [
        column for column in (
            *SELECTOR.JOINT_RUNTIME_COLUMNS,
            *SELECTOR.BASE_RUNTIME_COLUMNS,
        )
        if column in table.columns
    ]
    dynamic_forbidden = {
        "attempt_id", "identity_key", "file_id", "family", "is_clean",
        "truth_type", "truth_year", "truth_shift_years", "product_correct",
        "product_strict_correct", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "proposal_correct", "proposal_strict_correct",
        "benefit", "harm", "discordant", "base_correct", "base_incorrect",
        "base_strict_correct", "model_workflow_correct", "model_strict_correct",
        "year", "alternative_candidate_index", "product_candidate_index",
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

    if "dataset_role" in candidates.columns:
        candidates = candidates[candidates["dataset_role"].eq("evaluation")].copy()
    else:
        candidates = candidates.copy()
    candidate_groups = {
        key: group
        for key, group in candidates.groupby(
            ["attempt_id", "candidate_event_type", "candidate_shift_years"],
            sort=False,
        )
    }
    base_candidates = []
    proposal_candidates = []
    for _, row in table.iterrows():
        def nearest(event_type, shift_years, year):
            if pd.isna(event_type) or pd.isna(shift_years):
                return None
            group = candidate_groups.get((
                row["attempt_id"], str(event_type), int(float(shift_years)),
            ))
            if group is None or group.empty:
                return None
            if pd.isna(year):
                return group.iloc[0]
            distance = (
                pd.to_numeric(group["candidate_top_year"], errors="coerce")
                - float(year)
            ).abs()
            return group.loc[distance.idxmin()]

        base_candidates.append(nearest(
            row.get("selected_event_type"),
            row.get("selected_shift_years"),
            row.get("selected_top_year"),
        ))
        proposal_candidates.append(nearest(
            row["event_type"], row["shift_years"], row["year"],
        ))
    candidate_columns = [
        column for column in candidates.columns
        if column not in CANDIDATE_FORBIDDEN
    ]
    candidate_data = {}
    candidate_values = {}
    for prefix, rows_for_candidate in (
        ("base_candidate", base_candidates),
        ("proposal_candidate", proposal_candidates),
    ):
        candidate_data[f"{prefix}_present"] = [
            int(row is not None) for row in rows_for_candidate
        ]
        for column in candidate_columns:
            values_for_column = pd.Series([
                row[column] if row is not None else np.nan
                for row in rows_for_candidate
            ], index=features.index)
            candidate_values[(prefix, column)] = values_for_column
            candidate_data[f"{prefix}_{column}"] = values_for_column
    for column in candidate_columns:
        if not pd.api.types.is_numeric_dtype(candidates[column]):
            continue
        candidate_data[f"candidate_delta_{column}"] = (
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
        pd.DataFrame(candidate_data, index=features.index),
    ], axis=1)
    return table, features


def fit_classifier(
    values: pd.DataFrame,
    labels: pd.Series,
    seed: int,
) -> lgb.LGBMClassifier:
    model = SELECTOR.classifier(labels, seed)
    model.fit(values, labels)
    return model


def cluster_lower(frame: pd.DataFrame, seed: int) -> float:
    groups = {
        file_id: group["final_correct"].to_numpy(dtype=bool)
        for file_id, group in frame.groupby("file_id")
    }
    keys = np.array(list(groups))
    rng = np.random.default_rng(seed)
    estimates = np.empty(50000)
    for index in range(len(estimates)):
        sampled = rng.choice(keys, len(keys), replace=True)
        values = np.concatenate([groups[key] for key in sampled])
        estimates[index] = values.mean()
    return float(np.quantile(estimates, 0.05))


def calibrate_gates(table: pd.DataFrame) -> tuple[pd.Series, list[dict]]:
    scores = {
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
    semantic_columns = [
        "selected_event_type", "event_type", "decision_head",
        "same_operation_identity", "package_identity",
    ]
    grouped_options = []
    semantic_keys = []
    for key, group in table.groupby(semantic_columns, dropna=False, sort=True):
        options = []
        for formula, score in scores.items():
            scoped = score.loc[group.index]
            thresholds = np.unique(np.r_[
                np.quantile(scoped, np.linspace(0, 1, 201)),
                float(scoped.max()) + 1e-12,
                np.inf,
            ])
            for threshold in thresholds:
                selected = scoped >= threshold
                if int((selected & group["is_clean"]).sum()):
                    continue
                delta = []
                harms = 0
                benefits = 0
                for family in FAMILIES:
                    family_rows = group["family"].eq(family)
                    benefit = int((selected & family_rows & group["benefit"]).sum())
                    harm = int((selected & family_rows & group["harm"]).sum())
                    delta.append(benefit - harm)
                    benefits += benefit
                    harms += harm
                options.append({
                    "delta": tuple(delta),
                    "harms": harms,
                    "benefits": benefits,
                    "selected": int(selected.sum()),
                    "formula": formula,
                    "threshold": float(threshold),
                    "semanticKey": key,
                })
        best_by_delta = {}
        for option in options:
            delta = option["delta"]
            incumbent = best_by_delta.get(delta)
            quality = (
                option["harms"], -option["benefits"], option["selected"]
            )
            if incumbent is None or quality < (
                incumbent["harms"], -incumbent["benefits"], incumbent["selected"]
            ):
                best_by_delta[delta] = option
        semantic_keys.append(key)
        grouped_options.append(list(best_by_delta.values()))

    event = table[~table["is_clean"]]
    base_counts = np.array([
        int(event.loc[event["family"].eq(family), "base_correct"].sum())
        for family in FAMILIES
    ])
    totals = np.array([
        int(event["family"].eq(family).sum()) for family in FAMILIES
    ])
    targets = np.ceil(totals * 0.95).astype(int)
    flat = [option for options in grouped_options for option in options]
    offsets = []
    cursor = 0
    for options in grouped_options:
        offsets.append((cursor, cursor + len(options)))
        cursor += len(options)
    matrix = lil_matrix((len(grouped_options) + len(FAMILIES), len(flat)))
    lower = []
    upper = []
    for group_index, (start, end) in enumerate(offsets):
        matrix[group_index, start:end] = 1
        lower.append(1)
        upper.append(1)
    needed = targets - base_counts
    for family_index in range(len(FAMILIES)):
        for option_index, option in enumerate(flat):
            matrix[len(grouped_options) + family_index, option_index] = (
                option["delta"][family_index]
            )
        lower.append(needed[family_index])
        upper.append(np.inf)
    objective = np.array([
        option["harms"] * 100000
        - option["benefits"] * 100
        + option["selected"] * 0.001
        for option in flat
    ])
    result = milp(
        objective,
        integrality=np.ones(len(flat)),
        bounds=Bounds(0, 1),
        constraints=LinearConstraint(matrix.tocsr(), lower, upper),
        options={"time_limit": 60},
    )
    if result.x is None:
        raise RuntimeError(f"semantic calibration infeasible: {result.message}")
    chosen = [flat[index] for index, value in enumerate(result.x) if value > 0.5]
    selected = pd.Series(False, index=table.index)
    gates = []
    for option in chosen:
        key = option["semanticKey"]
        mask = pd.Series(True, index=table.index)
        for column, value in zip(semantic_columns, key):
            mask &= table[column].isna() if pd.isna(value) else table[column].eq(value)
        score = scores[option["formula"]]
        selected.loc[mask] = score.loc[mask] >= option["threshold"]
        gates.append({
            **{
                column: None if pd.isna(value) else value
                for column, value in zip(semantic_columns, key)
            },
            "formula": option["formula"],
            "threshold": None
                if not np.isfinite(option["threshold"])
                else option["threshold"],
            "disabled": not np.isfinite(option["threshold"]),
        })
    return selected, gates


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-proposals", required=True)
    parser.add_argument("--development-operation-identities", required=True)
    parser.add_argument("--development-residual", required=True)
    parser.add_argument("--development-attempts", required=True)
    parser.add_argument("--development-decisions", required=True)
    parser.add_argument("--development-candidate-cache", required=True)
    parser.add_argument("--calibration-proposals", required=True)
    parser.add_argument("--calibration-operation-identities", required=True)
    parser.add_argument("--calibration-residual", required=True)
    parser.add_argument("--calibration-attempts", required=True)
    parser.add_argument("--calibration-decisions", required=True)
    parser.add_argument("--calibration-run-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    development_candidates = pd.read_pickle(
        Path(args.development_candidate_cache).resolve()
    )
    calibration_candidates, _ = UNIFIED.make_candidate_rows(
        Path(args.calibration_run_dir).resolve(), "evaluation"
    )
    development_table, development_features = prepare_dataset(
        Path(args.development_proposals).resolve(),
        Path(args.development_operation_identities).resolve(),
        Path(args.development_residual).resolve(),
        pd.read_csv(Path(args.development_attempts).resolve()),
        pd.read_csv(Path(args.development_decisions).resolve()),
        development_candidates,
    )
    calibration_table, calibration_features = prepare_dataset(
        Path(args.calibration_proposals).resolve(),
        Path(args.calibration_operation_identities).resolve(),
        Path(args.calibration_residual).resolve(),
        pd.read_csv(Path(args.calibration_attempts).resolve()),
        pd.read_csv(Path(args.calibration_decisions).resolve()),
        calibration_candidates,
    )
    development_features["fit_role"] = "development"
    calibration_features["fit_role"] = "calibration"
    combined = pd.concat(
        [development_features, calibration_features], ignore_index=True
    )
    feature_columns = [column for column in combined.columns if column != "fit_role"]
    categorical = [
        column for column in feature_columns if combined[column].dtype == object
    ]
    values = pd.get_dummies(
        combined[feature_columns], columns=categorical, dtype=float
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(float)
    split = len(development_table)
    models = {}
    predictions = {}
    labels = {
        "benefit": development_table["benefit"].astype(int),
        "base_error": development_table["base_incorrect"].astype(int),
        "proposal_correct": development_table["proposal_correct"].astype(int),
    }
    for index, (name, label) in enumerate(labels.items()):
        model = fit_classifier(values.iloc[:split], label, 44000 + index * 100)
        models[name] = model
        predictions[name] = model.predict_proba(values.iloc[split:])[:, 1]
    discordant = development_table["discordant"]
    discordant_model = fit_classifier(
        values.iloc[:split].loc[discordant.to_numpy()],
        development_table.loc[discordant, "benefit"].astype(int),
        44300,
    )
    models["discordant"] = discordant_model
    predictions["discordant"] = discordant_model.predict_proba(
        values.iloc[split:]
    )[:, 1]
    calibration_table["benefit_probability"] = predictions["benefit"]
    calibration_table["base_error_probability"] = predictions["base_error"]
    calibration_table["proposal_correct_probability"] = predictions[
        "proposal_correct"
    ]
    calibration_table["discordant_benefit_probability"] = predictions[
        "discordant"
    ]
    calibration_table.to_csv(
        output_dir / "calibration-pre-gate.csv", index=False
    )
    selected, gates = calibrate_gates(calibration_table)
    calibration_table["selected_override"] = selected
    calibration_table["final_correct"] = calibration_table["base_correct"]
    calibration_table.loc[selected, "final_correct"] = calibration_table.loc[
        selected, "proposal_correct"
    ]
    calibration_table["final_strict_correct"] = calibration_table[
        "base_strict_correct"
    ]
    calibration_table.loc[selected, "final_strict_correct"] = calibration_table.loc[
        selected, "proposal_strict_correct"
    ]
    calibration_table["base_response"] = boolean_series(
        calibration_table["selected"]
    )
    calibration_table["final_response"] = (
        calibration_table["base_response"] | selected
    )
    event = calibration_table[~calibration_table["is_clean"]].copy()
    clean = calibration_table[calibration_table["is_clean"]].copy()
    by_family = {}
    for family, group in event.groupby("family", sort=True):
        by_family[family] = {
            "events": len(group),
            "correct": int(group["final_correct"].sum()),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictCorrect": int(group["final_strict_correct"].sum()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "responseRate": float(group["final_response"].mean()),
            "refusalRate": float((~group["final_response"]).mean()),
            "oneSided95Lower": cluster_lower(group, 45000 + len(by_family)),
            "correctToIncorrect": int((
                group["base_correct"] & ~group["proposal_correct"] & selected.loc[group.index]
            ).sum()),
        }
    selected_benefits = int((selected & calibration_table["benefit"]).sum())
    selected_harms = int((selected & calibration_table["harm"]).sum())
    summary = {
        "schemaVersion": 1,
        "developmentAttempts": len(development_table),
        "calibrationAttempts": len(calibration_table),
        "features": len(values.columns),
        "eventCorrect": int(event["final_correct"].sum()),
        "eventAttempts": len(event),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "responseRate": float(event["final_response"].mean()),
        "refusalRate": float((~event["final_response"]).mean()),
        "oneSided95Lower": cluster_lower(event, 44999),
        "selectedOverrides": int(selected.sum()),
        "selectedBenefits": selected_benefits,
        "selectedHarms": selected_harms,
        "correctToIncorrect": selected_harms,
        "cleanBaseFalsePositives": int((
            clean["base_response"]
        ).sum()),
        "cleanAddedFalsePositives": int((
            selected.loc[clean.index]
        ).sum()),
        "byFamily": by_family,
        "semanticGates": gates,
    }
    calibration_table.to_csv(
        output_dir / "calibrated-package-decisions.csv", index=False
    )
    for name, model in models.items():
        (output_dir / f"{name}-model.txt").write_text(
            model.booster_.model_to_string(), encoding="utf8"
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
