import { Command } from "@tauri-apps/plugin-shell";
import { readTextFile, exists, remove } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { clearWorkDir, getCofechaWorkDir } from "@/services/fs";
import { saveFile } from "../fs/io";

type CofechaVersion = "cofecha" | "cofecha12k" | "cofechawin";

const COFECHA_SIDECAR_NAME = "bin/cofecha";
const COFECHA12K_SIDECAR_NAME = "bin/cofecha12k";
const COFECHAWIN_SIDECAR_NAME = "bin/cofechawin";

const SIDECAR_NAME_BY_VERSION: Record<CofechaVersion, string> = {
  cofecha: COFECHA_SIDECAR_NAME,
  cofecha12k: COFECHA12K_SIDECAR_NAME,
  cofechawin: COFECHAWIN_SIDECAR_NAME,
};

// COFECHA 执行入口。
// 这个函数负责把 RWL 文本写到临时工作目录，启动 sidecar，读取 VERYCOF.OUT，
// 再把结果返回给前端。它同时处理两个约束：
// 1. 每次执行前清空 COFECHA 工作目录；
// 2. 非 ASCII 输入名在当前集成方式下不稳定，因此会降级为默认文件名。
// 参数 version 用于选择 COFECHA / COFECHA12K / COFECHA Win（默认为 "cofecha"）。
// 三个版本共用同一套 stdin 交互协议与 VERYCOF.OUT 输出，仅可执行文件不同。

export async function runCofecha(
  rwlText: string,
  inputFileName?: string,
  sourceRwlPath?: string,
  version: CofechaVersion = "cofecha"
): Promise<string> {
  const cleanResult = await clearWorkDir();
  if (cleanResult.failedPaths.length > 0) {
    console.warn("workspace cleanup had failures:", cleanResult.failedPaths);
  }

  const sidecarName = SIDECAR_NAME_BY_VERSION[version] ?? COFECHA_SIDECAR_NAME;
  const workDir = await getCofechaWorkDir();
  const defaultInputName = "INPUT.RWL";

  const requestedName =
    inputFileName && inputFileName.trim().length > 0 ? inputFileName : defaultInputName;
  const hasNonAsciiName = /[^\x00-\x7F]/.test(requestedName);
  // 当前集成下，COFECHA 对非 ASCII 文件名不稳定，因此这里统一降级。
  const runtimeInputName = hasNonAsciiName ? defaultInputName : requestedName;
  const inputPath = await join(workDir, runtimeInputName);

  await saveFile(inputPath, rwlText);

  const command = Command.sidecar(sidecarName, [], {
    cwd: workDir,
    encoding: "utf-8",
  });

  return new Promise<string>(async (resolve, reject) => {
    command.on("error", (e) => {
      console.error("cofecha error:", e);
      reject(e);
    });

    command.on("close", async (data) => {
      console.log(`cofecha finished: code=${data.code} signal=${data.signal}`);

      try {
        const outPath = await join(workDir, "VERYCOF.OUT");

        if (await exists(outPath)) {
          const outRawText = await readTextFile(outPath);
          // 如果运行时文件名被降级成 ASCII，把展示名补回 OUT 文本中。
          const outText =
            runtimeInputName !== requestedName
              ? outRawText.split(runtimeInputName).join(requestedName)
              : outRawText;

          if (sourceRwlPath && sourceRwlPath.trim().length > 0) {
            try {
              await invoke<string>("write_out_next_to_rwl", {
                sourceRwlPath,
                outText,
              });
            } catch (copyErr) {
              console.warn("failed to copy OUT file to rwl directory:", copyErr);
            }
          }

          try {
            if (runtimeInputName !== defaultInputName && (await exists(inputPath))) {
              await remove(inputPath);
            }
          } catch (rmErr) {
            console.warn("failed to remove temporary input file:", rmErr);
          }

          resolve(outText);
        } else {
          const msg = `VERYCOF.OUT not found: ${outPath}`;
          console.error(msg);
          reject(new Error(msg));
        }
      } catch (err) {
        reject(err);
      }
    });

    try {
      const child = await command.spawn();
      await child.write("very\n");
      await child.write(`${runtimeInputName}\n`);
      await child.write("\n");
      await child.write("\n");
      await child.write("\n");
      await child.write("\n");
      await child.write("\n");
    } catch (spawnErr) {
      reject(spawnErr);
    }
  });
}
