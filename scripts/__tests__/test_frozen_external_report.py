from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPTS = Path(__file__).resolve().parents[1]


def load_report_module():
    path = SCRIPTS / "report-frozen-external-test.py"
    spec = importlib.util.spec_from_file_location("frozen_external_report_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


REPORT = load_report_module()


class FrozenExternalReportTest(unittest.TestCase):
    def test_normalize_attempt_id_removes_dataset_prefix(self) -> None:
        self.assertEqual(
            REPORT.normalize_attempt_id(
                "frozen-external50-e59203fc:evaluation:123:4"
            ),
            "evaluation:123:4",
        )
        self.assertEqual(
            REPORT.normalize_attempt_id("evaluation:123:4"),
            "evaluation:123:4",
        )

    def test_post_package_recovery_is_not_reclassified_as_failure(self) -> None:
        frame = pd.DataFrame({
            "model_workflow_correct": [1, 0, 0, 0, 0],
            "model_response": [1, 0, 1, 1, 1],
            "candidate_oracle": [0, 0, 0, 1, 1],
            "model_operation_correct": [1, 0, 0, 0, 1],
        })
        self.assertEqual(
            REPORT.classify_failure_reasons(frame).tolist(),
            [
                "correct",
                "refusal",
                "evidence_projection_loss",
                "operation_or_shift_selection",
                "location_selection",
            ],
        )


if __name__ == "__main__":
    unittest.main()
