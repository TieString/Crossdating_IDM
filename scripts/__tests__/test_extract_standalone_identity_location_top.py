from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "extract-standalone-identity-location-top.py"
)
SPEC = importlib.util.spec_from_file_location("identity_location_top", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ExtractStandaloneIdentityLocationTopTest(unittest.TestCase):
    def test_selects_one_location_with_frozen_weighting(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a", "a"],
            "identity_group": ["g", "g", "whole"],
            "event_type": ["missingRing", "missingRing", "wholeSeriesMove"],
            "location_global_percentile": [1.0, 0.8, 1.0],
            "location_typed_percentile": [0.0, 1.0, 1.0],
            "location_global_classifier_percentile": [0.0, 1.0, 1.0],
            "location_typed_classifier_percentile": [1.0, 0.0, 1.0],
            "candidate_year": [1900, 1910, float("nan")],
        })

        top = MODULE.identity_top(frame, {
            "typedLocation": 0.0,
            "locationClassifier": 0.25,
        })

        self.assertEqual(len(top), 1)
        self.assertEqual(int(top.iloc[0]["candidate_year"]), 1910)
        self.assertAlmostEqual(float(top.iloc[0]["identity_location_score"]), 0.85)

    def test_meta_mode_uses_same_identity_meta_percentile(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "identity_group": ["g", "g"],
            "event_type": ["partialMove", "partialMove"],
            "location_global_percentile": [1.0, 0.5],
            "location_typed_percentile": [1.0, 0.5],
            "location_global_classifier_percentile": [1.0, 0.5],
            "location_typed_classifier_percentile": [1.0, 0.5],
            "location_meta_percentile": [0.2, 1.0],
            "candidate_year": [1900, 1910],
        })

        top = MODULE.identity_top(frame, {}, "meta")

        self.assertEqual(int(top.iloc[0]["candidate_year"]), 1910)


if __name__ == "__main__":
    unittest.main()
