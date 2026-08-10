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
    ["config", "--config"],
    ["output-dir", "--output-dir"],
    ["run-id", "--run-id"],
    ["file-concurrency", "--file-concurrency"],
    ["diagnosis-workers", "--diagnosis-workers"],
    ["file-ids", "--file-ids"],
];
const npmPositionalValues = [...rawArgs];
const npmForwardedArgs = npmValueOptions.flatMap(([name, flag]) => {
    const value = npmConfigValue(name);
    if (!value) return [];
    const resolved = value === "true" ? npmPositionalValues.shift() : value;
    return resolved ? [flag, resolved] : [];
});
for (const [name, flag] of [["resume", "--resume"], ["plan-only", "--plan-only"]]) {
    const value = npmConfigValue(name);
    if (value && value !== "false" && value !== "0") npmForwardedArgs.push(flag);
}
const forwardedArgs = rawArgs.some((argument) => argument.startsWith("--"))
    ? rawArgs
    : npmForwardedArgs;
const result = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "vite-node", "vite-node.mjs"),
    join(repoRoot, "scripts", "benchmark-itrdb-natural-zero-serial-generalization.ts"),
    "--",
    ...forwardedArgs,
], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
