import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const TMP_DIR = "D:/Code/Crossdating_Tauri_js-diagnosis-events-v1/.codex-tmp/conference-slides-20260818";
const OUTPUT_DIR = "D:/Code/Crossdating_Tauri_js-diagnosis-events-v1/docs/conference-dating-recommendation-flow-v1";
const PPTX_PATH = path.join(TMP_DIR, "dating-recommendation-flow-draft.pptx");
const LAYOUT_DIR = path.join(TMP_DIR, "layouts");

const W = 1280;
const H = 720;

const C = {
  paper: "#F4F1E8",
  paper2: "#ECE8DC",
  white: "#FCFBF6",
  ink: "#172B2A",
  ink2: "#40514D",
  muted: "#6D7873",
  rule: "#C8C6BB",
  moss: "#6F8050",
  mossLight: "#E4E8D5",
  teal: "#2F7E78",
  tealLight: "#DDECE8",
  coral: "#C7614F",
  coralLight: "#F3DDD6",
  amber: "#C79236",
  amberLight: "#F1E4C5",
  plum: "#75658B",
  plumLight: "#E7E0ED",
  blue: "#4D7A99",
  blueLight: "#DDE7EC",
  lime: "#BDD46F",
  limeLight: "#EDF2D4",
  red: "#A94336",
};

let objectCounter = 0;
const nextName = (prefix) => `${prefix}-${String(++objectCounter).padStart(4, "0")}`;

function addText(slide, text, x, y, w, h, opts = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    name: opts.name || nextName("text"),
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  box.text = text;
  box.text.style = {
    fontSize: opts.size ?? 18,
    bold: opts.bold ?? false,
    italic: opts.italic ?? false,
    color: opts.color ?? C.ink,
    alignment: opts.align ?? "left",
  };
  return box;
}

function addBox(slide, x, y, w, h, opts = {}) {
  const geometry = opts.geometry || "roundRect";
  const config = {
    geometry,
    name: opts.name || nextName("shape"),
    position: { left: x, top: y, width: w, height: h, rotation: opts.rotation || 0 },
    fill: opts.fill ?? C.white,
    line: {
      style: opts.dashed ? "dashed" : "solid",
      fill: opts.line ?? C.rule,
      width: opts.lineWidth ?? 1,
    },
    shadow: opts.shadow || "shadow-none",
  };
  if (["rect", "textbox", "roundRect"].includes(geometry)) {
    config.borderRadius = opts.radius ?? "rounded-xl";
  }
  const box = slide.shapes.add(config);
  return box;
}

function addLine(slide, x1, y1, x2, y2, opts = {}) {
  return slide.shapes.add({
    geometry: "line",
    name: opts.name || nextName("line"),
    position: { left: x1, top: y1, width: x2 - x1, height: y2 - y1 },
    fill: "none",
    line: {
      style: opts.dashed ? "dashed" : "solid",
      fill: opts.color ?? C.rule,
      width: opts.width ?? 1,
    },
  });
}

function addDot(slide, cx, cy, r, fill, line = fill) {
  return addBox(slide, cx - r, cy - r, 2 * r, 2 * r, {
    geometry: "ellipse",
    fill,
    line,
    lineWidth: 1,
    radius: 0,
  });
}

function addRing(slide, cx, cy, diameter, color = C.rule, width = 1) {
  return addBox(slide, cx - diameter / 2, cy - diameter / 2, diameter, diameter, {
    geometry: "ellipse",
    fill: "none",
    line: color,
    lineWidth: width,
    radius: 0,
  });
}

function addPill(slide, text, x, y, w, fill, color = C.ink, line = fill) {
  const p = addBox(slide, x, y, w, 28, { fill, line, radius: "rounded-full" });
  const t = addText(slide, text, x + 8, y + 5, w - 16, 18, { size: 13, bold: true, color, align: "center" });
  return { p, t };
}

function addTitleChrome(slide, index, title, kicker = "定年建议输出主链") {
  addText(slide, kicker, 68, 23, 620, 20, { size: 12, bold: true, color: C.teal });
  addText(slide, title, 68, 46, 1132, 51, { size: 35, bold: true, color: C.ink });
  addLine(slide, 68, 108, 1212, 108, { color: C.ink, width: 1.2 });
  addText(slide, String(index).padStart(2, "0"), 1180, 22, 32, 22, { size: 14, bold: true, color: C.muted, align: "right" });
  addText(slide, "Crossdating-IDM · 当前实现核对日期 2026-08-18", 68, 686, 650, 16, { size: 10, color: C.muted });
  addText(slide, `${index}/10`, 1150, 686, 62, 16, { size: 10, color: C.muted, align: "right" });
}

function addSourceNotes(slide, lines, extra = "") {
  const note = ["[Sources]", ...lines.map((x) => `- ${x}`), extra].filter(Boolean).join("\n");
  slide.speakerNotes.textFrame.setText(note);
  slide.speakerNotes.setVisible(true);
}

function addBackgroundMotif(slide, variant = 0) {
  slide.background.fill = C.paper;
  if (variant % 3 === 0) {
    addRing(slide, 1128, 630, 310, C.paper2, 2);
    addRing(slide, 1128, 630, 238, C.rule, 1);
    addRing(slide, 1128, 630, 166, C.paper2, 2);
    addDot(slide, 1180, 570, 20, C.limeLight, C.limeLight);
  } else if (variant % 3 === 1) {
    addRing(slide, 120, 615, 260, C.paper2, 2);
    addRing(slide, 120, 615, 188, C.rule, 1);
    addDot(slide, 185, 590, 15, C.tealLight, C.tealLight);
  } else {
    addRing(slide, 1160, 160, 230, C.paper2, 2);
    addRing(slide, 1160, 160, 150, C.rule, 1);
    addDot(slide, 1100, 165, 16, C.coralLight, C.coralLight);
  }
}

function connect(slide, from, to, opts = {}) {
  return slide.shapes.connect(from, to, {
    kind: opts.kind || "straight",
    fromSide: opts.fromSide,
    toSide: opts.toSide,
    line: { style: opts.dashed ? "dashed" : "solid", fill: opts.color || C.ink2, width: opts.width || 1.5 },
    head: opts.noHead ? { type: "none" } : { type: "triangle", width: "sm", length: "sm" },
  });
}

function drawSequence(slide, x, y, values, color, opts = {}) {
  const spacing = opts.spacing || 26;
  const size = opts.size || 16;
  values.forEach((value, i) => {
    const bx = x + i * spacing;
    const fill = value === "gap" ? C.paper : color;
    const line = value === "gap" ? color : color;
    addBox(slide, bx, y, size, size, { geometry: "ellipse", fill, line, lineWidth: value === "gap" ? 2 : 1, radius: 0 });
    if (value !== "gap" && value !== "") {
      addText(slide, String(value), bx - 4, y + 19, size + 8, 14, { size: 9, color: C.muted, align: "center" });
    }
  });
}

