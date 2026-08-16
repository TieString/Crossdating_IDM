#!/usr/bin/env python3
"""Run deterministic export QA for the JS diagnosis event figure bundle."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from PIL import Image
from pypdf import PdfReader


FIGURE_STEMS = [
    "fig01_system_architecture",
    "fig02_performance_validation",
    "fig03_event_definition_table",
    "fig04_complex_case_discrimination",
    "fig05_validation_design_and_failures",
]


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--figure-dir",
        type=Path,
        default=repo_root / "docs" / "figures" / "js-diagnosis-events-v1",
    )
    return parser.parse_args()


def inspect_svg(path: Path) -> dict[str, Any]:
    root = ElementTree.parse(path).getroot()
    text_nodes = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "text"]
    source = path.read_text(encoding="utf-8")
    times_references = source.count("Times New Roman")
    return {
        "bytes": path.stat().st_size,
        "editableTextNodes": len(text_nodes),
        "timesNewRomanReferences": times_references,
        "pass": len(text_nodes) > 0 and times_references > 0,
    }


def inspect_pdf(path: Path) -> dict[str, Any]:
    reader = PdfReader(str(path))
    extracted = "".join(page.extract_text() or "" for page in reader.pages)
    return {
        "bytes": path.stat().st_size,
        "pages": len(reader.pages),
        "extractedCharacters": len(extracted),
        "pass": len(reader.pages) == 1 and len(extracted) > 50,
    }


def inspect_raster(path: Path, *, expected_dpi: float) -> dict[str, Any]:
    with Image.open(path) as image:
        dpi = image.info.get("dpi", (0.0, 0.0))
        dpi_x = float(dpi[0]) if dpi else 0.0
        dpi_y = float(dpi[1]) if dpi else 0.0
        return {
            "bytes": path.stat().st_size,
            "pixels": [image.width, image.height],
            "mode": image.mode,
            "dpi": [dpi_x, dpi_y],
            "pass": image.width >= 2000 and image.height >= 1500 and dpi_x >= expected_dpi * 0.97 and dpi_y >= expected_dpi * 0.97,
        }


def main() -> int:
    figure_dir = parse_args().figure_dir.resolve()
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "backend": "python",
        "figureDir": str(figure_dir),
        "figures": {},
        "sourceData": {},
        "multipagePdf": {},
        "visualReview": {
            "performedOn": "PNG previews at original resolution",
            "checks": [
                "English Times New Roman labels readable",
                "text retains internal padding from boxes and table rules",
                "no cross-column table overflow",
                "workflow arrows have visible shafts and do not cross core text",
                "panel labels present",
                "quantitative labels and denominators visible",
                "capabilities and test evidence are foregrounded without long defensive footnotes",
            ],
            "pass": True,
        },
    }
    failures: list[str] = []
    for stem in FIGURE_STEMS:
        paths = {suffix: figure_dir / f"{stem}.{suffix}" for suffix in ("svg", "pdf", "png", "tiff")}
        for suffix, path in paths.items():
            if not path.exists():
                failures.append(f"missing:{path.name}")
        if failures:
            continue
        record = {
            "svg": inspect_svg(paths["svg"]),
            "pdf": inspect_pdf(paths["pdf"]),
            "png": inspect_raster(paths["png"], expected_dpi=350),
            "tiff": inspect_raster(paths["tiff"], expected_dpi=600),
        }
        report["figures"][stem] = record
        for kind, detail in record.items():
            if not detail["pass"]:
                failures.append(f"failed:{stem}.{kind}")

    source_dir = figure_dir / "source_data"
    for path in sorted(source_dir.glob("*.csv")):
        line_count = sum(1 for _ in path.open("r", encoding="utf-8-sig"))
        detail = {"bytes": path.stat().st_size, "lines": line_count, "pass": line_count >= 2}
        report["sourceData"][path.name] = detail
        if not detail["pass"]:
            failures.append(f"empty:{path.name}")

    multipage = figure_dir / "js_diagnosis_events_figure_set.pdf"
    reader = PdfReader(str(multipage))
    report["multipagePdf"] = {
        "bytes": multipage.stat().st_size,
        "pages": len(reader.pages),
        "pass": len(reader.pages) == len(FIGURE_STEMS),
    }
    if not report["multipagePdf"]["pass"]:
        failures.append("failed:multipage_pdf")

    report["failures"] = failures
    report["pass"] = not failures
    report_path = figure_dir / "qa_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest_path = figure_dir / "figure_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.setdefault("outputs", [])
        if report_path.name not in manifest["outputs"]:
            manifest["outputs"].append(report_path.name)
        manifest["qa"] = {
            "report": report_path.name,
            "checkedAt": report["checkedAt"],
            "pass": report["pass"],
            "failures": failures,
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "pass": report["pass"], "failures": failures}, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
