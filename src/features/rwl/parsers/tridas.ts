import { RwlReadOptions, RwlReadResult, RwlSiteData } from "../types";
import { ensureSeries, toIntOrNull, toNumOrNull, stripBom } from "../normalize";
import { RwlParseError } from "../errors";

// 覆盖常见 TRiDaS 变体：measurementSeries / values / value
// year 或 index 作为年份；value 文本作为宽度
export function parseTridas(text: string, _opts: RwlReadOptions = {}): RwlReadResult {
  const xmlText = stripBom(text).trim();
  if (!xmlText.startsWith("<") && !xmlText.startsWith("<?xml")) {
    throw new RwlParseError("tridas: not xml", "tridas");
  }

  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserErr = doc.getElementsByTagName("parsererror")[0];
  if (parserErr) throw new RwlParseError("tridas: xml parse error", "tridas");

  const data: RwlSiteData = new Map();
  const warnings: string[] = [];

  const msList = Array.from(doc.getElementsByTagNameNS("*", "measurementSeries"));
  if (msList.length === 0) {
    // 兼容无命名空间
    const ms2 = Array.from(doc.getElementsByTagName("measurementSeries"));
    msList.push(...(ms2 as any));
  }

  for (const ms of msList) {
    // series id：优先 title，其次 identifier/value
    const titleEl = ms.getElementsByTagNameNS("*", "title")[0] || ms.getElementsByTagName("title")[0];
    const idEl = ms.getElementsByTagNameNS("*", "identifier")[0] || ms.getElementsByTagName("identifier")[0];
    const idValEl = idEl?.getElementsByTagNameNS("*", "value")[0] || idEl?.getElementsByTagName("value")[0];

    const id = (titleEl?.textContent || idValEl?.textContent || "").trim();
    if (!id) continue;

    const series = ensureSeries(data, id);

    const valuesEl =
      ms.getElementsByTagNameNS("*", "values")[0] || ms.getElementsByTagName("values")[0];
    if (!valuesEl) continue;

    const valueEls = Array.from(valuesEl.getElementsByTagNameNS("*", "value"));
    const valueEls2 = valueEls.length ? valueEls : Array.from(valuesEl.getElementsByTagName("value"));

    for (const vEl of valueEls2) {
      const yearAttr = vEl.getAttribute("year");
      const idxAttr = vEl.getAttribute("index");
      const y = toIntOrNull(yearAttr ?? idxAttr ?? "");
      const v = toNumOrNull(vEl.textContent ?? "");
      if (y === null) continue;
      series.set(y, v);
    }
  }

  if (data.size === 0) throw new RwlParseError("tridas: no series parsed", "tridas");
  return { format: "tridas", data, warnings };
}