function drawStepPath(slide, x, y, w, h, states, color, opts = {}) {
  const min = Math.min(...states, 0);
  const max = Math.max(...states, 0);
  const span = Math.max(1, max - min);
  const dx = w / states.length;
  const yFor = (v) => y + h - ((v - min) / span) * h;
  addLine(slide, x, yFor(0), x + w, yFor(0), { color: C.rule, width: 1, dashed: true });
  for (let i = 0; i < states.length; i++) {
    const x1 = x + i * dx;
    const x2 = x + (i + 1) * dx;
    const yy = yFor(states[i]);
    addLine(slide, x1, yy, x2, yy, { color, width: opts.width || 3 });
    if (i < states.length - 1 && states[i + 1] !== states[i]) {
      addLine(slide, x2, yy, x2, yFor(states[i + 1]), { color, width: opts.width || 3 });
    }
  }
  return yFor;
}

function drawMiniLinePlot(slide, x, y, w, h, values, color, markerIndex = null) {
  addLine(slide, x, y + h, x + w, y + h, { color: C.ink2, width: 1 });
  addLine(slide, x, y, x, y + h, { color: C.ink2, width: 1 });
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(0.001, max - min);
  for (let i = 0; i < values.length - 1; i++) {
    const x1 = x + (i / (values.length - 1)) * w;
    const x2 = x + ((i + 1) / (values.length - 1)) * w;
    const y1 = y + h - ((values[i] - min) / span) * h;
    const y2 = y + h - ((values[i + 1] - min) / span) * h;
    addLine(slide, x1, y1, x2, y2, { color, width: 2.5 });
  }
  if (markerIndex !== null) {
    const mx = x + (markerIndex / (values.length - 1)) * w;
    const my = y + h - ((values[markerIndex] - min) / span) * h;
    addDot(slide, mx, my, 5, color);
    addLine(slide, mx, my + 8, mx, y + h, { color, width: 1, dashed: true });
  }
}

function addKeyValue(slide, label, value, x, y, w, accent = C.teal) {
  addText(slide, label.toUpperCase(), x, y, w, 16, { size: 10, bold: true, color: C.muted });
  addText(slide, value, x, y + 17, w, 34, { size: 23, bold: true, color: accent });
}

const presentation = Presentation.create({ slideSize: { width: W, height: H } });

// Slide 1 — title
{
  const slide = presentation.slides.add();
  slide.background.fill = C.paper;
  for (const d of [690, 570, 470, 365, 275, 190, 115]) addRing(slide, 1035, 410, d, d % 2 ? C.rule : C.paper2, d === 690 ? 2 : 1);
  drawStepPath(slide, 790, 320, 410, 180, [-4, -4, -4, -1, -1, 0, 0, 0], C.teal, { width: 5 });
  addDot(slide, 995, 410, 13, C.coral, C.coral);
  addDot(slide, 1148, 500, 11, C.amber, C.amber);
  addText(slide, "CROSSDATING–IDM · 定年建议模块", 70, 58, 500, 26, { size: 16, bold: true, color: C.teal });
  addText(slide, "从 lag 异常\n到可审计的\n定年建议", 70, 126, 670, 238, { size: 54, bold: true, color: C.ink });
  addText(slide, "一条事件级决策主链：识别结构、验证可执行编辑、定位安全复核窗，并把最终决定交还树轮专家。", 74, 392, 600, 92, { size: 22, color: C.ink2 });
  addLine(slide, 74, 518, 640, 518, { color: C.ink, width: 1.3 });
  addText(slide, "当前工作 RWL", 74, 540, 150, 20, { size: 12, bold: true, color: C.muted });
  addText(slide, "→", 225, 536, 30, 24, { size: 18, bold: true, color: C.teal, align: "center" });
  addText(slide, "一个复核事件", 260, 540, 190, 20, { size: 12, bold: true, color: C.muted });
  addText(slide, "→", 454, 536, 30, 24, { size: 18, bold: true, color: C.teal, align: "center" });
  addText(slide, "可审计编辑", 492, 540, 150, 20, { size: 12, bold: true, color: C.muted });
  addText(slide, "大会汇报视觉初稿 · 仅聚焦定年建议模块", 74, 661, 550, 20, { size: 11, color: C.muted });
  addText(slide, "01/10", 1144, 661, 68, 20, { size: 11, bold: true, color: C.muted, align: "right" });
  addSourceNotes(slide, [
    "docs/index.md — module positioning and event-level decision-support scope.",
    "docs/定年建议输出流程.md — audited output pipeline, 2026-08-18.",
  ], "Visual is schematic; no benchmark values are shown.");
}

