import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { RwlReadOptions, RwlReadResult } from "@/features/rwl/types";
import { readRwlString,detectPrecision } from "@/features/rwl/";
import { stopMarker } from "@/shared/constants";

// 绝对路径读取：要求 fs scope 放行该路径
export async function readRwlFile(path: string, opts: RwlReadOptions = {}): Promise<RwlReadResult> {
  const text = await readTextFile(path);
  stopMarker.value = await detectPrecision(text); // 更新全局停止标记
  return readRwlString(text, opts);
}

export async function saveFile(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}