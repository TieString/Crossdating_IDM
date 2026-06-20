# 核心组件文档

## 文档信息

- 读者：前端开发者、维护者
- 最后更新：2026-06-19
- 维护人：项目维护者
- 适用版本：1.0.0

## WidthContainer

### 用途

`src/components/WidthContainer/WidthContainer.tsx` 渲染 RWL 宽度网格。它展示序列、年份、宽度值、missing pad、stop marker、COFECHA/诊断高亮、删除标记和编辑动画，并通过回调把用户操作交给工作区/RWL 编辑器。

### Props

- `siteData`：必填，`RwlSiteData`，按 series code 和 year 存储的 RWL 数据。
- `masterSeries`：可选，参考序列值。
- `masterCorrelations`：可选，COFECHA PART 7 的整体相关系数。
- `seriesProblemCounts`：可选，COFECHA PART 7 的潜在问题段数量。
- `selected`：可选，当前选中序列。
- `historyAnimation`：可选，撤销/恢复动画指令。
- `jumpTarget`：可选，跳转高亮目标。
- `editHighlightTarget`：可选，编辑后高亮目标。
- `deleteSeriesRequest`：可选，外部触发的删除序列请求。
- `deletionMarkers`：可选，删除标记栈。
- `cofechaPart6Trees`：可选，拥有 COFECHA PART 6 问题块的序列集合。
- `scrollContainerRef` / `scrollElement`：可选，用于跳转和滚动协调。
- `onYearClick`、`onInsertMissingYearAtSide`、`onMoveSeriesTailByOffset`、`onDeleteYearWithMode`、`onMarkYearRangeAsMissing`、`onRestoreDeletion`、`onDeleteSeries`、`onEditAsText`、`onJumpToCofecha`、`onDeleteSeriesRequestHandled`、`onReplaceTreeData`：用户操作回调。

### 默认行为

未提供可选回调时，对应交互不会把编辑意图提交给外部。动画速度和动画开关来自 `useSettings()`，因此组件应位于 `SettingsProvider` 内。

### 使用示例

```tsx
import WidthContainer from "@/components/WidthContainer/WidthContainer";

<WidthContainer
  siteData={siteData}
  selected="ABC01A"
  onYearClick={(tree, year) => console.log(tree, year)}
/>
```

### 边界情况

- `siteData` 为空时不会渲染实际序列。
- stop marker 会作为特殊 cell 处理，不作为普通可编辑宽度值。
- missing pad 用于显示年份中断，不等同于真实宽度值。
- `scrollElement` 优先于 `scrollContainerRef`。

### 已知限制

- 组件负责大量网格交互和动画，仍是较重的 UI 模块。
- 需要浏览器 DOM、Pointer Events、ResizeObserver 和 Web Animations API 环境。

## WidthGridSkeleton

### 用途

`WidthGridSkeleton` 渲染宽度网格加载骨架，与真实网格共享表头结构。

### Props

- `showRows`：可选，默认 `false`。为 `true` 时显示随机行数的占位序列。

### 默认行为

只显示表头骨架。行骨架的数量在组件挂载时生成一次。

### 使用示例

```tsx
import { WidthGridSkeleton } from "@/components/WidthContainer/WidthContainer";

<WidthGridSkeleton showRows />
```

### 边界情况

`showRows={false}` 时不显示 body 占位。

### 已知限制

骨架行数使用 `Math.random()` 生成，仅用于加载视觉效果，不适合快照测试断言具体行数。

## SeriesTextEditor

### 用途

`src/components/WidthContainer/SeriesTextEditor.tsx` 将单个序列作为 `year value` 文本进行编辑，并支持提交、取消、多光标和列选择。

### Props

- `treeCode`：序列名称。
- `initialText`：初始文本。
- `stopMarkerValue`：提交解析时追加的 stop marker。
- `onClose`：关闭回调。提交时传入文本，取消时不传文本。

### 默认行为

挂载后自动聚焦。`Ctrl+Enter` 提交，`Esc` 取消，点击外部会提交当前文本。卸载时如果尚未关闭，会把当前文本传给 `onClose`。