// Slide 2 — four questions
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 2);
  addTitleChrome(slide, 2, "一条建议必须按顺序回答四个问题");

  const nodes = [];
  const xs = [90, 330, 570, 810];
  const colors = [C.blue, C.coral, C.plum, C.teal];
  const lights = [C.blueLight, C.coralLight, C.plumLight, C.tealLight];
  const nums = ["01", "02", "03", "04"];
  const labels = ["是否存在", "执行何种操作", "位移多少", "在哪里复核"];
  const questions = [
    "是否存在持续性的定年事件？",
    "哪种可执行编辑最能解释它？",
    "应移动几年，又要固定哪一侧？",
    "专家应该在哪一小段集中复核？",
  ];
  const evidence = [
    "整体与分段 lag 结构",
    "插入 / 删除 / 局部移动 / 整体移动",
    "有符号平台 + 编辑反事实",
    "唯一 5 / 7 / 9 / 13 年复核窗",
  ];

  for (let i = 0; i < 4; i++) {
    addBox(slide, xs[i], 175, 188, 300, { geometry: "ellipse", fill: lights[i], line: lights[i], radius: 0 });
    const node = addBox(slide, xs[i] + 65, 148, 58, 58, { geometry: "ellipse", fill: colors[i], line: colors[i], radius: 0 });
    nodes.push(node);
    addText(slide, nums[i], xs[i] + 65, 164, 58, 24, { size: 16, bold: true, color: C.white, align: "center" });
    addText(slide, labels[i], xs[i] + 20, 235, 148, 24, { size: 15, bold: true, color: colors[i], align: "center" });
    addText(slide, questions[i], xs[i] + 24, 278, 140, 76, { size: 19, bold: true, color: C.ink, align: "center" });
    addLine(slide, xs[i] + 54, 365, xs[i] + 134, 365, { color: colors[i], width: 1.5 });
    addText(slide, evidence[i], xs[i] + 20, 384, 148, 58, { size: 14, color: C.ink2, align: "center" });
  }
  for (let i = 0; i < 3; i++) connect(slide, nodes[i], nodes[i + 1], { fromSide: "right", toSide: "left", color: C.ink2, width: 1.2 });
  nodes.forEach((n) => n.bringToFront());

  addBox(slide, 1030, 166, 185, 304, { fill: C.ink, line: C.ink, radius: "rounded-2xl" });
  addText(slide, "唯一\n复核\n事件", 1053, 204, 140, 100, { size: 27, bold: true, color: C.white, align: "center" });
  addLine(slide, 1060, 321, 1188, 321, { color: C.lime, width: 2 });
  addText(slide, "事件类型\n位移量\n主复核窗\n年份排序\n证据账本", 1064, 344, 120, 105, { size: 14, color: C.white, align: "left" });

  addText(slide, "流程不会把最高分年份直接显示成最终建议。", 92, 515, 760, 34, { size: 23, bold: true, color: C.ink });
  addText(slide, "它比较的是完整的“操作 × 位移 × 位置”假设；当操作类型或远端位置仍存在冲突时，程序可以拒答。", 92, 555, 1000, 54, { size: 18, color: C.ink2 });
  addPill(slide, "不是强制精确年份", 92, 624, 230, C.coralLight, C.red, C.coral);
  addPill(slide, "不是后验正确概率", 336, 624, 254, C.amberLight, C.ink, C.amber);
  addPill(slide, "一次只处理当前前沿", 605, 624, 220, C.tealLight, C.teal, C.teal);
  addSourceNotes(slide, [
    "docs/index.md — four decision requirements: event, operation, shift, location.",
    "docs/定年建议输出流程.md — candidate/event/review-event distinction and operation-first adjudication.",
  ]);
}

// Slide 3 — inputs and reference
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 1);
  addTitleChrome(slide, 3, "诊断从当前工作 RWL 与动态参考年表开始");

  addText(slide, "输入 A", 72, 137, 120, 18, { size: 11, bold: true, color: C.blue });
  const working = addBox(slide, 72, 160, 300, 166, { fill: C.blueLight, line: C.blue, radius: "rounded-2xl" });
  addText(slide, "当前工作 RWL", 96, 185, 250, 30, { size: 24, bold: true, color: C.ink });
  addText(slide, "• 读取当前 siteData，而不是 raw baseline\n• 仅普通计算有限数值且宽度 > 0\n• 0 值仍保留为显式缺轮标记\n• 只诊断当前目标，但保留整站样芯供参考", 96, 228, 246, 87, { size: 15, color: C.ink2 });

  addText(slide, "输入 B", 72, 355, 120, 18, { size: 11, bold: true, color: C.moss });
  const refSource = addBox(slide, 72, 378, 300, 196, { fill: C.mossLight, line: C.moss, radius: "rounded-2xl" });
  addText(slide, "参考来源", 96, 401, 240, 30, { size: 24, bold: true, color: C.ink });
  addText(slide, "正常路径", 96, 445, 90, 19, { size: 13, bold: true, color: C.moss });
  addText(slide, "COFECHA PART 3 master + PART 6 锚定/标记分类", 190, 445, 154, 42, { size: 14, color: C.ink2 });
  addText(slide, "冷启动", 96, 505, 90, 19, { size: 13, bold: true, color: C.moss });
  addText(slide, "未标记芯少于 3 条时 pairwise bootstrap；目标芯不进入自己的临时 master", 190, 505, 158, 57, { size: 14, color: C.ink2 });

  const chronology = addBox(slide, 474, 212, 340, 300, { geometry: "ellipse", fill: C.white, line: C.teal, lineWidth: 2, radius: 0 });
  addText(slide, "动态\n参考年表", 544, 260, 200, 62, { size: 23, bold: true, color: C.teal, align: "center" });
  addText(slide, "32 年样条 / 50% 响应\nraw ÷ trend → 无量纲指数\nAR(p)，p=1…5，AIC 选阶\n默认 log transform\n逐年平均，replication ≥3\n最终 mean 0、SD 1", 538, 340, 212, 133, { size: 15, color: C.ink2, align: "center" });
  connect(slide, working, chronology, { fromSide: "right", toSide: "left", color: C.blue, width: 2 });
  connect(slide, refSource, chronology, { fromSide: "right", toSide: "left", color: C.moss, width: 2 });
  working.bringToFront(); refSource.bringToFront(); chronology.bringToFront();

  const gate = addBox(slide, 905, 194, 300, 340, { fill: C.ink, line: C.ink, radius: "rounded-2xl" });
  addText(slide, "诊断入口门控", 934, 224, 240, 21, { size: 13, bold: true, color: C.lime });
  addText(slide, "已选定目标芯\n+ 动态参考存在 points\n+ JS 诊断已开启", 934, 266, 240, 84, { size: 23, bold: true, color: C.white, align: "center" });
  addLine(slide, 947, 373, 1160, 373, { color: C.lime, width: 1.5 });
  addText(slide, "40 ms 防抖", 934, 390, 240, 22, { size: 15, color: C.white, align: "center" });
  addText(slide, "专用 Web Worker", 934, 425, 240, 26, { size: 18, bold: true, color: C.white, align: "center" });
  addText(slide, "没有动态参考 points → 不输出事件诊断", 934, 473, 240, 32, { size: 14, color: C.coralLight, align: "center" });
  connect(slide, chronology, gate, { fromSide: "right", toSide: "left", color: C.teal, width: 2 });
  chronology.bringToFront(); gate.bringToFront();

  addBox(slide, 474, 562, 731, 89, { fill: C.amberLight, line: C.amber, radius: "rounded-xl" });
  addText(slide, "当前实现边界", 497, 579, 180, 20, { size: 13, bold: true, color: C.amber });
  addText(slide, "COFECHA OUT 原文不生成、也不评分编辑操作。编辑后会排除过期 OUT，但已标记 stale 的动态参考点仍可能继续使用，直到重新运行 COFECHA。", 497, 605, 680, 40, { size: 15, color: C.ink });
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 0–2, dynamic-reference construction and freshness boundary.",
    "docs/index.md — COFECHA integration and reference-series role.",
  ]);
}

