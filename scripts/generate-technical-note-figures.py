"""Generate code-derived figures for the Crossdating IDM technical note.

Figure values are transcribed from the repository validation commands executed
on 2026-06-26. The workflow diagram reflects the current code path, including
the PART 3 master-series dynamic-reference route used by useHomeWorkspace.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "figures"

NAVY = "#163E63"
BLUE = "#2E74B5"
TEAL = "#287A70"
GREEN = "#4B8B5A"
ORANGE = "#C7772B"
RED = "#B0453B"
INK = "#1F2933"
MUTED = "#5B6770"
PALE_BLUE = "#EAF2F8"
PALE_GREEN = "#EAF5EE"
PALE_ORANGE = "#FFF3E8"
PALE_GRAY = "#F5F7F9"
LINE = "#B7C7D6"


def font(size: int, bold: bool = False):
    name = "arialbd.ttf" if bold else "arial.ttf"
    return ImageFont.truetype(f"C:/Windows/Fonts/{name}", size)


def center_text(draw: ImageDraw.ImageDraw, box, text, fnt, fill=INK, spacing=4):
    left, top, right, bottom = box
    bbox = draw.multiline_textbbox((0, 0), text, font=fnt, spacing=spacing, align="center")
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    draw.multiline_text(((left + right - width) / 2, (top + bottom - height) / 2), text, font=fnt, fill=fill, spacing=spacing, align="center")


def rounded_box(draw, box, text, fill, outline=LINE, title=False, text_fill=INK, radius=18):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=2)
    center_text(draw, box, text, font(23 if title else 19, bold=title), fill=text_fill)


def arrow(draw, start, end, fill=BLUE, width=4):
    draw.line([start, end], fill=fill, width=width)
    x1, y1 = start
    x2, y2 = end
    if abs(x2 - x1) >= abs(y2 - y1):
        direction = 1 if x2 > x1 else -1
        tip = (x2, y2)
        points = [tip, (x2 - 15 * direction, y2 - 9), (x2 - 15 * direction, y2 + 9)]
    else:
        direction = 1 if y2 > y1 else -1
        tip = (x2, y2)
        points = [tip, (x2 - 9, y2 - 15 * direction), (x2 + 9, y2 - 15 * direction)]
    draw.polygon(points, fill=fill)


def add_label(draw, xy, text, fill=MUTED):
    draw.text(xy, text, font=font(16), fill=fill)


def workflow_figure():
    image = Image.new("RGB", (1800, 1240), "white")
    draw = ImageDraw.Draw(image)
    draw.text((70, 42), "Crossdating IDM: implemented data and decision flow", font=font(35, bold=True), fill=NAVY)
    draw.text((70, 90), "Code-derived overview of input, working-state, COFECHA, diagnostic, and user-confirmed paths", font=font(19), fill=MUTED)

    draw.rounded_rectangle((50, 140, 550, 1120), radius=24, fill="#FBFCFE", outline="#D6E2EC", width=2)
    draw.rounded_rectangle((620, 140, 1180, 1120), radius=24, fill="#FBFCFE", outline="#D6E2EC", width=2)
    draw.rounded_rectangle((1250, 140, 1750, 1120), radius=24, fill="#FBFCFE", outline="#D6E2EC", width=2)
    draw.text((78, 165), "1. Input and working state", font=font(23, bold=True), fill=NAVY)
    draw.text((648, 165), "2. Analytical services", font=font(23, bold=True), fill=NAVY)
    draw.text((1278, 165), "3. Reviewable outcomes", font=font(23, bold=True), fill=NAVY)

    rounded_box(draw, (100, 240, 500, 350), "RWL text input\nTucson | Compact | CSV\nHeidelberg | TRiDaS", PALE_BLUE, title=True)
    rounded_box(draw, (100, 425, 500, 555), "Format router and parser\ncommon Map<series, year/value>", PALE_BLUE)
    rounded_box(draw, (100, 635, 500, 805), "RwlEditor\nraw baseline + working data\nhistory + deletion markers\noperation log", PALE_GREEN, title=True)
    rounded_box(draw, (100, 885, 500, 1040), "Grid, text editor, and chart\nmanual raw-width mean reference\nuser-driven changes", PALE_GREEN)
    arrow(draw, (300, 350), (300, 425))
    arrow(draw, (300, 555), (300, 635))
    arrow(draw, (300, 805), (300, 885))

    rounded_box(draw, (680, 240, 1120, 375), "Current working RWL\nexported to selected COFECHA sidecar", PALE_ORANGE, title=True)
    rounded_box(draw, (680, 455, 1120, 620), "VERYCOF.OUT parser\nPART 1 summary | PART 3 master\nPART 6 problem blocks | PART 7 stats", PALE_ORANGE)
    rounded_box(draw, (680, 710, 1120, 860), "Dynamic reference state\nPART 3 master dating series used\nPART 6 A flags classified", PALE_ORANGE)
    rounded_box(draw, (680, 940, 1120, 1065), "Web Worker diagnosis\nlag scans + segments + constrained edits", PALE_BLUE)
    arrow(draw, (900, 375), (900, 455), ORANGE)
    arrow(draw, (900, 620), (900, 710), ORANGE)
    arrow(draw, (900, 860), (900, 940), BLUE)

    rounded_box(draw, (1310, 240, 1690, 395), "COFECHA report review\nlinked series/year navigation\nOUT persisted and mirrored", PALE_ORANGE, title=True)
    rounded_box(draw, (1310, 500, 1690, 680), "Candidate evidence\ninsert missing ring\ndelete false ring\nwhole or partial range move", PALE_BLUE, title=True)
    rounded_box(draw, (1310, 780, 1690, 930), "Optional Bayesian MCMC\nRust multi-chain start-year\nposterior and R-hat diagnostics", PALE_GREEN)
    rounded_box(draw, (1310, 1010, 1690, 1100), "User selects an action\nRwlEditor records change\nold candidates become stale", PALE_GREEN, title=True)
    arrow(draw, (1500, 395), (1500, 500), ORANGE)
    arrow(draw, (1500, 680), (1500, 1010), BLUE)
    arrow(draw, (1500, 930), (1500, 1010), GREEN)

    arrow(draw, (500, 720), (680, 305), BLUE)
    arrow(draw, (500, 960), (680, 1000), BLUE)
    arrow(draw, (1120, 535), (1310, 315), ORANGE)
    arrow(draw, (1120, 785), (1310, 590), BLUE)
    arrow(draw, (1120, 1000), (1310, 855), GREEN)
    arrow(draw, (1310, 1055), (500, 1045), GREEN)

    add_label(draw, (95, 1150), "Persistent workspace state: history snapshots, references, COFECHA report, and operation records are keyed by file path in local storage.")
    image.save(OUT / "crossdating-idm-workflow.png")


def validation_figure():
    image = Image.new("RGB", (1800, 1180), "white")
    draw = ImageDraw.Draw(image)
    draw.text((70, 42), "Crossdating IDM: code-based verification outputs", font=font(35, bold=True), fill=NAVY)
    draw.text((70, 90), "Repository commands executed on 26 June 2026; values describe included fixtures rather than independent performance estimates", font=font(19), fill=MUTED)

    draw.rounded_rectangle((60, 145, 1135, 915), radius=24, fill="#FBFCFE", outline="#D6E2EC", width=2)
    draw.text((100, 180), "Internal flagged problem segments in supplied RWL pairs", font=font(25, bold=True), fill=NAVY)
    draw.text((100, 220), "raw input", font=font(18, bold=True), fill=BLUE)
    draw.text((245, 220), "supplied crossdated input", font=font(18, bold=True), fill=TEAL)
    draw.rectangle((100, 255, 130, 275), fill=BLUE)
    draw.rectangle((235, 255, 265, 275), fill=TEAL)

    sites = ["EBD", "EBM", "EBU", "RDD", "RDM", "RDU", "ZSD", "ZSL"]
    raw = [142, 94, 103, 97, 113, 99, 51, 79]
    cross = [14, 8, 5, 13, 5, 5, 1, 1]
    x0, y0, width, row_h = 210, 330, 740, 64
    max_v = 150
    for tick in range(0, 151, 25):
        x = x0 + width * tick / max_v
        draw.line((x, y0 - 22, x, y0 + row_h * len(sites) - 5), fill="#DFE7EF", width=1)
        tw = draw.textbbox((0, 0), str(tick), font=font(15))[2]
        draw.text((x - tw / 2, y0 - 50), str(tick), font=font(15), fill=MUTED)
    for i, site in enumerate(sites):
        y = y0 + i * row_h
        draw.text((112, y + 12), site, font=font(18, bold=True), fill=INK)
        raw_w = width * raw[i] / max_v
        cross_w = width * cross[i] / max_v
        draw.rounded_rectangle((x0, y + 3, x0 + raw_w, y + 25), radius=5, fill=BLUE)
        draw.rounded_rectangle((x0, y + 32, x0 + cross_w, y + 54), radius=5, fill=TEAL)
        draw.text((x0 + raw_w + 8, y + 3), str(raw[i]), font=font(16, bold=True), fill=BLUE)
        draw.text((x0 + cross_w + 8, y + 32), str(cross[i]), font=font(16, bold=True), fill=TEAL)
    draw.text((100, 850), "Aggregate: 778 raw flagged segments -> 52 supplied-crossdated flagged segments; 529 -> 14 diagnostic candidates.", font=font(18, bold=True), fill=INK)
    draw.text((100, 880), "This is a regression-screening result, not sensitivity, specificity, or independent crossdating accuracy.", font=font(17), fill=MUTED)

    draw.rounded_rectangle((1190, 145, 1740, 650), radius=24, fill="#FBFCFE", outline="#D6E2EC", width=2)
    draw.text((1230, 180), "COFECHA sidecar validation", font=font(25, bold=True), fill=NAVY)
    draw.text((1230, 225), "Supplied crossdated RWL files", font=font(18), fill=MUTED)
    draw.rounded_rectangle((1230, 280, 1695, 400), radius=16, fill=PALE_GREEN, outline="#B7D6BF", width=2)
    center_text(draw, (1230, 280, 1695, 400), "7 / 8 datasets\n0 PART 6 A/problem flags", font(27, bold=True), fill=GREEN)
    draw.rounded_rectangle((1230, 435, 1695, 555), radius=16, fill=PALE_ORANGE, outline="#F1CCAD", width=2)
    center_text(draw, (1230, 435, 1695, 555), "EBD retained 1 A/problem flag\nseries: EBD011", font(24, bold=True), fill=ORANGE)
    draw.text((1230, 595), "Command: npm run validate:cofecha:samples", font=font(16), fill=MUTED)

    draw.rounded_rectangle((1190, 690, 1740, 1080), radius=24, fill="#FBFCFE", outline="#D6E2EC", width=2)
    draw.text((1230, 725), "Additional checks completed", font=font(25, bold=True), fill=NAVY)
    checks = [
        ("Production build", "551 modules transformed"),
        ("Rust Bayesian MCMC", "7 unit tests passed"),
        ("Synthetic diagnosis", "clean, missing, false, global, whole, partial moves"),
        ("Dynamic reference", "PART 6 classification and 57-point fixture"),
        ("Workspace bridge", "SSR smoke check passed"),
    ]
    y = 782
    for title, detail in checks:
        draw.ellipse((1232, y + 5, 1248, y + 21), fill=GREEN)
        draw.text((1265, y), title, font=font(18, bold=True), fill=INK)
        draw.text((1265, y + 25), detail, font=font(16), fill=MUTED)
        y += 62
    image.save(OUT / "crossdating-idm-validation.png")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    workflow_figure()
    validation_figure()
    print(OUT)


if __name__ == "__main__":
    main()
