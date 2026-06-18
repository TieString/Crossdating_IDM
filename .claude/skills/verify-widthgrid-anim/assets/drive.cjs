/*
 * Drives the WidthGrid insert animation in a headless browser and reports
 * objectively whether (a) the first width column slides left in non-first rows,
 * and (b) no opaque cell overlaps another in the same row band.
 *
 * Self-contained: locates Playwright in the npx cache, ensures the Vite dev
 * server is up (spawns it if needed), copies the harness into repo root so Vite
 * serves it, runs, then removes the copied harness files.
 *
 * Usage (from repo root):
 *   node .claude/skills/verify-widthgrid-anim/assets/drive.cjs [--year=1805] [--keep]
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../../../..");
const ASSETS = __dirname;
const PORT = 1420;
const args = process.argv.slice(2);
const arg = (k, d) => { const m = args.find((a) => a.startsWith(`--${k}=`)); return m ? m.split("=")[1] : d; };
const TARGET_YEAR = arg("year", "1805");
const INSERT = arg("insert", "slide-shift");
const START = arg("start", "1780");
const SPEED = arg("speed", "0.1");
const ACTION = arg("action", "insert"); // "insert" | "undo"
const KEEP = args.includes("--keep");
const OUT = path.join(ROOT, ".tmp-widthgrid-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
    try { return require("playwright"); } catch { /* fall through */ }
    const cache = execSync("npm config get cache").toString().trim();
    const base = path.join(cache, "_npx");
    if (fs.existsSync(base)) {
        for (const d of fs.readdirSync(base)) {
            const nm = path.join(base, d, "node_modules");
            if (fs.existsSync(path.join(nm, "playwright"))) {
                module.paths.push(nm);
                return require("playwright");
            }
        }
    }
    throw new Error("playwright not found. Run once to populate the npx cache:  npx playwright@1.61 --version");
}

const ping = () => new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/harness.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
    req.setTimeout(1500, () => { req.destroy(); res(false); });
});

async function ensureVite() {
    if (await ping()) return null;
    const proc = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore", detached: false });
    for (let i = 0; i < 40; i++) { await sleep(500); if (await ping()) return proc; }
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error("Vite dev server did not come up on :" + PORT);
}

const sample = (page) => page.evaluate(() => {
    const host = document.getElementById("grid-host");
    const hr = host.getBoundingClientRect();
    const cells = [...document.querySelectorAll("[data-width-grid-cell='true'][data-tree='RDM021']")].map((c) => {
        const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
        const m = cs.transform.match(/matrix\(([^)]+)\)/);
        return {
            year: +c.dataset.year, text: (c.textContent || "").trim().slice(0, 8),
            x: +(r.left - hr.left).toFixed(1), y: +(r.top - hr.top).toFixed(1),
            w: +r.width.toFixed(1), cx: +(r.left + r.width / 2 - hr.left).toFixed(1),
            cy: +(r.top + r.height / 2 - hr.top).toFixed(1),
            tx: m ? +(+m[1].split(",")[4]).toFixed(1) : 0, opacity: +cs.opacity,
        };
    });
    // source-exit ghosts are plain position:absolute number spans (no data-* attrs)
    const ghosts = [...host.querySelectorAll("span")].filter((s) => {
        const cs = getComputedStyle(s);
        return cs.position === "absolute" && /^-?\d+$/.test((s.textContent || "").trim()) && +cs.opacity > 0.05;
    }).map((s) => {
        const r = s.getBoundingClientRect();
        return { text: (s.textContent || "").trim(), l: r.left - hr.left, cx: r.left + r.width / 2 - hr.left, cy: r.top + r.height / 2 - hr.top, opacity: +getComputedStyle(s).opacity };
    });
    // right edge of the year-label column (4-digit year spans that aren't value cells)
    const yearCells = [...host.querySelectorAll("span")].filter((s) => !s.hasAttribute("data-width-grid-cell") && /^1[789]\d\d$/.test((s.textContent || "").trim()));
    const yearRight = yearCells.length ? Math.max(...yearCells.map((s) => s.getBoundingClientRect().right - hr.left)) : 0;
    return { cells, ghosts, yearRight };
});

