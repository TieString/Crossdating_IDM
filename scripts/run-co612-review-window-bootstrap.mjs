import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const npmConfigValue = (name) => (
    process.env[`npm_config_${name.replaceAll("-", "_")}`]
    ?? process.env[`npm_config_${name}`]
);
const npmValueOptions = [
    ["input", "--input"],
    ["output-dir", "--output-dir"],
    ["run-id", "--run-id"],
    ["max-rounds", "--max-rounds"],
    ["workers", "--workers"],
    ["minimum-first-sweep-correct-windows", "--minimum-first-sweep-correct-windows"],
    ["reference-mode", "--reference-mode"],
];
const npmPositionalValues = [...rawArgs];
const npmForwardedArgs = npmValueOptions.flatMap(([name, flag]) => {
    const value = npmConfigValue(name);
    if (!value) return [];
    const resolved = value === "true" ? npmPositionalValues.shift() : value;
    return resolved ? [flag, resolved] : [];
});
const npmResume = npmConfigValue("resume");
if (npmResume && npmResume !== "false" && npmResume !== "0") {
    npmForwardedArgs.push("--resume");
}
const forwardedArgs = rawArgs.some((argument) => argument.startsWith("--"))
    ? rawArgs
    : npmForwardedArgs;
const result = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "vite-node", "vite-node.mjs"),
    join(repoRoot, "scripts", "benchmark-co612-review-window-bootstrap.ts"),
    "--",
    ...forwardedArgs,
], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
