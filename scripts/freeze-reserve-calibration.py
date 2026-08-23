#!/usr/bin/env python3
"""Promote the pre-frozen untouched reserve files to replacement calibration v2."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-config", required=True)
    parser.add_argument("--frozen-split", required=True)
    parser.add_argument("--qualified-pool", required=True)
    parser.add_argument("--output-config", required=True)
    parser.add_argument("--output-manifest", required=True)
    args = parser.parse_args()
    base = json.loads(Path(args.base_config).read_text(encoding="utf8"))
    split = json.loads(Path(args.frozen_split).read_text(encoding="utf8"))
    qualified = json.loads(Path(args.qualified_pool).read_text(encoding="utf8"))[
        "qualified"
    ]
    reserve_ids = [
        row["fileId"] for row in split["files"] if row["role"] == "reserve"
    ]
    by_id = {row["fileId"]: row for row in qualified}
    if any(file_id not in by_id for file_id in reserve_ids):
        raise RuntimeError("reserve file missing from qualified pool")
    config = copy.deepcopy(base)
    config["frozenDate"] = "2026-08-24"
    config["seed"] = "unified-adjudicator-reserve-calibration-v2-2026-08-24"
    config["fileIds"] = reserve_ids
    config["design"]["datasetRole"] = "calibration"
    config["design"]["splitId"] = (
        "unified-adjudicator-pre-frozen-reserve-calibration-v2-2026-08-24"
    )
    config["statistics"]["seed"] = (
        "unified-adjudicator-reserve-calibration-v2-bootstrap-2026-08-24"
    )
    config_text = json.dumps(config, indent=2) + "\n"
    output_config = Path(args.output_config).resolve()
    output_manifest = Path(args.output_manifest).resolve()
    output_config.write_bytes(config_text.encode("utf8"))
    git_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
    ).strip()
    manifest = {
        "schemaVersion": 1,
        "protocolVersion": config["protocolVersion"],
        "scenarioGeneratorVersion": config["scenarioGeneratorVersion"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "gitCommit": git_commit,
        "configPath": output_config.as_posix(),
        "configSha256": hashlib.sha256(config_text.encode()).hexdigest(),
        "itrdbRoot": config["itrdbRoot"],
        "cofechaSha256": split["cofechaSha256"],
        "files": [by_id[file_id] for file_id in reserve_ids],
        "excludedFiles": [],
        "counts": {
            "requestedFiles": len(reserve_ids),
            "includedFiles": len(reserve_ids),
            "excludedFiles": 0,
            "totalSeries": sum(by_id[file_id]["totalSeries"] for file_id in reserve_ids),
            "eligibleTargetsBeforeLimit": sum(
                by_id[file_id].get("eligibleTargetsBeforeLimit", 0)
                for file_id in reserve_ids
            ),
            "eligibleTargets": sum(
                len(by_id[file_id]["eligibleTargets"]) for file_id in reserve_ids
            ),
        },
    }
    output_manifest.write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf8"))
    print(json.dumps({
        "config": str(output_config),
        "manifest": str(output_manifest),
        "fileIds": reserve_ids,
        "targets": manifest["counts"]["eligibleTargets"],
    }))


if __name__ == "__main__":
    main()