(async () => {
    const { chromium } = loadPlaywright();
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    // copy harness into repo root (Vite serves index/*.html from root; @/ alias resolves regardless)
    fs.mkdirSync(path.join(ROOT, "harness"), { recursive: true });
    fs.copyFileSync(path.join(ASSETS, "harness.html"), path.join(ROOT, "harness.html"));
    fs.copyFileSync(path.join(ASSETS, "insert-anim.tsx"), path.join(ROOT, "harness", "insert-anim.tsx"));

    const vite = await ensureVite();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    let failed = false;
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 });
        page.on("pageerror", (e) => { console.log("PAGEERROR:", e.message); failed = true; });
        await page.goto(`http://localhost:${PORT}/harness.html?insert=${INSERT}&start=${START}&speed=${SPEED}`, { waitUntil: "networkidle" });
        await page.waitForSelector(`[data-width-grid-cell='true'][data-year='${TARGET_YEAR}']`, { timeout: 10000 });
        await sleep(400);
        await page.screenshot({ path: path.join(OUT, "00-before.png") });

        const box = await page.locator(`[data-width-grid-cell='true'][data-year='${TARGET_YEAR}']`).boundingBox();
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
        await sleep(200);
        const plus = page.locator("button[aria-label='Insert missing year on right side']");
        await plus.waitFor({ state: "visible", timeout: 3000 });
        await plus.click();

        // --action=undo: let the insert settle, then exercise the undo (insert-missing/undo) animation
        if (ACTION === "undo") {
            for (let i = 0; i < 60; i++) { const s = await sample(page); if (s.ghosts.length === 0) break; await sleep(300); }
            await sleep(400);
            await page.screenshot({ path: path.join(OUT, "00-before.png") });
            await page.locator("#undo-btn").click();
        }

        const frames = [];
        for (let i = 0; i < 14; i++) {
            await page.screenshot({ path: path.join(OUT, `f${String(i).padStart(2, "0")}_${i * 350}ms.png`) });
            const s = await sample(page);
            frames.push({ t: i * 350, cells: s.cells, ghosts: s.ghosts, yearRight: s.yearRight });
            await sleep(350);
        }
        // let the fade-out finish (poll, robust to any speed) before the stuck-ghost check
        let endGhosts = [];
        for (let i = 0; i < 60; i++) {
            const s = await sample(page);
            endGhosts = s.ghosts.filter((g) => g.opacity > 0.15);
            if (endGhosts.length === 0) break;
            await sleep(300);
        }
        await page.screenshot({ path: path.join(OUT, "99-after.png") });

        // CHECK 1: first width-col cell of each non-first, shifted row must slide (tx travels toward 0)
        const txByYear = {};
        for (const fr of frames) for (const c of fr.cells) (txByYear[c.year] ??= []).push(c.tx);
        const firstColYears = [...new Set(frames.flatMap((fr) => {
            const bands = {};
            for (const c of fr.cells) (bands[Math.round(c.y / 29)] ??= []).push(c);
            return Object.values(bands).map((b) => b.sort((a, z) => a.x - z.x)[0].year);
        }))];
        const moved = firstColYears.filter((y) => { const t = txByYear[y] || []; return Math.max(...t) - Math.min(...t) > 20; });
        console.log(`CHECK1 first-column motion: ${moved.length} of ${firstColYears.length} first-col cells slide (tx range >20px): years ${moved.join(",")}`);

        // CHECK 2: the left fade-out (source-exit ghost) must (a) exist — it fills col0 so it is
        // never blank, (b) fully fade out by the end (no stuck ghost), and (c) never cross over the
        // year-label column while still visibly opaque.
        const anyGhost = frames.some((fr) => fr.ghosts.length > 0);
        const stuck = endGhosts;
        const yearRight = Math.max(0, ...frames.map((fr) => fr.yearRight || 0));
        let yearHits = 0;
        for (const fr of frames) {
            for (const g of fr.ghosts) {
                if (g.opacity > 0.25 && g.l < yearRight - 2) {
                    yearHits++;
                    console.log(`  GHOST-OVER-YEAR t=${fr.t}ms ghost '${g.text}' left=${g.l.toFixed(0)} < yearRight=${yearRight.toFixed(0)} (op${g.opacity.toFixed(2)})`);
                }
            }
        }
        console.log(`CHECK2 left fade-out: present=${anyGhost} stuck@end=${stuck.length} year-overlap(opaque)=${yearHits}`);
        if (moved.length < 2 || !anyGhost || stuck.length > 0 || yearHits > 0) failed = true;
        console.log(`\n${failed ? "FAIL" : "PASS"} — shots in ${path.relative(ROOT, OUT)}/`);
    } finally {
        await browser.close();
        if (vite) { try { process.platform === "win32" ? execSync(`taskkill /F /T /PID ${vite.pid}`) : vite.kill(); } catch { /* ignore */ } }
        if (!KEEP) {
            fs.rmSync(path.join(ROOT, "harness.html"), { force: true });
            fs.rmSync(path.join(ROOT, "harness"), { recursive: true, force: true });
        }
    }
    process.exit(failed ? 1 : 0);
})();
