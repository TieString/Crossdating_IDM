# Third-Party Notices

Crossdating IDM 使用或随附若干第三方组件。项目根目录中的 GNU GPL v3.0 only 许可证不会取代这些第三方组件各自的版权和许可条款。

## COFECHA

Crossdating IDM 不包含、复制或分发 COFECHA 可执行程序。用户可从 [LTRR Dendrochronology Program Library](https://cambium.ltrr.arizona.edu/research/software) 独立获取 COFECHA，并在应用设置中选择本机 EXE；所选程序继续适用其权利人提供的条款，不属于 Crossdating IDM 的 GPL-3.0-only 授权范围。

COFECHA 由 Richard L. Holmes 创建。推荐引用：Holmes, R. L. (1983). Computer-assisted quality control in tree-ring dating and measurement. *Tree-Ring Bulletin*, 43, 69-78。

## ITRDB 示例数据

根目录 `test-data` 中的 RWL 示例来自 NOAA National Centers for Environmental Information, World Data Service for Paleoclimatology 管理的 International Tree-Ring Data Bank (ITRDB)。数据继续适用 ITRDB 及原始调查者的归属和引用要求；来源链接、文件校验值和逐站点说明见 `test-data/README.md` 与 `test-data/SHA256SUMS.txt`。

## 软件依赖

JavaScript/TypeScript 和 Rust 依赖继续适用其各自许可证。依赖清单与锁定版本记录在 `package.json`、`package-lock.json`、`yarn.lock`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中。将依赖与本项目一起使用或分发时，仍须遵守对应依赖的许可及声明要求。
