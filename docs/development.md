# 开发指�?
## 文档信息

- 读者：开发者、维护�?- 最后更新：2026-06-19
- 维护人：项目维护�?- 适用版本�?.0.0

## 环境

项目使用 Node.js、npm、Vite、React、TypeScript �?Tauri 2。依赖以 `package-lock.json` 锁定�?
安装依赖�?
```bash
npm install
```

浏览器开发：

```bash
npm run dev
```

Tauri 桌面开发：

```bash
npm run tauri
```

Vite 配置�?`vite.config.ts`。开发服务器固定使用 Tauri 常见端口 `1420`，并配置 `@` 指向 `src`�?
## 构建

```bash
npm run build
```

该命令先运行 `tsc`，再运行 `vite build`�?
## 验证脚本

```bash
npm run validate
npm run validate:samples
npm run validate:samples:strict
npm run validate:workspace-windows
npm run validate:auto-crossdating
npm run validate:cofecha:samples
npm run trial:auto-crossdating
```

- `validate:samples`：验证仓库样例的 RWL 解析、内部诊断和摘要链路�?- `validate:workspace-windows`：SSR smoke 验证独立窗口渲染和桥接常量�?- `validate:auto-crossdating`：验证自动交叉定年主流程�?synthetic demo�?- `validate:cofecha:samples`：直接调用本�?COFECHA sidecar 验证样例�?- `trial:auto-crossdating`：在临时目录�?RAW 样例试跑候选应用，不修改源文件�?
## TypeDoc

配置文件：`typedoc.json`

生成 API 文档�?
```bash
npm run docs:api
```

输出目录：`docs/api`

TypeDoc 入口覆盖 `src/components`、`src/features`、`src/services` �?`src/pages/useResizablePanels.ts`。私有成员和�?`@internal` 的成员不会输出�?
## Storybook

配置目录：`.storybook`

启动组件预览�?
```bash
npm run storybook
```

构建静�?Storybook�?
```bash
npm run build-storybook
```

Storybook 使用 `@storybook/react-vite` �?Autodocs。stories 放在组件目录旁边，文件名�?`*.stories.tsx`。当前核�?stories 覆盖菜单、查找替换、raw text editor、浮动滚动区、宽度网格骨架和宽度网格样例�?
## 文档编写约定

新增或修改公开 props、hooks、utils 时，同步补充 TSDoc。组件级用法、默认行为、边界情况和已知限制维护�?`docs/components.md`。项目结构、数据流和运行方式分别维护在 `docs/architecture.md` 和本文件�?
## 不改变业务逻辑的文档改动边�?
可以做：

- 增加 TSDoc�?- 导出仅用于文档和类型检查的 props 类型�?- 增加 Storybook stories�?- 增加 TypeDoc 配置和文档脚本�?- 增加 Markdown 文档�?
不要在文档任务中顺手修改�?
- RWL 解析、格式化和保存逻辑�?- COFECHA 工作目录、sidecar 调用�?OUT 处理�?- localStorage key、字段名和序列化格式�?- 诊断算法、候选排序、动画时序和用户可见文案�?
## ������ȫ�޸�ע������

�޸� `npm audit` ������ Tauri/Vite/React �������ǰ�����Ķ���

- [Bug ���¹ʼ�¼](bugs/README.md)
- [COFECHA sidecar stuck after dependency audit fix](bugs/cofecha-sidecar-stuck-after-audit-fix.md)

��Ҫֱ�Ӱ� `npm audit fix` �ͽṹ�ع����ĵ����ɡ����������л�����ͬһ�֡��漰 `@tauri-apps/plugin-shell` �� COFECHA sidecar ʱ����������ʵ���滷�����ԡ�

## Tauri ǰ������

`src-tauri/tauri.conf.json` ʹ�� `yarn dev` �� `yarn build` ��Ϊ Tauri ��ǰ������ճ����濪���Ƽ�ʹ�ã�

```bash
yarn tauri dev
```

������ͬһ�ֹ����л��� npm/Yarn �İ�װ�� audit �޸�����漰��������ʱ���Ķ� `docs/bugs/` �е��¹ʼ�¼��
