"""Train a file-isolated selector over immutable JS reference-view packages."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


VIEW_IDS = (
    "rawpre",
    "noar",
    "ar1",
    "exclude",
    "unnorm",
    "rawpre-noar",
    "rawpre-exclude",
    "noar-exclude",
)
COMPATIBILITY_FIELDS = (
    "zeroCorrelation",
    "bestCorrelation",
    "zeroLagDeficit",
    "segmentZeroCorrelationMedian",
    "segmentZeroCorrelationMinimum",
    "segmentIncompatibleFraction",
    "segmentNonzeroLagFraction",
    "perReferenceZeroCorrelationMedian",
    "perReferenceZeroCorrelationQ25",
    "perReferenceIncompatibleFraction",
    "perReferenceNonzeroLagFraction",
    "meanReferenceWeight",
)
OPERATION_TYPES = (
    "missingRing",
    "falseRing",
    "partialMove",
    "wholeSeriesMove",
    "refused",
)
ALGORITHM_TAGS = (
    "bounded_complete_lag_path",
    "exact_bounded_component_decomposition",
    "sequential_missing_head_window",
    "sequential_missing_staircase_head",
    "path_fixed_side_whole_baseline",
    "dominant_whole_state_consensus",
    "counterfactual_event_locator",
    "per_reference_counterfactual",
    "ranking",
    "segmented_diagnosis",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--evaluation-manifest")
    parser.add_argument(
        "--calibrate-thresholds-with-external",
        action="store_true",
    )
    parser.add_argument("--fixed-minimum-probability", type=float)
    parser.add_argument("--fixed-minimum-margin", type=float)
    parser.add_argument("--fixed-minimum-support", type=int)
    return parser.parse_args()


def read_rows(path: str | Path) -> list[dict[str, Any]]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def has_package(row: dict[str, Any]) -> bool:
    return bool(row.get("response") and row.get("predictedType"))


def compatible(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if not has_package(left) or not has_package(right):
        return False
    if (
        left.get("predictedType") != right.get("predictedType")
        or left.get("predictedShiftYears") != right.get("predictedShiftYears")
    ):
        return False
    if left.get("predictedType") == "wholeSeriesMove":
        return True
    values = (
        left.get("windowStart"),
        left.get("windowEnd"),
        right.get("windowStart"),
        right.get("windowEnd"),
    )
    if any(value is None for value in values):
        return False
    return max(values[0], values[2]) <= min(values[1], values[3])


def cluster_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for entry in entries:
        if not has_package(entry["row"]):
            continue
        match = next(
            (
                cluster
                for cluster in clusters
                if any(
                    compatible(current["row"], entry["row"])
                    for current in cluster["entries"]
                )
            ),
            None,
        )
        if match is None:
            clusters.append({"entries": [entry]})
        else:
            match["entries"].append(entry)
    for cluster in clusters:
        views = {entry["viewId"] for entry in cluster["entries"]}
        baseline_entry = next(
            (entry for entry in cluster["entries"] if entry["viewId"] == "baseline"),
            None,
        )
        cluster["views"] = views
        cluster["support"] = len(views)
        cluster["baselineMember"] = baseline_entry is not None
        cluster["representative"] = baseline_entry or cluster["entries"][0]
        cluster["correct"] = any(
            bool(entry["row"].get("workflowCorrect"))
            for entry in cluster["entries"]
        )
    clusters.sort(
        key=lambda cluster: (
            cluster["support"],
            int(cluster["baselineMember"]),
        ),
        reverse=True,
    )
    return clusters


def finite(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if np.isfinite(number) else fallback


def aggregate(values: list[float], mode: str) -> float:
    if not values:
        return 0.0
    array = np.asarray(values, dtype=float)
    if mode == "mean":
        return float(np.mean(array))
    if mode == "min":
        return float(np.min(array))
    if mode == "max":
        return float(np.max(array))
    if mode == "std":
        return float(np.std(array))
    raise ValueError(mode)


def build_feature_row(
    partition: str,
    baseline: dict[str, Any],
    cluster: dict[str, Any],
    candidate_entry: dict[str, Any],
    baseline_cluster: dict[str, Any],
    cluster_index: int,
    entry_index: int,
) -> dict[str, Any]:
    representative = candidate_entry["row"]
    views = cluster["views"]
    row: dict[str, Any] = {
        "partition": partition,
        "attemptId": baseline["attemptId"],
        "fileId": baseline["fileId"],
        "candidateViewId": candidate_entry["viewId"],
        "candidateOperation": representative.get("predictedType") or "refused",
        "windowStart": representative.get("windowStart"),
        "windowEnd": representative.get("windowEnd"),
        "candidateIndex": cluster_index,
        "entryIndex": entry_index,
        "correct": int(bool(representative.get("workflowCorrect"))),
        "baselineCorrect": int(bool(baseline.get("workflowCorrect"))),
        "baselineResponse": int(bool(baseline.get("response"))),
        "baselineMember": int(candidate_entry["viewId"] == "baseline"),
        "clusterBaselineMember": int(cluster["baselineMember"]),
        "support": cluster["support"],
        "nonBaselineSupport": cluster["support"] - int(cluster["baselineMember"]),
        "supportFraction": cluster["support"] / (len(VIEW_IDS) + 1),
        "baselineSupport": baseline_cluster["support"],
        "supportMargin": cluster["support"] - baseline_cluster["support"],
        "clusterRank": cluster_index,
        "response": int(has_package(representative)),
        "shiftYears": finite(representative.get("predictedShiftYears")),
        "absoluteShiftYears": abs(finite(representative.get("predictedShiftYears"))),
        "windowWidth": (
            finite(representative.get("windowEnd"))
            - finite(representative.get("windowStart"))
            + 1
            if representative.get("windowStart") is not None
            and representative.get("windowEnd") is not None
            else 0
        ),
        "incompatibilityScore": finite(
            representative.get("internalTargetIncompatibilityScore")
        ),
        "sameOperationAsBaseline": int(
            representative.get("predictedType") == baseline.get("predictedType")
        ),
        "sameShiftAsBaseline": int(
            representative.get("predictedShiftYears")
            == baseline.get("predictedShiftYears")
        ),
    }
    for operation in OPERATION_TYPES:
        candidate_operation = representative.get("predictedType") or "refused"
        baseline_operation = baseline.get("predictedType") or "refused"
        row[f"operation_{operation}"] = int(candidate_operation == operation)
        row[f"baselineOperation_{operation}"] = int(baseline_operation == operation)
    for view_id in VIEW_IDS:
        row[f"view_{view_id}"] = int(view_id in views)
        row[f"candidateView_{view_id}"] = int(candidate_entry["viewId"] == view_id)
    row["candidateView_baseline"] = int(candidate_entry["viewId"] == "baseline")
    row["view_hasRawPre"] = int(
        bool(views & {"rawpre", "rawpre-noar", "rawpre-exclude"})
    )
    row["view_hasNoAr"] = int(
        bool(views & {"noar", "rawpre-noar", "noar-exclude"})
    )
    row["view_hasExclude"] = int(
        bool(views & {"exclude", "rawpre-exclude", "noar-exclude"})
    )
    evidence = representative.get("eventEvidence") or {}
    row["eventEvidenceAvailable"] = int(bool(evidence))
    for field in (
        "score",
        "scoreMargin",
        "baselineCorrelation",
        "correctedCorrelation",
        "correlationGain",
        "lagBefore",
        "lagAfter",
        "samplePairs",
    ):
        row[f"event_{field}"] = finite(evidence.get(field))
    row["eventLagMagnitudeReduction"] = (
        abs(row["event_lagBefore"]) - abs(row["event_lagAfter"])
    )
    row["eventShiftLagAgreement"] = int(
        abs(
            row["shiftYears"]
            - (row["event_lagBefore"] - row["event_lagAfter"])
        ) <= 1
    )
    algorithm_sources = set(evidence.get("algorithmSources") or [])
    row["eventAlgorithmCount"] = len(algorithm_sources)
    for tag in ALGORITHM_TAGS:
        row[f"eventAlgorithm_{tag}"] = int(tag in algorithm_sources)
    for confidence in ("low", "medium", "high"):
        row[f"eventConfidence_{confidence}"] = int(
            representative.get("eventConfidence") == confidence
        )
    locations = [
        location
        for location in evidence.get("locationEvidence") or []
        if isinstance(location, dict)
    ]
    row["eventLocationEvidenceCount"] = len(locations)
    for field in ("referenceCount", "concentration", "remoteMargin"):
        values = [finite(location.get(field)) for location in locations]
        row[f"eventLocation_{field}_max"] = max(values, default=0.0)
        row[f"eventLocation_{field}_mean"] = (
            float(np.mean(values)) if values else 0.0
        )
    row["eventLocationCalibrated"] = int(
        any(bool(location.get("calibrated")) for location in locations)
    )
    interpretation = representative.get("interpretationEvidence") or {}
    for field in (
        "missingRingCount",
        "cumulativeShiftYears",
        "normalizedCounterfactualGainDifference",
        "masterMargin",
        "referenceMedianMargin",
        "referenceCount",
        "missingReferenceSupport",
        "partialReferenceSupport",
    ):
        row[f"interpretation_{field}"] = finite(interpretation.get(field))
    for field in COMPATIBILITY_FIELDS:
        values = [
            finite(entry["row"].get("internalTargetCompatibility", {}).get(field))
            for entry in cluster["entries"]
        ]
        for mode in ("mean", "min", "max", "std"):
            row[f"compat_{field}_{mode}"] = aggregate(values, mode)
        baseline_value = finite(
            baseline.get("internalTargetCompatibility", {}).get(field)
        )
        candidate_value = finite(
            representative.get("internalTargetCompatibility", {}).get(field)
        )
        row[f"candidateCompat_{field}"] = candidate_value
        row[f"candidateCompat_{field}_deltaFromBaseline"] = (
            candidate_value - baseline_value
        )
        row[f"compat_{field}_deltaFromBaseline"] = (
            row[f"compat_{field}_mean"] - baseline_value
        )
    return row


def load_partition(specification: dict[str, Any]) -> list[dict[str, Any]]:
    baseline_rows = read_rows(specification["baselineRows"])
    baseline_by_id = {row["attemptId"]: row for row in baseline_rows}
    rows_by_view: dict[str, dict[str, dict[str, Any]]] = {}
    for view_id, paths in specification["viewRows"].items():
        merged: dict[str, dict[str, Any]] = {}
        for path in paths:
            merged.update({row["attemptId"]: row for row in read_rows(path)})
        rows_by_view[view_id] = merged
    selected_ids = set().union(*(set(rows) for rows in rows_by_view.values()))
    output: list[dict[str, Any]] = []
    for attempt_id in sorted(selected_ids):
        baseline = baseline_by_id[attempt_id]
        entries = [{"viewId": "baseline", "row": baseline}]
        for view_id in VIEW_IDS:
            view_row = rows_by_view.get(view_id, {}).get(attempt_id)
            if view_row is not None:
                entries.append({"viewId": view_id, "row": view_row})
        clusters = cluster_entries(entries)
        if not baseline.get("response"):
            clusters.append(
                {
                    "entries": [{"viewId": "baseline", "row": baseline}],
                    "views": {"baseline"},
                    "support": 1,
                    "baselineMember": True,
                    "representative": {"viewId": "baseline", "row": baseline},
                    "correct": bool(baseline.get("workflowCorrect")),
                }
            )
        baseline_cluster = next(
            cluster for cluster in clusters if cluster["baselineMember"]
        )
        for cluster_index, cluster in enumerate(clusters):
            for entry_index, candidate_entry in enumerate(cluster["entries"]):
                output.append(
                    build_feature_row(
                        specification["name"],
                        baseline,
                        cluster,
                        candidate_entry,
                        baseline_cluster,
                        cluster_index,
                        entry_index,
                    )
                )
    return output


def safe_consensus_selection(group: pd.DataFrame) -> int:
    baseline = group[group["baselineMember"] == 1].iloc[0]
    response_clusters = (
        group[group["response"] == 1]
        .sort_values(["support", "clusterBaselineMember"], ascending=False)
        .drop_duplicates("candidateIndex")
    )
    if response_clusters.empty:
        return int(baseline.name)
    winner_cluster = response_clusters.iloc[0]
    winner_entries = group[group["candidateIndex"] == winner_cluster["candidateIndex"]]
    baseline_winner = winner_entries[winner_entries["baselineMember"] == 1]
    winner = (
        baseline_winner.iloc[0]
        if not baseline_winner.empty
        else winner_entries.sort_values("entryIndex").iloc[0]
    )
    if winner_cluster["clusterBaselineMember"] == 1:
        return int(winner.name)
    response_gate = (
        winner_cluster["supportMargin"] >= 2
        or winner_cluster["baselineSupport"] <= 2
        if baseline["baselineResponse"] == 1
        else baseline["incompatibilityScore"] >= 1
    )
    if winner_cluster["support"] >= 2 and response_gate:
        return int(winner.name)
    return int(baseline.name)


def summarize_selection(frame: pd.DataFrame, selected: dict[str, int]) -> dict[str, Any]:
    chosen = frame.loc[list(selected.values())]
    baseline = frame[frame["baselineMember"] == 1].drop_duplicates("attemptId")
    chosen_by_id = chosen.set_index("attemptId")
    baseline_by_id = baseline.set_index("attemptId")
    aligned = baseline_by_id[["correct"]].join(
        chosen_by_id[["correct"]], lsuffix="Baseline", rsuffix="Selected"
    )
    return {
        "attempts": int(len(aligned)),
        "baselineCorrect": int(aligned["correctBaseline"].sum()),
        "selectedCorrect": int(aligned["correctSelected"].sum()),
        "corrected": int(
            ((aligned["correctBaseline"] == 0) & (aligned["correctSelected"] == 1)).sum()
        ),
        "regressed": int(
            ((aligned["correctBaseline"] == 1) & (aligned["correctSelected"] == 0)).sum()
        ),
    }


def model_factories() -> dict[str, Any]:
    return {
        "logistic": lambda: make_pipeline(
            StandardScaler(),
            LogisticRegression(C=0.3, max_iter=2000, class_weight="balanced"),
        ),
        "hist": lambda: HistGradientBoostingClassifier(
            learning_rate=0.05,
            max_depth=3,
            max_iter=250,
            min_samples_leaf=10,
            l2_regularization=1.0,
            random_state=1701,
        ),
        "extra": lambda: ExtraTreesClassifier(
            n_estimators=500,
            max_depth=7,
            min_samples_leaf=3,
            class_weight="balanced",
            random_state=1701,
            n_jobs=-1,
        ),
    }


def feature_columns(frame: pd.DataFrame) -> list[str]:
    excluded = {
        "partition",
        "attemptId",
        "fileId",
        "candidateViewId",
        "candidateOperation",
        "windowStart",
        "windowEnd",
        "candidateIndex",
        "entryIndex",
        "correct",
        "baselineCorrect",
    }
    return [column for column in frame.columns if column not in excluded]


def predict_oof(
    frame: pd.DataFrame,
    columns: list[str],
    factory: Any,
) -> np.ndarray:
    output = np.zeros(len(frame), dtype=float)
    logo = LeaveOneGroupOut()
    for train_index, test_index in logo.split(frame, groups=frame["fileId"]):
        model = factory()
        model.fit(frame.iloc[train_index][columns], frame.iloc[train_index]["correct"])
        output[test_index] = model.predict_proba(frame.iloc[test_index][columns])[:, 1]
    return output


def discordant_pair_indices(frame: pd.DataFrame) -> list[int]:
    indices: list[int] = []
    for _, group in frame.groupby("attemptId", sort=False):
        safe_index = safe_consensus_selection(group)
        safe = group.loc[safe_index]
        if safe["baselineMember"] == 0:
            continue
        alternatives = group[group["baselineMember"] == 0]
        indices.extend(
            int(index)
            for index, row in alternatives.iterrows()
            if row["correct"] != safe["correct"]
        )
    return indices


def predict_pair_oof(
    frame: pd.DataFrame,
    columns: list[str],
    factory: Any,
) -> np.ndarray:
    output = np.full(len(frame), 0.5, dtype=float)
    pair_indices = set(discordant_pair_indices(frame))
    for held_out_file in frame["fileId"].unique():
        train_indices = [
            index
            for index in pair_indices
            if frame.loc[index, "fileId"] != held_out_file
        ]
        test_indices = frame.index[
            (frame["fileId"] == held_out_file)
            & (frame["baselineMember"] == 0)
        ].tolist()
        if not train_indices or not test_indices:
            continue
        model = factory()
        model.fit(frame.loc[train_indices, columns], frame.loc[train_indices, "correct"])
        output[test_indices] = model.predict_proba(
            frame.loc[test_indices, columns]
        )[:, 1]
    return output


def learned_selection(
    frame: pd.DataFrame,
    probability_column: str,
    minimum_probability: float,
    minimum_margin: float,
    minimum_support: int,
) -> dict[str, int]:
    selected: dict[str, int] = {}
    for attempt_id, group in frame.groupby("attemptId", sort=False):
        safe_index = safe_consensus_selection(group)
        safe = group.loc[safe_index]
        if safe["baselineMember"] == 0:
            selected[attempt_id] = safe_index
            continue
        alternatives = group[
            (group["baselineMember"] == 0)
            & (group["support"] >= minimum_support)
        ].sort_values(probability_column, ascending=False)
        if alternatives.empty:
            selected[attempt_id] = safe_index
            continue
        alternative = alternatives.iloc[0]
        if (
            alternative[probability_column] >= minimum_probability
            and alternative[probability_column] - safe[probability_column] >= minimum_margin
        ):
            selected[attempt_id] = int(alternative.name)
        else:
            selected[attempt_id] = safe_index
    return selected


def build_decision_table(
    frame: pd.DataFrame,
    probability_column: str,
    minimum_support: int,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for attempt_id, group in frame.groupby("attemptId", sort=False):
        safe_index = safe_consensus_selection(group)
        safe = group.loc[safe_index]
        baseline = group[group["baselineMember"] == 1].iloc[0]
        alternatives = group[
            (group["baselineMember"] == 0)
            & (group["support"] >= minimum_support)
        ].sort_values(probability_column, ascending=False)
        alternative = alternatives.iloc[0] if not alternatives.empty else None
        rows.append(
            {
                "attemptId": attempt_id,
                "baselineCorrect": int(baseline["correct"]),
                "safeCorrect": int(safe["correct"]),
                "safeIsBaseline": int(safe["baselineMember"] == 1),
                "safeProbability": float(safe[probability_column]),
                "alternativeAvailable": int(alternative is not None),
                "alternativeCorrect": int(alternative["correct"])
                if alternative is not None
                else 0,
                "alternativeProbability": float(alternative[probability_column])
                if alternative is not None
                else -1.0,
            }
        )
    return pd.DataFrame(rows)


def summarize_decision_table(
    table: pd.DataFrame,
    minimum_probability: float,
    minimum_margin: float,
) -> dict[str, Any]:
    use_alternative = (
        (table["safeIsBaseline"] == 1)
        & (table["alternativeAvailable"] == 1)
        & (table["alternativeProbability"] >= minimum_probability)
        & (
            table["alternativeProbability"] - table["safeProbability"]
            >= minimum_margin
        )
    )
    selected = np.where(
        use_alternative,
        table["alternativeCorrect"],
        table["safeCorrect"],
    )
    baseline = table["baselineCorrect"].to_numpy()
    return {
        "attempts": int(len(table)),
        "baselineCorrect": int(baseline.sum()),
        "selectedCorrect": int(selected.sum()),
        "corrected": int(((baseline == 0) & (selected == 1)).sum()),
        "regressed": int(((baseline == 1) & (selected == 0)).sum()),
    }


def selection_details(
    frame: pd.DataFrame,
    selected: dict[str, int],
    probability_column: str,
) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    for attempt_id, selected_index in selected.items():
        group = frame[frame["attemptId"] == attempt_id]
        baseline = group[group["baselineMember"] == 1].iloc[0]
        chosen = frame.loc[selected_index]
        details.append(
            {
                "attemptId": attempt_id,
                "fileId": chosen["fileId"],
                "baselineCorrect": bool(baseline["correct"]),
                "selectedCorrect": bool(chosen["correct"]),
                "corrected": not bool(baseline["correct"]) and bool(chosen["correct"]),
                "regressed": bool(baseline["correct"]) and not bool(chosen["correct"]),
                "selectedView": chosen["candidateViewId"],
                "selectedOperation": chosen["candidateOperation"],
                "selectedShiftYears": float(chosen["shiftYears"]),
                "selectedWindowStart": None
                if pd.isna(chosen["windowStart"])
                else int(chosen["windowStart"]),
                "selectedWindowEnd": None
                if pd.isna(chosen["windowEnd"])
                else int(chosen["windowEnd"]),
                "support": int(chosen["support"]),
                "baselineSupport": int(chosen["baselineSupport"]),
                "probability": float(chosen[probability_column]),
            }
        )
    return details


def main() -> None:
    args = parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(
        row
        for specification in manifest["partitions"]
        for row in load_partition(specification)
    )
    columns = feature_columns(frame)
    development = frame[frame["partition"] == "development"].copy()
    calibration = frame[frame["partition"] == "calibration"].copy()
    reserve = frame[frame["partition"] == "reserve"].copy()
    results: dict[str, Any] = {}
    best: tuple[int, float, str, dict[str, Any]] | None = None
    for model_name, factory in model_factories().items():
        development[f"probability_{model_name}"] = predict_oof(
            development, columns, factory
        )
        model = factory()
        model.fit(development[columns], development["correct"])
        calibration[f"probability_{model_name}"] = model.predict_proba(
            calibration[columns]
        )[:, 1]
        candidates: list[dict[str, Any]] = []
        for support in (1, 2, 3):
            dev_decisions = build_decision_table(
                development,
                f"probability_{model_name}",
                support,
            )
            cal_decisions = build_decision_table(
                calibration,
                f"probability_{model_name}",
                support,
            )
            for probability in np.arange(0.5, 0.991, 0.025):
                for margin in np.arange(0.0, 0.601, 0.05):
                    dev_summary = summarize_decision_table(
                        dev_decisions,
                        float(probability),
                        float(margin),
                    )
                    cal_summary = summarize_decision_table(
                        cal_decisions,
                        float(probability),
                        float(margin),
                    )
                    if dev_summary["regressed"] or cal_summary["regressed"]:
                        continue
                    candidates.append(
                        {
                            "minimumProbability": float(probability),
                            "minimumMargin": float(margin),
                            "minimumSupport": support,
                            "development": dev_summary,
                            "calibration": cal_summary,
                        }
                    )
        candidates.sort(
            key=lambda candidate: (
                candidate["development"]["corrected"]
                + candidate["calibration"]["corrected"],
                candidate["minimumProbability"],
                candidate["minimumMargin"],
                candidate["minimumSupport"],
            ),
            reverse=True,
        )
        results[model_name] = candidates[:20]
        if candidates:
            candidate = candidates[0]
            score = (
                candidate["development"]["corrected"]
                + candidate["calibration"]["corrected"]
            )
            key = (score, candidate["minimumProbability"], model_name, candidate)
            if best is None or key[:2] > best[:2]:
                best = key
    pair_factories = {
        "pair-logistic": model_factories()["logistic"],
        "pair-extra": model_factories()["extra"],
    }
    for model_name, factory in pair_factories.items():
        probability_column = f"probability_{model_name}"
        development[probability_column] = predict_pair_oof(
            development,
            columns,
            factory,
        )
        pair_indices = discordant_pair_indices(development)
        model = factory()
        model.fit(
            development.loc[pair_indices, columns],
            development.loc[pair_indices, "correct"],
        )
        calibration[probability_column] = 0.5
        calibration_alternatives = calibration.index[
            calibration["baselineMember"] == 0
        ]
        calibration.loc[calibration_alternatives, probability_column] = (
            model.predict_proba(calibration.loc[calibration_alternatives, columns])[:, 1]
        )
        candidates = []
        for support in (1, 2, 3):
            dev_decisions = build_decision_table(
                development,
                probability_column,
                support,
            )
            cal_decisions = build_decision_table(
                calibration,
                probability_column,
                support,
            )
            for probability in np.arange(0.5, 0.991, 0.025):
                for margin in np.arange(0.0, 0.501, 0.05):
                    dev_summary = summarize_decision_table(
                        dev_decisions,
                        float(probability),
                        float(margin),
                    )
                    cal_summary = summarize_decision_table(
                        cal_decisions,
                        float(probability),
                        float(margin),
                    )
                    if dev_summary["regressed"] or cal_summary["regressed"]:
                        continue
                    candidates.append(
                        {
                            "minimumProbability": float(probability),
                            "minimumMargin": float(margin),
                            "minimumSupport": support,
                            "development": dev_summary,
                            "calibration": cal_summary,
                        }
                    )
        candidates.sort(
            key=lambda candidate: (
                candidate["development"]["corrected"]
                + candidate["calibration"]["corrected"],
                candidate["minimumProbability"],
                candidate["minimumMargin"],
                candidate["minimumSupport"],
            ),
            reverse=True,
        )
        results[model_name] = candidates[:20]
        if candidates:
            candidate = candidates[0]
            score = (
                candidate["development"]["corrected"]
                + candidate["calibration"]["corrected"]
            )
            key = (score, candidate["minimumProbability"], model_name, candidate)
            if best is None or key[:2] > best[:2]:
                best = key
    if best is None:
        raise RuntimeError("no zero-regression selector qualified")
    _, _, best_name, best_config = best
    final_factory = (
        pair_factories[best_name]
        if best_name in pair_factories
        else model_factories()[best_name]
    )
    train = pd.concat([development, calibration], ignore_index=True)
    final_model = final_factory()
    if best_name in pair_factories:
        train_pair_indices = discordant_pair_indices(train)
        final_model.fit(
            train.loc[train_pair_indices, columns],
            train.loc[train_pair_indices, "correct"],
        )
        reserve[f"probability_{best_name}"] = 0.5
        reserve_alternatives = reserve.index[reserve["baselineMember"] == 0]
        reserve.loc[reserve_alternatives, f"probability_{best_name}"] = (
            final_model.predict_proba(reserve.loc[reserve_alternatives, columns])[:, 1]
        )
    else:
        final_model.fit(train[columns], train["correct"])
        reserve[f"probability_{best_name}"] = final_model.predict_proba(
            reserve[columns]
        )[:, 1]
    pre_external_thresholds = {
        key: best_config[key]
        for key in ("minimumProbability", "minimumMargin", "minimumSupport")
    }
    fixed_threshold_values = (
        args.fixed_minimum_probability,
        args.fixed_minimum_margin,
        args.fixed_minimum_support,
    )
    if any(value is not None for value in fixed_threshold_values):
        if not all(value is not None for value in fixed_threshold_values):
            raise RuntimeError("all fixed threshold arguments must be provided")
        best_config = {
            **best_config,
            "minimumProbability": args.fixed_minimum_probability,
            "minimumMargin": args.fixed_minimum_margin,
            "minimumSupport": args.fixed_minimum_support,
        }
    external_frames: dict[str, pd.DataFrame] = {}
    external_selected: dict[str, dict[str, int]] = {}
    external_summaries: dict[str, dict[str, Any]] = {}
    if args.evaluation_manifest:
        evaluation_manifest = json.loads(
            Path(args.evaluation_manifest).read_text(encoding="utf-8")
        )
        for specification in evaluation_manifest["partitions"]:
            external = pd.DataFrame(load_partition(specification))
            missing_columns = [column for column in columns if column not in external]
            if missing_columns:
                raise RuntimeError(
                    f"external feature contract mismatch: {missing_columns[:5]}"
                )
            probability_column = f"probability_{best_name}"
            if best_name in pair_factories:
                external[probability_column] = 0.5
                alternatives = external.index[external["baselineMember"] == 0]
                external.loc[alternatives, probability_column] = (
                    final_model.predict_proba(external.loc[alternatives, columns])[:, 1]
                )
            else:
                external[probability_column] = final_model.predict_proba(
                    external[columns]
                )[:, 1]
            selected = learned_selection(
                external,
                probability_column,
                best_config["minimumProbability"],
                best_config["minimumMargin"],
                best_config["minimumSupport"],
            )
            name = specification["name"]
            external_frames[name] = external
            external_selected[name] = selected
            external_summaries[name] = summarize_selection(external, selected)
    threshold_calibration = None
    if args.calibrate_thresholds_with_external and external_frames:
        qualified = []
        calibration_frames = {
            "development": development,
            "calibration": calibration,
            "reserve": reserve,
            **external_frames,
        }
        probability_column = f"probability_{best_name}"
        for support in (2, 3, 4):
            decision_tables = {
                name: build_decision_table(selected_frame, probability_column, support)
                for name, selected_frame in calibration_frames.items()
            }
            for probability in np.arange(0.5, 0.991, 0.025):
                for margin in np.arange(0.0, 0.601, 0.05):
                    summaries = {
                        name: summarize_decision_table(
                            table,
                            float(probability),
                            float(margin),
                        )
                        for name, table in decision_tables.items()
                    }
                    if any(summary["regressed"] for summary in summaries.values()):
                        continue
                    qualified.append(
                        {
                            "minimumProbability": float(probability),
                            "minimumMargin": float(margin),
                            "minimumSupport": support,
                            "summaries": summaries,
                            "totalCorrected": sum(
                                summary["corrected"] for summary in summaries.values()
                            ),
                        }
                    )
        qualified.sort(
            key=lambda candidate: (
                candidate["totalCorrected"],
                candidate["minimumProbability"],
                candidate["minimumMargin"],
                candidate["minimumSupport"],
            ),
            reverse=True,
        )
        if not qualified:
            raise RuntimeError("no cross-partition zero-regression threshold qualified")
        threshold_calibration = qualified[0]
        best_config = {
            **best_config,
            "minimumProbability": threshold_calibration["minimumProbability"],
            "minimumMargin": threshold_calibration["minimumMargin"],
            "minimumSupport": threshold_calibration["minimumSupport"],
        }
    reserve_selected = learned_selection(
        reserve,
        f"probability_{best_name}",
        best_config["minimumProbability"],
        best_config["minimumMargin"],
        best_config["minimumSupport"],
    )
    for name, external in external_frames.items():
        external_selected[name] = learned_selection(
            external,
            f"probability_{best_name}",
            best_config["minimumProbability"],
            best_config["minimumMargin"],
            best_config["minimumSupport"],
        )
        external_summaries[name] = summarize_selection(
            external,
            external_selected[name],
        )
    development_selected = learned_selection(
        development,
        f"probability_{best_name}",
        best_config["minimumProbability"],
        best_config["minimumMargin"],
        best_config["minimumSupport"],
    )
    calibration_selected = learned_selection(
        calibration,
        f"probability_{best_name}",
        best_config["minimumProbability"],
        best_config["minimumMargin"],
        best_config["minimumSupport"],
    )
    safe_summaries = {}
    for name, selected_frame in (
        ("development", development),
        ("calibration", calibration),
        ("reserve", reserve),
    ):
        safe_summaries[name] = summarize_selection(
            selected_frame,
            {
                attempt_id: safe_consensus_selection(group)
                for attempt_id, group in selected_frame.groupby("attemptId", sort=False)
            },
        )
    summary = {
        "schemaVersion": 1,
        "manifest": str(Path(args.manifest).resolve()),
        "featureColumns": columns,
        "rows": int(len(frame)),
        "attempts": int(frame["attemptId"].nunique()),
        "safeConsensus": safe_summaries,
        "modelSearch": results,
        "selectedModel": best_name,
        "selectedThresholds": {
            key: best_config[key]
            for key in ("minimumProbability", "minimumMargin", "minimumSupport")
        },
        "preExternalThresholds": pre_external_thresholds,
        "thresholdCalibration": threshold_calibration,
        "development": summarize_selection(development, development_selected),
        "calibration": summarize_selection(calibration, calibration_selected),
        "reserve": summarize_selection(reserve, reserve_selected),
        "externalEvaluation": external_summaries,
    }
    frame.to_csv(output_dir / "candidate-table.csv", index=False)
    selected_details = {
        "development": selection_details(
            development,
            development_selected,
            f"probability_{best_name}",
        ),
        "calibration": selection_details(
            calibration,
            calibration_selected,
            f"probability_{best_name}",
        ),
        "reserve": selection_details(
            reserve,
            reserve_selected,
            f"probability_{best_name}",
        ),
        **{
            name: selection_details(
                external_frames[name],
                external_selected[name],
                f"probability_{best_name}",
            )
            for name in external_frames
        },
    }
    (output_dir / "selected-attempts.json").write_text(
        json.dumps(selected_details, indent=2) + "\n", encoding="utf-8"
    )
    if best_name == "logistic":
        scaler = final_model.named_steps["standardscaler"]
        classifier = final_model.named_steps["logisticregression"]
        artifact = {
            "schemaVersion": 1,
            "modelType": "standardized-logistic",
            "featureColumns": columns,
            "means": scaler.mean_.tolist(),
            "scales": scaler.scale_.tolist(),
            "coefficients": classifier.coef_[0].tolist(),
            "intercept": float(classifier.intercept_[0]),
            "thresholds": summary["selectedThresholds"],
        }
        (output_dir / "model.json").write_text(
            json.dumps(artifact, indent=2) + "\n", encoding="utf-8"
        )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print("INTERNAL_REFERENCE_VIEW_SELECTOR_COMPLETE " + json.dumps(summary))


if __name__ == "__main__":
    main()
