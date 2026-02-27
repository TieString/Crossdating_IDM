import { Command } from "@tauri-apps/plugin-shell";
import { writeTextFile, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { getCofechaWorkDir } from "@/services/fs";

const COFECHA_SIDECAR_NAME = "bin/cofecha"; // 必须与 externalBin 条目一致:contentReference[oaicite:4]{index=4}


export async function runCofecha(rwlText: string) {
  const workDir = await getCofechaWorkDir();
  const inputName = "INPUT.RWL";
  const inputPath = await join(workDir, inputName);

  await writeTextFile(inputPath, rwlText);

  const command = Command.sidecar(
    COFECHA_SIDECAR_NAME,
    [],
    { cwd: workDir, encoding: "utf-8" } // cwd 决定 OUT 落点:contentReference[oaicite:6]{index=6}
  );

  command.on("error", (e) => console.error("cofecha error:", e));
  command.on("close", async (data) => {
    console.log(`cofecha finished: code=${data.code} signal=${data.signal}`);

    const outPath = await join(workDir, "VERYCOF.OUT");
    if (await exists(outPath)) {
      const outText = await readTextFile(outPath);
      // 在这里把 outText 显示到 UI
      console.log(outText.slice(0, 2000));
    } else {
      console.error("VERYCOF.OUT not found:", outPath);
    }
  });

  const child = await command.spawn();

  await child.write("very\n");
  await child.write(`${inputName}\n`);
  await child.write("\n");
  await child.write("\n");
  await child.write("\n");
  await child.write("\n");
  await child.write("\n");
}
