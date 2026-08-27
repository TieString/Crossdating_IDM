from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "train-standalone-hierarchical-package.py"
)
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("standalone_hierarchical", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StandaloneHierarchicalIsolationTest(unittest.TestCase):
    def test_augmented_scenarios_share_the_same_file_cluster(self) -> None:
        packages = pd.DataFrame({
            "attempt_id": ["baseline:1:1", "augmentation-1:2:1"],
            "file_id": ["co592", "co592"],
        })

        clusters = MODULE.cluster_ids(packages, by_file_id=True)

        self.assertEqual(clusters.tolist(), ["co592", "co592"])

    def test_legacy_mode_keeps_dataset_prefix(self) -> None:
        packages = pd.DataFrame({
            "attempt_id": ["baseline:1:1", "augmentation-1:2:1"],
            "file_id": ["co592", "co592"],
        })

        clusters = MODULE.cluster_ids(packages, by_file_id=False)

        self.assertEqual(
            clusters.tolist(),
            ["baseline|co592", "augmentation-1|co592"],
        )


if __name__ == "__main__":
    unittest.main()
