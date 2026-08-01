import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const resourceRoot = path.join(root, "src-tauri", "resources", "current_event_ranker");
const modelsRoot = path.join(resourceRoot, "models");
const tauriConfig = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const failures = [];
const searchableResources = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assertForbiddenAuditFlagsAreFalse = (value, location) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertForbiddenAuditFlagsAreFalse(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(final_blind_used|event_union_used)$/i.test(key) && child !== false) {
      failures.push(`${location}.${key} must be explicitly false`);
    }
    assertForbiddenAuditFlagsAreFalse(child, `${location}.${key}`);
  }
};

const modelSpecs = [
  {
    id: "current-event-range-v1.0.0",
    bundleVersion: "current-event-range-v1.0.0",
    bundleFileCount: 14,
    singleRange: false,
    adaptiveRange: false,
  },
  {
    id: "current-event-adaptive-range-v1",
    bundleVersion: "current-event-adaptive-range-gate-v1.3.0",
    bundleFileCount: 36,
    singleRange: true,
    adaptiveRange: true,
    rangeReliabilityFeatureCount: 109,
    manifestSha256: "09f3e4c37d7a4bc06586eca0012678788afd0c786701cd03821b2b4ca2077a78",
  },
  {
    id: "current-event-missing-rrf-v1",
    bundleVersion: "current-event-range-v1.0.0",
    bundleFileCount: 14,
    singleRange: false,
    adaptiveRange: false,
    rrfRoute: true,
    manifestSha256: "cda3c17af39d8a6964bf1d7ca410675919bfa0dfe0b49496569f2ba678796d3d",
    rootFiles: [
      "current_event_rrf_sidecar.py",
      "current_event_rrf_request.schema.json",
      "current_event_rrf_response.schema.json",
      "deployment_manifest.json",
    ],
  },
];

const exactShape = async (directory) => (
  (await readdir(directory, { withFileTypes: true }))
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"}:${entry.name}`)
    .sort()
);

if (JSON.stringify(await exactShape(resourceRoot)) !== JSON.stringify(["dir:models"])) {
  failures.push("current-event resource root must contain only the models directory");
}
if (JSON.stringify(await exactShape(modelsRoot)) !== JSON.stringify(
  modelSpecs.map((model) => `dir:${model.id}`).sort(),
)) {
  failures.push("packaged model directory set does not match the trusted catalog");
}

