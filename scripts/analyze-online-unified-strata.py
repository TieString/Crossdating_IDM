#!/usr/bin/env python3
"""Summarize file-isolated online unified OOF predictions by correlation strata."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


def correlation_bin(value: float) -> str:
    if value < 0.6:
        return "<0.60"
    if value < 0.7:
        return "0.60-0.70"
    if value < 0.8:
        return "0.70-0.80"
    return ">=0.80"


def clustered_lower_bound(
    frame: pd.DataFrame,
    column: str,
    seed: int,
    samples: int = 5000,
) -> float:
    files = frame["file_id"].drop_duplicates().to_numpy()
    if len(files) == 0:
        return 0.0
    rng = np.random.default_rng(seed)
    by_file = {
        file_id: frame.loc[frame["file_id"].eq(file_id), column].to_numpy()
        for file_id in files
    }
    values = np.empty(samples, dtype=np.float64)
    for index in range(samples):
        selected = rng.choice(files, size=len(files), replace=True)
        observations = np.concatenate([by_file[file_id] for file_id in selected])
        values[index] = observations.mean()
    return float(np.quantile(values, 0.05))


def summarize(frame: pd.DataFrame, seed: int) -> dict[str, Any]:
    attempts = len(frame)
    return {
        "files": int(frame["file_id"].nunique()),
        "attempts": attempts,
        "workflowCorrect": int(frame["combined_correct"].sum()),
        "workflowAccuracy": float(frame["combined_correct"].mean()) if attempts else 0.0,
        "clusteredOneSided95Lower": clustered_lower_bound(
            frame, "combined_correct", seed,
        ),
        "operationErrors": int((frame["operation_correct"].eq(0)).sum()),
        "windowErrors": int((
            frame["operation_correct"].eq(1)
            & frame["location_correct"].eq(0)
        ).sum()),
        "oracleMissing": int(frame["workflow_oracle"].eq(0).sum()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-md", required=True)
    parser.add_argument("--seed", type=int, default=20260901)
    parser.add_argument("--minimum-file-correlation", type=float, default=0.6)
    parser.add_argument("--minimum-target-correlation", type=float, default=0.6)
    parser.add_argument("--maximum-target-problem-segments", type=int, default=0)
    parser.add_argument("--maximum-target-zero-count", type=int, default=0)
    parser.add_argument(
        "--minimum-target-excluded-reference-cores", type=int, default=5,
    )
    args = parser.parse_args()

    predictions = pd.read_csv(args.predictions)
    cases = pd.read_csv(args.cases)[[
        "caseIndex", "fileId", "targetId", "masterCorrelation", "problemSegments",
    ]]
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf8"))
    file_correlation = {
        str(row["fileId"]): float(row["seriesIntercorrelation"])
        for row in manifest["files"]
    }
    target_quality = {
        (str(file["fileId"]), str(target["targetId"])): {
            "targetZeroCount": int(target.get("zeroCount", 0)),
            "targetExcludedReferenceCores": max(
                0,
                int(file.get(
                    "eligibleTargetsBeforeLimit",
                    len(file.get("eligibleTargets", [])),
                )) - 1,
            ),
        }
        for file in manifest["files"]
        for target in file.get("eligibleTargets", [])
    }
    cases["targetZeroCount"] = cases.apply(
        lambda row: target_quality.get(
            (str(row["fileId"]), str(row["targetId"])),
            {},
        ).get("targetZeroCount", -1),
        axis=1,
    )
    cases["targetExcludedReferenceCores"] = cases.apply(
        lambda row: target_quality.get(
            (str(row["fileId"]), str(row["targetId"])),
            {},
        ).get("targetExcludedReferenceCores", -1),
        axis=1,
    )
    predictions["caseIndex"] = predictions["attempt_id"].map(
        lambda value: int(re.search(r":(\d+):\d+$", str(value)).group(1))
    )
    frame = predictions.merge(cases, on="caseIndex", how="left", validate="many_to_one")
    frame["fileCorrelation"] = frame["file_id"].map(file_correlation)
    eligibility = (
        frame["fileCorrelation"].ge(args.minimum_file_correlation)
        & frame["masterCorrelation"].ge(args.minimum_target_correlation)
        & frame["problemSegments"].le(args.maximum_target_problem_segments)
        & frame["targetZeroCount"].le(args.maximum_target_zero_count)
        & frame["targetExcludedReferenceCores"].ge(
            args.minimum_target_excluded_reference_cores,
        )
    )
    excluded_attempts = int((~eligibility).sum())
    frame = frame.loc[eligibility].copy()
    frame["fileCorrelationBin"] = frame["fileCorrelation"].map(correlation_bin)
    frame["targetCorrelationBin"] = frame["masterCorrelation"].map(correlation_bin)

    result = {
        "schemaVersion": 1,
        "qualityProtocol": {
            "minimumFileCorrelation": args.minimum_file_correlation,
            "minimumTargetCorrelation": args.minimum_target_correlation,
            "maximumTargetProblemSegments": args.maximum_target_problem_segments,
            "maximumTargetZeroCount": args.maximum_target_zero_count,
            "minimumTargetExcludedReferenceCores": (
                args.minimum_target_excluded_reference_cores
            ),
            "excludedAttempts": excluded_attempts,
        },
        "overall": summarize(frame, args.seed),
        "byFamily": {
            name: summarize(group, args.seed + index + 1)
            for index, (name, group) in enumerate(frame.groupby("family", sort=True))
        },
        "byFileCorrelation": {
            name: summarize(group, args.seed + 100 + index)
            for index, (name, group) in enumerate(
                frame.groupby("fileCorrelationBin", sort=True)
            )
        },
        "byTargetCorrelation": {
            name: summarize(group, args.seed + 200 + index)
            for index, (name, group) in enumerate(
                frame.groupby("targetCorrelationBin", sort=True)
            )
        },
    }
    output_json = Path(args.output_json)
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")

    def table(section: str, rows: dict[str, dict[str, Any]]) -> list[str]:
        output = [
            f"## {section}",
            "",
            "| 分层 | 文件 | 诊断 | 准确率 | 单侧95%下界 | 操作错误 | 窗口错误 | Oracle缺失 |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for name, row in rows.items():
            output.append(
                f"| {name} | {row['files']} | {row['attempts']} | "
                f"{row['workflowAccuracy']:.2%} | {row['clusteredOneSided95Lower']:.2%} | "
                f"{row['operationErrors']} | {row['windowErrors']} | {row['oracleMissing']} |"
            )
        return output + [""]

    markdown = [
        "# 线上统一模型分层 OOF",
        "",
        "所有 OOF 折按完整 RWL 文件隔离。相关性仅用于报告分层，不进入模型特征。",
        (
            "目标同时满足干净态 master 相关性、问题段、自然 0 与目标排除参考芯门槛；"
            f"本次从统计分母排除 {excluded_attempts} 次不合格诊断。"
        ),
        "",
    ]
    markdown += table("A/B/C/D", result["byFamily"])
    markdown += table("文件内部相关性", result["byFileCorrelation"])
    markdown += table("目标序列与 master 相关性", result["byTargetCorrelation"])
    Path(args.output_md).write_text("\n".join(markdown), encoding="utf8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