// Slide 4 — detection
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 0);
  addTitleChrome(slide, 4, "整体与分段 lag 扫描把错配转化为结构性报警");

  addText(slide, "1 · 整体基线", 72, 134, 260, 20, { size: 12, bold: true, color: C.teal });
  addText(slide, "将目标序列在 −100 到 +100 年之间整体滑动", 72, 159, 440, 28, { size: 20, bold: true, color: C.ink });
  addText(slide, "至少 25 对有效年份；依次比较 t-like 支持、重叠长度与 |lag|。", 72, 191, 440, 36, { size: 14, color: C.ink2 });
  const lagValues = [0.09,0.12,0.14,0.18,0.21,0.32,0.47,0.72,0.93,0.68,0.36,0.22,0.18,0.15,0.13,0.11,0.10];
  drawMiniLinePlot(slide, 94, 259, 402, 148, lagValues, C.teal, 8);
  addText(slide, "−100", 83, 417, 50, 17, { size: 11, color: C.muted });
  addText(slide, "0", 283, 417, 30, 17, { size: 11, color: C.muted, align: "center" });
  addText(slide, "+100", 452, 417, 52, 17, { size: 11, color: C.muted, align: "right" });
  addPill(slide, "示意峰值：lag −4", 200, 445, 208, C.tealLight, C.teal, C.teal);

  addText(slide, "2 · 重叠分段", 568, 134, 300, 20, { size: 12, bold: true, color: C.blue });
  addText(slide, "50 年窗口，重叠 25 年", 568, 159, 350, 28, { size: 20, bold: true, color: C.ink });
  addText(slide, "每个窗口独立扫描 lag −100…+10，并比较当前位置 r₀ 与最佳移动匹配。", 568, 191, 350, 55, { size: 14, color: C.ink2 });
  const years = ["1900–49", "1925–74", "1950–99", "1975–24"];
  years.forEach((yr, i) => {
    const yy = 278 + i * 66;
    addText(slide, yr, 568, yy + 6, 80, 18, { size: 12, color: C.muted });
    addBox(slide, 658 + i * 34, yy, 220, 28, { fill: i < 2 ? C.coralLight : C.tealLight, line: i < 2 ? C.coral : C.teal, radius: "rounded-full" });
    addText(slide, i < 2 ? "最佳 lag −4 · B-like" : "lag 0 · 无报警", 678 + i * 34, yy + 6, 180, 16, { size: 11, bold: true, color: i < 2 ? C.red : C.teal, align: "center" });
  });

  addText(slide, "3 · 结构性报警", 956, 134, 260, 20, { size: 12, bold: true, color: C.coral });
  addBox(slide, 954, 162, 260, 112, { fill: C.coralLight, line: C.coral, radius: "rounded-2xl" });
  addText(slide, "B-like", 978, 182, 90, 24, { size: 23, bold: true, color: C.coral });
  addText(slide, "非零 lag 带来可信且稳定的相关改善", 978, 218, 210, 44, { size: 15, color: C.ink2 });
  addBox(slide, 954, 292, 260, 112, { fill: C.amberLight, line: C.amber, radius: "rounded-2xl" });
  addText(slide, "A-like", 978, 312, 90, 24, { size: 23, bold: true, color: C.amber });
  addText(slide, "相关偏低，但移动年份仍无法解释问题", 978, 348, 210, 44, { size: 15, color: C.ink2 });
  addText(slide, "A-like 永远不会直接生成编辑。", 958, 421, 250, 24, { size: 14, bold: true, color: C.red, align: "center" });

  addBox(slide, 72, 509, 1142, 139, { fill: C.white, line: C.rule, radius: "rounded-2xl" });
  addText(slide, "传播模式（propagation pattern）", 97, 530, 250, 18, { size: 12, bold: true, color: C.plum });
  drawStepPath(slide, 330, 544, 550, 64, [-4,-4,-4,-4,0,0,0,0], C.plum, { width: 4 });
  addText(slide, "较老侧：稳定 lag −4", 323, 615, 230, 18, { size: 12, color: C.muted });
  addText(slide, "较新侧：lag 0", 704, 615, 180, 18, { size: 12, color: C.muted, align: "right" });
  addText(slide, "≥2 个相邻、同方向 B-like 窗口\n→ 主导 lag + 一致性\n→ 局部移动草案", 930, 538, 245, 82, { size: 17, bold: true, color: C.ink });
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 3–8, global scan, 50/25 segmentation, A-like/B-like and propagation.",
  ], "Lag profile and segment paths are schematic, not measured results.");
}

// Slide 5 — executable hypotheses
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 2);
  addTitleChrome(slide, 5, "报警被翻译成真正可执行的编辑假设");
  addText(slide, "三条草案通道", 72, 135, 180, 20, { size: 12, bold: true, color: C.muted });
  addPill(slide, "整体滑动", 72, 166, 175, C.blueLight, C.blue, C.blue);
  addPill(slide, "传播模式", 260, 166, 175, C.plumLight, C.plum, C.plum);
  addPill(slide, "孤立 B-like", 448, 166, 190, C.coralLight, C.coral, C.coral);
  addText(slide, "→  每份草案必须映射为 RWL 编辑器已经支持的实际操作", 668, 168, 520, 24, { size: 18, bold: true, color: C.ink });

  const rows = [
    { y: 225, color: C.teal, light: C.tealLight, code: "M", title: "缺轮", lag: "ΔL = −1", action: "在 c 年插入 0；较老侧整体 −1 年", meaning: "未形成或测量时漏掉极窄轮" },
    { y: 329, color: C.coral, light: C.coralLight, code: "F", title: "伪轮", lag: "ΔL = +1", action: "删除 c 年；较老侧整体 +1 年", meaning: "年内密度界或重复划分" },
    { y: 433, color: C.plum, light: C.plumLight, code: "P", title: "局部移动", lag: "ΔL ≤ −2", action: "较老区间移动 k 年；较新侧固定", meaning: "腐朽、断裂、连续缺段或拼接" },
    { y: 537, color: C.amber, light: C.amberLight, code: "W", title: "整体移动", lag: "全序列恒定负 lag", action: "整条序列移动 k 年；位移必须精确", meaning: "树皮/边材缺失、树皮侧断裂或死亡" },
  ];
  rows.forEach((r, i) => {
    addBox(slide, 72, r.y, 1142, 84, { fill: r.light, line: r.color, radius: "rounded-xl" });
    addBox(slide, 88, r.y + 12, 58, 58, { geometry: "ellipse", fill: r.color, line: r.color, radius: 0 });
    addText(slide, r.code, 88, r.y + 27, 58, 25, { size: 20, bold: true, color: C.white, align: "center" });
    addText(slide, r.title, 166, r.y + 15, 185, 26, { size: 22, bold: true, color: C.ink });
    addText(slide, r.lag, 166, r.y + 48, 185, 18, { size: 14, bold: true, color: r.color });
    drawSequence(slide, 380, r.y + 23, i === 0 ? [1,2,"gap",4,5,6] : i === 1 ? [1,2,3,3,4,5] : [1,2,"gap","gap",5,6] , r.color, { spacing: 31, size: 17 });
    if (i === 3) drawSequence(slide, 380, r.y + 23, [1,2,3,4,5,6], r.color, { spacing: 31, size: 17 });
    addText(slide, r.action, 603, r.y + 15, 330, 43, { size: 17, bold: true, color: C.ink });
    addText(slide, r.meaning, 944, r.y + 17, 236, 43, { size: 15, color: C.ink2 });
  });
  addText(slide, "候选生成不会只猜一年：传播模式附近最多预扫描 5 个插入/删除年份，孤立 B-like 分段附近最多预扫描 6 个年份。", 72, 638, 1090, 33, { size: 14, color: C.muted });
  addSourceNotes(slide, [
    "docs/index.md — event definitions and coordinate-transform semantics.",
    "docs/定年建议输出流程.md — step 9, draft channels and executable operation constraints.",
  ], "Timeline symbols are schematic.");
}

