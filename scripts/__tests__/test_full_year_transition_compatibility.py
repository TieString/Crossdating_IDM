from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "train-standalone-full-year-location-head.py"
)
SPEC = importlib.util.spec_from_file_location("full_year_location", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FullYearTransitionCompatibilityTest(unittest.TestCase):
    def test_relative_step_is_invariant_to_whole_baseline(self) -> None:
        rows = pd.DataFrame({
            "shift_years": [-6, -6],
            "rawTransition_olderLag": [-6, -9],
            "rawTransition_newerLag": [0, -3],
            "rawTransition_localOlderLag": [-6, -9],
            "rawTransition_localNewerLag": [0, -3],
            "rawTransition_normalizedSplitGain": [0.8, 0.8],
        })

        result = MODULE.add_transition_shift_compatibility(rows)

        self.assertEqual(
            result[
                "transitionCompatibility_rawTransition_global_absoluteError"
            ].tolist(),
            [0.0, 0.0],
        )
        self.assertEqual(
            result[
                "transitionCompatibility_rawTransition_global_exact"
            ].tolist(),
            [1.0, 1.0],
        )

    def test_wrong_shift_identity_has_nonzero_error(self) -> None:
        rows = pd.DataFrame({
            "shift_years": [-4],
            "rawTransition_olderLag": [-6],
            "rawTransition_newerLag": [0],
        })

        result = MODULE.add_transition_shift_compatibility(rows)

        self.assertEqual(
            float(result[
                "transitionCompatibility_rawTransition_global_absoluteError"
            ].iloc[0]),
            2.0,
        )


if __name__ == "__main__":
    unittest.main()
