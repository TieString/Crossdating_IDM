#!/usr/bin/env python3
"""Rank keep/no-event/local immutable packages with file-level OOF isolation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SAFE_RUNTIME_COLUMNS = (
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
    "selected_start_year",
    "selected_end_year",
    "selected_top_year",
    "operation_overridden",
    "location_overridden",
    "decision_head",
)
SCORE_FORBIDDEN = {
    "attempt_id",
    "file_id",
    "family",
    "product_correct",
    "product_strict_correct",
    "truth_year",
    "operation_correct",
    "strict_operation_correct",
    "window_correct",
    "strict_correct",
    "top_exact",
    "year",
}
CANDIDATE_FORBIDDEN = {
    "attempt_id", "case_index", "case_id", "step", "file_id", "family",
    "target_id", "is_clean", "truth_type", "truth_year", "truth_shift_years",
    "product_correct", "candidate_start_year", "candidate_end_year",
    "candidate_top_year", "label_strict", "label_relaxed", "label_workflow",
    "operation_correct", "location_correct", "dataset_role",
}


def boolean(value: Any) -> bool:
    return str(value).lower() in ("true", "1")


def report_gate(gate: dict) -> dict:
    output = dict(gate)
    threshold = float(output["threshold"])
    output["threshold"] = threshold if np.isfinite(threshold) else None
    output["disabled"] = not np.isfinite(threshold)
    return output


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=550,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=30,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=5.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def pair_classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=30,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.5,
        reg_lambda=5.0,
        scale_pos_weight=min(60.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def nearest_profile(
    score_groups: dict[tuple[str, str, int], pd.DataFrame],
    attempt_id: str,
    event_type: str,
    shift_years: int,
    year: float | int | None,
) -> pd.Series | None:
    group = score_groups.get((attempt_id, event_type, int(shift_years)))
    if group is None or group.empty:
        return None
    if year is None or pd.isna(year):
        return group.sort_values("joint_score", ascending=False).iloc[0]
    distance = (group["year"] - float(year)).abs()
    return group.loc[distance.idxmin()]


def nearest_candidate(
    candidate_groups: dict[tuple[str, str, int], pd.DataFrame],
    attempt_id: str,
    event_type: str,
    shift_years: int,
    year: float | int | None,
) -> pd.Series | None:
    group = candidate_groups.get((attempt_id, event_type, int(shift_years)))
    if group is None or group.empty:
        return None
    if year is None or pd.isna(year):
        return group.iloc[0]
    distance = (
        pd.to_numeric(group["candidate_top_year"], errors="coerce") - float(year)
    ).abs()
    return group.loc[distance.idxmin()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scores", required=True)
    parser.add_argument("--safe-dir", required=True)
    parser.add_argument("--candidate-cache", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-correct-weight", type=float, default=1.0)
    parser.add_argument("--clean-weight", type=float, default=1.0)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    scores = pd.read_pickle(Path(args.scores).resolve())
    safe_dir = Path(args.safe_dir).resolve()
    attempts = pd.read_csv(safe_dir / "attempts.csv").set_index("attempt_id")
    decisions = pd.read_csv(safe_dir / "decisions.csv").set_index("attempt_id")
    candidates = pd.read_pickle(Path(args.candidate_cache).resolve())
    candidates = candidates[candidates["dataset_role"].eq("evaluation")].copy()
    score_groups = {
        key: group
        for key, group in scores.groupby(
            ["attempt_id", "event_type", "shift_years"], sort=False
        )
    }
    candidate_groups = {
        key: group
        for key, group in candidates.groupby(
            ["attempt_id", "candidate_event_type", "candidate_shift_years"],
            sort=False,
        )
    }
    identity_top = scores.sort_values(
        ["attempt_id", "event_type", "shift_years", "joint_score"],
        ascending=[True, True, True, False],
    ).groupby(
        ["attempt_id", "event_type", "shift_years"], as_index=False
    ).head(1)
    identity_by_attempt = {
        attempt_id: group
        for attempt_id, group in identity_top.groupby("attempt_id", sort=False)
    }
    score_feature_columns = [
        column for column in scores.columns if column not in SCORE_FORBIDDEN
    ]
    candidate_feature_columns = [
        column for column in candidates.columns if column not in CANDIDATE_FORBIDDEN
    ]

    records: list[dict[str, Any]] = []
    for attempt_id, attempt in attempts.iterrows():
        decision = decisions.loc[attempt_id]
        is_clean = boolean(attempt["is_clean"])
        base_correct = is_clean or boolean(decision["model_workflow_correct"])
        base_strict = is_clean or boolean(decision["model_strict_correct"])
        selected = boolean(decision["selected"])
        base_event_type = (
            str(decision["selected_event_type"])
            if selected and pd.notna(decision["selected_event_type"])
            else "noEvent"
        )
        base_shift = (
            int(float(decision["selected_shift_years"]))
            if selected and pd.notna(decision["selected_shift_years"])
            else 0
        )
        base_year = decision["selected_top_year"] if selected else None
        overridden = boolean(decision["overridden"])
        base_candidate_index = decision[
            "alternative_candidate_index" if overridden else "product_candidate_index"
        ]
        base_candidate = None
        if pd.notna(base_candidate_index):
            index = int(float(base_candidate_index))
            if index in candidates.index:
                base_candidate = candidates.loc[index]
        base_profile = nearest_profile(
            score_groups, attempt_id, base_event_type, base_shift, base_year
        )
        attempt_context = {
            f"context_{column}": decision[column]
            for column in SAFE_RUNTIME_COLUMNS
            if column in decision.index
        }

        def append_package(
            source: str,
            event_type: str,
            shift_years: int,
            year: float | int | None,
            profile: pd.Series | None,
            candidate: pd.Series | None,
            workflow_correct: bool,
            strict_correct: bool,
        ) -> None:
            record: dict[str, Any] = {
                "attempt_id": attempt_id,
                "file_id": attempt["file_id"],
                "family": attempt["family"],
                "is_clean": int(is_clean),
                "candidate_source": source,
                "candidate_is_base": int(source == "base"),
                "event_type": event_type,
                "shift_years": shift_years,
                "shift_abs": abs(shift_years),
                "candidate_has_response": int(event_type != "noEvent"),
                "candidate_year_present": int(year is not None and not pd.isna(year)),
                "workflow_correct": int(workflow_correct),
                "strict_correct": int(strict_correct),
                "base_correct": int(base_correct),
                "base_strict_correct": int(base_strict),
            }
            record.update(attempt_context)
            for column in score_feature_columns:
                record[f"yearly_{column}"] = (
                    profile[column]
                    if profile is not None and column in profile.index else np.nan
                )
            record["yearly_present"] = int(profile is not None)
            for column in candidate_feature_columns:
                record[f"candidate_{column}"] = (
                    candidate[column]
                    if candidate is not None and column in candidate.index else np.nan
                )
            record["candidate_evidence_present"] = int(candidate is not None)
            records.append(record)

        append_package(
            "base",
            base_event_type,
            base_shift,
            base_year,
            base_profile,
            base_candidate,
            base_correct,
            base_strict,
        )
        for _, proposal in identity_by_attempt.get(
            attempt_id, pd.DataFrame()
        ).iterrows():
            event_type = str(proposal["event_type"])
            shift_years = int(proposal["shift_years"])
            year = int(proposal["year"])
            proposal_candidate = nearest_candidate(
                candidate_groups,
                attempt_id,
                event_type,
                shift_years,
                year,
            )
            append_package(
                "proposal",
                event_type,
                shift_years,
                year,
                proposal,
                proposal_candidate,
                boolean(proposal["window_correct"]),
                boolean(proposal["strict_correct"]),
            )

    table = pd.DataFrame(records)
    base_rows = table[table["candidate_is_base"].eq(1)].set_index("attempt_id")
    numeric_columns = [
        column for column in table.columns
        if column.startswith(("yearly_", "candidate_"))
        and pd.api.types.is_numeric_dtype(table[column])
    ]
    delta_data = {}
    for column in numeric_columns:
        delta_data[f"delta_{column}"] = (
            pd.to_numeric(table[column], errors="coerce")
            - table["attempt_id"].map(
                pd.to_numeric(base_rows[column], errors="coerce")
            )
        )
    table = pd.concat([
        table,
        pd.DataFrame(delta_data, index=table.index),
    ], axis=1)
    forbidden = {
        "attempt_id", "file_id", "family", "is_clean", "workflow_correct",
        "strict_correct", "base_correct", "base_strict_correct",
    }
    feature_columns = [column for column in table.columns if column not in forbidden]
    raw_features = table[feature_columns].copy()
    categorical = [
        column for column in raw_features.columns
        if raw_features[column].dtype == object
    ]
    values = pd.get_dummies(raw_features, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    feature_names = list(values.columns)

    files = np.array(sorted(table["file_id"].unique()))
    predictions = np.full(len(table), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train = np.flatnonzero(~table["file_id"].isin(held_files).to_numpy())
        test = np.flatnonzero(table["file_id"].isin(held_files).to_numpy())
        ordered = table.iloc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = table.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        estimator = ranker(35000 + fold)
        estimator.fit(
            values.loc[ordered],
            table.loc[ordered, "workflow_correct"],
            group=groups,
            sample_weight=(
                np.where(
                    table.loc[ordered, "base_correct"].eq(1),
                    args.base_correct_weight,
                    1.0,
                )
                * np.where(
                    table.loc[ordered, "is_clean"].eq(1),
                    args.clean_weight,
                    1.0,
                )
            ),
        )
        predictions[test] = estimator.predict(values.iloc[test])
    if np.isnan(predictions).any():
        raise RuntimeError("missing immutable package OOF predictions")
    table["package_score"] = predictions

    proposal_mask = table["candidate_is_base"].eq(0)
    pair_benefit = table["base_correct"].eq(0) & table["workflow_correct"].eq(1)
    pair_harm = table["base_correct"].eq(1) & table["workflow_correct"].eq(0)
    pair_training_mask = proposal_mask & (pair_benefit | pair_harm)
    pair_predictions = np.full(len(table), np.nan)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train = np.flatnonzero((
            ~table["file_id"].isin(held_files)
            & pair_training_mask
        ).to_numpy())
        test = np.flatnonzero((
            table["file_id"].isin(held_files)
            & proposal_mask
        ).to_numpy())
        estimator = pair_classifier(pair_benefit.iloc[train].astype(int), 36000 + fold)
        estimator.fit(values.iloc[train], pair_benefit.iloc[train].astype(int))
        pair_predictions[test] = estimator.predict_proba(values.iloc[test])[:, 1]
    if np.isnan(pair_predictions[proposal_mask]).any():
        raise RuntimeError("missing immutable package pair OOF predictions")
    table["pair_score"] = pair_predictions

    ranked = table.sort_values(
        ["attempt_id", "package_score"], ascending=[True, False]
    )
    top = ranked.groupby("attempt_id", sort=False).head(1).copy()
    base_score = table[table["candidate_is_base"].eq(1)].set_index("attempt_id")[
        "package_score"
    ]
    best_alternative = table[table["candidate_is_base"].eq(0)].sort_values(
        ["attempt_id", "package_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    best_alternative["override_margin"] = (
        best_alternative["package_score"]
        - best_alternative["attempt_id"].map(base_score)
    )
    evaluation = best_alternative.copy()
    evaluation["benefit"] = (
        evaluation["base_correct"].eq(0)
        & evaluation["workflow_correct"].eq(1)
    )
    evaluation["harm"] = (
        evaluation["base_correct"].eq(1)
        & evaluation["workflow_correct"].eq(0)
    )
    evaluation["clean_false_positive"] = (
        evaluation["is_clean"].eq(1)
        & evaluation["candidate_has_response"].eq(1)
    )

    thresholds = sorted(set(
        evaluation["override_margin"].quantile(
            np.linspace(0, 1, 1001)
        ).astype(float).tolist()
        + [float(evaluation["override_margin"].max()) + 1e-12, float("inf")]
    ))
    options = []
    for threshold in thresholds:
        selected = evaluation["override_margin"] >= threshold
        harms = int((selected & evaluation["harm"]).sum())
        clean_false_positives = int((
            selected & evaluation["clean_false_positive"]
        ).sum())
        if harms or clean_false_positives:
            continue
        options.append({
            "threshold": threshold,
            "benefits": int((selected & evaluation["benefit"]).sum()),
            "selected": int(selected.sum()),
        })
    gate = max(
        options,
        key=lambda option: (
            option["benefits"], -option["selected"], option["threshold"]
        ),
    )
    evaluation["selected_override"] = (
        evaluation["override_margin"] >= gate["threshold"]
    )

    pair_evaluation = table[proposal_mask].sort_values(
        ["attempt_id", "pair_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    pair_evaluation["benefit"] = (
        pair_evaluation["base_correct"].eq(0)
        & pair_evaluation["workflow_correct"].eq(1)
    )
    pair_evaluation["harm"] = (
        pair_evaluation["base_correct"].eq(1)
        & pair_evaluation["workflow_correct"].eq(0)
    )
    pair_evaluation["clean_false_positive"] = pair_evaluation["is_clean"].eq(1)
    pair_options = []
    for threshold in sorted(set(
        pair_evaluation["pair_score"].quantile(
            np.linspace(0, 1, 1001)
        ).astype(float).tolist()
        + [float(pair_evaluation["pair_score"].max()) + 1e-12, float("inf")]
    )):
        selected = pair_evaluation["pair_score"] >= threshold
        harms = int((selected & pair_evaluation["harm"]).sum())
        clean_false_positives = int((
            selected & pair_evaluation["clean_false_positive"]
        ).sum())
        if harms or clean_false_positives:
            continue
        pair_options.append({
            "threshold": threshold,
            "benefits": int((selected & pair_evaluation["benefit"]).sum()),
            "selected": int(selected.sum()),
        })
    pair_gate = max(
        pair_options,
        key=lambda option: (
            option["benefits"], -option["selected"], option["threshold"]
        ),
    )
    pair_evaluation["selected_override"] = (
        pair_evaluation["pair_score"] >= pair_gate["threshold"]
    )
    selected_by_attempt = evaluation.set_index("attempt_id")["selected_override"]
    top["gate_selected_alternative"] = top["attempt_id"].map(
        selected_by_attempt
    ).fillna(False)
    base_event_correct = int((
        base_rows["base_correct"].eq(1) & base_rows["is_clean"].eq(0)
    ).sum())
    selected_benefits = int((
        evaluation["selected_override"] & evaluation["benefit"]
    ).sum())
    selected_harms = int((
        evaluation["selected_override"] & evaluation["harm"]
    ).sum())
    direct_event = top[top["family"] != "Clean"]
    direct_clean = top[top["family"] == "Clean"]
    direct_benefits = int((
        direct_event["base_correct"].eq(0)
        & direct_event["workflow_correct"].eq(1)
    ).sum())
    direct_harms = int((
        direct_event["base_correct"].eq(1)
        & direct_event["workflow_correct"].eq(0)
    ).sum())
    direct_clean_false_positives = int((
        direct_clean["candidate_has_response"].eq(1)
        & direct_clean["candidate_is_base"].eq(0)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "files": int(table["file_id"].nunique()),
        "attempts": int(table["attempt_id"].nunique()),
        "packageRows": len(table),
        "features": len(feature_names),
        "baseCorrectWeight": args.base_correct_weight,
        "cleanWeight": args.clean_weight,
        "baseEventCorrect": base_event_correct,
        "directEventCorrect": int(direct_event["workflow_correct"].sum()),
        "directEventAccuracy": float(direct_event["workflow_correct"].mean()),
        "directBenefits": direct_benefits,
        "directHarms": direct_harms,
        "directCleanFalsePositives": direct_clean_false_positives,
        "availableAlternativeBenefits": int(evaluation["benefit"].sum()),
        "gate": report_gate(gate),
        "selectedBenefits": selected_benefits,
        "selectedHarms": selected_harms,
        "selectedCleanFalsePositives": int((
            evaluation["selected_override"]
            & evaluation["clean_false_positive"]
        ).sum()),
        "finalEventCorrect": base_event_correct + selected_benefits - selected_harms,
        "finalEventAccuracy": (
            base_event_correct + selected_benefits - selected_harms
        ) / max(1, int((table["family"] != "Clean").groupby(table["attempt_id"]).first().sum())),
        "pairGate": report_gate(pair_gate),
        "pairAvailableBenefits": int(pair_evaluation["benefit"].sum()),
        "pairSelectedBenefits": int((
            pair_evaluation["selected_override"] & pair_evaluation["benefit"]
        ).sum()),
        "pairSelectedHarms": int((
            pair_evaluation["selected_override"] & pair_evaluation["harm"]
        ).sum()),
        "pairSelectedCleanFalsePositives": int((
            pair_evaluation["selected_override"]
            & pair_evaluation["clean_false_positive"]
        ).sum()),
    }
    top.to_csv(output_dir / "immutable-package-top.csv", index=False)
    evaluation.to_csv(output_dir / "immutable-package-overrides.csv", index=False)
    pair_evaluation.to_csv(output_dir / "immutable-package-pair-overrides.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
