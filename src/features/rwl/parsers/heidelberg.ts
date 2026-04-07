import { RwlReadOptions, RwlReadResult, RwlSiteData } from "../types";
import { splitLines, stripBom, toIntOrNull, toNumOrNull, ensureSeries } from "../normalize";
import { RwlParseError } from "../errors";

// FH/Heidelberg 格式解析器（基于 dplR 的 read.fh R 函数）
// 特性：
// 1. 支持 HEADER/DATA 块结构
// 2. 从 Header 提取元数据（KeyCode、Length、DateEnd、DateBegin、Unit 等）
// 3. 自动检测数据格式：列格式 (< 60 chars | contains ;) 或块格式 (>= 60 chars, fixed 6-char fields)
// 4. Unit 单位转换（默认 /100）
// 5. 完整的数据验证

interface FhHeaderMetadata {
  keyCode: string;
  length: number;
  dateEnd: number;
  dateBegin: number;
  multiplier: number;
  divisor: number;
  siteCode?: string;
  treeNo?: number;
  coreNo?: number;
  radiusNo?: number;
  stemDiskNo?: number;
  missingRingsBefore?: number;
}

function extractHeaderMetadata(headerLines: string[]): FhHeaderMetadata {
  const metadata: Record<string, string> = {};
  
  for (const line of headerLines) {
    const match = line.match(/^([A-Za-z]+)=(.*)$/);
    if (match) {
      metadata[match[1]] = match[2].trim();
    }
  }

  // 必要字段验证
  const keyCode = metadata["KeyCode"] || metadata["Keycode"];
  if (!keyCode) throw new RwlParseError("Header missing KeyCode");

  const lengthStr = metadata["Length"];
  if (!lengthStr) throw new RwlParseError("Header missing Length");
  const length = toIntOrNull(lengthStr);
  if (length === null || length <= 0) throw new RwlParseError("Invalid Length");

  const dateEndStr = metadata["DateEnd"];
  if (!dateEndStr) throw new RwlParseError("Header missing DateEnd");
  const dateEnd = toIntOrNull(dateEndStr);
  if (dateEnd === null) throw new RwlParseError("Invalid DateEnd");

  // DateBegin 可选，如果缺失则从 Length 推导
  let dateBegin: number;
  const dateBeginStr = metadata["DateBegin"];
  if (dateBeginStr) {
    const parsed = toIntOrNull(dateBeginStr);
    if (parsed === null) throw new RwlParseError("Invalid DateBegin");
    dateBegin = parsed;
  } else {
    dateBegin = dateEnd - length + 1;
  }

  // Unit 处理：默认 /100，支持 "1/100", "10/100", "2" 等格式
  let multiplier = 1;
  let divisor = 100;
  const unitStr = metadata["Unit"];
  if (unitStr) {
    const unitCleaned = unitStr.replace(/\s*mm\s*/i, "");
    const divIdx = unitCleaned.indexOf("/");
    if (divIdx > 0) {
      const mulPart = toNumOrNull(unitCleaned.substring(0, divIdx));
      const divPart = toNumOrNull(unitCleaned.substring(divIdx + 1));
      if (mulPart !== null && divPart !== null && divPart > 0) {
        multiplier = mulPart;
        divisor = divPart;
      }
    } else {
      const mul = toNumOrNull(unitCleaned);
      if (mul !== null && mul > 0) {
        multiplier = mul;
        divisor = 1;
      }
    }
  }

  // 可选字段
  const treeNo = metadata["TreeNo"] ? toIntOrNull(metadata["TreeNo"]) : undefined;
  const coreNo = metadata["CoreNo"] ? toIntOrNull(metadata["CoreNo"]) : undefined;
  const radiusNo = metadata["RadiusNo"] ? toIntOrNull(metadata["RadiusNo"]) : undefined;
  const stemDiskNo = metadata["StemDiskNo"] ? toIntOrNull(metadata["StemDiskNo"]) : undefined;
  const missingRingsBefore = metadata["MissingRingsBefore"] ? toIntOrNull(metadata["MissingRingsBefore"]) : undefined;

  return {
    keyCode,
    length,
    dateEnd,
    dateBegin,
    multiplier,
    divisor,
    siteCode: metadata["SiteCode"],
    treeNo: treeNo || undefined,
    coreNo: coreNo || undefined,
    radiusNo: radiusNo || undefined,
    stemDiskNo: stemDiskNo || undefined,
    missingRingsBefore: missingRingsBefore || undefined,
  };
}

function detectDataFormat(dataLines: string[]): "column" | "block" {
  // 列格式：行长 < 60 或包含注释符 ;
  // 块格式：行长 >= 60，无注释符
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length < 60 || trimmed.includes(";")) {
      return "column";
    }
    return "block";
  }
  return "column"; // 默认
}

function stripComment(line: string): string {
  const idx = line.indexOf(";");
  return idx >= 0 ? line.substring(0, idx) : line;
}

function parseColumnFormatData(dataLines: string[], _meta: FhHeaderMetadata): number[] {
  const result: number[] = [];
  
  for (const line of dataLines) {
    const cleaned = stripComment(line).trim();
    if (!cleaned) continue;
    
    // 按空白分割
    const parts = cleaned.split(/\s+/);
    for (const part of parts) {
      const val = toNumOrNull(part);
      if (val !== null) {
        result.push(val);
      }
    }
  }
  
  return result;
}

