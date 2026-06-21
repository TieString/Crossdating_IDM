# 文档维护规则

## 文档信息

- 读者：开发者、维护者、Reviewer
- 最后更新：2026-06-21
- 维护人：项目维护者
- 适用版本：1.0.0

## 文档与代码同步

以下变更必须同步更新文档：

1. 新增、删除、重命名组件。
2. 修改组件 props。
3. 修改 hooks 或 utils 的公开行为。
4. 修改项目启动、构建、部署方式。
5. 修改核心架构、状态管理方式或数据流。
6. 修改领域算法、数据结构或验证脚本。
7. 修复影响使用方式的 bug。

## Review 标准

文档变更应检查以下内容：

1. 事实是否与当前代码一致。
2. 示例代码是否可以运行。
3. props、类型、默认值是否准确。
4. 文档是否说明了边界情况。
5. 是否标注最后更新时间。
6. 是否存在过期链接或失效命令。

## 文档格式

每篇长期维护文档应包含：

```md
# 标题

## 文档信息

- 读者：
- 最后更新：
- 维护人：
- 适用版本：
```

## 文档分工

- `README.md`：项目入口、核心流程、常用命令和文档导航。
- `docs/architecture.md`：真实代码结构、主数据流、领域模块边界。
- `docs/development.md`：本地开发、构建、验证、TypeDoc 和 Storybook。
- `docs/components.md`：核心组件 props、默认行为、示例、边界情况和已知限制。
- `docs/cofecha-reference.md`：COFECHA-pass 动态参考序列的算法、状态、UI 行为和验证入口。
- `docs/maintenance.md`：文档同步和 review 规则。
- `docs/api`：由 TypeDoc 生成，不手写修改。

## Storybook 维护

新增核心展示组件或修改公开 props 时，应同步更新对应 `*.stories.tsx`。stories 应使用小而真实的示例数据，不调用 Tauri 文件系统、COFECHA sidecar 或会修改本地文件的逻辑。

## TypeDoc 维护

公开 props、hooks、utils 和领域类型应补充 TSDoc。内部 helper 可以保持私有；不应为了文档输出而扩大运行时 API。

## 依赖升级与漏洞修复

依赖升级、`npm audit fix`、lockfile 重生成、包管理器切换都可能改变运行时行为。涉及以下范围时，必须同步更新文档或 `docs/bugs/` 记录：

1. Tauri 插件、sidecar、文件系统、窗口桥接。
2. Vite、React、Storybook、TypeDoc 等构建和文档工具链。
3. RWL 解析、保存、COFECHA 执行、持久化相关依赖。
4. 任何会改变启动命令、lockfile、安装方式或验证方式的调整。

不要把漏洞修复和结构重构混在同一轮。修复前应记录关键依赖版本，修复后应运行构建、验证脚本和必要的桌面手动测试。

已知案例：

- [COFECHA sidecar stuck after dependency audit fix](bugs/cofecha-sidecar-stuck-after-audit-fix.md)
