"""Fit a group-held-out older/covered/newer mode corrector for unit events."""

from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import math
import sys
from pathlib import Path
from typing import Any, Sequence

import numpy as np


HERE = Path(__file__).resolve().parent
TRAINER_PATH = HERE / "fit-current-unit-mode-miss-corrector.py"
SPEC = importlib.util.spec_from_file_location("current_mode_corrector", TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {TRAINER_PATH}")
BASE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BASE
SPEC.loader.exec_module(BASE)

WINDOW_WIDTH = 13
EVENT_TYPES = ("missingRing", "falseRing")


def parse_source(value: str) -> tuple[str, Path]:
    label, path = value.split("=", 1)
    return label.strip(), Path(path.strip())


def shifted_window(row: dict[str, Any], shift: int) -> tuple[int, int]:
    source = row["case"].source
    mode = source["modeWindow"]
    coarse = source["coarseWindow"]
    direction = -1 if row["older"] > row["newer"] else 1
    start = int(mode["startYear"]) + direction * shift
    start = max(
        int(coarse["startYear"]),
        min(start, int(coarse["endYear"]) - WINDOW_WIDTH + 1),
    )
    return start, start + WINDOW_WIDTH - 1


def accepted(row: dict[str, Any], gate: dict[str, float]) -> bool:
    side = max(row["older"], row["newer"])
    return (
        side >= gate["minimumSideProbability"]
        and side - row["covered"] >= gate["minimumCoveredMargin"]
        and abs(row["older"] - row["newer"])
            >= gate["minimumDirectionMargin"]
    )


def metrics(rows: Sequence[dict[str, Any]], gate: dict[str, float]):
    old_hits = new_hits = gains = losses = changes = 0
    for row in rows:
        source = row["case"].source
        truth = int(source["truthYear"])
        mode = source["modeWindow"]
        old = int(mode["startYear"]) <= truth <= int(mode["endYear"])
        selected = shifted_window(row, int(gate["shiftYears"])) \
            if accepted(row, gate) else (int(mode["startYear"]), int(mode["endYear"]))
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
        "gains": gains,
        "losses": losses,
        "changes": changes,
    }


def gates():
    for probability, covered_margin, direction_margin, shift in itertools.product(
        np.arange(0.3, 0.951, 0.05),
        np.arange(-0.2, 0.601, 0.1),
        (0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5),
        (1, 2, 3, 4, 5, 6, 8, 10, 12),
    ):
        yield {
            "minimumSideProbability": float(probability),
            "minimumCoveredMargin": float(covered_margin),
            "minimumDirectionMargin": float(direction_margin),
            "shiftYears": int(shift),
        }


