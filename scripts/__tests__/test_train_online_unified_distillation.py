from __future__ import annotations

import gzip
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "train-online-unified-distillation.py"
SPEC = importlib.util.spec_from_file_location("train_online_unified", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_attempt(path: Path, attempt_id: str, file_id: str) -> None:
    payload = {
        "attemptId": attempt_id,
        "fileId": file_id,
        "family": "Clean",
        "targetIdentity": {"eventType": "noEvent", "shiftYears": 0},
        "workflowOracle": True,
        "operationRows": [{
            "packageId": f"package:{attempt_id}",
            "eventType": "noEvent",
            "shiftYears": 0,
            "label": 1,
            "features": {"clean_score": 1},
        }],
        "locationRows": [],
    }
    with gzip.open(path, "wt", encoding="utf8") as handle:
        handle.write(json.dumps(payload) + "\n")


def test_loads_multiple_frozen_input_shards(tmp_path: Path) -> None:
    first = tmp_path / "events.ndjson.gz"
    second = tmp_path / "clean.ndjson.gz"
    write_attempt(first, "events:1", "file-a")
    write_attempt(second, "clean:1", "file-b")

    rows, attempts = MODULE.load_operation_rows([first, second])

    assert len(rows) == 2
    assert set(attempts) == {"events:1", "clean:1"}


def test_rejects_duplicate_attempt_ids_across_shards(tmp_path: Path) -> None:
    first = tmp_path / "first.ndjson.gz"
    second = tmp_path / "second.ndjson.gz"
    write_attempt(first, "same:1", "file-a")
    write_attempt(second, "same:1", "file-b")

    with pytest.raises(ValueError, match="duplicate attempt id"):
        MODULE.load_operation_rows([first, second])
