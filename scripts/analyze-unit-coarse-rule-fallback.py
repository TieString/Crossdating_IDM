"""Audit low-margin fallbacks from the frozen unit-event coarse ranker to rules."""

from __future__ import annotations

import argparse
import gc
import json
import math
import runpy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


@dataclass(frozen=True)
class Case:
    dataset: str
    event_type: str
    group: str
    truth_year: int
    model_index: int
    rule_index: int
    model_score: float
    model_margin: float
    rule_advantage: float
    center_distance: float
    model_hit: bool
    rule_hit: bool
    current_hit: bool


def parse_datasets(values: Sequence[str]) -> list[tuple[str, Path]]:
    result: list[tuple[str, Path]] = []
    for value in values:
        name, separator, raw_path = value.partition("=")
        if not separator or not name or not raw_path:
            raise ValueError(f"Expected NAME=PATH, received {value!r}")
        result.append((name, Path(raw_path)))
    return result


def overlap_ratio(left: dict[str, Any], right: dict[str, Any]) -> float:
    intersection = max(
        0,
        min(int(left["endYear"]), int(right["endYear"]))
        - max(int(left["startYear"]), int(right["startYear"]))
        + 1,
    )
    union = (
        max(int(left["endYear"]), int(right["endYear"]))
        - min(int(left["startYear"]), int(right["startYear"]))
        + 1
    )
    return intersection / max(1, union)


def source_family(source: str) -> str:
    if source == "current_event":
        return "current"
    if source == "joint_counterfactual_operation":
        return "joint"
    if source == "lag_transition":
        return "transition"
    if source.startswith("profile:"):
        return "profile"
    if source.startswith("reference_transition:"):
        return "reference"
    return "other"


def aggregate_rule(candidates: Sequence[dict[str, Any]]) -> tuple[int, list[float]]:
    overlap = [
        sum(overlap_ratio(candidate, other) for other in candidates)
        / max(1, len(candidates))
        for candidate in candidates
    ]
    scores = [float(candidate.get("aggregateScore", 0)) for candidate in candidates]
    selected = 0
    for index in range(1, len(candidates)):
        difference = scores[index] - scores[selected]
        if difference > 1e-9 or (
            abs(difference) <= 1e-9
            and overlap[index] - overlap[selected] > 1e-9
        ):
            selected = index
    return selected, scores


def density_rule(candidates: Sequence[dict[str, Any]]) -> tuple[int, list[float]]:
    groups: dict[str, list[int]] = {}
    for index, candidate in enumerate(candidates):
        groups.setdefault(source_family(str(candidate.get("source", ""))), []).append(index)
    centers = [
        (int(candidate["startYear"]) + int(candidate["endYear"])) / 2
        for candidate in candidates
    ]
    scores: list[float] = []
    for index, candidate in enumerate(candidates):
        density = 0.0
        for family, indexes in groups.items():
            family_vote = sum(
                math.exp(-0.5 * ((centers[index] - centers[other]) / 2) ** 2)
                for other in indexes
            ) / max(1, len(indexes))
            weight = 0.25 if family == "current" else 0.5 if family == "reference" else 1.0
            density += family_vote * weight
        if source_family(str(candidate.get("source", ""))) == "transition":
            density += 0.25
        scores.append(density)
    selected = 0
    for index in range(1, len(candidates)):
        difference = scores[index] - scores[selected]
        if difference > 1e-9 or (
            abs(difference) <= 1e-9 and centers[index] > centers[selected]
        ):
            selected = index
    return selected, scores


def predict_node(node: dict[str, Any], features: np.ndarray) -> float:
    if "leaf_value" in node:
        return float(node["leaf_value"])
    value = float(features[int(node["split_feature"])])
    if not math.isfinite(value):
        branch = "left_child" if node.get("default_left", False) else "right_child"
        return predict_node(node[branch], features)
    threshold = float(node["threshold"])
    go_left = value <= threshold if node.get("decision_type") == "<=" else value == threshold
    return predict_node(node["left_child"] if go_left else node["right_child"], features)


def score_rows(model: dict[str, Any], features: np.ndarray) -> list[float]:
    trees = model["model"]["tree_info"]
    return [
        sum(predict_node(tree["tree_structure"], row) for tree in trees)
        for row in features
    ]


