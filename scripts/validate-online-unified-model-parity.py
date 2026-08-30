#!/usr/bin/env python3
"""Compare frozen JSON-tree scores with the TypeScript worker scorer."""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = (
    ROOT
    / "src"
    / "features"
    / "crossdating"
    / "diagnosis"
    / "models"
    / "onlineUnifiedModel.json"
)


def score_node(node: dict[str, object], values: list[float]) -> float:
    if "leaf_value" in node:
        return float(node["leaf_value"])
    feature = int(node["split_feature"])
    value = values[feature]
    if not math.isfinite(value):
        branch = "left_child" if bool(node["default_left"]) else "right_child"
    else:
        threshold = float(node["threshold"])
        go_left = value <= threshold if node["decision_type"] == "<=" else value == threshold
        branch = "left_child" if go_left else "right_child"
    return score_node(node[branch], values)  # type: ignore[arg-type]


def score_head(head: dict[str, object], features: dict[str, float]) -> float:
    names = list(head["featureNames"])
    values = [float(features.get(str(name), 0.0)) for name in names]
    trees = list(head["treeInfo"])
    total = sum(
        score_node(tree["tree_structure"], values)  # type: ignore[arg-type]
        for tree in trees
    )
    return total / len(trees) if head.get("averageOutput") and trees else total


def feature_fixture(names: list[str], seed: int) -> dict[str, float]:
    output: dict[str, float] = {}
    for index, name in enumerate(names):
        selector = (index * 17 + seed * 13) % 11
        if selector in {0, 3, 7}:
            output[name] = ((index * 29 + seed * 31) % 401 - 200) / 37.0
    return output


def main() -> None:
    model = json.loads(MODEL_PATH.read_text(encoding="utf8"))
    requests: list[dict[str, object]] = []
    expected: list[float] = []
    for head_name in ("operation", "location"):
        head = model[head_name]
        names = [str(name) for name in head["featureNames"]]
        for seed in (1, 7, 23, 101):
            features = feature_fixture(names, seed)
            requests.append({"head": head_name, "features": features})
            expected.append(score_head(head, features))
    completed = subprocess.run(
        [
            str(ROOT / "node_modules" / ".bin" / "vite-node.cmd"),
            str(ROOT / "scripts" / "score-online-unified-parity.ts"),
        ],
        cwd=ROOT,
        input=json.dumps(requests),
        text=True,
        capture_output=True,
        encoding="utf8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout + completed.stderr)
    actual = [float(value) for value in json.loads(completed.stdout)]
    maximum_error = max(abs(left - right) for left, right in zip(expected, actual))
    if maximum_error > 1e-12:
        raise AssertionError(f"Python/TypeScript score drift: {maximum_error:.3e}")
    print(
        f"online unified parity passed: {len(actual)} vectors, "
        f"maximum absolute error={maximum_error:.3e}"
    )


if __name__ == "__main__":
    main()
