/** Exercise the real Vite config with the existing multi-million-file cache. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, loadConfigFromFile } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = process.argv.slice(2);
const option = (key, fallback) => options.includes(key) ? options[options.indexOf(key) + 1] : fallback;
const duration = Number(option("--seconds", "150"));
const port = Number(option("--port", "1430"));
const output = resolve(root, option("--output", ".benchmark-results/vite-dev-watch-check.json"));
assert(duration >= 90, "Exercise beyond the original ~70-second crash point");
const normalize = value => value.replaceAll("\\", "/");
const report = { root, port, requestedSeconds: duration, raisedHeapLimit: false, samples: [], http: [], passed: false };
let server, sourceProbe, ignoredProbe;
const started = performance.now();
const sourceHash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const modelPath = join(root, "public/models/unifiedV5Model.json");
const modelBefore = await sourceHash(modelPath);
const waitFor = async (check, label, milliseconds = 15000) => {
    const began = performance.now();
    while (!check()) {
        assert(performance.now() - began < milliseconds, `Timed out waiting for ${label}`);
        await delay(100);
    }
};

try {
    // Reject a regressed config before allowing it to scan the large cache.
    const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, join(root, "vite.config.ts"));
    assert(loaded?.config.server?.watch?.ignored?.includes("**/.benchmark-results/**"));
    server = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "warn",
        server: { host: "127.0.0.1", port, strictPort: true, open: false } });
    await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const request = async path => {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
        assert.equal(response.status, 200, `HTTP ${path}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        report.http.push({ path, status: response.status, bytes: bytes.length });
        return bytes;
    };
    await request("/");
    await request("/@vite/client");
    const model = await request("/models/unifiedV5Model.json");
    assert.equal(createHash("sha256").update(model).digest("hex"), modelBefore);

    // Load the application's actual source import graph, not just an empty index.
    const queue = ["/src/app/main.tsx", "/src/pages/home/diagnosisWorker.ts?worker_file&type=module"];
    const visited = new Set();
    while (queue.length) {
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);
        assert(visited.size <= 2000, "Unexpected import graph expansion");
        await request(url);
        const module = await server.moduleGraph.getModuleByUrl(url);
        for (const child of module?.importedModules ?? []) if (child.url.startsWith("/src/") && !visited.has(child.url)) queue.push(child.url);
    }
    report.projectModulesLoaded = visited.size;

    sourceProbe = await mkdtemp(join(root, "src", ".vite-watch-smoke-"));
    ignoredProbe = await mkdtemp(join(root, ".benchmark-results", ".vite-watch-smoke-"));
    const sourceFile = join(sourceProbe, "probe.ts"), ignoredFile = join(ignoredProbe, "probe.txt");
    const sourceUrl = "/src/" + basename(sourceProbe) + "/probe.ts";
    const changes = [], updates = [];
    server.watcher.on("all", (event, path) => changes.push({ event, path: normalize(path) }));
    const send = server.ws.send.bind(server.ws);
    server.ws.send = (...args) => {
        if (typeof args[0] === "object") updates.push(args[0]);
        return send(...args);
    };
    await writeFile(sourceFile, "export const value = 1; if (import.meta.hot) import.meta.hot.accept();\n");
    await writeFile(ignoredFile, "ignored-one\n");
    await waitFor(() => changes.some(event => event.path === normalize(sourceFile)), "source file registration");
    await request(sourceUrl);
    changes.length = 0;
    updates.length = 0;
    await writeFile(sourceFile, "export const value = 2; if (import.meta.hot) import.meta.hot.accept();\n");
    await writeFile(ignoredFile, "ignored-two\n");
    await waitFor(() => updates.some(message => message.type === "update" && message.updates.some(update => update.path === sourceUrl)), "HMR update");
    report.hmrUpdate = true;

    do {
        await delay(5000);
        const watched = server.watcher.getWatched(), memory = process.memoryUsage();
        const excluded = Object.keys(watched).filter(path => normalize(path).includes("/.benchmark-results"));
        assert.equal(excluded.length, 0, "Research cache entered watcher directory index");
        assert(!changes.some(event => event.path.startsWith(normalize(ignoredProbe) + "/")), "Ignored cache emitted a file event");
        assert(memory.heapUsed < 1024 ** 3, "Development heap exceeded the 1 GiB safety bound");
        const sample = { seconds: (performance.now() - started) / 1000, heapMB: memory.heapUsed / 1048576,
            rssMB: memory.rss / 1048576, watchedDirectories: Object.keys(watched).length,
            watchedEntries: Object.values(watched).reduce((count, files) => count + files.length, 0), cacheDirectoriesWatched: excluded.length };
        report.samples.push(sample);
        process.stdout.write(JSON.stringify(sample) + "\n");
    } while ((performance.now() - started) / 1000 < duration);
    await request("/");
    await request("/src/app/main.tsx");
    assert.equal(await sourceHash(modelPath), modelBefore);
    report.modelSha256 = modelBefore;
    report.passed = true;
} catch (error) {
    report.error = error.stack ?? String(error);
    process.exitCode = 1;
} finally {
    await server?.close();
    // Only remove the two fresh test directories, never an existing cache.
    for (const [path, parent] of [[sourceProbe, join(root, "src")], [ignoredProbe, join(root, ".benchmark-results")]]) {
        if (!path) continue;
        const resolved = resolve(path);
        assert.equal(dirname(resolved), parent);
        assert(basename(resolved).startsWith(".vite-watch-smoke-"));
        assert(resolved.startsWith(root + sep));
        await rm(resolved, { recursive: true, force: true });
    }
    report.elapsedSeconds = (performance.now() - started) / 1000;
    report.serverClosed = true;
    report.temporaryProbesRemoved = true;
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, samples: undefined, http: undefined, output }, null, 2));
}
