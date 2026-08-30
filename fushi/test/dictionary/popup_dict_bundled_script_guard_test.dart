import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// BUG-1651 源码守卫：词典自带 JS（OALDPEX 等 MDX 行为脚本）受控执行的三个不变式。
///
/// 背景：import 侧把同 stem `.js` 落盘成 script.js，宿主注入 `window.__dictScriptTexts`，
/// 弹窗在词条裸 HTML innerHTML 注入后由 executeDictScripts 动态执行。安全边界 = 入库脚本
/// 只来自「导入时落盘、宿主注入的脚本文本」；词条 HTML 里的内联 <script> 经 innerHTML
/// 注入本身保持惰性，但 executeDictScripts 会在**该词典有入库脚本时**把词条自带的内联
/// 脚本（如 OALDPEX 的 `<script>window.__oaldpexReady=true;</script>` 初始化 flag 设置器）
/// 先执行掉——两者同属词典包信任域（欧路/DictTango 宿主本来就执行词条全部脚本），
/// 无入库脚本的词典内联脚本仍完全不执行。
///
/// popup.js 有三份镜像（in-app 弹窗 + 两份浏览器扩展 vendor 副本；byte-parity 由
/// browser_extension_popup_parity_guard 另锁），本守卫在三份上各自断言语义约束，
/// 防止任何一份单独回退。flutter test cwd 是 hibiki 包根。
void main() {
  const Map<String, String> jsMirrors = <String, String>{
    'in-app popup': 'assets/popup/popup.js',
    'extension vendor (assets)': 'assets/browser_extension/vendor/popup.js',
    'extension vendor (tools)': '../tools/browser-extension/vendor/popup.js',
  };

  jsMirrors.forEach((String name, String relPath) {
    group('[$name] 裸 HTML 路径注入后接宿主 shim (BUG-1651)', () {
      late final String js;
      setUpAll(() => js = File(relPath).readAsStringSync());

      test('innerHTML 注入后必须调用 rewriteSoundMediaIn + executeDictScripts', () {
        final int inner = js.indexOf(
          "wrapper.innerHTML = rewriteDictLinks(content, dictName)",
        );
        expect(inner, greaterThan(-1),
            reason: '裸 HTML 路径的 innerHTML 注入点必须存在');
        final int sound = js.indexOf(
          "rewriteSoundMediaIn(wrapper, dictName)",
        );
        final int exec = js.indexOf("executeDictScripts(wrapper, dictName)");
        expect(sound, greaterThan(inner),
            reason: 'sound:// 重写必须先于/紧随 innerHTML 注入');
        expect(exec, greaterThan(inner),
            reason: '词典脚本必须在 HTML 注入后执行');
      });

      test('handleGlossaryAnchorClick 必须先拦截 data-fushi-sound 再放行外链', () {
        final int fs = js.indexOf(
          "if (anchor.hasAttribute('data-fushi-sound'))",
        );
        expect(fs, greaterThan(-1),
            reason: '被重写的发音锚点必须走统一播放分支');
        final int http = js.indexOf("openExternalLink(href)");
        expect(fs, lessThan(http),
            reason: 'data-fushi-sound 分支必须在 http 外链分支之前——扩展侧重写后的'
                '发音 URL 是 http 端点，落后者会 openExternalLink 开新标签');
      });
    });
  });

  group('definition.js 与弹窗同款 shim', () {
    late final String js;
    setUpAll(
        () => js = File('assets/popup/definition.js').readAsStringSync());

    test('裸 HTML 注入后调用 rewriteSoundMediaIn + executeDictScripts', () {
      expect(
        js.contains(
            "wrapper.innerHTML = rewriteDictLinks(contentJson, dictName)"),
        isTrue,
        reason: 'definition.js 裸 HTML 注入点必须存在',
      );
      expect(
        js.contains('rewriteSoundMediaIn(wrapper, dictName)'),
        isTrue,
        reason: '词典主页释义页必须做 sound:// 重写',
      );
      expect(
        js.contains('executeDictScripts(wrapper, dictName)'),
        isTrue,
        reason: '词典主页释义页必须执行词典落盘脚本',
      );
    });
  });

  group('dict-media.js 安全边界与重写', () {
    late final String js;
    setUpAll(
        () => js = File('assets/popup/dict-media.js').readAsStringSync());

    test('executeDictScripts 只从 window.__dictScriptTexts 取脚本文本', () {
      expect(
        js.contains('window.__dictScriptTexts'),
        isTrue,
        reason: '入库脚本文本只能来自宿主注入的 __dictScriptTexts（导入落盘物）',
      );
      expect(
        js.contains("window.__dictScriptTexts[dictName]"),
        isTrue,
        reason: '入库脚本按词典名取值',
      );
    });

    test('有入库脚本的词典：词条内联脚本在入库脚本前执行（flag 设置器）', () {
      // 真机实证：OALDPEX 词条自带 <script>window.__oaldpexReady=true;</script>
      // 作初始化 flag，oaldpex.js 顶层 if(!window.__oaldpexReady) throw。innerHTML
      // 惰性让内联脚本不执行 → flag 永未设 → 脚本拒绝初始化。executeDictScripts
      // 必须在注入入库脚本前执行词条内联脚本（与入库脚本同词典信任域）。
      expect(
        js.contains("wrapper.querySelectorAll('script:not([src])')"),
        isTrue,
        reason: '必须扫描词条内联 <script>（无 src）并在入库脚本前执行',
      );
    });

    test('执行用 document.createElement(\'script\') + textContent（禁 innerHTML）', () {
      final int create = js.indexOf("document.createElement('script')");
      expect(create, greaterThan(-1),
          reason: '动态插入才执行（innerHTML 注入的 script 按规范惰性）');
      expect(js.contains('script.textContent = scriptText'), isTrue,
          reason: '入库脚本必须用 textContent 承载（用 innerHTML 会把 <script> 文本'
              '当 HTML 解析，破坏安全边界）');
    });

    test('同页去重：__fushiDictScriptsExecuted 每词典只执行一次', () {
      expect(js.contains('window.__fushiDictScriptsExecuted'), isTrue,
          reason: '事件绑定防重复注入');
      expect(js.contains('__fushiDictScriptsExecuted[dictName]'), isTrue,
          reason: '去重键是词典名');
    });

    test('rewriteSoundMediaIn 重写 data-href/href 并打 data-fushi-sound 标记', () {
      expect(
        js.contains('[data-href^="sound:"], a[href^="sound:"]'),
        isTrue,
        reason: 'OALDPEX 读 data-href、部分词典读 href，两者都要重写',
      );
      expect(js.contains("el.setAttribute('data-fushi-sound', 'true')"),
          isTrue,
          reason: '点击拦截靠 data-fushi-sound 标记识别（app 内 image:// 与扩展 '
              'http 端点两种 URL 形态）');
    });

    test('rewriteDictLinks 把 <script src> 重写为 dictmedia://', () {
      expect(
        js.contains(
            r'dictmedia://${encodeURIComponent(normalized)}?dictionary='),
        isTrue,
        reason: '脚本靠 $(script[src*=]) 推导资源基准路径，必须重写 src',
      );
    });
  });

  group('宿主注入 window.__dictScriptTexts', () {
    test('popup_settings_injection 注入脚本 map', () {
      final String src = File(
        'lib/src/pages/implementations/popup_settings_injection.dart',
      ).readAsStringSync();
      expect(src.contains('window.__dictScriptTexts = \$scriptsJson;'), isTrue,
          reason: '静态设置段必须把 {dictName: scriptText} 注入成 __dictScriptTexts');
    });
  });

  group('vendored jQuery（词典脚本宿主依赖）', () {
    test('必须是含 ajax 的完整版（OALDPEX 顶层用 $.ajaxSetup / $.getScript）', () {
      final String jq =
          File('assets/popup/vendor/jquery.min.js').readAsStringSync();
      expect(jq.contains('ajaxSetup'), isTrue,
          reason: 'oaldpex.js 顶层调用 $.ajaxSetup({cache:true}) 与 $.getScript——'
              'jQuery slim 不含 ajax 模块，缺则词典脚本顶层即 TypeError，整本死掉。'
              '必须 vendor 完整版（jquery-x.y.z.min.js，非 slim）');
    });

    test('popup.html / definition.html 在 popup.js / definition.js 前加载 jQuery', () {
      final String popupHtml =
          File('assets/popup/popup.html').readAsStringSync();
      final int jqAt = popupHtml.indexOf('vendor/jquery.min.js');
      final int popupJsAt = popupHtml.indexOf('src="popup.js"');
      expect(jqAt, greaterThan(-1), reason: 'popup.html 必须加载 jQuery');
      expect(jqAt, lessThan(popupJsAt),
          reason: 'jQuery 必须先于 popup.js 加载，词典脚本执行时 $ 已就绪');

      final String defHtml =
          File('assets/popup/definition.html').readAsStringSync();
      expect(defHtml.indexOf('vendor/jquery.min.js'), greaterThan(-1),
          reason: 'definition.html 必须加载 jQuery');
      expect(
          defHtml.indexOf('vendor/jquery.min.js') <
              defHtml.indexOf('src="definition.js"'),
          isTrue,
          reason: 'jQuery 必须先于 definition.js 加载');
    });
  });
}
