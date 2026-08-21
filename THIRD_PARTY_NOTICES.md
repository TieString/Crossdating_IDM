# Third-Party Notices

Crossdating IDM 使用或随附若干第三方组件。项目根目录中的 GNU GPL v3.0 only 许可证不会取代这些第三方组件各自的版权和许可条款。

## COFECHA 可执行程序

以下文件是第三方 COFECHA 可执行程序，不属于 Crossdating IDM 的 GPL-3.0-only 授权范围：

- `src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe`
- `src-tauri/bin/cofecha12k-x86_64-pc-windows-msvc.exe`
- `src-tauri/bin/cofechawin-x86_64-pc-windows-msvc.exe`

这些文件的版权和许可权利仍归其各自权利人所有。公开分发源码、安装包或 Release 资产前，发布者必须自行确认拥有分发这些文件的许可；如果无法确认，应从公开仓库和发布包中移除这些文件，并改为要求用户从获授权的来源自行提供。

COFECHA 由 Richard L. Holmes 创建。推荐引用：Holmes, R. L. (1983). Computer-assisted quality control in tree-ring dating and measurement. *Tree-Ring Bulletin*, 43, 69-78。

## ITRDB 示例数据

根目录 `test-data` 中的 RWL 示例来自 NOAA National Centers for Environmental Information, World Data Service for Paleoclimatology 管理的 International Tree-Ring Data Bank (ITRDB)。数据继续适用 ITRDB 及原始调查者的归属和引用要求；来源链接、文件校验值和逐站点说明见 `test-data/README.md` 与 `test-data/SHA256SUMS.txt`。

## 软件依赖

JavaScript/TypeScript 和 Rust 依赖继续适用其各自许可证。依赖清单与锁定版本记录在 `package.json`、`package-lock.json`、`yarn.lock`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中。将依赖与本项目一起使用或分发时，仍须遵守对应依赖的许可及声明要求。