// Slide 6 — sandbox and gates
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 0);
  addTitleChrome(slide, 6, "每个假设都要在沙盘中真正试改，并完整重新诊断");

  const processNodes = [];
  const process = [
    { x: 72, title: "复制", body: "复制整份 siteData" },
    { x: 224, title: "试改", body: "只修改目标样芯副本" },
    { x: 376, title: "复诊", body: "重新运行 diagnoseSeriesCore" },
  ];
  process.forEach((p, i) => {
    const n = addBox(slide, p.x, 156, 128, 84, { fill: i === 1 ? C.coralLight : C.blueLight, line: i === 1 ? C.coral : C.blue, radius: "rounded-xl" });
    processNodes.push(n);
    addText(slide, p.title, p.x + 10, 173, 108, 20, { size: 15, bold: true, color: i === 1 ? C.coral : C.blue, align: "center" });
    addText(slide, p.body, p.x + 12, 204, 104, 28, { size: 13, color: C.ink2, align: "center" });
  });
  connect(slide, processNodes[0], processNodes[1], { fromSide: "right", toSide: "left", color: C.ink2 });
  connect(slide, processNodes[1], processNodes[2], { fromSide: "right", toSide: "left", color: C.ink2 });
  processNodes.forEach((n) => n.bringToFront());
  addText(slide, "任何沙盘试改都不会写入工作 RWL。", 72, 258, 432, 24, { size: 15, bold: true, color: C.teal, align: "center" });

  addRing(slide, 370, 468, 310, C.rule, 1.5);
  addRing(slide, 370, 468, 170, C.teal, 2.5);
  addText(slide, "≥ 3 / 7", 310, 435, 120, 38, { size: 30, bold: true, color: C.teal, align: "center" });
  addText(slide, "硬门条件", 305, 483, 130, 20, { size: 12, bold: true, color: C.muted, align: "center" });
  const gates = [
    ["平均分段 r ↑", 370, 290],
    ["B-like 数量 ↓", 520, 350],
    ["传播模式减弱", 545, 475],
    ["|lag| → 0", 470, 600],
    ["整体 r 降幅 ≤ 0.02", 265, 630],
    ["边界局部 r ↑", 165, 515],
    ["不制造新强 B-like", 170, 365],
  ];
  gates.forEach(([label, gx, gy], i) => {
    const col = i === 6 ? C.coral : C.moss;
    addDot(slide, gx, gy, 8, col);
    const tx = gx < 370 ? gx - 118 : gx + 12;
    addText(slide, label, tx, gy - 10, 112, 26, { size: 13, bold: true, color: C.ink2, align: gx < 370 ? "right" : "left" });
    addLine(slide, gx, gy, 370 + (gx - 370) * 0.46, 468 + (gy - 468) * 0.46, { color: C.rule, width: 1 });
  });

  addBox(slide, 690, 150, 520, 238, { fill: C.white, line: C.ink2, radius: "rounded-2xl" });
  addText(slide, "硬门 ≠ 排序分", 716, 175, 250, 28, { size: 25, bold: true, color: C.ink });
  addText(slide, "硬门决定候选有没有资格留下；\n分数只负责排列已经通过硬门的候选。", 716, 214, 450, 54, { size: 20, color: C.ink2 });
  const weights = [
    ["一阶差分整体一致性", "8.0", C.teal],
    ["平均分段相关改善", "3.0", C.blue],
    ["传播模式消解", "3.0", C.plum],
    ["lag 向 0 恢复", "2.5", C.moss],
    ["整条序列相关改善", "2.0", C.amber],
  ];
  weights.forEach((wgt, i) => {
    const yy = 286 + i * 22;
    addText(slide, wgt[0], 716, yy, 310, 18, { size: 13, color: C.ink2 });
    addBox(slide, 1038, yy + 2, Number(wgt[1]) * 19, 10, { fill: wgt[2], line: wgt[2], radius: "rounded-full" });
    addText(slide, wgt[1], 1140, yy - 1, 42, 18, { size: 12, bold: true, color: wgt[2], align: "right" });
  });

  addBox(slide, 690, 418, 520, 214, { fill: C.ink, line: C.ink, radius: "rounded-2xl" });
  addText(slide, "相对置信度", 716, 444, 280, 21, { size: 13, bold: true, color: C.lime });
  addText(slide, "probabilityLike", 716, 482, 220, 30, { size: 25, bold: true, color: C.white });
  addText(slide, "只是在当前幸存候选池内计算 softmax", 716, 520, 440, 24, { size: 17, color: C.white });
  addText(slide, "不是后验正确概率\n不能因此绕过事件层直接显示\n主路径中 COFECHA 年份提示贡献 = 0", 716, 556, 456, 66, { size: 15, color: C.coralLight });
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 10–13, sandbox edit, seven hard gates, scoring and probabilityLike.",
  ]);
}

