#!/usr/bin/env python3
"""Freeze additional scenario seeds over the same development files and targets."""

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
    parser.add_argument("--config", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument(
        "--prefix",
        default="itrdb-unified-adjudicator-v2-development-augmentation",
    )
    args = parser.parse_args()
    config_path = Path(args.config).resolve()
    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base_config = json.loads(config_path.read_text(encoding="utf8"))
    base_manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    git_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
    ).strip()
    written = []
    for index in range(1, args.count + 1):
        config = copy.deepcopy(base_config)
        config["seed"] = f"{base_config['seed']}:augmentation-{index}"
        config["statistics"]["seed"] = (
            f"{base_config['statistics']['seed']}:augmentation-{index}"
        )
        config["design"]["augmentationIndex"] = index
        config_name = f"{args.prefix}-{index}-config.json"
        manifest_name = f"{args.prefix}-{index}-manifest.json"
        generated_config_path = output_dir / config_name
        generated_manifest_path = output_dir / manifest_name
        config_text = json.dumps(config, indent=2) + "\n"
        generated_config_path.write_bytes(config_text.encode("utf8"))
        manifest = copy.deepcopy(base_manifest)
        manifest["createdAt"] = datetime.now(timezone.utc).isoformat()
        manifest["gitCommit"] = git_commit
        manifest["configPath"] = generated_config_path.as_posix()
        manifest["configSha256"] = hashlib.sha256(config_text.encode()).hexdigest()
        generated_manifest_path.write_bytes(
            (json.dumps(manifest, indent=2) + "\n").encode("utf8")
        )
        written.append({
            "index": index,
            "configPath": str(generated_config_path),
            "manifestPath": str(generated_manifest_path),
            "configSha256": manifest["configSha256"],
        })
    print(json.dumps({"outputDir": str(output_dir), "artifacts": written}))


if __name__ == "__main__":
    main()
