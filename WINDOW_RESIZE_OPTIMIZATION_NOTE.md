# 从可拖拽分栏到窗口缩放优化：Crossdating_Tauri 首页重构记录

最后更新：2026-04-15

> 这不是一份“改了哪些文件”的流水账，而是一篇偏工程博客风格的实现记录。  
> 目标是把这次首页分栏、大小调整、高度修复和窗口 resize 卡顿优化，完整地整理成一份可回顾、可复用、可继续迭代的笔记。

---

## 一、问题是怎么开始的

这次改动最初并不是从性能开始的，而是一个很直观的交互需求：

- 首页左侧是年轮宽度数据区；
- 右侧是 COFECHA 文本和图表区；
- 用户希望左右两块能拖动调整宽度；
- 左侧内部的 `data-container / problems-container` 想要上下拖动；
- 右侧内部的 `full-text / line-chart` 也想要上下拖动。

这听起来像一个典型的“加几个 splitter”的需求，但真正做起来后，很快就牵出了三个层面的连锁问题：

1. 页面原本的布局模型并不是为“可拖拽分栏”设计的；
2. 高度链不闭合，导致子面板会被内容撑开；
3. 在加载较大 RWL 数据后，窗口 resize 会明显卡顿。

所以最后这次工作，实际上做了三件事：

1. 给首页建立统一的可拖拽分栏模型；
2. 修复整个页面的高度链；
3. 对 resize 卡顿做了一轮从轻量优化到结构性优化的定位和重构。

---

## 二、改造前的首页结构

首页的主流程集中在 [src/pages/Home.tsx](src/pages/Home.tsx)。

它一边处理业务流程：

- 打开 RWL
- 解析数据
- 渲染宽度表
- 保存并运行 COFECHA
- 解析 VERYCOF.OUT

一边还直接管理页面上的几个大区域：

- 左侧 `width-module`
- 右侧 `cofecha-module`
- 左下 `problems-container`
- 右下 `line-chart`

原来的布局虽然能工作，但有两个天然限制：

### 1. 面板尺寸是“静态写死”的

例如：

- `.data-container` 曾经有固定高度
- `.full-text` 曾经有固定高度
- `problems-container` 只有 `max-height`

这意味着页面是“内容主导布局”，不是“布局主导内容”。

### 2. 高度依赖 `height: 100%`，但父级并不稳定

从 `body` 到 `#root`，再到 `App`，再到 `Home`，中间多层都在依赖相对高度。  
一旦某一层没有拿到真实高度，后面的 `100%` 就会退化为“由内容撑开”。

这也是后面出现“问题面板和图表被挤到底部”的根源。

---

## 三、第一步：把首页抽象成三个可调整大小的分栏

这一步的核心不是 CSS，而是先明确页面究竟有哪些“可以被拖动的边界”。

最后确定为三组：

1. 主界面左右分栏  
   `width-module | cofecha-module`

2. 左侧上下分栏  
   `data-container | problems-container`

3. 右侧上下分栏  
   `full-text | line-chart`

对应的状态被抽成一个专用 hook：

- [src/pages/useResizablePanels.ts](src/pages/useResizablePanels.ts)

这个 hook 管理三份比例：

```ts
{
  mainSplitRatio: 0.56,
  leftBottomRatio: 0.22,
  rightBottomRatio: 0.35
}
```

### 为什么用比例，不直接存像素

因为这个页面是桌面端窗口，用户会不断改变窗口大小。  
如果存像素，窗口尺寸变化后布局会很容易失衡。  
存比例的好处是：

- 分栏能随窗口一起缩放；
- 重新打开应用时能恢复“相对布局感”；
- 同样的布局在不同分辨率下都更稳定。

### 为什么单独抽成 hook

如果把拖拽逻辑直接写在 `Home.tsx` 里，页面很快会被下面这些东西搅在一起：

- 鼠标事件
- 比例计算
- 最小尺寸限制
- 本地持久化
- 拖拽时的清理逻辑

抽成 `useResizablePanels` 之后，`Home` 只需要做两件事：

1. 声明“哪个分隔条控制哪一块”
2. 告诉 hook 这次是横向还是纵向、容器是谁、最小尺寸是多少

---

## 四、拖拽分栏是怎么实现的

`useResizablePanels.ts` 的核心思路很直接：

1. `pointerdown` 时读取当前容器的 `getBoundingClientRect()`
2. 根据方向（`x` 或 `y`）确定当前拖的是宽度还是高度
3. 把鼠标偏移量换算成比例
4. 用 `clamp` 把比例限制在最小/最大范围内
5. 拖动过程中更新 React state
6. `pointerup` 时移除事件监听，恢复光标和选中行为

### 核心接口