// Slide 7 — eventization and path
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 1);
  addTitleChrome(slide, 7, "只有拓扑、反事实与多参考芯一致，候选才会成为事件");

  addText(slide, "候选云", 72, 137, 230, 18, { size: 12, bold: true, color: C.coral });
  const candidateYears = [1949,1950,1951,1952,1953,1954,1955];
  candidateYears.forEach((yr, i) => {
    const scoreSize = [13,18,22,30,25,17,12][i];
    const cx = 130 + (i % 3) * 88 + (i > 4 ? 30 : 0);
    const cy = 230 + Math.floor(i / 3) * 88;
    addDot(slide, cx, cy, scoreSize, i === 3 ? C.coral : C.coralLight, C.coral);
    addText(slide, String(yr), cx - 34, cy - 8, 68, 18, { size: 12, bold: i === 3, color: C.ink, align: "center" });
  });
  addText(slide, "每条目标芯最多保留 5 个\n相近且相容的候选\n→ 聚合为种子事件", 90, 472, 245, 65, { size: 16, color: C.ink2, align: "center" });
  addPill(slide, "种子窗：7年 / 7年 / 9年 / 整条", 88, 556, 250, C.coralLight, C.red, C.coral);

  addText(slide, "独立的分段 lag path", 394, 137, 360, 18, { size: 12, bold: true, color: C.plum });
  addBox(slide, 390, 164, 470, 355, { fill: C.white, line: C.rule, radius: "rounded-2xl" });
  addText(slide, "较老侧", 418, 182, 100, 18, { size: 11, color: C.muted });
  addText(slide, "较新侧", 731, 182, 100, 18, { size: 11, color: C.muted, align: "right" });
  drawStepPath(slide, 430, 243, 390, 122, [-2,-2,-2,-1,-1,0,0,0], C.plum, { width: 5 });
  addText(slide, "长时间稳定的整数状态", 430, 385, 180, 18, { size: 13, bold: true, color: C.plum });
  addText(slide, "稀疏的状态跳变", 655, 385, 165, 18, { size: 13, bold: true, color: C.plum, align: "right" });
  addLine(slide, 430, 420, 820, 420, { color: C.rule, width: 1 });
  addText(slide, "稳定状态默认至少约 18 年\n显式状态转换代价\n局部边界细化不超过 14 年\n不是无约束 DTW", 430, 438, 390, 70, { size: 15, color: C.ink2, align: "center" });

  addText(slide, "一致性证据", 916, 137, 270, 18, { size: 12, bold: true, color: C.teal });
  const evidenceItems = [
    ["候选反事实", "实际试改后是否真正改善"],
    ["raw + COFECHA-style path", "状态跳变是否持续存在"],
    ["逐参考芯投票", "信号能否在多条芯上重现"],
    ["位置剖面", "证据是否聚集于同一模式"],
    ["显式 0 值 ±2 年", "只做局部重排，不制造事件"],
  ];
  const evNodes = [];
  evidenceItems.forEach((e, i) => {
    const yy = 174 + i * 72;
    const n = addBox(slide, 916, yy, 280, 55, { fill: i % 2 ? C.tealLight : C.white, line: C.teal, radius: "rounded-xl" });
    evNodes.push(n);
    addText(slide, e[0], 934, yy + 8, 246, 18, { size: 15, bold: true, color: C.teal });
    addText(slide, e[1], 934, yy + 29, 246, 17, { size: 12, color: C.ink2 });
  });

  const hypothesis = addBox(slide, 438, 562, 704, 78, { fill: C.ink, line: C.ink, radius: "rounded-2xl" });
  addText(slide, "完整假设", 461, 579, 180, 18, { size: 12, bold: true, color: C.lime });
  addText(slide, "操作类型  ×  位移量  ×  位置", 659, 574, 450, 34, { size: 25, bold: true, color: C.white, align: "center" });
  addText(slide, "candidate IDs · lag before/after · 参考支持 · 不可变证据账本", 461, 614, 648, 18, { size: 13, color: C.white, align: "center" });
  connect(slide, evNodes[4], hypothesis, { fromSide: "bottom", toSide: "right", kind: "elbow", color: C.teal, width: 1.5 });
  hypothesis.bringToFront();
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 15–18 and 21, candidate eventization, constrained path, mixed-reference pass and evidence ledger.",
    "docs/index.md — lag-state topology grammar and multi-reference evidence roles.",
  ], "Candidate bubbles and lag path are schematic.");
}

// Slide 8 — adjudication
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 2);
  addTitleChrome(slide, 8, "联合裁决先决定操作，再决定位置；证据冲突时拒答");

  const op = addBox(slide, 70, 184, 260, 128, { fill: C.blueLight, line: C.blue, radius: "rounded-2xl" });
  addText(slide, "1 · 操作竞争", 92, 204, 220, 18, { size: 12, bold: true, color: C.blue });
  addText(slide, "缺轮\n伪轮\n局部移动 × k\n整体移动 × k", 92, 239, 220, 65, { size: 18, bold: true, color: C.ink, align: "center" });

  const opDecision = addBox(slide, 396, 194, 180, 108, { geometry: "diamond", fill: C.white, line: C.blue, lineWidth: 2, radius: 0 });
  addText(slide, "操作 margin\n≥ 0.04？", 432, 226, 108, 45, { size: 18, bold: true, color: C.ink, align: "center" });

  const loc = addBox(slide, 644, 184, 260, 128, { fill: C.plumLight, line: C.plum, radius: "rounded-2xl" });
  addText(slide, "2 · 位置竞争", 667, 204, 215, 18, { size: 12, bold: true, color: C.plum });
  addText(slide, "只有在操作与位移\n已经确定之后\n才比较不同位置模式", 667, 239, 215, 58, { size: 18, bold: true, color: C.ink, align: "center" });

  const locDecision = addBox(slide, 970, 194, 180, 108, { geometry: "diamond", fill: C.white, line: C.plum, lineWidth: 2, radius: 0 });
  addText(slide, "远端位置 margin\n≥ 0.04？", 1003, 226, 114, 45, { size: 17, bold: true, color: C.ink, align: "center" });

  connect(slide, op, opDecision, { fromSide: "right", toSide: "left", color: C.blue, width: 2 });
  connect(slide, opDecision, loc, { fromSide: "right", toSide: "left", color: C.ink2, width: 2 });
  connect(slide, loc, locDecision, { fromSide: "right", toSide: "left", color: C.plum, width: 2 });
  [op,opDecision,loc,locDecision].forEach((n) => n.bringToFront());

  addBox(slide, 404, 336, 165, 55, { fill: C.coralLight, line: C.coral, radius: "rounded-full" });
  addText(slide, "拒答：操作冲突", 414, 354, 145, 18, { size: 12, bold: true, color: C.red, align: "center" });
  addLine(slide, 486, 302, 486, 336, { color: C.coral, width: 1.5, dashed: true });
  addBox(slide, 978, 336, 165, 55, { fill: C.coralLight, line: C.coral, radius: "rounded-full" });
  addText(slide, "拒答：远端位置模式冲突", 988, 347, 145, 31, { size: 12, bold: true, color: C.red, align: "center" });
  addLine(slide, 1060, 302, 1060, 336, { color: C.coral, width: 1.5, dashed: true });

  addText(slide, "3 · 安全的主复核窗定位", 72, 430, 300, 18, { size: 12, bold: true, color: C.teal });
  const bands = [
    { x: 72, w: 420, label: "唯一 13 年物理位置模式", fill: C.tealLight, line: C.teal },
    { x: 158, w: 334, label: "9 年：仅在独立证据一致时缩窄", fill: C.mossLight, line: C.moss },
    { x: 250, w: 242, label: "7 年", fill: C.amberLight, line: C.amber },
    { x: 330, w: 162, label: "5 年", fill: C.coralLight, line: C.coral },
  ];
  bands.forEach((b, i) => {
    addBox(slide, b.x, 460 + i * 40, b.w, 28, { fill: b.fill, line: b.line, radius: "rounded-full" });
    addText(slide, b.label, b.x + 12, 466 + i * 40, b.w - 24, 17, { size: i === 0 ? 13 : 12, bold: true, color: C.ink, align: "center" });
  });
  addText(slide, "保留 13 年窗是诚实的保守选择，并不等于定位器自动失败。", 72, 627, 455, 38, { size: 15, bold: true, color: C.teal });

  addBox(slide, 602, 430, 612, 222, { fill: C.ink, line: C.ink, radius: "rounded-2xl" });
  addText(slide, "4 · 最终显示门", 630, 452, 190, 18, { size: 12, bold: true, color: C.lime });
  addText(slide, "窗宽 ∈ {5, 7, 9, 13}\nCOFECHA 标记  或  独立强权限证据\nstrict 事件  或  reviewOnly 单位事件\n不存在未解决的操作/远端位置冲突", 630, 490, 530, 104, { size: 18, bold: true, color: C.white });
  addLine(slide, 630, 612, 1160, 612, { color: C.lime, width: 1.5 });
  addText(slide, "输出  →  唯一主复核窗；否则拒答", 630, 621, 530, 21, { size: 15, bold: true, color: C.lime, align: "center" });
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 19–23, operation-first adjudication, 0.04 margins, safe 5/7/9/13 windows and display gate.",
  ]);
}

