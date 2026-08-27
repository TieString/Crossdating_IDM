from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "fit-standalone-hierarchical-package.py"
)
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("standalone_fit_predict", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StandaloneFitPredictContractTest(unittest.TestCase):
    def test_target_categories_cannot_expand_training_schema(self) -> None:
        training = pd.DataFrame({
            "event_type": ["missingRing", "falseRing"],
            "score": [0.1, 0.2],
        })
        target = pd.DataFrame({
            "event_type": ["partialMove"],
            "score": [0.3],
        })

        train_values, target_values, names = MODULE.encode_train_target(
            training, target, ["event_type", "score"]
        )

        self.assertIn("event_type_missingRing", names)
        self.assertIn("event_type_falseRing", names)
        self.assertNotIn("event_type_partialMove", names)
        self.assertEqual(train_values.columns.tolist(), target_values.columns.tolist())
        self.assertEqual(
            float(target_values.filter(like="event_type_").sum(axis=1).iloc[0]),
            0.0,
        )

    def test_final_choice_is_independent_of_correctness_labels(self) -> None:
        operations = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "cluster_id": ["f", "f"],
            "file_id": ["f", "f"],
            "family": ["A", "A"],
            "identity_group": ["a|missingRing|-1", "a|falseRing|1"],
            "event_type": ["missingRing", "falseRing"],
            "shift_years": [-1, 1],
            "operation_correct": [1, 0],
            "operation_meta_percentile": [0.9, 0.1],
        })
        packages = pd.DataFrame({
            "attempt_id": ["a", "a", "a", "a"],
            "identity_group": [
                "a|missingRing|-1", "a|missingRing|-1",
                "a|falseRing|1", "a|falseRing|1",
            ],
            "event_type": [
                "missingRing", "missingRing", "falseRing", "falseRing",
            ],
            "candidate_source": ["x", "y", "x", "y"],
            "candidate_year": [1900, 1910, 1900, 1910],
            "location_correct": [1, 0, 0, 1],
            "workflow_correct": [1, 0, 0, 1],
            "strict_correct": [1, 0, 0, 1],
            "location_global_percentile": [1.0, 0.1, 0.1, 1.0],
            "location_typed_percentile": [1.0, 0.1, 0.1, 1.0],
            "location_global_classifier_percentile": [1.0, 0.1, 0.1, 1.0],
            "location_typed_classifier_percentile": [1.0, 0.1, 0.1, 1.0],
        })
        weights = {
            "operationClassifier": 2.0,
            "typedOperation": 2.0,
            "typedLocation": 0.25,
            "locationClassifier": 0.5,
        }

        first = MODULE.select_target(packages.copy(), operations.copy(), weights)
        mutated_packages = packages.copy()
        mutated_packages[["location_correct", "workflow_correct", "strict_correct"]] = (
            1 - mutated_packages[
                ["location_correct", "workflow_correct", "strict_correct"]
            ]
        )
        mutated_operations = operations.copy()
        mutated_operations["operation_correct"] = 1 - mutated_operations[
            "operation_correct"
        ]
        second = MODULE.select_target(
            mutated_packages, mutated_operations, weights
        )

        self.assertEqual(first["event_type"].tolist(), ["missingRing"])
        self.assertEqual(first["selected_candidate_year"].tolist(), [1900])
        self.assertEqual(second["event_type"].tolist(), first["event_type"].tolist())
        self.assertEqual(
            second["selected_candidate_year"].tolist(),
            first["selected_candidate_year"].tolist(),
        )


if __name__ == "__main__":
    unittest.main()