function parseBlockFormatData(dataLines: string[], _meta: FhHeaderMetadata): number[] {
  const result: number[] = [];
  
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // 每行 10 个 6 字符的字段
    for (let i = 0; i < 10; i++) {
      const start = i * 6;
      const end = start + 6;
      if (start >= trimmed.length) break;
      
      const fieldStr = trimmed.substring(start, end);
      const val = toNumOrNull(fieldStr);
      if (val !== null) {
        result.push(val);
      }
    }
  }

  // 清理尾部零：找到最后一个非零值，删除之后的所有零
  let lastNonZeroIdx = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] !== 0) {
      lastNonZeroIdx = i;
      break;
    }
  }
  
  if (lastNonZeroIdx >= 0 && lastNonZeroIdx < result.length - 1) {
    // 检查是否 lastNonZeroIdx 后的都是零
    let allZeros = true;
    for (let i = lastNonZeroIdx + 1; i < result.length; i++) {
      if (result[i] !== 0) {
        allZeros = false;
        break;
      }
    }
    if (allZeros) {
      result.splice(lastNonZeroIdx + 1);
    }
  }

  return result;
}

export function parseHeidelberg(text: string, opts: RwlReadOptions = {}): RwlReadResult {
  const edgeZeros = opts.edgeZeros ?? true;

  const lines = splitLines(stripBom(text));
  
  // 找到所有 HEADER: 和 DATA: 行的位置
  const headerBegins: number[] = [];
  const dataEnds: number[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*HEADER:\s*$/.test(lines[i])) {
      headerBegins.push(i);
    }
    if (/^\s*DATA:\s*(Tree|Single)\s*$/.test(lines[i])) {
      dataEnds.push(i);
    }
  }

  if (dataEnds.length === 0) {
    throw new RwlParseError('File has no DATA blocks in "Tree" or "Single" formats');
  }

  // 为每个 DATA 块找到对应的 HEADER 块
  const headerTaken = new Array(headerBegins.length).fill(false);
  const headerMap = new Map<number, number>(); // dataIdx -> headerIdx
  const warnings: string[] = [];

  for (let i = 0; i < dataEnds.length; i++) {
    const dataPos = dataEnds[i];
    // 找前面最近的、未被使用过的 HEADER
    const precedingHeaders = headerBegins.filter(h => h < dataPos - 1);
    if (precedingHeaders.length === 0) {
      throw new RwlParseError("invalid file: HEADER and DATA don't match");
    }
    
    const closestHeaderIdx = headerBegins.indexOf(precedingHeaders[precedingHeaders.length - 1]);
    if (headerTaken[closestHeaderIdx]) {
      throw new RwlParseError("invalid file: HEADER and DATA don't match");
    }
    
    headerTaken[closestHeaderIdx] = true;
    headerMap.set(i, closestHeaderIdx);
  }

  if (!headerTaken.every(x => x)) {
    warnings.push("more HEADER blocks than DATA blocks in supported formats");
  }

  // 解析每个 DATA 块
  const data: RwlSiteData = new Map();
  let firstUnit = { multiplier: 1, divisor: 100 };
  let firstDataFormat: "column" | "block" = "column";

  for (let i = 0; i < dataEnds.length; i++) {
    const dataPos = dataEnds[i];
    const headerIdx = headerMap.get(i);
    if (headerIdx === undefined) continue;

    const headerPos = headerBegins[headerIdx];
    const headerEnd = dataPos; // HEADER 块在 DATA 行之前结束
    const headerLines = lines.slice(headerPos + 1, headerEnd)
      .filter(l => l.trim() && !/^\s*HEADER:\s*$/.test(l));

    let meta: FhHeaderMetadata;
    try {
      meta = extractHeaderMetadata(headerLines);
    } catch (e) {
      warnings.push(`Series ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // 找 DATA 块的结束位置
    let dataBlockEnd = lines.length;
    const nextHeaderIndex = headerBegins.findIndex(h => h > dataPos);
    if (nextHeaderIndex >= 0) {
      dataBlockEnd = headerBegins[nextHeaderIndex];
    }

    const dataLines = lines.slice(dataPos + 1, dataBlockEnd)
      .filter(l => l.trim());

    if (dataLines.length === 0) {
      const nExpected = meta.dateEnd - meta.dateBegin + 1;
      throw new RwlParseError(`Series ${meta.keyCode}: too few values (expected ${nExpected}, got 0)`);
    }

    // 检测并解析数据
    const dataFormat = detectDataFormat(dataLines);
    const values: number[] = dataFormat === "column"
      ? parseColumnFormatData(dataLines, meta)
      : parseBlockFormatData(dataLines, meta);

    // 保存第一个 series 的 format/unit 用于 readOptions
    if (i === 0) {
      firstDataFormat = dataFormat;
      firstUnit = { multiplier: meta.multiplier, divisor: meta.divisor };
    }

    // 验证值数量
    const nExpected = meta.dateEnd - meta.dateBegin + 1;
    if (values.length < nExpected) {
      throw new RwlParseError(
        `Series ${meta.keyCode}: too few values (expected ${nExpected}, got ${values.length})`
      );
    }

    // 应用 Unit 转换并填充数据
    const series = ensureSeries(data, meta.keyCode);
    for (let j = 0; j < nExpected; j++) {
      let v: number | null = values[j] * meta.multiplier / meta.divisor;
      
      if (!edgeZeros && v <= 0) {
        v = null;
      } else if (edgeZeros && v < 0) {
        v = null;
      }
      
      series.set(meta.dateBegin + j, v);
    }
  }

  return {
    format: "heidelberg",
    data,
    warnings,
    readOptions: {
      edgeZeros,
      fhDataFormat: firstDataFormat,
      fhUnit: firstUnit,
    },
  };
}