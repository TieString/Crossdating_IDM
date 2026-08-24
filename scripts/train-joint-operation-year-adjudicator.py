#!/usr/bin/env python3
"""Rank immutable operation identity x yearly location hypotheses with file OOF."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


BASE_PROFILE_FIELDS = (
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
)
NESTED_PROFILE_FIELDS = {
    "rawTransition": (
        "olderLag", "newerLag", "localOlderLag", "localNewerLag",
        "splitGain", "normalizedSplitGain", "balancedAdvantage",
        "olderMeanAdvantage", "newerMeanAdvantage", "localGain31",
        "localBalancedAdvantage31", "samplePairs",
    ),
    "cofechaTransition": (
        "olderLag", "newerLag", "localOlderLag", "localNewerLag",
        "splitGain", "normalizedSplitGain", "balancedAdvantage",
        "olderMeanAdvantage", "newerMeanAdvantage", "localGain31",
        "localBalancedAdvantage31", "samplePairs",
    ),
    "cumulative": (
        "combinedCumulative", "combinedCusum", "combinedContrast",
        "combinedLocal31", "combinedLocal61", "rawCumulative", "rawCusum",
        "rawContrast", "differenceCumulative", "differenceCusum",
        "differenceContrast", "whitenedCumulative", "whitenedCusum",
        "whitenedContrast", "cofechaCumulative", "cofechaCusum",
        "cofechaContrast", "referenceMedianCumulative",
        "referenceMedianCusum", "referenceMedianContrast",
        "referenceMeanCumulative", "referenceMeanCusum",
        "referenceMeanContrast", "referenceVoteCumulative",
        "referenceVoteCusum", "referenceVoteContrast",
    ),
    "piecewise": (
        "combinedObjective", "combinedGain", "rawObjective",
        "cofechaObjective", "whitenedObjective", "differenceObjective",
        "rawGain", "cofechaGain", "whitenedGain", "differenceGain",
        "olderPairs", "newerPairs",
    ),
    "referenceChange": (
        "referenceCount", "meanPercentile", "medianPercentile",
        "meanStandardizedObjective", "supportFraction", "weightedSupport",
        "meanGain", "positiveGainFraction",
    ),
    "referenceTransition": (
        "referenceCount", "rankMean", "rankMedian", "weightedRankMean",
        "peakKernel5", "peakKernel9", "peakKernel13", "windowVote25",
        "weightedWindowVote25", "positiveGainFraction",
        "baselineModeFraction",
    ),
    "perReference": (
        "referenceCount", "differenceWeighted", "differenceGainWeighted",
        "whitenedMean", "whitenedGainMean", "positiveDifferenceGainFraction",
        "positiveWhitenedGainFraction", "positiveSideStepFraction",
        "peakKernel5", "peakKernel9", "lagStepWeighted", "lagStepMedian",
        "lagStepPositiveFraction", "lagStepPeakKernel5", "lagStepPeakKernel9",
        "fixedLagStepWeighted", "fixedLagStepMedian",
        "fixedLagStepPositiveFraction", "fixedLagStepPeakKernel5",
        "fixedLagStepPeakKernel9",
    ),
    "boundaryLocal": (
        "olderAdvantage3", "newerAdvantage3", "stepMinimum3", "stepMean3",
        "olderAdvantage5", "newerAdvantage5", "stepMinimum5", "stepMean5",
        "olderAdvantage9", "newerAdvantage9", "stepMinimum9", "stepMean9",
    ),
    "partialLocal": (
        "raw31", "difference31", "whitened31", "combo31", "combo41",
        "combo61", "multiScale",
    ),
}
PROFILE_FIELDS = (
    *BASE_PROFILE_FIELDS,
    *(f"{prefix}_available" for prefix in NESTED_PROFILE_FIELDS),
    *(
        f"{prefix}_{field}"
        for prefix, fields in NESTED_PROFILE_FIELDS.items()
        for field in fields
    ),
)
RANK_FIELDS = (
    "rawGain",
    "differenceGain",
    "combinedGain",
    "sideMinimumAdvantage",
    "sideStepScore",
    "correctedSideSupport",
    "localSideStepScore11",
    "localSideStepScore21",
    "localSideStepScore31",
    "rawTransition_splitGain",
    "rawTransition_normalizedSplitGain",
    "rawTransition_balancedAdvantage",
    "rawTransition_localGain31",
    "cofechaTransition_splitGain",
    "cofechaTransition_normalizedSplitGain",
    "cofechaTransition_balancedAdvantage",
    "cofechaTransition_localGain31",
    "cumulative_combinedCusum",
    "cumulative_combinedContrast",
    "cumulative_referenceMedianCusum",
    "cumulative_referenceVoteCusum",
    "piecewise_combinedObjective",
    "piecewise_combinedGain",
    "referenceChange_weightedSupport",
    "referenceChange_positiveGainFraction",
    "referenceTransition_weightedRankMean",
    "referenceTransition_peakKernel9",
    "referenceTransition_weightedWindowVote25",
    "perReference_differenceGainWeighted",
    "perReference_fixedLagStepWeighted",
    "perReference_fixedLagStepPeakKernel9",
    "boundaryLocal_stepMinimum5",
    "boundaryLocal_stepMean5",
    "partialLocal_multiScale",
)


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=420,
        learning_rate=0.025,
        num_leaves=31,
        min_child_samples=80,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.0,
        reg_lambda=4.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def read_ndjson(path: Path):
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def truth_year(step: dict[str, Any]) -> int | None:
    value = step.get("diagnosedTruthYear")
    if value is None:
        value = step.get("acceptedTruthYear")
    return int(value) if value is not None else None


def numeric(value: Any, fallback: float = 0.0) -> float:
    if value is None:
        return fallback
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def flatten_profile_row(row: dict[str, Any]) -> dict[str, Any]:
    output = {
        "year": int(row["year"]),
        **{field: numeric(row.get(field)) for field in BASE_PROFILE_FIELDS},
    }
    for prefix, fields in NESTED_PROFILE_FIELDS.items():
        nested = row.get(prefix)
        output[f"{prefix}_available"] = int(isinstance(nested, dict))
        for field in fields:
            output[f"{prefix}_{field}"] = numeric(
                nested.get(field) if isinstance(nested, dict) else None
            )
    return output


def selected_profile_rows(
    rows: list[dict[str, Any]],
    best_year: int,
    side_best_year: int,
    stride: int,
) -> list[dict[str, Any]]:
    if not rows:
        return []
    selected_years = {
        int(row["year"])
        for row in rows
        if int(row["year"]) % stride == 0
    }
    for anchor in (best_year, side_best_year):
        selected_years.update(range(anchor - 6, anchor + 7))
    for field in RANK_FIELDS:
        strongest = sorted(
            rows,
            key=lambda row: numeric(row.get(field), float("-inf")),
            reverse=True,
        )[:1]
        for row in strongest:
            selected_years.add(int(row["year"]))
    return [row for row in rows if int(row["year"]) in selected_years]


def build_table(
    manifest_path: Path,
    run_dir: Path,
    identities_path: Path,
    stride: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    steps = json.loads((run_dir / "steps.json").read_text(encoding="utf8"))
    step_by_attempt = {
        f"evaluation:{step['caseIndex']}:{step['step']}": step
        for step in steps
    }
    identity_labels = pd.read_csv(identities_path)
    identity_labels["identity_lookup"] = (
        identity_labels["attempt_id"].astype(str)
        + "|" + identity_labels["event_type"].astype(str)
        + "|" + identity_labels["shift_years"].astype(int).astype(str)
    )
    label_by_identity = identity_labels.set_index("identity_lookup")[[
        "operation_correct",
        "strict_operation_correct",
    ]].to_dict(orient="index")
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    records: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    for part_value in manifest["parts"]:
        for attempt in read_ndjson(Path(part_value)):
            step = step_by_attempt.get(attempt["attemptId"])
            if step is None:
                continue
            actual_year = truth_year(step)
            attempts.append({
                "attempt_id": attempt["attemptId"],
                "file_id": attempt["fileId"],
                "family": attempt["family"],
                "product_correct": int(bool(step.get("workflowSuggestionCorrect"))),
                "product_strict_correct": int(
                    bool(step.get("primaryOperationCorrect"))
                    and bool(step.get("primaryWindowCovered"))
                ),
                "product_response": int(bool(step.get("response"))),
                "truth_type": step.get("diagnosedTruthType")
                or step.get("acceptedTruthType"),
                "truth_shift_years": step.get("diagnosedTruthShiftYears")
                if step.get("diagnosedTruthShiftYears") is not None
                else step.get("acceptedTruthShiftYears"),
                "truth_year": actual_year,
                "cofecha_flagged": int(bool(step.get("cofechaFlagged"))),
                "reference_anchor_count": int(step.get("referenceAnchorCount") or 0),
                "primary_event_type": (step.get("primary") or {}).get("eventType"),
                "primary_shift_years": (step.get("primary") or {}).get("shiftYears"),
                "primary_score": (step.get("primary") or {}).get("score") or 0.0,
                "primary_score_margin": (
                    (step.get("primary") or {}).get("scoreMargin") or 0.0
                ),
            })
            for identity in attempt["identities"]:
                scored = identity.get("scored")
                if not scored or not scored.get("rows"):
                    continue
                lookup = "|".join(map(str, (
                    attempt["attemptId"],
                    identity["eventType"],
                    int(identity["shiftYears"]),
                )))
                labels = label_by_identity.get(lookup, {
                    "operation_correct": 0,
                    "strict_operation_correct": 0,
                })
                flattened_rows = [
                    flatten_profile_row(row) for row in scored["rows"]
                ]
                profile = selected_profile_rows(
                    flattened_rows,
                    int(scored["bestYear"]),
                    int(scored["sideStepBestYear"]),
                    stride,
                )
                years = [int(row["year"]) for row in profile]
                if not years:
                    continue
                minimum_year = min(years)
                maximum_year = max(years)
                span = max(1, maximum_year - minimum_year)
                for row in profile:
                    year = int(row["year"])
                    window_correct = int(
                        bool(labels["operation_correct"])
                        and actual_year is not None
                        and abs(year - actual_year) <= 6
                    )
                    strict_correct = int(
                        bool(labels["strict_operation_correct"])
                        and actual_year is not None
                        and abs(year - actual_year) <= 6
                    )
                    record = {
                        "attempt_id": attempt["attemptId"],
                        "file_id": attempt["fileId"],
                        "family": attempt["family"],
                        "product_correct": int(
                            bool(step.get("workflowSuggestionCorrect"))
                        ),
                        "product_strict_correct": int(
                            bool(step.get("primaryOperationCorrect"))
                            and bool(step.get("primaryWindowCovered"))
                        ),
                        "truth_year": actual_year,
                        "event_type": identity["eventType"],
                        "shift_years": int(identity["shiftYears"]),
                        "shift_abs": abs(int(identity["shiftYears"])),
                        "operation_probability": float(
                            identity["operationProbability"]
                        ),
                        "operation_rank": int(identity["operationRank"]),
                        "operation_rank_reciprocal": 1.0
                        / max(1, int(identity["operationRank"])),
                        "package_identity": int(identity["packageIdentity"]),
                        "operation_correct": int(labels["operation_correct"]),
                        "strict_operation_correct": int(
                            labels["strict_operation_correct"]
                        ),
                        "baseline_lag": int(scored["baselineLag"]),
                        "shift_baseline_distance": abs(
                            int(identity["shiftYears"])
                            - int(scored["baselineLag"])
                        ),
                        "year": year,
                        "year_fraction": (year - minimum_year) / span,
                        "distance_from_operation_best": abs(
                            year - int(scored["bestYear"])
                        ),
                        "distance_from_side_best": abs(
                            year - int(scored["sideStepBestYear"])
                        ),
                        "window_correct": window_correct,
                        "strict_correct": strict_correct,
                        "top_exact": int(
                            window_correct and actual_year is not None
                            and year == actual_year
                        ),
                    }
                    record.update({
                        field: numeric(row.get(field))
                        for field in PROFILE_FIELDS
                    })
                    records.append(record)
    table = pd.DataFrame(records)
    attempt_table = pd.DataFrame(attempts).drop_duplicates("attempt_id")
    rank_feature_data = {}
    for field in RANK_FIELDS:
        identity_groups = table.groupby(
            ["attempt_id", "event_type", "shift_years"],
            sort=False,
        )[field]
        rank_feature_data[f"identity_{field}_percentile"] = identity_groups.rank(
            method="average", pct=True, ascending=True
        )
        rank_feature_data[f"identity_{field}_deficit"] = (
            identity_groups.transform("max") - table[field]
        )
        same_year_groups = table.groupby(["attempt_id", "year"], sort=False)[field]
        rank_feature_data[f"cross_{field}_percentile"] = same_year_groups.rank(
            method="average", pct=True, ascending=True
        )
        rank_feature_data[f"cross_{field}_deficit"] = (
            same_year_groups.transform("max") - table[field]
        )
    operation_groups = table.groupby("attempt_id", sort=False)["operation_probability"]
    rank_feature_data["operation_probability_deficit"] = (
        operation_groups.transform("max") - table["operation_probability"]
    )
    table = pd.concat([
        table,
        pd.DataFrame(rank_feature_data, index=table.index),
    ], axis=1)
    return table, attempt_table


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows-manifest", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--operation-identities", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stride", type=int, default=3)
    parser.add_argument("--save-row-scores", action="store_true")
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    table, attempts = build_table(
        Path(args.rows_manifest).resolve(),
        Path(args.run_dir).resolve(),
        Path(args.operation_identities).resolve(),
        max(1, args.stride),
    )
    forbidden = {
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
    feature_columns = [column for column in table.columns if column not in forbidden]
    values = pd.get_dummies(
        table[feature_columns],
        columns=["event_type"],
        dtype=float,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    feature_names = list(values.columns)
    files = np.array(sorted(table["file_id"].unique()))
    predictions = np.full(len(table), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train_mask = ~table["file_id"].isin(held_files)
        positive_attempts = set(table.loc[
            train_mask & table["window_correct"].eq(1), "attempt_id"
        ])
        train = np.flatnonzero(
            train_mask.to_numpy()
            & table["attempt_id"].isin(positive_attempts).to_numpy()
        )
        test = np.flatnonzero(table["file_id"].isin(held_files).to_numpy())
        ordered = table.iloc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = table.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        estimator = ranker(31000 + fold)
        estimator.fit(
            values.loc[ordered],
            table.loc[ordered, "window_correct"],
            group=groups,
        )
        predictions[test] = estimator.predict(values.iloc[test])
    if np.isnan(predictions).any():
        raise RuntimeError("missing joint operation-year OOF predictions")
    table["joint_score"] = predictions
    ordered = table.sort_values(
        ["attempt_id", "joint_score"], ascending=[True, False]
    )
    top = ordered.groupby("attempt_id", sort=False).head(1).copy()
    second = ordered.groupby("attempt_id", sort=False)["joint_score"].agg(
        lambda scores: scores.iloc[1] if len(scores) > 1 else scores.iloc[0]
    )
    top["joint_margin"] = top["joint_score"] - top["attempt_id"].map(second)
    top["proposal_correct"] = top["window_correct"]
    top["proposal_strict_correct"] = top["strict_correct"]
    duplicate_metadata = [
        column for column in (
            "product_correct",
            "product_strict_correct",
            "truth_year",
        )
        if column in top.columns
    ]
    result = attempts.merge(
        top.drop(columns=duplicate_metadata),
        on=["attempt_id", "file_id", "family"],
        how="left",
    )
    event = result[result["family"] != "Clean"].copy()
    clean = result[result["family"] == "Clean"].copy()
    corrected = event[
        event["product_correct"].eq(0) & event["proposal_correct"].eq(1)
    ]
    harmed = event[
        event["product_correct"].eq(1) & event["proposal_correct"].eq(0)
    ]
    product_correct = int(event["product_correct"].sum())
    oracle_union = int((
        event["product_correct"].eq(1) | event["proposal_correct"].eq(1)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "files": int(event["file_id"].nunique()),
        "eventAttempts": len(event),
        "yearRows": len(table),
        "features": len(feature_names),
        "productCorrect": product_correct,
        "productAccuracy": product_correct / max(1, len(event)),
        "proposalCorrect": int(event["proposal_correct"].sum()),
        "proposalAccuracy": float(event["proposal_correct"].mean()),
        "proposalStrictCorrect": int(event["proposal_strict_correct"].sum()),
        "proposalStrictAccuracy": float(event["proposal_strict_correct"].mean()),
        "correctedProductFailures": len(corrected),
        "harmedProductCorrect": len(harmed),
        "oracleUnionCorrect": oracle_union,
        "oracleUnionAccuracy": oracle_union / max(1, len(event)),
        "cleanAttempts": len(clean),
        "byFamily": {
            family: {
                "events": len(group),
                "productCorrect": int(group["product_correct"].sum()),
                "proposalCorrect": int(group["proposal_correct"].sum()),
                "correctedProductFailures": int((
                    group["product_correct"].eq(0)
                    & group["proposal_correct"].eq(1)
                ).sum()),
                "harmedProductCorrect": int((
                    group["product_correct"].eq(1)
                    & group["proposal_correct"].eq(0)
                ).sum()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }
    result.to_csv(output_dir / "joint-operation-year-top.csv", index=False)
    if args.save_row_scores:
        table.to_pickle(output_dir / "joint-operation-year-scores.pkl")
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
