import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const hmrPort = 20_000 + Math.floor(Math.random() * 20_000);

const server = await createServer({
  configFile: false,
  appType: "custom",
  logLevel: "error",
  resolve: {
    alias: {
      "@": path.join(process.cwd(), "src"),
    },
  },
  optimizeDeps: { noDiscovery: true },
  server: { hmr: { port: hmrPort }, middlewareMode: true },
});

const assertIncludes = (html, value, message) => {
  assert.ok(html.includes(value), message ?? `Expected rendered HTML to include ${value}`);
};

const assertArrayIncludes = (values, value, message) => {
  assert.ok(values.includes(value), message ?? `Expected array to include ${value}`);
};

const serializeSiteDataForAssert = (siteData) => JSON.stringify(
  Array.from(siteData.entries()).map(([tree, treeData]) => [
    tree,
    Array.from(treeData.entries()).sort(([yearA], [yearB]) => yearA - yearB),
  ]).sort(([treeA], [treeB]) => treeA.localeCompare(treeB)),
);

function buildHistorySmokeData() {
  return new Map([
    ["SMK001", new Map([
      [1900, 11],
      [1901, 12],
      [1902, 13],
      [1903, 14],
      [1904, 15],
    ])],
    ["SMK002", new Map([
      [1900, 21],
      [1901, 22],
      [1902, 23],
      [1903, 24],
      [1904, 25],
    ])],
  ]);
}

const sampleEntries = [
  {
    id: "manual-1",
    sequence: 1,
    timestamp: "2026-06-16T04:00:00.000Z",
    tree: "EBD011",
    summary: "修改宽度",
    detail: "1847: 120 -> 118",
    operationType: "UPDATE_WIDTH_VALUE",
    source: "manual",
    targetYear: 1847,
    oldValue: 120,
    newValue: 118,
    reason: "人工复核",
    metricsBefore: { localCorrelation: 0.21 },
    metricsAfter: { localCorrelation: 0.34 },
    isApplied: true,
    isReverted: false,
    canUndo: true,
    canRedo: false,
    canUndoBatch: false,
    undoDepth: 1,
    redoDepth: 0,
  },
  {
    id: "batch-1",
    sequence: 2,
    timestamp: "2026-06-16T04:01:00.000Z",
    tree: "EBD151",
    summary: "应用候选",
    detail: "平移 -1 年",
    operationType: "APPLY_SUGGESTION",
    source: "auto-suggested",
    targetYear: 1901,
    affectedRange: { startYear: 1901, endYear: 1950 },
    reason: "segment correlation improved",
    metricsBefore: { localCorrelation: 0.12 },
    metricsAfter: { localCorrelation: 0.48, delta: 0.36 },
    batchId: "suggestion-batch-smoke-2",
    isApplied: true,
    isReverted: false,
    canUndo: true,
    canRedo: false,
    canUndoBatch: true,
    undoDepth: 2,
    redoDepth: 0,
  },
  {
    id: "cofecha-1",
    sequence: 3,
    timestamp: "2026-06-16T04:02:00.000Z",
    tree: "COFECHA",
    summary: "运行 COFECHA",
    detail: "COFECHA · A/problem 1 · Intercorr. 0.657",
    operationType: "RUN_COFECHA",
    source: "cofecha-assisted",
    reason: "manual validation",
    cofechaAfter: { possibleProblemsCount: 1 },
    isApplied: true,
    isReverted: false,
    canUndo: false,
    canRedo: false,
    canUndoBatch: false,
    undoDepth: 0,
    redoDepth: 0,
  },
];