// Slide 9 — review
{
  const slide = presentation.slides.add();
  addBackgroundMotif(slide, 1);
  addTitleChrome(slide, 9, "用户复核的是一个窗口，而不是接受自动宣判");

  addBox(slide, 72, 146, 390, 474, { fill: C.white, line: C.teal, lineWidth: 2, radius: "rounded-2xl" });
  addText(slide, "主复核事件", 96, 168, 160, 18, { size: 12, bold: true, color: C.teal });
  addText(slide, "可能缺轮", 96, 201, 300, 31, { size: 27, bold: true, color: C.ink });
  addPill(slide, "9 年主窗口 · 1949–1957", 96, 246, 250, C.tealLight, C.teal, C.teal);
  addKeyValue(slide, "lag 状态", "−1 → 0", 96, 297, 120, C.plum);
  addKeyValue(slide, "事件证据", "高", 235, 297, 100, C.moss);
  addKeyValue(slide, "年份证据", "较一致", 96, 360, 240, C.blue);
  addLine(slide, 96, 419, 438, 419, { color: C.rule, width: 1 });
  addText(slide, "建议复核顺序", 96, 436, 240, 18, { size: 11, bold: true, color: C.muted });
  const years = [1952,1951,1953,1950,1954];
  years.forEach((yr, i) => {
    addBox(slide, 96 + i * 66, 470, 54, 48, { fill: i === 0 ? C.coral : C.coralLight, line: C.coral, radius: "rounded-xl" });
    addText(slide, `#${i+1}`, 103 + i * 66, 478, 40, 14, { size: 10, bold: true, color: i === 0 ? C.white : C.red, align: "center" });
    addText(slide, String(yr), 100 + i * 66, 495, 46, 17, { size: 12, bold: true, color: i === 0 ? C.white : C.ink, align: "center" });
  });
  addText(slide, "窗口内所有年份仍可选择。\nRank 1 只是优先检查顺序，不是正确概率。", 96, 539, 324, 60, { size: 15, color: C.ink2 });

  addBox(slide, 520, 146, 408, 474, { fill: C.paper2, line: C.rule, radius: "rounded-2xl" });
  addText(slide, "反事实预览", 545, 168, 260, 18, { size: 12, bold: true, color: C.plum });
  addText(slide, "先检查，再决定是否修改数据", 545, 201, 330, 30, { size: 24, bold: true, color: C.ink });
  const before = [0.38,0.42,0.46,0.39,0.31,0.28,0.35,0.44,0.40,0.33,0.30,0.39];
  const after = [0.43,0.49,0.55,0.60,0.57,0.62,0.67,0.64,0.59,0.61,0.65,0.69];
  drawMiniLinePlot(slide, 560, 286, 332, 130, before, C.coral, null);
  drawMiniLinePlot(slide, 560, 286, 332, 130, after, C.teal, null);
  addLine(slide, 574, 441, 620, 441, { color: C.coral, width: 3 });
  addText(slide, "当前", 628, 433, 70, 18, { size: 12, color: C.coral });
  addLine(slide, 715, 441, 761, 441, { color: C.teal, width: 3 });
  addText(slide, "模拟编辑后", 770, 433, 105, 18, { size: 12, color: C.teal });
  addBox(slide, 560, 480, 332, 92, { fill: C.white, line: C.plum, radius: "rounded-xl" });
  addText(slide, "局部 r", 579, 495, 70, 18, { size: 11, bold: true, color: C.muted });
  addText(slide, "0.31", 579, 521, 70, 30, { size: 24, bold: true, color: C.coral });
  addText(slide, "→", 668, 520, 35, 30, { size: 24, bold: true, color: C.ink, align: "center" });
  addText(slide, "0.62", 718, 521, 70, 30, { size: 24, bold: true, color: C.teal });
  addText(slide, "Δr +0.31", 802, 521, 70, 26, { size: 17, bold: true, color: C.plum, align: "right" });
  addText(slide, "预览数据只存在于图表中，工作 RWL 不会改变。", 560, 583, 332, 24, { size: 14, bold: true, color: C.plum, align: "center" });

  addText(slide, "专家决策", 976, 151, 200, 18, { size: 12, bold: true, color: C.amber });
  const decisions = [
    ["1", "检查实体样芯 / 扫描图 / 折线"],
    ["2", "选择具体年份或断点"],
    ["3", "只应用一个操作"],
  ];
  decisions.forEach((d, i) => {
    const yy = 198 + i * 104;
    addDot(slide, 1012, yy + 18, 18, C.amber, C.amber);
    addText(slide, d[0], 995, yy + 8, 34, 20, { size: 14, bold: true, color: C.white, align: "center" });
    addText(slide, d[1], 1044, yy, 160, 50, { size: 17, bold: true, color: C.ink });
    if (i < 2) addLine(slide, 1012, yy + 40, 1012, yy + 94, { color: C.amber, width: 2 });
  });
  addBox(slide, 960, 517, 248, 103, { fill: C.coralLight, line: C.coral, radius: "rounded-xl" });
  addText(slide, "当前 UI 事实", 979, 535, 170, 18, { size: 11, bold: true, color: C.red });
  addText(slide, "reviewOnly 底层禁止应用。\n主卡片：单次点击应用。\n图表预览：应用 → 再确认。", 979, 562, 207, 50, { size: 14, color: C.ink });
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 24–28, review-event fields, ranked years, preview semantics, reviewOnly restriction and current confirmation paths.",
  ], "Review panel and correlation curves are schematic.");
}

