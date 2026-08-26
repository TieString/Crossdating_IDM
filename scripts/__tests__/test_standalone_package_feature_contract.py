from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).resolve().parents[1] / "train-standalone-unified-package.py"
SPEC = importlib.util.spec_from_file_location("standalone_package", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StandalonePackageFeatureContractTest(unittest.TestCase):
    def test_truth_derived_location_labels_are_not_features(self) -> None:
        table = pd.DataFrame({
            "attempt_id": ["a"],
            "cluster_id": ["f"],
            "file_id": ["f"],
            "family": ["A"],
            "is_clean": [0],
            "candidate_year": [1900],
            "operation_correct": [1],
            "location_correct": [1],
            "location_relevance": [3],
            "location_error_years": [0.0],
            "workflow_correct": [1],
            "strict_correct": [1],
            "physical_evidence": [0.75],
        })

        _, features = MODULE.encode(table, "full")

        self.assertEqual(features, ["physical_evidence"])


if __name__ == "__main__":
    unittest.main()