### 使用示例

```tsx
<SeriesTextEditor
  treeCode="ABC01A"
  initialText="1900\t112\n1901\t118"
  stopMarkerValue={999}
  onClose={(text) => console.log(text)}
/>
```

### 边界情况

- 空文本、非法年份或非法宽度会解析失败。
- `missing` 会解析为 `null`。
- 文本解析成功后会在最大年份后一位追加 stop marker。

### 已知限制

这是 textarea 叠加层实现，不是 CodeMirror。复杂编辑能力只覆盖当前源码中实现的快捷键。

## RawTextEditor

### 用途

`src/components/FindReplace/RawTextEditor.tsx` 是基于 CodeMirror 6 的 raw text editor，用于原始文本编辑和查找替换。

### Props

- `initialText`：初始文档内容。
- `invalid`：可选，显示非法状态样式。
- `onInput`：文档变化回调。
- `onSearchStateChange`：搜索匹配数和当前匹配变化回调。
- `onSave`：`Mod+S` 回调。
- `onApply`：`Mod+Enter` 回调。
- `onCancel`：`Escape` 回调。

### 默认行为

挂载时创建一次 CodeMirror 实例并聚焦。后续 `initialText` 变化不会自动重建编辑器，调用端需要通过 React `key` 控制重置。

### 使用示例

```tsx
const editorRef = useRef<RawEditorHandle>(null);

<RawTextEditor
  ref={editorRef}
  initialText={rawText}
  onApply={() => editorRef.current?.getValue()}
/>
```

### 边界情况

- 搜索为空时，`onSearchStateChange` 返回 `{ count: 0, current: 0 }`。
- 中键拖拽用于矩形选择，并阻止 WebView 的自动滚动。

### 已知限制

搜索通过 CodeMirror literal search 配置执行，不是正则搜索。

## FindReplaceBar

### 用途

`src/components/FindReplace/FindReplaceBar.tsx` 是受控查找/替换浮层。它只展示状态并向外抛出用户动作。

### Props

- `mode`：`"find"` 或 `"replace"`。
- `textMode`：可选，默认 `false`。文本模式允许替换为空字符串。
- `query`、`replaceValue`：受控输入值。
- `matchIndex`、`matchCount`：当前匹配位置和总数。
- `onModeChange`、`onQueryChange`、`onReplaceValueChange`、`onNext`、`onPrev`、`onReplaceOne`、`onReplaceAll`、`onClose`：交互回调。

### 默认行为

打开后在下一帧聚焦查找框。组件挂载期间按 `Escape` 会调用 `onClose()`。查找框按 `Enter` 调用下一项，`Shift+Enter` 调用上一项。

### 使用示例

```tsx
<FindReplaceBar
  mode="find"
  query={query}
  replaceValue=""
  matchIndex={0}
  matchCount={0}
  onModeChange={setMode}
  onQueryChange={setQuery}
  onReplaceValueChange={setReplaceValue}
  onNext={findNext}
  onPrev={findPrev}
  onReplaceOne={replaceOne}
  onReplaceAll={replaceAll}
  onClose={close}
/>
```

### 边界情况

宽度值模式下，替换值为空或全空白时禁用替换按钮。文本模式下允许空替换。

### 已知限制

查找和替换逻辑不在组件内部实现，必须由调用端维护匹配状态。

## FloatingScrollArea

### 用途

`src/components/FloatingScrollArea/FloatingScrollArea.tsx` 包装原生滚动容器，并叠加 `FloatingScrollbar`。

### Props

继承大多数 `HTMLAttributes<HTMLDivElement>`，但自定义 `children`：

- `children`：ReactNode，或接收滚动容器 ref 的 render function。
- `viewportClassName`、`viewportStyle`：外层 viewport 样式。
- `scrollbarRevision`：强制刷新滚动条尺寸的修订值。
- `topClearanceSelector`：滚动容器内部需要避让的 sticky 顶部元素选择器。
- `edgeInset`：滚动条轨道边距。

### 默认行为

