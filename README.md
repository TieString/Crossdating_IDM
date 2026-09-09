# Crossdating IDM _(Crossdating_IDM / Crossdating_Tauri)_

<p align="center">
  <img src="./app-icon.png" width="112" alt="Crossdating IDM">
</p>

[![Release](https://img.shields.io/github/v/release/TieString/Crossdating_IDM?style=flat-square)](https://github.com/TieString/Crossdating_IDM/releases/latest)
[![Windows](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg?style=flat-square)](https://github.com/TieString/Crossdating_IDM/releases/latest)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg?style=flat-square)](LICENSE)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

面向树轮 RWL 数据的可视化编辑、COFECHA 验证与事件级交叉定年桌面工作站。

Crossdating IDM 把树轮宽度编辑、样芯图像、折线对照、COFECHA 报告和自动定年建议放在同一个工作区中。用户可以从唯一的窄年份窗口快速定位缺轮、伪轮、局部移动或整体移动，再回到曲线和实体样芯完成复核。

产品名为 **Crossdating IDM**；GitHub 仓库名保留为 `Crossdating_IDM`，本地工程目录名 `Crossdating_Tauri` 用于体现桌面技术栈。

## 内容列表

- [背景](#背景)
- [安装](#安装)
- [使用](#使用)
- [核心功能](#核心功能)
- [定年建议](#定年建议)
- [验证结果](#验证结果)
- [示例数据](#示例数据)
- [开发](#开发)
- [文档](#文档)
- [维护者](#维护者)
- [致谢](#致谢)
- [贡献](#贡献)
- [许可证](#许可证)

## 背景

交叉定年需要在年份、宽度序列、参考曲线、统计报告和样芯实体证据之间不断往返。Crossdating IDM 将这些步骤组织为连续工作流：读取原始 RWL、查看和编辑宽度、运行 COFECHA、获取事件级建议、在图表中预览、应用并重新验证。

应用采用 Tauri、React 和 TypeScript 构建。产品内的自动建议由本地 JS 事件级诊断完成，支持多参考芯证据、lag 状态路径、反事实纠正、保存后重诊断和全文件待复核导航。

## 安装

Windows x64 用户可在 [Releases](https://github.com/TieString/Crossdating_IDM/releases/latest) 下载最新版安装程序：

```text
Crossdating-IDM_1.6.0_x64-setup.exe
```

安装完成后，示例 RWL 会随软件放入安装资源目录的 `test-data` 文件夹，也可直接使用仓库根目录中的 [`test-data`](test-data)。

应用默认使用内置的`cofecha-js 0.2.1`在Web Worker中生成COFECHA兼容报告，不需要EXE。若需与官方程序对照，可选用LTRR独立提供的COFECHA：

1. 前往 [LTRR Dendrochronology Program Library](https://www.ltrr.arizona.edu/pub/dpl/) 获取 COFECHA。
2. 解压下载内容。
3. 在“设置 > COFECHA”选择“官方 COFECHA”，并选择EXE。

两种引擎都返回完整OUT并使用相同解析、动态参考和PART导航；加载未定年RWL后可在PART 8按相关R或年份调整D排序。

从源码运行：

```powershell
git clone https://github.com/TieString/Crossdating_IDM.git
cd Crossdating_IDM
yarn install
yarn tauri dev
```

## 使用

1. 打开 `.rwl` 文件，宽度网格会保留原始 Tucson 精度和编号格式。
2. 选择一条样芯，在宽度表、树轮横条和折线图之间同步定位年份。
3. 打开或编辑后会自动刷新所选COFECHA报告引擎；查看报告、问题段、动态参考和待复核序列，无需先保存。
4. 在“定年建议”中检查唯一主操作和13年窗口。
5. 在图表中预览修正，选择窗口年份并应用；撤销、恢复和操作日志会完整记录编辑。
6. 重新保存与验证，继续处理同一序列的下一个前沿事件。

第一次体验推荐打开 [`test-data/co612.rwl`](test-data/co612.rwl)。它包含 56 条样芯和丰富的自然缺轮记录，适合熟悉完整工作流。

## 核心功能

- **多格式 RWL 工作区**：支持 Tucson、Compact、CSV、Heidelberg 和 TRiDaS，读取、编辑、另存与格式精度保持一致。
- **高效宽度编辑**：网格选择、查找替换、文本多光标编辑、右键插入/删除、整体移动、局部移动以及稳定的撤销恢复。
- **树轮与扫描影像**：按真实宽度生成树轮横条，可加载大型扫描图、裁切样芯、标定十年锚点并同步当前年份。
- **交互式曲线对照**：多序列折线、参考序列、样本量、年份窗口、缩放、片段移动预览和双线错配分析。
- **COFECHA 双引擎**：默认由Web Worker中的cofecha-js生成完整报告，也可调用用户自行提供的官方EXE；两者统一支持PART导航、PART 8、原始OUT导出和COFECHA-pass动态参考。
- **事件级定年建议**：识别缺轮、伪轮、局部移动和正/负整体移动，每次只显示当前最值得复核的一个事件。
- **全文件导航**：按需扫描其他候选序列，优先呈现证据清晰、能够增强全文件共同年份结构的复核入口。

## 定年建议

当前v5运行时对局部事件始终输出一个主操作、精确位移和唯一13年窗口。局部移动内部搜索`-2..-100`年，整体移动搜索`-100..-1`及`+1..+100`年，但界面只呈现最终选择，不暴露内部假设列表。

### 等价解释

树轮实体证据拥有最终裁决权，但界面不会轮流展示固定操作链：

- 默认只显示模型最终选择的唯一操作。
- 模型选择整体移动时始终显示“以局部事件复核”；确认树皮后，同一冻结证据从partial、missing、false中选择最高分唯一操作。只有选中partial才继续显示“以缺轮形式复核”，用户确认无断裂后再调用missing定位器。整个过程不重跑family，每层都可恢复上一步解释。
- 应用当前事件后重建RWL状态，再诊断更老事件。

这种交互避免把内部候选列表变成需要用户逐一排除的建议菜单。

## 验证结果

当前冻结v5校准包含200个完整RWL文件，并按文件级内部相关性0.60–0.70、0.70–0.80和≥0.80分层；目标序列在干净状态下要求`masterCorrelation > 0.60`。development与calibration按完整文件隔离。

主准确率按“最终正确事件/全部真实事件机会”计算。局部事件必须操作和位移正确、唯一13年窗口覆盖当前最靠树皮真值；whole只要求类型及精确位移。当前阻塞事件错误或拒答后只计该事件，再模拟人工正确解决并继续。

| 类别 | 正确 / 事件机会 | 准确率 | 覆盖率 |
| --- | ---: | ---: | ---: |
| A | 1,158 / 1,246 | **92.94%** | **100.00%** |
| B | 1,093 / 1,168 | **93.58%** | **100.00%** |
| C | 1,983 / 2,136 | **92.84%** | **100.00%** |
| D | 4,172 / 4,488 | **92.96%** | **99.73%** |
| 总体 | 8,406 / 9,038 | **93.01%** | **99.87%** |

Clean误报为29/2,924＝**0.99%**。低相关档C和D分别为88.22%和89.54%，仍应视为未通过的弱项；不能用总体结果掩盖。正向whole专项为624/688＝90.70%，其中远距离混合D为292/349＝83.67%。这些结果是已消费校准回归，不是新的独立final。详见[`docs/benchmarks/signed-whole-save-fix-2026-09-04.md`](docs/benchmarks/signed-whole-save-fix-2026-09-04.md)。

## 示例数据

仓库和 Windows 安装包均附带以下原始 RWL：

- [`ca646.rwl`](test-data/ca646.rwl), Rock Springs Ranch, California
- [`co589.rwl`](test-data/co589.rwl), Almont Triangle, Colorado
- [`co612.rwl`](test-data/co612.rwl), Montrose, Colorado
- [`or093.rwl`](test-data/or093.rwl), Frederick Butte Update, Oregon
- [`paki033.rwl`](test-data/paki033.rwl), Mushkin, Pakistan
- [`ut529.rwl`](test-data/ut529.rwl), Beef Basin, Utah

这些数据来自 NOAA National Centers for Environmental Information 的 [International Tree-Ring Data Bank (ITRDB)](https://www.ncei.noaa.gov/products/paleoclimatology/tree-ring)。完整来源链接、调查者引用说明和 SHA-256 见 [`test-data/README.md`](test-data/README.md)。

## 开发

```powershell
yarn install
yarn build
yarn test:production
yarn test:legacy
yarn tauri dev
yarn tauri build
```

`test:production`是当前v5发布门。`test:legacy`保留旧诊断器的完整历史审计，其中含已知失败与需要本机COFECHA EXE的数据回归，不作为当前发布通过条件。

常用验证：

```powershell
yarn validate
yarn validate:cofecha:samples --cofecha-exe="C:\path\to\COFECHA.exe"
yarn benchmark:co612-zero-frontier-matrix --cofecha-exe "C:\path\to\COFECHA.exe"
```

需要实时调用 COFECHA 的基准通过 `--cofecha-exe PATH` 或环境变量 `COFECHA_EXE` 指向开发者自行获取的可执行文件。

主要入口：

- [`src/pages/Home.tsx`](src/pages/Home.tsx)：主工作区与界面编排。
- [`src/features/rwl/index.ts`](src/features/rwl/index.ts)：RWL 解析和格式处理。
- [`src/features/crossdating/diagnosis.ts`](src/features/crossdating/diagnosis.ts)：JS 事件级诊断入口。
- [`src/features/crossdating/diagnosis/eventEnsemble.ts`](src/features/crossdating/diagnosis/eventEnsemble.ts)：事件证据与前沿恢复。
- [`src/features/crossdating/diagnosis/jointEventAdjudicator.ts`](src/features/crossdating/diagnosis/jointEventAdjudicator.ts)：操作、位移与位置的统一裁决。
- [`src/services/cofecha/index.ts`](src/services/cofecha/index.ts)：JavaScript/官方双引擎统一OUT入口。
- [`src/services/cofecha/runner.ts`](src/services/cofecha/runner.ts)：用户所选官方COFECHA EXE的本地运行与OUT处理。

## 文档

### RWL结束符、真实999与分段规则

解析先确定结束符身份，再按每个数据段的结束符确定单位：`999`为0.01 mm，`−9999`为0.001 mm。三位或四位测量整数不决定单位。此单位约定见[NOAA ITRDB格式说明](https://www.ncei.noaa.gov/pub/data/paleo/treering/treeinfo.txt)；以下边界规则是本应用与配套cofecha-js采用的明确解析策略。

| 位置及后续数据 | 解释 |
| --- | --- |
| 999右侧还有测量值或另一个结束符 | 真实测量值 |
| 未满十年行，999后没有值 | 当前段结束符，即使下一行同名并从下一年开始 |
| 年份个位为9的最后测量格为999，下一行同名且从下一年开始 | 真实测量值；正常跨十年行连续 |
| 上述行末999之后年份断开、换名或文件结束 | 当前段结束符 |
| 单独一行只有序列名、年份和999 | 结束前一段，优先于跨行连续规则 |
| 满十个测量值后追加第11个999字段 | 结束符 |
| −9999 | 始终为结束符；其后还有测量字段时报错 |

- `1999:999 → 2000`：同名时保留1999年的真实999。
- `1999:999 → 2003`：第一段截至1998年，1999–2002年缺测。
- `1995:999 → 1996`：第一段截至1994年，1995年缺测。
- 真实999位于段末时，应另写结束符，如`120 999 999`，其中最后一个999是结束符。

同名多段存入同一个按年份索引的Map，来源段边界、终止位置和单位另存为`tucsonSegments`。空缺年份不补0、不插值、不移动后续年份；显式0仍表示缺轮。应用工作数据统一使用0.001 mm整数和负数终止标记，避免正数999与终止标记碰撞。因此0.01 mm来源整数在工作区显示为原数的10倍，物理轮宽不变。

未改变范围的段按来源精度写回，混合精度同名段也分别保留。编辑后无法准确表示为原精度时使用0.001 mm输出；混合精度段边界被改变且无法可靠对应来源时，同样以0.001 mm无损写出。新结束符均由导出器生成，真实999保留。孤立结束符、年份重叠、非法额外字段或缺少结束符会阻止应用导入；必须修正源文本后再打开。若编辑后产生“某段从个位9年份的真实999独立一行开始，且随后还有数据”，该文本无法同时满足单独999行规则，保存会明确报错，避免生成歧义文件。

cofecha-js源码维护于独立仓库。本应用锁定npm正式版`cofecha-js@0.2.1`，包含上述边界修复，不再使用临时补丁。报告与底层证据缓存按0.2.1版本重新验证。官方EXE接收必要的无冲突、统一单位临时输入，用户RWL原文件保持不变。读取失败会弹出中文对话框，列明问题序列和年份，并提示核对缺测边界或遗漏的测量值。

- [RWL 格式规范](RWL_FORMAT_SPEC.md)
- [ITRDB A/B/C/D 验证报告](docs/VALIDATION.md)
- [示例数据与引用](test-data/README.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

## 维护者

- [TieString](https://github.com/TieString)

## 致谢

- [International Tree-Ring Data Bank](https://www.ncei.noaa.gov/products/paleoclimatology/tree-ring) 及所有贡献树轮数据的调查者。
- [LTRR Dendrochronology Program Library](https://www.ltrr.arizona.edu/pub/dpl/) 与 Richard L. Holmes 创建的 COFECHA。推荐引用：Holmes, R. L. (1983). Computer-assisted quality control in tree-ring dating and measurement. *Tree-Ring Bulletin*, 43, 69-78.
- [Standard Readme](https://github.com/RichardLitt/standard-readme) 提供的 README 组织规范。

## 贡献

欢迎提交 [Issue](https://github.com/TieString/Crossdating_IDM/issues) 和 Pull Request。提交前请运行与改动范围相符的 Vitest、`yarn build`，并保持 RWL 示例数据、操作语义和保存重开行为可复现。

## 许可证

[GNU General Public License v3.0 only](LICENSE) © 2026 TieString and contributors。第三方程序与示例数据的归属和引用见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 及 [`test-data/README.md`](test-data/README.md)。
