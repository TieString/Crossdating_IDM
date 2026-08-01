"""Check the Python environment before rebuilding the bundled sidecar."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import sys
from pathlib import Path


EXPECTED_PYINSTALLER = "6.14.2"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()

    manifest = json.loads(
        (args.bundle.resolve() / "training_manifest.json").read_text(encoding="utf-8")
    )
    expected_packages = dict(manifest["environment"]["packages"])
    expected_packages["pyinstaller"] = EXPECTED_PYINSTALLER
    actual_packages = {
        name: importlib.metadata.version(name)
        for name in expected_packages
    }
    mismatches = {
        name: {"expected": expected_packages[name], "actual": actual_packages[name]}
        for name in expected_packages
        if actual_packages[name] != expected_packages[name]
    }
    if sys.version_info[:3] != (3, 10, 6):
        mismatches["python"] = {
            "expected": "3.10.6",
            "actual": platform.python_version(),
        }
    if mismatches:
        raise RuntimeError(
            "sidecar build environment does not match the frozen versions: "
            + json.dumps(mismatches, ensure_ascii=False, sort_keys=True)
        )

    print(json.dumps({
        "ok": True,
        "python": platform.python_version(),
        "packages": actual_packages,
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
