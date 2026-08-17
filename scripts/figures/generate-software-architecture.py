#!/usr/bin/env python3
"""Generate the code-grounded Crossdating-IDM software architecture figure."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Rectangle


COLORS = {
    "ink": "#292D32",
    "muted": "#626A70",
    "teal": "#247F8D",
    "teal_soft": "#C4DEE3",
    "blue_soft": "#C5DCEA",
    "green_soft": "#CBE1D7",
    "gold_soft": "#EAD9A8",
    "rose_soft": "#E6C8CC",
    "purple_soft": "#D9CEE2",
    "panel": "#F8FAFB",
    "white": "#FFFFFF",
    "line": "#343A40",
}


def configure_style() -> None:
    mpl.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman"],
            "font.size": 10.5,
            "axes.unicode_minus": False,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "savefig.facecolor": "white",
        }
    )


def add_rectangle(
    ax: plt.Axes,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    facecolor: str,
    edgecolor: str = COLORS["line"],
    linewidth: float = 1.25,
    zorder: float = 1,
) -> Rectangle:
    patch = Rectangle(
        (x, y),
        width,
        height,
        transform=ax.transAxes,
        facecolor=facecolor,
        edgecolor=edgecolor,
        linewidth=linewidth,
        joinstyle="miter",
        zorder=zorder,
    )
    ax.add_patch(patch)
    return patch


def add_text(
    ax: plt.Axes,
    x: float,
    y: float,
    text: str,
    *,
    size: float = 10.5,
    weight: str = "normal",
    color: str = COLORS["ink"],
    ha: str = "left",
    va: str = "top",
    linespacing: float = 1.18,
    zorder: float = 4,
) -> None:
    ax.text(
        x,
        y,
        text,
        transform=ax.transAxes,
        fontsize=size,
        fontweight=weight,
        color=color,
        ha=ha,
        va=va,
        linespacing=linespacing,
        zorder=zorder,
    )


def add_layer(
    ax: plt.Axes,
    y: float,
    height: float,
    title: str,
) -> tuple[float, float]:
    x = 0.045
    width = 0.91
    header_height = 0.036
    add_rectangle(ax, x, y, width, height, facecolor=COLORS["panel"], linewidth=1.45)
    add_rectangle(
        ax,
        x,
        y + height - header_height,
        width,
        header_height,
        facecolor=COLORS["teal"],
        linewidth=1.45,
        zorder=2,
    )
    add_text(
        ax,
        x + 0.013,
        y + height - header_height / 2,
        title,
        size=12.2,
        weight="bold",
        color=COLORS["white"],
        va="center",
    )
    return y, y + height - header_height


def add_box(
    ax: plt.Axes,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    title: str,
    body: str,
    header_color: str,
    title_size: float = 10.7,
    body_size: float = 9.4,
    body_linespacing: float = 1.18,
) -> None:
    header_height = min(0.031, height * 0.30)
    add_rectangle(ax, x, y, width, height, facecolor=COLORS["white"], linewidth=1.15, zorder=2)
    add_rectangle(
        ax,
        x,
        y + height - header_height,
        width,
        header_height,
        facecolor=header_color,
        linewidth=1.15,
        zorder=3,
    )
    add_text(
        ax,
        x + width / 2,
        y + height - header_height / 2,
        title,
        size=title_size,
        weight="bold",
        ha="center",
        va="center",
    )
    add_text(
        ax,
        x + 0.012,
        y + height - header_height - 0.010,
        body,
        size=body_size,
        linespacing=body_linespacing,
    )


def add_group(
    ax: plt.Axes,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    title: str,
    header_color: str,
) -> tuple[float, float, float, float]:
    header_height = 0.030
    add_rectangle(ax, x, y, width, height, facecolor=COLORS["white"], linewidth=1.2, zorder=2)
    add_rectangle(
        ax,
        x,
        y + height - header_height,
        width,
        header_height,
        facecolor=header_color,
        linewidth=1.2,
        zorder=3,
    )
    add_text(
        ax,
        x + width / 2,
        y + height - header_height / 2,
        title,
        size=10.8,
        weight="bold",
        ha="center",
        va="center",
    )
    return x, y, width, height - header_height


def add_inner_box(
    ax: plt.Axes,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    title: str,
    text: str,
    facecolor: str,
    title_size: float = 9.4,
    body_size: float = 8.6,
) -> None:
    add_rectangle(ax, x, y, width, height, facecolor=facecolor, linewidth=1.0, zorder=3)
    add_text(
        ax,
        x + 0.010,
        y + height - 0.008,
        title,
        size=title_size,
        weight="bold",
    )
    add_text(
        ax,
        x + 0.010,
        y + height - 0.026,
        text,
        size=body_size,
        color=COLORS["ink"],
        linespacing=1.15,
    )


def add_arrow(
    ax: plt.Axes,
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    color: str = COLORS["line"],
    linewidth: float = 1.45,
    mutation_scale: float = 13,
    connectionstyle: str = "arc3,rad=0",
    zorder: float = 5,
) -> None:
    arrow = FancyArrowPatch(
        start,
        end,
        transform=ax.transAxes,
        arrowstyle="-|>",
        mutation_scale=mutation_scale,
        linewidth=linewidth,
        color=color,
        shrinkA=0,
        shrinkB=0,
        connectionstyle=connectionstyle,
        capstyle="butt",
        joinstyle="miter",
        zorder=zorder,
    )
    ax.add_patch(arrow)


def add_double_arrow(
    ax: plt.Axes,
    start: tuple[float, float],
    end: tuple[float, float],
) -> None:
    arrow = FancyArrowPatch(
        start,
        end,
        transform=ax.transAxes,
        arrowstyle="<|-|>",
        mutation_scale=11,
        linewidth=1.25,
        color=COLORS["line"],
        shrinkA=0,
        shrinkB=0,
        zorder=5,
    )
    ax.add_patch(arrow)


def add_polyline_arrow(
    ax: plt.Axes,
    points: list[tuple[float, float]],
    *,
    color: str = COLORS["teal"],
    linewidth: float = 1.45,
) -> None:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    ax.plot(
        xs,
        ys,
        transform=ax.transAxes,
        color=color,
        linewidth=linewidth,
        solid_capstyle="butt",
        solid_joinstyle="miter",
        clip_on=False,
        zorder=5,
    )
    add_arrow(
        ax,
        points[-2],
        points[-1],
        color=color,
        linewidth=linewidth,
        mutation_scale=12,
        zorder=6,
    )


def build_figure() -> plt.Figure:
    configure_style()
    fig = plt.figure(figsize=(7.35, 10.35), facecolor="white")
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    add_text(
        ax,
        0.045,
        0.975,
        "Crossdating-IDM Software Architecture",
        size=22,
        weight="bold",
    )
    add_text(
        ax,
        0.045,
        0.941,
        "Version-aware orchestration from RWL data to expert-confirmed event edits",
        size=11.8,
        color=COLORS["muted"],
    )

    # Layer 1: interaction
    add_layer(ax, 0.750, 0.158, "LAYER 1   USER INTERACTION · REACT IN TAURI WEBVIEW")
    add_box(
        ax,
        0.065,
        0.772,
        0.270,
        0.091,
        title="Workspace layout",
        body="• Resizable panels\n• Width grid\n• Linked series chart",
        header_color=COLORS["blue_soft"],
    )
    add_box(
        ax,
        0.365,
        0.772,
        0.270,
        0.091,
        title="Evidence views",
        body="• Tree-ring scan\n• COFECHA report\n• Event review window",
        header_color=COLORS["teal_soft"],
    )
    add_box(
        ax,
        0.665,
        0.772,
        0.270,
        0.091,
        title="Expert controls",
        body="• Select target / reference\n• Preview one edit\n• Confirm, undo or redo",
        header_color=COLORS["green_soft"],
    )

    # Layer 2: state and domain
    add_layer(ax, 0.500, 0.210, "LAYER 2   WORKSPACE STATE & DOMAIN SERVICES · TYPESCRIPT")
    add_box(
        ax,
        0.065,
        0.558,
        0.270,
        0.106,
        title="Workspace orchestrator",
        body="useHomeWorkspace\n• File and target identity\n• Reference / COFECHA state\n• Scan and view state",
        header_color=COLORS["teal_soft"],
        body_size=8.9,
    )
    add_box(
        ax,
        0.365,
        0.558,
        0.270,
        0.106,
        title="RWL editor state core",
        body="RwlEditor\n• Raw baseline + working data\n• Format metadata\n• History + operation journal",
        header_color=COLORS["rose_soft"],
        body_size=8.9,
    )
    add_box(
        ax,
        0.665,
        0.558,
        0.270,
        0.106,
        title="TypeScript domain services",
        body="• RWL parse / format\n• Reference chronology\n• COFECHA report parsing\n• Linked year navigation",
        header_color=COLORS["purple_soft"],
        body_size=8.9,
    )
    add_rectangle(ax, 0.065, 0.515, 0.870, 0.027, facecolor=COLORS["green_soft"], linewidth=1.0, zorder=2)
    add_text(
        ax,
        0.500,
        0.5285,
        "STATE COHERENCE   request ID  ·  workspace epoch  ·  RWL hash  ·  stale-result invalidation",
        size=9.0,
        weight="bold",
        ha="center",
        va="center",
    )

    # Layer 3: execution split into worker and desktop services
    add_layer(ax, 0.190, 0.273, "LAYER 3   ISOLATED COMPUTE & DESKTOP SERVICES")
    add_group(
        ax,
        0.065,
        0.211,
        0.500,
        0.205,
        title="Dedicated Web Worker · TypeScript diagnosis",
        header_color=COLORS["blue_soft"],
    )
    add_inner_box(
        ax,
        0.083,
        0.346,
        0.464,
        0.046,
        title="Immutable request snapshot",
        text="Working site data · target · reference config · fresh COFECHA text",
        facecolor="#F2F7FA",
        body_size=7.9,
    )
    add_inner_box(
        ax,
        0.083,
        0.257,
        0.464,
        0.074,
        title="Event diagnosis engine",
        text=(
            "Global + segmented matching · constrained lag-state paths\n"
            "counterfactual edit scans · multi-core evidence fusion\n"
            "embedded tree ensembles · joint event adjudication"
        ),
        facecolor="#F7F9FB",
        body_size=8.15,
    )
    add_inner_box(
        ax,
        0.083,
        0.216,
        0.464,
        0.035,
        title="Typed result",
        text="event · shift · review window · evidence · preview",
        facecolor=COLORS["green_soft"],
        title_size=8.6,
        body_size=7.7,
    )
    add_arrow(ax, (0.315, 0.346), (0.315, 0.331), linewidth=1.15, mutation_scale=10)
    add_arrow(ax, (0.315, 0.257), (0.315, 0.247), linewidth=1.15, mutation_scale=10)

    add_group(
        ax,
        0.595,
        0.211,
        0.340,
        0.205,
        title="Tauri / Rust desktop services",
        header_color=COLORS["gold_soft"],
    )
    add_inner_box(
        ax,
        0.613,
        0.346,
        0.304,
        0.046,
        title="Tauri plugins",
        text="filesystem · dialog · path · shell",
        facecolor="#FBF7EB",
        body_size=8.2,
    )
    add_inner_box(
        ax,
        0.613,
        0.282,
        0.304,
        0.054,
        title="Rust commands",
        text="TIFF decode / crop / cache\nOUT mirroring beside source RWL",
        facecolor="#FBF7EB",
        body_size=8.2,
    )
    add_inner_box(
        ax,
        0.613,
        0.222,
        0.304,
        0.050,
        title="COFECHA runner",
        text="write working RWL · spawn sidecar\nread VERYCOF.OUT",
        facecolor=COLORS["rose_soft"],
        body_size=8.2,
    )

    # Layer 4: resources and persistent state
    add_layer(ax, 0.027, 0.126, "LAYER 4   PERSISTENT & EXTERNAL RESOURCES")
    add_box(
        ax,
        0.065,
        0.044,
        0.270,
        0.064,
        title="Source workspace",
        body="RWL files · scan images\noptional <stem>.OUT mirror",
        header_color=COLORS["blue_soft"],
        title_size=9.7,
        body_size=8.2,
    )
    add_box(
        ax,
        0.365,
        0.044,
        0.270,
        0.064,
        title="Application data",
        body="Per-file JSON state · scan cache\ncofecha-work / VERYCOF.OUT",
        header_color=COLORS["green_soft"],
        title_size=9.7,
        body_size=8.2,
    )
    add_box(
        ax,
        0.665,
        0.044,
        0.270,
        0.064,
        title="Bundled executables",
        body="COFECHA · COFECHA12K\nCOFECHA Win",
        header_color=COLORS["gold_soft"],
        title_size=9.7,
        body_size=8.2,
    )

    # Inter-layer data flow. Parallel shafts remain outside text blocks.
    add_arrow(ax, (0.200, 0.750), (0.200, 0.710), color=COLORS["teal"], linewidth=1.7)
    add_arrow(ax, (0.500, 0.750), (0.500, 0.710), color=COLORS["teal"], linewidth=1.7)
    add_arrow(ax, (0.800, 0.750), (0.800, 0.710), color=COLORS["teal"], linewidth=1.7)
    add_double_arrow(ax, (0.335, 0.611), (0.365, 0.611))
    add_double_arrow(ax, (0.635, 0.611), (0.665, 0.611))

    add_arrow(ax, (0.235, 0.500), (0.235, 0.416), color=COLORS["teal"], linewidth=1.65)
    add_arrow(ax, (0.765, 0.500), (0.765, 0.416), color=COLORS["teal"], linewidth=1.65)
    add_polyline_arrow(
        ax,
        [(0.083, 0.233), (0.027, 0.233), (0.027, 0.611), (0.065, 0.611)],
        linewidth=1.45,
    )
    add_polyline_arrow(
        ax,
        [(0.917, 0.369), (0.973, 0.369), (0.973, 0.611), (0.935, 0.611)],
        linewidth=1.35,
    )
    ax.text(
        0.017,
        0.396,
        "diagnosis response",
        transform=ax.transAxes,
        rotation=90,
        fontsize=7.8,
        color=COLORS["muted"],
        ha="center",
        va="center",
        zorder=6,
    )
    ax.text(
        0.983,
        0.470,
        "files · OUT · state",
        transform=ax.transAxes,
        rotation=90,
        fontsize=7.8,
        color=COLORS["muted"],
        ha="center",
        va="center",
        zorder=6,
    )

    add_arrow(ax, (0.200, 0.190), (0.200, 0.108), linewidth=1.45)
    add_arrow(ax, (0.500, 0.190), (0.500, 0.108), linewidth=1.45)
    add_arrow(ax, (0.800, 0.190), (0.800, 0.108), linewidth=1.45)

    add_text(ax, 0.071, 0.728, "user actions", size=8.0, color=COLORS["muted"], va="center")
    add_text(ax, 0.071, 0.481, "state snapshots", size=8.0, color=COLORS["muted"], va="center")
    add_text(ax, 0.736, 0.481, "I/O requests", size=8.0, color=COLORS["muted"], va="center")
    add_text(
        ax,
        0.500,
        0.012,
        "ONE WORKING SERIES  ·  ONE EVIDENCE COORDINATE  ·  ONE AUDITABLE EDIT PATH",
        size=8.7,
        weight="bold",
        color=COLORS["teal"],
        ha="center",
        va="center",
    )

    return fig


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=repo_root / "docs" / "figures" / "js-diagnosis-events-v1",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = output_dir / "fig08_software_architecture"

    fig = build_figure()
    svg_path = stem.with_suffix(".svg")
    fig.savefig(svg_path, bbox_inches="tight", pad_inches=0.05)
    # Matplotlib writes spaces after multiline SVG path commands; trim them so
    # repository whitespace checks remain useful for the generated vector file.
    svg_text = svg_path.read_text(encoding="utf-8")
    svg_path.write_text(
        "\n".join(line.rstrip() for line in svg_text.splitlines()) + "\n",
        encoding="utf-8",
    )
    fig.savefig(stem.with_suffix(".pdf"), bbox_inches="tight", pad_inches=0.05)
    fig.savefig(stem.with_suffix(".png"), dpi=350, bbox_inches="tight", pad_inches=0.05)
    fig.savefig(
        stem.with_suffix(".tiff"),
        dpi=600,
        bbox_inches="tight",
        pad_inches=0.05,
        pil_kwargs={"compression": "tiff_lzw"},
    )
    plt.close(fig)
    print(stem)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
