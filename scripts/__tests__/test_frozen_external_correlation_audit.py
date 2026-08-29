from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPTS = Path(__file__).resolve().parents[1]


def load_audit_module():
    path = SCRIPTS / "audit-frozen-external-correlation-oracle.py"
    spec = importlib.util.spec_from_file_location("frozen_external_correlation_audit_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


AUDIT = load_audit_module()


class FrozenExternalCorrelationAuditTest(unittest.TestCase):
    def test_partial_move_adds_transitive_missing_review(self) -> None:
        row = pd.Series({
            "attempt_id": "evaluation:1:1",
            "selected_candidate_source": "unifiedFullYearProposal",
            "event_type": "partialMove",
            "shift_years": -4,
            "selected_candidate_year": 1900,
        })
        proposal_sources = {
            "unifiedFullYearProposal": {
                "evaluation:1:1": {"selected_candidate_source": "fullYearProfile"}
            }
        }
        source, interpretations = AUDIT.selected_interpretations(
            row,
            {"primary": None, "alternative": None},
            proposal_sources,
        )
        self.assertEqual(source, "fullYearProfile")
        self.assertEqual(
            [item["eventType"] for item in interpretations],
            ["partialMove", "missingRing"],
        )
        self.assertEqual(interpreting_window(interpretations[1]), (1894, 1906))

    def test_product_primary_retains_exact_window_and_alternative(self) -> None:
        row = pd.Series({
            "attempt_id": "evaluation:2:1",
            "selected_candidate_source": "unifiedBaseProposal",
            "event_type": "wholeSeriesMove",
            "shift_years": -4,
            "selected_candidate_year": None,
        })
        primary = {
            "eventType": "wholeSeriesMove",
            "shiftYears": -4,
            "startYear": 1800,
            "endYear": 2000,
            "topYear": None,
        }
        alternative = {
            "eventType": "missingRing",
            "shiftYears": -1,
            "startYear": 1960,
            "endYear": 1972,
            "topYear": 1967,
        }
        proposal_sources = {
            "unifiedBaseProposal": {
                "evaluation:2:1": {"selected_candidate_source": "productPrimary"}
            }
        }
        _, interpretations = AUDIT.selected_interpretations(
            row,
            {"primary": primary, "alternative": alternative},
            proposal_sources,
        )
        self.assertEqual(
            [item["eventType"] for item in interpretations],
            ["wholeSeriesMove", "missingRing"],
        )
        self.assertEqual(interpreting_window(interpretations[1]), (1960, 1972))

    def test_failure_categories_are_mutually_exclusive(self) -> None:
        base = {
            "model_workflow_correct": 0,
            "model_response": 1,
            "frontier_error": False,
            "model_operation_correct": 1,
            "location_correct": 0,
        }
        self.assertEqual(AUDIT.failure_category(pd.Series(base)), "window_location")
        self.assertEqual(
            AUDIT.failure_category(pd.Series({**base, "frontier_error": True})),
            "frontier_selection",
        )
        self.assertEqual(
            AUDIT.failure_category(pd.Series({**base, "model_response": 0})),
            "refusal",
        )


def interpreting_window(event: dict[str, object]) -> tuple[object, object]:
    return event["startYear"], event["endYear"]


if __name__ == "__main__":
    unittest.main()
