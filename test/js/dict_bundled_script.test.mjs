// BUG-1651 行为测试（jsdom 真实 DOM）：词典自带 JS（OALDPEX 等 MDX 词典的行为脚本）
// 导入时落盘为 script.js，弹窗在词条 HTML 注入后受控执行。
//
// 根因：import 丢 .js + 词条 HTML 里的 <script> 经 innerHTML 注入不执行（且无宿主 shim）。
// 修复：import 保留脚本 → 宿主注入 window.__dictScriptTexts → dict-media.js 的
// executeDictScripts 动态 createElement('script') 执行（只执行脚本文件，词条内联
// <script> 文本仍不跑）；sound:// → image:// 属性重写（data-href/href）+ data-fushi-sound
// 标记；rewriteDictLinks 把 <script src> 重写为 dictmedia:// 供脚本推导资源基准路径。
//
// 为什么用行为测试而非源码扫描：核心不变式是「脚本真执行了、只执行一次、且内联脚本不跑」，
// 只有真在 DOM 上跑 executeDictScripts / rewriteSoundMediaIn 才能验到。
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

// test/js/ → 仓库根 → fushi/assets/popup/（当前分支真值）。
const DICT_MEDIA_URL = new URL(
  "../../fushi/assets/popup/dict-media.js",
  import.meta.url,
);
const dictMediaSrc = readFileSync(DICT_MEDIA_URL, "utf8");

// 浏览器扩展与 in-app 共享 popup.js（字节镜像），其中 renderContent 会调用这三个
// 函数——扩展版 dict-media.js 缺任何一个都会让扩展渲染 ReferenceError 崩掉。
const EXT_DICT_MEDIA_URL = new URL(
  "../../tools/browser-extension/vendor/dict-media.js",
  import.meta.url,
);
const extDictMediaSrc = readFileSync(EXT_DICT_MEDIA_URL, "utf8");

// 加载真 dict-media.js 到 jsdom window（runScripts dangerously 才能让动态注入的
// 脚本文本执行，这正是 executeDictScripts 走 createElement 而非 innerHTML 的原因）。
function makeDom() {
  return new JSDOM(
    "<!DOCTYPE html><html><head></head><body></body></html>",
    { runScripts: "dangerously" },
  );
}

test("executeDictScripts 执行词典落盘脚本，且同页只执行一次", () => {
  const dom = makeDom();
  const win = dom.window;
  win.__dictScriptTexts = {
    OALD: "window.__ran = (window.__ran || 0) + 1; window.oaldReady = true;",
  };
  win.eval(dictMediaSrc);
  const wrapper = win.document.createElement("div");
  win.executeDictScripts(wrapper, "OALD");
  assert.equal(win.oaldReady, true, "词典脚本应已执行");
  assert.equal(win.__ran, 1);
  // 同一页第二次渲染同词典条目不得重复执行（防事件重复绑定）。
  win.executeDictScripts(win.document.createElement("div"), "OALD");
  assert.equal(win.__ran, 1, "去重：不得重复执行");
});

test("executeDictScripts 无脚本/未知词典时是无操作", () => {
  const dom = makeDom();
  const win = dom.window;
  win.__dictScriptTexts = { Other: "window.__bad = true;" };
  win.eval(dictMediaSrc);
  win.executeDictScripts(win.document.createElement("div"), "Unknown");
  assert.equal(win.__bad, undefined, "未知词典不应执行任何脚本");
});

test("rewriteSoundMediaIn 把 sound:// 重写为 image:// 并打 data-fushi-sound 标记", () => {
  const dom = makeDom();
  const win = dom.window;
  win.eval(dictMediaSrc);
  const wrapper = win.document.createElement("div");
  wrapper.innerHTML =
    '<span data-href="sound://a/hassling.mp3">♪</span>' +
    '<a href="sound://b/c.mp3">b</a>' +
    '<a href="https://example.com/x.mp3">x</a>';
  win.rewriteSoundMediaIn(wrapper, "OALD");
  const span = wrapper.querySelector("span");
  assert.equal(
    span.getAttribute("data-href"),
    "image://?dictionary=OALD&path=a%2Fhassling.mp3",
  );
  assert.equal(span.getAttribute("data-fushi-sound"), "true");
  const a = wrapper.querySelector("a[href^=image]");
  assert.equal(
    a.getAttribute("href"),
    "image://?dictionary=OALD&path=b%2Fc.mp3",
  );
  assert.equal(a.getAttribute("data-fushi-sound"), "true");
  const ext = wrapper.querySelector("a[href^=https]");
  assert.equal(ext.getAttribute("data-fushi-sound"), null, "外链不得被改写");
});