外层渲染 viewport，内层渲染原生 scroll div，并给同一目标挂载浮动滚动条。

### 使用示例

```tsx
<FloatingScrollArea style={{ height: 320 }}>
  <div style={{ width: 800 }}>content</div>
</FloatingScrollArea>
```

### 边界情况

如果内容不溢出，浮动 thumb 会隐藏。

### 已知限制

依赖 DOM 测量和 ResizeObserver；不适合服务端渲染为最终交互形态。

## FloatingScrollbar

### 用途

`src/components/FloatingScrollbar/FloatingScrollbar.tsx` 为原生滚动元素绘制水平和垂直浮动 thumb。

### Props

- `targetRef`：必填，指向原生滚动元素。
- `revision`：可选，变化时重新测量。
- `topClearanceSelector`：可选，避让 sticky header。
- `edgeInset`：可选，默认 `8`。

### 默认行为

滚动或 pointer move 时显示 thumb，约 1000ms 后隐藏。支持 scroll-driven animation 的浏览器使用 compositor 跟随滚动，否则回退到 scroll 事件更新 transform。

### 使用示例

```tsx
<FloatingScrollbar targetRef={scrollRef} edgeInset={8} />
```

### 边界情况

目标元素不存在时不执行测量和监听。

### 已知限制

只绘制 overlay thumb，不替换浏览器原生滚动能力。

## ContextMenu

### 用途

`src/components/ContextMenu/ContextMenu.tsx` 通过 portal 在 viewport 坐标处显示右键菜单。

### Props

- `open`：是否显示。
- `x`、`y`：菜单锚点坐标。
- `items`：菜单项，包含 `key`、`label`、`onSelect`，可选 `icon`、`danger`、`disabled`。
- `onClose`：关闭回调。

### 默认行为

菜单超出 viewport 时会翻转到可见区域。点击外部、按 `Escape`、滚动、resize 或选择菜单项都会关闭。

### 使用示例

```tsx
<ContextMenu
  open={open}
  x={x}
  y={y}
  items={[{ key: "delete", label: "Delete", danger: true, onSelect: remove }]}
  onClose={close}
/>
```

### 边界情况

disabled 项不会调用 `onSelect()`。

### 已知限制

键盘导航只处理 `Escape` 关闭，没有实现方向键 roving focus。

## Menu / MenuItem

### 用途

`src/components/Menu/Menu.tsx` 和 `MenuItem.tsx` 渲染顶部菜单和嵌套子菜单。

### Props

`Menu`：

- `items`：菜单配置数组，包含 `label`，可选 `onClick`、`disabled`、`children`。

`MenuItem`：

- `label`、`onClick`、`onMouseEnter`、`onMouseLeave`、`isActive`、`disabled`、`children`。

### 默认行为

`Menu` 管理当前 hover 激活项。叶子节点点击时执行 `onClick`，Promise rejection 会通过 `console.error("Menu action failed:", error)` 输出。

### 使用示例

```tsx
<Menu
  items={[
    { label: "File", children: <Menu items={[{ label: "Open", onClick: openFile }]} /> },
  ]}
/>
```

### 边界情况

带 `children` 的项只负责打开子菜单，不直接执行 `onClick`。

### 已知限制

当前菜单主要基于 hover 和 click，没有完整 ARIA menubar 键盘导航。

## RollingNumber

### 用途

`src/components/RollingNumber/RollingNumber.tsx` 渲染按位滚动的数字动画。

### Props

- `value`：目标数字。
- `fromValue`：可选，动画起始数字。
- `placeholder`：可选，默认 `"missing"`，当 `value` 不是数字时显示。
- `stagger`：可选，默认 `0.035`，每位数字的延迟。
- `speed`：可选，默认 `1`，动画速度倍率。

### 默认行为

当 `value` 是有限数字时按字符拆分并渲染滚动列；否则显示 placeholder。

### 使用示例

```tsx
<RollingNumber value={128} fromValue={95} speed={1} />
```

### 边界情况

负号和非数字字符会作为静态字符显示。

### 已知限制

组件只负责显示动画，不做数值格式化或本地化。
