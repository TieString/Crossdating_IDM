import { readTextFile } from "@tauri-apps/plugin-fs";
import { RwlReadOptions, RwlReadResult } from "./types";
import { readRwlString } from "./index";
import { detectPrecision } from "./detect";
import { stopMarker } from "@/shared/constants";

// 绝对路径读取：要求 fs scope 放行该路径
export async function readRwlFile(path: string, opts: RwlReadOptions = {}): Promise<RwlReadResult> {
  const text = await readTextFile(path);
  stopMarker.value = await detectPrecision(text); // 更新全局停止标记
  return readRwlString(text, opts);
}