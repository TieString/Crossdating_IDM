import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const explicitRoot = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const sampleRoot = explicitRoot
  ? path.resolve(process.cwd(), explicitRoot)
  : path.join(process.cwd(), "test-data");

async function listSamples(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const pairedSamples = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const folder = path.join(root, entry.name);
      return ["RAW.rwl", "crossdated.rwl"]
        .map((fileName) => path.join(folder, fileName))
        .filter((filePath) => existsSync(filePath));
    });
  const standaloneSamples = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".rwl")
    .map((entry) => path.join(root, entry.name));
  return [...pairedSamples, ...standaloneSamples]
    .sort((left, right) => left.localeCompare(right));
}

function dataSignature(data) {
  return JSON.stringify(Array.from(data, ([seriesId, values]) => {
    const entries = Array.from(values);
    while (entries.length > 0) {
      const terminalValue = entries.at(-1)?.[1];
      if (terminalValue !== 999 && terminalValue !== -9999) break;
      entries.pop();
    }
    return [seriesId, entries];
  }));
}

async function inspectSample(filePath, rwlModule) {
  const text = await readFile(filePath, "utf8");
  const result = await rwlModule.readRwlString(text);
  if (result.data.size === 0) {
    throw new Error(`${filePath}: parsed data is empty`);
  }

  let roundTrip = "n/a";
  const formatter = rwlModule.formatHandlers[result.format]?.format;
  if (formatter) {
    const formatted = formatter(result.data, result.readOptions);
    const reparsed = await rwlModule.readRwlString(formatted, { preferFormat: result.format });
    if (dataSignature(reparsed.data) !== dataSignature(result.data)) {
      throw new Error(`${filePath}: parse/format round trip changed data`);
    }
    roundTrip = "ok";
  }

  const valueCount = Array.from(result.data.values())
    .reduce((total, values) => total + values.size, 0);
  return {
    file: path.relative(sampleRoot, filePath),
    format: result.format,
    seriesCount: result.data.size,
    valueCount,
    roundTrip,
  };
}

async function main() {
  if (!existsSync(sampleRoot)) {
    throw new Error(`Sample root not found: ${sampleRoot}`);
  }

  const server = await createServer({
    configFile: false,
    appType: "custom",
    logLevel: "error",
    resolve: { alias: { "@": path.join(process.cwd(), "src") } },
    optimizeDeps: { noDiscovery: true },
    server: {
      hmr: { port: 20_000 + Math.floor(Math.random() * 20_000) },
      middlewareMode: true,
    },
  });

  try {
    const rwlModule = await server.ssrLoadModule("/src/features/rwl/index.ts");
    const samples = await listSamples(sampleRoot);
    if (samples.length === 0) {
      throw new Error(`No RWL samples found under ${sampleRoot}`);
    }

    const rows = [];
    for (const filePath of samples) {
      rows.push(await inspectSample(filePath, rwlModule));
    }

    console.log(`Sample root: ${sampleRoot}`);
    console.log("file       format  series  values  round trip");
    console.log("---------  ------  ------  ------  ----------");
    for (const row of rows) {
      console.log(
        `${row.file.padEnd(9)}  ${row.format.padEnd(6)}  ${String(row.seriesCount).padStart(6)}  ${String(row.valueCount).padStart(6)}  ${row.roundTrip}`,
      );
    }
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