```ts
type ResizeConfig = {
  key: LayoutKey;
  axis: "x" | "y";
  container: HTMLElement | null | (() => HTMLElement | null);
  minStart: number;
  minEnd: number;
};
```

这里有两个实现细节很关键。

### 1. `container` 支持传函数

拖拽逻辑发生在事件触发时，而不是组件第一次渲染时。  
如果只传 `ref.current`，很容易把 `null` 提前闭包进去。  
所以这里允许传：

```ts
container: () => leftPanelsRef.current
```

这样 `pointerdown` 触发时会拿到最新 DOM。

### 2. 最小尺寸不是靠 CSS 猜，而是进计算

比如左右主分栏：

```ts
minStart: 670,
minEnd: 580
```

左侧上下分栏：

```ts
minStart: 220,
minEnd: 96
```

右侧上下分栏：

```ts
minStart: 180,
minEnd: 220
```

拖动时不是简单让鼠标位置直接变成比例，而是先算出：

```ts
const minRatio = minStart / effectiveSize;
const maxRatio = 1 - minEnd / effectiveSize;
```

这样无论容器当前大小如何变化，都能保证两边不会被拖得过小。

### 拖拽状态怎么持久化

每次 `layout` 变化后，直接写入：

```ts
localStorage["crossdating.homeLayout.v1"]
```

这样应用关闭后再打开，布局还能延续上次的状态。

---

## 五、`Home.tsx` 是怎么接入三组分栏的

`Home.tsx` 里最重要的变化，不是具体某一行样式，而是页面结构被重新组织了。

### 左侧模块

左侧从原来的“控制条 + 数据区 + 条件问题区”，改成了：

```tsx
<div className={style["width-module"]}>
  <div className={style["control-bar"]}>...</div>
  <div className={style["width-panels"]}>
    <div className={style["data-container"]}>...</div>
    <div role="separator" ... />
    <div className={style["problems-container"]}>...</div>
  </div>
</div>
```

其中：

- `width-panels` 是纵向容器
- `data-container` 负责滚动
- 中间插入横向分隔条
- `problems-container` 放问题详情

### 右侧模块

右侧结构也类似：

```tsx
<div className={style["cofecha-module"]}>
  <div className={style["statics-info"]}>...</div>
  <div className={style["cofecha-panels"]}>
    <div className={style["full-text"]}>...</div>
    <div role="separator" ... />
    <div className={style["line-chart"]}>...</div>
  </div>
</div>
```

### 主左右分栏

左右模块之间插入纵向分隔条：

```tsx
<div
  role="separator"
  aria-orientation="vertical"
  onPointerDown={startResize(...)}
/>
```

而左侧自身的宽度，不再依赖某个固定值，而是直接绑定到比例：

```tsx
style={{ flex: `0 0 ${layout.mainSplitRatio * 100}%` }}
```

这个写法的好处是：

- 左侧宽度可控
- 右侧仍然保持 `flex: 1`
- 布局由容器决定，而不是被内容反向撑开

---

## 六、真正麻烦的不是分栏，而是高度链

分栏接好之后，很快就出现了一个典型问题：

- `problems-container` 和 `line-chart` 看起来“消失”了
- 但实际上它们并没有被删掉
- 而是被内容和父容器关系一路挤到了很底下

这说明问题并不在“面板是否渲染”，而在“页面是否有一个稳定的高度系统”。

### 根因

多层容器都在写：

```css
height: 100%;
```

但上层未必真的有确定高度。  
这样最终结果就是：

- 子层按照内容撑高
- 父层继续被子层撑高
- 整个页面高度失控

### 修复策略

把高度链从根开始补完整：

- `index.html`
- `src/app/App.css`
- `src/app/App.tsx`
- `src/pages/Home.module.css`

重点包括：

```css
html,
body {
  height: 100%;
}

#root {
  display: flex;
  min-height: 0;
}

.app-container {
  display: flex;
  min-height: 0;
  overflow: hidden;
}
```

以及在 `Home.module.css` 中：

```css
.home-container,
.width-module,
.cofecha-module,
.width-panels,
.cofecha-panels {
  min-height: 0;
  overflow: hidden;
}
```

这一步是整个分栏系统能否稳定工作的基础。  
如果不先把高度链收住，后面的虚拟列表和拖拽比例都会被破坏。

---

## 七、为什么窗口 resize 会卡

在页面可拖拽、可滚动之后，另一个问题变得非常明显：

> 一旦加载较大的 RWL 数据，再拖动窗口大小，页面会卡。

最开始直觉上会怀疑右下 Chart.js，因为图表在 resize 时确实容易重绘。  
但后来发现，真正的主瓶颈其实在左侧的宽度表。

### 原来的左侧渲染方式

原本 [src/components/WidthContainer/WidthContainer.tsx](src/components/WidthContainer/WidthContainer.tsx) 的逻辑是：