def candidate_hit(event_type: str, candidate: dict[str, Any], truth: int) -> bool:
    expansion = 2 if event_type == "falseRing" else 0
    return (
        int(candidate["startYear"]) - expansion
        <= truth
        <= int(candidate["endYear"]) + expansion
    )


def coarse_candidate_hit(
    event_type: str,
    candidates: Sequence[dict[str, Any]],
    selected_index: int,
    truth: int,
) -> bool:
    selected = candidates[selected_index]
    if event_type != "missingRing":
        return candidate_hit(event_type, selected, truth)
    lag = next(
        (
            candidate for candidate in candidates
            if candidate.get("source") == "lag_transition"
        ),
        None,
    )
    if lag is None:
        return candidate_hit(event_type, selected, truth)
    overlap = max(
        0,
        min(int(selected["endYear"]), int(lag["endYear"]))
        - max(int(selected["startYear"]), int(lag["startYear"]))
        + 1,
    )
    union_start = min(int(selected["startYear"]), int(lag["startYear"]))
    union_end = max(int(selected["endYear"]), int(lag["endYear"]))
    if overlap >= 5 and union_end - union_start + 1 <= 45:
        return union_start <= truth <= union_end
    return candidate_hit(event_type, selected, truth)


def load_cases(
    datasets: Sequence[tuple[str, Path]],
    models: dict[str, Any],
    candidate_features: Any,
) -> list[Case]:
    result: list[Case] = []
    for dataset, path in datasets:
        payload = json.loads(path.read_text(encoding="utf-8"))
        seen: set[tuple[str, str, int, str]] = set()
        parity_mismatches = 0
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            event_type = str(source.get("eventType", ""))
            if context.get("baselineFlagged", True) or event_type not in models:
                continue
            candidates = source.get("candidates", [])
            if not candidates:
                continue
            truth = int(source["truthYear"])
            key = (
                str(context.get("file", "")),
                str(context.get("target", "")),
                truth,
                event_type,
            )
            if key in seen:
                continue
            seen.add(key)
            event_model = models[event_type]
            features = candidate_features(
                source,
                candidates,
                event_model["profiles"],
            )
            scores = score_rows(event_model, features)
            order = sorted(range(len(scores)), key=lambda index: (-scores[index], index))
            model_index = order[0]
            model_margin = scores[model_index] - scores[order[1]] if len(order) > 1 else 0.0
            if event_type == "falseRing":
                rule_index, rule_scores = density_rule(candidates)
            else:
                rule_index, rule_scores = aggregate_rule(candidates)
            model_center = (
                int(candidates[model_index]["startYear"])
                + int(candidates[model_index]["endYear"])
            ) / 2
            rule_center = (
                int(candidates[rule_index]["startYear"])
                + int(candidates[rule_index]["endYear"])
            ) / 2
            model_hit = coarse_candidate_hit(
                event_type,
                candidates,
                model_index,
                truth,
            )
            current_window = source["coarseWindow"]
            current_hit = (
                int(current_window["startYear"])
                <= truth
                <= int(current_window["endYear"])
            )
            if model_hit != current_hit:
                parity_mismatches += 1
                print(json.dumps({
                    "parityMismatch": dataset,
                    "eventType": event_type,
                    "file": context.get("file"),
                    "target": context.get("target"),
                    "truthYear": truth,
                    "modelIndex": model_index,
                    "modelSource": candidates[model_index].get("source"),
                    "coarseSource": source.get("coarseSource"),
                    "modelHit": model_hit,
                    "currentHit": current_hit,
                }, ensure_ascii=True))
            result.append(Case(
                dataset=dataset,
                event_type=event_type,
                group=str(context.get("file", "")),
                truth_year=truth,
                model_index=model_index,
                rule_index=rule_index,
                model_score=scores[model_index],
                model_margin=model_margin,
                rule_advantage=rule_scores[rule_index] - rule_scores[model_index],
                center_distance=abs(rule_center - model_center),
                model_hit=model_hit,
                rule_hit=coarse_candidate_hit(
                    event_type,
                    candidates,
                    rule_index,
                    truth,
                ),
                current_hit=current_hit,
            ))
        print(f"loaded {dataset}: {len(seen)} cases, parity mismatches={parity_mismatches}")
        del payload
        gc.collect()
    return result


