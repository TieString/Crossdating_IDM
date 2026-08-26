#!/usr/bin/env python3
"""Train file-OOF pairwise location recovery inside a fixed operation identity."""

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
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=700,
        learning_rate=0.02,
        num_leaves=15,
        min_child_samples=24,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=1.25,
        reg_lambda=6.0,
        scale_pos_weight=min(20.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def encode_location_rows(
    packages: pd.DataFrame,
    *,
    enable_relative_evidence: bool,
) -> tuple[pd.DataFrame, list[str]]:
    columns = [
        column for column in packages.columns
        if column in {
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
        }
        or column.startswith("context_")
        or column.startswith("runtime_source__")
        or column.startswith("geometry_")
        or column.startswith("bundle_")
        or (
            is_candidate_relative_evidence(column)
            if enable_relative_evidence
            else (
                column.startswith("evidence_")
                and not column.startswith("evidence_identity_")
            )
        )
    ]
    raw = packages[columns].copy()
    categorical = [column for column in raw.columns if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def anchor_index(
    group: pd.DataFrame,
    selected: pd.Series,
    typed_weight: float,
    classifier_weight: float,
) -> int:
    selected_year = selected.get("selected_candidate_year")
    selected_source = selected.get("selected_candidate_source")
    exact = group[
        group["candidate_source"].eq(selected_source)
        & group["candidate_year"].eq(selected_year)
    ]
    if not exact.empty:
        return int(exact.index[0])
    same_year = group[group["candidate_year"].eq(selected_year)]
    if not same_year.empty:
        return int(same_year.index[0])

    rank_score = (
        group["location_global_percentile"] * (1 - typed_weight)
        + group["location_typed_percentile"] * typed_weight
    )
    classifier_score = (
        group["location_global_classifier_percentile"] * (1 - typed_weight)
        + group["location_typed_classifier_percentile"] * typed_weight
    )
    score = (
        rank_score * (1 - classifier_weight)
        + classifier_score * classifier_weight
    )
    return int(score.fillna(-np.inf).idxmax())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--hierarchical-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--pair-target", choices=("window", "graded"), default="window"
    )
    parser.add_argument("--enable-relative-evidence", action="store_true")
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    hierarchical_path = Path(args.hierarchical_top).resolve()
    hierarchical = pd.read_csv(hierarchical_path)
    hierarchical_summary = json.loads(
        (hierarchical_path.parent / "summary.json").read_text(encoding="utf8")
    )
    typed_weight = float(
        hierarchical_summary.get("weights", {}).get("typedLocation", 0.5)
    )
    classifier_weight = float(
        hierarchical_summary.get("weights", {}).get("locationClassifier", 0.0)
    )
    hierarchical_by_attempt = hierarchical.set_index("attempt_id")
    packages = pd.read_pickle(Path(args.location_scores).resolve()).copy()
    packages = packages[packages["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    packages = packages.reset_index(drop=True)
    values, feature_names = encode_location_rows(
        packages,
        enable_relative_evidence=args.enable_relative_evidence,
    )
    pairs = []
    for identity_group, group in packages.groupby("identity_group", sort=False):
        if not bool(group["identity_operation_correct"].max()):
            continue
        selected = hierarchical_by_attempt.loc[group.iloc[0]["attempt_id"]]
        anchor = anchor_index(
            group,
            selected,
            typed_weight,
            classifier_weight,
        )
        for alternative in group.index:
            if alternative == anchor:
                continue
            pairs.append({
                "identity_group": identity_group,
                "attempt_id": group.iloc[0]["attempt_id"],
                "cluster_id": group.iloc[0]["cluster_id"],
                "file_id": group.iloc[0]["file_id"],
                "family": group.iloc[0]["family"],
                "event_type": group.iloc[0]["event_type"],
                "shift_years": int(group.iloc[0]["shift_years"]),
                "anchor_index": anchor,
                "alternative_index": int(alternative),
                "candidate_year_delta": float(
                    packages.loc[alternative, "candidate_year"]
                    - packages.loc[anchor, "candidate_year"]
                ),
                "anchor_correct": int(packages.loc[anchor, "workflow_correct"]),
                "alternative_correct": int(
                    packages.loc[alternative, "workflow_correct"]
                ),
                "anchor_error_years": packages.loc[
                    anchor, "location_error_years"
                ],
                "alternative_error_years": packages.loc[
                    alternative, "location_error_years"
                ],
                "alternative_candidate_year": packages.loc[
                    alternative, "candidate_year"
                ],
                "alternative_candidate_source": packages.loc[
                    alternative, "candidate_source"
                ],
            })
    pair_table = pd.DataFrame(pairs)
    pair_values = (
        values.loc[pair_table["alternative_index"]].reset_index(drop=True)
        - values.loc[pair_table["anchor_index"]].reset_index(drop=True)
    )
    pair_values.columns = [f"delta_{column}" for column in pair_values.columns]
    pair_values["pair_candidate_year_delta"] = pair_table[
        "candidate_year_delta"
    ].to_numpy(dtype=np.float32)
    pair_values["pair_candidate_year_absolute_delta"] = pair_table[
        "candidate_year_delta"
    ].abs().to_numpy(dtype=np.float32)
    pair_values["pair_candidate_year_direction"] = np.sign(
        pair_table["candidate_year_delta"].to_numpy(dtype=np.float32)
    )
    pair_values["pair_candidate_year_delta_per_shift"] = (
        pair_table["candidate_year_delta"]
        / pair_table["shift_years"].abs().clip(lower=1)
    ).to_numpy(dtype=np.float32)
    if args.pair_target == "graded":
        comparable = (
            pair_table["anchor_error_years"].notna()
            & pair_table["alternative_error_years"].notna()
            & pair_table["anchor_error_years"].ne(
                pair_table["alternative_error_years"]
            )
        )
        pair_table["alternative_better"] = (
            pair_table["alternative_error_years"]
            < pair_table["anchor_error_years"]
        ).astype(int)
        pair_table["discordant"] = comparable
    else:
        pair_table["alternative_better"] = (
            pair_table["alternative_correct"].eq(1)
            & pair_table["anchor_correct"].eq(0)
        ).astype(int)
        pair_table["discordant"] = pair_table["alternative_correct"].ne(
            pair_table["anchor_correct"]
        )
    files = np.array(sorted(pair_table["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    predictions = np.full(len(pair_table), np.nan)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        test = pair_table.index[
            pair_table["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        for offset, event_type in enumerate(sorted(LOCAL_EVENT_TYPES)):
            train = pair_table.index[
                ~pair_table["cluster_id"].isin(held_files)
                & pair_table["event_type"].eq(event_type)
                & pair_table["discordant"]
            ].to_numpy(dtype=int)
            typed_test = pair_table.index[
                pair_table.index.isin(test)
                & pair_table["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            model = classifier(
                pair_table.loc[train, "alternative_better"],
                81000 + fold * 10 + offset,
            )
            model.fit(
                pair_values.loc[train],
                pair_table.loc[train, "alternative_better"],
            )
            predictions[typed_test] = model.predict_proba(
                pair_values.loc[typed_test]
            )[:, 1]
    if np.isnan(predictions).any():
        raise RuntimeError("missing same-identity location pair predictions")
    pair_table["alternative_better_probability"] = predictions

    best_alternative = pair_table.sort_values(
        ["identity_group", "alternative_better_probability"],
        ascending=[True, False],
    ).groupby("identity_group", sort=False).head(1).copy()
    selected_by_type: dict[str, tuple[float, pd.DataFrame]] = {}
    threshold_rows = []
    for event_type in sorted(LOCAL_EVENT_TYPES):
        selected_type = hierarchical[
            hierarchical["event_type"].eq(event_type)
        ].copy()
        alternatives = best_alternative[
            best_alternative["event_type"].eq(event_type)
        ].set_index("identity_group")
        scores = selected_type["identity_group"].map(
            alternatives["alternative_better_probability"]
        )
        anchor_correct = selected_type["identity_group"].map(
            alternatives["anchor_correct"]
        )
        alternative_correct = selected_type["identity_group"].map(
            alternatives["alternative_correct"]
        )
        alternative_year = selected_type["identity_group"].map(
            alternatives["alternative_candidate_year"]
        )
        alternative_source = selected_type["identity_group"].map(
            alternatives["alternative_candidate_source"]
        )
        thresholds = sorted(set(
            scores.dropna().quantile(np.linspace(0, 1, 501)).astype(float).tolist()
            + [1.01]
        ))
        best = None
        for threshold in thresholds:
            use_alternative = scores.ge(threshold) & scores.notna()
            location_correct = anchor_correct.fillna(
                selected_type["final_correct"]
            ).astype(int)
            location_correct.loc[use_alternative] = alternative_correct[
                use_alternative
            ].astype(int)
            final_correct = location_correct.astype(int)
            key = (int(final_correct.sum()), -int(use_alternative.sum()))
            if best is None or key > best[0]:
                result = selected_type.copy()
                result["pair_location_correct"] = location_correct
                result["final_correct"] = final_correct
                result["pair_location_override"] = use_alternative
                result.loc[
                    use_alternative, "selected_candidate_year"
                ] = alternative_year[use_alternative]
                result.loc[
                    use_alternative, "selected_candidate_source"
                ] = alternative_source[use_alternative]
                best = (key, float(threshold), result)
        assert best is not None
        selected_by_type[event_type] = (best[1], best[2])
        threshold_rows.append({
            "eventType": event_type,
            "threshold": best[1],
            "correct": best[0][0],
            "overrides": -best[0][1],
        })

    selected = hierarchical.copy()
    selected["pair_location_override"] = False
    for event_type, (_, typed_selected) in selected_by_type.items():
        typed_selected = typed_selected.set_index("attempt_id")
        mask = selected["event_type"].eq(event_type)
        selected.loc[mask, "final_correct"] = selected.loc[
            mask, "attempt_id"
        ].map(typed_selected["final_correct"]).astype(int)
        selected.loc[mask, "pair_location_override"] = selected.loc[
            mask, "attempt_id"
        ].map(typed_selected["pair_location_override"]).fillna(False)
        selected.loc[mask, "selected_candidate_year"] = selected.loc[
            mask, "attempt_id"
        ].map(typed_selected["selected_candidate_year"])
        selected.loc[mask, "selected_candidate_source"] = selected.loc[
            mask, "attempt_id"
        ].map(typed_selected["selected_candidate_source"])
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
    summary = {
        "schemaVersion": 1,
        "files": int(pair_table["cluster_id"].nunique()),
        "pairs": len(pair_table),
        "discordantPairs": int(pair_table["discordant"].sum()),
        "features": len(feature_names),
        "pairTarget": args.pair_target,
        "thresholds": {
            row["eventType"]: row["threshold"] for row in threshold_rows
        },
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
    pair_table.to_pickle(output_dir / "location-pair-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-location-pair-top.csv", index=False)
    pd.DataFrame(threshold_rows).to_csv(
        output_dir / "location-pair-thresholds.csv", index=False
    )
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
