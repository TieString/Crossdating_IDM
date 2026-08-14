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
    ["manifest", "--manifest"],
    ["output-dir", "--output-dir"],
    ["run-dir", "--run-dir"],
    ["run-id", "--run-id"],
    ["plan", "--plan"],
    ["cofecha-exe", "--cofecha-exe"],
    ["families", "--families"],
    ["file-ids", "--file-ids"],
    ["scenario-ids", "--scenario-ids"],
    ["case-indices", "--case-indices"],
    ["max-targets-per-file", "--max-targets-per-file"],
    ["case-limit", "--case-limit"],
    ["max-steps", "--max-steps"],
    ["workers", "--workers"],
];
const unresolvedValueOptions = npmValueOptions.filter(([name]) => (
    npmConfigValue(name) === "true"
));
if (!rawArgs.some((argument) => argument.startsWith("--"))
    && unresolvedValueOptions.length > 1) {
    throw new Error(
        "npm stripped multiple option names; use --name=value for capability benchmark arguments",
    );
}
const npmPositionalValues = [...rawArgs];
const npmForwardedArgs = npmValueOptions.flatMap(([name, flag]) => {
    const value = npmConfigValue(name);
    if (!value) return [];
    const resolved = value === "true" ? npmPositionalValues.shift() : value;
    return resolved ? [flag, resolved] : [];
});
for (const [name, flag] of [
    ["keep-all-cofecha", "--keep-all-cofecha"],
    ["keep-diagnosis-audits", "--keep-diagnosis-audits"],
    ["merge-existing", "--merge-existing"],
]) {
    const value = npmConfigValue(name);
    if (value && value !== "false" && value !== "0") npmForwardedArgs.push(flag);
}
const forwardedArgs = rawArgs.some((argument) => argument.startsWith("--"))
    ? rawArgs
    : npmForwardedArgs;
const result = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "vite-node", "vite-node.mjs"),
    join(repoRoot, "scripts", "benchmark-itrdb-operation-capability.ts"),
    "--",
    ...forwardedArgs,
], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
