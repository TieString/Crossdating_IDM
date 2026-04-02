import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { ICofechaResult } from "./types";
import { getCofechaWorkDir } from "@/services/fs/workspace";
import { join } from "@tauri-apps/api/path";
// COFECHA 输出解析模块。
// 这里的目标不是完整理解报告全文，而是提取前端真正需要展示的部分：
// 1. PART 1 中的统计摘要；
// 2. PART 3 中的主序列相关数据；
// 3. PART 6 中的潜在问题详情。
// 解析结果会被整理成统一的 ICofechaResult，供页面层直接消费。
/**
 * 从工作空间读取COFECHA输出文件内容的异步函数
 * @returns {Promise<string>} 返回一个Promise，解析为文件内容字符串
 */
const readOutFile = async (): Promise<string> => {
    try {
        // 使用readTextFile函数读取文件，文件路径相对于应用程序资源目录
        const outPath = await join(await getCofechaWorkDir(), "VERYCOF.OUT");
        if (!await exists(outPath)) {
            console.error("VERYCOF.OUT not found:", outPath);
            return "VERYCOF.OUT not found";
        }
        const content = await readTextFile(outPath); // 路径相对于应用程序数据目录
        console.log("正在读取工作空间文件");
        
        return content;
    } catch (error) {
        console.log('读取文件出错:' + error);
        return "读取文件出错";
    }
}

const parseCofechaResult = (content: string): ICofechaResult => {
    // 先按 PART 拆分，再从各部分提取前端需要的摘要字段。
    const reportParts = splitReportByParts(content);

    const part1 = reportParts.get("PART 1") || "";
    const part3 = reportParts.get("PART 3") || "";
    const part6 = reportParts.get("PART 6") || "";

    const masterSeriesYear = extractMasterSeriesYear(part1);
    const interCorrelation = extractSeriesIntercorrelation(part1);
    const meanSensitivity = extractAverageMeanSensitivity(part1);
    const meanLength = extractMeanLength(part1);
    const masterDatingSeries = extractMasterDatingSeries(part3);

    const possibleProblemsCount = extractPossibleProblemsCount(part1);

    const possibleProblemsDetail = extractPossibleProblemsDetail(part6);

    const cofechaResult: ICofechaResult = {
        masterSeriesYear,
        seriesIntercorrelation: interCorrelation,
        averageMeanSensitivity: meanSensitivity,
        meanLength,
        absentRings: "",
        masterDatingSeries,
        possibleProblemsCount,
        possibleProblemsDetail
    }
    return cofechaResult;
}

function extractMasterSeriesYear(text: string): string {
    // 提取主序列年份范围，例如 1791-2023。
    const match = text.match(/Master series\s+(\d{4})\s+(\d{4})\s+(\d+)/);
    if (match) {
        return `${match[1]}-${match[2]}`; // 返回格式为 "1791-2023"
    }
    return "";
}

function extractSeriesIntercorrelation(text: string): number {
    // 提取序列相关系数。
    const match = text.match(/Series intercorrelation\s+([\d.]+)/);
    if (match) {
        return parseFloat(match[1]); // 转换为浮点数
    }
    return -1;
}

function extractAverageMeanSensitivity(text: string): number {
    // 提取平均灵敏度。
    const match = text.match(/Average mean sensitivity\s+([\d.]+)/);
    if (match) {
        return parseFloat(match[1]); // 转换为浮点数
    }
    return -1;
}

function extractPossibleProblemsCount(text: string): number {
    // 提取可能存在问题的段数。
    const match = text.match(/Segments, possible problems\s+(\d+)/);

    if (match) {
        return parseInt(match[1], 10); // 转换为整数
    }
    return -1;
}

function extractMeanLength(text: string): number {
    // 提取平均序列长度。
    const match = text.match(/Mean length of series\s+([\d.]+)/);
    if (match) {
        return parseFloat(match[1]); // 转换为浮点数
    }
    return -1;
}


function extractMasterDatingSeries(text: string): Map<number, number> {
    const masterDatingSeries = new Map<number, number>();

    // 正则匹配：年份（4位）、相关性值（可带负号和小数点）。
    const regex = /(\d{4})\s+([-+]?\d*\.\d+|\d+)/g;
    let match;

    // 逐步解析每个匹配项。
    while ((match = regex.exec(text)) !== null) {
        const year = parseInt(match[1], 10); // 提取年份
        const value = parseFloat(match[2]); // 提取相关性值
        masterDatingSeries.set(year, value);
    }

    return masterDatingSeries;
}


//DONE: 处理同号 PART 时，合并其内容而非覆盖（例如两个 PART 3）[v1.1.3]
export function splitReportByParts(text: string): Map<string, string> {
 const parts = new Map<string, string>();

    // 先提取 PART 1（从文件开头到 PART 2: 之前）。
    const part2Index = text.indexOf("PART 2:");
    if (part2Index !== -1) {
        const part1Content = text.substring(0, part2Index).trim();
        parts.set("PART 1", part1Content);
    }

    // 再处理 PART 2 及后续 PART X 段，并把同号分页续页合并起来。
    const regex = /(PART \d+:.*?)(?=(PART \d+:|$))/gs;
    let match;

    while ((match = regex.exec(text.substring(part2Index))) !== null) {
        const partTitle = match[1].split("\n")[0].trim(); // 提取 PART X: 标题
        const partNumber = partTitle.split(" ")[1].replace(":", ""); // 提取 `X`
        const partContent = match[1].trim(); // 获取该部分的内容
        const key = `PART ${partNumber}`;
        // 同号 PART（分页续页）=> 合并
    parts.set(key, parts.has(key) ? `${parts.get(key)}\n${partContent}` : partContent);
    }

    return parts;
}


function extractPossibleProblemsDetail(text: string): Map<string, string> {
    const possibleProblems = new Map<string, string>();

    // 按 `==========` 分割成多个块
    const sections = text.split(/=+/);

    for (const section of sections) {
        const lines = section.trim().split("\n").map(line => line.trim()).filter(line => line);

        if (lines.length === 0) continue; // 跳过空块

        // 取第一行的第一个字符串作为 key
        const seriesID = lines[0].split(/\s+/)[0]; // 按空格分割，取第一个单词

        // 查找 `[A] Segment` 部分
        const aMatch = section.match(/\[A\] Segment[\s\S]*?(?=\[[B-E]\]|\={10,}|$)/);
        if (aMatch) {
            possibleProblems.set(seriesID, aMatch[0].trim());
        }
    }

    return possibleProblems;
}



export { readOutFile, parseCofechaResult };

