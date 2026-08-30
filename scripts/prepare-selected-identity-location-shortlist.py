#!/usr/bin/env python3
"""Build a truth-blind location shortlist for selected operation identities."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
DEFAULT_LOCATION_VIEWS = (
    "location_score",
    "location_meta_score",
    "location_typed_score",
    "location_global_score",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_identity_group(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    if "identity_group" not in output:
        output["identity_group"] = (
            output["attempt_id"].astype(str)
            + "|" + output["event_type"].astype(str)
            + "|" + output["shift_years"].astype(int).astype(str)
        )
    return output


def normalize_candidate_year(frame: pd.DataFrame) -> pd.DataFrame:
    """Expose exactly one integer year column before candidate sets merge."""

    output = frame.copy()
    if "year" in output:
        year = pd.to_numeric(output["year"], errors="coerce")
    elif "candidate_year" in output:
        year = pd.to_numeric(output["candidate_year"], errors="coerce")
    else:
        raise ValueError("location packages miss candidate_year/year")
    if year.isna().any():
        raise ValueError("location packages contain invalid candidate years")
    output["year"] = year.astype(int)
    return output.drop(columns=["candidate_year"], errors="ignore")


def build_shortlist(
    packages: pd.DataFrame,
    operation_top: pd.DataFrame,
    *,
    top_per_view: int = 3,
    views: tuple[str, ...] = DEFAULT_LOCATION_VIEWS,
    anchor_scores: pd.DataFrame | None = None,
    replace_anchored_identities: bool = False,
) -> pd.DataFrame:
    if top_per_view < 1:
        raise ValueError("top_per_view must be positive")
    packages = normalize_candidate_year(ensure_identity_group(packages))
    operation_top = ensure_identity_group(operation_top)
    selected = operation_top[
        operation_top["event_type"].isin(LOCAL_EVENT_TYPES)
    ][["identity_group"]].drop_duplicates()
    source = packages.merge(
        selected,
        on="identity_group",
        how="inner",
        validate="many_to_one",
    ).copy()
    year_column = "year"
    available_views = tuple(view for view in views if view in source)
    if not available_views:
        raise ValueError("location packages miss all frozen location views")
    missing_identities = sorted(
        set(selected["identity_group"]) - set(source["identity_group"])
    )
    if missing_identities:
        raise ValueError(
            f"selected local identities miss packages: {missing_identities[:3]}"
        )

    selected_indices: set[int] = set()
    for view in available_views:
        source[view] = pd.to_numeric(source[view], errors="coerce")
        ranked = source.sort_values(
            ["identity_group", view, year_column],
            ascending=[True, False, False],
            kind="mergesort",
        ).groupby("identity_group", sort=False).head(top_per_view)
        selected_indices.update(ranked.index)
    fallback = source.loc[sorted(selected_indices)].drop_duplicates(
        ["identity_group", year_column], keep="first"
    ).copy()
    anchor_feature: pd.DataFrame | None = None
    if anchor_scores is not None:
        anchors = normalize_candidate_year(ensure_identity_group(anchor_scores))
        anchors = anchors[anchors["identity_group"].isin(
            set(selected["identity_group"])
        )].copy()
        if "residual_oof_score" in anchors:
            anchor_feature = anchors[[
                "identity_group", "year", "residual_oof_score",
            ]].rename(columns={
                "residual_oof_score": "anchor_location_oof_score",
            }).drop_duplicates(["identity_group", "year"])
            anchors = anchors.drop(columns=["residual_oof_score"])
        if replace_anchored_identities:
            anchored_identities = set(anchors["identity_group"])
            fallback = fallback[~fallback["identity_group"].isin(
                anchored_identities
            )]
        # Keep the richer frozen-view row when an anchor names the same year;
        # anchor-only years are appended without replacing bottom evidence.
        output = pd.concat([fallback, anchors], ignore_index=True, sort=False)
    else:
        output = fallback
    output = output.drop_duplicates(
        ["identity_group", "year"], keep="first"
    ).copy()
    if anchor_feature is not None:
        output = output.merge(
            anchor_feature,
            on=["identity_group", "year"],
            how="left",
            validate="one_to_one",
        )
    if "window_correct" not in output and "location_correct" in output:
        output["window_correct"] = pd.to_numeric(
            output["location_correct"], errors="coerce"
        ).fillna(0).astype("int8")
    output["listwise_score"] = pd.to_numeric(
        output.get("location_score", output[available_views[0]]),
        errors="coerce",
    ).fillna(0)
    output["pairwise_score"] = pd.to_numeric(
        output.get("location_meta_score", output[available_views[0]]),
        errors="coerce",
    ).fillna(output["listwise_score"])
    output["proposal_id"] = (
        output["attempt_id"].astype(str)
        + "|" + output["event_type"].astype(str)
        + "|" + output["shift_years"].astype(int).astype(str)
        + "|" + output["year"].astype(str)
    )
    return output.sort_values(
        ["attempt_id", "identity_group", "year"], kind="mergesort"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-packages", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--top-per-view", type=int, default=3)
    parser.add_argument("--anchor-location-scores")
    parser.add_argument("--replace-anchored-identities", action="store_true")
    args = parser.parse_args()

    package_path = Path(args.location_packages).resolve()
    operation_path = Path(args.operation_top).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    packages = pd.read_pickle(package_path)
    operation_top = pd.read_csv(operation_path)
    shortlist = build_shortlist(
        packages,
        operation_top,
        top_per_view=args.top_per_view,
        anchor_scores=(
            pd.read_pickle(Path(args.anchor_location_scores).resolve())
            if args.anchor_location_scores else None
        ),
        replace_anchored_identities=args.replace_anchored_identities,
    )
    shortlist.to_pickle(output_dir / "location-scores.pkl")
    proposal_columns = [
        "proposal_id", "attempt_id", "file_id", "family", "event_type",
        "shift_years", "year", "listwise_score", "pairwise_score",
    ]
    shortlist[proposal_columns].to_csv(
        output_dir / "proposals.csv", index=False
    )
    summary = {
        "schemaVersion": 1,
        "truthBlind": True,
        "operationIdentityImmutable": True,
        "candidateWindowsImmutable": True,
        "locationPackages": str(package_path),
        "locationPackagesSha256": sha256_file(package_path),
        "operationTop": str(operation_path),
        "operationTopSha256": sha256_file(operation_path),
        "topPerView": args.top_per_view,
        "anchorLocationScores": (
            str(Path(args.anchor_location_scores).resolve())
            if args.anchor_location_scores else None
        ),
        "replaceAnchoredIdentities": args.replace_anchored_identities,
        "views": [
            view for view in DEFAULT_LOCATION_VIEWS if view in shortlist
        ],
        "identities": int(shortlist["identity_group"].nunique()),
        "proposals": int(len(shortlist)),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
