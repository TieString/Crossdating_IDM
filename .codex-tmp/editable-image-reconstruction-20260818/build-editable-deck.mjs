import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "D:/Code/Crossdating_Tauri_js-diagnosis-events-v1";
const SRC_DIR = `${ROOT}/docs/conference-dating-recommendation-imagegen-v1`;
const TMP_DIR = `${ROOT}/.codex-tmp/editable-image-reconstruction-20260818`;
const OUT_DIR = `${ROOT}/docs/conference-dating-recommendation-imagegen-v1`;
const ASSET_DIR = `${TMP_DIR}/assets`;
const FINAL_PPTX = `${OUT_DIR}/Crossdating-IDM-dating-recommendation-editable.pptx`;
const RENDER_DIR = `${TMP_DIR}/rendered`;
const LAYOUT_DIR = `${TMP_DIR}/layouts`;
const W = 1280;
const H = 720;
const FONT = "Microsoft YaHei";

const C = {
  paper: "#F7F4EC",
  white: "#FFFDF8",
  ink: "#102D2C",
  ink2: "#3F514E",
  muted: "#6E7770",
  sage: "#AAB097",
  rule: "#C8C6BA",
  teal: "#0B5C5B",
  teal2: "#2D7E77",
  tealLight: "#DCEBE7",
  moss: "#667A3A",
  mossLight: "#E6E9D5",
  coral: "#C14F33",
  coralLight: "#F3DED6",
  plum: "#6B3E67",
  plumLight: "#E7DFE9",
  ochre: "#A96F06",
  ochreLight: "#F2E4C5",
  grayLight: "#F0EEE7",
};

const src = (n) => `${SRC_DIR}/slide-${String(n).padStart(2, "0")}.png`;
const imageCache = new Map();
let objectId = 0;
const name = (p) => `${p}-${String(++objectId).padStart(4, "0")}`;