const summaries = [];
for (const spec of modelSpecs) {
  const modelRoot = path.join(modelsRoot, spec.id);
  const bundleDir = path.join(modelRoot, "bundle");
  const expectedRootFiles = spec.rootFiles ?? ["current_event_ranker_sidecar.py"];
  const expectedModelShape = [
    "dir:bundle",
    ...expectedRootFiles.map((name) => `file:${name}`),
  ].sort();
  if (JSON.stringify(await exactShape(modelRoot)) !== JSON.stringify(expectedModelShape)) {
    failures.push(`${spec.id}: model root has an unexpected shape`);
  }

  const manifest = JSON.parse(await readFile(path.join(bundleDir, "bundle_manifest.json"), "utf8"));
  const schema = JSON.parse(await readFile(path.join(bundleDir, "feature_schema.json"), "utf8"));
  const requestSchema = JSON.parse(await readFile(path.join(bundleDir, "current_event_request.schema.json"), "utf8"));
  const responseSchema = JSON.parse(await readFile(path.join(bundleDir, "current_event_response.schema.json"), "utf8"));
  const reliabilitySchema = JSON.parse(await readFile(path.join(bundleDir, "reliability_schema.json"), "utf8"));
  const runtimeConfig = JSON.parse(await readFile(path.join(bundleDir, "runtime_config.json"), "utf8"));
  const trainingManifest = JSON.parse(await readFile(path.join(bundleDir, "training_manifest.json"), "utf8"));
  const bundleFiles = await readdir(bundleDir);

  for (const fileName of bundleFiles.filter((name) => name.toLowerCase().endsWith(".json"))) {
    assertForbiddenAuditFlagsAreFalse(
      JSON.parse(await readFile(path.join(bundleDir, fileName), "utf8")),
      `${spec.id}/${fileName}`,
    );
  }

  if (spec.manifestSha256) {
    const manifestBytes = await readFile(path.join(bundleDir, "bundle_manifest.json"));
    if (sha256(manifestBytes) !== spec.manifestSha256) {
      failures.push(`${spec.id}: bundle manifest SHA-256 does not match the trusted upgrade`);
    }
  }

  if (manifest.protocol_version !== "crossdating.current-event.v1") {
    failures.push(`${spec.id}: unexpected protocol version`);
  }
  if (manifest.bundle_version !== spec.bundleVersion) {
    failures.push(`${spec.id}: unexpected bundle version`);
  }
  if (manifest.diagnostic_only !== true || manifest.automatic_writeback !== false) {
    failures.push(`${spec.id}: model must remain diagnostic-only without automatic writeback`);
  }
  const expectedBundleFiles = [
    "bundle_manifest.json",
    ...Object.values(manifest.files).map((record) => record.path),
  ].sort();
  if (
    bundleFiles.length !== spec.bundleFileCount
    || JSON.stringify([...bundleFiles].sort()) !== JSON.stringify(expectedBundleFiles)
  ) {
    failures.push(`${spec.id}: bundle is not the exact manifest file set`);
  }
  if (bundleFiles.some((name) => name.toLowerCase().endsWith(".jsonl"))) {
    failures.push(`${spec.id}: training JSONL must not be packaged`);
  }
  if (bundleFiles.some((name) => /final[_-]?blind|event[_-]?union/i.test(name))) {
    failures.push(`${spec.id}: forbidden final_blind/event_union resource name detected`);
  }

  for (const [label, record] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(bundleDir, record.path));
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      failures.push(`${spec.id}: ${label} byte count or hash mismatch`);
    }
  }

  const featureNames = schema.feature_names.map((row) => row.name);
  if (
    schema.feature_count !== 251
    || featureNames.length !== 251
    || schema.dtype !== "float64"
    || !schema.feature_names.every((row, index) => row.index === index && row.dtype === "float64")
  ) {
    failures.push(`${spec.id}: year schema must be ordered 251-column float64`);
  }
  if (featureNames.includes("zero_count") || featureNames.includes("remaining_event_count")) {
    failures.push(`${spec.id}: unavailable missing-count labels leaked into year features`);
  }
  if (
    runtimeConfig.candidate_pool !== "selected_top500"
    || runtimeConfig.feature_variant !== "deployable_no_missing_count"
    || runtimeConfig.automatic_writeback !== false
  ) {
    failures.push(`${spec.id}: runtime config violates the frozen desktop contract`);
  }
  if (
    trainingManifest.ranker?.params?.objective !== "lambdarank"
    || trainingManifest.ranker?.seed !== 17
    || trainingManifest.ranker_training?.source_files !== 327
    || trainingManifest.ranker_training?.series !== 923
    || trainingManifest.ranker_training?.rounds !== 2217
    || trainingManifest.ranker_training?.candidate_rows !== 444535
  ) {
    failures.push(`${spec.id}: unexpected full-data year-ranker training manifest`);
  }
  const zeroCounts = Object.keys(trainingManifest.ranker_training?.zero_count_distribution ?? {}).map(Number);
  if (zeroCounts.length === 0 || zeroCounts.some((count) => count < 1 || count > 6)) {
    failures.push(`${spec.id}: training zero_count lies outside 1..6`);
  }

  const requestProperties = requestSchema.properties.params.properties;
  if ("zero_count" in requestProperties || "remaining_event_count" in requestProperties) {
    failures.push(`${spec.id}: unavailable labels leaked into request protocol`);
  }
  if (requestProperties.confirmedInsertions.maxItems !== 6) {
    failures.push(`${spec.id}: confirmed insertion limit must remain 6`);
  }
  if (requestSchema.additionalProperties !== false || requestSchema.properties.params.additionalProperties !== false) {
    failures.push(`${spec.id}: request schema must reject properties outside the frozen JSONL contract`);
  }

  const reliabilityNames = reliabilitySchema.feature_names?.map((row) => row.name) ?? [];
  const expectedReliabilityNames = [
    "log_candidate_count",
    "round_index",
    "top1_score",
    "top2_score",
    "top1_top2_margin",
    "score_mean",
    "score_std",
    "top1_z",
    "top2_z",
    "margin_z",
  ];
  if (
    JSON.stringify(reliabilityNames) !== JSON.stringify(expectedReliabilityNames)
    || !reliabilitySchema.feature_names.every((row, index) => row.index === index)
  ) {
    failures.push(`${spec.id}: reliability schema must match the ordered 10-column float64 runtime contract`);
  }

  let rangeFeatureCount = null;
  if (spec.singleRange) {
    const rangeSchema = JSON.parse(
      await readFile(path.join(bundleDir, "current_event_range_feature_schema.json"), "utf8"),
    );
    rangeFeatureCount = rangeSchema.feature_count;
    if (
      rangeSchema.feature_count !== 70
      || rangeSchema.dtype !== "float32"
      || rangeSchema.feature_names.length !== 70
      || !rangeSchema.feature_names.every((row, index) => row.index === index && row.dtype === "float32")
    ) {
      failures.push(`${spec.id}: range schema must be ordered 70-column float32`);
    }
    if (
      runtimeConfig.single_event_range?.count !== 1
      || runtimeConfig.single_event_range?.max_width !== 15
      || runtimeConfig.single_event_range?.feature_count !== 70
    ) {
      failures.push(`${spec.id}: single event range runtime contract is invalid`);
    }
    if (spec.adaptiveRange && (
      runtimeConfig.single_event_range?.radius !== 7
      || runtimeConfig.single_event_range?.max_centers !== 120
      || typeof runtimeConfig.single_event_range?.adaptive_window !== "object"
      || runtimeConfig.single_event_range?.width_semantics !== "evidence-adaptive; max_width is an upper bound"
    )) {
      failures.push(`${spec.id}: adaptive event range runtime policy is invalid`);
    }
    const resultProperties = responseSchema.properties.result.properties;
    const eventRangeProperties = resultProperties.eventRange?.properties ?? {};
    if (
      eventRangeProperties.width?.maximum !== 15
      || eventRangeProperties.scope?.const !== "newest_unresolved_event"
      || !("baseRank" in resultProperties.suggestions.items.properties)
      || !("rangePromoted" in resultProperties.suggestions.items.properties)
    ) {
      failures.push(`${spec.id}: response schema does not expose one bounded range and exact-year ranks`);
    }
    if (spec.adaptiveRange && [
      "adaptive",
      "shrunk",
      "windowPolicy",
      "maxEnvelopeStart",
      "maxEnvelopeEnd",
      "evidencePeak",
      "evidenceMass",
    ].some((name) => !(name in eventRangeProperties))) {
      failures.push(`${spec.id}: response schema is missing adaptive range fields`);
    }
    if (spec.rangeReliabilityFeatureCount) {
      const rangeReliabilitySchema = JSON.parse(
        await readFile(
          path.join(bundleDir, "current_event_range_reliability_feature_schema.json"),
          "utf8",
        ),
      );
      if (
        rangeReliabilitySchema.feature_count !== spec.rangeReliabilityFeatureCount
        || rangeReliabilitySchema.dtype !== "float64"
        || rangeReliabilitySchema.feature_names.length !== spec.rangeReliabilityFeatureCount
        || !rangeReliabilitySchema.feature_names.every(
          (row, index) => row.index === index && row.dtype === "float64",
        )
      ) {
        failures.push(`${spec.id}: range reliability schema must be ordered 109-column float64`);
      }
      const rangeGate = runtimeConfig.single_event_range?.reliability_gates?.range;
      const yearGate = runtimeConfig.single_event_range?.reliability_gates?.year;
      if (
        rangeGate?.feature_count !== spec.rangeReliabilityFeatureCount
        || rangeGate?.independent_from_year_gate !== true
        || rangeGate?.threshold !== 0.33853178198144895
        || yearGate?.independent_from_range_gate !== true
      ) {
        failures.push(`${spec.id}: independent range/year gate runtime contract is invalid`);
      }
      if (!("rangeReliability" in resultProperties) || !("yearReliability" in resultProperties)) {
        failures.push(`${spec.id}: response schema is missing the independent gate results`);
      }
      const dualGateReference = JSON.parse(
        await readFile(path.join(bundleDir, "dual_gate_raw_prediction_reference.json"), "utf8"),
      );
      const dualStates = Object.fromEntries(
        dualGateReference.rows.map((row) => [row.caseId, row.expectedResult]),
      );
      if (
        dualGateReference.bundle_version !== spec.bundleVersion
        || dualGateReference.rows.length !== 3
        || dualStates.full_advice?.status !== "advice"
        || dualStates.full_advice?.suggestions?.length !== 5
        || dualStates.full_advice?.rangeReliability?.accepted !== true
        || dualStates.full_advice?.yearReliability?.accepted !== true
        || dualStates.range_only?.status !== "range_advice"
        || dualStates.range_only?.eventRange == null
        || dualStates.range_only?.suggestions?.length !== 0
        || dualStates.range_only?.rangeReliability?.accepted !== true
        || dualStates.range_only?.yearReliability?.accepted !== false
        || dualStates.range_rejected?.status !== "evidence_insufficient"
        || dualStates.range_rejected?.eventRange !== null
        || dualStates.range_rejected?.suggestions?.length !== 0
        || dualStates.range_rejected?.rangeReliability?.accepted !== false
      ) {
        failures.push(`${spec.id}: dual-gate raw reference does not contain the three frozen states`);
      }
    }
  } else if (bundleFiles.some((name) => /^current_event_range_|^range_prediction_reference/.test(name))) {
    failures.push(`${spec.id}: legacy bundle unexpectedly contains single-range artifacts`);
  }

  if (spec.rrfRoute) {
    const deploymentPath = path.join(modelRoot, "deployment_manifest.json");
    const deploymentBytes = await readFile(deploymentPath);
    const deployment = JSON.parse(deploymentBytes.toString("utf8"));
    const rrfRequestBytes = await readFile(path.join(modelRoot, "current_event_rrf_request.schema.json"));
    const rrfResponseBytes = await readFile(path.join(modelRoot, "current_event_rrf_response.schema.json"));
    const rrfSidecarBytes = await readFile(path.join(modelRoot, "current_event_rrf_sidecar.py"));
    const requestProperties = JSON.parse(rrfRequestBytes.toString("utf8")).properties.params.properties;
    const responseProperties = JSON.parse(rrfResponseBytes.toString("utf8")).properties.result.properties;
    if (
      sha256(deploymentBytes) !== "fa2385f3a2c3ada9976a21c6aa02b882e4fba94ef6d75924ef7517ccb116565b"
      || sha256(rrfRequestBytes) !== "61cc23052c29340f5068ab8e85bfbb5c77cece6843355e1d72cb5db196053c54"
      || sha256(rrfResponseBytes) !== "67ef5c1820123d53d690f8aa4894a2383542c738b7a86f188bf556f846c67223"
      || sha256(rrfSidecarBytes) !== "f43d3de6d94fcfc8342eee645f438cc778aba85989fe9ec5fb392a8621f22a22"
    ) {
      failures.push(`${spec.id}: RRF deployment manifest/schema/sidecar hash mismatch`);
    }
    if (
      deployment.manifest_version !== "current-event-rrf-deployment-candidate-v1"
      || deployment.diagnostic_only !== true
      || deployment.production_model_exported !== false
      || deployment.selected_mainline_replaced !== false
      || deployment.route?.route_version !== "missing-current-event-rrf0-range3-v1"
      || JSON.stringify(deployment.route?.operation_scope) !== JSON.stringify(["insert_missing"])
      || deployment.route?.existing_zero_policy !== "remove"
      || deployment.route?.top_k !== 5
      || deployment.route?.range_radius !== 3
      || deployment.route?.automatic_writeback !== false
      || deployment.model_bundle?.manifest?.sha256 !== spec.manifestSha256
      || deployment.model_bundle?.all_declared_hashes_verified !== true
      || deployment.implementation?.sidecar_executable?.bytes !== 77243967
      || deployment.implementation?.sidecar_executable?.sha256 !== "f3c48133091f886ea5372235e0db520682a5a939bb9cdb2c10b03fe7be83a4a8"
    ) {
      failures.push(`${spec.id}: frozen RRF deployment contract drifted`);
    }
    if (
      requestProperties.existingZeroPolicy?.const !== "remove"
      || requestProperties.topK?.const !== 5
      || requestProperties.rangeRadius?.const !== 3
      || requestProperties.confirmedInsertions?.maxItems !== 6
      || responseProperties.routeVersion?.const !== "missing-current-event-rrf0-range3-v1"
      || responseProperties.suggestions?.items?.properties?.evidence?.type !== "object"
    ) {
      failures.push(`${spec.id}: RRF machine-readable protocol does not match remove/5/3`);
    }
  }

  searchableResources.push(path.join(
    modelRoot,
    spec.rrfRoute ? "current_event_rrf_sidecar.py" : "current_event_ranker_sidecar.py",
  ));
  summaries.push({
    id: spec.id,
    bundleVersion: manifest.bundle_version,
    bundleFiles: bundleFiles.length,
    bundleBytes: (await Promise.all(bundleFiles.map(async (name) => (
      await readFile(path.join(bundleDir, name))
    )))).reduce((sum, bytes) => sum + bytes.length, 0),
    yearFeatureCount: schema.feature_count,
    rangeFeatureCount,
    rangeReliabilityFeatureCount: spec.rangeReliabilityFeatureCount ?? null,
    singleEventRange: spec.singleRange,
    adaptiveEventRange: spec.adaptiveRange,
    rrfRoute: spec.rrfRoute ?? false,
    manualOnly: spec.rrfRoute ?? false,
  });
}

