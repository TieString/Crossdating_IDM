# COFECHA sidecar stuck after dependency audit fix

## 文档信息

- 读者：维护者、依赖升级执行者、COFECHA 集成调试者
- 最后更新：2026-06-20
- 维护人：项目维护者
- 适用版本：1.0.0 / Tauri 2

## 摘要

一次为了修复 `npm audit` 漏洞而执行的依赖升级，导致打开 RWL 文件后界面可以显示宽度网格，但 COFECHA 区域一直停留在“正在运行 COFECHA...”状态。

最初通过恢复到文档系统生成后的依赖锁定状态临时止血。后续分组验证确认：只升级前端 `@tauri-apps/plugin-shell` 到 `2.3.5` 仍会卡住；同时升级前端 shell 插件与 Rust 侧 Tauri/shell 锁定版本后，COFECHA 恢复正常。

## 影响范围

受影响路径：

- `src/services/cofecha/runner.ts`
- `src/pages/home/useHomeWorkspace.ts`
- `src-tauri/tauri.conf.json`
- `package-lock.json`
- `yarn.lock`
- `src-tauri/Cargo.lock`

用户可见现象：

1. 打开 `.rwl` 文件后，宽度网格能显示。
2. 文件读取和 RWL 解析实际上已经完成。
3. COFECHA 面板长期显示“正在运行 COFECHA...”。
4. `isCofechaRunning` 一直为 `true`。
5. `runCofecha()` 没有完成，`close` 事件没有按预期触发。

## 触发背景

当时为了修复 audit 漏洞，执行过类似命令：

```bash
npm audit fix
npm install
```

依赖解析版本发生变化：

```text
@tauri-apps/plugin-shell: 2.2.0 -> 2.3.5
vite: 6.1.1 -> 6.4.3
react-router: 7.2.0 -> 7.18.0
```

恢复后确认的临时稳定状态：

```text
@tauri-apps/plugin-shell: 2.2.0
vite: 6.1.1
react-router: 7.2.0
```

后续验证可用的升级状态：

```text
@tauri-apps/plugin-shell: 2.3.5
tauri-plugin-shell: 2.3.5
tauri: 2.11.3
tauri-runtime: 2.11.3
vite: 6.1.1
react-router: 7.2.0
```

## 判断依据

排查时观察到：

- RWL 网格已经渲染，说明文件读取、解析和 `siteData` 设置不是根因。
- 卡住的是 COFECHA 运行状态，说明问题集中在 `runCofecha()` 或 sidecar 进程交互。
- Node 脚本 `yarn validate:cofecha:samples` 可以直接调用本地 COFECHA sidecar 并生成 `VERYCOF.OUT`，说明 COFECHA 可执行文件本身不是根因。
- 恢复依赖锁定后，COFECHA 运行恢复正常。
- 只升级前端 `@tauri-apps/plugin-shell` 到 `2.3.5` 后，COFECHA 仍然卡住。
- 同步升级前端 shell 插件与 Rust 侧 Tauri/shell 锁定版本后，COFECHA 在真实桌面环境恢复正常。

因此，这不是文档系统、RWL 解析、宽度网格拆分或 Yarn 启动命令本身导致的问题，而是 Tauri shell 前端包与 Rust 侧 Tauri/shell 运行时版本组合不一致或不兼容导致的高概率事件。

## 分组验证记录

| 组别 | 依赖状态 | 结果 | 结论 |
| --- | --- | --- | --- |
| A | 文档系统生成后的锁定状态，`@tauri-apps/plugin-shell@2.2.0` | 正常 | 可作为临时回退点 |
| B | 只升级前端 `@tauri-apps/plugin-shell@2.3.5` | 卡住 | 不能只升级 JS shell 插件 |
| C | 前端 `@tauri-apps/plugin-shell@2.3.5`，Rust 侧 `tauri-plugin-shell@2.3.5`，Tauri 栈解析到 `2.11.3` | 正常 | 前后端/Rust 侧版本对齐后可用 |

验证过的命令：

```bash
yarn build
cargo check
```

桌面端手动验证：

```text
yarn tauri dev
打开同一个 RWL 文件
COFECHA 能结束，不再停留在“正在运行 COFECHA...”
```

## 恢复与修复方式

临时止血方式是恢复到文档系统生成后的锁文件状态：

1. 保留文档系统新增内容。
2. 恢复 `package-lock.json` 或 `yarn.lock` 中关键版本：

```text
@tauri-apps/plugin-shell@2.2.0
vite@6.1.1
react-router@7.2.0
```

3. 撤销后续为排查问题临时加入的 COFECHA runner 和 loading 状态改动。

最终可用修复是保留 `vite` 与 `react-router` 原有稳定版本，只让 Tauri shell 相关依赖前后端对齐：

```text
package.json / yarn.lock:
@tauri-apps/plugin-shell: 2.3.5

src-tauri/Cargo.lock:
tauri-plugin-shell: 2.3.5
tauri: 2.11.3
tauri-runtime: 2.11.3
```

注意：这次 Cargo 不是只升级了 `tauri-plugin-shell`，而是连带解析并升级了 Rust 侧 Tauri 栈。后续如果要进一步缩小范围，需要单独研究 Cargo 依赖约束，而不是把本次结果误写成“只升级 Rust shell 插件即可”。

## 后续修漏洞规则

不要直接对全项目运行：

```bash
npm audit fix
```

更安全的流程：

1. 先保存当前工作区或建立临时分支。
2. 阅读 `npm audit` 输出，区分生产依赖、开发依赖和传递依赖。
3. 分包升级，而不是一次性升级所有可修复项。
4. 每升级一个关键依赖，就运行：

```bash
npm run build
npm run validate:samples
npm run validate:workspace-windows
npm run validate:auto-crossdating
```

5. 涉及 COFECHA 或 Tauri shell 时，额外手动测试：

```text
[ ] yarn/npm tauri dev 能启动
[ ] 打开 RWL 后宽度网格显示
[ ] COFECHA 自动运行能结束
[ ] VERYCOF.OUT 能显示
[ ] 重新运行 COFECHA 按钮可用
[ ] OUT 文件能镜像保存到 RWL 旁边
```

6. 单独测试这些依赖：

```text
@tauri-apps/plugin-shell
@tauri-apps/api
@tauri-apps/plugin-fs
@tauri-apps/plugin-dialog
vite
react-router
```

## 如果必须升级 `@tauri-apps/plugin-shell`

如果安全修复必须升级 `@tauri-apps/plugin-shell`，必须同步验证 Rust 侧 `tauri-plugin-shell` 和 Tauri 栈锁定版本。不要只升级前端 JS 包。

如果未来再次出现 sidecar 卡住，再考虑把 COFECHA 执行移动到 Rust command 中，由 Rust 直接控制：

- sidecar 路径
- 工作目录
- stdin 写入和关闭
- stdout/stderr 消费
- 进程超时
- `VERYCOF.OUT` 读取
- OUT 镜像保存

这样可以减少 JavaScript shell 插件版本变化对 COFECHA 交互式进程的影响。

## 注意事项

- 漏洞修复是必要工作，但不能和结构重构、文档生成、包管理器切换混在同一轮。
- 修改 lockfile 后必须说明关键依赖版本变化。
- 如果运行行为变化，必须记录到 `docs/bugs/` 或维护文档中。
- 对 Tauri sidecar、文件系统权限、外部命令交互的改动，必须做真实桌面环境测试，不能只依赖 Vite 构建通过。