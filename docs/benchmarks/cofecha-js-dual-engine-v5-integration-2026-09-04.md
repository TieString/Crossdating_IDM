# cofecha-js双引擎与统一v5接入报告

日期：2026-09-04

## 结论

当前`main`已恢复`cofecha-js 0.2.0`完整报告链，并与官方COFECHA EXE统一到同一个OUT文本入口。JavaScript是默认引擎，不依赖EXE，在Web Worker中运行；官方引擎继续使用Tauri/Rust工作目录。两种引擎的OUT都经现有formatter解析，PART 3和PART 6生成动态参考、锚定芯与待复核队列，只有完整输入身份匹配时才允许自动建议。

冻结v5模型资产、207维证据定义、模型权重和事件门均未修改。报告引擎不进入模型输入；引擎切换只控制报告/动态参考的新鲜度。whole→统一局部选择、partial→missing和逐层恢复交互均保留。

## 迁移来源与方式

只读参考：`archive/main-before-auto-suggestion-2026-09-04`（`aaada0aa`）。

没有cherry-pick或覆盖整分支，而是在当前Home、保存缓存和v5 Worker基础上逐文件迁移：

| 模块 | 迁移或合并内容 |
| --- | --- |
| `src/services/cofecha/cofechaJs.worker.ts` | Worker内调用`cofecha-js`并只回传完整OUT或规范化错误 |
| `src/services/cofecha/jsRunner.ts` | 构建dated/undated请求；浏览器走Worker，SSR/测试走内联实现 |
| `src/services/cofecha/jsWorkerProtocol.ts` | Worker请求/响应类型 |
| `src/services/cofecha/index.ts` | JavaScript/官方双引擎统一入口 |
| `src/services/cofecha/runner.ts` | 保留官方EXE链并补回undated文件与排序参数 |
| `src-tauri/src/cofecha.rs` | 官方PART 8提示、R/D排序验证和安全文件名检查 |
| `src/features/settings/*`、`src/pages/settings/*` | 默认JavaScript、显式双引擎选择、官方EXE配置 |
| `src/pages/home/CofechaUndatedControls.*` | PART 8加载、更换、清除和R/D排序 |
| `src/pages/Home.tsx`、`WorkspacePages.tsx`、`workspaceWindowBridge.ts` | 主窗口与独立报告窗口共享PART 8状态和命令 |
| `useHomeWorkspace.ts` | 在当前保存复用、请求合并和v5缓存基础上接入双引擎、PART 8及过期门 |
| `workspacePersistence.ts` | 持久化报告引擎、OUT、解析结果、输入签名、undated来源、排序和过期状态 |
| `diagnosisReferencePolicy.ts` | 明确拒绝`isStale`动态参考 |

## 没有迁移的旧逻辑

- 没有复制存档分支的整份`useHomeWorkspace.ts`，避免覆盖当前保存缓存、在途请求合并和常驻v5 Worker。
- 没有恢复旧`CofechaVersion`三版本菜单；官方版本由用户选择的EXE路径定义。
- 没有恢复legacy诊断、旧模型或让OUT内容重写v5操作、位移和窗口。
- 没有复制存档的旧formatter；当前formatter继续作为两种OUT的唯一解析器。
- 没有提交、复制或分发官方COFECHA EXE。
- 没有把PART 8的排序/交互写回原始OUT；界面只渲染内存中的查看副本。

## 数据流

### JavaScript

```text
当前dated RWL + 可选undated RWL + R/D排序
  → cofechaJs.worker.ts
  → cofecha-js 0.2.0（内存）
  → 完整OUT（PART 1–7，可选PART 8）
  → formatter
  → PART 3 master + PART 6 A分类
  → dynamic reference / anchorPassIds / candidateFlaggedIds
  → referenceReady门
  → v5 Worker使用当前RWL构建目标排除的testingValues证据
```

JavaScript路径不创建`cofecha-work`，也不读取EXE路径。

### 官方

```text
当前dated RWL + 可选undated RWL + R/D排序
  → services/cofecha/runner.ts
  → Tauri run_external_cofecha
  → 用户选择的官方EXE / VERYCOF.OUT
  → 同一formatter和动态参考链
```

## 自动建议参考链

