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

  // FH/Heidelberg 特定参数
  fhDataFormat?: "column" | "block" | "auto";  // 数据格式：列格式、块格式、自动检测
  fhUnit?: { multiplier: number; divisor: number };  // Unit 转换参数

  // CSV 解析参数
  csvDelimiter?: "," | ";" | "\t";

  // 统一行为
  preferFormat?: Exclude<RwlFormat, "unknown">; // 强制按某格式解析
}

// RWL 解析结果。包含数据和格式元信息，用于格式透明性：
// 打开什么格式的 RWL，保存时保持同样格式。
// readOptions 由各解析器填充，在 RwlEditor 中保存，导出时复现格式。
// 详见 RWL_FORMAT_SPEC.md#格式透明性原则
export interface RwlReadResult {
  format: RwlFormat;
  data: RwlSiteData;
  warnings: string[];
  // 记录解析时使用的关键参数，以便后续导出时复原格式
  readOptions?: {
    tucsonLong?: boolean;        // Tucson 格式：true 为 7 列，false 为 8 列
    edgeZeros?: boolean;         // 是否保留边界 0
    fhDataFormat?: "column" | "block";  // FH 数据格式
    fhUnit?: { multiplier: number; divisor: number };  // FH Unit 参数
  };
}