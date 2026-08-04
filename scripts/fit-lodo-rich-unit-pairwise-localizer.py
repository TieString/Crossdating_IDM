"""Fit a shallow pairwise year localizer on consumed rich coarse-window audits.

The ranker compares years only within the same case. Configuration and promotion gates
are selected from leave-one-dataset-out development predictions; validation labels never
participate in selection.
"""

from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np


@dataclass(frozen=True)
class Case:
    split: str
    mode: str
    truth: int
    years: np.ndarray
    raw_features: dict[str, np.ndarray]
    final_start: int
    final_end: int
    anchors: tuple[int, ...]

    @property
    def center(self) -> int:
        return (self.final_start + self.final_end) // 2

    @property
    def radius(self) -> int:
        return (self.final_end - self.final_start) // 2


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
            f"{self.feature_set}:{self.label_type}:l{self.leaves}:d{self.depth}:"
            f"m{self.minimum}:n{self.estimators}"
        )


def finite(value: Any, fallback: float = -10.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def load_cases(path: Path) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    cases = []
    for row in payload:
        if row.get("eventType") != "falseRing":
            continue
        years = np.asarray([int(point["year"]) for point in row["rows"]])
        names = set.intersection(*(set(point["features"]) for point in row["rows"]))
        features = {
            name: np.asarray([
                finite(point["features"].get(name)) for point in row["rows"]
            ])
            for name in names
        }
        final_start, final_end = map(int, row["finalRange"])
        cases.append(Case(
            split=str(row["split"]),
            mode=str(row.get("falseRingMode") or "unknown"),
            truth=int(row["truthYear"]),
            years=years,
            raw_features=features,
            final_start=final_start,
            final_end=final_end,
            anchors=tuple(int(value) for value in (
                row.get("primaryTopYear"),
                row.get("operationBestYear"),
                row.get("sideStepBestYear"),
            ) if value is not None),
        ))
    return cases


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values), dtype=float)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + end - 1) / (2 * max(1, len(values) - 1))
        result[order[start:end]] = rank
        start = end
    return result


def moving_mean(values: np.ndarray, radius: int) -> np.ndarray:
    return np.asarray([
        float(np.mean(values[max(0, index - radius):index + radius + 1]))
        for index in range(len(values))
    ])


def feature_sets(names: Sequence[str]) -> dict[str, tuple[str, ...]]:
    locator = tuple(name for name in names if name.startswith("locatorRank:"))
    scientific = tuple(
        name for name in names
        if name.startswith(("difference", "whitened"))
        and ("Master" in name or "ReferenceWeighted" in name)
        and name.endswith(("21", "31", "61"))
        and not any(token in name for token in ("Boundary", "Edge", "Older", "Newer", "Side"))
    )
    local = tuple(
        name for name in names
        if name.startswith(("difference", "whitened"))
        and any(token in name for token in (
            "Boundary5", "Boundary7", "Boundary9",
            "SideMinimum3", "SideMinimum5", "SideMinimum7",
        ))
    )
    return {
        "locator": locator,
        "combined": tuple(dict.fromkeys((*locator, *scientific))),
        "combinedLocal": tuple(dict.fromkeys((*locator, *scientific, *local))),
    }


def feature_matrix(
    case: Case,
    selected: Sequence[str],
    include_shapes: bool,
) -> np.ndarray:
    ranked = {name: percentile_ranks(case.raw_features[name]) for name in selected}
    columns = [ranked[name] for name in selected]
    if include_shapes:
        for name in selected:
            values = ranked[name]
            mass3 = moving_mean(values, 1)
            mass5 = moving_mean(values, 2)
            columns.extend((mass3, mass5, values - mass3))
    span = max(1, int(case.years[-1] - case.years[0]))
    center_delta = (case.years - case.center) / span
    columns.extend((
        center_delta,
        np.abs(center_delta),
        (np.abs(case.years - case.center) <= case.radius).astype(float),
        np.minimum(case.years - case.years[0], case.years[-1] - case.years) / span,
    ))
    for anchor_index in range(3):
        anchor = case.anchors[anchor_index] if anchor_index < len(case.anchors) else None
        if anchor is None:
            columns.extend((np.zeros(len(case.years)), np.ones(len(case.years))))
        else:
            delta = (case.years - anchor) / span
            columns.extend((delta, np.abs(delta)))
    for mode in ("average", "moderate", "splitLike"):
        columns.append(np.full(len(case.years), float(case.mode == mode)))
    return np.column_stack(columns)