const searchableText = (
  await Promise.all(searchableResources.map((resource) => readFile(resource, "utf8")))
).join("\n");
const finalBlindUsed = /final[_-]?blind/i.test(searchableText);
const eventUnionUsed = /event[_-]?union/i.test(searchableText);
if (finalBlindUsed || eventUnionUsed) {
  failures.push("forbidden final_blind/event_union reference detected in runtime resources");
}

const resources = tauriConfig.bundle.resources ?? {};
if (resources["resources/current_event_ranker"] !== "current_event_ranker") {
  failures.push("Tauri current-event resource mapping is missing");
}
for (const binary of [
  "bin/current-event-ranker-sidecar",
  "bin/current-event-adaptive-range-sidecar",
  "bin/current-event-rrf-sidecar",
]) {
  if (!(tauriConfig.bundle.externalBin ?? []).includes(binary)) {
    failures.push(`Tauri externalBin is missing ${binary}`);
  }
}
for (const executable of [
  "current-event-ranker-sidecar-x86_64-pc-windows-msvc.exe",
  "current-event-adaptive-range-sidecar-x86_64-pc-windows-msvc.exe",
  "current-event-rrf-sidecar-x86_64-pc-windows-msvc.exe",
]) {
  try {
    if ((await stat(path.join(root, "src-tauri", "bin", executable))).size === 0) {
      failures.push(`${executable} is empty`);
    }
  } catch {
    failures.push(`${executable} is missing`);
  }
}
const rrfExecutablePath = path.join(
  root,
  "src-tauri",
  "bin",
  "current-event-rrf-sidecar-x86_64-pc-windows-msvc.exe",
);
try {
  const bytes = await readFile(rrfExecutablePath);
  if (
    bytes.length !== 77243967
    || sha256(bytes) !== "f3c48133091f886ea5372235e0db520682a5a939bb9cdb2c10b03fe7be83a4a8"
  ) {
    failures.push("RRF external binary does not match the accepted deployment manifest");
  }
} catch {
  failures.push("RRF external binary cannot be hashed");
}
try {
  await stat(path.join(
    root,
    "src-tauri",
    "bin",
    "current-event-single-range-sidecar-x86_64-pc-windows-msvc.exe",
  ));
  failures.push("superseded current-event single-range sidecar is still packaged");
} catch {
  // The V1.1 executable must disappear when the adaptive V1.2 slot replaces it.
}

if (failures.length > 0) {
  console.error("Current-event multi-model integration validation failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  defaultModelId: "current-event-range-v1.0.0",
  models: summaries,
  protocolVersion: "crossdating.current-event.v1",
  diagnosticOnly: true,
  automaticWriteback: false,
  trainingJsonlPackaged: false,
  finalBlindUsed,
  eventUnionUsed,
}, null, 2));
