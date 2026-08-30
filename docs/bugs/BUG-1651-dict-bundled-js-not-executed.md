## BUG-1651 · 词典自带 JS 从不执行（OALDPEX Noun/Verb 标签、发音失效）
- **报告**：2026-08-30（用户：导入 oaldpex 词典后词条 HTML/CSS 渲染正常，但 Noun/Verb/All 标签点击无反应、发音图标不出声、其余依赖脚本的交互同理失效）
- **真实性**：✅ 真 bug，两层断链 + 一层宿主缺项：
  1. **导入侧丢脚本** — `import_mdx_from_zip`（`native/fushidicts/fushidicts_src/importer.cpp:1119-1130`）只提取同 stem 的 `.mdd`/`.css`，`.js` 被直接丢弃；`import_mdx` 只 `read_sibling_css` 内联 styles.css（L1012-1023、L1061），从不落盘脚本。
  2. **渲染侧不执行** — `popup.js` L3232 裸 HTML 路径 `wrapper.innerHTML = rewriteDictLinks(content, dictName)` 经 innerHTML 注入的 `<script>` 按 HTML 规范一律不执行（标签留在 DOM 但不跑）；`definition.js` L516 同构。`rewriteDictLinks`（`dict-media.js` L14-25）只重写 `<link>`/`<img>`，不重写 `<script src>`。
  3. **宿主缺 shim** — oaldpex.js 依赖宿主注入 jQuery（通篇 `$(...)`，文件自身不含）与 `sound://` 发音约定（`globalAudio.src = $audio.data("href")`），弹窗页面两者皆无；`dictmedia` scheme handler 又把 content-type 硬编码 `text/css`（`dictionary_webview_media.dart` L166-170），即便脚本走 scheme 加载也会因 `application/octet-stream`/`text/css` 被拒。
- **[x] ① 已修复** —（提交哈希待填）
  - 导入侧：`importer.cpp` 新增 `read_sibling_js` + `import_mdx_from_zip` 提取同 stem `.js`（L1145-1149）+ `write_simple_dict` 落盘 `script.js`；
  - 查询侧：`query.hpp/query.cpp` 新增 `DictionaryScript` + `get_scripts()`（读取 `script.js`）；`fushidicts_ffi.cpp` 新增 `fushidicts_get_scripts/free_scripts`；Dart `fushidicts.dart` 新增 `dictionaryScripts` 缓存 + `getScripts()`；
  - 渲染侧：`dict-media.js` 新增 `executeDictScripts`（动态 createElement 执行，去重键=脚本文本，脚本变更可重跑）/`rewriteSoundMediaIn`（sound:// → image:// + `data-fushi-sound` 标记）/`rewriteSoundMediaPath`，`rewriteDictLinks` 增 `<script src>` → `dictmedia://`；`popup.js`/`definition.js` 裸 HTML 注入后接两个 shim；`handleGlossaryAnchorClick` 先拦截 `data-fushi-sound`；
  - 宿主 shim：vendor 完整版 jQuery 3.7.1（**非 slim**——oaldpex.js 顶层 `$.ajaxSetup`/`$.getScript` 需要 ajax 模块）+ `popup.html`/`definition.html` 先加载；`dictionary_webview_media.dart` dictmedia handler Content-Type 按扩展名；
  - 注入：`popup_settings_injection.dart` + `dictionary_popup_webview.dart` 把 `{dictName: scriptText}` 注入 `window.__dictScriptTexts`（memo 身份比较，换词典集失效）。
- **[x] ② 已加自动化测试**
  - `test/js/dict_bundled_script.test.mjs`（6 用例：执行/去重/无操作/sound 重写/script src 重写/内联惰性/扩展函数存在，jsdom 真实 DOM，node 已跑绿）；
  - `native/fushidicts/tests/mdx_sibling_js_import_test.cpp`（zip + 散装目录导入 → script.js 落盘 + `get_scripts` 回读；已注册 CMakeLists，**本机无编译器未编译**）；
  - `fushi/test/dictionary/popup_dict_bundled_script_guard_test.dart`（源码扫描守卫，含完整版 jQuery 断言）。
- **实测（dump 用户 oaldpex.mdx 真实词条）**：R3 确认——词条 HTML 带 `<script src="oaldpex.js">` + `.sound-link-placeholder`（`sound://placeholder.mp3`）模板；oaldpex.js 顶层 `$.ajaxSetup`/`$.getScript` ⇒ **必须完整版 jQuery（非 slim）**；词条还引用 oaldpex_img/word/sen/tts.js + scripts/oaldpex-jquery.js（目录内不存在，oaldpex.js 不依赖它们，保持惰性即可）。平台检测走 generic 分支（UA 非 eudic/goldendict），`oaldpexMain` 无条件绑定。
- **备注**：① 本机缺 flutter/dart/编译器，**未跑 flutter analyze / flutter test / native 编译**；② 设备复测（Windows 导入 oaldpex.zip → 查词标签切换、发音出声、中文显隐）与 `.codex-test/` 证据待补；③ `dart run tool/bug.dart reindex` 未跑（无 dart），索引表待补；④ 渲染层已知限制：localStorage（file:// opaque origin）下词典配置每次回默认。