async function imageBytes(filePath) {
  if (!imageCache.has(filePath)) {
    const b = await fs.readFile(filePath);
    imageCache.set(filePath, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  return imageCache.get(filePath);
}

function addText(slide, text, x, y, w, h, opts = {}) {
  const s = slide.shapes.add({
    geometry: "textbox",
    name: opts.name || name("text"),
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  s.text = text;
  s.text.style = {
    typeface: opts.typeface || FONT,
    fontSize: opts.size ?? 18,
    bold: opts.bold ?? false,
    italic: opts.italic ?? false,
    color: opts.color || C.ink,
    alignment: opts.align || "left",
    verticalAlignment: opts.valign || "top",
    autoFit: opts.autoFit || "shrinkText",
    insets: opts.insets || { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return s;
}

function addBox(slide, x, y, w, h, opts = {}) {
  const geometry = opts.geometry || "roundRect";
  const cfg = {
    geometry,
    name: opts.name || name("shape"),
    position: { left: x, top: y, width: w, height: h, rotation: opts.rotation || 0 },
    fill: opts.fill ?? C.white,
    line: { style: opts.dashed ? "dashed" : "solid", fill: opts.line ?? C.rule, width: opts.lineWidth ?? 1 },
    shadow: opts.shadow || "shadow-none",
  };
  if (["rect", "roundRect", "textbox"].includes(geometry)) cfg.borderRadius = opts.radius ?? "rounded-xl";
  return slide.shapes.add(cfg);
}

function addLine(slide, x1, y1, x2, y2, opts = {}) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(Math.abs(x2 - x1), 0.1);
  const height = Math.max(Math.abs(y2 - y1), 0.1);
  return slide.shapes.add({
    geometry: "line",
    name: opts.name || name("line"),
    position: { left, top, width, height, horizontalFlip: x2 < x1, verticalFlip: y2 < y1 },
    fill: "none",
    line: { style: opts.dashed ? "dashed" : "solid", fill: opts.color || C.ink2, width: opts.width || 1 },
  });
}

function addArrow(slide, x, y, w, h, color = C.teal, rotation = 0) {
  return addBox(slide, x, y, w, h, { geometry: "rightArrow", fill: color, line: color, lineWidth: 0.5, rotation });
}

function addDot(slide, cx, cy, r, fill, line = fill, lineWidth = 1) {
  return addBox(slide, cx - r, cy - r, r * 2, r * 2, { geometry: "ellipse", fill, line, lineWidth });
}

function addRing(slide, cx, cy, d, color = C.rule, width = 1) {
  return addBox(slide, cx - d / 2, cy - d / 2, d, d, { geometry: "ellipse", fill: "none", line: color, lineWidth: width });
}

function addRingSystem(slide, cx, cy, maxD, count, opts = {}) {
  for (let i = count; i >= 1; i--) {
    const d = (maxD / count) * i;
    addRing(slide, cx, cy, d, i % (opts.majorEvery || 4) === 0 ? (opts.majorColor || C.rule) : (opts.color || "#D8D5C9"), i % (opts.majorEvery || 4) === 0 ? 1.1 : 0.55);
  }
}

function addPill(slide, text, x, y, w, fill, color, line = fill, size = 13) {
  addBox(slide, x, y, w, 28, { fill, line, radius: "rounded-full" });
  addText(slide, text, x + 8, y + 5, w - 16, 18, { size, bold: true, color, align: "center" });
}

async function addCrop(slide, filePath, crop, position, alt) {
  return slide.images.add({
    blob: await imageBytes(filePath),
    contentType: "image/png",
    alt,
    fit: "cover",
    crop,
    position,
  });
}

async function addImage(slide, filePath, position, alt, fit = "contain") {
  return slide.images.add({
    blob: await imageBytes(filePath),
    contentType: "image/png",
    alt,
    fit,
    position,
  });
}

function addFooterLandscape(slide) {
  addBox(slide, 0, 650, 430, 70, { geometry: "triangle", fill: "#E5E7DE", line: "#E5E7DE", lineWidth: 0.2 });
  addBox(slide, 300, 645, 610, 75, { geometry: "triangle", fill: "#ECE9E0", line: "#ECE9E0", lineWidth: 0.2 });
  addBox(slide, 800, 650, 480, 70, { geometry: "triangle", fill: "#E1E4DA", line: "#E1E4DA", lineWidth: 0.2 });
  for (let i = 0; i < 34; i++) {
    const x = 30 + i * 38;
    const h = 8 + ((i * 17) % 54);
    addLine(slide, x, 708 - h, x, 708, { color: i % 5 === 0 ? C.teal : C.rule, width: i % 5 === 0 ? 1.2 : 0.7 });
    addDot(slide, x, 708 - h, i % 5 === 0 ? 2.2 : 1.2, i % 5 === 0 ? C.teal : C.muted);
  }
}

async function addBackground(slide, n) {
  slide.background.fill = C.paper;
  await addImage(slide, `${ASSET_DIR}/foliage-corner.png`, { left: 0, top: 0, width: 275, height: 70 }, "watercolor foliage corner", "cover");
  addFooterLandscape(slide);
}

function addStandardHeader(slide, n, title) {
  addText(slide, String(n).padStart(2, "0"), 44, 52, 95, 72, { size: 60, color: C.sage, bold: false });
  addText(slide, title, 260, 27, 950, 55, { size: 35, bold: true, color: "#000000", align: "left" });
  addLine(slide, 260, 90, 1110, 90, { color: C.teal, width: 2 });
}

function addNotes(slide, n) {
  slide.speakerNotes.textFrame.setText(`[Sources]\n- ${src(n)} (visual reference; reconstructed, not embedded full-page)\n- ${ROOT}/docs/index.md\n- ${ROOT}/docs/定年建议输出流程.md`);
  slide.speakerNotes.setVisible(true);
}

function drawAxes(slide, x, y, w, h, opts = {}) {
  addLine(slide, x, y + h, x + w, y + h, { color: opts.color || C.ink2, width: 1 });
  addLine(slide, x, y, x, y + h, { color: opts.color || C.ink2, width: 1 });
}

function drawLinePlot(slide, x, y, w, h, values, color, opts = {}) {
  drawAxes(slide, x, y, w, h, opts);
  const min = opts.min ?? Math.min(...values);
  const max = opts.max ?? Math.max(...values);
  const span = Math.max(0.001, max - min);
  const pts = values.map((v, i) => ({ x: x + (i / (values.length - 1)) * w, y: y + h - ((v - min) / span) * h }));
  for (let i = 0; i < pts.length - 1; i++) addLine(slide, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, { color, width: opts.width || 2 });
  if (opts.dots) pts.forEach((p, i) => addDot(slide, p.x, p.y, i === opts.highlight ? 4 : 2.2, i === opts.highlight ? (opts.highlightColor || C.coral) : color));
  return pts;
}

function drawStepPath(slide, x, y, w, h, states, color, opts = {}) {
  const min = opts.min ?? Math.min(...states, 0);
  const max = opts.max ?? Math.max(...states, 0);
  const span = Math.max(1, max - min);
  const yFor = (v) => y + h - ((v - min) / span) * h;
  const dx = w / states.length;
  addLine(slide, x, yFor(0), x + w, yFor(0), { color: C.rule, width: 0.8, dashed: true });
  for (let i = 0; i < states.length; i++) {
    const x1 = x + i * dx;
    const x2 = x + (i + 1) * dx;
    const yy = yFor(states[i]);
    addLine(slide, x1, yy, x2, yy, { color, width: opts.width || 3 });
    if (i < states.length - 1 && states[i + 1] !== states[i]) addLine(slide, x2, yy, x2, yFor(states[i + 1]), { color, width: opts.width || 3 });
  }
}

function drawTinyLagGlyph(slide, x, y, type, color) {
  const patterns = {
    missing: [-1, -1, 0, 0],
    false: [0, 0, 1, 1],
    partial: [-2, -2, 0, 0],
    whole: [-1, -1, -1, -1],
  };
  drawStepPath(slide, x, y, 78, 38, patterns[type], color, { min: -2, max: 1, width: 2 });
}

function addYearBoxes(slide, x, y, years, opts = {}) {
  const cellW = opts.cellW || 34;
  years.forEach((yr, i) => {
    addBox(slide, x + i * cellW, y, cellW - 2, 22, { geometry: "rect", fill: opts.fills?.[i] || C.white, line: opts.line || C.rule, lineWidth: 0.7, radius: 0 });
    addText(slide, String(yr), x + i * cellW + 2, y + 4, cellW - 6, 14, { size: 9, color: opts.colors?.[i] || C.ink, align: "center" });
  });
}

const presentation = Presentation.create({ slideSize: { width: W, height: H } });

// Slide 1
{
  const slide = presentation.slides.add();
  await addBackground(slide, 1);
  addText(slide, "01", 48, 80, 110, 92, { size: 72, color: C.sage });
  addText(slide, "将统计异常转化为\n事件级定年建议", 70, 245, 560, 155, { size: 49, bold: true, color: "#000000" });
  addText(slide, "Crossdating-IDM 定年建议输出流程", 75, 420, 420, 32, { size: 20, bold: true, color: C.teal });
  addLine(slide, 75, 457, 270, 457, { color: C.teal, width: 2 });
  addText(slide, "操作类型 × 位移量 × 主复核窗", 75, 480, 430, 26, { size: 17, color: C.ink2 });
  addLine(slide, 75, 515, 520, 515, { color: C.rule, width: 1, dashed: true });
  addText(slide, "受约束 lag 拓扑 · 可执行反事实 · 多参考芯证据", 75, 535, 500, 26, { size: 17, color: C.teal });

  addDot(slide, 1000, 320, 155, C.mossLight, C.mossLight, 0);
  addDot(slide, 1135, 235, 95, C.ochreLight, C.ochreLight, 0);
  addRingSystem(slide, 980, 390, 500, 18, { color: "#DDD9CC", majorColor: C.rule, majorEvery: 4 });
  addLine(slide, 710, 390, 1240, 390, { color: C.muted, width: 0.8, dashed: true });
  addLine(slide, 965, 95, 965, 610, { color: C.ink2, width: 1 });
  drawStepPath(slide, 720, 160, 500, 430, [-2.8,-2.5,-2.2,-1.8,-1.5,-1.1,-0.8,-0.3,0.1,0.5,0.9,1.2], C.teal, { min: -3, max: 3, width: 4 });
  addDot(slide, 760, 525, 13, C.teal, C.white, 4);
  addDot(slide, 982, 385, 13, C.moss, C.white, 4);
  addDot(slide, 1115, 250, 13, C.coral, C.white, 4);
  [1900,1920,1940,1960,1980,2000,2020].forEach((yr,i)=>addText(slide,String(yr),735+i*73,610,48,15,{size:10,color:C.ink2,align:"center"}));
  ["+3","+2","+1","0","−1","−2","−3"].forEach((v,i)=>addText(slide,v,925,93+i*52,30,15,{size:10,color:C.ink2,align:"right"}));
  addText(slide, "年  份", 930, 646, 70, 16, { size: 11, color: C.ink, align: "center" });
  addNotes(slide, 1);
}

// Slide 2
{
  const slide = presentation.slides.add();
  await addBackground(slide, 2);
  addStandardHeader(slide, 2, "事件级建议统一表达为“操作 × 位移 × 位置”");
  const evidence = [
    ["统计报警", C.coral], ["全局滑动", C.teal2], ["重叠分段", C.teal], ["受约束 lag path", C.moss], ["可执行编辑反事实", C.ochre], ["逐参考芯证据", C.ink]
  ];
  evidence.forEach((e,i)=>{
    const yy=185+i*52;
    addRingSystem(slide, 112, yy+12, 36, 3, {color:e[1],majorColor:e[1],majorEvery:1});
    addDot(slide,112,yy+12,4,e[1]);
    addText(slide,e[0],145,yy,180,25,{size:17,bold:i===0,color:C.ink});
    addLine(slide,300,yy+12,405,330,{color:e[1],width:1,dashed:true});
  });
  addRingSystem(slide, 438, 330, 95, 5, { color: C.rule, majorColor: C.coral, majorEvery: 5 });
  addText(slide,"联合\n裁决",405,300,66,62,{size:18,bold:true,color:C.ink,align:"center",valign:"middle"});
  addArrow(slide,480,318,55,24,C.ink,0);
  addDot(slide,760,330,180,C.ochreLight,C.ochreLight,0);
  addRingSystem(slide,760,330,350,14,{color:"#DDD9CC",majorColor:C.rule,majorEvery:4});
  addText(slide,"⚙",620,280,70,70,{size:42,bold:true,color:C.teal,align:"center"});
  addText(slide,"×",705,295,35,35,{size:30,bold:true,color:C.ink,align:"center"});
  addText(slide,"↔",747,280,70,60,{size:38,bold:true,color:C.moss,align:"center"});
  addText(slide,"×",828,295,35,35,{size:30,bold:true,color:C.ink,align:"center"});
  addText(slide,"●",870,286,50,50,{size:35,bold:true,color:C.coral,align:"center"});
  addText(slide,"操作类型 × 位移量 × 位置",635,360,250,32,{size:20,bold:true,color:C.teal,align:"center"});
  addArrow(slide,935,318,60,24,C.ink,0);
  addRingSystem(slide,1095,330,190,9,{color:"#DDD9CC",majorColor:C.rule,majorEvery:3});
  addDot(slide,1095,330,30,C.moss,C.moss,0);
  addText(slide,"✓",1071,300,48,48,{size:35,bold:true,color:C.white,align:"center"});
  addText(slide,"唯一主复核事件",1000,438,190,28,{size:20,bold:true,color:C.teal,align:"center"});
  addText(slide,"将问题区段转化为位置明确、\n可执行、可追踪的定年建议",994,474,205,52,{size:16,color:C.ink,align:"center"});
  addBox(slide,350,535,650,100,{fill:C.white,line:C.rule,dashed:true,radius:"rounded-xl"});
  const events=[["缺轮","missing",C.teal],["伪轮","false",C.moss],["局部移动","partial",C.coral],["整体移动","whole",C.teal]];
  events.forEach((e,i)=>{
    const xx=385+i*150;
    addText(slide,e[0],xx,548,120,20,{size:14,bold:true,color:e[2],align:"center"});
    drawTinyLagGlyph(slide,xx+18,575,e[1],e[2]);
  });
  addNotes(slide, 2);
}

// Slide 3
{
  const slide = presentation.slides.add();
  await addBackground(slide, 3);
  addStandardHeader(slide, 3, "动态参考年表提供可比较的公共年代信号");
  addText(slide,"当前 working RWL",110,150,220,25,{size:18,bold:true,color:C.teal});
  addText(slide,"目标芯",110,178,100,20,{size:14,bold:true,color:C.teal});
  await addImage(slide,`${ASSET_DIR}/target-core.png`,{left:108,top:205,width:230,height:40},"target tree core texture","cover");
  drawLinePlot(slide,55,270,260,85,[0.2,0.5,0.1,0.7,0.3,0.8,0.25,0.6,0.15,0.75,0.32,0.9,0.4,0.7,0.2,0.8],C.teal,{min:0,max:1,dots:false,width:1.5});
  addText(slide,"1600",45,360,40,14,{size:9,color:C.ink2}); addText(slide,"2000",280,360,40,14,{size:9,color:C.ink2,align:"right"});
  addText(slide,"COFECHA PART 3 master",108,390,260,25,{size:18,bold:true,color:C.moss});
  addText(slide,"锚定样芯",108,417,100,20,{size:14,bold:true,color:C.moss});
  await addImage(slide,`${ASSET_DIR}/anchor-cores.png`,{left:108,top:445,width:230,height:70},"anchor tree core textures","cover");
  [0,1,2,3].forEach((k)=>drawLinePlot(slide,55,540+k*15,260,12,[0.4+k*0.03,0.55,0.45,0.65,0.5,0.6,0.48,0.7,0.52,0.62,0.5,0.66],k%2?C.moss:C.ink2,{min:0,max:1,width:1}));
  addLine(slide,340,222,1038,222,{color:C.teal,width:2});
  addLine(slide,340,560,425,560,{color:C.moss,width:2});
  const proc=[
    [445,"pairwise bootstrap",C.teal],[565,"32 年样条",C.moss],[685,"无量纲指数",C.moss],[805,"AR(p) 预白化",C.coral],[925,"逐年平均",C.ochre]
  ];
  proc.forEach((p,i)=>{
    addRingSystem(slide,p[0],458,58,3,{color:p[2],majorColor:p[2],majorEvery:1});
    addDot(slide,p[0],458,6,p[2]);
    addText(slide,p[1],p[0]-60,396,120,32,{size:14,bold:true,color:p[2],align:"center"});
    if(i>0) addArrow(slide,p[0]-87,449,32,18,C.muted,0);
    drawLinePlot(slide,p[0]-48,505,96,48,[0.2,0.5,0.3,0.8,0.4,0.6,0.35,0.7,0.45],p[2],{min:0,max:1,width:1.5});
  });
  addLine(slide,425,560,425,458,{color:C.moss,width:1,dashed:true});
  addLine(slide,973,458,1038,380,{color:C.ochre,width:2});
  addRingSystem(slide,1130,370,285,15,{color:"#DAD6C9",majorColor:C.rule,majorEvery:4});
  drawLinePlot(slide,1050,350,160,70,[0.35,0.6,0.25,0.75,0.3,0.55,0.15,0.68,0.4,0.78,0.32,0.62],C.teal,{min:0,max:1,width:2});
  addDot(slide,1038,222,6,C.teal); addLine(slide,1038,222,1038,330,{color:C.teal,width:2});
  addDot(slide,1038,380,6,C.moss);
  addText(slide,"目标芯 ↔ 动态参考年表",1030,145,210,26,{size:18,bold:true,color:C.teal,align:"center"});
  addText(slide,"公共年际变化",1050,178,170,20,{size:14,bold:true,color:C.teal,align:"center"});
  addText(slide,"mean = 0，SD = 1",1050,525,170,22,{size:16,bold:true,color:C.teal,align:"center"});
  addNotes(slide, 3);
}

// Slide 4
{
  const slide = presentation.slides.add();
  await addBackground(slide, 4);
  addStandardHeader(slide, 4, "整体与分段 lag 扫描识别错位结构");
  addLine(slide,425,140,425,605,{color:C.rule,width:1}); addLine(slide,835,140,835,605,{color:C.rule,width:1});
  addPill(slide,"整体滑动 −100…+100 年",105,140,250,C.teal,C.white,C.teal,15);
  await addImage(slide,`${ASSET_DIR}/global-core.png`,{left:65,top:190,width:320,height:46},"tree-core global scan texture","cover");
  const globalVals=[0.1,0.15,0.08,0.2,0.12,0.18,0.15,0.26,0.20,0.30,0.22,0.35,0.18,0.28,0.72,0.34,0.25,0.22,0.17,0.15,0.12];
  const pts=drawLinePlot(slide,70,270,330,170,globalVals,C.teal,{min:0,max:0.8,width:2,dots:false});
  addDot(slide,pts[14].x,pts[14].y,5,C.teal); addLine(slide,pts[14].x,pts[14].y,pts[14].x,440,{color:C.teal,width:1,dashed:true});
  addText(slide,"示意最佳 lag = −4",180,238,170,24,{size:17,bold:true,color:C.teal,align:"center"});
  ["−100","−50","0","+50","+100"].forEach((v,i)=>addText(slide,v,54+i*82,449,54,14,{size:9,color:C.ink2,align:"center"}));
  addText(slide,"整体基线（主导 lag）",135,500,210,22,{size:16,bold:true,color:C.teal,align:"center"});
  addPill(slide,"50 年窗口 / 25 年重叠",500,140,250,C.teal,C.white,C.teal,15);
  for(let i=0;i<5;i++){
    addBox(slide,460+i*64,205+(i%2)*18,112,34,{geometry:"rect",fill:i<2?C.coralLight:C.mossLight,line:i<2?C.coral:C.moss,lineWidth:1,radius:0});
    addText(slide,`W${i+1}`,495+i*64,211+(i%2)*18,40,18,{size:12,bold:true,color:C.ink,align:"center"});
  }
  addText(slide,"25 年重叠",605,185,100,18,{size:12,bold:true,color:C.teal,align:"center"});
  addText(slide,"A-like：低相关，移动后无明显改善",455,285,330,22,{size:14,bold:true,color:C.coral});
  addText(slide,"B-like：非零 lag 带来稳定改善",455,435,330,22,{size:14,bold:true,color:C.moss});
  for(let i=0;i<5;i++){
    drawLinePlot(slide,450+i*68,330,55,52,i<4?[0.2,0.28,0.22,0.27,0.24]:[0.22,0.25,0.23,0.26,0.24],C.coral,{min:0,max:0.5,width:1.3});
    drawLinePlot(slide,450+i*68,485,55,52,[0.1,0.25,0.65,0.3,0.12],C.moss,{min:0,max:0.7,width:1.3});
  }
  addPill(slide,"连续同方向 B-like",930,140,210,C.teal,C.white,C.teal,15);
  await addImage(slide,`${ASSET_DIR}/segmented-core.png`,{left:865,top:190,width:355,height:48},"segmented tree-core texture","cover");
  addBox(slide,865,190,100,38,{geometry:"rect",fill:"none",line:C.coral,lineWidth:2,radius:0});
  addBox(slide,965,190,125,38,{geometry:"rect",fill:"none",line:C.moss,lineWidth:2,radius:0});
  addBox(slide,1090,190,130,38,{geometry:"rect",fill:"none",line:C.moss,lineWidth:2,radius:0});
  addText(slide,"A-like 区段",870,235,95,16,{size:11,bold:true,color:C.coral,align:"center"});
  addText(slide,"B-like 区段",980,235,100,16,{size:11,bold:true,color:C.moss,align:"center"});
  addText(slide,"B-like 区段",1100,235,110,16,{size:11,bold:true,color:C.moss,align:"center"});
  addText(slide,"传播模式",945,282,200,22,{size:17,bold:true,color:C.teal,align:"center"});
  drawStepPath(slide,875,330,330,170,[-4,-4,-4,-4,0,0,0,0],C.moss,{min:-5,max:1,width:3});
  addText(slide,"较老侧 lag = −4",885,515,140,18,{size:13,bold:true,color:C.coral});
  addText(slide,"较新侧 lag = 0",1070,515,135,18,{size:13,bold:true,color:C.moss,align:"right"});
  addPill(slide,"主导 lag = −4",895,545,150,C.grayLight,C.teal,C.rule,14);
  addBox(slide,250,600,800,50,{fill:C.white,line:C.rule,radius:"rounded-full"});
  addText(slide,"报警输出：",280,615,100,20,{size:16,bold:true,color:C.teal});
  addText(slide,"整体基线   ·   问题区段   ·   propagation pattern",390,615,620,20,{size:16,bold:true,color:C.ink,align:"center"});
  addNotes(slide, 4);
}

// Slide 5
{
  const slide = presentation.slides.add();
  await addBackground(slide, 5);
  addStandardHeader(slide, 5, "lag 状态拓扑映射为四类可执行事件");
  const rows = [
    { y: 140, n: "1", name: "缺轮", delta: "ΔL = −1", color: C.teal, light: C.tealLight, code: "insertMissingYear", meaning: "年轮缺失 / 测量遗漏", type: "missing" },
    { y: 275, n: "2", name: "伪轮", delta: "ΔL = +1", color: C.coral, light: C.coralLight, code: "deleteFalseYear", meaning: "伪界 / 重复划分", type: "false" },
    { y: 410, n: "3", name: "局部移动", delta: "ΔL ≤ −2", color: C.plum, light: C.plumLight, code: "partialRangeMove", meaning: "连续缺段 / 芯段错位", type: "partial" },
    { y: 545, n: "4", name: "整体移动", delta: "全序列恒定负 lag", color: C.ochre, light: C.ochreLight, code: "wholeSeriesMove", meaning: "树皮侧年份缺失", type: "whole" },
  ];
  rows.forEach((r) => {
    addLine(slide, 20, r.y + 118, 1260, r.y + 118, { color: C.rule, width: 0.8, dashed: true });
    addRingSystem(slide, 75, r.y + 58, 88, 7, { color: r.color, majorColor: r.color, majorEvery: 7 });
    addBox(slide, 142, r.y + 20, 25, 25, { fill: r.color, line: r.color, radius: "rounded-md" });
    addText(slide, r.n, 142, r.y + 23, 25, 18, { size: 13, bold: true, color: C.white, align: "center" });
    addText(slide, r.name, 180, r.y + 18, 140, 26, { size: 23, bold: true, color: r.color });
    addBox(slide, 145, r.y + 60, 165, 38, { fill: C.white, line: r.color, radius: "rounded-lg" });
    addText(slide, r.delta, 155, r.y + 68, 145, 22, { size: 17, bold: true, color: r.color, align: "center" });
    addText(slide, "操作前", 430, r.y + 2, 70, 18, { size: 12, bold: true, color: C.white, align: "center" });
    addBox(slide, 425, r.y, 80, 22, { fill: r.color, line: r.color, radius: "rounded-full" });
    addText(slide, "操作前", 428, r.y + 3, 74, 16, { size: 11, bold: true, color: C.white, align: "center" });
    addBox(slide, 712, r.y, 80, 22, { fill: r.color, line: r.color, radius: "rounded-full" });
    addText(slide, "操作后", 715, r.y + 3, 74, 16, { size: 11, bold: true, color: C.white, align: "center" });
    addArrow(slide, 650, r.y + 55, 45, 24, r.color, 0);
    addText(slide, r.code, 945, r.y + 30, 205, 24, { size: 17, bold: true, color: r.color });
    addDot(slide, 948, r.y + 70, 4, r.color);
    addText(slide, r.meaning, 962, r.y + 60, 190, 40, { size: 15, bold: true, color: r.color });
    addRingSystem(slide, 1190, r.y + 58, 92, 7, { color: r.color, majorColor: r.color, majorEvery: 7 });
    drawTinyLagGlyph(slide, 1151, r.y + 40, r.type, r.color);
  });
  // Row-specific year sequences
  addText(slide, "参考年序列", 320, 172, 85, 16, { size: 10, color: C.ink2 });
  addText(slide, "测量年序列", 320, 215, 85, 16, { size: 10, color: C.ink2 });
  addYearBoxes(slide, 405, 166, [1988,1989,1990,1991,1992,1993], { cellW: 38 });
  addYearBoxes(slide, 405, 207, [1988,1989,"",1991,1992,1993], { cellW: 38, fills: [C.white,C.white,C.tealLight,C.white,C.white,C.white] });
  addYearBoxes(slide, 700, 166, [1988,1989,1990,1991,1992,1993], { cellW: 38 });
  addYearBoxes(slide, 700, 207, [1988,1989,1990,1991,1992,1993], { cellW: 38, fills: [C.white,C.white,C.tealLight,C.white,C.white,C.white] });
  addText(slide, "参考年序列", 320, 307, 85, 16, { size: 10, color: C.ink2 });
  addText(slide, "测量年序列", 320, 350, 85, 16, { size: 10, color: C.ink2 });
  addYearBoxes(slide, 405, 301, [1988,1989,1990,1991,1992,1993], { cellW: 38 });
  addYearBoxes(slide, 405, 342, [1988,1989,1990,1990,1991,1992,1993], { cellW: 33, fills: [C.white,C.white,C.white,C.coralLight,C.white,C.white,C.white] });
  addYearBoxes(slide, 700, 301, [1988,1989,1990,1991,1992,1993], { cellW: 38 });
  addYearBoxes(slide, 700, 342, [1988,1989,1990,1991,1992,1993], { cellW: 38 });
  addText(slide, "参考年序列", 320, 442, 85, 16, { size: 10, color: C.ink2 });
  addText(slide, "测量年序列", 320, 485, 85, 16, { size: 10, color: C.ink2 });
  addYearBoxes(slide, 405, 436, [1990,1991,1992,1993,1994,1995,1996,1997], { cellW: 30 });
  addYearBoxes(slide, 405, 477, [1990,1991,1992,1993,"","",1996,1997], { cellW: 30, fills: [C.white,C.white,C.white,C.white,C.plumLight,C.plumLight,C.white,C.white] });
  addYearBoxes(slide, 700, 436, [1990,1991,1992,1993,1994,1995,1996,1997], { cellW: 30 });
  addYearBoxes(slide, 700, 477, [1990,1991,1992,1993,1994,1995,1996,1997], { cellW: 30, fills: [C.white,C.white,C.white,C.white,C.plumLight,C.plumLight,C.white,C.white] });
  addText(slide, "参考年序列", 320, 577, 85, 16, { size: 10, color: C.ink2 });
  addText(slide, "测量年序列", 320, 620, 85, 16, { size: 10, color: C.ink2 });
  addYearBoxes(slide, 405, 571, [1985,1986,1987,1988,1989,1990,1991,1992], { cellW: 30 });
  addYearBoxes(slide, 405, 612, [1983,1984,1985,1986,1987,1988,1989,1990], { cellW: 30, line: C.ochre });
  addYearBoxes(slide, 700, 571, [1985,1986,1987,1988,1989,1990,1991,1992], { cellW: 30 });
  addYearBoxes(slide, 700, 612, [1985,1986,1987,1988,1989,1990,1991,1992], { cellW: 30, line: C.ochre });
  addNotes(slide, 5);
}

// Slide 6
{
  const slide = presentation.slides.add();
  await addBackground(slide, 6);
  addStandardHeader(slide, 6, "可执行反事实决定候选是否进入事件层");
  const headers = [[30,"复制 siteData",C.teal],[220,"虚拟编辑目标芯",C.coral],[430,"完整重新诊断",C.plum],[635,"before / after",C.ochre]];
  headers.forEach((h,i)=>{
    addBox(slide,h[0],125,160,28,{fill:h[2],line:h[2],radius:"rounded-full"});
    addText(slide,h[1],h[0]+8,131,144,17,{size:13,bold:true,color:C.white,align:"center"});
    if(i<headers.length-1) addArrow(slide,h[0]+167,132,35,14,C.ink2,0);
  });
  // editable process icons
  addBox(slide,45,175,105,80,{geometry:"ellipse",fill:C.white,line:C.teal,lineWidth:2});
  addBox(slide,55,190,85,45,{geometry:"rect",fill:C.white,line:C.teal,lineWidth:2,radius:0});
  addText(slide,"siteData 副本",38,273,120,20,{size:13,bold:true,color:C.ink,align:"center"});
  addRingSystem(slide,300,215,110,7,{color:C.ochre,majorColor:C.coral,majorEvery:7});
  addBox(slide,330,225,35,35,{fill:C.white,line:C.coral,radius:"rounded-md"});
  addText(slide,"✎",333,228,29,25,{size:20,bold:true,color:C.coral,align:"center"});
  addText(slide,"执行候选编辑",240,273,120,20,{size:13,bold:true,color:C.ink,align:"center"});
  addBox(slide,485,180,110,75,{fill:C.white,line:C.plum,radius:"rounded-xl"});
  drawLinePlot(slide,500,200,80,35,[0.2,0.35,0.28,0.55,0.4,0.62,0.48],C.plum,{min:0,max:0.7,width:2,dots:true});
  addText(slide,"diagnoseSeriesCore",455,273,170,20,{size:13,bold:true,color:C.ink,align:"center"});
  drawLinePlot(slide,650,180,105,70,[0.15,0.3,0.45,0.55,0.48,0.38,0.2],C.teal,{min:0,max:0.6,width:1.7,dots:true});
  drawLinePlot(slide,770,180,105,70,[0.12,0.25,0.5,0.62,0.55,0.35,0.18],C.ochre,{min:0,max:0.7,width:1.7,dots:true});
  addText(slide,"Before",660,160,80,18,{size:12,bold:true,color:C.teal,align:"center"});
  addText(slide,"After",780,160,80,18,{size:12,bold:true,color:C.ochre,align:"center"});
  // candidate comparison panels
  addText(slide,"典型候选编辑的 before / after 展示（lag 路径与相关剖面）",35,320,760,22,{size:16,bold:true,color:C.teal});
  [0,1,2].forEach((k)=>{
    const xx=30+k*260;
    addBox(slide,xx,350,240,225,{fill:C.white,line:C.rule,dashed:true,radius:"rounded-md"});
    addText(slide,`候选 ${String.fromCharCode(65+k)}（${k<2?"通过硬门":"未通过硬门"}）`,xx+15,363,210,20,{size:13,bold:true,color:k<2?C.ink:C.coral,align:"center"});
    drawLinePlot(slide,xx+18,405,92,55,[0.2,0.35,0.48,0.6,0.42,0.25],C.teal,{min:0,max:0.7,width:1.3,dots:true});
    drawLinePlot(slide,xx+130,405,92,55,k===2?[0.18,0.25,0.4,0.5,0.35,0.22]:[0.15,0.32,0.55,0.68,0.5,0.3],C.ochre,{min:0,max:0.7,width:1.3,dots:true});
    addText(slide,"Before",xx+30,385,60,15,{size:10,color:C.teal,align:"center"}); addText(slide,"After",xx+145,385,60,15,{size:10,color:C.ochre,align:"center"});
    drawLinePlot(slide,xx+18,500,92,45,[0.2,0.32,0.52,0.33,0.22],C.teal,{min:0,max:0.6,width:1.2,dots:true});
    drawLinePlot(slide,xx+130,500,92,45,k===2?[0.18,0.28,0.42,0.3,0.2]:[0.12,0.34,0.58,0.4,0.18],C.ochre,{min:0,max:0.6,width:1.2,dots:true});
  });
  // seven-gate radial cluster
  addRingSystem(slide,1040,390,265,10,{color:"#DDD9CC",majorColor:C.ochre,majorEvery:5});
  addText(slide,"硬门阈值\n≥ 3 / 7",970,350,140,70,{size:25,bold:true,color:C.ink,align:"center",valign:"middle"});
  const gates=[
    [1040,165,"平均分段相关 ↑",C.teal],[1170,220,"B-like 数量 ↓",C.coral],[1215,375,"传播模式减弱",C.plum],[1160,530,"|lag| → 0",C.ochre],[1015,585,"整条相关稳定",C.plum],[885,500,"边界相关 ↑",C.teal],[865,275,"不制造新强\nB-like",C.coral]
  ];
  gates.forEach((g,i)=>{
    addBox(slide,g[0]-65,g[1]-45,130,90,{geometry:"ellipse",fill:C.white,line:g[3],lineWidth:1.5});
    addText(slide,String(i+1),g[0]-10,g[1]-60,20,20,{size:12,bold:true,color:C.white,align:"center"});
    addDot(slide,g[0],g[1]-50,14,g[3]);
    addText(slide,g[2],g[0]-54,g[1]-12,108,43,{size:13,bold:true,color:C.ink,align:"center",valign:"middle"});
    addLine(slide,g[0],g[1],1040+(g[0]-1040)*0.43,390+(g[1]-390)*0.43,{color:C.rule,width:1,dashed:true});
  });
  addBox(slide,875,610,330,36,{fill:C.white,line:C.teal,radius:"rounded-full"});
  addText(slide,"硬门：≥ 3 / 7",895,618,140,20,{size:17,bold:true,color:C.teal,align:"center"});
  addText(slide,"排序：通过硬门后计算",1045,618,145,20,{size:14,bold:true,color:C.ochre,align:"center"});
  addText(slide,"probabilityLike：候选池内相对权重",875,655,330,20,{size:13,bold:true,color:C.ochre,align:"center"});
  addNotes(slide, 6);
}

// Slide 7
{
  const slide = presentation.slides.add();
  await addBackground(slide, 7);
  addStandardHeader(slide, 7, "联合裁决从完整假设中选择唯一主复核窗");
  const evidence=[
    ["候选事件",C.coral],["受约束 lag path",C.teal],["位置剖面",C.plum],["逐参考芯投票",C.ochre]
  ];
  evidence.forEach((e,i)=>{
    const yy=145+i*112;
    addBox(slide,25,yy,290,96,{fill:C.white,line:C.teal,radius:"rounded-xl"});
    addText(slide,e[0],50,yy+12,240,22,{size:17,bold:true,color:C.ink,align:"center"});
    if(i===0){[0,1,2,3].forEach(k=>{addRingSystem(slide,75+k*58,yy+63,42,3,{color:[C.teal,C.ochre,C.plum,C.coral][k],majorColor:[C.teal,C.ochre,C.plum,C.coral][k],majorEvery:3});});}
    if(i===1){for(let k=0;k<3;k++) drawLinePlot(slide,45+k*85,yy+48,68,35,[0.2,0.45,0.7,0.35,0.18],[C.teal,C.ochre,C.plum][k],{min:0,max:0.8,width:1.3,dots:true});}
    if(i===2){for(let k=0;k<4;k++){addDot(slide,70+k*62,yy+62,6,[C.teal,C.ochre,C.plum,C.coral][k]); drawLinePlot(slide,45+k*62,yy+72,50,20,[0.1,0.6,0.1],[C.teal,C.ochre,C.plum,C.coral][k],{min:0,max:0.7,width:1});}}
    if(i===3){[0,1,2,3].forEach(k=>{addBox(slide,50+k*60,yy+48,45,32,{geometry:"ellipse",fill:C.white,line:[C.teal,C.ochre,C.plum,C.coral][k],lineWidth:1.5});addText(slide,k<2?"✓":"×",61+k*60,yy+54,22,18,{size:13,bold:true,color:k<2?C.moss:C.coral,align:"center"});});}
  });
  [195,307,419,531].forEach((yy,i)=>{addLine(slide,315,yy,420,i<2?230:470,{color:evidence[i][1],width:1.5});});
  addBox(slide,420,128,480,440,{fill:C.white,line:C.teal,radius:"rounded-2xl"});
  addPill(slide,"操作类型 × 位移量 × 位置",520,142,285,C.white,C.teal,C.teal,17);
  addBox(slide,450,195,420,145,{fill:C.grayLight,line:C.teal,radius:"rounded-xl"});
  addPill(slide,"阶段一：操作裁决（先定操作与位移）",480,210,360,C.teal,C.white,C.teal,15);
  addText(slide,"操作竞争",485,260,110,20,{size:16,bold:true,color:C.ink,align:"center"});
  addText(slide,"operation margin ≥ 0.04",470,294,160,20,{size:13,color:C.ink,align:"center"});
  addArrow(slide,640,263,55,22,C.teal,0);
  drawLinePlot(slide,715,250,120,55,[0.2,0.45,0.7,0.9,0.55,0.32],C.teal,{min:0,max:1,width:1.5,dots:true,highlight:3});
  addText(slide,"选定操作类型与位移量",690,312,170,20,{size:14,bold:true,color:C.ink,align:"center"});
  addArrow(slide,640,350,22,45,C.teal,90);
  addBox(slide,450,400,420,145,{fill:C.grayLight,line:C.ochre,radius:"rounded-xl"});
  addPill(slide,"阶段二：位置裁决（后定位置）",480,415,360,C.ochre,C.white,C.ochre,15);
  addText(slide,"位置竞争",485,466,110,20,{size:16,bold:true,color:C.ink,align:"center"});
  addText(slide,"remote margin ≥ 0.04",470,500,160,20,{size:13,color:C.ink,align:"center"});
  addArrow(slide,640,468,55,22,C.ochre,0);
  addDot(slide,750,485,10,C.teal); addLine(slide,715,520,785,520,{color:C.ink,width:1});
  drawLinePlot(slide,715,490,120,35,[0.1,0.25,0.7,0.28,0.12],C.teal,{min:0,max:0.8,width:1.5});
  addText(slide,"选定主位置模式",695,528,160,18,{size:14,bold:true,color:C.ink,align:"center"});
  addBox(slide,525,580,250,34,{fill:C.coralLight,line:C.coral,dashed:true,radius:"rounded-full"});
  addText(slide,"证据冲突 → 拒答",545,588,210,18,{size:16,bold:true,color:C.coral,align:"center"});
  // right window narrowing
  addText(slide,"主位置模式",970,135,190,22,{size:20,bold:true,color:C.teal,align:"center"});
  const windows=[[13,225,145],[9,345,115],[7,455,92],[5,555,70]];
  windows.forEach((w,i)=>{
    addText(slide,`${w[0]} 年`,915,w[1]-18,70,28,{size:22,bold:true,color:C.teal,align:"center"});
    addRingSystem(slide,1050,w[1],w[2],7,{color:C.ochre,majorColor:C.ochre,majorEvery:7});
    if(i<windows.length-1) addArrow(slide,1042,w[1]+w[2]/2+6,18,35,C.teal,90);
  });
  addBox(slide,940,635,250,38,{fill:C.teal,line:C.teal,radius:"rounded-full"});
  addText(slide,"唯一主复核事件",960,644,210,20,{size:18,bold:true,color:C.white,align:"center"});
  // checkpoints
  const checks=["candidate","detected","fused","retained","displayed","final"];
  checks.forEach((t,i)=>{addBox(slide,35+i*130,650,112,28,{fill:C.white,line:C.teal,radius:"rounded-full"});addText(slide,t,44+i*130,657,94,16,{size:11,color:C.ink,align:"center"});if(i<5)addArrow(slide,150+i*130,658,18,12,C.teal,0);});
  addNotes(slide, 7);
}

// Slide 8
{
  const slide = presentation.slides.add();
  await addBackground(slide, 8);
  addStandardHeader(slide, 8, "一次确认一个事件，编辑后立即重新诊断");
  addBox(slide,28,125,405,420,{fill:C.white,line:C.teal,radius:"rounded-xl"});
  addBox(slide,28,125,405,38,{fill:C.teal,line:C.teal,radius:"rounded-xl"});
  addText(slide,"9 年主复核窗：1949–1957",55,133,350,24,{size:20,bold:true,color:C.white,align:"center"});
  addText(slide,"Rank 1",55,180,100,20,{size:16,bold:true,color:C.ochre});
  const ranks=[["#1","1952",C.ochre],["#2","1951",C.teal],["#3","1953",C.plum]];
  ranks.forEach((r,i)=>{const yy=225+i*65;addText(slide,r[0],45,yy,35,20,{size:14,bold:true,color:C.ink});addRingSystem(slide,105,yy+10,44,4,{color:r[2],majorColor:r[2],majorEvery:4});addText(slide,r[1],145,yy-2,70,24,{size:17,bold:true,color:C.ink});});
  addText(slide,"用户选择年份 / 断点",235,180,170,20,{size:16,bold:true,color:C.ink,align:"center"});
  drawLinePlot(slide,235,230,155,90,[0.15,0.3,0.5,0.35,0.65,0.42,0.55,0.38],C.teal,{min:0,max:0.7,width:1.8,dots:true,highlight:4,highlightColor:C.ochre});
  addText(slide,"反事实预览",190,355,180,24,{size:19,bold:true,color:C.ink,align:"center"});
  addText(slide,"编辑前（当前）",190,385,110,18,{size:12,bold:true,color:C.ink,align:"center"});
  addText(slide,"编辑后（预览）",305,385,110,18,{size:12,bold:true,color:C.ink,align:"center"});
  drawLinePlot(slide,190,420,95,70,[0.2,0.3,0.48,0.6,0.4,0.25],C.teal,{min:0,max:0.7,width:1.4,dots:true});
  drawLinePlot(slide,315,420,95,70,[0.15,0.38,0.62,0.75,0.52,0.32],C.ochre,{min:0,max:0.8,width:1.4,dots:true});
  addArrow(slide,290,444,20,14,C.teal,0);
  addBox(slide,495,150,220,365,{fill:C.white,line:C.teal,radius:"rounded-xl"});
  addBox(slide,510,165,190,34,{fill:C.teal,line:C.teal,radius:"rounded-full"});
  addText(slide,"RwlEditor",520,173,170,20,{size:21,bold:true,color:C.white,align:"center"});
  addBox(slide,570,225,70,70,{fill:C.white,line:C.teal,radius:"rounded-md"});
  addText(slide,"✎",580,234,50,44,{size:32,bold:true,color:C.teal,align:"center"});
  addText(slide,"undo snapshot",540,315,130,20,{size:14,bold:true,color:C.ink,align:"center"});
  addText(slide,"operation log",540,360,130,20,{size:14,bold:true,color:C.ink,align:"center"});
  addBox(slide,520,390,170,105,{fill:C.white,line:C.teal,dashed:true,radius:"rounded-md"});
  ["source = auto-suggested","event ID","selectedYear","operation","before / after evidence"].forEach((t,i)=>addText(slide,t,535,400+i*18,140,16,{size:11,color:C.ink}));
  addArrow(slide,730,320,65,28,C.teal,0);
  // right loop
  addRingSystem(slide,1010,350,390,15,{color:"#E1DDD1",majorColor:C.rule,majorEvery:5});
  const loop=[[1010,165,"① working RWL 更新"],[1170,335,"② 旧事件 stale"],[1010,535,"③ 重新诊断"],[850,335,"④ 下一当前前沿"]];
  loop.forEach((n,i)=>{addDot(slide,n[0],n[1],34,C.teal,C.teal,1);addText(slide,["✓","×","∿","◎"][i],n[0]-18,n[1]-22,36,38,{size:26,bold:true,color:C.white,align:"center"});addText(slide,n[2],n[0]-95,n[1]+44,190,22,{size:16,bold:true,color:C.ink,align:"center"});});
  addArrow(slide,1092,205,35,18,C.teal,40); addArrow(slide,1138,435,35,18,C.teal,135); addArrow(slide,895,505,35,18,C.teal,220); addArrow(slide,855,235,35,18,C.teal,310);
  // bottom workflow and close
  const flow=[[80,"识别",C.teal],[245,"定位",C.teal],[410,"决策",C.teal],[575,"编辑",C.ochre],[740,"复核",C.coral]];
  flow.forEach((f,i)=>{addBox(slide,f[0],575,120,48,{fill:C.white,line:f[2],radius:"rounded-xl"});addText(slide,f[1],f[0]+18,588,84,22,{size:20,bold:true,color:f[2],align:"center"});if(i<4)addArrow(slide,f[0]+125,590,25,16,C.teal,0);});
  addBox(slide,320,645,600,42,{fill:C.teal,line:C.teal,radius:"rounded-full"});
  addText(slide,"算法生成主复核窗，专家完成定年判断",350,655,540,22,{size:22,bold:true,color:C.white,align:"center"});
  addNotes(slide, 8);
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

await fs.mkdir(RENDER_DIR, { recursive: true });
await fs.mkdir(LAYOUT_DIR, { recursive: true });

for (const [index, slide] of presentation.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  await writeBlob(path.join(RENDER_DIR, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(path.join(LAYOUT_DIR, `${stem}.layout.json`), await layout.text());
}

const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
await writeBlob(path.join(TMP_DIR, "montage.webp"), montage);

const inspection = await presentation.inspect({ kind: "slide,textbox,shape,image,notes", maxChars: 30000 });
await fs.writeFile(path.join(TMP_DIR, "inspection.ndjson"), inspection.ndjson);

const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(FINAL_PPTX);

console.log(JSON.stringify({ slides: presentation.slides.items.length, finalPptx: FINAL_PPTX, renderDir: RENDER_DIR }, null, 2));
