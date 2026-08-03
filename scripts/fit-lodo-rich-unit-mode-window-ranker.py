"""Fit a dataset-held-out rich counterfactual 13-year mode selector."""

from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np


HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "fit-rich-unit-mode-window-ranker.py"
SPEC = importlib.util.spec_from_file_location("rich_mode_ranker", BASE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {BASE_PATH}")
BASE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BASE
SPEC.loader.exec_module(BASE)

EVENT_TYPES = ("missingRing", "falseRing")
WINDOW_WIDTH = 13


@dataclass(frozen=True)
class Configuration:
    feature_set: str
    label_type: str
    leaves: int
    depth: int
    minimum: int
    estimators: int

    @property
    def name(self) -> str:
        return (
            f"{self.feature_set}:{self.label_type}:l{self.leaves}:"
            f"d{self.depth}:m{self.minimum}:n{self.estimators}"
        )


def feature_sets(source: dict[str, Any]) -> dict[str, tuple[str, ...]]:
    names = tuple(sorted(source["rows"][0]["features"]))
    n24 = tuple(name for name in BASE.FALSE_N24 if name in names)
    scientific = tuple(
        name for name in names
        if name.startswith(("difference", "whitened"))
        and "Huber" in name
        and name.endswith(("21", "31", "61"))
        and not any(marker in name for marker in (
            "Boundary", "Edge", "Older", "Newer", "Side",
        ))
    )
    predictive_local = tuple(
        name for name in names
        if name.startswith(("differencePredictive", "whitenedPredictive"))
        and "Huber" in name
        and name.endswith(("3", "5", "7"))
        and any(marker in name for marker in (
            "Edge", "Older", "Newer", "Side",
        ))
    )
    return {
        "n24": n24,
        "scientific": scientific,
        "scientificLocal": tuple(dict.fromkeys([*scientific, *predictive_local])),
    }


def configurations(requested: Sequence[str]) -> list[Configuration]:
    shapes = (
        (5, 3, 30, 60),
        (5, 3, 60, 80),
        (7, 3, 40, 80),
        (9, 4, 30, 100),
    )
    return [
        Configuration(feature_set, label, *shape)
        for feature_set, label, shape in itertools.product(
            requested, ("binary", "central"), shapes,
        )
    ]


def make_model(configuration: Configuration, seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=(
            [0, 1]
            if configuration.label_type == "binary"
            else [0, 1, 3, 7, 15, 31, 63, 127]
        ),
        n_estimators=configuration.estimators,
        learning_rate=0.025,
        num_leaves=configuration.leaves,
        max_depth=configuration.depth,
        min_child_samples=configuration.minimum,
        max_bin=63,
        reg_lambda=20,
        reg_alpha=4,
        colsample_bytree=0.7,
        subsample=0.85,
        subsample_freq=1,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def fit(
    cases: Sequence[Any],
    configuration: Configuration,
    seed: int,
) -> lgb.LGBMRanker:
    model = make_model(configuration, seed)
    model.fit(
        np.concatenate([case.features for case in cases]),
        np.concatenate([case.labels for case in cases]),
        group=[len(case.starts) for case in cases],
    )
    return model


def bounded_current(case: Any) -> tuple[int, int]:
    source = case.source
    center = sum(source["primaryRange"]) / 2
    return BASE.bounded_window(center, source["coarseRange"])


def predict(
    model: lgb.LGBMRanker,
    cases: Sequence[Any],
    dataset: str,
) -> list[dict[str, Any]]:
    result = []
    for case in cases:
        scores = np.asarray(model.predict(case.features), dtype=float)
        selected_index = max(
            range(len(scores)),
            key=lambda index: (scores[index], case.starts[index]),
        )
        selected_start = int(case.starts[selected_index])
        current = bounded_current(case)
        current_index = int(np.argmin(np.abs(case.starts - current[0])))
        selected_score = float(scores[selected_index])
        alternatives = np.delete(scores, selected_index)
        margin = selected_score - (
            float(np.max(alternatives)) if len(alternatives) else selected_score
        )
        remote = [
            float(score) for start, score in zip(case.starts, scores)
            if int(start) + WINDOW_WIDTH - 1 < selected_start
            or int(start) > selected_start + WINDOW_WIDTH - 1
        ]
        current_center = sum(current) / 2
        selected_center = selected_start + WINDOW_WIDTH // 2
        selected_direction = np.sign(selected_center - current_center)
        anchors = (
            case.source.get("primaryTopYear"),
            case.source.get("operationBestYear"),
            case.source.get("sideStepBestYear"),
        )
        anchor_votes = sum(
            anchor is not None
            and np.sign(float(anchor) - current_center) == selected_direction
            for anchor in anchors
        )
        result.append({
            "case": case,
            "dataset": dataset,
            "current": current,
            "selected": (selected_start, selected_start + WINDOW_WIDTH - 1),
            "advantage": selected_score - float(scores[current_index]),
            "margin": margin,
            "remoteMargin": selected_score - max(remote, default=selected_score),
            "shift": abs(selected_start - current[0]),
            "anchorVotes": anchor_votes,
        })
    return result


def gates():
    for advantage, margin, remote, minimum_shift, maximum_shift, votes in itertools.product(
        (0, 0.05, 0.1, 0.2, 0.35, 0.5),
        (0, 0.02, 0.05, 0.1),
        (-np.inf, 0, 0.1, 0.3, 0.5),
        (1, 3, 5),
        (3, 6, 12, 100),
        (0, 1, 2),
    ):
        if maximum_shift < minimum_shift:
            continue
        yield {
            "minimumAdvantage": float(advantage),
            "minimumMargin": float(margin),
            "minimumRemoteMargin": float(remote),
            "minimumShift": int(minimum_shift),
            "maximumShift": int(maximum_shift),
            "minimumAnchorVotes": int(votes),
        }


def accepted_mask(rows: Sequence[dict[str, Any]], gate: dict[str, float]):
    return (
        np.asarray([row["advantage"] for row in rows]) >= gate["minimumAdvantage"]
    ) & (
        np.asarray([row["margin"] for row in rows]) >= gate["minimumMargin"]
    ) & (
        np.asarray([row["remoteMargin"] for row in rows])
            >= gate["minimumRemoteMargin"]
    ) & (
        np.asarray([row["shift"] for row in rows]) >= gate["minimumShift"]
    ) & (
        np.asarray([row["shift"] for row in rows]) <= gate["maximumShift"]
    ) & (
        np.asarray([row["anchorVotes"] for row in rows])
            >= gate["minimumAnchorVotes"]
    )


def summarize(
    rows: Sequence[dict[str, Any]],
    mask: np.ndarray,
) -> dict[str, int]:
    truths = np.asarray([int(row["case"].source["truthYear"]) for row in rows])
    old_hits = np.asarray([
        row["current"][0] <= truth <= row["current"][1]
        for row, truth in zip(rows, truths)
    ])
    candidate_hits = np.asarray([
        row["selected"][0] <= truth <= row["selected"][1]
        for row, truth in zip(rows, truths)
    ])
    new_hits = np.where(mask, candidate_hits, old_hits)
    return {
        "cases": len(rows),
        "oldHits": int(np.sum(old_hits)),
        "newHits": int(np.sum(new_hits)),
        "gains": int(np.sum(mask & candidate_hits & ~old_hits)),
        "losses": int(np.sum(mask & old_hits & ~candidate_hits)),
        "changes": int(np.sum(mask)),
    }


def select_gate(rows: Sequence[dict[str, Any]], datasets: Sequence[str]):
    if not rows:
        return None
    dataset_rows = {
        name: np.asarray([row["dataset"] == name for row in rows])
        for name in datasets
    }
    candidates = []
    for gate in gates():
        mask = accepted_mask(rows, gate)
        total = summarize(rows, mask)
        if total["newHits"] <= total["oldHits"]:
            continue
        by_dataset = {
            name: summarize(
                [row for row, selected in zip(rows, selected_rows) if selected],
                mask[selected_rows],
            )
            for name, selected_rows in dataset_rows.items()
        }
        if any(
            value["newHits"] < value["oldHits"]
            for value in by_dataset.values()
        ):
            continue
        support = sum(
            value["newHits"] > value["oldHits"]
            for value in by_dataset.values()
        )
        score = (
            support,
            total["newHits"] - total["oldHits"],
            total["gains"],
            -total["losses"],
            -total["changes"],
        )
        candidates.append((score, gate, total, by_dataset))
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
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--feature-sets", default="n24,scientific")
    parser.add_argument("--events", default=",".join(EVENT_TYPES))
    args = parser.parse_args()

    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    available = feature_sets(raw[0])
    requested_sets = [
        name for name in args.feature_sets.split(",") if name in available
    ]
    requested_events = [
        name for name in args.events.split(",") if name in EVENT_TYPES
    ]
    datasets = sorted({str(source["split"]) for source in raw})
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    bundle: dict[str, Any] = {"version": 1, "eventTypes": {}}

    for event_type in requested_events:
        prepared: dict[tuple[str, str], dict[str, list[Any]]] = {}
        for feature_set in requested_sets:
            point_names = available[feature_set]
            for label in ("binary", "central"):
                cases = [
                    case
                    for source in raw
                    if source["eventType"] == event_type
                    for case in [BASE.build_case(source, point_names, label)]
                    if case is not None
                ]
                prepared[(feature_set, label)] = {
                    name: [case for case in cases if case.dataset == name]
                    for name in datasets
                }
                print(event_type, feature_set, label, len(cases), flush=True)

        candidates = []
        for configuration_index, configuration in enumerate(
            configurations(requested_sets)
        ):
            by_dataset = prepared[
                (configuration.feature_set, configuration.label_type)
            ]
            predictions = []
            for held_index, held_name in enumerate(datasets):
                held = by_dataset[held_name]
                held_groups = {case.group for case in held}
                train = [
                    case
                    for name in datasets if name != held_name
                    for case in by_dataset[name]
                    if case.group not in held_groups
                ]
                model = fit(
                    train,
                    configuration,
                    20261201 + configuration_index * 17 + held_index,
                )
                predictions.extend(predict(model, held, held_name))
            selected = select_gate(predictions, datasets)
            if selected is None:
                continue
            score, gate, total, by_dataset_summary = selected
            candidates.append({
                "score": score,
                "configuration": configuration,
                "gate": gate,
                "total": total,
                "byDataset": by_dataset_summary,
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
            case
            for rows in prepared[
                (configuration.feature_set, configuration.label_type)
            ].values()
            for case in rows
        ]
        final_model = fit(all_cases, configuration, 20261231)
        point_names = available[configuration.feature_set]
        model_feature_names = BASE.feature_names(point_names)
        importances = final_model.booster_.feature_importance(importance_type="gain")
        top_features = sorted(
            zip(model_feature_names, importances),
            key=lambda row: row[1],
            reverse=True,
        )[:50]
        selected_report = {
            "configuration": configuration.name,
            "pointFeatureCount": len(point_names),
            "featureCount": len(model_feature_names),
            "gate": selected["gate"],
            "total": selected["total"],
            "byDataset": selected["byDataset"],
            "topFeatures": top_features,
        }
        report["eventTypes"][event_type] = {
            "selected": selected_report,
            "changes": [
                {
                    "dataset": row["dataset"],
                    "file": row["case"].source["file"],
                    "target": row["case"].source["target"],
                    "truthYear": row["case"].source["truthYear"],
                    "oldWindow": row["current"],
                    "newWindow": row["selected"],
                    "advantage": row["advantage"],
                    "margin": row["margin"],
                    "remoteMargin": row["remoteMargin"],
                    "anchorVotes": row["anchorVotes"],
                }
                for row in selected["predictions"]
                if accepted_mask([row], selected["gate"])[0]
            ],
            "runnerUp": [
                {
                    "configuration": row["configuration"].name,
                    "gate": row["gate"],
                    "total": row["total"],
                    "byDataset": row["byDataset"],
                }
                for row in candidates[:12]
            ],
        }
        dumped = final_model.booster_.dump_model()
        bundle["eventTypes"][event_type] = {
            "pointFeatureNames": point_names,
            "featureNames": model_feature_names,
            "windowWidth": WINDOW_WIDTH,
            "gate": selected["gate"],
            "training": {
                "configuration": configuration.name,
                "cases": len(all_cases),
                "datasets": datasets,
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
    Path(args.model).write_text(json.dumps(bundle), encoding="utf-8")


if __name__ == "__main__":
    main()