1. 把整棵树/所有树种的数据转成 `timeline`
2. 再按每 10 个单元拆成 `rows`
3. 最后把所有 `rows` 一次性渲染成 `.series-row`

也就是说：

- 数据一多，DOM 数量就会非常大
- 窗口 resize 时，这些网格全部参与重排
- 就算用户只看到了很小一段区域，浏览器仍然得处理整张表

### 为什么轻量优化效果有限

中间尝试过一些较轻的方案：

- `content-visibility`
- `contain`
- 图表 `resizeDelay`
- resize 时短暂挂起图表

这些都不是无效，它们确实会让局部更省一点。  
但问题在于：左侧真正的 DOM 规模没有变。

只要 DOM 还在那里，浏览器就还是得为它们花时间。

所以最后决定不再“挤牙膏式优化”，而是直接把左侧宽度表改成虚拟列表。

---

## 八、左侧宽度表虚拟列表是怎么做的

这部分是本轮性能优化里最核心的改动。

文件：

- [src/components/WidthContainer/WidthContainer.tsx](src/components/WidthContainer/WidthContainer.tsx)
- [src/components/WidthContainer/WidthContainer.module.css](src/components/WidthContainer/WidthContainer.module.css)

### 设计目标

不是把“整个表渲染得更快一点”，而是：

> 根本不渲染看不见的行。

### 第一步：把层级数据拍平成 `VirtualRow[]`

每一行除了原本的数据，还记录它在虚拟容器中的纵向位置：

```ts
interface VirtualRow extends SeriesRow {
  treeCode: string;
  top: number;
}
```

同时定义几组固定量：

```ts
const ROW_HEIGHT = 24;
const ROW_GAP = 5;
const SERIES_GAP = 12;
const OVERSCAN_PX = 320;
```

含义是：

- 每行高度按 `24px` 估算
- 同一树种内部行与行之间留 `5px`
- 不同树种块之间留 `12px`
- 额外多渲染一段缓冲区，避免滚动时白屏

### 第二步：监听真正的滚动容器

左侧滚动并不是 `window`，而是 `data-container`。  
所以在 `Home.tsx` 里专门把它的 ref 传进来：

```tsx
const dataContainerRef = useRef<HTMLDivElement>(null)

<WidthContainer
  ...
  scrollContainerRef={dataContainerRef}
/>
```

然后在 `WidthContainer.tsx` 里监听：

- `scrollTop`
- `clientHeight`

更新当前视口：

```ts
const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
```

### 第三步：只截取当前可见行

通过二分查找，快速找到应该显示的行区间：

```ts
findVisibleStartIndex(...)
findVisibleEndIndex(...)
```

然后只保留：

```ts
const visibleRows = virtualRows.rows.slice(startIndex, endIndex + 1)
```

### 第四步：把每一行绝对定位到正确位置

容器本身不再按自然文档流堆满所有行，而是：

```css
.width-grid-container {
  position: relative;
}

.series-row {
  position: absolute;
  left: 0;
  right: 0;
}
```

对应地，在 JSX 中通过 `top` 摆放：

```tsx
style={{ top: `${row.top}px` }}
```

容器高度用整张虚拟表的总高度撑起来：

```tsx
style={{ height: `${virtualRows.totalHeight}px` }}
```

这样滚动条仍然反映整份数据的真实长度，但 DOM 里只存在当前视口附近那一小部分。

---

## 九、另一个关键优化：不要在每次 render 都重新 `getData()`

这一步很容易被忽略，但它在这个项目里影响其实很大。

在改造前，`Home.tsx` 里会频繁做：

```ts
const siteData = rwlEditorRef.current.getData();
```

而 `getData()` 返回的是一个新的 `Map` 副本。

这意味着什么？

- 即使窗口 resize 只是布局变化
- 只要 `Home` 重新 render
- 左侧宽度表和右侧图表都会拿到“新引用”
- 下游组件会以为“数据变了”

所以这次改成了显式快照：

```ts
const [siteDataSnapshot, setSiteDataSnapshot] = useState(...)
```

只有在真正的数据事件发生时才更新它：

- 打开文件
- 编辑年轮值
- 保存
- 另存为后同步基准

这样 resize 只影响布局，不再顺带制造一份“新数据”。

这是左侧虚拟列表之外，第二个真正有结构意义的性能优化。

---

## 十、图表区做了哪些配套优化

右下图表虽然不是最大瓶颈，但也做了几项配套处理。

### 1. 窗口持续 resize 时暂时不渲染真正图表

在 `Home.tsx` 中加了：

```ts
const [isWindowResizing, setIsWindowResizing] = useState(false)
```

逻辑是：

- 每次 `window.resize` 先把它置为 `true`
- 如果 `160ms` 内没有新的 resize，再恢复为 `false`

对应 UI：

