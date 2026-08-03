"""Fit a file-grouped direct 13-year mode ranker for unit events.

Unlike the point ranker, each training row is a complete candidate window. The
features preserve older/newer flank asymmetry so adjacent windows need not be
resolved by summing a broad year-level probability plateau. Validation files
are report-only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
POINT_TRAINER_PATH = HERE / "fit-file-grouped-unit-point-model.py"
SPEC = importlib.util.spec_from_file_location("unit_point_trainer", POINT_TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {POINT_TRAINER_PATH}")
POINT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POINT
SPEC.loader.exec_module(POINT)

EVENT_TYPES = ("missingRing", "falseRing")
WINDOW_WIDTH = 13
HALF_WIDTH = WINDOW_WIDTH // 2


@dataclass(frozen=True)
class WindowCase:
    source: dict[str, Any]
    features: np.ndarray
    labels: np.ndarray
    starts: np.ndarray
    group: str
    dataset: str


@dataclass(frozen=True)
class Configuration:
    feature_set: str
    label_type: str
    num_leaves: int
    max_depth: int
    min_child_samples: int
    n_estimators: int

    @property
    def name(self) -> str:
        return (
            f"{self.feature_set}:{self.label_type}:l{self.num_leaves}:"
            f"d{self.max_depth}:m{self.min_child_samples}:n{self.n_estimators}"
        )


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def mean(values: Sequence[float]) -> float:
    return sum(values) / max(1, len(values))


def window_feature_names(point_names: Sequence[str]) -> list[str]:
    aggregates = (
        "mean",
        "maximum",
        "center",
        "older3",
        "newer3",
        "flankDelta",
        "before3",
        "after3",
        "enterDelta",
        "exitDelta",
    )
    return [
        *[
            f"{aggregate}:{name}"
            for name in point_names
            for aggregate in aggregates
        ],
        "relativeStart",
        "relativeEnd",
        "relativeCenter",
        "currentModeSigned",
        "currentModeDistance",
        "currentModeOverlap",
        "sourceCurrentMode",
        "sourceCurrentFinalCenter",
        "sourceCoarseOlderEdge",
        "sourceCoarseNewerEdge",
        "sourceCurrentCenter",
        "sourceOperationCenter",
        "sourceSideCenter",
        "currentCenterDistance",
        "operationCenterDistance",
        "sideCenterDistance",
        "oldWasNarrow",
        "learnedWindowScore",
        "learnedWindowMargin",
        "learnedWindowRemoteMargin",
        "nineYearSafety",
        "nineYearSafetyMargin",
    ]


def build_window_matrix(
    source: dict[str, Any],
    point_matrix: np.ndarray,
    years: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    rows = []
    starts = []
    coarse = source["coarseWindow"]
    coarse_start = int(coarse["startYear"])
    coarse_end = int(coarse["endYear"])
    span = max(1, coarse_end - coarse_start)
    mode = source["modeWindow"]
    mode_start = int(mode["startYear"])
    mode_end = int(mode["endYear"])
    mode_center = (mode_start + mode_end) / 2
    final = source["finalWindow"]
    final_center = (int(final["startYear"]) + int(final["endYear"])) / 2
    operation = source.get("selectedOperation") or {}

    def bounded_start(anchor: Any) -> int | None:
        if anchor is None:
            return None
        return max(
            int(years[0]),
            min(round(float(anchor)) - HALF_WIDTH, int(years[-1]) - WINDOW_WIDTH + 1),
        )

    current_start = bounded_start(source.get("currentPrimaryYear"))
    operation_start = bounded_start(operation.get("bestYear"))
    side_start = bounded_start(operation.get("sideStepBestYear"))
    learned_score = float(source.get("learnedWindowScore") or 0)
    learned_margin = float(source.get("learnedWindowMargin") or 0)
    learned_remote = float(source.get("learnedWindowRemoteMargin") or 0)
    nine_safety = float(source.get("nineYearSafety") or 0)
    nine_threshold = float(source.get("nineYearSafetyThreshold") or 1)
    for index in range(0, len(years) - WINDOW_WIDTH + 1):
        start = int(years[index])
        end = start + WINDOW_WIDTH - 1
        if int(years[index + WINDOW_WIDTH - 1]) != end:
            continue
        window = point_matrix[index:index + WINDOW_WIDTH]
        center = start + HALF_WIDTH
        values = []
        for column in range(window.shape[1]):
            series = window[:, column]
            older = float(np.mean(series[:3]))
            newer = float(np.mean(series[-3:]))
            before_rows = point_matrix[max(0, index - 3):index, column]
            after_rows = point_matrix[
                index + WINDOW_WIDTH:index + WINDOW_WIDTH + 3,
                column,
            ]
            before = float(np.mean(before_rows)) if len(before_rows) else older
            after = float(np.mean(after_rows)) if len(after_rows) else newer
            values.extend((
                float(np.mean(series)),
                float(np.max(series)),
                float(series[HALF_WIDTH]),
                older,
                newer,
                newer - older,
                before,
                after,
                older - before,
                after - newer,
            ))
        overlap = max(0, min(end, mode_end) - max(start, mode_start) + 1)
        values.extend((
            (start - coarse_start) / span,
            (end - coarse_start) / span,
            (center - coarse_start) / span,
            (center - mode_center) / span,
            abs(center - mode_center) / span,
            overlap / WINDOW_WIDTH,
            float(start == mode_start),
            float(center == round(final_center)),
            float(start == coarse_start),
            float(end == coarse_end),
            float(current_start is not None and start == current_start),
            float(operation_start is not None and start == operation_start),
            float(side_start is not None and start == side_start),
            1.0 if current_start is None else abs(start - current_start) / span,
            1.0 if operation_start is None else abs(start - operation_start) / span,
            1.0 if side_start is None else abs(start - side_start) / span,
            float(int(source.get("calibratedWidth", 0)) == 9),
            learned_score,
            learned_margin,
            learned_remote,
            nine_safety,
            nine_safety - nine_threshold,
        ))
        rows.append(values)
        starts.append(start)
    return np.asarray(rows, dtype=np.float32), np.asarray(starts, dtype=int)


def load_cases(
    paths: Sequence[Path],
    dataset: str,
    event_type: str,
    point_names: Sequence[str],
    label_type: str,
) -> list[WindowCase]:
    result = []
    seen: set[tuple[str, str, int]] = set()
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            if context.get("baselineFlagged", True):
                continue
            if source.get("eventType") != event_type:
                continue
            if source.get("correctionYears") != source.get("truthCorrectionYears"):
                continue
            if any(name not in source for name in ("years", "ranks")):
                continue
            if "coarseWindow" not in source or "modeWindow" not in source:
                current_candidate = next((
                    candidate
                    for candidate in source.get("candidates", [])
                    if candidate.get("source") == "current_event"
                ), None)
                current_year = source.get("currentPrimaryYear")
                if current_candidate is None or current_year is None:
                    continue
                coarse = {
                    "startYear": int(current_candidate["startYear"]),
                    "endYear": int(current_candidate["endYear"]),
                }
                mode = {
                    "startYear": int(current_year) - HALF_WIDTH,
                    "endYear": int(current_year) + HALF_WIDTH,
                }
                source = {
                    **source,
                    "coarseWindow": coarse,
                    "modeWindow": mode,
                    "finalWindow": mode,
                    "calibratedWidth": WINDOW_WIDTH,
                }
            key = (
                str(context.get("file", "")),
                str(context.get("target", "")),
                int(source["truthYear"]),
            )
            if key in seen:
                continue
            seen.add(key)
            point_matrix, years = POINT.feature_columns(source, point_names)
            matrix, starts = build_window_matrix(source, point_matrix, years)
            if len(starts) == 0:
                continue
            truth = int(source["truthYear"])
            if label_type == "binary":
                labels = np.asarray([
                    int(start <= truth <= start + WINDOW_WIDTH - 1)
                    for start in starts
                ], dtype=int)
            else:
                labels = np.asarray([
                    max(0, HALF_WIDTH + 1 - abs(start + HALF_WIDTH - truth))
                    for start in starts
                ], dtype=int)
            result.append(WindowCase(
                source=source,
                features=matrix,
                labels=labels,
                starts=starts,
                group=str(context.get("file", key[0])),
                dataset=dataset,
            ))
    return result


def configurations(feature_sets: Sequence[str]) -> list[Configuration]:
    return [
        Configuration(feature_set, label_type, leaves, depth, minimum, estimators)
        for feature_set in feature_sets
        for label_type in ("binary", "central")
        for leaves, depth in ((5, 3), (9, 4), (15, 4))
        for minimum in (20, 40, 70)
        for estimators in (50, 100)
    ]


def make_ranker(configuration: Configuration, seed: int):
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 3, 7, 15, 31, 63, 127],
        n_estimators=configuration.n_estimators,
        learning_rate=0.03,
        num_leaves=configuration.num_leaves,
        max_depth=configuration.max_depth,
        min_child_samples=configuration.min_child_samples,
        max_bin=63,
        feature_fraction=0.8,
        bagging_fraction=0.85,
        bagging_freq=1,
        reg_lambda=3.0,
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
    )


def fit_ranker(cases: Sequence[WindowCase], configuration: Configuration, seed: int):
    model = make_ranker(configuration, seed)
    model.fit(
        np.concatenate([case.features for case in cases]),
        np.concatenate([case.labels for case in cases]),
        group=[len(case.starts) for case in cases],
    )
    return model


def predict_cases(model: Any, cases: Sequence[WindowCase]):
    predictions = []
    for case in cases:
        scores = model.predict(case.features)
        index = max(range(len(scores)), key=lambda row: (scores[row], case.starts[row]))
        start = int(case.starts[index])
        predictions.append((start, start + WINDOW_WIDTH - 1, float(scores[index])))
    return predictions


def summarize(cases: Sequence[WindowCase], predictions: Sequence[tuple[int, int, float]]):
    hits = []
    current_hits = []
    coarse_hits = []
    errors = []
    by_dataset: dict[str, list[bool]] = {}
    for case, (start, end, _) in zip(cases, predictions):
        truth = int(case.source["truthYear"])
        hit = start <= truth <= end
        hits.append(hit)
        mode = case.source["modeWindow"]
        current_hits.append(int(mode["startYear"]) <= truth <= int(mode["endYear"]))
        coarse = case.source["coarseWindow"]
        coarse_hits.append(int(coarse["startYear"]) <= truth <= int(coarse["endYear"]))
        errors.append(abs((start + HALF_WIDTH) - truth))
        by_dataset.setdefault(case.dataset, []).append(hit)
    return {
        "cases": len(cases),
        "hits": sum(hits),
        "coverage": mean(hits),
        "currentHits": sum(current_hits),
        "currentCoverage": mean(current_hits),
        "coarseHits": sum(coarse_hits),
        "delta": sum(hits) - sum(current_hits),
        "medianCenterError": float(np.median(errors)) if errors else 0,
        "byDataset": {
            name: {"cases": len(values), "hits": sum(values), "coverage": mean(values)}
            for name, values in sorted(by_dataset.items())
        },
    }


def cross_validated(cases: Sequence[WindowCase], configuration: Configuration, folds: int):
    groups = np.asarray([case.group for case in cases])
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    predictions: list[tuple[int, int, float] | None] = [None] * len(cases)
    fold_rows = []
    for fold, (fit_indexes, test_indexes) in enumerate(
        splitter.split(np.arange(len(cases)), groups=groups)
    ):
        train = [cases[index] for index in fit_indexes]
        test = [cases[index] for index in test_indexes]
        model = fit_ranker(train, configuration, 20260820 + fold)
        selected = predict_cases(model, test)
        for index, prediction in zip(test_indexes, selected):
            predictions[int(index)] = prediction
        fold_rows.append({"fold": fold, **summarize(test, selected)})
    return [row for row in predictions if row is not None], fold_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument("--events", default="missingRing")
    parser.add_argument("--feature-sets", default="")
    parser.add_argument("--labels", default="")
    parser.add_argument(
        "--bundle",
        default="src/features/crossdating/diagnosis/unitEventPointWindowModel.json",
    )
    parser.add_argument("--report", default=".tmp-file-grouped-unit-mode-window-report.json")
    parser.add_argument("--model", default=".tmp-file-grouped-unit-mode-window-model.json")
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()

    event_types = tuple(item.strip() for item in args.events.split(",") if item.strip())
    requested_feature_sets = {
        item.strip() for item in args.feature_sets.split(",") if item.strip()
    }
    requested_labels = {
        item.strip() for item in args.labels.split(",") if item.strip()
    }
    train_paths = parse_paths(args.train)
    calibration_paths = parse_paths(args.calibration)
    validation_paths = parse_paths(args.validation)
    current_bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "splitPolicy": "file-disjoint train/calibration/validation; file-grouped OOF",
        "windowWidth": WINDOW_WIDTH,
        "eventTypes": {},
    }
    bundle: dict[str, Any] = {"version": 1, "eventTypes": {}}

    for event_type in event_types:
        point_feature_sets = POINT.feature_sets(event_type, current_bundle)
        if requested_feature_sets:
            point_feature_sets = {
                name: values
                for name, values in point_feature_sets.items()
                if name in requested_feature_sets
            }
        prepared: dict[str, dict[str, dict[str, list[WindowCase]]]] = {}
        for feature_set, point_names in point_feature_sets.items():
            prepared[feature_set] = {}
            for label_type in ("binary", "central"):
                if requested_labels and label_type not in requested_labels:
                    continue
                prepared[feature_set][label_type] = {
                    "train": load_cases(
                        train_paths, "train", event_type, point_names, label_type
                    ),
                    "calibration": load_cases(
                        calibration_paths, "calibration", event_type, point_names, label_type
                    ),
                    "validation": load_cases(
                        validation_paths, "validation", event_type, point_names, label_type
                    ),
                }
        candidates = []
        for configuration in configurations(tuple(point_feature_sets)):
            if requested_labels and configuration.label_type not in requested_labels:
                continue
            data = prepared[configuration.feature_set][configuration.label_type]
            oof_predictions, folds = cross_validated(
                data["train"], configuration, args.folds
            )
            oof = summarize(data["train"], oof_predictions)
            model = fit_ranker(data["train"], configuration, 20260820)
            calibration_predictions = predict_cases(model, data["calibration"])
            calibration = summarize(data["calibration"], calibration_predictions)
            worst_fold = min(row["coverage"] for row in folds)
            score = (
                min(worst_fold, calibration["coverage"]),
                min(oof["delta"], calibration["delta"]),
                mean((oof["coverage"], calibration["coverage"])),
                -calibration["medianCenterError"],
            )
            candidates.append({
                "configuration": configuration,
                "model": model,
                "oof": oof,
                "folds": folds,
                "worstFoldCoverage": worst_fold,
                "calibration": calibration,
                "selectionScore": score,
            })
        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        selected = candidates[0]
        configuration = selected["configuration"]
        data = prepared[configuration.feature_set][configuration.label_type]
        final_model = fit_ranker(
            [*data["train"], *data["calibration"]], configuration, 20260821
        )
        validation = summarize(
            data["validation"], predict_cases(final_model, data["validation"])
        ) if data["validation"] else None
        point_names = point_feature_sets[configuration.feature_set]
        selected_report = {
            "configuration": configuration.name,
            "featureCount": len(window_feature_names(point_names)),
            "oof": selected["oof"],
            "folds": selected["folds"],
            "worstFoldCoverage": selected["worstFoldCoverage"],
            "calibration": selected["calibration"],
            "validation": validation,
        }
        report["eventTypes"][event_type] = {
            "selected": selected_report,
            "runnerUp": [
                {
                    "configuration": row["configuration"].name,
                    "oof": row["oof"],
                    "worstFoldCoverage": row["worstFoldCoverage"],
                    "calibration": row["calibration"],
                }
                for row in candidates[:12]
            ],
        }
        bundle["eventTypes"][event_type] = {
            "pointFeatureNames": point_names,
            "featureNames": window_feature_names(point_names),
            "windowWidth": WINDOW_WIDTH,
            "training": {
                "configuration": configuration.name,
                "trainCases": len(data["train"]),
                "calibrationCases": len(data["calibration"]),
                "validationCases": len(data["validation"]),
            },
            "model": final_model.booster_.dump_model(),
        }
        print(json.dumps({event_type: selected_report}, ensure_ascii=False))

    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    Path(args.model).write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Wrote {args.report} and {args.model}")


if __name__ == "__main__":
    main()
