import { Command } from "@tauri-apps/plugin-shell";
import { writeTextFile, readTextFile, exists, remove } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { getCofechaWorkDir } from "@/services/fs";

const COFECHA_SIDECAR_NAME = "bin/cofecha";

export async function runCofecha(
  rwlText: string,
  inputFileName?: string,
  sourceRwlPath?: string
): Promise<string> {
  const workDir = await getCofechaWorkDir();
  const defaultInputName = "INPUT.RWL";

  const requestedName =
    inputFileName && inputFileName.trim().length > 0 ? inputFileName : defaultInputName;
  const hasNonAsciiName = /[^\x00-\x7F]/.test(requestedName);
  // COFECHA stdin is unstable with non-ASCII file names in this integration.
  const runtimeInputName = hasNonAsciiName ? defaultInputName : requestedName;
  const inputPath = await join(workDir, runtimeInputName);

  await writeTextFile(inputPath, rwlText);

  const command = Command.sidecar(COFECHA_SIDECAR_NAME, [], {
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
          // If runtime name was downgraded to ASCII, patch display name back in the OUT text.
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
