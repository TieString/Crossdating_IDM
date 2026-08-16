#!/usr/bin/env python3
"""Generate the JS diagnosis event architecture and validation figure set.

The plotting backend is intentionally Python/matplotlib only. Quantitative panels read the
checked-in frozen generalization result so a future result JSON can replace it without changing
the layout or manually copying percentages.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import textwrap
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.font_manager import FontProperties, findfont
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle


PALETTE = {
    "ink": "#24272B",
    "muted": "#626B73",
    "line": "#30343B",
    "grid": "#D6DADF",
    "paper": "#FFFFFF",
    "panel": "#F7F8F9",
    "teal": "#247F8D",
    "teal_dark": "#176674",
    "teal_soft": "#BFDDE4",
    "blue": "#3B78A8",
    "blue_dark": "#245A86",
    "blue_soft": "#A9C8DE",
    "red": "#B43A50",
    "red_soft": "#E8C9CC",
    "rose": "#D99AA6",
    "purple": "#8A6B8F",
    "purple_soft": "#D8C9DB",
    "gold": "#C68B2C",
    "gold_soft": "#EBD9AE",
    "green": "#3C8569",
    "green_soft": "#C8E0D5",
    "grey_soft": "#E8EAEC",
}

FAMILY_COLORS = {
    "A": PALETTE["blue"],
    "B": PALETTE["teal"],
    "C": PALETTE["red"],
    "D": PALETTE["purple"],
}

MEASUREMENT_STYLE = {
    "ring_width_or_unlabeled": ("Ring width / unlabeled", "o", PALETTE["blue"]),
    "density": ("Density", "s", PALETTE["red"]),
    "width_component": ("Early-/latewood width", "^", PALETTE["gold"]),
}


EVENT_DEFINITIONS_V2 = [
    {
        "event": "Clean match",
        "action": "Keep the series unchanged",
        "lag": "Stable 0\n(or a known global baseline)",
        "meaning": "Calendar alignment is retained across the measured series.",
        "recognition": "No persistent lag transition; edit counterfactuals provide no stable gain; reference cores agree on the baseline.",
        "color": PALETTE["grey_soft"],
    },
    {
        "event": "Missing ring",
        "action": "Insert one calendar year",
        "lag": "g − 1 → g",
        "meaning": "A locally absent or extremely narrow ring, often associated with suppressed cambial growth under drought, cold, fire or insect stress.",
        "recognition": "A unit negative step, a superior insert-year counterfactual and concordant gains against the master and independent cores.",
        "color": PALETTE["blue_soft"],
    },
    {
        "event": "False ring",
        "action": "Delete one calendar year",
        "lag": "g + 1 → g",
        "meaning": "An intra-annual density fluctuation or false boundary, including a ring divided twice during measurement.",
        "recognition": "A unit positive step, a superior delete-year counterfactual, residual support and consistent transition direction across references.",
        "color": PALETTE["red_soft"],
    },
    {
        "event": "Partial shift",
        "action": "Move the older block by −q years",
        "lag": "g − q → g\nq ≥ 2",
        "meaning": "Localized decay, fracture, segment loss or a within-core measurement splice that displaces only part of the series.",
        "recognition": "One large local transition, a dominant range-shift counterfactual and agreement on the fixed-side breakpoint.",
        "color": PALETTE["teal_soft"],
    },
    {
        "event": "Whole-series shift",
        "action": "Move the complete series by g years",
        "lag": "Constant global g",
        "meaning": "A negative shift is consistent with tree death, missing bark or sapwood, or a bark-side break that removed outer years.",
        "recognition": "Global sliding match, a constant lag path, terminal-side evidence and a whole-series counterfactual converge on the same g.",
        "color": PALETTE["purple_soft"],
    },
    {
        "event": "Event staircase",
        "action": "Apply sequential unit edits",
        "lag": "−n … −1 → 0\n(or the positive mirror)",
        "meaning": "Several missing or false rings distributed through the series rather than one continuous displaced block.",
        "recognition": "Multiple intermediate lag plateaus, repeated unit counterfactual gains and stepwise recovery after each confirmed edit.",
        "color": "#D7E6F1",
    },
    {
        "event": "Adjacent paired events",
        "action": "Resolve two local unit events",
        "lag": "Short pulse;\ndistal baseline restored",
        "meaning": "Nearby missing and false rings can cancel in long windows while retaining a distinct local disturbance signature.",
        "recognition": "Opposite local transitions, paired before/after evidence and matching votes on both sides of the short event interval.",
        "color": PALETTE["gold_soft"],
    },
]


EVENT_DEFINITIONS = [
    {
        "event": "干净对照\nClean",
        "lag": "稳定 0\n（或已知全局基线）",
        "edit": "不编辑",
        "meaning": "序列与参考年表一致；不等于生态上没有胁迫。",
        "detect": "无持续 lag 转换；候选编辑缺少稳定增益；多参考芯不支持可执行事件。",
        "limit": "参考结构弱时仍可能误报；既有留出为 1/23。",
        "color": PALETTE["grey_soft"],
    },
    {
        "event": "缺轮\nmissingRing",
        "lag": "g−1 → g\n基线 0 时：−1 → 0",
        "edit": "插入 1 个年份；\n所选年及较老侧平移 1 年",
        "meaning": "可能是局部缺失/极窄而漏测的年轮；可由干旱、低温、火、虫害等抑制形成层活动，但生态归因需解剖与站点证据。",
        "detect": "受约束分段 lag 阶跃 + 虚拟插年反事实 + master/逐参考芯增益共识；共享 0 只能重排，不能凭空生成事件。",
        "limit": "窗口覆盖不等于精确年份；相邻多缺轮可与连续缺段等价。",
        "color": PALETTE["blue_soft"],
    },
    {
        "event": "伪轮\nfalseRing",
        "lag": "g+1 → g\n基线 0 时：+1 → 0",
        "edit": "删除 1 个年份；\n较老侧回移 1 年",
        "meaning": "可能是年内密度波动/假界线（干旱后复湿、异常温度或扰动），也可能是人工多分了一轮。",
        "detect": "受约束正向阶跃 + 虚拟删年反事实 + 差分/残差峰 + 多参考芯方向一致；不允许正向 partialMove 替代。",
        "limit": "仅凭环宽不能确定形成机制；需观察木材解剖边界。",
        "color": PALETTE["red_soft"],
    },
    {
        "event": "局部移动\npartialMove −q",
        "lag": "g−q → g\nq = 2…100",
        "edit": "固定 firstFixedYear 及较新侧；\n仅将较老块平移 −q 年",
        "meaning": "可解释为样芯内部腐朽、断裂、缺段，或拼接/测量段错位；也可能汇总多个不可分辨的缺失年份，并非单一生态事件。",
        "detect": "精确多年份 lag 跳变 + year×operation 网格 + 局部/全段反事实 + 边界多视图共识；−1 保留给缺轮。",
        "limit": "若看不到中间平台，连续缺段与多个缺轮可能不可辨识。",
        "color": PALETTE["teal_soft"],
    },
    {
        "event": "整体移动\nwholeSeriesMove g",
        "lag": "全序列近似恒定 g\n无局部回到 0 的断点",
        "edit": "整条序列平移 g 年",
        "meaning": "负向 g 可对应采样前死亡、树皮/边材缺失或树皮侧断裂而丢失末端年份；也可能只是起止年/元数据错误。",
        "detect": "global sliding + COFECHA 终端/较新固定侧基线 + 全段前后 hard gate；局部事件不能冒充全局基线。",
        "limit": "算法识别的是日历偏移，不能单凭 lag 判定死亡或树皮缺失。",
        "color": PALETTE["purple_soft"],
    },
    {
        "event": "单位事件阶梯\n多缺轮/多伪轮",
        "lag": "−n…−1→0\n或 +n…+1→0",
        "edit": "只输出最新未解决事件；\n应用后重新诊断下一事件",
        "meaning": "可能是多次局地生长异常，也可能是多处识别/测量错误；每个年份仍需独立核验。",
        "detect": "完整 bounded lag path、多个中间平台、独立参考芯阶梯与逐轮反事实；累计位移 N 本身不足以一次插入 N 个 0。",
        "limit": "事件太近或中间区段太短时，可能只剩累计 lag 解释。",
        "color": "#D7E6F1",
    },
    {
        "event": "近邻抵消/解释歧义\nmissing+false 或\n阶梯 / partial 等价",
        "lag": "远端同基线；\n局部出现短脉冲或等价累计位移",
        "edit": "受约束解释切换、逐轮单事件，\n或证据不足时拒答",
        "meaning": "真实生长异常与样品破损/测量错位可能产生相同日历结果；此处不应强作生态归因。",
        "detect": "局部两侧证据、联合反事实、参考分票、终端固定侧基线与 typed evidence ledger 共同裁决。",
        "limit": "既有 C 压力集中 73/96 个错误步骤满足累计 lag 等价；严格分数未改记成功。",
        "color": PALETTE["gold_soft"],
    },
]


@dataclass(frozen=True)
class FigureContract:
    conclusion: str
    archetype: str
    target: str
    backend: str
    final_size: str
    reviewer_risk: str


CONTRACT = FigureContract(
    conclusion=(
        "Constrained lag topology, executable counterfactuals and multi-core evidence resolve one "
        "traceable event operation, shift and focused review window."
    ),
    archetype="schematic-led composite + quantitative grid",
    target="research manuscript, project report and presentation; editable English vector figures",
    backend="Python / matplotlib",
    final_size=(
        "8.5 × 10.2 in（架构竖版），12.5 × 8.6 in（判别），10.8 × 8.4 in（统计），13 × 9.4 in（表），"
        "11.2 × 8.4 in（验证设计）"
    ),
    reviewer_risk=(
        "Keep metric denominators explicit and preserve the distinction between lag recognition, "
        "operation recovery and review-window localization."
    ),
)


def configure_style() -> FontProperties:
    candidates = ["Times New Roman", "Nimbus Roman", "Liberation Serif", "DejaVu Serif"]
    selected = "DejaVu Serif"
    for candidate in candidates:
        try:
            resolved = findfont(FontProperties(family=candidate), fallback_to_default=False)
        except ValueError:
            continue
        if resolved:
            selected = candidate
            break
    mpl.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": [selected, "Times New Roman", "DejaVu Serif"],
            "mathtext.fontset": "stix",
            "axes.unicode_minus": False,
            "svg.fonttype": "none",
            "svg.hashsalt": "js-diagnosis-events-v1",
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "font.size": 8.5,
            "axes.titlesize": 10,
            "axes.labelsize": 8.5,
            "xtick.labelsize": 7.5,
            "ytick.labelsize": 7.5,
            "axes.linewidth": 0.8,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "legend.frameon": False,
            "figure.facecolor": PALETTE["paper"],
            "axes.facecolor": PALETTE["paper"],
        }
    )
    return FontProperties(family=selected)


def wrap_text(text: str, width: int) -> str:
    paragraphs = text.split("\n")
    return "\n".join(
        "\n".join(
            textwrap.wrap(
                paragraph,
                width=max(1, width),
                break_long_words=True,
                break_on_hyphens=False,
                replace_whitespace=False,
            )
        )
        if paragraph
        else ""
        for paragraph in paragraphs
    )


def wrap_display_text(text: str, max_units: float) -> str:
    """Wrap mixed Chinese/Latin text by approximate rendered width, not code-point count."""

    lines: list[str] = []
    current: list[str] = []
    current_width = 0.0
    for character in text:
        if character == "\n":
            lines.append("".join(current).rstrip())
            current = []
            current_width = 0.0
            continue
        if unicodedata.east_asian_width(character) in {"W", "F"}:
            width = 1.0
        elif character.isspace():
            width = 0.34
        elif character.isupper():
            width = 0.68
        else:
            width = 0.56
        if current and current_width + width > max_units:
            lines.append("".join(current).rstrip())
            current = []
            current_width = 0.0
        current.append(character)
        current_width += width
    if current or not lines:
        lines.append("".join(current).rstrip())
    return "\n".join(lines)


def panel_label(ax: mpl.axes.Axes, label: str, x: float = -0.08, y: float = 1.05) -> None:
    ax.text(
        x,
        y,
        label,
        transform=ax.transAxes,
        fontsize=11,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )


def style_axis(ax: mpl.axes.Axes, grid_axis: str | None = None) -> None:
    ax.spines["left"].set_color(PALETTE["line"])
    ax.spines["bottom"].set_color(PALETTE["line"])
    ax.tick_params(colors=PALETTE["ink"], width=0.7, length=3)
    if grid_axis:
        ax.grid(axis=grid_axis, color=PALETTE["grid"], linewidth=0.6, alpha=0.65)
        ax.set_axisbelow(True)


def save_figure(fig: mpl.figure.Figure, output_base: Path, png_dpi: int = 350) -> list[str]:
    output_base.parent.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    metadata = {"Creator": "Python/matplotlib", "Title": output_base.name}
    for suffix, kwargs in (
        (".svg", {"metadata": {"Creator": "Python/matplotlib", "Date": None}}),
        (".pdf", {"metadata": metadata}),
        (".png", {"dpi": png_dpi}),
        (".tiff", {"dpi": 600, "pil_kwargs": {"compression": "tiff_lzw"}}),
    ):
        path = output_base.with_suffix(suffix)
        fig.savefig(path, bbox_inches="tight", facecolor="white", **kwargs)
        outputs.append(path.name)
    return outputs


def draw_box(
    ax: mpl.axes.Axes,
    xywh: tuple[float, float, float, float],
    title: str,
    body: str,
    *,
    face: str = "white",
    title_face: str | None = None,
    edge: str = PALETTE["line"],
    title_color: str = PALETTE["ink"],
    body_color: str = PALETTE["ink"],
    title_size: float = 9.2,
    body_size: float = 7.5,
    wrap: int = 28,
    rounded: float = 0.012,
    linewidth: float = 1.0,
) -> None:
    x, y, w, h = xywh
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle=f"round,pad=0.004,rounding_size={rounded}",
        transform=ax.transAxes,
        facecolor=face,
        edgecolor=edge,
        linewidth=linewidth,
        zorder=2,
    )
    ax.add_patch(patch)
    title_h = min(0.038, h * 0.28)
    if title_face:
        ax.add_patch(
            Rectangle(
                (x, y + h - title_h),
                w,
                title_h,
                transform=ax.transAxes,
                facecolor=title_face,
                edgecolor="none",
                zorder=3,
            )
        )
    ax.text(
        x + w / 2,
        y + h - title_h / 2,
        title,
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=title_size,
        fontweight="bold",
        color=title_color,
        zorder=4,
    )
    ax.text(
        x + 0.012,
        y + h - title_h - 0.010,
        wrap_text(body, wrap),
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=body_size,
        color=body_color,
        linespacing=1.35,
        zorder=4,
    )


def draw_step_header(ax: mpl.axes.Axes, y: float, text: str) -> None:
    ax.add_patch(
        Rectangle(
            (0.02, y),
            0.96,
            0.037,
            transform=ax.transAxes,
            facecolor=PALETTE["teal"],
            edgecolor=PALETTE["line"],
            linewidth=1.0,
            zorder=1,
        )
    )
    ax.text(
        0.032,
        y + 0.0185,
        text,
        transform=ax.transAxes,
        ha="left",
        va="center",
        fontsize=10.3,
        color="white",
        fontweight="bold",
    )


def arrow(
    ax: mpl.axes.Axes,
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    color: str = PALETTE["line"],
    linewidth: float = 1.2,
    connectionstyle: str = "arc3,rad=0",
    mutation_scale: float = 9.5,
) -> None:
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            transform=ax.transAxes,
            arrowstyle="-|>,head_length=0.42,head_width=0.28",
            mutation_scale=mutation_scale,
            linewidth=linewidth,
            color=color,
            connectionstyle=connectionstyle,
            shrinkA=0,
            shrinkB=0,
            capstyle="butt",
            joinstyle="miter",
            zorder=5,
        )
    )


def create_architecture_figure(result: dict[str, Any]) -> mpl.figure.Figure:
    del result  # The architecture is code-derived and does not display benchmark values.
    fig, ax = plt.subplots(figsize=(8.5, 10.2))
    ax.set_axis_off()
    font_family = "Times New Roman"
    border_width = 0.9
    arrow_width = 1.0
    title_strip_height = 0.024

    def add_text(x: float, y: float, text: str, **kwargs: Any) -> None:
        ax.text(x, y, text, transform=ax.transAxes, fontfamily=font_family, **kwargs)

    def section_header(y: float, text: str) -> None:
        ax.add_patch(
            Rectangle(
                (0.03, y),
                0.94,
                0.035,
                transform=ax.transAxes,
                facecolor=PALETTE["teal"],
                edgecolor=PALETTE["line"],
                linewidth=border_width,
                zorder=2,
            )
        )
        add_text(
            0.042,
            y + 0.0175,
            text,
            ha="left",
            va="center",
            fontsize=10.5,
            color="white",
            fontweight="bold",
            zorder=3,
        )

    def rect_box(
        xywh: tuple[float, float, float, float],
        title: str,
        body: str,
        *,
        title_face: str,
        face: str = "white",
        title_size: float = 9.2,
        body_size: float = 7.0,
        wrap: int = 36,
        body_align: str = "left",
    ) -> None:
        x, y, width, height = xywh
        ax.add_patch(
            Rectangle(
                (x, y),
                width,
                height,
                transform=ax.transAxes,
                facecolor=face,
                edgecolor=PALETTE["line"],
                linewidth=border_width,
                zorder=2,
            )
        )
        ax.add_patch(
            Rectangle(
                (x, y + height - title_strip_height),
                width,
                title_strip_height,
                transform=ax.transAxes,
                facecolor=title_face,
                edgecolor="none",
                zorder=3,
            )
        )
        add_text(
            x + width / 2,
            y + height - title_strip_height / 2,
            title,
            ha="center",
            va="center",
            fontsize=title_size,
            color=PALETTE["ink"],
            fontweight="bold",
            zorder=4,
        )
        body_text = wrap_text(body, wrap)
        body_padding = min(0.009, height * 0.10)
        add_text(
            x + (0.012 if body_align == "left" else width / 2),
            y + height - title_strip_height - body_padding,
            body_text,
            ha=body_align,
            va="top",
            fontsize=body_size,
            color=PALETTE["ink"],
            linespacing=1.20,
            zorder=4,
        )

    def flow_arrow(
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        color: str = PALETTE["line"],
        linewidth: float = 1.05,
        head_scale: float = 10.0,
    ) -> None:
        """Draw a compact arrow with a visible shaft even across short gaps."""

        ax.add_patch(
            FancyArrowPatch(
                start,
                end,
                transform=ax.transAxes,
                arrowstyle="-|>,head_length=0.42,head_width=0.28",
                mutation_scale=head_scale,
                linewidth=linewidth,
                color=color,
                shrinkA=0,
                shrinkB=0,
                connectionstyle="arc3,rad=0",
                capstyle="butt",
                joinstyle="miter",
                zorder=5,
            )
        )

    add_text(
        0.04,
        0.986,
        "JS Crossdating Event Diagnosis Workflow",
        ha="left",
        va="top",
        fontsize=18.0,
        fontweight="bold",
        color=PALETTE["ink"],
    )
    add_text(
        0.04,
        0.950,
        "From format-preserving RWL data to one traceable event edit",
        ha="left",
        va="top",
        fontsize=10.0,
        color=PALETTE["muted"],
    )

    # Step 1 mirrors the reference figure's portrait two-column composition.
    section_header(0.890, "STEP 1   DATA STATE AND REFERENCE CHRONOLOGY")
    top_x = [0.05, 0.53]
    top_width = 0.42
    top_y = 0.715
    top_height = 0.160
    top_boxes = [
        (
            "Transparent RWL state",
            "• Tucson short/long formats\n• Raw baseline + working series\n• Format-preserving read and write\n• Target + same-site reference cores\n• Year, zero and edit provenance",
        ),
        (
            "Reference chronology & side evidence",
            "• Manual calendar-year chronology\n• COFECHA-pass anchor master\n• Spline detrending + AR prewhitening\n• Leave-target-out reference\n• PART 6 segment evidence\n• Independent-core support",
        ),
    ]
    for x, (title, body) in zip(top_x, top_boxes):
        rect_box(
            (x, top_y, top_width, top_height),
            title,
            body,
            title_face=PALETTE["teal_soft"],
            face="#F9FBFC",
            title_size=10.4,
            body_size=8.2,
            wrap=43,
        )
    flow_arrow(
        (top_x[0] + top_width, top_y + top_height / 2),
        (top_x[1], top_y + top_height / 2),
        linewidth=arrow_width,
    )

    section_header(0.665, "STEP 2   CONSTRAINED EVENT EVIDENCE")
    evidence_x = [0.05, 0.36, 0.67]
    evidence_width = 0.28
    evidence_y = 0.480
    evidence_height = 0.165
    evidence_boxes = [
        (
            "Lag topology",
            "• Global sliding match\n• COFECHA-like segment correlation\n• Constrained integer-lag Viterbi path\n• Direction, magnitude and plateaus\n• Review windows: 5/7/9/13 years",
            PALETTE["blue_soft"],
        ),
        (
            "Executable counterfactuals",
            "• Virtual insert and delete\n• Partial shifts: −2 to −100 years\n• Whole-series shift grid\n• Before/after correlations and residuals\n• Executable operations only",
            PALETTE["red_soft"],
        ),
        (
            "Multi-core evidence ledger",
            "• Master + independent-core votes\n• Vote count, margin and concentration\n• Terminal/fixed-side baseline\n• Presence, operation and location types\n• Provenance ≠ evidence weight",
            PALETTE["purple_soft"],
        ),
    ]
    for x, (title, body, color) in zip(evidence_x, evidence_boxes):
        rect_box(
            (x, evidence_y, evidence_width, evidence_height),
            title,
            body,
            title_face=color,
            title_size=9.4,
            body_size=7.5,
            wrap=34,
        )
    for center in (top_x[0] + top_width / 2, top_x[1] + top_width / 2):
        flow_arrow((center, top_y), (center, 0.700), linewidth=arrow_width, head_scale=8.0)
    for x in evidence_x:
        center = x + evidence_width / 2
        flow_arrow((center, 0.665), (center, evidence_y + evidence_height), linewidth=0.9, head_scale=8.5)

    event_x = [0.05, 0.285, 0.520, 0.755]
    event_width = 0.195
    event_y = 0.412
    event_height = 0.045
    event_specs = [
        ("Missing ring", "g − 1 → g", PALETTE["blue_soft"]),
        ("False ring", "g + 1 → g", PALETTE["red_soft"]),
        ("Partial shift", "g − q → g; q ≥ 2", PALETTE["teal_soft"]),
        ("Whole-series shift", "constant global g", PALETTE["purple_soft"]),
    ]
    event_centers: list[float] = []
    for x, (title, signature, color) in zip(event_x, event_specs):
        event_centers.append(x + event_width / 2)
        ax.add_patch(
            Rectangle(
                (x, event_y),
                event_width,
                event_height,
                transform=ax.transAxes,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=border_width,
                zorder=3,
            )
        )
        add_text(x + event_width / 2, event_y + 0.030, title, ha="center", va="center", fontsize=9.2, fontweight="bold", zorder=4)
        add_text(x + event_width / 2, event_y + 0.011, signature, ha="center", va="center", fontsize=7.3, color=PALETTE["ink"], zorder=4)
    bus_y = 0.475
    source_centers = [x + evidence_width / 2 for x in evidence_x]
    ax.plot([event_centers[0], event_centers[-1]], [bus_y, bus_y], transform=ax.transAxes, color=PALETTE["line"], linewidth=arrow_width, zorder=1)
    for center in source_centers:
        ax.plot([center, center], [evidence_y, bus_y], transform=ax.transAxes, color=PALETTE["line"], linewidth=arrow_width, zorder=1)
    for center in event_centers:
        flow_arrow((center, bus_y), (center, event_y + event_height), linewidth=0.85, head_scale=8.0)

    section_header(0.365, "STEP 3   JOINT ADJUDICATION: OPERATION × SHIFT × LOCATION")
    adjudication_width = 0.42
    adjudication_height = 0.058
    adjudication_boxes = [
        (0.05, 0.292, "Linked hypothesis", "Operation, lag path and evidence remain connected.", PALETTE["teal_soft"]),
        (0.53, 0.292, "Joint adjudication", "Fuse topology, counterfactuals and core votes.", PALETTE["teal_soft"]),
        (0.53, 0.215, "Precise resolution", "Resolve operation, shift and event location.", PALETTE["teal_soft"]),
        (0.05, 0.215, "Single product output", "One executable edit + one focused review window.", PALETTE["green_soft"]),
    ]
    for x, y, title, body, color in adjudication_boxes:
        rect_box(
            (x, y, adjudication_width, adjudication_height),
            title,
            body,
            title_face=color,
            face="#FCFCFC",
            title_size=9.5,
            body_size=7.5,
            wrap=52,
        )
    flow_arrow((0.05 + adjudication_width, 0.321), (0.53, 0.321), linewidth=arrow_width)
    flow_arrow(
        (0.53 + adjudication_width / 2, 0.292),
        (0.53 + adjudication_width / 2, 0.273),
        linewidth=arrow_width,
        head_scale=8.0,
    )
    flow_arrow((0.53, 0.244), (0.05 + adjudication_width, 0.244), linewidth=arrow_width)
    for center in event_centers:
        flow_arrow((center, event_y), (center, 0.400), linewidth=0.85, head_scale=7.5)
    flow_arrow((0.05 + adjudication_width / 2, 0.365), (0.05 + adjudication_width / 2, 0.350), linewidth=0.9, head_scale=8.0)
    flow_arrow((0.05 + adjudication_width / 2, 0.215), (0.05 + adjudication_width / 2, 0.205), linewidth=0.9, head_scale=7.0)

    section_header(0.170, "STEP 4   REVIEW, CONTROLLED COMMIT AND REDIAGNOSIS")
    review_width = 0.28
    review_height = 0.045
    review_boxes = [
        (0.05, 0.115, "Graph review", "Inspect window and evidence", PALETTE["teal_soft"]),
        (0.36, 0.115, "Edit preview", "Select year or firstFixedYear", PALETTE["teal_soft"]),
        (0.67, 0.115, "Confirm once", "Apply one focused event", PALETTE["gold_soft"]),
        (0.67, 0.050, "RwlEditor commit", "Undo stack + operation log", PALETTE["teal_soft"]),
        (0.36, 0.050, "Refresh diagnosis", "Rebuild on current working state", PALETTE["teal_soft"]),
    ]
    for x, y, title, body, color in review_boxes:
        rect_box(
            (x, y, review_width, review_height),
            title,
            body,
            title_face=color,
            title_size=8.8,
            body_size=7.2,
            wrap=35,
        )
    flow_arrow((0.05 + review_width, 0.1375), (0.36, 0.1375), linewidth=arrow_width)
    flow_arrow((0.36 + review_width, 0.1375), (0.67, 0.1375), linewidth=arrow_width)
    flow_arrow(
        (0.67 + review_width / 2, 0.115),
        (0.67 + review_width / 2, 0.095),
        linewidth=arrow_width,
        head_scale=8.0,
    )
    flow_arrow((0.67, 0.0725), (0.36 + review_width, 0.0725), linewidth=arrow_width)
    flow_arrow((0.05 + review_width / 2, 0.170), (0.05 + review_width / 2, 0.160), linewidth=0.9, head_scale=7.0)

    # Route the feedback loop outside the content area and enter the RWL state box
    # horizontally, so the final arrow always has a visible shaft.
    loop_entry_y = 0.800
    ax.plot(
        [0.36, 0.025, 0.025],
        [0.0725, 0.0725, loop_entry_y],
        transform=ax.transAxes,
        color=PALETTE["teal_dark"],
        linewidth=1.15,
        zorder=1,
        clip_on=False,
    )
    flow_arrow(
        (0.025, loop_entry_y),
        (top_x[0], loop_entry_y),
        color=PALETTE["teal_dark"],
        linewidth=1.15,
        head_scale=8.5,
    )
    add_text(
        0.016,
        0.390,
        "updated working state",
        ha="right",
        va="center",
        rotation=90,
        fontsize=7.4,
        color=PALETTE["teal_dark"],
        clip_on=False,
    )
    benefit_labels = ["FORMAT-PRESERVING", "COUNTERFACTUAL", "MULTI-CORE", "FULLY AUDITABLE"]
    benefit_colors = [PALETTE["blue_soft"], PALETTE["red_soft"], PALETTE["teal_soft"], PALETTE["green_soft"]]
    benefit_width = 0.225
    for index, (label, color) in enumerate(zip(benefit_labels, benefit_colors)):
        x0 = 0.05 + index * benefit_width
        ax.add_patch(
            Rectangle(
                (x0, 0.010),
                benefit_width,
                0.026,
                transform=ax.transAxes,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.65,
                zorder=2,
            )
        )
        add_text(
            x0 + benefit_width / 2,
            0.023,
            label,
            ha="center",
            va="center",
            fontsize=7.6,
            fontweight="bold",
            color=PALETTE["ink"],
            zorder=3,
        )
    return fig


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total <= 0:
        return (math.nan, math.nan)
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


def get_family_metrics(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for family in ("A", "B", "C", "D"):
        run = "AB" if family in {"A", "B"} else "CD"
        metric = result["runs"][run]["official"]["byFamily"][family]
        bootstrap = result["fileClusterBootstrap"][family]
        rows.append(
            {
                "family": family,
                "truth_events": metric["truthEvents"],
                "strict_recovery": metric["truthRecoveryRate"],
                "response": metric["responseRateAtAttemptedFrontier"],
                "operation_accuracy": metric["primaryOperationAccuracy"],
                "main_window": metric["primaryWindowCoverage"],
                "conditional_window": metric["conditionalLocalWindowCoverage"],
                "top1": metric["top1"],
                "ci_low": bootstrap["ci95"][0],
                "ci_high": bootstrap["ci95"][1],
                "files": bootstrap["files"],
            }
        )
    return rows


def get_single_event_metrics(result: dict[str, Any]) -> list[dict[str, Any]]:
    by_scenario = result["runs"]["AB"]["official"]["byScenario"]
    specs = [
        ("Missing ring", "A1-single-missing"),
        ("False ring", "A2-single-false"),
        ("Partial shift", "A3-single-partial"),
        ("Whole-series shift", "A4-single-whole"),
    ]
    rows: list[dict[str, Any]] = []
    for label, scenario_id in specs:
        metric = by_scenario[scenario_id]
        n = metric["truthEvents"]
        recovered = metric["recoveredTruthEvents"]
        response_successes = round(metric["responseRateAtAttemptedFrontier"] * n)
        rows.append(
            {
                "label": label,
                "scenario": scenario_id,
                "n": n,
                "recovered": recovered,
                "strict_recovery": metric["truthRecoveryRate"],
                "response": metric["responseRateAtAttemptedFrontier"],
                "top1": metric["top1"],
                "strict_ci": wilson_interval(recovered, n),
                "response_ci": wilson_interval(response_successes, n),
            }
        )
    return rows


def create_performance_figure(result: dict[str, Any]) -> mpl.figure.Figure:
    families = get_family_metrics(result)
    singles = get_single_event_metrics(result)
    per_file = result["perFile"]

    fig = plt.figure(figsize=(10.8, 8.4))
    gs = fig.add_gridspec(
        3,
        2,
        height_ratios=[1.0, 1.0, 0.20],
        hspace=0.43,
        wspace=0.34,
        left=0.075,
        right=0.975,
        top=0.885,
        bottom=0.075,
    )
    ax_a = fig.add_subplot(gs[0, 0])
    ax_b = fig.add_subplot(gs[0, 1])
    ax_c = fig.add_subplot(gs[1, 0])
    ax_d = fig.add_subplot(gs[1, 1])
    ax_e = fig.add_subplot(gs[2, :])

    fig.text(
        0.055,
        0.965,
        "JS 定年建议模块：既有冻结跨文件留出性能",
        fontsize=16,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )
    fig.text(
        0.055,
        0.928,
        (
            f"{result['population']['includedFiles']} 个未见 RWL 文件；A/B 644 个真值，C/D 690 个真值；"
            "文件聚类 bootstrap 10,000 次。结果冻结于 2026-08-13，不是当前代码的新盲测。"
        ),
        fontsize=8.7,
        ha="left",
        va="top",
        color=PALETTE["muted"],
    )

    # a: family strict recovery with clustered bootstrap confidence intervals.
    x = np.arange(4)
    values = np.array([row["strict_recovery"] for row in families])
    lower = values - np.array([row["ci_low"] for row in families])
    upper = np.array([row["ci_high"] for row in families]) - values
    bars = ax_a.bar(
        x,
        values,
        width=0.62,
        color=[FAMILY_COLORS[row["family"]] for row in families],
        alpha=0.88,
        edgecolor=PALETTE["line"],
        linewidth=0.8,
        zorder=3,
    )
    ax_a.errorbar(
        x,
        values,
        yerr=np.vstack([lower, upper]),
        fmt="none",
        ecolor=PALETTE["line"],
        elinewidth=1.1,
        capsize=4,
        capthick=1.1,
        zorder=5,
    )
    ax_a.axhline(0.90, color=PALETTE["red"], linestyle="--", linewidth=1.0, alpha=0.8)
    ax_a.text(3.47, 0.905, "预设 90%", color=PALETTE["red"], fontsize=7.3, ha="right", va="bottom")
    for bar, row in zip(bars, families):
        ax_a.text(
            bar.get_x() + bar.get_width() / 2,
            row["strict_recovery"] + 0.025,
            f"{row['strict_recovery'] * 100:.1f}%",
            ha="center",
            va="bottom",
            fontsize=8.2,
            fontweight="bold",
            color=PALETTE["ink"],
        )
        ax_a.text(
            bar.get_x() + bar.get_width() / 2,
            0.045,
            f"n={row['truth_events']}",
            ha="center",
            va="bottom",
            fontsize=6.8,
            color="white" if row["strict_recovery"] > 0.45 else PALETTE["ink"],
        )
    ax_a.set_xticks(x, ["A\n单事件", "B\n远距双事件", "C\n近邻压力", "D\n三类混合"])
    ax_a.set_ylim(0, 1.06)
    ax_a.set_ylabel("严格恢复率")
    ax_a.set_title("复杂度升高时，严格恢复率明显下降", loc="left", pad=8, fontweight="bold")
    style_axis(ax_a, "y")
    panel_label(ax_a, "a")

    # b: metric heatmap.
    metric_rows = [
        ("响应率", "response"),
        ("全前沿操作正确", "operation_accuracy"),
        ("主窗口覆盖", "main_window"),
        ("操作正确时窗口覆盖", "conditional_window"),
        ("精确 Top1", "top1"),
    ]
    heat = np.array(
        [
            [row[key] if row[key] is not None else np.nan for row in families]
            for _, key in metric_rows
        ]
    )
    cmap = LinearSegmentedColormap.from_list(
        "teal_paper",
        ["#F6F6F5", "#D8E7EA", "#8CBBC7", PALETTE["teal_dark"]],
    )
    im = ax_b.imshow(heat, vmin=0, vmax=1, cmap=cmap, aspect="auto")
    ax_b.set_xticks(np.arange(4), ["A", "B", "C", "D"])
    ax_b.set_yticks(np.arange(len(metric_rows)), [name for name, _ in metric_rows])
    ax_b.tick_params(length=0)
    for row_index in range(heat.shape[0]):
        for column_index in range(heat.shape[1]):
            value = heat[row_index, column_index]
            text_color = "white" if value >= 0.70 else PALETTE["ink"]
            ax_b.text(
                column_index,
                row_index,
                "—" if np.isnan(value) else f"{value * 100:.1f}",
                ha="center",
                va="center",
                fontsize=8.0,
                color=text_color,
                fontweight="bold" if row_index in {0, 2, 4} else "normal",
            )
    ax_b.set_title("高响应不等于严格恢复；Top1 是最弱环节", loc="left", pad=8, fontweight="bold")
    for spine in ax_b.spines.values():
        spine.set_visible(False)
    cbar = fig.colorbar(im, ax=ax_b, fraction=0.046, pad=0.03)
    cbar.set_label("比例")
    cbar.ax.tick_params(labelsize=6.8)
    panel_label(ax_b, "b")

    # c: single-event Wilson intervals.
    y = np.arange(len(singles))[::-1]
    strict = np.array([row["strict_recovery"] for row in singles])
    response = np.array([row["response"] for row in singles])
    strict_lo = strict - np.array([row["strict_ci"][0] for row in singles])
    strict_hi = np.array([row["strict_ci"][1] for row in singles]) - strict
    response_lo = response - np.array([row["response_ci"][0] for row in singles])
    response_hi = np.array([row["response_ci"][1] for row in singles]) - response
    ax_c.errorbar(
        strict,
        y + 0.11,
        xerr=np.vstack([strict_lo, strict_hi]),
        fmt="o",
        markersize=6,
        color=PALETTE["blue_dark"],
        ecolor=PALETTE["blue_soft"],
        elinewidth=2.2,
        capsize=3,
        label="严格恢复（Wilson 95% CI）",
        zorder=4,
    )
    ax_c.errorbar(
        response,
        y - 0.11,
        xerr=np.vstack([response_lo, response_hi]),
        fmt="s",
        markersize=5.5,
        color=PALETTE["red"],
        ecolor=PALETTE["red_soft"],
        elinewidth=2.2,
        capsize=3,
        label="响应率（Wilson 95% CI）",
        zorder=3,
    )
    ax_c.axvline(0.90, color=PALETTE["red"], linestyle="--", linewidth=0.9, alpha=0.75)
    for yi, row in zip(y, singles):
        ax_c.text(
            min(1.02, row["strict_recovery"] + 0.025),
            yi + 0.11,
            f"{row['recovered']}/{row['n']}",
            fontsize=7.2,
            color=PALETTE["blue_dark"],
            va="center",
        )
    ax_c.set_yticks(y, [row["label"] for row in singles])
    ax_c.set_xlim(0.55, 1.04)
    ax_c.set_xlabel("比例")
    ax_c.set_title("单事件：缺轮与整体移动达到 90%，局部移动仍偏弱", loc="left", pad=8, fontweight="bold")
    ax_c.legend(loc="lower left", fontsize=7.0)
    style_axis(ax_c, "x")
    panel_label(ax_c, "c")

    # d: file-level heterogeneity.
    for kind, (label, marker, color) in MEASUREMENT_STYLE.items():
        rows = [row for row in per_file if row["measurementKind"] == kind]
        if not rows:
            continue
        sizes = [34 + 11 * math.log1p(row["fileProblemSegments"]) for row in rows]
        ax_d.scatter(
            [row["AB"]["truthRecoveryRate"] for row in rows],
            [row["CD"]["truthRecoveryRate"] for row in rows],
            s=sizes,
            marker=marker,
            c=color,
            edgecolors="white",
            linewidths=0.8,
            alpha=0.87,
            label=label,
            zorder=3,
        )
    ab_overall = result["runs"]["AB"]["official"]["overall"]["truthRecoveryRate"]
    cd_overall = result["runs"]["CD"]["official"]["overall"]["truthRecoveryRate"]
    ax_d.axvline(ab_overall, color=PALETTE["blue"], linestyle="--", linewidth=0.8, alpha=0.7)
    ax_d.axhline(cd_overall, color=PALETTE["red"], linestyle="--", linewidth=0.8, alpha=0.7)
    ax_d.plot([0, 1], [0, 1], color=PALETTE["grid"], linewidth=0.8, linestyle=":")
    label_offsets = {
        "russ070n": (0.018, 0.018),
        "russ110e": (0.018, -0.035),
        "swit292": (0.018, 0.018),
    }
    for row in per_file:
        if row["fileId"] not in label_offsets:
            continue
        dx, dy = label_offsets[row["fileId"]]
        ax_d.annotate(
            row["fileId"],
            xy=(row["AB"]["truthRecoveryRate"], row["CD"]["truthRecoveryRate"]),
            xytext=(row["AB"]["truthRecoveryRate"] + dx, row["CD"]["truthRecoveryRate"] + dy),
            fontsize=6.8,
            color=PALETTE["ink"],
            arrowprops={"arrowstyle": "-", "lw": 0.6, "color": PALETTE["muted"]},
        )
    ax_d.set_xlim(0, 1.04)
    ax_d.set_ylim(0, 1.04)
    ax_d.set_xlabel("每文件 A/B 严格恢复率")
    ax_d.set_ylabel("每文件 C/D 严格恢复率")
    ax_d.set_title("23 个文件间异质性很大，参考结构决定适用边界", loc="left", pad=8, fontweight="bold")
    ax_d.legend(loc="upper left", fontsize=6.8)
    style_axis(ax_d, "both")
    panel_label(ax_d, "d")

    # e: integrity strip.
    ax_e.set_axis_off()
    integrity = result["integrity"]
    clean_total = result["population"]["includedFiles"]
    cards = [
        ("运行错误", str(integrity["benchmarkErrors"]), PALETTE["green_soft"]),
        ("非法窗口宽度", str(integrity["illegalWindowWidths"]), PALETTE["green_soft"]),
        ("非法自动 partial", str(integrity["invalidAutomaticPartialMoves"]), PALETTE["green_soft"]),
        ("保存/重开一致", "100%" if integrity["saveReopenStable"] else "否", PALETTE["green_soft"]),
        ("干净误报", f"{len(result['cleanFalsePositives'])}/{clean_total} = {len(result['cleanFalsePositives']) / clean_total * 100:.2f}%", PALETTE["gold_soft"]),
    ]
    gap = 0.012
    width = (1 - gap * (len(cards) - 1)) / len(cards)
    for index, (name, value, color) in enumerate(cards):
        x0 = index * (width + gap)
        ax_e.add_patch(
            FancyBboxPatch(
                (x0, 0.05),
                width,
                0.82,
                boxstyle="round,pad=0.006,rounding_size=0.02",
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.7,
                transform=ax_e.transAxes,
            )
        )
        ax_e.text(x0 + width / 2, 0.61, name, ha="center", va="center", fontsize=7.2, color=PALETTE["muted"])
        ax_e.text(x0 + width / 2, 0.30, value, ha="center", va="center", fontsize=9.2, fontweight="bold", color=PALETTE["ink"])
    panel_label(ax_e, "e", x=-0.035, y=1.0)
    fig.text(
        0.975,
        0.022,
        "严格恢复 = 操作 + 位移量 + 唯一主窗口均正确；条件窗口覆盖仅在操作正确时计算。",
        ha="right",
        va="bottom",
        fontsize=7.2,
        color=PALETTE["muted"],
    )
    return fig


def create_event_table_figure() -> mpl.figure.Figure:
    fig, ax = plt.subplots(figsize=(13.0, 9.4))
    ax.set_axis_off()
    ax.text(
        0.02,
        0.985,
        "定年事件、可能的生态/样品含义与识别契约",
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=16.5,
        fontweight="bold",
        color=PALETTE["ink"],
    )
    ax.text(
        0.02,
        0.949,
        "生态含义是待现场与木材解剖验证的解释；软件直接识别的是日历 lag 状态与可执行编辑。",
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=9.1,
        color=PALETTE["muted"],
    )

    columns = [
        ("事件 / 操作", "event", 0.105, 11.5),
        ("lag 状态指纹\n（老端 → 树皮端）", "lag", 0.115, 12.5),
        ("软件执行编辑", "edit", 0.145, 15.5),
        ("可能的生态 / 样品含义", "meaning", 0.235, 25.0),
        ("如何识别与通过门槛", "detect", 0.285, 30.0),
        ("不可越过的解释边界", "limit", 0.115, 12.0),
    ]
    left = 0.018
    table_bottom = 0.095
    table_top = 0.915
    header_h = 0.067
    row_h = (table_top - table_bottom - header_h) / len(EVENT_DEFINITIONS)
    x_positions = [left]
    usable_width = 0.964
    for _, _, width, _ in columns:
        x_positions.append(x_positions[-1] + usable_width * width)

    ax.add_patch(
        Rectangle(
            (left, table_top - header_h),
            usable_width,
            header_h,
            transform=ax.transAxes,
            facecolor=PALETTE["teal"],
            edgecolor=PALETTE["line"],
            linewidth=1.0,
        )
    )
    for index, (title, _, _, _) in enumerate(columns):
        ax.text(
            (x_positions[index] + x_positions[index + 1]) / 2,
            table_top - header_h / 2,
            title,
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=9.0,
            color="white",
            fontweight="bold",
            linespacing=1.2,
        )

    for row_index, row in enumerate(EVENT_DEFINITIONS):
        top = table_top - header_h - row_index * row_h
        bottom = top - row_h
        base_face = "#FFFFFF" if row_index % 2 == 0 else "#F7F8F8"
        ax.add_patch(
            Rectangle(
                (left, bottom),
                usable_width,
                row_h,
                transform=ax.transAxes,
                facecolor=base_face,
                edgecolor=PALETTE["line"],
                linewidth=0.65,
            )
        )
        ax.add_patch(
            Rectangle(
                (x_positions[0], bottom),
                x_positions[1] - x_positions[0],
                row_h,
                transform=ax.transAxes,
                facecolor=row["color"],
                edgecolor="none",
            )
        )
        for col_index, (_, key, _, wrap) in enumerate(columns):
            x0 = x_positions[col_index]
            x1 = x_positions[col_index + 1]
            text = wrap_display_text(row[key], wrap)
            ax.text(
                (x0 + x1) / 2 if col_index < 3 else x0 + 0.006,
                (top + bottom) / 2,
                text,
                transform=ax.transAxes,
                ha="center" if col_index < 3 else "left",
                va="center",
                fontsize=6.35 if col_index >= 3 else 6.85,
                color=PALETTE["ink"],
                fontweight="bold" if col_index == 0 else "normal",
                linespacing=1.17,
            )

    for x in x_positions:
        ax.plot(
            [x, x],
            [table_bottom, table_top],
            transform=ax.transAxes,
            color=PALETTE["line"],
            linewidth=0.65,
        )

    ax.text(
        0.02,
        0.056,
        "文献依据：缺轮可由形成层活动受抑及多类胁迫导致；伪轮/IADF 与生长季内水分和温度变化有关。COFECHA 仅辅助质量控制，最终判断仍由树轮学者完成。",
        transform=ax.transAxes,
        ha="left",
        va="center",
        fontsize=7.4,
        color=PALETTE["muted"],
    )
    ax.text(
        0.02,
        0.029,
        "注：g 为全局日历基线；q 为局部负向位移幅度。窗口与 Top1 均是人工复核导航，不是生态事件自动定因。",
        transform=ax.transAxes,
        ha="left",
        va="center",
        fontsize=7.4,
        color=PALETTE["red"],
        fontweight="bold",
    )
    return fig


def draw_lag_signature(
    ax: mpl.axes.Axes,
    x: Sequence[float],
    y: Sequence[float],
    *,
    title: str,
    subtitle: str,
    color: str,
    ylim: tuple[float, float],
) -> None:
    ax.plot(x, y, color=color, linewidth=2.2, drawstyle="steps-post")
    ax.axhline(0, color=PALETTE["grid"], linestyle="--", linewidth=0.8)
    ax.set_xlim(0, 1)
    ax.set_ylim(*ylim)
    ax.set_xticks([0, 1], ["老端", "树皮端"])
    ax.set_yticks(sorted(set(int(v) for v in y)))
    ax.set_title(title, loc="left", fontsize=8.7, fontweight="bold", pad=5)
    ax.text(0.02, 0.94, subtitle, transform=ax.transAxes, fontsize=6.6, color=PALETTE["muted"], va="top")
    style_axis(ax, None)
    ax.spines["left"].set_alpha(0.55)
    ax.spines["bottom"].set_alpha(0.55)


def create_complex_cases_figure(result: dict[str, Any]) -> mpl.figure.Figure:
    fig = plt.figure(figsize=(12.5, 8.6))
    outer = fig.add_gridspec(
        3,
        6,
        height_ratios=[1.05, 1.45, 0.82],
        hspace=0.48,
        wspace=0.42,
        left=0.055,
        right=0.975,
        top=0.875,
        bottom=0.065,
    )
    fig.text(
        0.04,
        0.968,
        "复杂定年情形如何被区分：lag 拓扑、反事实与固定侧证据的联合裁决",
        fontsize=16,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )
    fig.text(
        0.04,
        0.932,
        "示意路径从较老端指向树皮端；颜色表示不同操作假设，非概率。",
        fontsize=8.8,
        ha="left",
        va="top",
        color=PALETTE["muted"],
    )

    signatures = [
        ([0, 0.58, 1], [-1, 0, 0], "缺轮", "单位负阶跃：−1→0", PALETTE["blue"], (-1.5, 0.6)),
        ([0, 0.58, 1], [1, 0, 0], "伪轮", "单位正阶跃：+1→0", PALETTE["red"], (-0.6, 1.5)),
        ([0, 0.58, 1], [-6, 0, 0], "局部缺段", "单次大阶跃：−q→0", PALETTE["teal"], (-6.8, 0.8)),
        ([0, 1], [-4, -4], "负向整体移动", "全段恒定；可提示外层年份缺失", PALETTE["purple"], (-4.8, 0.8)),
        ([0, 0.25, 0.48, 0.72, 1], [-3, -2, -1, 0, 0], "多缺轮阶梯", "多个中间平台，逐轮恢复", PALETTE["blue_dark"], (-3.8, 0.8)),
        ([0, 0.28, 0.68, 1], [0, -1, 0, 0], "近邻抵消脉冲", "远端同基线，局部两次转换", PALETTE["gold"], (-1.5, 0.6)),
    ]
    for index, spec in enumerate(signatures):
        ax = fig.add_subplot(outer[0, index])
        draw_lag_signature(
            ax,
            spec[0],
            spec[1],
            title=spec[2],
            subtitle=spec[3],
            color=spec[4],
            ylim=spec[5],
        )
        if index == 0:
            panel_label(ax, "a", x=-0.30, y=1.18)

    # b: three ambiguity comparisons using inset axes.
    ax_b = fig.add_subplot(outer[1, :3])
    ax_b.set_axis_off()
    ax_b.set_title("三类高风险混淆：关键不是位移总量，而是状态路径结构", loc="left", pad=8, fontweight="bold")
    panel_label(ax_b, "b", x=-0.08, y=1.09)
    comparison_specs = [
        (
            "连续缺段 −3 vs 三个分离缺轮",
            ([0, 0.62, 1], [-3, 0, 0], PALETTE["teal"], "partial：单跳"),
            ([0, 0.25, 0.47, 0.68, 1], [-3, -2, -1, 0, 0], PALETTE["blue"], "missing：阶梯"),
            "中间 −2/−1 平台 + 逐参考芯一致 → 多缺轮；无平台且 range-shift 增益更强 → partial。",
        ),
        (
            "whole −4 + missing vs 纯局部 −5",
            ([0, 0.60, 1], [-5, -4, -4], PALETTE["purple"], "whole+missing：树皮端仍为 −4"),
            ([0, 0.60, 1], [-5, 0, 0], PALETTE["teal"], "pure partial：树皮端回 0"),
            "COFECHA 终端 / 较新固定侧给出 g=−4；先应用 whole，再重诊断局部单位事件。",
        ),
        (
            "缺轮 + 伪轮近邻抵消",
            ([0, 0.30, 0.66, 1], [0, -1, 0, 0], PALETTE["gold"], "局部脉冲"),
            ([0, 1], [0, 0], PALETTE["grid"], "长窗表面：无偏移"),
            "长窗口会相互抵消；局部两侧反事实、paired reference 和 transition 方向共同恢复。",
        ),
    ]
    for row_index, (title, first, second, note) in enumerate(comparison_specs):
        y0 = 0.68 - row_index * 0.32
        inset = ax_b.inset_axes([0.02, y0, 0.42, 0.24])
        inset.plot(first[0], first[1], drawstyle="steps-post", color=first[2], linewidth=2.0, label=first[3])
        inset.plot(second[0], second[1], drawstyle="steps-post", color=second[2], linewidth=1.8, linestyle="--", label=second[3])
        inset.axhline(0, color=PALETTE["grid"], linewidth=0.7)
        ymin = min(min(first[1]), min(second[1])) - 0.7
        ymax = max(max(first[1]), max(second[1]), 0) + 0.7
        inset.set_xlim(0, 1)
        inset.set_ylim(ymin, ymax)
        inset.set_xticks([0, 1], ["老端", "树皮端"])
        inset.tick_params(labelsize=6.2)
        inset.legend(loc="lower left", fontsize=5.8)
        style_axis(inset, None)
        ax_b.text(0.47, y0 + 0.205, title, transform=ax_b.transAxes, fontsize=8.3, fontweight="bold", va="top")
        ax_b.text(0.47, y0 + 0.13, wrap_text(note, 31), transform=ax_b.transAxes, fontsize=7.1, color=PALETTE["muted"], va="top", linespacing=1.35)

    # c: evidence stack and constrained outcomes.
    ax_c = fig.add_subplot(outer[1, 3:])
    ax_c.set_axis_off()
    ax_c.set_title("五层证据如何把“像”转化为可执行且可拒答的建议", loc="left", pad=8, fontweight="bold")
    panel_label(ax_c, "c", x=-0.08, y=1.09)
    stack = [
        ("1  lag 拓扑", "方向、幅度、转换数、中间平台", PALETTE["blue_soft"]),
        ("2  编辑反事实", "insert / delete / partial / whole 的 Δr 与残差", PALETTE["red_soft"]),
        ("3  多参考芯共识", "master + individual vote；统计参考数与 margin", PALETTE["teal_soft"]),
        ("4  固定侧基线", "树皮端/终端是否回 0，还是保留全局 g", PALETTE["purple_soft"]),
        ("5  统一裁决", "保持操作、shift、lag 与强位置契约", PALETTE["gold_soft"]),
    ]
    for index, (title, body, color) in enumerate(stack):
        y0 = 0.79 - index * 0.16
        draw_box(
            ax_c,
            (0.02, y0, 0.52, 0.125),
            title,
            body,
            face="white",
            title_face=color,
            wrap=29,
            title_size=8.2,
            body_size=6.8,
        )
        if index < len(stack) - 1:
            arrow(ax_c, (0.28, y0), (0.28, y0 - 0.034), linewidth=0.9)

    outcomes = [
        (0.77, "独立证据同向", "唯一操作 + 唯一主窗", PALETTE["green_soft"]),
        (0.46, "累计 lag 等价", "仅开放受约束解释切换", PALETTE["gold_soft"]),
        (0.15, "证据不足/冲突", "拒答；保留人工复核", PALETTE["red_soft"]),
    ]
    for y0, title, body, color in outcomes:
        draw_box(
            ax_c,
            (0.63, y0, 0.34, 0.15),
            title,
            body,
            face=color,
            title_face=None,
            wrap=21,
            title_size=8.2,
            body_size=7.0,
        )
        arrow(ax_c, (0.54, 0.39), (0.63, y0 + 0.075), connectionstyle="arc3,rad=0.08", linewidth=0.9)
    compatible = result["nearEventEquivalentInterpretations"]["byFamily"]["C"]
    ax_c.text(
        0.62,
        0.03,
        wrap_text(
            f"既有 C 压力集：{compatible['cumulativeLagCompatible']}/{compatible['wrongOperationSteps']} "
            "个错误操作步骤满足累计 lag 等价；报告仍保持严格失败，不以解释切换抬高准确率。",
            31,
        ),
        transform=ax_c.transAxes,
        fontsize=6.8,
        color=PALETTE["red"],
        va="bottom",
        linespacing=1.3,
    )

    # d: serial human-in-the-loop repair.
    ax_d = fig.add_subplot(outer[2, :])
    ax_d.set_axis_off()
    ax_d.set_title("逐轮前沿保证：每次只修一个已确认事件，避免旧候选污染下一轮", loc="left", pad=8, fontweight="bold")
    panel_label(ax_d, "d", x=-0.035, y=1.12)
    sequence = [
        ("当前 working RWL", PALETTE["teal_soft"]),
        ("若存在全局 g\n先应用 whole", PALETTE["purple_soft"]),
        ("人工选年/断点\n二次确认一次", PALETTE["gold_soft"]),
        ("RwlEditor 写回\n撤销栈 + 日志", PALETTE["blue_soft"]),
        ("旧诊断 stale\n重建参考与 lag path", PALETTE["red_soft"]),
        ("显示下一个\n最新未解决前沿", PALETTE["green_soft"]),
        ("COFECHA / 解剖\n最终核验", PALETTE["teal_soft"]),
    ]
    box_w = 0.118
    xs = np.linspace(0.015, 0.985 - box_w, len(sequence))
    for index, ((title, color), x0) in enumerate(zip(sequence, xs)):
        ax_d.add_patch(
            FancyBboxPatch(
                (x0, 0.23),
                box_w,
                0.50,
                boxstyle="round,pad=0.006,rounding_size=0.02",
                transform=ax_d.transAxes,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.8,
            )
        )
        ax_d.text(x0 + box_w / 2, 0.48, title, transform=ax_d.transAxes, ha="center", va="center", fontsize=7.2, fontweight="bold", linespacing=1.25)
        if index < len(sequence) - 1:
            arrow(ax_d, (x0 + box_w, 0.48), (xs[index + 1], 0.48), linewidth=1.0)
    ax_d.text(
        0.50,
        0.06,
        "死亡、树皮缺失、腐朽或断裂属于样品解释层；需结合 bark/pith 状态、样芯照片、现场记录和木材解剖确认。",
        transform=ax_d.transAxes,
        ha="center",
        va="center",
        fontsize=7.7,
        color=PALETTE["red"],
        fontweight="bold",
    )
    return fig


def create_validation_design_figure(result: dict[str, Any]) -> mpl.figure.Figure:
    """Explain the frozen file-disjoint benchmark and where cases stop.

    This figure complements the performance figure: it documents the unit of separation,
    injected complexity families, terminal outcomes, and reproducibility controls. It avoids
    presenting the frozen run as a new blind evaluation of later code.
    """

    population = result["population"]
    ab = result["runs"]["AB"]["official"]
    cd = result["runs"]["CD"]["official"]

    fig = plt.figure(figsize=(11.2, 8.4))
    gs = fig.add_gridspec(
        2,
        2,
        height_ratios=[1.02, 0.98],
        width_ratios=[1.08, 0.92],
        hspace=0.34,
        wspace=0.28,
        left=0.06,
        right=0.975,
        top=0.875,
        bottom=0.075,
    )
    ax_a = fig.add_subplot(gs[0, 0])
    ax_b = fig.add_subplot(gs[0, 1])
    ax_c = fig.add_subplot(gs[1, 0])
    ax_d = fig.add_subplot(gs[1, 1])

    fig.text(
        0.055,
        0.965,
        "冻结跨文件验证设计、复杂度分层与失效位置",
        fontsize=16,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )
    fig.text(
        0.055,
        0.928,
        (
            "数据选择不使用信号强度或诊断输出；每个文件最多 1 条目标序列。"
            "测试日期 2026-08-13，结果只代表该冻结协议与执行提交。"
        ),
        fontsize=8.7,
        ha="left",
        va="top",
        color=PALETTE["muted"],
    )

    # a: complete protocol, with the RWL file as the isolation/cluster unit.
    ax_a.set_axis_off()
    ax_a.set_title("文件级隔离后再注入事件，并逐次重诊断", loc="left", pad=8, fontweight="bold")
    panel_label(ax_a, "a", x=-0.07, y=1.06)
    protocol = [
        (
            "候选库",
            f"{population['candidateFiles']} 个 RWL 文件\n排除旧 manifest 重叠",
            PALETTE["grey_soft"],
        ),
        (
            "预先筛选",
            "目标 ≥200 年\nmaster r ≥0.80\nproblem segment = 0",
            PALETTE["teal_soft"],
        ),
        (
            "冻结留出",
            f"{population['includedFiles']} 个文件 / {population['targets']} 个目标\n每文件最多 1 条",
            PALETTE["blue_soft"],
        ),
        (
            "事件注入",
            "A/B/C/D 预定义场景\nshift、间距、窗宽均冻结",
            PALETTE["gold_soft"],
        ),
        (
            "产品同构运行",
            "COFECHA-pass 参考\n生成 1 个主建议/复核窗",
            PALETTE["purple_soft"],
        ),
        (
            "逐轮核验",
            "应用 1 个真值事件\n保存/重开 → 重新诊断\n直到成功或严格停止",
            PALETTE["green_soft"],
        ),
    ]
    columns = 3
    box_w = 0.285
    box_h = 0.27
    xs = [0.02, 0.355, 0.69]
    ys = [0.62, 0.18]
    for index, (heading, body, color) in enumerate(protocol):
        row = index // columns
        col = index % columns
        x0 = xs[col]
        y0 = ys[row]
        ax_a.add_patch(
            FancyBboxPatch(
                (x0, y0),
                box_w,
                box_h,
                boxstyle="round,pad=0.006,rounding_size=0.018",
                transform=ax_a.transAxes,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.8,
            )
        )
        ax_a.text(
            x0 + box_w / 2,
            y0 + box_h * 0.72,
            heading,
            transform=ax_a.transAxes,
            ha="center",
            va="center",
            fontsize=8.3,
            fontweight="bold",
            color=PALETTE["ink"],
        )
        ax_a.text(
            x0 + box_w / 2,
            y0 + box_h * 0.38,
            body,
            transform=ax_a.transAxes,
            ha="center",
            va="center",
            fontsize=6.8,
            linespacing=1.25,
            color=PALETTE["ink"],
        )
        if col < columns - 1:
            arrow(ax_a, (x0 + box_w, y0 + box_h / 2), (xs[col + 1], y0 + box_h / 2), linewidth=0.9)
    arrow(ax_a, (xs[2] + box_w / 2, ys[0]), (xs[0] + box_w / 2, ys[1] + box_h), connectionstyle="arc3,rad=-0.34", linewidth=0.9)
    ax_a.text(
        0.50,
        0.035,
        "隔离/聚类单位 = RWL 文件；场景内事件不是独立文件，不能用普通逐事件 bootstrap。",
        transform=ax_a.transAxes,
        ha="center",
        va="center",
        fontsize=7.0,
        color=PALETTE["red"],
        fontweight="bold",
    )

    # b: scenario-family matrix.
    ax_b.set_axis_off()
    ax_b.set_title("四个家族回答不同难度的问题", loc="left", pad=8, fontweight="bold")
    panel_label(ax_b, "b", x=-0.09, y=1.06)
    family_specs = [
        ("A", "单事件 + clean", "5", ab["byFamily"]["A"]["cases"], 92, "能否识别基本操作？"),
        ("B", "远距双事件 / whole+local", "12", ab["byFamily"]["B"]["cases"], 552, "能否逐个恢复分离事件？"),
        ("C", "相距 7 年的近邻双事件", "9", cd["byFamily"]["C"]["cases"], 414, "能否处理局部等价解释？"),
        ("D", "whole + 两个 local", "4", cd["byFamily"]["D"]["cases"], 276, "能否先定全局再找局部？"),
    ]
    headers = ["家族", "结构", "场景", "案例", "真值", "核心问题"]
    col_x = [0.035, 0.13, 0.52, 0.63, 0.74, 0.84]
    ax_b.add_patch(Rectangle((0.015, 0.82), 0.97, 0.105, transform=ax_b.transAxes, facecolor=PALETTE["teal"], edgecolor=PALETTE["line"], linewidth=0.8))
    for x0, header in zip(col_x, headers):
        ax_b.text(x0, 0.872, header, transform=ax_b.transAxes, ha="left", va="center", fontsize=7.0, fontweight="bold", color="white")
    row_h = 0.18
    for idx, (family, structure, scenarios, cases, truths, question) in enumerate(family_specs):
        y0 = 0.82 - (idx + 1) * row_h
        ax_b.add_patch(Rectangle((0.015, y0), 0.97, row_h, transform=ax_b.transAxes, facecolor=PALETTE["paper"] if idx % 2 == 0 else PALETTE["panel"], edgecolor=PALETTE["grid"], linewidth=0.7))
        ax_b.add_patch(FancyBboxPatch((0.028, y0 + 0.038), 0.062, 0.105, boxstyle="round,pad=0.004,rounding_size=0.012", transform=ax_b.transAxes, facecolor=FAMILY_COLORS[family], edgecolor=PALETTE["line"], linewidth=0.7))
        ax_b.text(0.059, y0 + 0.091, family, transform=ax_b.transAxes, ha="center", va="center", fontsize=9.0, fontweight="bold", color="white")
        ax_b.text(col_x[1], y0 + 0.091, wrap_text(structure, 18), transform=ax_b.transAxes, ha="left", va="center", fontsize=6.8, linespacing=1.25)
        ax_b.text(col_x[2], y0 + 0.091, scenarios, transform=ax_b.transAxes, ha="left", va="center", fontsize=7.6, fontweight="bold")
        ax_b.text(col_x[3], y0 + 0.091, str(cases), transform=ax_b.transAxes, ha="left", va="center", fontsize=7.2)
        ax_b.text(col_x[4], y0 + 0.091, str(truths), transform=ax_b.transAxes, ha="left", va="center", fontsize=7.2)
        ax_b.text(col_x[5], y0 + 0.091, wrap_text(question, 9), transform=ax_b.transAxes, ha="left", va="center", fontsize=6.5, linespacing=1.22)
    ax_b.text(0.02, 0.035, "A 含 23 个 clean 对照；B/C/D 每个冻结目标均覆盖各自全部场景。", transform=ax_b.transAxes, ha="left", va="center", fontsize=6.9, color=PALETTE["muted"])

    # c: exhaustive terminal outcome decomposition from the run summaries.
    ax_c.set_title("完整停止原因显示：近邻压力主要败在“操作解释”", loc="left", pad=8, fontweight="bold")
    panel_label(ax_c, "c")
    labels = ["全部事件恢复", "拒答", "操作错误", "窗口未覆盖", "clean 通过", "clean 误报"]
    colors = [PALETTE["green"], PALETTE["gold"], PALETTE["red"], PALETTE["purple"], PALETTE["blue"], PALETTE["rose"]]
    ab_stop = ab["stopReasons"]
    cd_stop = cd["stopReasons"]
    outcome_counts = {
        "A/B（单事件+远距）": [
            ab_stop.get("all_truths_recovered", 0),
            ab_stop.get("refused", 0),
            ab_stop.get("wrong_operation", 0),
            ab_stop.get("window_miss", 0),
            ab_stop.get("clean_pass", 0),
            ab_stop.get("clean_false_positive", 0),
        ],
        "C/D（近邻+三类混合）": [
            cd_stop.get("all_truths_recovered", 0),
            cd_stop.get("refused", 0),
            cd_stop.get("wrong_operation", 0),
            cd_stop.get("window_miss", 0),
            cd_stop.get("clean_pass", 0),
            cd_stop.get("clean_false_positive", 0),
        ],
    }
    y_positions = np.array([1, 0])
    left = np.zeros(2)
    totals = np.array([sum(outcome_counts[name]) for name in outcome_counts], dtype=float)
    for label, color, component_index in zip(labels, colors, range(len(labels))):
        counts = np.array([outcome_counts[name][component_index] for name in outcome_counts], dtype=float)
        shares = counts / totals
        ax_c.barh(y_positions, shares, left=left, height=0.47, color=color, edgecolor="white", linewidth=0.7, label=label)
        for yi, x0, share, count in zip(y_positions, left, shares, counts):
            if share >= 0.075:
                ax_c.text(x0 + share / 2, yi, f"{int(count)}\n{share * 100:.1f}%", ha="center", va="center", fontsize=6.5, color="white" if color in {PALETTE['green'], PALETTE['red'], PALETTE['purple'], PALETTE['blue']} else PALETTE["ink"], fontweight="bold")
        left += shares
    ax_c.set_yticks(y_positions, list(outcome_counts.keys()))
    ax_c.set_xlim(0, 1)
    ax_c.set_xlabel("案例占比（各横条内部合计 100%）")
    ax_c.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1.0))
    ax_c.legend(loc="lower center", bbox_to_anchor=(0.5, -0.33), ncol=3, fontsize=6.4, handlelength=1.4, columnspacing=1.0)
    style_axis(ax_c, "x")

    # d: statistical/reproducibility contract.
    ax_d.set_axis_off()
    ax_d.set_title("统计与可复现性契约", loc="left", pad=8, fontweight="bold")
    panel_label(ax_d, "d", x=-0.09, y=1.06)
    cards = [
        ("抽样单位", "RWL 文件\n23 个独立 clusters", PALETTE["blue_soft"]),
        ("不确定性", "文件聚类 bootstrap\n10,000 次；95% CI", PALETTE["teal_soft"]),
        ("操作网格", "partial = −6/−20\nwhole = −4/+4", PALETTE["purple_soft"]),
        ("事件间距", "远距 = 30 年\n近邻 = 7 年", PALETTE["gold_soft"]),
        ("允许窗宽", "5 / 7 / 9 / 13 年\n非法宽度 = 0", PALETTE["green_soft"]),
        ("运行完整性", "错误 = 0\n保存/重开 = 100%", PALETTE["green_soft"]),
    ]
    card_w = 0.30
    card_h = 0.22
    xs = [0.02, 0.35, 0.68]
    ys = [0.61, 0.32]
    for idx, (heading, body, color) in enumerate(cards):
        row = idx // 3
        col = idx % 3
        x0 = xs[col]
        y0 = ys[row]
        ax_d.add_patch(FancyBboxPatch((x0, y0), card_w, card_h, boxstyle="round,pad=0.006,rounding_size=0.018", transform=ax_d.transAxes, facecolor=color, edgecolor=PALETTE["line"], linewidth=0.7))
        ax_d.text(x0 + card_w / 2, y0 + card_h * 0.72, heading, transform=ax_d.transAxes, ha="center", va="center", fontsize=7.4, fontweight="bold")
        ax_d.text(x0 + card_w / 2, y0 + card_h * 0.36, body, transform=ax_d.transAxes, ha="center", va="center", fontsize=6.6, linespacing=1.25)
    ax_d.add_patch(FancyBboxPatch((0.02, 0.045), 0.96, 0.18, boxstyle="round,pad=0.008,rounding_size=0.018", transform=ax_d.transAxes, facecolor=PALETTE["panel"], edgecolor=PALETTE["red"], linewidth=1.0))
    ax_d.text(0.50, 0.135, "替换策略", transform=ax_d.transAxes, ha="center", va="center", fontsize=7.5, color=PALETTE["red"], fontweight="bold")
    ax_d.text(
        0.50,
        0.082,
        "后续盲测完成后只替换结果 JSON 并重跑同一 Python 脚本；\n布局、指标定义与源数据表保持不变。",
        transform=ax_d.transAxes,
        ha="center",
        va="center",
        fontsize=6.8,
        linespacing=1.2,
        color=PALETTE["ink"],
    )

    fig.text(
        0.975,
        0.022,
        "论文定位：可审计的质量控制与人工复核建议，不是自动定年器；COFECHA 与木材解剖判断仍是外部核验层。",
        ha="right",
        va="bottom",
        fontsize=7.2,
        color=PALETTE["muted"],
    )
    return fig


def draw_square_card(
    ax: mpl.axes.Axes,
    xywh: tuple[float, float, float, float],
    title: str,
    body: str = "",
    *,
    face: str = "white",
    title_face: str | None = None,
    edge: str = PALETTE["line"],
    title_size: float = 8.6,
    body_size: float = 7.2,
    wrap: int = 30,
    body_align: str = "left",
    body_va: str = "top",
    linewidth: float = 0.85,
    padding: float = 0.014,
) -> None:
    """Draw a square-corner card with explicit internal padding."""

    x, y, width, height = xywh
    ax.add_patch(
        Rectangle(
            (x, y),
            width,
            height,
            transform=ax.transAxes,
            facecolor=face,
            edgecolor=edge,
            linewidth=linewidth,
            zorder=2,
        )
    )
    title_height = min(0.052, height * 0.34)
    if title_face is not None:
        ax.add_patch(
            Rectangle(
                (x, y + height - title_height),
                width,
                title_height,
                transform=ax.transAxes,
                facecolor=title_face,
                edgecolor="none",
                zorder=3,
            )
        )
    ax.text(
        x + width / 2,
        y + height - title_height / 2,
        title,
        transform=ax.transAxes,
        ha="center",
        va="center",
        fontsize=title_size,
        fontweight="bold",
        color=PALETTE["ink"],
        zorder=4,
    )
    if body:
        body_y = (
            y + (height - title_height) / 2
            if body_va == "center"
            else y + height - title_height - padding
        )
        ax.text(
            x + (padding if body_align == "left" else width / 2),
            body_y,
            wrap_text(body, wrap),
            transform=ax.transAxes,
            ha=body_align,
            va=body_va,
            fontsize=body_size,
            color=PALETTE["ink"],
            linespacing=1.22,
            zorder=4,
        )


def create_performance_figure_v2(result: dict[str, Any]) -> mpl.figure.Figure:
    """Performance-first summary using the existing frozen cross-file result."""

    families = get_family_metrics(result)
    singles = get_single_event_metrics(result)
    per_file = result["perFile"]
    fig = plt.figure(figsize=(11.2, 8.0))
    gs = fig.add_gridspec(
        3,
        2,
        height_ratios=[1.0, 1.0, 0.19],
        hspace=0.38,
        wspace=0.32,
        left=0.075,
        right=0.975,
        top=0.875,
        bottom=0.065,
    )
    ax_a = fig.add_subplot(gs[0, 0])
    ax_b = fig.add_subplot(gs[0, 1])
    ax_c = fig.add_subplot(gs[1, 0])
    ax_d = fig.add_subplot(gs[1, 1])
    ax_e = fig.add_subplot(gs[2, :])

    truth_total = sum(row["truth_events"] for row in families)
    fig.text(
        0.055,
        0.965,
        "Cross-file performance of the dating recommendation module",
        fontsize=17.0,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )
    fig.text(
        0.055,
        0.928,
        f"{result['population']['includedFiles']} unseen RWL files  •  {truth_total:,} truth events  •  file-cluster bootstrap: 10,000 replicates",
        fontsize=9.0,
        ha="left",
        va="top",
        color=PALETTE["muted"],
    )

    # a: family-level strict recovery and file-cluster intervals.
    x = np.arange(4)
    values = np.array([row["strict_recovery"] for row in families])
    lower = values - np.array([row["ci_low"] for row in families])
    upper = np.array([row["ci_high"] for row in families]) - values
    bars = ax_a.bar(
        x,
        values,
        width=0.62,
        color=[FAMILY_COLORS[row["family"]] for row in families],
        alpha=0.90,
        edgecolor=PALETTE["line"],
        linewidth=0.75,
        zorder=3,
    )
    ax_a.errorbar(
        x,
        values,
        yerr=np.vstack([lower, upper]),
        fmt="none",
        ecolor=PALETTE["line"],
        elinewidth=1.05,
        capsize=4,
        capthick=1.05,
        zorder=5,
    )
    for bar, row in zip(bars, families):
        ax_a.text(
            bar.get_x() + bar.get_width() / 2,
            row["strict_recovery"] + 0.027,
            f"{row['strict_recovery'] * 100:.1f}%",
            ha="center",
            va="bottom",
            fontsize=8.8,
            fontweight="bold",
        )
        ax_a.text(
            bar.get_x() + bar.get_width() / 2,
            0.035,
            f"n={row['truth_events']}",
            ha="center",
            va="bottom",
            fontsize=7.2,
            color="white" if row["strict_recovery"] > 0.45 else PALETTE["ink"],
        )
    ax_a.set_xticks(x, ["A\nSingle events", "B\nDistant pairs", "C\nNear pairs", "D\nThree-event mix"])
    ax_a.set_ylim(0, 1.04)
    ax_a.set_ylabel("Strict recovery")
    ax_a.set_title("Strict recovery across benchmark families", loc="left", pad=8, fontweight="bold")
    ax_a.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1.0))
    style_axis(ax_a, "y")
    panel_label(ax_a, "a")

    # b: complementary performance dimensions.
    metric_rows = [
        ("Response", "response"),
        ("Operation", "operation_accuracy"),
        ("Main-window coverage", "main_window"),
        ("Conditional coverage", "conditional_window"),
        ("Exact Top1", "top1"),
    ]
    heat = np.array([[row[key] if row[key] is not None else np.nan for row in families] for _, key in metric_rows])
    cmap = LinearSegmentedColormap.from_list(
        "teal_paper_v2",
        ["#F5F6F6", "#DCE9EB", "#8EBAC3", PALETTE["teal_dark"]],
    )
    im = ax_b.imshow(heat, vmin=0, vmax=1, cmap=cmap, aspect="auto")
    ax_b.set_xticks(np.arange(4), ["A", "B", "C", "D"])
    ax_b.set_yticks(np.arange(len(metric_rows)), [name for name, _ in metric_rows])
    ax_b.tick_params(length=0, pad=7)
    for row_index in range(heat.shape[0]):
        for column_index in range(heat.shape[1]):
            value = heat[row_index, column_index]
            ax_b.text(
                column_index,
                row_index,
                "—" if np.isnan(value) else f"{value * 100:.1f}",
                ha="center",
                va="center",
                fontsize=8.3,
                color="white" if value >= 0.68 else PALETTE["ink"],
                fontweight="bold",
            )
    ax_b.set_title("Complementary performance dimensions (%)", loc="left", pad=8, fontweight="bold")
    for spine in ax_b.spines.values():
        spine.set_visible(False)
    cbar = fig.colorbar(im, ax=ax_b, fraction=0.046, pad=0.03)
    cbar.set_label("Proportion")
    cbar.ax.tick_params(labelsize=7.0)
    panel_label(ax_b, "b")

    # c: single-event Wilson intervals.
    y = np.arange(len(singles))[::-1]
    strict = np.array([row["strict_recovery"] for row in singles])
    response = np.array([row["response"] for row in singles])
    strict_lo = strict - np.array([row["strict_ci"][0] for row in singles])
    strict_hi = np.array([row["strict_ci"][1] for row in singles]) - strict
    response_lo = response - np.array([row["response_ci"][0] for row in singles])
    response_hi = np.array([row["response_ci"][1] for row in singles]) - response
    ax_c.errorbar(
        strict,
        y + 0.11,
        xerr=np.vstack([strict_lo, strict_hi]),
        fmt="o",
        markersize=6,
        color=PALETTE["blue_dark"],
        ecolor=PALETTE["blue_soft"],
        elinewidth=2.2,
        capsize=3,
        label="Strict recovery (95% CI)",
        zorder=4,
    )
    ax_c.errorbar(
        response,
        y - 0.11,
        xerr=np.vstack([response_lo, response_hi]),
        fmt="s",
        markersize=5.5,
        color=PALETTE["red"],
        ecolor=PALETTE["red_soft"],
        elinewidth=2.2,
        capsize=3,
        label="Response (95% CI)",
        zorder=3,
    )
    ax_c.axvline(0.90, color=PALETTE["muted"], linestyle="--", linewidth=0.85, alpha=0.65)
    for yi, row in zip(y, singles):
        ax_c.text(
            min(1.015, row["strict_recovery"] + 0.018),
            yi + 0.11,
            f"{row['recovered']}/{row['n']}",
            fontsize=7.1,
            color=PALETTE["blue_dark"],
            va="center",
        )
    ax_c.set_yticks(y, [row["label"] for row in singles])
    ax_c.set_xlim(0.0, 1.025)
    ax_c.set_xlabel("Proportion")
    ax_c.set_title("Single-event response and strict recovery", loc="left", pad=8, fontweight="bold")
    ax_c.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1.0))
    ax_c.legend(loc="lower left", fontsize=7.2)
    style_axis(ax_c, "x")
    panel_label(ax_c, "c")

    # d: cross-file generalization.
    for kind, (label, marker, color) in MEASUREMENT_STYLE.items():
        rows = [row for row in per_file if row["measurementKind"] == kind]
        if not rows:
            continue
        sizes = [34 + 11 * math.log1p(row["fileProblemSegments"]) for row in rows]
        ax_d.scatter(
            [row["AB"]["truthRecoveryRate"] for row in rows],
            [row["CD"]["truthRecoveryRate"] for row in rows],
            s=sizes,
            marker=marker,
            c=color,
            edgecolors="white",
            linewidths=0.8,
            alpha=0.90,
            label=label,
            zorder=3,
        )
    ab_overall = result["runs"]["AB"]["official"]["overall"]["truthRecoveryRate"]
    cd_overall = result["runs"]["CD"]["official"]["overall"]["truthRecoveryRate"]
    ax_d.axvline(ab_overall, color=PALETTE["blue"], linestyle="--", linewidth=0.85, alpha=0.75)
    ax_d.axhline(cd_overall, color=PALETTE["red"], linestyle="--", linewidth=0.85, alpha=0.75)
    ax_d.plot([0, 1], [0, 1], color=PALETTE["grid"], linewidth=0.8, linestyle=":")
    ax_d.set_xlim(0, 1.04)
    ax_d.set_ylim(0, 1.04)
    ax_d.set_xlabel("Per-file A/B strict recovery")
    ax_d.set_ylabel("Per-file C/D strict recovery")
    ax_d.set_title("Generalization across 23 independent RWL files", loc="left", pad=8, fontweight="bold")
    ax_d.xaxis.set_major_formatter(mpl.ticker.PercentFormatter(1.0))
    ax_d.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1.0))
    ax_d.legend(loc="upper left", fontsize=7.0)
    style_axis(ax_d, "both")
    panel_label(ax_d, "d")

    # e: positive integrity and reproducibility summary.
    ax_e.set_axis_off()
    integrity = result["integrity"]
    clean_total = result["population"]["includedFiles"]
    clean_specificity = (clean_total - len(result["cleanFalsePositives"])) / clean_total
    cards = [
        ("Runtime completion", "100%" if integrity["benchmarkErrors"] == 0 else "Check", PALETTE["green_soft"]),
        ("Legal review windows", "100%" if integrity["illegalWindowWidths"] == 0 else "Check", PALETTE["green_soft"]),
        ("Valid edit operations", "100%" if integrity["invalidAutomaticPartialMoves"] == 0 else "Check", PALETTE["green_soft"]),
        ("Save–reopen consistency", "100%" if integrity["saveReopenStable"] else "Check", PALETTE["green_soft"]),
        ("Clean specificity", f"{clean_specificity * 100:.1f}%", PALETTE["gold_soft"]),
    ]
    gap = 0.012
    width = (1 - gap * (len(cards) - 1)) / len(cards)
    for index, (name, value, color) in enumerate(cards):
        x0 = index * (width + gap)
        ax_e.add_patch(
            Rectangle(
                (x0, 0.04),
                width,
                0.84,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.70,
                transform=ax_e.transAxes,
            )
        )
        ax_e.text(x0 + width / 2, 0.62, name, ha="center", va="center", fontsize=7.6, color=PALETTE["muted"])
        ax_e.text(x0 + width / 2, 0.31, value, ha="center", va="center", fontsize=10.0, fontweight="bold")
    panel_label(ax_e, "e", x=-0.035, y=1.0)
    return fig


def create_event_table_figure_v2() -> mpl.figure.Figure:
    """Concise event definition table with generous cell padding."""

    fig, ax = plt.subplots(figsize=(12.8, 8.4))
    ax.set_axis_off()
    ax.text(
        0.025,
        0.972,
        "Crossdating events, ecological meaning and recognition evidence",
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=17.0,
        fontweight="bold",
        color=PALETTE["ink"],
    )
    ax.text(
        0.025,
        0.932,
        "Lag signatures are read from older years toward the bark-side end.",
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=9.0,
        color=PALETTE["muted"],
    )

    left = 0.025
    width = 0.95
    table_top = 0.895
    table_bottom = 0.045
    header_height = 0.068
    row_height = (table_top - table_bottom - header_height) / len(EVENT_DEFINITIONS_V2)
    fractions = [0.20, 0.15, 0.29, 0.36]
    x_positions = [left]
    for fraction in fractions:
        x_positions.append(x_positions[-1] + width * fraction)
    headers = ["Event and executable edit", "Lag signature", "Ecological / specimen meaning", "Recognition evidence"]

    ax.add_patch(
        Rectangle(
            (left, table_top - header_height),
            width,
            header_height,
            transform=ax.transAxes,
            facecolor=PALETTE["teal"],
            edgecolor=PALETTE["line"],
            linewidth=0.95,
        )
    )
    for index, header in enumerate(headers):
        ax.text(
            (x_positions[index] + x_positions[index + 1]) / 2,
            table_top - header_height / 2,
            header,
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=9.5,
            fontweight="bold",
            color="white",
        )

    for row_index, row in enumerate(EVENT_DEFINITIONS_V2):
        row_top = table_top - header_height - row_index * row_height
        row_bottom = row_top - row_height
        base = "#FFFFFF" if row_index % 2 == 0 else "#F7F8F8"
        ax.add_patch(
            Rectangle(
                (left, row_bottom),
                width,
                row_height,
                transform=ax.transAxes,
                facecolor=base,
                edgecolor=PALETTE["grid"],
                linewidth=0.65,
            )
        )
        ax.add_patch(
            Rectangle(
                (x_positions[0], row_bottom),
                x_positions[1] - x_positions[0],
                row_height,
                transform=ax.transAxes,
                facecolor=row["color"],
                edgecolor="none",
            )
        )
        center_y = (row_top + row_bottom) / 2
        ax.text(
            x_positions[0] + 0.012,
            center_y + 0.018,
            row["event"],
            transform=ax.transAxes,
            ha="left",
            va="center",
            fontsize=8.7,
            fontweight="bold",
            color=PALETTE["ink"],
        )
        ax.text(
            x_positions[0] + 0.012,
            center_y - 0.021,
            wrap_text(row["action"], 27),
            transform=ax.transAxes,
            ha="left",
            va="center",
            fontsize=7.5,
            color=PALETTE["ink"],
            linespacing=1.15,
        )
        ax.text(
            (x_positions[1] + x_positions[2]) / 2,
            center_y,
            row["lag"],
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=8.2,
            color=PALETTE["ink"],
            linespacing=1.20,
        )
        ax.text(
            x_positions[2] + 0.012,
            center_y,
            wrap_text(row["meaning"], 43),
            transform=ax.transAxes,
            ha="left",
            va="center",
            fontsize=7.7,
            color=PALETTE["ink"],
            linespacing=1.18,
        )
        ax.text(
            x_positions[3] + 0.012,
            center_y,
            wrap_text(row["recognition"], 54),
            transform=ax.transAxes,
            ha="left",
            va="center",
            fontsize=7.7,
            color=PALETTE["ink"],
            linespacing=1.18,
        )

    for x0 in x_positions:
        ax.plot([x0, x0], [table_bottom, table_top], transform=ax.transAxes, color=PALETTE["line"], linewidth=0.70)
    ax.plot([left, left + width], [table_bottom, table_bottom], transform=ax.transAxes, color=PALETTE["line"], linewidth=0.70)
    return fig


def draw_lag_signature_v2(
    ax: mpl.axes.Axes,
    x: Sequence[float],
    y: Sequence[float],
    *,
    title: str,
    cue: str,
    color: str,
    ylim: tuple[float, float],
) -> None:
    ax.plot(x, y, color=color, linewidth=2.25, drawstyle="steps-post")
    ax.axhline(0, color=PALETTE["grid"], linestyle="--", linewidth=0.75)
    ax.set_xlim(0, 1)
    ax.set_ylim(*ylim)
    ax.set_xticks([0, 1], ["Older", "Bark-side"])
    ax.set_yticks(sorted(set(int(value) for value in y)))
    ax.set_title(title, loc="left", fontsize=8.8, fontweight="bold", pad=5)
    ax.text(0.02, 0.94, cue, transform=ax.transAxes, fontsize=6.8, color=PALETTE["muted"], va="top")
    style_axis(ax, None)
    ax.spines["left"].set_alpha(0.55)
    ax.spines["bottom"].set_alpha(0.55)


def create_complex_cases_figure_v2(result: dict[str, Any]) -> mpl.figure.Figure:
    """Show how lag topology and counterfactual evidence separate complex cases."""

    del result
    fig = plt.figure(figsize=(12.5, 8.4))
    outer = fig.add_gridspec(
        3,
        6,
        height_ratios=[0.92, 1.58, 0.74],
        hspace=0.32,
        wspace=0.42,
        left=0.055,
        right=0.975,
        top=0.875,
        bottom=0.055,
    )
    fig.text(
        0.04,
        0.967,
        "Precise discrimination of complex crossdating patterns",
        fontsize=17.0,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )
    fig.text(
        0.04,
        0.930,
        "Lag topology + executable counterfactuals + independent-core evidence",
        fontsize=9.0,
        ha="left",
        va="top",
        color=PALETTE["muted"],
    )

    signatures = [
        ([0, 0.58, 1], [-1, 0, 0], "Missing ring", "unit negative step", PALETTE["blue"], (-1.5, 0.6)),
        ([0, 0.58, 1], [1, 0, 0], "False ring", "unit positive step", PALETTE["red"], (-0.6, 1.5)),
        ([0, 0.58, 1], [-6, 0, 0], "Partial shift", "single −q transition", PALETTE["teal"], (-6.8, 0.8)),
        ([0, 1], [-4, -4], "Whole-series shift", "constant global g", PALETTE["purple"], (-4.8, 0.8)),
        ([0, 0.25, 0.48, 0.72, 1], [-3, -2, -1, 0, 0], "Event staircase", "multiple plateaus", PALETTE["blue_dark"], (-3.8, 0.8)),
        ([0, 0.28, 0.68, 1], [0, -1, 0, 0], "Local cancellation", "paired transitions", PALETTE["gold"], (-1.5, 0.6)),
    ]
    for index, spec in enumerate(signatures):
        axis = fig.add_subplot(outer[0, index])
        draw_lag_signature_v2(
            axis,
            spec[0],
            spec[1],
            title=spec[2],
            cue=spec[3],
            color=spec[4],
            ylim=spec[5],
        )
        if index == 0:
            panel_label(axis, "a", x=-0.30, y=1.18)

    # b: three confusable pairs and the evidence that separates them.
    ax_b = fig.add_subplot(outer[1, :3])
    ax_b.set_axis_off()
    ax_b.set_title("Three confusable patterns resolved by path structure", loc="left", pad=8, fontweight="bold")
    panel_label(ax_b, "b", x=-0.07, y=1.08)
    comparisons = [
        (
            "Continuous gap vs three missing rings",
            ([0, 0.62, 1], [-3, 0, 0], PALETTE["teal"], "partial: one transition"),
            ([0, 0.25, 0.47, 0.68, 1], [-3, -2, -1, 0, 0], PALETTE["blue"], "missing: three plateaus"),
            "Topology: 1 transition vs 3 plateaus\nCounterfactual: range shift vs sequential inserts\nResolved output: partial −3 / three missing rings",
        ),
        (
            "Whole −4 + missing vs pure partial −5",
            ([0, 0.60, 1], [-5, -4, -4], PALETTE["purple"], "whole + missing"),
            ([0, 0.60, 1], [-5, 0, 0], PALETTE["teal"], "pure partial"),
            "Fixed side: bark-side remains −4 vs returns to 0\nCounterfactual: whole first vs one range shift\nResolved output: whole −4 + missing / partial −5",
        ),
        (
            "Missing + false vs a flat long-window match",
            ([0, 0.30, 0.66, 1], [0, -1, 0, 0], PALETTE["gold"], "local pulse"),
            ([0, 1], [0, 0], PALETTE["grid"], "long-window baseline"),
            "Topology: two opposite local transitions\nCounterfactual: paired insert/delete gains\nResolved output: two adjacent unit events",
        ),
    ]
    for row_index, (title, first, second, summary) in enumerate(comparisons):
        y0 = 0.68 - row_index * 0.32
        inset = ax_b.inset_axes([0.02, y0, 0.42, 0.235])
        inset.plot(first[0], first[1], drawstyle="steps-post", color=first[2], linewidth=2.05, label=first[3])
        inset.plot(second[0], second[1], drawstyle="steps-post", color=second[2], linewidth=1.85, linestyle="--", label=second[3])
        inset.axhline(0, color=PALETTE["grid"], linewidth=0.70)
        inset.set_xlim(0, 1)
        inset.set_ylim(min(min(first[1]), min(second[1])) - 0.7, max(max(first[1]), max(second[1]), 0) + 0.7)
        inset.set_xticks([0, 1], ["Older", "Bark-side"])
        inset.tick_params(labelsize=6.3)
        inset.legend(loc="lower left", fontsize=5.9, frameon=True, facecolor="white", edgecolor="none", framealpha=0.86)
        style_axis(inset, None)
        ax_b.text(0.48, y0 + 0.205, title, transform=ax_b.transAxes, fontsize=8.5, fontweight="bold", va="top")
        ax_b.text(
            0.48,
            y0 + 0.142,
            summary,
            transform=ax_b.transAxes,
            fontsize=7.2,
            color=PALETTE["ink"],
            va="top",
            linespacing=1.28,
        )

    # c: evidence fusion into precise product outputs.
    ax_c = fig.add_subplot(outer[1, 3:])
    ax_c.set_axis_off()
    ax_c.set_title("Evidence fusion produces a precise, executable result", loc="left", pad=8, fontweight="bold")
    panel_label(ax_c, "c", x=-0.08, y=1.08)
    stack = [
        ("1  Lag topology", "Direction • magnitude • transitions • plateaus", PALETTE["blue_soft"]),
        ("2  Edit counterfactuals", "Insert • delete • partial • whole", PALETTE["red_soft"]),
        ("3  Multi-core consensus", "Master • independent votes • support margin", PALETTE["teal_soft"]),
        ("4  Fixed-side baseline", "Bark-side state • terminal evidence", PALETTE["purple_soft"]),
        ("5  Joint resolution", "Fuse operation • shift • location", PALETTE["gold_soft"]),
    ]
    stack_y = [0.80, 0.655, 0.510, 0.365, 0.220]
    for index, ((title, body, color), y0) in enumerate(zip(stack, stack_y)):
        draw_square_card(
            ax_c,
            (0.02, y0, 0.50, 0.108),
            title,
            body,
            face="white",
            title_face=color,
            title_size=8.2,
            body_size=6.9,
            wrap=40,
            padding=0.010,
        )
        if index < len(stack) - 1:
            arrow(ax_c, (0.27, y0), (0.27, stack_y[index + 1] + 0.108), linewidth=0.90, mutation_scale=8.0)

    output_specs = [
        (0.680, "Event type", "missing • false • partial • whole", PALETTE["green_soft"]),
        (0.455, "Shift magnitude", "±1 • −q • global g", PALETTE["teal_soft"]),
        (0.230, "Focused review window", "5 • 7 • 9 • 13 years", PALETTE["blue_soft"]),
    ]
    bus_x = 0.575
    ax_c.plot([0.52, bus_x], [0.274, 0.274], transform=ax_c.transAxes, color=PALETTE["line"], linewidth=0.95)
    ax_c.plot([bus_x, bus_x], [0.274, 0.755], transform=ax_c.transAxes, color=PALETTE["line"], linewidth=0.95)
    for y0, title, body, color in output_specs:
        draw_square_card(
            ax_c,
            (0.63, y0, 0.34, 0.15),
            title,
            body,
            face=color,
            title_size=8.8,
            body_size=7.2,
            body_align="center",
            body_va="center",
            wrap=32,
            padding=0.012,
        )
        arrow(ax_c, (bus_x, y0 + 0.075), (0.63, y0 + 0.075), linewidth=0.90, mutation_scale=8.0)
    ax_c.add_patch(
        Rectangle(
            (0.63, 0.050),
            0.34,
            0.105,
            transform=ax_c.transAxes,
            facecolor=PALETTE["green_soft"],
            edgecolor=PALETTE["line"],
            linewidth=0.75,
        )
    )
    ax_c.text(
        0.80,
        0.102,
        "One traceable edit\nfrom convergent evidence",
        transform=ax_c.transAxes,
        ha="center",
        va="center",
        fontsize=7.6,
        fontweight="bold",
        linespacing=1.18,
    )

    # d: compact, traceable event iteration.
    ax_d = fig.add_subplot(outer[2, :])
    ax_d.set_axis_off()
    ax_d.set_title("One-event iteration keeps every correction current and traceable", loc="left", pad=8, fontweight="bold")
    panel_label(ax_d, "d", x=-0.035, y=1.12)
    sequence = [
        ("Working RWL", "Raw + current state", PALETTE["teal_soft"]),
        ("Global baseline", "Resolve whole shift first", PALETTE["purple_soft"]),
        ("Focused event", "Type + shift + window", PALETTE["gold_soft"]),
        ("Preview & confirm", "Inspect before / after", PALETTE["blue_soft"]),
        ("Commit", "Undo stack + audit log", PALETTE["red_soft"]),
        ("Rediagnose", "Fresh path + next event", PALETTE["green_soft"]),
    ]
    box_width = 0.145
    gap = (0.97 - 6 * box_width) / 5
    xs = [0.015 + index * (box_width + gap) for index in range(6)]
    for index, ((title, body, color), x0) in enumerate(zip(sequence, xs)):
        draw_square_card(
            ax_d,
            (x0, 0.32, box_width, 0.42),
            title,
            body,
            face="white",
            title_face=color,
            title_size=8.0,
            body_size=7.0,
            body_align="center",
            body_va="center",
            wrap=24,
            padding=0.018,
        )
        if index < len(sequence) - 1:
            arrow(ax_d, (x0 + box_width, 0.53), (xs[index + 1], 0.53), linewidth=0.95, mutation_scale=8.5)
    return fig


def create_validation_design_figure_v2(result: dict[str, Any]) -> mpl.figure.Figure:
    """Show benchmark coverage, file isolation and reproducible update mechanics."""

    population = result["population"]
    ab = result["runs"]["AB"]["official"]
    cd = result["runs"]["CD"]["official"]
    fig = plt.figure(figsize=(11.2, 8.0))
    gs = fig.add_gridspec(
        2,
        2,
        height_ratios=[1.02, 0.98],
        width_ratios=[1.08, 0.92],
        hspace=0.34,
        wspace=0.27,
        left=0.06,
        right=0.975,
        top=0.875,
        bottom=0.065,
    )
    ax_a = fig.add_subplot(gs[0, 0])
    ax_b = fig.add_subplot(gs[0, 1])
    ax_c = fig.add_subplot(gs[1, 0])
    ax_d = fig.add_subplot(gs[1, 1])
    fig.text(
        0.055,
        0.965,
        "Cross-file benchmark design and capability coverage",
        fontsize=17.0,
        fontweight="bold",
        ha="left",
        va="top",
        color=PALETTE["ink"],
    )
    fig.text(
        0.055,
        0.928,
        "23 unseen RWL files  •  four scenario families  •  file-cluster uncertainty  •  product-identical execution",
        fontsize=9.0,
        ha="left",
        va="top",
        color=PALETTE["muted"],
    )

    # a: file-disjoint benchmark pipeline.
    ax_a.set_axis_off()
    ax_a.set_title("File-disjoint validation pipeline", loc="left", pad=8, fontweight="bold")
    panel_label(ax_a, "a", x=-0.07, y=1.06)
    protocol = [
        ("Candidate pool", f"{population['candidateFiles']} RWL files", PALETTE["grey_soft"]),
        ("Eligibility screen", "Target ≥ 200 yr\nmaster r ≥ 0.80", PALETTE["teal_soft"]),
        ("Unseen-file set", f"{population['includedFiles']} files\none target per file", PALETTE["blue_soft"]),
        ("Scenario injection", "Families A–D\nfrozen shifts + spacing", PALETTE["gold_soft"]),
        ("Product execution", "COFECHA-pass reference\none primary suggestion", PALETTE["purple_soft"]),
        ("Iterative scoring", "Apply one truth event\nrediagnose current state", PALETTE["green_soft"]),
    ]
    box_width = 0.285
    box_height = 0.27
    xs = [0.02, 0.355, 0.69]
    ys = [0.62, 0.18]
    for index, (title, body, color) in enumerate(protocol):
        row = index // 3
        col = index % 3
        x0 = xs[col]
        y0 = ys[row]
        draw_square_card(
            ax_a,
            (x0, y0, box_width, box_height),
            title,
            body,
            face="white",
            title_face=color,
            title_size=8.5,
            body_size=7.2,
            body_align="center",
            body_va="center",
            wrap=28,
            padding=0.018,
        )
        if col < 2:
            arrow(ax_a, (x0 + box_width, y0 + box_height / 2), (xs[col + 1], y0 + box_height / 2), linewidth=0.90, mutation_scale=8.5)
    # Orthogonal connector between the two rows.
    route_y = 0.535
    ax_a.plot(
        [xs[2] + box_width / 2, xs[2] + box_width / 2, xs[0] + box_width / 2],
        [ys[0], route_y, route_y],
        transform=ax_a.transAxes,
        color=PALETTE["line"],
        linewidth=0.90,
    )
    arrow(
        ax_a,
        (xs[0] + box_width / 2, route_y),
        (xs[0] + box_width / 2, ys[1] + box_height),
        linewidth=0.90,
        mutation_scale=8.0,
    )

    # b: family design table.
    ax_b.set_axis_off()
    ax_b.set_title("Four families span increasing event complexity", loc="left", pad=8, fontweight="bold")
    panel_label(ax_b, "b", x=-0.09, y=1.06)
    family_specs = [
        ("A", "Clean + single events", "5", ab["byFamily"]["A"]["cases"], 92, "Core operation"),
        ("B", "Distant pairs / whole + local", "12", ab["byFamily"]["B"]["cases"], 552, "Separated recovery"),
        ("C", "Near local pairs (7 yr)", "9", cd["byFamily"]["C"]["cases"], 414, "Local discrimination"),
        ("D", "Whole + two local events", "4", cd["byFamily"]["D"]["cases"], 276, "Global + local"),
    ]
    headers = ["Family", "Structure", "Scen.", "Cases", "Truths", "Capability"]
    col_x = [0.030, 0.145, 0.500, 0.600, 0.700, 0.800]
    ax_b.add_patch(
        Rectangle(
            (0.015, 0.82),
            0.97,
            0.105,
            transform=ax_b.transAxes,
            facecolor=PALETTE["teal"],
            edgecolor=PALETTE["line"],
            linewidth=0.80,
        )
    )
    for x0, header in zip(col_x, headers):
        ax_b.text(x0, 0.872, header, transform=ax_b.transAxes, ha="left", va="center", fontsize=7.2, fontweight="bold", color="white")
    row_height = 0.18
    for index, (family, structure, scenarios, cases, truths, capability) in enumerate(family_specs):
        y0 = 0.82 - (index + 1) * row_height
        ax_b.add_patch(
            Rectangle(
                (0.015, y0),
                0.97,
                row_height,
                transform=ax_b.transAxes,
                facecolor=PALETTE["paper"] if index % 2 == 0 else PALETTE["panel"],
                edgecolor=PALETTE["grid"],
                linewidth=0.70,
            )
        )
        ax_b.add_patch(
            Rectangle(
                (0.028, y0 + 0.038),
                0.070,
                0.105,
                transform=ax_b.transAxes,
                facecolor=FAMILY_COLORS[family],
                edgecolor=PALETTE["line"],
                linewidth=0.70,
            )
        )
        ax_b.text(0.063, y0 + 0.091, family, transform=ax_b.transAxes, ha="center", va="center", fontsize=9.2, fontweight="bold", color="white")
        ax_b.text(col_x[1], y0 + 0.091, wrap_text(structure, 25), transform=ax_b.transAxes, ha="left", va="center", fontsize=7.0, linespacing=1.20)
        ax_b.text(col_x[2], y0 + 0.091, scenarios, transform=ax_b.transAxes, ha="left", va="center", fontsize=7.7, fontweight="bold")
        ax_b.text(col_x[3], y0 + 0.091, str(cases), transform=ax_b.transAxes, ha="left", va="center", fontsize=7.4)
        ax_b.text(col_x[4], y0 + 0.091, str(truths), transform=ax_b.transAxes, ha="left", va="center", fontsize=7.4)
        ax_b.text(col_x[5], y0 + 0.091, wrap_text(capability, 18), transform=ax_b.transAxes, ha="left", va="center", fontsize=6.8, linespacing=1.18)

    # c: coverage matrix.
    ax_c.set_title("Scenario coverage across diagnostic capabilities", loc="left", pad=8, fontweight="bold")
    panel_label(ax_c, "c")
    capability_labels = ["Clean\ncontrol", "Unit\nedit", "Range\nshift", "Whole\nshift", "Near\nevents", "Mixed\nevents"]
    coverage = np.array(
        [
            [1, 1, 1, 1, 0, 0],
            [0, 1, 1, 1, 0, 1],
            [0, 1, 1, 0, 1, 1],
            [0, 1, 1, 1, 1, 1],
        ],
        dtype=float,
    )
    coverage_cmap = LinearSegmentedColormap.from_list("coverage", ["#F2F3F3", PALETTE["teal"]])
    ax_c.imshow(coverage, vmin=0, vmax=1, cmap=coverage_cmap, aspect="auto")
    ax_c.set_xticks(np.arange(len(capability_labels)), capability_labels)
    ax_c.set_yticks(np.arange(4), ["A  Single", "B  Distant", "C  Near", "D  Mixed"])
    ax_c.tick_params(length=0, pad=7)
    for row in range(coverage.shape[0]):
        for col in range(coverage.shape[1]):
            if coverage[row, col] > 0:
                ax_c.text(col, row, "YES", ha="center", va="center", fontsize=7.5, fontweight="bold", color="white")
    for spine in ax_c.spines.values():
        spine.set_visible(False)

    # d: reproducibility metrics and direct update path.
    ax_d.set_axis_off()
    ax_d.set_title("Reproducibility controls and update path", loc="left", pad=8, fontweight="bold")
    panel_label(ax_d, "d", x=-0.09, y=1.06)
    truth_total = sum(get_family_metrics(result)[index]["truth_events"] for index in range(4))
    cards = [
        ("FILE CLUSTERS", f"{population['includedFiles']}", PALETTE["blue_soft"]),
        ("BOOTSTRAP", "10,000", PALETTE["teal_soft"]),
        ("TRUTH EVENTS", f"{truth_total:,}", PALETTE["purple_soft"]),
        ("REVIEW WINDOWS", "5 / 7 / 9 / 13 yr", PALETTE["gold_soft"]),
        ("RUNTIME ERRORS", str(result["integrity"]["benchmarkErrors"]), PALETTE["green_soft"]),
        ("SAVE–REOPEN", "100%" if result["integrity"]["saveReopenStable"] else "Check", PALETTE["green_soft"]),
    ]
    card_width = 0.30
    card_height = 0.18
    xs_card = [0.02, 0.35, 0.68]
    ys_card = [0.66, 0.41]
    for index, (title, value, color) in enumerate(cards):
        row = index // 3
        col = index % 3
        x0 = xs_card[col]
        y0 = ys_card[row]
        ax_d.add_patch(
            Rectangle(
                (x0, y0),
                card_width,
                card_height,
                transform=ax_d.transAxes,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.70,
            )
        )
        ax_d.text(x0 + card_width / 2, y0 + 0.125, title, transform=ax_d.transAxes, ha="center", va="center", fontsize=7.0, color=PALETTE["muted"], fontweight="bold")
        ax_d.text(x0 + card_width / 2, y0 + 0.055, value, transform=ax_d.transAxes, ha="center", va="center", fontsize=9.3, fontweight="bold")

    update_boxes = [
        (0.02, "RESULT JSON", PALETTE["grey_soft"]),
        (0.36, "SAME PYTHON\nSCRIPT", PALETTE["teal_soft"]),
        (0.70, "SVG • PDF\nPNG • TIFF", PALETTE["blue_soft"]),
    ]
    for index, (x0, label, color) in enumerate(update_boxes):
        ax_d.add_patch(
            Rectangle(
                (x0, 0.10),
                0.28,
                0.17,
                transform=ax_d.transAxes,
                facecolor=color,
                edgecolor=PALETTE["line"],
                linewidth=0.75,
            )
        )
        ax_d.text(x0 + 0.14, 0.185, label, transform=ax_d.transAxes, ha="center", va="center", fontsize=7.2, fontweight="bold", linespacing=1.15)
        if index < len(update_boxes) - 1:
            arrow(ax_d, (x0 + 0.28, 0.185), (update_boxes[index + 1][0], 0.185), linewidth=0.90, mutation_scale=8.0)
    return fig


def write_csv(path: Path, rows: Iterable[dict[str, Any]], fieldnames: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in fieldnames})


def export_source_data(result: dict[str, Any], output_dir: Path) -> list[str]:
    source_dir = output_dir / "source_data"
    source_dir.mkdir(parents=True, exist_ok=True)
    family_rows = get_family_metrics(result)
    write_csv(
        source_dir / "family_metrics.csv",
        family_rows,
        [
            "family",
            "truth_events",
            "strict_recovery",
            "response",
            "operation_accuracy",
            "main_window",
            "conditional_window",
            "top1",
            "ci_low",
            "ci_high",
            "files",
        ],
    )
    single_rows = []
    for row in get_single_event_metrics(result):
        single_rows.append(
            {
                "label": row["label"],
                "scenario": row["scenario"],
                "n": row["n"],
                "recovered": row["recovered"],
                "strict_recovery": row["strict_recovery"],
                "strict_ci_low": row["strict_ci"][0],
                "strict_ci_high": row["strict_ci"][1],
                "response": row["response"],
                "response_ci_low": row["response_ci"][0],
                "response_ci_high": row["response_ci"][1],
                "top1": row["top1"],
            }
        )
    write_csv(
        source_dir / "single_event_metrics.csv",
        single_rows,
        [
            "label",
            "scenario",
            "n",
            "recovered",
            "strict_recovery",
            "strict_ci_low",
            "strict_ci_high",
            "response",
            "response_ci_low",
            "response_ci_high",
            "top1",
        ],
    )
    per_file_rows = [
        {
            "file_id": row["fileId"],
            "measurement_kind": row["measurementKind"],
            "file_intercorrelation": row["fileIntercorrelation"],
            "file_problem_segments": row["fileProblemSegments"],
            "target_correlation": row["targetCorrelation"],
            "ab_strict_recovery": row["AB"]["truthRecoveryRate"],
            "cd_strict_recovery": row["CD"]["truthRecoveryRate"],
        }
        for row in result["perFile"]
    ]
    write_csv(
        source_dir / "per_file_metrics.csv",
        per_file_rows,
        [
            "file_id",
            "measurement_kind",
            "file_intercorrelation",
            "file_problem_segments",
            "target_correlation",
            "ab_strict_recovery",
            "cd_strict_recovery",
        ],
    )
    event_rows = [
        {
            "event": row["event"],
            "executable_edit": row["action"],
            "lag_signature": row["lag"].replace("\n", " "),
            "ecological_or_specimen_meaning": row["meaning"],
            "recognition_evidence": row["recognition"],
        }
        for row in EVENT_DEFINITIONS_V2
    ]
    write_csv(
        source_dir / "event_definitions.csv",
        event_rows,
        [
            "event",
            "executable_edit",
            "lag_signature",
            "ecological_or_specimen_meaning",
            "recognition_evidence",
        ],
    )
    family_design_rows = [
        {
            "family": "A",
            "structure": "clean control and one missing/false/partial/whole event",
            "scenarios": 5,
            "cases": result["runs"]["AB"]["official"]["byFamily"]["A"]["cases"],
            "truth_events": result["runs"]["AB"]["official"]["byFamily"]["A"]["truthEvents"],
            "spacing_years": "not_applicable",
        },
        {
            "family": "B",
            "structure": "distant local pairs and whole plus one local event",
            "scenarios": 12,
            "cases": result["runs"]["AB"]["official"]["byFamily"]["B"]["cases"],
            "truth_events": result["runs"]["AB"]["official"]["byFamily"]["B"]["truthEvents"],
            "spacing_years": 30,
        },
        {
            "family": "C",
            "structure": "near local pairs",
            "scenarios": 9,
            "cases": result["runs"]["CD"]["official"]["byFamily"]["C"]["cases"],
            "truth_events": result["runs"]["CD"]["official"]["byFamily"]["C"]["truthEvents"],
            "spacing_years": 7,
        },
        {
            "family": "D",
            "structure": "whole plus partial plus missing or false",
            "scenarios": 4,
            "cases": result["runs"]["CD"]["official"]["byFamily"]["D"]["cases"],
            "truth_events": result["runs"]["CD"]["official"]["byFamily"]["D"]["truthEvents"],
            "spacing_years": "mixed",
        },
    ]
    write_csv(
        source_dir / "benchmark_family_design.csv",
        family_design_rows,
        ["family", "structure", "scenarios", "cases", "truth_events", "spacing_years"],
    )
    terminal_rows: list[dict[str, Any]] = []
    for run_name in ("AB", "CD"):
        official = result["runs"][run_name]["official"]
        total = official["selectedCases"]
        for reason, count in official["stopReasons"].items():
            terminal_rows.append(
                {
                    "run": run_name,
                    "selected_cases": total,
                    "terminal_reason": reason,
                    "count": count,
                    "share": count / total,
                }
            )
    write_csv(
        source_dir / "terminal_outcomes.csv",
        terminal_rows,
        ["run", "selected_cases", "terminal_reason", "count", "share"],
    )
    return [
        "source_data/family_metrics.csv",
        "source_data/single_event_metrics.csv",
        "source_data/per_file_metrics.csv",
        "source_data/event_definitions.csv",
        "source_data/benchmark_family_design.csv",
        "source_data/terminal_outcomes.csv",
    ]


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--result-json",
        type=Path,
        default=repo_root / "docs" / "benchmarks" / "itrdb-current-generalization-result-v1.json",
        help="Frozen benchmark result JSON used for all quantitative panels.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=repo_root / "docs" / "figures" / "js-diagnosis-events-v1",
        help="Directory for SVG/PDF/PNG/TIFF figures and source-data tables.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    configure_style()
    result_path = args.result_json.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    with result_path.open("r", encoding="utf-8") as handle:
        result = json.load(handle)

    figures = [
        ("fig01_system_architecture", create_architecture_figure(result)),
        ("fig02_performance_validation", create_performance_figure_v2(result)),
        ("fig03_event_definition_table", create_event_table_figure_v2()),
        ("fig04_complex_case_discrimination", create_complex_cases_figure_v2(result)),
        ("fig05_validation_design_and_failures", create_validation_design_figure_v2(result)),
    ]
    outputs: list[str] = []
    for name, fig in figures:
        outputs.extend(save_figure(fig, output_dir / name))

    multipage_path = output_dir / "js_diagnosis_events_figure_set.pdf"
    with PdfPages(
        multipage_path,
        metadata={
            "Title": "JS diagnosis events figure set",
            "Author": "Generated with Python/matplotlib",
            "Subject": CONTRACT.conclusion,
        },
    ) as pdf:
        for _, fig in figures:
            pdf.savefig(fig, bbox_inches="tight", facecolor="white")
    outputs.append(multipage_path.name)

    source_outputs = export_source_data(result, output_dir)
    outputs.extend(source_outputs)
    for documentation_name in ("README.md", "QA_NOTES.md"):
        if (output_dir / documentation_name).exists():
            outputs.append(documentation_name)
    input_sha256 = hashlib.sha256(result_path.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "backend": "python-matplotlib",
        "figureContract": {
            "conclusion": CONTRACT.conclusion,
            "archetype": CONTRACT.archetype,
            "target": CONTRACT.target,
            "finalSize": CONTRACT.final_size,
            "reviewerRisk": CONTRACT.reviewer_risk,
        },
        "benchmark": {
            "createdAt": result.get("createdAt"),
            "executionGitCommit": result.get("executionGitCommit"),
            "manifestGitCommit": result.get("manifestGitCommit"),
            "verdict": result.get("verdict"),
            "inputSha256": input_sha256,
            "note": "Existing frozen result; not a rerun and not a blind test of later code.",
        },
        "outputs": outputs,
    }
    (output_dir / "figure_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    outputs.append("figure_manifest.json")

    for _, fig in figures:
        plt.close(fig)
    print(json.dumps({"outputDir": str(output_dir), "outputs": outputs}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