```tsx
{isWindowResizing ? (
  <div className={style["chart-resize-placeholder"]}>
    正在调整窗口，图表会在结束后刷新。
  </div>
) : (
  <TreeChartManager fullData={siteData} />
)}
```

这样做的目的，是避免 Chart.js 在用户持续拖拽窗口边缘时每一帧都参与重绘。

### 2. 图表容器明确吃满剩余高度

这个改动前面是为了解决布局问题，但也顺手减少了图表 resize 时的异常抖动：

- `TreeChartManager` 拆分为按钮区 + 图表区
- `MultiLineChart` 允许高度跟随容器

图表不是本轮性能优化的核心，但如果不做这些配套修复，它很容易继续放大 resize 抖动。

---

## 十一、这次改动里踩过的坑

### 1. 以为是图表卡，实际主要是左侧大表格卡

这很常见。因为图表是“视觉上最复杂的东西”，但真正的浏览器布局成本经常来自大量普通 DOM。

### 2. 分栏问题表面像 CSS，实际根因是高度链

如果只盯着 `problems-container` 和 `line-chart` 调，很容易误判成：

- 条件渲染错了
- flex 比例错了
- z-index 错了

但真正根因其实是更上层的 `#root / App / Home` 高度没闭合。

### 3. 轻量优化无法替代减少 DOM 数量

`contain`、`content-visibility`、`memo` 都有用，  
但它们都不如“根本不渲染那几千行”来得直接。

---

## 十二、目前哪些改动最关键

如果只看最终收益，本轮最核心的三项是：

### 1. 首页分栏模型统一化

对应：

- `useResizablePanels.ts`
- `Home.tsx`
- `Home.module.css`

让首页真正具备：

- 左右拖拽
- 左侧上下拖拽
- 右侧上下拖拽
- 布局比例持久化

### 2. 高度链修复

对应：

- `index.html`
- `src/app/App.css`
- `src/app/App.tsx`
- `src/pages/Home.module.css`

让页面从“内容撑布局”变回“布局约束内容”。

### 3. 左侧宽度表虚拟化 + 数据快照化

对应：

- `src/components/WidthContainer/WidthContainer.tsx`
- `src/components/WidthContainer/WidthContainer.module.css`
- `src/pages/Home.tsx`

这部分是 resize 卡顿优化中最有决定性的结构性变化。

---

## 十三、涉及文件总览

本轮相关文件主要有：

- `index.html`
- `src/app/App.css`
- `src/app/App.tsx`
- `src/pages/useResizablePanels.ts`
- `src/pages/Home.tsx`
- `src/pages/Home.module.css`
- `src/components/WidthContainer/WidthContainer.tsx`
- `src/components/WidthContainer/WidthContainer.module.css`
- `src/components/WidthContainer/WidthGrid/WidthGrid.tsx`
- `src/components/Chart/TreeChartManager.tsx`
- `src/components/Chart/MultiLineChart.tsx`

---

## 十四、怎么验证这轮改动

建议至少手动验证下面几类场景。

### 布局与交互

- 左右主分栏是否能顺畅拖动
- 左侧上下分栏是否能正常拖动
- 右侧上下分栏是否能正常拖动
- 重启应用后布局比例是否保持

### 高度与滚动

- 加载大数据文件后，页面整体是否仍固定在窗口内
- `problems` 和 `chart` 是否还处于正常可见区域
- 左侧宽度表是否只在自身容器内滚动

### 性能

- 打开较大 RWL 后拖动窗口边缘，是否明显比改造前更顺
- resize 时右下图表是否先进入占位，停止后恢复
- 滚动左侧宽度表时是否还有明显白屏或跳动

### 构建

```bash
npm run build
```

---

## 十五、后续还可以怎么继续优化

如果未来仍觉得卡，建议继续往这几个方向走：

1. 增加性能埋点，量化 resize 时到底是布局、绘制还是脚本在吃时间
2. 把左侧虚拟列表从固定行高升级成可测量行高
3. 对图表区做更细粒度的 resize 降频
4. 如果树种数量很多，可考虑对图表选择按钮区也做虚拟化

---

## 十六、总结

这次改动表面上看，是“给首页加了拖拽分栏”。  
但真正完成下来，它其实是一次首页布局模型和大数据渲染方式的重构：

- 先重新定义页面的三组分栏
- 再修复高度链，防止布局被内容反向撑开
- 然后把 resize 卡顿从“感觉上在卡”拆解到真正的瓶颈
- 最后把左侧大表格从整表渲染改成按可视区渲染

所以，如果要用一句话概括这次工作，我会写成：

> 这次不是单纯地给 `Home` 页面加了 splitter，而是借这个机会，把首页从“静态堆叠 + 大 DOM 全量渲染”升级成了“可调布局 + 稳定高度链 + 可视区渲染”的版本。
