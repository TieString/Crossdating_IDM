import importlib.util
import unittest
from pathlib import Path

import pandas as pd


MODULE_PATH = Path(__file__).parents[1] / "train-internal-reference-view-selector.py"
SPEC = importlib.util.spec_from_file_location("internal_reference_view_selector", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def candidate(
    index: int,
    *,
    baseline: bool,
    response: bool,
    support: int,
    baseline_support: int,
    score: float,
    correct: int,
):
    return {
        "attemptId": "evaluation:1:1",
        "baselineMember": int(baseline),
        "clusterBaselineMember": int(baseline),
        "candidateIndex": index,
        "entryIndex": 0,
        "response": int(response),
        "support": support,
        "supportMargin": support - baseline_support,
        "baselineSupport": baseline_support,
        "baselineResponse": int(response) if baseline else 0,
        "incompatibilityScore": score,
        "correct": correct,
    }


class InternalReferenceViewSelectorTest(unittest.TestCase):
    def test_clean_refusal_is_not_overridden_by_two_view_noise(self):
        frame = pd.DataFrame(
            [
                candidate(
                    0,
                    baseline=True,
                    response=False,
                    support=1,
                    baseline_support=1,
                    score=0,
                    correct=1,
                ),
                candidate(
                    1,
                    baseline=False,
                    response=True,
                    support=2,
                    baseline_support=1,
                    score=0,
                    correct=0,
                ),
            ]
        )
        selected = MODULE.safe_consensus_selection(frame)
        self.assertEqual(selected, 0)

    def test_incompatible_refusal_can_be_recovered(self):
        frame = pd.DataFrame(
            [
                candidate(
                    0,
                    baseline=True,
                    response=False,
                    support=1,
                    baseline_support=1,
                    score=2,
                    correct=0,
                ),
                candidate(
                    1,
                    baseline=False,
                    response=True,
                    support=3,
                    baseline_support=1,
                    score=2,
                    correct=1,
                ),
            ]
        )
        selected = MODULE.safe_consensus_selection(frame)
        self.assertEqual(selected, 1)

    def test_feature_contract_excludes_identity_truth_and_absolute_years(self):
        frame = pd.DataFrame(
            [
                {
                    "partition": "development",
                    "attemptId": "evaluation:1:1",
                    "fileId": "forbidden",
                    "candidateViewId": "rawpre",
                    "candidateOperation": "missingRing",
                    "windowStart": 1900,
                    "windowEnd": 1912,
                    "candidateIndex": 0,
                    "entryIndex": 0,
                    "correct": 1,
                    "baselineCorrect": 1,
                    "support": 3,
                }
            ]
        )
        columns = MODULE.feature_columns(frame)
        self.assertEqual(columns, ["support"])


if __name__ == "__main__":
    unittest.main()
