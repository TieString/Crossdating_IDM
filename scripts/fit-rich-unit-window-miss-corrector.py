"""Calibrate a file-grouped left/covered/right correction for 13-year windows."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


WINDOW_WIDTH = 13


@dataclass(frozen=True)
class Case:
    source: dict[str, Any]
    features: np.ndarray
    label: int
    current: tuple[int, int]
    group: str
    dataset: str


def normalize(values: np.ndarray) -> np.ndarray:
    scale = float(np.std(values))
    return (values - float(np.mean(values))) / (scale if scale > 1e-8 else 1.0)


def rank_score(values: np.ndarray) -> np.ndarray:
    order = np.lexsort((-np.arange(len(values)), -values))
    ranks = np.empty(len(values), dtype=np.float32)
    ranks[order] = np.arange(len(values), dtype=np.float32)
    return 1 - ranks / max(1, len(values) - 1)


def bounded_start(center: float, coarse: Sequence[int]) -> int:
    start = round(center) - WINDOW_WIDTH // 2
    return max(int(coarse[0]), min(start, int(coarse[1]) - WINDOW_WIDTH + 1))


def dataset_name(source: dict[str, Any]) -> str:
    return (
        "reserved"
        if "reserved-rich" in str(source.get("sourceAudit", ""))
        else str(source["split"])
    )


def summary(values: np.ndarray) -> tuple[float, float]:
    return (
        float(np.mean(values)) if len(values) else 0,
        float(np.max(values)) if len(values) else 0,
    )


def build_case(source: dict[str, Any], names: Sequence[str]) -> Case | None:
    if not source.get("primaryRange") or len(source.get("rows", [])) < WINDOW_WIDTH:
        return None
    rows = source["rows"]
    years = np.asarray([row["year"] for row in rows], dtype=int)
    current_center = sum(source["primaryRange"]) / 2
    start = bounded_start(current_center, source["coarseRange"])
    end = start + WINDOW_WIDTH - 1
    truth = int(source["truthYear"])
    label = 1 if truth < start else 2 if truth > end else 0
    span = max(1, source["coarseRange"][1] - source["coarseRange"][0])
    current_mask = (years >= start) & (years <= end)
    older_mask = years < start
    newer_mask = years > end
    older_flank = (years >= start - 6) & older_mask
    newer_flank = (years <= end + 6) & newer_mask
    features: list[float] = [
        (current_center - source["coarseRange"][0]) / span,
        (start - source["coarseRange"][0]) / span,
        (source["coarseRange"][1] - end) / span,
        (source["primaryRange"][1] - source["primaryRange"][0] + 1) / WINDOW_WIDTH,
        float(source.get("signalStrength") or 0),
    ]
    position = str(source.get("positionStratum") or "")
    features.extend(float(position == value) for value in (
        "olderEdge", "olderInterior", "middle", "newerInterior", "newerEdge",
    ))
    for name in names:
        raw = np.asarray([row["features"][name] for row in rows], dtype=np.float32)
        for values in (normalize(raw), rank_score(raw)):
            current_mean, current_max = summary(values[current_mask])
            older_mean, older_max = summary(values[older_mask])
            newer_mean, newer_max = summary(values[newer_mask])
            older_flank_mean, older_flank_max = summary(values[older_flank])
            newer_flank_mean, newer_flank_max = summary(values[newer_flank])
            peak_index = int(np.argmax(values))
            center_index = int(np.argmin(np.abs(years - round(current_center))))
            features.extend((
                (int(years[peak_index]) - current_center) / span,
                current_mean,
                current_max,
                older_mean,
                older_max,
                newer_mean,
                newer_max,
                older_flank_mean - current_mean,
                older_flank_max - current_max,
                newer_flank_mean - current_mean,
                newer_flank_max - current_max,
                float(values[center_index]),
            ))
    return Case(
        source=source,
        features=np.asarray(features, dtype=np.float32),
        label=label,
        current=(start, end),
        group=str(source["file"]).lower(),
        dataset=dataset_name(source),
    )


def make_model(seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="multiclass",
        num_class=3,
        n_estimators=100,
        learning_rate=0.025,
        num_leaves=7,
        max_depth=3,
        min_child_samples=30,
        max_bin=63,
        reg_lambda=30,
        reg_alpha=6,
        colsample_bytree=0.65,
        subsample=0.85,
        subsample_freq=1,
        class_weight="balanced",
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def fit(cases: Sequence[Case], seed: int) -> lgb.LGBMClassifier:
    model = make_model(seed)
    model.fit(
        np.stack([case.features for case in cases]),
        np.asarray([case.label for case in cases]),
    )
    return model


def score(model: Any, cases: Sequence[Case], fold: str | int) -> list[dict[str, Any]]:
    probabilities = model.predict_proba(np.stack([case.features for case in cases]))
    return [
        {
            "key": case.source["key"],
            "fold": fold,
            "dataset": case.dataset,
            "truth": int(case.source["truthYear"]),
            "coarse": case.source["coarseRange"],
            "current": case.current,
            "label": case.label,
            "coveredProbability": float(row[0]),
            "olderProbability": float(row[1]),
            "newerProbability": float(row[2]),
        }
        for case, row in zip(cases, probabilities)
    ]


def shifted_window(row: dict[str, Any], shift: int) -> tuple[int, int]:
    direction = -1 if row["olderProbability"] > row["newerProbability"] else 1
    start = row["current"][0] + direction * shift
    start = max(row["coarse"][0], min(start, row["coarse"][1] - WINDOW_WIDTH + 1))
    return start, start + WINDOW_WIDTH - 1


def metrics(rows: Sequence[dict[str, Any]], gate: Any) -> dict[str, Any]:
    old_hits = new_hits = gains = losses = changes = 0
    for row in rows:
        old = row["current"][0] <= row["truth"] <= row["current"][1]
        selected = shifted_window(row, gate["shift"]) if (
            max(row["olderProbability"], row["newerProbability"])
                >= gate["minimumSideProbability"]
            and max(row["olderProbability"], row["newerProbability"])
                - row["coveredProbability"] >= gate["minimumCoveredMargin"]
            and abs(row["olderProbability"] - row["newerProbability"])
                >= gate["minimumDirectionMargin"]
        ) else tuple(row["current"])
        new = selected[0] <= row["truth"] <= selected[1]
        old_hits += int(old)
        new_hits += int(new)
        gains += int(new and not old)
        losses += int(old and not new)
        changes += int(selected != tuple(row["current"]))
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


def select_gate(oof: Sequence[dict[str, Any]], calibration: Sequence[dict[str, Any]]):
    options = []
    for probability in np.arange(0.35, 0.951, 0.05):
        for covered_margin in np.arange(-0.2, 0.601, 0.1):
            for direction_margin in (0, 0.05, 0.1, 0.2, 0.3, 0.4):
                for shift in (2, 3, 4, 5, 6, 8, 10, 12):
                    gate = {
                        "minimumSideProbability": float(probability),
                        "minimumCoveredMargin": float(covered_margin),
                        "minimumDirectionMargin": float(direction_margin),
                        "shift": shift,
                    }
                    fold_rows = [
                        metrics([row for row in oof if row["fold"] == fold], gate)
                        for fold in sorted(set(row["fold"] for row in oof))
                    ]
                    oof_metrics = metrics(oof, gate)
                    calibration_metrics = metrics(calibration, gate)
                    score = (
                        min([row["delta"] for row in fold_rows] + [calibration_metrics["delta"]]),
                        oof_metrics["delta"] + calibration_metrics["delta"],
                        -(oof_metrics["losses"] + calibration_metrics["losses"]),
                        -(oof_metrics["changes"] + calibration_metrics["changes"]),
                    )
                    options.append((score, gate, oof_metrics, fold_rows, calibration_metrics))
    return max(options, key=lambda row: row[0])


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
    parser.add_argument("--dataset", default=".tmp-unit-coarse-window-year-dataset.json")
    parser.add_argument("--report", default=".tmp-rich-unit-window-miss-report.json")
    parser.add_argument("--model", default=".tmp-rich-unit-window-miss-model.json")
    args = parser.parse_args()
    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    names = tuple(sorted(
        name for name in raw[0]["rows"][0]["features"] if "Boundary" not in name
    ))
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    bundle: dict[str, Any] = {"version": 1, "eventTypes": {}}
    for event_type in ("missingRing", "falseRing"):
        cases = [
            case
            for source in raw
            if source["eventType"] == event_type
            for case in [build_case(source, names)]
            if case is not None
        ]
        datasets = {
            name: [case for case in cases if case.dataset == name]
            for name in ("train", "calibration", "validation", "reserved")
        }
        groups = np.asarray([case.group for case in datasets["train"]])
        splitter = GroupKFold(n_splits=5)
        oof = []
        for fold, (fit_indexes, test_indexes) in enumerate(
            splitter.split(np.arange(len(datasets["train"])), groups=groups)
        ):
            model = fit([datasets["train"][index] for index in fit_indexes], 20260920 + fold)
            oof.extend(score(
                model,
                [datasets["train"][index] for index in test_indexes],
                fold,
            ))
        development_model = fit(datasets["train"], 20260930)
        calibration = score(development_model, datasets["calibration"], "calibration")
        _, gate, oof_metrics, folds, calibration_metrics = select_gate(oof, calibration)
        final_model = fit([*datasets["train"], *datasets["calibration"]], 20260931)
        validation = score(final_model, datasets["validation"], "validation")
        reserved = score(final_model, datasets["reserved"], "reserved")
        report["eventTypes"][event_type] = {
            "gate": gate,
            "oof": oof_metrics,
            "folds": folds,
            "calibration": calibration_metrics,
            "validation": metrics(validation, gate),
            "reserved": metrics(reserved, gate),
            "changedReserved": [
                row for row in reserved
                if metrics([row], gate)["changes"] > 0
            ],
        }
        dumped = final_model.booster_.dump_model()
        bundle["eventTypes"][event_type] = {
            "profileNames": names,
            "gate": gate,
            "model": {
                "numClass": 3,
                "treeInfo": [
                    {"tree_structure": compact_tree(tree["tree_structure"])}
                    for tree in dumped["tree_info"]
                ],
            },
        }
        print(json.dumps({event_type: report["eventTypes"][event_type]}, indent=2))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.model).write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