test("rewriteDictLinks 把 <script src> 重写为 dictmedia://", () => {
  const dom = makeDom();
  const win = dom.window;
  win.eval(dictMediaSrc);
  const html = '<script src="oaldpex.js"></script><img src="pic/x.png">';
  const out = win.rewriteDictLinks(html, "OALD");
  assert.ok(out.includes('src="dictmedia://oaldpex.js?dictionary=OALD"'));
  assert.ok(out.includes("image://?dictionary=OALD&path=pic%2Fx.png"));
});

test("安全边界：词条 HTML 里的内联 <script> 经 innerHTML 不执行", () => {
  const dom = makeDom();
  const win = dom.window;
  win.eval(dictMediaSrc);
  const wrapper = win.document.createElement("div");
  wrapper.innerHTML = "<script>window.__inlineRan = true;</script>";
  assert.equal(
    win.__inlineRan,
    undefined,
    "innerHTML 注入的内联脚本必须保持惰性（executeDictScripts 只执行落盘脚本）",
  );
});

test("扩展版 dict-media.js 携带共享 popup.js 依赖的三个函数", () => {
  for (const fn of [
    "function rewriteSoundMediaPath",
    "function rewriteSoundMediaIn",
    "function executeDictScripts",
  ]) {
    assert.ok(
      extDictMediaSrc.includes(fn),
      `扩展版 dict-media.js 缺 ${fn}（共享 popup.js 的 renderContent 会调用）`,
    );
  }
});

test("审查 L3/L4: script 内联体不泄漏、scheme 源保留（rewriteDictLinks）", () => {
  const dom = makeDom();
  const win = dom.window;
  win.eval(dictMediaSrc);
  // L3: 带内联体的 <script src> 整块重写，内联文本不得泄漏进渲染 DOM。
  const noInline = win.rewriteDictLinks(
    '<script src="oaldpex.js">window.__inlineLeak = 1;</script>',
    "OALD",
  );
  assert.ok(!noInline.includes("__inlineLeak"), "内联体必须被丢弃");
  assert.ok(noInline.includes('src="dictmedia://oaldpex.js?dictionary=OALD"'));
  // L4: scheme-bearing src 保持原样，不改成无效 dictmedia://。
  const ext = win.rewriteDictLinks('<script src="https://cdn/x.js"></script>', "OALD");
  assert.ok(ext.includes('src="https://cdn/x.js"'), "外链 script src 不得改写");
  assert.ok(!ext.includes("dictmedia://"), "外链不得被 dictmedia:// 化");
});

test("审查 L5: SOUND:// 大写变体也被重写（大小写不敏感选择器）", () => {
  const dom = makeDom();
  const win = dom.window;
  win.eval(dictMediaSrc);
  const wrapper = win.document.createElement("div");
  wrapper.innerHTML = '<a href="SOUND://a/b.mp3">b</a>';
  win.rewriteSoundMediaIn(wrapper, "OALD");
  const a = wrapper.querySelector("a");
  assert.equal(
    a.getAttribute("href"),
    "image://?dictionary=OALD&path=a%2Fb.mp3",
    "SOUND:// 大写必须同样被重写为 image://",
  );
  assert.equal(a.getAttribute("data-fushi-sound"), "true");
});

test("审查 M2: data-fushi-sound 点击优先用被重写的 data-href，跳过 # 占位 href", () => {
  const dom = makeDom();
  const win = dom.window;
  // 真 popup.js 里 handleGlossaryAnchorClick 依赖的宿主全局：data-fushi-sound
  // 分支只用 playWordAudio；其余 stub 掉以防走到其它分支。
  win.playWordAudio = (u) => { win.__played = win.__played || []; win.__played.push(u); return Promise.resolve(true); };
  win.openExternalLink = () => {};
  win.markGlobalLookupExtHit = () => {};
  win.flutter_inappwebview = { callHandler: () => {} };
  const POPUP_URL = new URL("../../fushi/assets/popup/popup.js", import.meta.url);
  const popupSrc = readFileSync(POPUP_URL, "utf8");
  const m = popupSrc.match(/function handleGlossaryAnchorClick\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, "未能从 popup.js 提取 handleGlossaryAnchorClick");
  win.eval(m[0]);

  const a = win.document.createElement("a");
  a.setAttribute("href", "#");
  a.setAttribute("data-href", "image://?dictionary=OALD&path=b.mp3");
  a.setAttribute("data-fushi-sound", "true");
  win.document.body.appendChild(a);
  const ev = new win.Event("click");
  win.handleGlossaryAnchorClick(ev, a);
  assert.deepEqual(
    win.__played,
    ["image://?dictionary=OALD&path=b.mp3"],
    "href=# 占位必须被跳过，播放 data-href 里的可播 URL",
  );
});
