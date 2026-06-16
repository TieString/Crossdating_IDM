export * from "./types"
export * from "./detect"

// RWL 格式处理器框架
// ==================
// 核心原则：读写在同一路径
//
// 每个 RWL 格式 (tucson, compact 等) 都是一个独立的处理器模块（parsers/*.ts）
// 内部包含对称的 parse 和 format 函数，确保打开->编辑->保存的完整一致性。
// 
// 这个文件负责：
// 1. 定义处理器接口 RwlFormatHandler（parse + format）
// 2. 注册表 formatHandlers 统一管理所有格式
// 3. 读取入口 readRwlString() 通过注册表自动路由
//
// 扩展示例（新增格式 example）：
// 1. 在 parsers/example.ts 中同时实现 parseExample() 和 formatExample()
// 2. 在下方 formatHandlers 中添加一行: example: { parse: parseExample, format: formatExample }
// 3. 不需修改其他文件，RwlEditor 和 readRwlString() 自动支持

import { RwlReadOptions, RwlReadResult, RwlFormat, RwlSiteData } from "./types";
import { detectRwlFormat } from "./detect";
import { RwlParseError } from "./errors";
import { parseTucson, formatTucson } from "./parsers/tucson";
import { parseCompact } from "./parsers/compact";
import { parseCsv } from "./parsers/csv";
import { parseHeidelberg } from "./parsers/heidelberg";
import { parseTridas } from "./parsers/tridas";
import { stopMarker } from "@/shared/constants";

// 格式处理器接口
// parse: 必需，文本 → RwlReadResult（包含数据和格式元数据）
// format: 可选，数据 → 文本（使用 readOptions 复现原始格式）
export interface RwlFormatHandler {
  parse: (text: string, opts: RwlReadOptions) => RwlReadResult;
  format?: (data: RwlSiteData, readOpts: any, selectedTree?: string) => string;
}

// 格式处理器注册表
// 每个格式对应一个处理器。已实现 format 的格式（tucson）可导出；
// 仅实现 parse 的格式（其他）暂不支持导出但可读取。
export const formatHandlers: Record<RwlFormat, RwlFormatHandler | null> = {
  tucson: {
    parse: parseTucson,
    format: (data, readOpts, selected) => formatTucson(data, readOpts?.tucsonLong ?? false, selected)
  },
  compact: { parse: parseCompact },
  csv: { parse: parseCsv },
  heidelberg: { parse: parseHeidelberg },
  tridas: { parse: parseTridas },
  unknown: null
};

function tryParseInOrder(text: string, order: RwlFormat[], opts: RwlReadOptions): RwlReadResult {
  const errors: string[] = [];
  for (const f of order) {
    const handler = formatHandlers[f];
    if (!handler) continue; // 无效格式或不支持，跳过
    try {
      return handler.parse(text, opts);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  throw new RwlParseError(`readRwlString failed:\n${errors.join("\n")}`, "unknown");
}

export async function readRwlString(text: string, opts: RwlReadOptions = {}): Promise<RwlReadResult> {
  if (opts.preferFormat) {
    return tryParseInOrder(text, [opts.preferFormat], opts);
  }

  const detected = detectRwlFormat(text);

  // 先尝试命中的格式，其余格式作为回退顺序。
  const fallback: RwlFormat[] = ["tucson", "compact", "heidelberg", "csv", "tridas"];
  const order: RwlFormat[] = detected === "unknown"
    ? fallback
    : [detected, ...fallback.filter(f => f !== detected)];

  // stopMarker 未显式传入时，从全局中获取推导值（如果已设置），否则使用默认值 -9999
  if (opts.stopMarker === undefined) {
    opts.stopMarker = stopMarker.value;
  }
  
  return tryParseInOrder(text, order, opts);
}