try {
  const pages = await server.ssrLoadModule("/src/pages/home/WorkspacePages.tsx");
  const homeWorkspace = await server.ssrLoadModule("/src/pages/home/useHomeWorkspace.ts");
  const bridge = await server.ssrLoadModule("/src/pages/home/workspaceWindowBridge.ts");
  const formatter = await server.ssrLoadModule("/src/features/cofecha/formatter.ts");
  const validation = await server.ssrLoadModule("/src/features/crossdating/validation.ts");
  const rwlEdit = await server.ssrLoadModule("/src/features/rwl/edit.ts");

  assert.equal(bridge.workspaceWindowLabels["operation-log"], "workspace-operation-log");
  assert.equal(bridge.workspaceWindowLabels.cofecha, "workspace-cofecha");
  assert.equal(bridge.workspaceWindowLabels["line-chart"], "workspace-line-chart");
  assert.equal(bridge.workspaceWindowTitles["operation-log"], "操作日志");
  assert.equal(bridge.isWorkspaceWindowLabel("operation-log", "workspace-operation-log"), true);
  assert.equal(bridge.isWorkspaceWindowLabel("operation-log", "workspace-line-chart"), false);
  assert.deepEqual(
    bridge.createWorkspaceWindowClosedPayload("cofecha", "workspace-cofecha"),
    { kind: "cofecha", requesterLabel: "workspace-cofecha" },
  );

  const capabilityPath = path.join(process.cwd(), "src-tauri", "capabilities", "default.json");
  const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
  for (const label of Object.values(bridge.workspaceWindowLabels)) {
    assertArrayIncludes(capability.windows, label, `Capability must include workspace window ${label}`);
  }
  for (const permission of [
    "core:webview:allow-create-webview-window",
    "core:window:allow-set-focus",
    "core:window:allow-show",
    "core:window:allow-unminimize",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-toggle-maximize",
  ]) {
    assertArrayIncludes(capability.permissions, permission, `Capability must allow ${permission}`);
  }

  const syntheticCofechaReport = `
Program COFECHA smoke
Segments, possible problems  1
Series intercorrelation  .657
Average mean sensitivity  .190
Mean length of series  193.9
PART 2:
placeholder
PART 3:
  1900  .50
PART 6:  POTENTIAL PROBLEMS:

 EBD011    1850 to  2024     175 years                                                                                    Series   1

 [A] Segment   High   -10   -9   -8   -7   -6   -5   -4   -3   -2   -1   +0   +1   +2
    1950 1999    8   -.01 -.06 -.14  .09 -.22  .22  .09 -.02  .03  .00  .21| .18 -.10

 [B] Entire series, effect on correlation (  .489) is:
       Lower   1974< -.083  Higher   1932  .022

 [C] Year-to-year changes diverging by over 4.0 std deviations:
       1973 1974  -4.4 SD

 [E] Outliers     1   3.0 SD above or -4.5 SD below mean for year
       1890 +3.2 SD
 ===================================================================================================================================

 EBD012    1861 to  2024     164 years                                                                                    Series   2

 [B] Entire series, effect on correlation (  .637) is:
       Lower   1980< -.025  Higher   1988  .019
 ===================================================================================================================================
PART 7:
   1 EBD011   1850 2024    175      6      1    .454
`;
  const syntheticCofecha = formatter.parseCofechaResult(syntheticCofechaReport);
  const ebd011ProblemDetail = syntheticCofecha.possibleProblemsDetail.get("EBD011") ?? "";
  assert.equal(syntheticCofecha.possibleProblemsCount, 1);
  assert.equal(syntheticCofecha.seriesProblemCounts.get("EBD011"), 1);
  assert.equal(syntheticCofecha.possibleProblemsDetail.has("EBD012"), false);
  assertIncludes(ebd011ProblemDetail, "[A] Segment");
  assertIncludes(ebd011ProblemDetail, "[B] Entire series");
  assertIncludes(ebd011ProblemDetail, "[C] Year-to-year changes");
  assertIncludes(ebd011ProblemDetail, "[E] Outliers");

  const failedValidation = validation.buildCrossdatingValidationSummary({
    hasData: true,
    isCofechaRunning: false,
    isCofechaOutdated: false,
    cofechaPossibleProblemsCount: 1,
    cofechaProblemSeries: ["EBD011"],
    internalProblemSegmentCount: 0,
    internalCandidateCount: 0,
    batchResult: null,
  });
  assert.equal(failedValidation.status, "failed");
  assert.ok(failedValidation.items.some((item) => item.includes("EBD011")));

  const staleValidation = validation.buildCrossdatingValidationSummary({
    hasData: true,
    isCofechaRunning: false,
    isCofechaOutdated: true,
    cofechaPossibleProblemsCount: 1,
    cofechaProblemSeries: ["EBD011"],
    internalProblemSegmentCount: 0,
    internalCandidateCount: 0,
    batchResult: null,
  });
  assert.equal(staleValidation.status, "stale");
  assert.ok(staleValidation.items.some((item) => item.includes("EBD011")));

  const restoredCofechaLog = [
    { ...sampleEntries[2], id: "cofecha-restored-1", sequence: 1 },
    { ...sampleEntries[2], id: "cofecha-restored-2", sequence: 2 },
  ];
  const appendedCofechaLog = homeWorkspace.appendCofechaOperationLogEntry(
    restoredCofechaLog,
    { ...sampleEntries[2], id: "cofecha-new-run", sequence: 3 },
  );
  assert.deepEqual(appendedCofechaLog.map((entry) => entry.id), [
    "cofecha-restored-1",
    "cofecha-restored-2",
    "cofecha-new-run",
  ]);

  const fullCofechaLog = Array.from({ length: 200 }, (_, index) => ({
    ...sampleEntries[2],
    id: `cofecha-old-${index}`,
    sequence: index + 1,
  }));
  const trimmedCofechaLog = homeWorkspace.appendCofechaOperationLogEntry(
    fullCofechaLog,
    { ...sampleEntries[2], id: "cofecha-trimmed-new", sequence: 201 },
  );
  assert.equal(trimmedCofechaLog.length, 200);
  assert.equal(trimmedCofechaLog[0].id, "cofecha-old-1");
  assert.equal(trimmedCofechaLog.at(-1).id, "cofecha-trimmed-new");

  const operationLogHtml = renderToStaticMarkup(React.createElement(pages.OperationLogPage, {
    fileName: "smoke.rwl",
    operationLog: sampleEntries,
    canResetToRawData: true,
    onUndoEntry() {},
    onUndoBatch() {},
    onRedoEntry() {},
    onJumpEntry() {},
    onResetToRawData() {},
    onClose() {},
  }));

  assertIncludes(operationLogHtml, "操作日志");
  assertIncludes(operationLogHtml, "aria-label=\"关闭\"");
  assertIncludes(operationLogHtml, "smoke.rwl");
  assertIncludes(operationLogHtml, "显示 / 总计");
  assertIncludes(operationLogHtml, "搜索");
  assertIncludes(operationLogHtml, "全部来源");
  assertIncludes(operationLogHtml, "全部状态");
  assertIncludes(operationLogHtml, "建议批次");
  assertIncludes(operationLogHtml, "回到原始");
  assertIncludes(operationLogHtml, "应用候选");
  assertIncludes(operationLogHtml, "segment correlation improved");
  assertIncludes(operationLogHtml, "suggestion-batch-smoke-2");
  assertIncludes(operationLogHtml, "aria-label=\"整批回滚 suggestion-batch-smoke-2\"");
  assertIncludes(operationLogHtml, "title=\"定位到 EBD151 1901\"");
  assertIncludes(operationLogHtml, "title=\"撤销该条操作\"");
  assertIncludes(operationLogHtml, "title=\"重做该条操作\"");
  assertIncludes(operationLogHtml, "COFECHA · A/problem 1");

  const cofechaHtml = renderToStaticMarkup(React.createElement(pages.CofechaReportPage, {
    cofechaResult: {
      possibleProblemsCount: 1,
      masterSeriesYear: 350,
      seriesIntercorrelation: 0.657,
      averageMeanSensitivity: 0.19,
      meanLength: 193.9,
    },
    isCofechaOutdated: true,
    isCofechaRunning: false,
    canRunValidation: true,
    validationSummary: {
      severity: "warning",
      title: "需要重新验证",
      detail: "当前 working series 已变化",
      items: ["最近批次：请求 2，应用 1，跳过 1，失败 0"],
    },
    linkedReport: {
      html: "<span data-cofecha-link=\"true\" data-tree=\"EBD011\">EBD011</span>",
      count: 1,
    },
    partOptions: [
      { value: "ALL", label: "全部内容" },
      { value: "PART 6", label: "PART 6" },
    ],
    selectedPart: "ALL",
    jumpTarget: { id: 1, tree: "EBD011" },
    onSelectedPartChange() {},
    onRunValidation() {},
    onTextClick() {},
    onTextKeyDown() {},
    onClose() {},
  }));

  assertIncludes(cofechaHtml, "COFECHA");
  assertIncludes(cofechaHtml, "aria-label=\"关闭\"");
  assertIncludes(cofechaHtml, "VERYCOF.OUT · 上次结果");
  assertIncludes(cofechaHtml, "待验证");
  assertIncludes(cofechaHtml, "重新验证");
  assertIncludes(cofechaHtml, "需要重新验证");
  assertIncludes(cofechaHtml, "最近批次");
  assertIncludes(cofechaHtml, "EBD011");

  const initialHistoryData = buildHistorySmokeData();
  const initialHistorySignature = serializeSiteDataForAssert(initialHistoryData);
  const batchId = "suggestion-batch-history-smoke";
  const editor = new rwlEdit.RwlEditor(initialHistoryData);

  editor.insertMissingYearAtSide("SMK001", 1902, "right", {
    operationType: "APPLY_SUGGESTION",
    source: "auto-suggested",
    reason: "history smoke insert",
    batchId,
  });
  editor.deleteYearWithMode("SMK002", 1903, "direct", "right", {
    operationType: "APPLY_SUGGESTION",
    source: "auto-suggested",
    reason: "history smoke delete",
    batchId,
  });

  const changedSignature = serializeSiteDataForAssert(editor.getData());
  assert.notEqual(changedSignature, initialHistorySignature);
  assert.equal(editor.hasRawDataChanges(), true);
  assert.equal(editor.getOperationLog().filter((entry) => entry.batchId === batchId).length, 2);
  assert.equal(editor.getOperationLog().every((entry) => entry.canUndoBatch), true);

  const persistedWhileChanged = editor.toHistorySnapshot();
  const restoredChanged = new rwlEdit.RwlEditor(new Map());
  restoredChanged.restorePersistedHistory(persistedWhileChanged);
  assert.equal(serializeSiteDataForAssert(restoredChanged.getData()), changedSignature);
  assert.equal(restoredChanged.getOperationLog().every((entry) => entry.canUndoBatch), true);

  const rollbackAnimation = restoredChanged.undoOperationLogBatch(batchId);
  assert.ok(rollbackAnimation, "Expected batch rollback to return the last rollback animation");
  assert.equal(serializeSiteDataForAssert(restoredChanged.getData()), initialHistorySignature);
  assert.equal(restoredChanged.hasRawDataChanges(), false);
  assert.equal(restoredChanged.getOperationLog().every((entry) => entry.isReverted), true);
  assert.equal(restoredChanged.getOperationLog().some((entry) => entry.canUndoBatch), false);

  const persistedAfterRollback = restoredChanged.toHistorySnapshot();
  const restoredRollback = new rwlEdit.RwlEditor(new Map());
  restoredRollback.restorePersistedHistory(persistedAfterRollback);
  assert.equal(serializeSiteDataForAssert(restoredRollback.getData()), initialHistorySignature);
  assert.equal(restoredRollback.getOperationLog().every((entry) => entry.isReverted), true);

  console.log("Workspace window smoke validation passed.");
} finally {
  await server.close();
}
