from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


SCRIPT = Path(__file__).parents[1] / "train-unified-diagnosis-adjudicator.py"
SPEC = importlib.util.spec_from_file_location("unified_adjudicator", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def candidate_row(
    index: int,
    event_type: str,
    shift: int,
    start: int,
    end: int,
    *,
    primary: int = 0,
    alternative: int = 0,
) -> dict[str, object]:
    return {
        "attempt_id": "evaluation:1:1",
        "file_id": "test-file",
        "family": "D",
        "dataset_role": "evaluation",
        "is_clean": 0,
        "label_workflow": 0,
        "label_strict": 0,
        "label_relaxed": 0,
        "operation_correct": 0,
        "location_correct": 0,
        "candidate_event_type": event_type,
        "candidate_shift_years": shift,
        "candidate_start_year": start,
        "candidate_end_year": end,
        "candidate_top_year": (start + end) // 2,
        "exact_product_primary": primary,
        "exact_product_alternative": alternative,
        "exact_source_count": 1,
        "near_source_count": 1,
        "feature": float(index),
    }


class UnifiedAdjudicatorTest(unittest.TestCase):
    def test_tagged_attempt_still_loads_case_step_audit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "steps.json").write_text(json.dumps([{
                "caseIndex": 1,
                "caseId": "case-a",
                "step": 1,
                "fileId": "file-a",
                "family": "A",
                "targetId": "target-a",
                "diagnosedTruthType": "missingRing",
                "diagnosedTruthYear": 1900,
                "diagnosedTruthShiftYears": -1,
                "workflowSuggestionCorrect": False,
                "response": False,
            }]), encoding="utf8")
            audit_dir = root / "workers" / "worker-1" / "case-1-step-1"
            audit_dir.mkdir(parents=True)
            (audit_dir / "diagnosis-audit.json").write_text(json.dumps({
                "after": {
                    "audit": {
                        "targetRange": {"startYear": 1800, "endYear": 2000},
                        "candidateProjectedEvents": [{
                            "eventType": "missingRing",
                            "startYear": 1894,
                            "endYear": 1906,
                            "topYear": 1900,
                        }],
                    },
                    "operationGrid": {
                        "operations": [{
                            "eventType": "missingRing",
                            "shiftYears": -1,
                            "bestYear": 1900,
                            "dynamicScore": 0.4,
                        }],
                    },
                },
            }), encoding="utf8")
            rows, _ = MODULE.make_candidate_rows(root, "tagged-run")
            self.assertTrue(rows["attempt_id"].str.startswith("tagged-run:").all())
            self.assertGreaterEqual(int(rows["raw_candidate_count"].max()), 2)
            self.assertGreater(int(rows["source_operation_grid"].max()), 0)

    def test_product_alternative_is_part_of_operation_identity(self) -> None:
        candidates = pd.DataFrame([
            candidate_row(0, "wholeSeriesMove", -3, 1200, 1900, primary=1),
            candidate_row(1, "falseRing", 1, 1494, 1506, alternative=1),
            candidate_row(2, "falseRing", 1, 1492, 1498),
            candidate_row(3, "partialMove", -3, 1488, 1500),
        ])
        features = candidates[["feature"]]
        pairs, _, _ = MODULE.make_pairwise_table(candidates, features, ["feature"])
        false_candidate = pairs[pairs["alternative_candidate_index"] == 2].iloc[0]
        partial_candidate = pairs[pairs["alternative_candidate_index"] == 3].iloc[0]
        self.assertEqual(false_candidate["same_operation_identity"], 1)
        self.assertEqual(false_candidate["identity_product_candidate_index"], 1)
        self.assertEqual(partial_candidate["same_operation_identity"], 0)

    def test_operation_scope_never_selects_same_identity(self) -> None:
        pairs = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "alternative_candidate_index": [0, 1],
            "product_candidate_index": [2, 2],
            "same_operation_identity": [1, 0],
            "pair_label": [1, 0],
            "pair_harm": [0, 0],
        })
        candidate_probabilities = np.array([0.99, 0.7, 0.2])
        top = MODULE.top_stacked_predictions(
            pairs,
            np.array([0.99, 0.8]),
            candidate_probabilities,
            "all_geometric",
            "operation",
            0.0,
        )
        self.assertEqual(int(top.iloc[0]["alternative_candidate_index"]), 1)

    def test_recovery_threshold_keeps_wrong_and_clean_candidates_refused(self) -> None:
        top = pd.DataFrame({
            "recovery_probability": [0.96, 0.91, 0.89],
            "is_clean": [0, 1, 0],
            "label_workflow": [1, 0, 0],
            "label_strict": [1, 0, 0],
            "label_relaxed": [1, 0, 0],
            "operation_correct": [1, 0, 0],
            "location_correct": [1, 0, 0],
        })
        threshold, metrics = MODULE.choose_recovery_threshold(top)
        self.assertGreater(threshold, 0.91)
        self.assertLessEqual(threshold, 0.96)
        self.assertEqual(metrics["correctRecoveries"], 1)
        self.assertEqual(metrics["wrongEventRecoveries"], 0)
        self.assertEqual(metrics["cleanFalsePositives"], 0)

    def test_operation_override_has_priority_over_location(self) -> None:
        operation = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "file_id": ["f", "f"],
            "family": ["B", "B"],
            "dataset_role": ["evaluation", "evaluation"],
            "is_clean": [0, 0],
            "overridden": [True, False],
            "model_workflow_correct": [True, False],
            "selected_event_type": ["partialMove", "missingRing"],
            "selected_shift_years": [-6, -1],
        })
        location = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "file_id": ["f", "f"],
            "family": ["B", "B"],
            "dataset_role": ["evaluation", "evaluation"],
            "is_clean": [0, 0],
            "overridden": [True, True],
            "model_workflow_correct": [False, True],
            "selected_event_type": ["missingRing", "missingRing"],
            "selected_shift_years": [-1, -1],
        })
        combined = MODULE.combine_structured_decisions(operation, location)
        first = combined[combined["attempt_id"] == "a"].iloc[0]
        second = combined[combined["attempt_id"] == "b"].iloc[0]
        self.assertEqual(first["decision_head"], "operation")
        self.assertEqual(first["selected_event_type"], "partialMove")
        self.assertEqual(second["decision_head"], "location")
        self.assertTrue(bool(second["model_workflow_correct"]))


if __name__ == "__main__":
    unittest.main()