def labels(case: Case, label_type: str) -> np.ndarray:
    distance = np.abs(case.years - case.truth)
    if label_type == "exact":
        return (distance == 0).astype(int)
    return np.select(
        (distance == 0, distance <= 1, distance <= 2, distance <= 4),
        (4, 3, 2, 1),
        default=0,
    ).astype(int)


def make_model(configuration: Configuration, seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1] if configuration.label_type == "exact" else [0, 1, 3, 7, 15],
        n_estimators=configuration.estimators,
        learning_rate=0.03,
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
    cases: Sequence[Case],
    configuration: Configuration,
    selected: Sequence[str],
    seed: int,
) -> lgb.LGBMRanker:
    model = make_model(configuration, seed)
    matrices = [
        feature_matrix(case, selected, configuration.feature_set != "combinedLocal")
        for case in cases
    ]
    model.fit(
        np.concatenate(matrices),
        np.concatenate([labels(case, configuration.label_type) for case in cases]),
        group=[len(case.years) for case in cases],
    )
    return model


def predict_rows(
    model: lgb.LGBMRanker,
    cases: Sequence[Case],
    configuration: Configuration,
    selected: Sequence[str],
) -> list[dict[str, Any]]:
    rows = []
    for case in cases:
        matrix = feature_matrix(case, selected, configuration.feature_set != "combinedLocal")
        scores = np.asarray(model.booster_.predict(matrix), dtype=float)
        order = np.lexsort((-case.years, -scores))
        top_index = int(order[0])
        candidate = int(case.years[top_index])
        current_index = int(np.argmin(np.abs(case.years - case.center)))
        remote = [
            float(score) for year, score in zip(case.years, scores)
            if abs(int(year) - candidate) > case.radius
        ]
        direction = int(np.sign(candidate - case.center))
        rows.append({
            "case": case,
            "candidate": candidate,
            "advantage": float(scores[top_index] - scores[current_index]),
            "margin": float(scores[top_index] - scores[int(order[1])]),
            "remoteMargin": float(scores[top_index] - max(remote, default=scores[top_index])),
            "shift": abs(candidate - case.center),
            "anchorDirectionVotes": sum(
                int(np.sign(anchor - case.center)) == direction
                for anchor in case.anchors
            ),
        })
    return rows


def gate_grid():
    for values in itertools.product(
        (-np.inf, 0.0, 0.02, 0.05, 0.1),
        (-np.inf, 0.0, 0.01, 0.03),
        (-np.inf, 0.0, 0.05, 0.1),
        (1, 3, 5),
        (4, 8, 100),
        (0, 1, 2),
        (2, 4, 100),
    ):
        yield values


def accepted(row: dict[str, Any], gate: tuple[float, ...]) -> bool:
    advantage, margin, remote, minimum_shift, maximum_shift, votes, _ = gate
    return (
        row["advantage"] >= advantage
        and row["margin"] >= margin
        and row["remoteMargin"] >= remote
        and minimum_shift <= row["shift"] <= maximum_shift
        and row["anchorDirectionVotes"] >= votes
    )


def selected_center(row: dict[str, Any], gate: tuple[float, ...]) -> int:
    case = row["case"]
    if not accepted(row, gate):
        return case.center
    move_limit = int(gate[-1])
    delta = row["candidate"] - case.center
    return case.center + int(np.sign(delta)) * min(abs(delta), move_limit)


def summarize(rows: Sequence[dict[str, Any]], gate: tuple[float, ...]) -> dict[str, int]:
    baseline = selected = gain = loss = changes = exact = within_two = 0
    for row in rows:
        case = row["case"]
        center = selected_center(row, gate)
        baseline_hit = case.final_start <= case.truth <= case.final_end
        selected_hit = abs(center - case.truth) <= case.radius
        baseline += baseline_hit
        selected += selected_hit
        gain += selected_hit and not baseline_hit
        loss += baseline_hit and not selected_hit
        changes += center != case.center
        exact += center == case.truth
        within_two += abs(center - case.truth) <= 2
    return {
        "cases": len(rows),
        "baseline": baseline,
        "selected": selected,
        "gain": gain,
        "loss": loss,
        "changes": changes,
        "centerExact": exact,
        "centerWithinTwo": within_two,
    }


