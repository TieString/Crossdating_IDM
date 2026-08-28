from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd


SCRIPTS = Path(__file__).resolve().parents[1]


def load_helpers():
    path = SCRIPTS / "frozen_model_inference.py"
    spec = importlib.util.spec_from_file_location("frozen_model_inference_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


HELPERS = load_helpers()


class FrozenModelInferenceTest(unittest.TestCase):
    def test_manifest_verifies_bytes_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.txt"
            model.write_bytes(b"immutable-model")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps([{
                "relativePath": "model.txt",
                "bytes": model.stat().st_size,
                "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
            }]), encoding="utf8")
            result = HELPERS.verify_runtime_manifest(root, manifest)
            self.assertEqual(result["files"], 1)
            self.assertEqual(result["mismatches"], 0)

    def test_encoding_uses_only_frozen_feature_columns(self) -> None:
        frame = pd.DataFrame({
            "value": [1.5, 2.5],
            "kind": ["known", "unseen"],
            "ignored": [99, 99],
        })
        values = HELPERS.encode_frame(
            frame,
            ["value", "kind"],
            ["value", "kind_known", "kind_training_only"],
        )
        self.assertEqual(list(values.columns), [
            "value", "kind_known", "kind_training_only",
        ])
        self.assertEqual(values["kind_known"].tolist(), [1.0, 0.0])
        self.assertEqual(values["kind_training_only"].tolist(), [0.0, 0.0])

    def test_predict_only_entrypoints_contain_no_fit_calls(self) -> None:
        for name in (
            "predict-frozen-operation-identities.py",
            "predict-frozen-enriched-evidence-heads.py",
            "predict-frozen-standalone-model.py",
        ):
            tree = ast.parse((SCRIPTS / name).read_text(encoding="utf8"))
            fit_calls = [
                node for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "fit"
            ]
            self.assertEqual(fit_calls, [], name)


if __name__ == "__main__":
    unittest.main()