// Slide 10 — apply, stale, rediagnose
{
  const slide = presentation.slides.add();
  slide.background.fill = C.paper;
  for (const d of [580,500,420,340,260,180]) addRing(slide, 830, 390, d, d === 500 ? C.rule : C.paper2, d === 580 ? 2 : 1);
  addTitleChrome(slide, 10, "接受一个事件后，数据更新，所有旧建议立即作废");

  addText(slide, "精确编辑语义", 72, 137, 240, 18, { size: 12, bold: true, color: C.muted });
  const edits = [
    ["M", "在 c 年写入 0", "较老侧 −1 年", C.teal, C.tealLight],
    ["F", "删除 c 年", "较老侧 +1 年", C.coral, C.coralLight],
    ["P", "移动 ≤ c−1 的年份", "较新侧固定", C.plum, C.plumLight],
    ["W", "移动整条序列", "必须找回原硬门候选", C.amber, C.amberLight],
  ];
  edits.forEach((e, i) => {
    const yy = 172 + i * 103;
    addBox(slide, 72, yy, 330, 82, { fill: e[5], line: e[4], radius: "rounded-xl" });
    addBox(slide, 87, yy + 15, 50, 50, { geometry: "ellipse", fill: e[4], line: e[4], radius: 0 });
    addText(slide, e[0], 87, yy + 28, 50, 22, { size: 17, bold: true, color: C.white, align: "center" });
    addText(slide, e[1], 155, yy + 14, 220, 25, { size: 18, bold: true, color: C.ink });
    addText(slide, e[2], 155, yy + 46, 220, 20, { size: 13, color: C.ink2 });
  });

  const loopNodes = [];
  const loop = [
    { x: 618, y: 158, w: 220, h: 66, t: "RwlEditor 应用\n一个已验证计划", c: C.tealLight, l: C.teal },
    { x: 936, y: 228, w: 220, h: 66, t: "保存 undo snapshot\n并写入统一操作日志", c: C.blueLight, l: C.blue },
    { x: 940, y: 430, w: 220, h: 66, t: "全部候选与事件\n立即标记 stale", c: C.coralLight, l: C.coral },
    { x: 625, y: 535, w: 220, h: 66, t: "Web Worker 基于\n新 working series 复诊", c: C.plumLight, l: C.plum },
    { x: 482, y: 345, w: 220, h: 66, t: "下一处树皮侧\n当前前沿才可能浮现", c: C.amberLight, l: C.amber },
  ];
  loop.forEach((n) => {
    const s = addBox(slide, n.x, n.y, n.w, n.h, { fill: n.c, line: n.l, lineWidth: 1.5, radius: "rounded-full" });
    loopNodes.push(s);
    addText(slide, n.t, n.x + 18, n.y + 14, n.w - 36, 42, { size: 16, bold: true, color: C.ink, align: "center" });
  });
  connect(slide, loopNodes[0], loopNodes[1], { fromSide: "right", toSide: "top", kind: "curved", color: C.teal, width: 2 });
  connect(slide, loopNodes[1], loopNodes[2], { fromSide: "bottom", toSide: "top", kind: "curved", color: C.blue, width: 2 });
  connect(slide, loopNodes[2], loopNodes[3], { fromSide: "left", toSide: "right", kind: "curved", color: C.coral, width: 2 });
  connect(slide, loopNodes[3], loopNodes[4], { fromSide: "left", toSide: "bottom", kind: "curved", color: C.plum, width: 2 });
  connect(slide, loopNodes[4], loopNodes[0], { fromSide: "top", toSide: "left", kind: "curved", color: C.amber, width: 2 });
  loopNodes.forEach((n) => n.bringToFront());

  addBox(slide, 695, 316, 270, 126, { geometry: "ellipse", fill: C.ink, line: C.ink, radius: 0 });
  addText(slide, "每轮只处理\n一个事件", 738, 343, 184, 54, { size: 22, bold: true, color: C.white, align: "center" });
  addText(slide, "旧坐标绝不驱动第二次编辑", 729, 405, 202, 25, { size: 12, color: C.lime, align: "center" });

  addBox(slide, 452, 626, 744, 42, { fill: C.ink, line: C.ink, radius: "rounded-full" });
  addText(slide, "算法缩小范围 · 树轮专家作出决定 · RWL 历史保留为什么这样改", 472, 637, 704, 20, { size: 17, bold: true, color: C.white, align: "center" });
  addText(slide, "边界：过期 OUT 会被排除；stale 动态参考点仍可能持续使用，直到下一次 COFECHA 运行。", 72, 620, 350, 48, { size: 13, color: C.red });
  addSourceNotes(slide, [
    "docs/定年建议输出流程.md — steps 27–32, edit plans, RwlEditor audit path, stale invalidation and frontier rediagnosis.",
    "docs/index.md — expert-in-the-loop positioning and event-by-event recovery.",
  ]);
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(LAYOUT_DIR, { recursive: true });

for (const [index, slide] of presentation.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  const png = await presentation.export({ slide, format: "png", scale: 1.5 });
  await writeBlob(path.join(OUTPUT_DIR, `${stem}.png`), png);
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(path.join(LAYOUT_DIR, `${stem}.layout.json`), await layout.text());
}

const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(PPTX_PATH);

const inspection = await presentation.inspect({
  kind: "slide,textbox,shape,chart,image",
  maxChars: 20000,
});
await fs.writeFile(path.join(TMP_DIR, "deck-inspection.ndjson"), inspection.ndjson);

console.log(JSON.stringify({ slides: presentation.slides.items.length, outputDir: OUTPUT_DIR, pptx: PPTX_PATH }, null, 2));