def select_gate(rows: Sequence[dict[str, Any]], datasets: Sequence[str]):
    if not rows:
        return None
    dataset_index = {name: index for index, name in enumerate(datasets)}
    groups = np.asarray([dataset_index[row["dataset"]] for row in rows], dtype=int)
    covered = np.asarray([row["covered"] for row in rows], dtype=float)
    older = np.asarray([row["older"] for row in rows], dtype=float)
    newer = np.asarray([row["newer"] for row in rows], dtype=float)
    side = np.maximum(older, newer)
    direction_margin = np.abs(older - newer)
    covered_margin = side - covered
    truths = np.asarray([int(row["case"].source["truthYear"]) for row in rows])
    old_hits = np.asarray([
        int(row["case"].source["modeWindow"]["startYear"])
            <= int(row["case"].source["truthYear"])
            <= int(row["case"].source["modeWindow"]["endYear"])
        for row in rows
    ], dtype=bool)
    old_by_dataset = np.bincount(
        groups,
        weights=old_hits.astype(int),
        minlength=len(datasets),
    ).astype(int)
    shifted_hits = {
        shift: np.asarray([
            start <= truth <= end
            for row, truth in zip(rows, truths)
            for start, end in [shifted_window(row, shift)]
        ], dtype=bool)
        for shift in (1, 2, 3, 4, 5, 6, 8, 10, 12)
    }
    candidates = []
    for gate in gates():
        mask = (
            (side >= gate["minimumSideProbability"])
            & (covered_margin >= gate["minimumCoveredMargin"])
            & (direction_margin >= gate["minimumDirectionMargin"])
        )
        selected_hits = np.where(
            mask,
            shifted_hits[int(gate["shiftYears"])],
            old_hits,
        )
        new_by_dataset = np.bincount(
            groups,
            weights=selected_hits.astype(int),
            minlength=len(datasets),
        ).astype(int)
        if np.any(new_by_dataset < old_by_dataset):
            continue
        gains_mask = mask & selected_hits & ~old_hits
        losses_mask = mask & old_hits & ~selected_hits
        old_total = int(np.sum(old_hits))
        new_total = int(np.sum(selected_hits))
        if new_total <= old_total:
            continue
        gains_by_dataset = np.bincount(
            groups,
            weights=gains_mask.astype(int),
            minlength=len(datasets),
        ).astype(int)
        losses_by_dataset = np.bincount(
            groups,
            weights=losses_mask.astype(int),
            minlength=len(datasets),
        ).astype(int)
        changes_by_dataset = np.bincount(
            groups,
            weights=mask.astype(int),
            minlength=len(datasets),
        ).astype(int)
        support = int(np.sum(new_by_dataset > old_by_dataset))
        total = {
            "cases": len(rows),
            "oldHits": old_total,
            "newHits": new_total,
            "gains": int(np.sum(gains_mask)),
            "losses": int(np.sum(losses_mask)),
            "changes": int(np.sum(mask)),
        }
        by_dataset = {
            name: {
                "cases": int(np.sum(groups == index)),
                "oldHits": int(old_by_dataset[index]),
                "newHits": int(new_by_dataset[index]),
                "gains": int(gains_by_dataset[index]),
                "losses": int(losses_by_dataset[index]),
                "changes": int(changes_by_dataset[index]),
            }
            for name, index in dataset_index.items()
        }
        candidates.append((
            (
                support,
                total["newHits"] - total["oldHits"],
                -total["losses"],
                -total["changes"],
            ),
            gate,
            total,
            by_dataset,
        ))
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
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--bundle", default=(
        "src/features/crossdating/diagnosis/unitEventPointWindowModel.json"
    ))
    parser.add_argument("--report", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    sources = [parse_source(value) for value in args.source]
    dataset_names = [label for label, _ in sources]
    point_bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    output_model: dict[str, Any] = {"version": 1, "eventTypes": {}}

    for event_type in EVENT_TYPES:
        point_names = BASE.MODE.POINT.feature_sets(event_type, point_bundle)["compact"]
        cases_by_dataset = {}
        for label, path in sources:
            cases_by_dataset[label] = BASE.load_cases(
                [path], event_type, point_names
            )
            print(
                event_type,
                "loaded",
                label,
                len(cases_by_dataset[label]),
                flush=True,
            )
        configurations = [
            BASE.Configuration("compact", leaves, depth, minimum, 80, weight)
            for leaves, depth in ((3, 2), (5, 3))
            for minimum in (15, 25, 40, 60)
            for weight in (4, 8, 12)
        ]
        candidates = []
        for config_index, configuration in enumerate(configurations):
            predictions = []
            for held_index, held_name in enumerate(dataset_names):
                held = cases_by_dataset[held_name]
                held_groups = {case.group.lower() for case in held}
                train = [
                    case
                    for name in dataset_names if name != held_name
                    for case in cases_by_dataset[name]
                    if case.group.lower() not in held_groups
                ]
                if len({case.label for case in train}) < 3:
                    continue
                model = BASE.fit(
                    train,
                    configuration,
                    20261010 + config_index * 17 + held_index,
                )
                rows = BASE.predict(model, held, held_name)
                for row in rows:
                    row["dataset"] = held_name
                predictions.extend(rows)
            selected = select_gate(predictions, dataset_names)
            if selected is None:
                continue
            score, gate, total, by_dataset = selected
            candidates.append({
                "score": score,
                "configuration": configuration,
                "gate": gate,
                "total": total,
                "byDataset": by_dataset,
                "predictions": predictions,
            })
            print(event_type, configuration.name, score, flush=True)
        candidates.sort(key=lambda row: row["score"], reverse=True)
        selected = candidates[0] if candidates else None
        if selected is None:
            report["eventTypes"][event_type] = {"selected": None}
            continue
        configuration = selected["configuration"]
        all_cases = [
            case for name in dataset_names for case in cases_by_dataset[name]
        ]
        final_model = BASE.fit(all_cases, configuration, 20261101)
        feature_names = BASE.MODE.window_feature_names(point_names)
        selected_report = {
            "configuration": configuration.name,
            "featureCount": len(feature_names),
            "gate": selected["gate"],
            "total": selected["total"],
            "byDataset": selected["byDataset"],
        }
        report["eventTypes"][event_type] = {
            "selected": selected_report,
            "changes": [
                {
                    "dataset": row["dataset"],
                    "file": row["case"].source["context"]["file"],
                    "target": row["case"].source["context"]["target"],
                    "truthYear": row["case"].source["truthYear"],
                    "oldWindow": row["case"].source["modeWindow"],
                    "newWindow": shifted_window(
                        row, int(selected["gate"]["shiftYears"])
                    ),
                    "probabilities": {
                        "covered": row["covered"],
                        "older": row["older"],
                        "newer": row["newer"],
                    },
                }
                for row in selected["predictions"]
                if accepted(row, selected["gate"])
            ],
            "runnerUp": [
                {
                    "configuration": row["configuration"].name,
                    "gate": row["gate"],
                    "total": row["total"],
                    "byDataset": row["byDataset"],
                } for row in candidates[:12]
            ],
        }
        dumped = final_model.booster_.dump_model()
        output_model["eventTypes"][event_type] = {
            "pointFeatureNames": point_names,
            "featureNames": feature_names,
            "windowWidth": WINDOW_WIDTH,
            "gate": selected["gate"],
            "training": {
                "configuration": configuration.name,
                "cases": len(all_cases),
                "datasets": dataset_names,
            },
            "model": {
                "tree_info": [
                    {"tree_structure": compact_tree(tree["tree_structure"])}
                    for tree in dumped["tree_info"]
                ],
            },
        }
        print(json.dumps({event_type: selected_report}, indent=2), flush=True)

    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    Path(args.model).write_text(json.dumps(output_model), encoding="utf-8")


if __name__ == "__main__":
    main()
