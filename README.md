# Crossdating IDM _(Crossdating_IDM)_

<p align="center">
  <img src="./app-icon.png" width="112" alt="Crossdating IDM">
</p>

[![Release](https://img.shields.io/github/v/release/TieString/Crossdating_IDM?style=flat-square)](https://github.com/TieString/Crossdating_IDM/releases/latest)
[![Windows](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg?style=flat-square)](https://github.com/TieString/Crossdating_IDM/releases/latest)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg?style=flat-square)](LICENSE)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

面向树轮 RWL 数据的可视化编辑、COFECHA 验证与事件级交叉定年桌面工作站。

Crossdating IDM 把树轮宽度编辑、样芯图像、折线对照、COFECHA 报告和自动定年建议放在同一个工作区中。用户可以从唯一的窄年份窗口快速定位缺轮、伪轮、局部移动或整体移动，再回到曲线和实体样芯完成复核。


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
Crossdating-IDM_1.5.0_x64-setup.exe
```

安装完成后，示例 RWL 会随软件放入安装资源目录的 `test-data` 文件夹，也可直接使用仓库根目录中的 [`test-data`](test-data)。

COFECHA 由 LTRR 独立提供，不包含在 Crossdating IDM 的源码和安装包中。安装应用后：

1. 前往 [LTRR Dendrochronology Program Library](https://www.ltrr.arizona.edu/pub/dpl/) 获取 COFECHA。
2. 解压下载内容。
3. 在 Crossdating IDM 的“运行 > 加载 COFECHA...”或“设置 > COFECHA”中选择需要使用的 EXE。

需要切换 COFECHA 版本时，直接加载另一个 EXE 即可。

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
3. 保存后运行 COFECHA，查看报告、问题段、动态参考和待复核序列。
4. 在“定年建议”中检查唯一主操作和 5/7/9/13 年窗口。
5. 在图表中预览修正，选择窗口年份并应用；撤销、恢复和操作日志会完整记录编辑。
6. 重新保存与验证，继续处理同一序列的下一个前沿事件。

第一次体验推荐打开 [`test-data/co612.rwl`](test-data/co612.rwl)。它包含 56 条样芯和丰富的自然缺轮记录，适合熟悉完整工作流。

## 核心功能

- **多格式 RWL 工作区**：支持 Tucson、Compact、CSV、Heidelberg 和 TRiDaS，读取、编辑、另存与格式精度保持一致。
- **高效宽度编辑**：网格选择、查找替换、文本多光标编辑、右键插入/删除、整体移动、局部移动以及稳定的撤销恢复。
- **树轮与扫描影像**：按真实宽度生成树轮横条，可加载大型扫描图、裁切样芯、标定十年锚点并同步当前年份。
- **交互式曲线对照**：多序列折线、参考序列、样本量、年份窗口、缩放、片段移动预览和双线错配分析。
- **COFECHA 集成**：加载用户从 LTRR 获取的本机 EXE，一键运行、PART 导航、问题段定位、原始 OUT 导出和 COFECHA-pass 动态参考。
- **事件级定年建议**：识别缺轮、伪轮、局部移动和负向整体移动，每次只显示当前最值得复核的一个事件。
- **全文件导航**：按需扫描其他候选序列，优先呈现证据清晰、能够增强全文件共同年份结构的复核入口。

## 定年建议

局部事件始终输出一个主操作、一个 `#` 年份排序和一个唯一的 5/7/9/13 年窗口。局部移动内部可联合搜索 `-2..-100` 年，但界面只呈现最终断点和位移，不暴露内部假设列表。

### 等价解释

树轮实体证据拥有最终裁决权。诊断会保留一条受约束的复核链：

```text
整体移动  ->  局部移动  ->  近距离多个缺轮
```

- 整体移动建议常驻“排除整体移动，复核局部事件”。树皮年或采样年已经确认时，可直接进入局部事件解释，并可随时恢复整体移动解释。
- 局部移动建议常驻“未见断裂，按缺轮逐轮复核”。样芯完整时，系统定位最靠树皮侧的一处缺轮，应用后重新诊断下一处。
- 样芯存在断裂、腐朽或连续缺段证据时，保留局部移动解释，一次移动较老侧并严格保持断点较新侧不动。

转换只使用诊断内部已经独立验证的解释和窗口，不会把累计位移机械拆成年份列表。界面仍保持一次一个事件，让统计证据与实体观察自然衔接。

## 验证结果

事件级建议使用 25 个高质量 ITRDB 文件进行冻结验证。目标序列满足无 A 标记、长度不少于 200 年、树间相关性不少于 0.80；每类冻结 1,000 个案例，其他序列保持干净并按生产流程重新生成 COFECHA/master。

下表为完整复核工作流准确率。当前阻塞事件会先计入结果，再模拟用户完成该事件的实体复核，使后续事件也获得一次建议机会；等价解释在操作语义和唯一窗口均正确时计为成功。

| 类别 | 定义 | 主要场景 | 正确事件 / 全部事件 | 准确率 | 单侧 95% 下界 |
| --- | --- | --- | ---: | ---: | ---: |
| A | 单位事件 | 单缺轮、单伪轮、单局部移动、单整体移动 | 945 / 1,000 | **94.50%** | **92.20%** |
| B | 远距离多事件 | 多缺轮、多伪轮、多个局部移动；间距 >= 14 年 | 2,696 / 3,001 | **89.84%** | **87.86%** |
| C | 近距离单位事件 | 2-4 个同方向缺轮或伪轮；间距 2/5/9/13 年 | 2,735 / 3,003 | **91.08%** | **88.94%** |
| D | 远距离混合事件 | 缺轮、伪轮、局部移动和整体移动的两类、三类及四类组合 | 2,202 / 2,536 | **86.83%** | **84.16%** |

按文件聚类的 bootstrap 使用 10,000 次重采样。Clean 对照共 1,000 例，复核误报率为 **0.70%**；保存重开稳定率为 **100%**。

冻结文件为：`az086`、`ca646`、`ca660`、`co021`、`co583`、`co589`、`co593`、`co604`、`co605`、`co616`、`co617`、`co624`、`co629`、`co631`、`co647`、`co649`、`co650`、`co651`、`co658`、`nm025`、`nm560`、`nm565`、`nm572`、`nm580`、`ut530`。

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
yarn test
yarn tauri dev
yarn tauri build
```

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
- [`src/services/cofecha/runner.ts`](src/services/cofecha/runner.ts)：用户所选 COFECHA EXE 的本地运行与 OUT 处理。

## 文档

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
