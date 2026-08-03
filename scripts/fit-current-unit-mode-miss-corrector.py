"""Fit a gated older/covered/newer correction for an existing 13-year mode.

The base locator remains the default. The classifier may move the mode to one
coarse-window edge only when file-grouped OOF and calibration show that the
side decision recovers more windows than it loses. Validation is report-only.
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


HERE = Path(__file__).resolve().parent
MODE_PATH = HERE / "fit-file-grouped-unit-mode-window-model.py"
SPEC = importlib.util.spec_from_file_location("unit_mode_trainer", MODE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {MODE_PATH}")
MODE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODE
SPEC.loader.exec_module(MODE)

WINDOW_WIDTH = 13


@dataclass(frozen=True)
class Case:
    source: dict[str, Any]
    features: np.ndarray
    label: int
    group: str


@dataclass(frozen=True)
class Configuration:
    feature_set: str
    num_leaves: int
    max_depth: int
    min_child_samples: int
    n_estimators: int
    side_weight: int

    @property
    def name(self) -> str:
        return (
            f"{self.feature_set}:l{self.num_leaves}:d{self.max_depth}:"
            f"m{self.min_child_samples}:n{self.n_estimators}:w{self.side_weight}"
        )


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def load_cases(
    paths: Sequence[Path],
    event_type: str,
    point_names: Sequence[str],
) -> list[Case]:
    windows = MODE.load_cases(paths, "source", event_type, point_names, "binary")
    result = []
    for case in windows:
        source = dict(case.source)
        source.pop("coarseCandidateCounterfactuals", None)
        mode = source["modeWindow"]
        truth = int(source["truthYear"])
        coarse = source["coarseWindow"]
        coarse_hit = int(coarse["startYear"]) <= truth <= int(coarse["endYear"])
        mode_start = int(mode["startYear"])
        index = int(np.argmin(np.abs(case.starts - mode_start)))
        if mode_start <= truth <= int(mode["endYear"]) or not coarse_hit:
            label = 0
        elif truth < mode_start:
            label = 1
        else:
            label = 2
        result.append(Case(
            source=source,
            features=case.features[index],
            label=label,
            group=case.group,
        ))
    return result


def make_model(configuration: Configuration, seed: int):
    return lgb.LGBMClassifier(
        objective="multiclass",
        num_class=3,
        n_estimators=configuration.n_estimators,
        learning_rate=0.025,
        num_leaves=configuration.num_leaves,
        max_depth=configuration.max_depth,
        min_child_samples=configuration.min_child_samples,
        max_bin=63,
        reg_lambda=12,
        reg_alpha=2,
        colsample_bytree=0.7,
        subsample=0.85,
        subsample_freq=1,
        class_weight={0: 1, 1: configuration.side_weight, 2: configuration.side_weight},
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def fit(cases: Sequence[Case], configuration: Configuration, seed: int):
    model = make_model(configuration, seed)
    model.fit(
        np.stack([case.features for case in cases]),
        np.asarray([case.label for case in cases]),
    )
    return model


def predict(model: Any, cases: Sequence[Case], fold: str | int):
    probabilities = model.predict_proba(np.stack([case.features for case in cases]))
    return [
        {
            "case": case,
            "fold": fold,
            "covered": float(row[0]),
            "older": float(row[1]),
            "newer": float(row[2]),
        }
        for case, row in zip(cases, probabilities)
    ]


def cross_validated(cases: Sequence[Case], configuration: Configuration, folds: int):
    group_labels: dict[str, int] = {}
    for case in cases:
        group_labels[case.group] = max(group_labels.get(case.group, 0), case.label)
    assignments: dict[str, int] = {}
    for label in range(3):
        groups = sorted(
            group for group, selected in group_labels.items() if selected == label
        )
        for index, group in enumerate(groups):
            assignments[group] = index % folds
    rows = []
    for fold in range(folds):
        train = [case for case in cases if assignments[case.group] != fold]
        test = [case for case in cases if assignments[case.group] == fold]
        rows.extend(predict(fit(train, configuration, 20260830 + fold), test, fold))
    return rows


def selected_window(row: dict[str, Any], gate: dict[str, float]):
    case = row["case"]
    source = case.source
    mode = source["modeWindow"]
    side = max(row["older"], row["newer"])
    accepted = (
        side >= gate["minimumSideProbability"]
        and side - row["covered"] >= gate["minimumCoveredMargin"]
        and abs(row["older"] - row["newer"]) >= gate["minimumDirectionMargin"]
    )
    if not accepted:
        return int(mode["startYear"]), int(mode["endYear"])
    coarse = source["coarseWindow"]
    if row["older"] > row["newer"]:
        start = int(coarse["startYear"])
    else:
        start = int(coarse["endYear"]) - WINDOW_WIDTH + 1
    return start, start + WINDOW_WIDTH - 1


def metrics(rows: Sequence[dict[str, Any]], gate: dict[str, float]):
    old_hits = new_hits = gains = losses = changes = 0
    for row in rows:
        source = row["case"].source
        truth = int(source["truthYear"])
        mode = source["modeWindow"]
        old = int(mode["startYear"]) <= truth <= int(mode["endYear"])
        selected = selected_window(row, gate)
        new = selected[0] <= truth <= selected[1]
        old_hits += int(old)
        new_hits += int(new)
        gains += int(new and not old)
        losses += int(old and not new)
        changes += int(selected != (int(mode["startYear"]), int(mode["endYear"])))
    return {
        "cases": len(rows),
        "oldHits": old_hits,
        "newHits": new_hits,
        "coverage": new_hits / max(1, len(rows)),
        "delta": new_hits - old_hits,
        "gains": gains,
        "losses": losses,
        "changes": changes,
    }


def gates():
    for probability in np.arange(0.25, 0.951, 0.05):
        for covered_margin in np.arange(-0.4, 0.701, 0.1):
            for direction_margin in (0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5):
                yield {
                    "minimumSideProbability": float(probability),
                    "minimumCoveredMargin": float(covered_margin),
                    "minimumDirectionMargin": float(direction_margin),
                }


def select_gate(oof: Sequence[dict[str, Any]], calibration: Sequence[dict[str, Any]]):
    candidates = []
    folds = sorted(set(row["fold"] for row in oof))
    for gate in gates():
        folded = [metrics([row for row in oof if row["fold"] == fold], gate)
                  for fold in folds]
        overall = metrics(oof, gate)
        calibrated = metrics(calibration, gate)
        if any(row["delta"] < 0 for row in folded) or calibrated["delta"] < 0:
            continue
        if overall["gains"] + calibrated["gains"] == 0:
            continue
        score = (
            min([row["delta"] for row in folded] + [calibrated["delta"]]),
            overall["delta"] + calibrated["delta"],
            -(overall["losses"] + calibrated["losses"]),
            -(overall["changes"] + calibrated["changes"]),
        )
        candidates.append((score, gate, overall, folded, calibrated))
    return max(candidates, default=None, key=lambda row: row[0])


def compact_tree(node: dict[str, Any]) -> dict[str, Any]:
    if "leaf_value" in node:
        return {"leaf_value": node["leaf_value"]}
    return {
        "split_feature": node["split_feature"],
        "threshold": node["threshold"],
        "decision_type": node["decision_type"],
        "default_left": node["default_left"],
        "left_child": compact_tree(node["left_child"]),
        "right_child": compact_tree(node["right_child"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", required=True)
    parser.add_argument("--event", default="falseRing")
    parser.add_argument("--bundle", default=(
        "src/features/crossdating/diagnosis/unitEventPointWindowModel.json"
    ))
    parser.add_argument("--report", default=".tmp-unit-mode-miss-corrector-report.json")
    parser.add_argument("--model", default=".tmp-unit-mode-miss-corrector-model.json")
    args = parser.parse_args()

    point_bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    feature_sets = MODE.POINT.feature_sets(args.event, point_bundle)
    configurations = [
        Configuration(feature_set, leaves, depth, minimum, estimators, weight)
        for feature_set in ("compact", "boundary")
        for leaves, depth in ((3, 2), (5, 3), (9, 4))
        for minimum in (10, 20, 40)
        for estimators in (50, 100)
        for weight in (4, 8, 12)
    ]
    prepared = {}
    for feature_set in ("compact", "boundary"):
        names = feature_sets[feature_set]
        prepared[feature_set] = {
            "names": names,
            "train": load_cases(parse_paths(args.train), args.event, names),
            "calibration": load_cases(
                parse_paths(args.calibration), args.event, names
            ),
            "validation": load_cases(
                parse_paths(args.validation), args.event, names
            ),
        }

    candidates = []
    for configuration in configurations:
        data = prepared[configuration.feature_set]
        oof = cross_validated(data["train"], configuration, 5)
        train_model = fit(data["train"], configuration, 20260840)
        calibration = predict(train_model, data["calibration"], "calibration")
        selected = select_gate(oof, calibration)
        if selected is None:
            continue
        score, gate, oof_metrics, folds, calibration_metrics = selected
        candidates.append({
            "score": score,
            "configuration": configuration,
            "gate": gate,
            "oof": oof_metrics,
            "folds": folds,
            "calibration": calibration_metrics,
        })
    candidates.sort(key=lambda row: row["score"], reverse=True)
    selected = candidates[0] if candidates else None
    if selected is None:
        raise RuntimeError("No non-regressing mode correction gate was found")
    configuration = selected["configuration"]
    data = prepared[configuration.feature_set]
    final_model = fit(
        [*data["train"], *data["calibration"]], configuration, 20260841
    )
    validation_rows = predict(final_model, data["validation"], "validation")
    validation = metrics(validation_rows, selected["gate"])
    feature_names = MODE.window_feature_names(data["names"])
    report = {
        "schemaVersion": 1,
        "eventType": args.event,
        "selectionPolicy": "file-grouped train OOF plus calibration; validation report-only",
        "selected": {
            "configuration": configuration.name,
            "featureCount": len(feature_names),
            "gate": selected["gate"],
            "oof": selected["oof"],
            "folds": selected["folds"],
            "calibration": selected["calibration"],
            "validation": validation,
        },
        "runnerUp": [
            {
                "configuration": row["configuration"].name,
                "gate": row["gate"],
                "oof": row["oof"],
                "calibration": row["calibration"],
            }
            for row in candidates[:12]
        ],
        "validationChanges": [
            {
                "file": row["case"].source["context"]["file"],
                "target": row["case"].source["context"]["target"],
                "truthYear": row["case"].source["truthYear"],
                "oldWindow": row["case"].source["modeWindow"],
                "newWindow": selected_window(row, selected["gate"]),
                "probabilities": {
                    "covered": row["covered"],
                    "older": row["older"],
                    "newer": row["newer"],
                },
            }
            for row in validation_rows
            if selected_window(row, selected["gate"]) != (
                int(row["case"].source["modeWindow"]["startYear"]),
                int(row["case"].source["modeWindow"]["endYear"]),
            )
        ],
    }
    model = {
        "version": 1,
        "eventType": args.event,
        "pointFeatureNames": data["names"],
        "featureNames": feature_names,
        "windowWidth": WINDOW_WIDTH,
        "gate": selected["gate"],
        "training": {
            "configuration": configuration.name,
            "trainCases": len(data["train"]),
            "calibrationCases": len(data["calibration"]),
            "validationCases": len(data["validation"]),
        },
        "model": {
            "tree_info": [
                {"tree_structure": compact_tree(tree["tree_structure"])}
                for tree in final_model.booster_.dump_model()["tree_info"]
            ],
        },
    }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.model).write_text(json.dumps(model, indent=2), encoding="utf-8")
    print(json.dumps(report["selected"], indent=2))
    print(json.dumps(report["validationChanges"], indent=2))


if __name__ == "__main__":
    main()
