// # RwlSiteData, RwlFormat, ReadOptions

export type Year = number;
export type Width = number | null;


export type RwlTreeData = Map<Year, Width>;
export type RwlSiteData = Map<string, RwlTreeData>


export type RwlFormat =
  | "tucson"       // decadal fixed-width (ITRDB 常见)
  | "compact"      // 3 列/长表（series year value）
  | "heidelberg"   // FH/Heidelberg（带 HEADER: 的变体）
  | "tridas"       // XML
  | "csv"          // CSV（长表或宽表）
  | "unknown";

export interface RwlReadOptions {
  // Tucson / Heidelberg 解析参数
  long?: boolean;                 // 负年代：ID 7 + 年份 5
  edgeZeros?: boolean;            // true: 保留 0；false: 0 也视为缺失
  stopMarker?: number;            // 默认 -9999
  header?: boolean | "auto";      // heidelberg / tucson 是否自动跳过 header

  // CSV 解析参数
  csvDelimiter?: "," | ";" | "\t";

  // 统一行为
  preferFormat?: Exclude<RwlFormat, "unknown">; // 强制按某格式解析
}

export interface RwlReadResult {
  format: RwlFormat;
  data: RwlSiteData;
  warnings: string[];
}