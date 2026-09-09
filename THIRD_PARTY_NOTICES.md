# Third-Party Notices

Crossdating IDM 使用或随附若干第三方组件。项目根目录中的 GNU GPL v3.0 only 许可证不会取代这些第三方组件各自的版权和许可条款。

## COFECHA

Crossdating IDM 不包含、复制或分发 COFECHA 可执行程序。用户可从 [LTRR Dendrochronology Program Library](https://www.ltrr.arizona.edu/pub/dpl/) 独立获取 COFECHA，并在应用设置中选择本机 EXE；所选程序继续适用其权利人提供的条款，不属于 Crossdating IDM 的 GPL-3.0-only 授权范围。

设置页下载按钮使用 LTRR 网站公开提供的 favicon 作为来源标识，相关标识权利归原权利人所有。

COFECHA 由 Richard L. Holmes 创建。推荐引用：Holmes, R. L. (1983). Computer-assisted quality control in tree-ring dating and measurement. *Tree-Ring Bulletin*, 43, 69-78。

## TREES / CROSSDATE spline equations

实验性 JS 内部参考模型包含对 LTRR 公开 Cook-Holmes cubic smoothing spline 带状方程的 TypeScript 实现。原始 `spline.c` 由 Edward R. Cook 的 IMSL 例程发展而来，并由 Richard L. Holmes 整合；LTRR 的 TREES/CROSSDATE 源码按 GNU GPL version 2 or later 发布。来源与许可说明：

- https://www.ltrr.arizona.edu/pub/trees/doc/old_html/spline_8c-source.html
- https://www.ltrr.arizona.edu/pub/trees/index.html

## ITRDB 示例数据

根目录 `test-data` 中的 RWL 示例来自 NOAA National Centers for Environmental Information, World Data Service for Paleoclimatology 管理的 International Tree-Ring Data Bank (ITRDB)。数据继续适用 ITRDB 及原始调查者的归属和引用要求；来源链接、文件校验值和逐站点说明见 `test-data/README.md` 与 `test-data/SHA256SUMS.txt`。

## 软件依赖

工作区迁移包的 ZIP 编解码使用 `fflate` 0.8.2（MIT，作者 Arjun Barrett），包内许可证随 npm 依赖保留。扫描原图的流式SHA-256使用RustCrypto `sha2` 0.10.8（MIT OR Apache-2.0）。这些依赖不改变源数据的许可与归属。

`cofecha-js` 0.2.1 是独立的 COFECHA 6.06-compatible TypeScript 实现，按 `GPL-3.0-only` 发布；实验定年证据复用该包的报告预处理链。包内原有 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 保持有效，不包含或重新授权官方 COFECHA EXE。

JavaScript/TypeScript 和 Rust 依赖继续适用其各自许可证。依赖清单与锁定版本记录在 `package.json`、`package-lock.json`、`yarn.lock`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中。将依赖与本项目一起使用或分发时，仍须遵守对应依赖的许可及声明要求。