def select_gate(rows: Sequence[dict[str, Any]], split_names: Sequence[str]):
    candidates = []
    for gate in gate_grid():
        overall = summarize(rows, gate)
        by_split = {
            split: summarize(
                [row for row in rows if row["case"].split == split],
                gate,
            )
            for split in split_names
        }
        if any(metric["selected"] < metric["baseline"] for metric in by_split.values()):
            continue
        candidates.append({"gate": gate, "overall": overall, "splits": by_split})
    candidates.sort(key=lambda row: (
        row["overall"]["selected"],
        -row["overall"]["loss"],
        row["overall"]["centerWithinTwo"],
        row["overall"]["centerExact"],
        -row["overall"]["changes"],
    ), reverse=True)
    return candidates[0] if candidates else None


def configurations() -> list[Configuration]:
    return [
        Configuration(feature_set, label, leaves, depth, minimum, estimators)
        for feature_set, label, (leaves, depth, minimum, estimators) in itertools.product(
            ("locator", "combined", "combinedLocal"),
            ("exact", "graded"),
            ((5, 3, 30, 60), (7, 3, 30, 80), (9, 4, 40, 100)),
        )
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--development-split", action="append", required=True)
    parser.add_argument("--validation-split", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    cases = load_cases(args.dataset)
    common = sorted(set.intersection(*(set(case.raw_features) for case in cases)))
    sets = feature_sets(common)
    development = [case for case in cases if case.split in args.development_split]
    validation = [case for case in cases if case.split == args.validation_split]
    search = []
    for config_index, configuration in enumerate(configurations()):
        selected = sets[configuration.feature_set]
        oof_rows = []
        for held_out in args.development_split:
            train = [case for case in development if case.split != held_out]
            test = [case for case in development if case.split == held_out]
            model = fit(train, configuration, selected, 1000 + config_index)
            oof_rows.extend(predict_rows(model, test, configuration, selected))
        gate = select_gate(oof_rows, args.development_split)
        if gate is None:
            continue
        search.append({
            "configuration": configuration,
            "featureCount": len(selected),
            "gate": gate,
            "oofRows": oof_rows,
        })
    search.sort(key=lambda row: (
        row["gate"]["overall"]["selected"],
        -row["gate"]["overall"]["loss"],
        row["gate"]["overall"]["centerWithinTwo"],
        row["gate"]["overall"]["centerExact"],
    ), reverse=True)
    best = search[0]
    configuration = best["configuration"]
    selected = sets[configuration.feature_set]
    final_model = fit(development, configuration, selected, 9001)
    validation_rows = predict_rows(final_model, validation, configuration, selected)
    gate_values = tuple(best["gate"]["gate"])
    payload = {
        "developmentSplits": args.development_split,
        "validationSplit": args.validation_split,
        "selectedConfiguration": configuration.__dict__,
        "featureCount": len(selected),
        "selectedGate": {
            "minimumAdvantage": gate_values[0],
            "minimumMargin": gate_values[1],
            "minimumRemoteMargin": gate_values[2],
            "minimumShift": gate_values[3],
            "maximumShift": gate_values[4],
            "minimumAnchorDirectionVotes": gate_values[5],
            "moveLimit": gate_values[6],
        },
        "development": {
            "overall": best["gate"]["overall"],
            "splits": best["gate"]["splits"],
        },
        "validation": summarize(validation_rows, gate_values),
        "topDevelopmentConfigurations": [
            {
                "configuration": row["configuration"].__dict__,
                "featureCount": row["featureCount"],
                "gate": {
                    "values": row["gate"]["gate"],
                    "overall": row["gate"]["overall"],
                    "splits": row["gate"]["splits"],
                },
            }
            for row in search[:10]
        ],
        "topFeatureImportances": sorted(
            (
                (name, int(importance))
                for name, importance in zip(
                    selected,
                    final_model.feature_importances_[:len(selected)],
                )
            ),
            key=lambda row: row[1],
            reverse=True,
        )[:30],
    }
    rendered = json.dumps(payload, indent=2)
    args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