def summarize(cases: Iterable[Case], threshold: float | None = None) -> dict[str, Any]:
    rows = list(cases)
    fallback = [
        row.model_margin <= threshold and row.model_index != row.rule_index
        if threshold is not None
        else False
        for row in rows
    ]
    model_hits = sum(row.model_hit for row in rows)
    selected_hits = sum(
        row.rule_hit if use_rule else row.model_hit
        for row, use_rule in zip(rows, fallback)
    )
    return {
        "cases": len(rows),
        "modelHits": model_hits,
        "modelCoverage": model_hits / max(1, len(rows)),
        "fallbacks": sum(fallback),
        "selectedHits": selected_hits,
        "selectedCoverage": selected_hits / max(1, len(rows)),
        "delta": selected_hits - model_hits,
        "gains": sum(
            use_rule and row.rule_hit and not row.model_hit
            for row, use_rule in zip(rows, fallback)
        ),
        "losses": sum(
            use_rule and row.model_hit and not row.rule_hit
            for row, use_rule in zip(rows, fallback)
        ),
    }


def margin_quantiles(cases: Sequence[Case]) -> dict[str, float]:
    margins = np.asarray([row.model_margin for row in cases], dtype=float)
    return {
        str(quantile): float(np.quantile(margins, quantile))
        for quantile in (0, 0.1, 0.25, 0.5, 0.75, 0.9, 1)
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fit", action="append", default=[])
    parser.add_argument("--calibration", action="append", default=[])
    parser.add_argument("--evaluation", action="append", default=[])
    parser.add_argument("--output", default=".tmp-unit-coarse-rule-fallback-report.json")
    args = parser.parse_args()

    helper = runpy.run_path(
        str(Path(__file__).with_name("fit-file-grouped-unit-coarse-model.py"))
    )
    candidate_features = helper["candidate_features"]
    model_bundle = json.loads(Path(
        "src/features/crossdating/diagnosis/unitEventCoarseWindowModel.json"
    ).read_text(encoding="utf-8"))
    models = model_bundle["eventTypes"]
    fit_names = {name for name, _ in parse_datasets(args.fit)}
    calibration_names = {name for name, _ in parse_datasets(args.calibration)}
    all_datasets = [
        *parse_datasets(args.fit),
        *parse_datasets(args.calibration),
        *parse_datasets(args.evaluation),
    ]
    cases = load_cases(all_datasets, models, candidate_features)
    report: dict[str, Any] = {"events": {}}
    for event_type in models:
        event_cases = [row for row in cases if row.event_type == event_type]
        fit_cases = [row for row in event_cases if row.dataset in fit_names]
        calibration_cases = [
            row for row in event_cases if row.dataset in calibration_names
        ]
        thresholds = sorted({
            -1.0,
            0.0,
            *[row.model_margin for row in fit_cases],
        })
        candidates = []
        for threshold in thresholds:
            fit_summary = summarize(fit_cases, threshold)
            calibration_summary = summarize(calibration_cases, threshold)
            by_fit_dataset = {
                name: summarize(
                    (row for row in fit_cases if row.dataset == name),
                    threshold,
                )
                for name in sorted(fit_names)
            }
            by_calibration_dataset = {
                name: summarize(
                    (
                        row for row in calibration_cases
                        if row.dataset == name
                    ),
                    threshold,
                )
                for name in sorted(calibration_names)
            }
            if (
                fit_summary["delta"] >= 0
                and calibration_summary["delta"] >= 0
                and all(row["delta"] >= 0 for row in by_fit_dataset.values())
                and all(row["delta"] >= 0 for row in by_calibration_dataset.values())
            ):
                candidates.append({
                    "threshold": threshold,
                    "fit": fit_summary,
                    "calibration": calibration_summary,
                    "byFitDataset": by_fit_dataset,
                    "byCalibrationDataset": by_calibration_dataset,
                })
        selected = max(
            candidates,
            key=lambda row: (
                row["calibration"]["delta"],
                row["fit"]["delta"],
                -row["calibration"]["fallbacks"],
                -row["threshold"],
            ),
        )
        threshold = float(selected["threshold"])
        report["events"][event_type] = {
            "marginQuantiles": margin_quantiles(event_cases),
            "disagreements": summarize(
                row for row in event_cases if row.model_index != row.rule_index
            ),
            "selected": selected,
            "all": summarize(event_cases, threshold),
            "byDataset": {
                dataset: summarize(
                    (row for row in event_cases if row.dataset == dataset),
                    threshold,
                )
                for dataset, _ in all_datasets
            },
        }
    Path(args.output).write_text(
        json.dumps(report, indent=2, ensure_ascii=True),
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
