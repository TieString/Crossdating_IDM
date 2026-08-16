#!/usr/bin/env python3
"""Generate the six-panel lag-state diagnostic grammar figure."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.font_manager import findfont
from matplotlib.patches import FancyArrowPatch, Rectangle


PALETTE = {
    "ink": "#25282C",
    "muted": "#667078",
    "line": "#3B4046",
    "grid": "#D8DDE1",
    "panel": "#FAFBFC",
    "blue": "#3B78A8",
    "blue_soft": "#DCEAF3",
    "teal": "#247F8D",
    "teal_soft": "#D9ECEE",
    "red": "#B43A50",
    "red_soft": "#F1DEE2",
    "purple": "#82698A",
    "gold": "#C38A2E",
    "green": "#3D8569",
}


def configure_style() -> None:
    findfont("Times New Roman", fallback_to_default=False)
    mpl.rcParams.update(
        {
            "font.family": "Times New Roman",
            "font.size": 10.5,
            "axes.titlesize": 12.5,
            "axes.labelsize": 10.5,
            "xtick.labelsize": 9.5,
            "ytick.labelsize": 9.5,
            "legend.fontsize": 9.0,
            "axes.linewidth": 1.0,
            "axes.edgecolor": PALETTE["line"],
            "text.color": PALETTE["ink"],
            "axes.labelcolor": PALETTE["ink"],
            "xtick.color": PALETTE["ink"],
            "ytick.color": PALETTE["ink"],
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "savefig.facecolor": "white",
            "figure.facecolor": "white",
        }
    )


def panel_frame(ax: plt.Axes, letter: str, title: str) -> None:
    ax.set_facecolor(PALETTE["panel"])
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_color(PALETTE["line"])
        spine.set_linewidth(1.0)
    ax.text(
        -0.075,
        1.055,
        letter,
        transform=ax.transAxes,
        fontsize=15,
        fontweight="bold",
        va="bottom",
        ha="left",
        clip_on=False,
    )
    ax.text(
        0.0,
        1.055,
        title,
        transform=ax.transAxes,
        fontsize=12.5,
        fontweight="bold",
        va="bottom",
        ha="left",
        clip_on=False,
    )


def container_panel(ax: plt.Axes, letter: str, title: str) -> None:
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xticks([])
    ax.set_yticks([])
    panel_frame(ax, letter, title)


def lag_axis(
    ax: plt.Axes,
    letter: str,
    title: str,
    ylim: tuple[float, float],
    yticks: list[int],
) -> None:
    panel_frame(ax, letter, title)
    ax.set_xlim(0, 100)
    ax.set_ylim(*ylim)
    ax.set_xticks([])
    ax.set_yticks(yticks)
    ax.set_ylabel("Relative lag, L(t)", labelpad=4)
    ax.axhline(0, color=PALETTE["muted"], linewidth=1.0, linestyle=(0, (3, 3)), zorder=1)
    ax.grid(axis="y", color=PALETTE["grid"], linewidth=0.7, zorder=0)
    ax.annotate(
        "",
        xy=(0.94, -0.15),
        xytext=(0.08, -0.15),
        xycoords="axes fraction",
        arrowprops={"arrowstyle": "-|>", "lw": 1.2, "color": PALETTE["line"]},
        annotation_clip=False,
    )
    ax.text(0.02, -0.245, "Older / pith", transform=ax.transAxes, ha="left", va="top")
    ax.text(0.98, -0.245, "Newer / bark", transform=ax.transAxes, ha="right", va="top")


def draw_step(
    ax: plt.Axes,
    xs: list[float],
    ys: list[float],
    color: str,
    label: str | None = None,
    linewidth: float = 2.5,
    linestyle: str = "-",
) -> None:
    ax.plot(
        xs,
        ys,
        color=color,
        linewidth=linewidth,
        linestyle=linestyle,
        solid_capstyle="butt",
        solid_joinstyle="miter",
        label=label,
        zorder=4,
    )


def draw_dictionary(ax: plt.Axes) -> None:
    container_panel(ax, "a", "Lag-state dictionary")
    ax.text(
        0.5,
        0.91,
        "ΔL = L(old) − L(new)",
        ha="center",
        va="center",
        fontsize=11.5,
        fontweight="bold",
    )
    rows = [
        ("Clean", "L = 0", [0.08, 0.39], [0.0, 0.0], PALETTE["line"]),
        ("Whole-series", "constant g < 0", [0.08, 0.39], [-0.10, -0.10], PALETTE["purple"]),
        ("Unit event", "|ΔL| = 1", [0.08, 0.23, 0.23, 0.39], [-0.06, -0.06, 0.06, 0.06], PALETTE["blue"]),
        ("Partial move", "ΔL ≤ −2", [0.08, 0.23, 0.23, 0.39], [-0.08, -0.08, 0.07, 0.07], PALETTE["teal"]),
        ("Cancelling pair", "baseline → pulse → baseline", [0.08, 0.17, 0.17, 0.30, 0.30, 0.39], [0.0, 0.0, 0.08, 0.08, 0.0, 0.0], PALETTE["gold"]),
    ]
    y_positions = [0.76, 0.62, 0.48, 0.34, 0.18]
    for (name, meaning, xs, offsets, color), y in zip(rows, y_positions, strict=True):
        ax.plot([0.06, 0.42], [y, y], color=PALETTE["grid"], linewidth=0.7, linestyle=(0, (2, 3)))
        ax.plot(xs, [y + value for value in offsets], color=color, linewidth=2.5, solid_joinstyle="miter")
        ax.text(0.48, y + 0.018, name, ha="left", va="center", fontsize=10.2, fontweight="bold")
        ax.text(0.48, y - 0.045, meaning, ha="left", va="center", fontsize=9.2, color=PALETTE["muted"])


def draw_whole_partial(ax: plt.Axes) -> None:
    lag_axis(ax, "b", "Whole-series vs partial displacement", (-3.8, 0.8), [-3, -2, -1, 0])
    ax.axvspan(0, 56, color=PALETTE["teal_soft"], alpha=0.52, zorder=0)
    draw_step(ax, [0, 100], [-2, -2], PALETTE["purple"], "Whole-series: constant −2")
    draw_step(ax, [0, 56, 56, 100], [-3, -3, 0, 0], PALETTE["teal"], "Partial: older block −3")
    ax.axvline(56, color=PALETTE["teal"], linewidth=1.0, linestyle=(0, (2, 2)), zorder=2)
    ax.text(28, -3.50, "moved older block", ha="center", va="center", fontsize=9.3, color=PALETTE["teal"])
    ax.text(78, 0.22, "fixed newer side", ha="center", va="bottom", fontsize=9.3, color=PALETTE["teal"])
    ax.legend(loc="lower right", frameon=False, handlelength=2.5, borderaxespad=0.45)


def draw_unit_events(ax: plt.Axes) -> None:
    lag_axis(ax, "c", "Missing ring vs false ring", (-1.75, 1.75), [-1, 0, 1])
    ax.axvline(52, color=PALETTE["muted"], linewidth=0.9, linestyle=(0, (2, 2)), zorder=2)
    draw_step(ax, [0, 52, 52, 100], [-1, -1, 0, 0], PALETTE["blue"], "Missing ring: ΔL = −1")
    draw_step(ax, [0, 52, 52, 100], [1, 1, 0, 0], PALETTE["red"], "False ring: ΔL = +1")
    ax.scatter([52, 52], [0, 0], s=30, color=[PALETTE["blue"], PALETTE["red"]], zorder=5)
    ax.text(13, -1.26, "INSERT", color=PALETTE["blue"], fontweight="bold", fontsize=9.5)
    ax.text(13, 1.25, "DELETE", color=PALETTE["red"], fontweight="bold", fontsize=9.5)
    ax.legend(loc="lower right", frameon=False, handlelength=2.5, borderaxespad=0.45)


def mini_lag_axis(ax: plt.Axes, title: str) -> None:
    ax.set_facecolor("white")
    ax.set_xlim(0, 100)
    ax.set_ylim(-3.5, 0.6)
    ax.set_xticks([])
    ax.set_yticks([-3, 0])
    ax.tick_params(length=3, pad=2)
    ax.axhline(0, color=PALETTE["muted"], linewidth=0.8, linestyle=(0, (3, 3)))
    ax.set_title(title, fontsize=10.2, fontweight="bold", pad=5)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(PALETTE["line"])
    ax.spines["bottom"].set_color(PALETTE["line"])


def draw_gap_competition(ax: plt.Axes) -> None:
    container_panel(ax, "d", "Continuous gap vs missing-ring staircase")
    left = ax.inset_axes([0.08, 0.20, 0.38, 0.62])
    right = ax.inset_axes([0.56, 0.20, 0.38, 0.62])
    mini_lag_axis(left, "One block move")
    mini_lag_axis(right, "Three unit edits")
    draw_step(left, [0, 55, 55, 100], [-3, -3, 0, 0], PALETTE["teal"])
    left.axvline(55, color=PALETTE["teal"], linewidth=0.8, linestyle=(0, (2, 2)))
    draw_step(
        right,
        [0, 28, 28, 48, 48, 68, 68, 100],
        [-3, -3, -2, -2, -1, -1, 0, 0],
        PALETTE["blue"],
    )
    for year in (28, 48, 68):
        right.axvline(year, color=PALETTE["blue"], linewidth=0.65, linestyle=(0, (2, 2)), alpha=0.8)
    ax.text(0.27, 0.10, "single ΔL = −3", ha="center", va="center", color=PALETTE["teal"], fontsize=9.4)
    ax.text(0.75, 0.10, "−1, −1, −1", ha="center", va="center", color=PALETTE["blue"], fontsize=9.4)


def draw_cancelling_pair(ax: plt.Axes) -> None:
    lag_axis(ax, "e", "Cancelling missing–false pair", (-0.65, 1.65), [0, 1])
    ax.axvspan(35, 68, color="#F4E7C9", alpha=0.75, zorder=0)
    draw_step(ax, [0, 35, 35, 68, 68, 100], [0, 0, 1, 1, 0, 0], PALETTE["gold"])
    for year, label, color in (
        (35, "Missing\nΔL = −1", PALETTE["blue"]),
        (68, "False\nΔL = +1", PALETTE["red"]),
    ):
        ax.axvline(year, color=color, linewidth=1.0, linestyle=(0, (2, 2)), zorder=2)
        ax.text(year, 1.20, label, color=color, ha="center", va="bottom", fontsize=9.2, fontweight="bold")
    ax.text(51.5, 0.72, "local lag pulse", ha="center", va="center", fontsize=10.0, color=PALETTE["gold"], fontweight="bold")
    ax.text(82, -0.25, "distal baseline restored", ha="center", va="center", fontsize=9.2, color=PALETTE["muted"])


def draw_consensus(ax: plt.Axes) -> None:
    container_panel(ax, "f", "Counterfactual and multi-reference consensus")
    curve_ax = ax.inset_axes([0.09, 0.52, 0.82, 0.32])
    years = np.arange(-12, 13)
    centers = [-1.0, 0.0, 0.6, 1.1, -0.4]
    widths = [3.0, 3.4, 2.9, 3.2, 3.5]
    curves = []
    for index, (center, width) in enumerate(zip(centers, widths, strict=True), start=1):
        curve = 0.03 + 0.16 * np.exp(-0.5 * ((years - center) / width) ** 2)
        curve += 0.006 * np.cos((years + index) * 0.75)
        curves.append(curve)
        curve_ax.plot(years, curve, color=PALETTE["blue"], linewidth=1.0, alpha=0.34)
    aggregate = np.mean(np.vstack(curves), axis=0)
    curve_ax.axvspan(-4, 4, color=PALETTE["blue_soft"], alpha=0.8, zorder=0)
    curve_ax.plot(years, aggregate, color=PALETTE["blue"], linewidth=2.5, zorder=4)
    curve_ax.axvline(0, color=PALETTE["line"], linewidth=0.9, linestyle=(0, (2, 2)))
    curve_ax.set_xlim(-12, 12)
    curve_ax.set_ylim(0.0, 0.23)
    curve_ax.set_xticks([-10, 0, 10], ["−10", "candidate year", "+10"])
    curve_ax.set_yticks([0.0, 0.1, 0.2])
    curve_ax.set_ylabel("Edit gain", labelpad=3)
    curve_ax.tick_params(length=3, pad=2)
    curve_ax.spines["top"].set_visible(False)
    curve_ax.spines["right"].set_visible(False)
    curve_ax.text(-11.2, 0.205, "5 source cores", fontsize=9.0, color=PALETTE["muted"], ha="left", va="top")
    curve_ax.text(3.7, 0.19, "9-year mode", fontsize=9.0, color=PALETTE["blue"], ha="right", va="top")

    bar_ax = ax.inset_axes([0.09, 0.16, 0.48, 0.24])
    labels = ["Insert", "Delete", "Move"]
    values = [0.18, 0.055, 0.095]
    colors = [PALETTE["blue"], PALETTE["red"], PALETTE["teal"]]
    positions = np.arange(3)
    bar_ax.barh(positions, values, color=colors, height=0.55)
    bar_ax.set_yticks(positions, labels)
    bar_ax.invert_yaxis()
    bar_ax.set_xlim(0, 0.21)
    bar_ax.set_xticks([0.0, 0.1, 0.2])
    bar_ax.tick_params(length=3, pad=2)
    bar_ax.spines["top"].set_visible(False)
    bar_ax.spines["right"].set_visible(False)
    for pos, value in zip(positions, values, strict=True):
        bar_ax.text(value + 0.005, pos, f"{value:.3f}", va="center", ha="left", fontsize=8.8)

    ax.add_patch(
        Rectangle(
            (0.64, 0.16),
            0.31,
            0.22,
            transform=ax.transAxes,
            facecolor=PALETTE["blue_soft"],
            edgecolor=PALETTE["blue"],
            linewidth=1.2,
            zorder=3,
        )
    )
    ax.text(0.795, 0.305, "Suggested operation", transform=ax.transAxes, ha="center", va="center", fontsize=9.2)
    ax.text(0.795, 0.235, "INSERT", transform=ax.transAxes, ha="center", va="center", fontsize=11.0, fontweight="bold", color=PALETTE["blue"])
    ax.text(0.795, 0.185, "focused review window", transform=ax.transAxes, ha="center", va="center", fontsize=8.6, color=PALETTE["muted"])
    ax.add_patch(
        FancyArrowPatch(
            (0.57, 0.29),
            (0.64, 0.27),
            transform=ax.transAxes,
            arrowstyle="-|>",
            mutation_scale=12,
            linewidth=1.3,
            color=PALETTE["line"],
            connectionstyle="arc3,rad=0.0",
            zorder=5,
        )
    )


def build_figure() -> plt.Figure:
    fig = plt.figure(figsize=(8.3, 11.2))
    grid = fig.add_gridspec(
        3,
        2,
        left=0.085,
        right=0.975,
        bottom=0.065,
        top=0.965,
        wspace=0.28,
        hspace=0.44,
    )
    axes = [fig.add_subplot(grid[row, col]) for row in range(3) for col in range(2)]
    draw_dictionary(axes[0])
    draw_whole_partial(axes[1])
    draw_unit_events(axes[2])
    draw_gap_competition(axes[3])
    draw_cancelling_pair(axes[4])
    draw_consensus(axes[5])
    return fig


def export_figure(fig: plt.Figure, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = output_dir / "fig07_lag_state_diagnostic_grammar"
    svg_path = stem.with_suffix(".svg")
    fig.savefig(svg_path, bbox_inches="tight")
    svg_text = svg_path.read_text(encoding="utf-8")
    svg_path.write_text(
        "\n".join(line.rstrip() for line in svg_text.splitlines()) + "\n",
        encoding="utf-8",
    )
    fig.savefig(stem.with_suffix(".pdf"), bbox_inches="tight")
    fig.savefig(stem.with_suffix(".png"), dpi=350, bbox_inches="tight")
    fig.savefig(
        stem.with_suffix(".tiff"),
        dpi=600,
        bbox_inches="tight",
        pil_kwargs={"compression": "tiff_lzw"},
    )


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=repo_root / "docs" / "figures" / "js-diagnosis-events-v1",
    )
    return parser.parse_args()


def main() -> None:
    configure_style()
    args = parse_args()
    figure = build_figure()
    export_figure(figure, args.output_dir)
    plt.close(figure)


if __name__ == "__main__":
    main()