1. 完整OUT解析PART 6；无A问题芯进入锚定组，有A问题芯进入待复核队列。
2. PART 3 master dating series交给`createCofechaMasterReferenceConfig`。
3. 动态参考记录当前dated RWL哈希，并在编辑、引擎或PART 8输入变化时立即标记`isStale`。
4. `selectAutomaticDiagnosisReferenceConfig`只接受非过期且含chronology points的动态参考。
5. v5 Worker请求仍只有`siteData`、目标ID、精度和`referenceReady`，不含报告引擎或类别规则。
6. `CofechaEngineEvidenceCache`使用cofecha-js报告预处理的testingValues，并从参考集合排除当前目标芯。

## 缓存与过期身份

复用身份同时包含：

- 完整序列化dated RWL文本与内容签名；
- dated文件路径；
- 报告引擎；
- 官方EXE路径（仅官方引擎）；
- cofecha-js版本；
- undated完整文本、路径与签名；
- PART 8排序方式。

相同身份的成功结果可在重复保存或重新打开时复用；同一身份的在途请求只运行一次。真正编辑RWL、切换引擎、改变EXE、加载/清除undated或改变排序会立即使当前报告和动态参考过期。编辑停止300ms后会使用当前working RWL自动刷新所选引擎，不需要先保存源文件；新OUT完成后更新同一份完整状态。OUT/reference对象身份变化不会清空相同RWL状态下的v5结果缓存。

## 持久化

`PersistedCofechaState`记录：报告引擎、完整OUT、序列化解析结果、dated签名、cofecha-js版本、官方EXE路径、undated路径/签名、PART 8排序及`reportIsStale`。动态参考继续保存在reference状态中。

重新打开时必须同时满足RWL签名、引擎、EXE、cofecha-js版本和全部undated身份，才恢复为fresh并立即复用；否则旧OUT仅作为“上次结果”展示，动态参考保持过期并自动重算。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| TypeScript严格检查 | 通过 |
| cofecha-js请求/Runner | 4/4通过 |
| JavaScript/官方统一OUT契约 | 1/1通过 |
| 设置默认值、持久化与引擎UI | 6/6通过 |
| 校验身份、复用与编辑后自动刷新 | 5/5通过 |
| 工作区持久化 | 3/3通过 |
| PART 8控件、R/D排序与清除契约 | 2/2控件 + Runner覆盖通过 |
| 动态参考新鲜度门 | 5/5通过 |
| v5生产与复核交互 | 纳入生产测试并通过 |
| 生产测试总计 | 108/108通过 |
| Rust官方dated/PART 8提示 | 4/4通过 |
| 独立工作区窗口smoke | 通过；验证器不再扫描`.benchmark-results` |
| `npm run build` | 通过；产出独立`cofechaJs.worker`和`diagnosisWorker` |

JavaScript测试确认无需EXE即可生成PART 1–7；加载undated后生成PART 8，并能在最高相关R与年份调整D之间切换。PART 8存在时，PART 1–7的formatter解析结果保持不变。

## 对v5准确率的影响

- 模型资产SHA-256仍为`4a355af59c22a9cd53e20d233256d94b44b83aea222d7ace55e6cb7e9bbb5c1e`。
- 报告引擎不进入v5候选、阈值、位移或窗口输入。
- 同一RWL状态在引擎切换后复用相同v5状态缓存；只在fresh报告恢复后重新显示。
- 冻结模型、signed-whole和操作/窗口专项均在生产测试中通过，因此A/B/C/D首次操作和窗口数值没有接入层变化。
- 当前whole/partial人工复核只改变用户选择后的解释路径，不改变首次模型答案。

## 已知限制

- 仓库不包含官方COFECHA EXE，因此本轮不能在自动环境中执行真实官方二进制；已验证Rust提示文本、参数安全和官方OUT统一解析入口。真实EXE仍需用户本机测试。
- JavaScript与官方程序可能在数值细节或报告排版上存在差异；前端字段和完整PART契约统一，但不声称字节级OUT相同。
- PART 8当前接收Tucson RWL未定年输入。
- 已消费校准结果不是新的final；本轮没有重新训练或调整v5。

## 冻结与提交状态

参考工作树和归档分支保持只读；目标工作树原有未提交v5、可逆复核、性能优化和Archify文件均保留。本报告完成时尚未提交或推送。
