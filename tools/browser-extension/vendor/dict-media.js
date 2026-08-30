function normalizeDictMediaPath(raw) {
    return `${raw}`.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

function rewriteDictionaryMediaPath(rawPath, dictName) {
    const trimmed = `${rawPath}`.trim();
    if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) {
        return null;
    }
    const normalized = normalizeDictMediaPath(rawPath);
    // TODO-1215: a real browser has no image:// scheme handler, so gaiji /
    // pitch-accent SVG images would break (ERR_UNKNOWN_URL_SCHEME). In the
    // extension, bridge-shim.js pre-fills window.__fushiDictMedia with the
    // running server's base URL + token (from background cfg()); when present,
    // rewrite to the server's http media endpoint. In-app that global is unset
    // -> the original image:// path is kept (the app WebView resolves it).
    const media = (typeof window !== 'undefined') ? window.__fushiDictMedia : null;
    if (media && media.base && media.token) {
        return `${media.base}/api/media/dictionary` +
            `?dictionary=${encodeURIComponent(dictName)}` +
            `&path=${encodeURIComponent(normalized)}` +
            `&token=${encodeURIComponent(media.token)}`;
    }
    return `image://?dictionary=${encodeURIComponent(dictName)}&path=${encodeURIComponent(normalized)}`;
}

function rewriteDictLinks(html, dictName) {
    return html.replace(/<link[^>]*href=['"]([^'"]+)['"][^>]*>/gi, (match, href) => {
        const normalized = normalizeDictMediaPath(href);
        return `<link rel="stylesheet" href="dictmedia://${encodeURIComponent(normalized)}?dictionary=${encodeURIComponent(dictName)}">`;
    }).replace(/<img\b[^>]*\bsrc=(['"])([^'"]+)\1[^>]*>/gi, (match, quote, src) => {
        const rewritten = rewriteDictionaryMediaPath(src, dictName);
        if (rewritten === null) {
            return match;
        }
        // TODO-1215 安全：扩展环境（window.__fushiDictMedia 已设）下，这段 HTML 会经 innerHTML
        // 直落宿主页 DOM——绝不能把带原始 sync token 的媒体 URL 写进 <img src>（哪怕只存在一帧也会被
        // MutationObserver 截获）。改成无 token 的占位 data-* 属性（去掉 src），popup.js 在 innerHTML
        // 之后据此 fetch→blob 补 src（token 只在 fetch 调用里）。app 内（该全局未设）保持原样。
        const media = (typeof window !== 'undefined') ? window.__fushiDictMedia : null;
        if (media && media.base && media.token) {
            return match.replace(/src=(['"])([^'"]+)\1/i,
                `data-fushi-media-dict="${encodeURIComponent(dictName)}" data-fushi-media-path="${encodeURIComponent(src)}"`);
        }
        return match.replace(/src=(['"])([^'"]+)\1/i, `src=${quote}${rewritten}${quote}`);
    });
}

// BUG-1651: 与 in-app dict-media.js 同款宿主 shim（popup.js 三镜像共享会调用）。
// 扩展环境不注入 __dictScriptTexts（不执行词典脚本），这些函数是无操作兜底，但
// rewriteSoundMediaIn 的 data-href/href 重写走本文件的 rewriteDictionaryMediaPath
// （扩展 → 带 token 的 http 媒体端点），点击经共享 popup.js 的 data-fushi-sound
// 分支播放，不 openExternalLink。
function rewriteSoundMediaPath(rawPath, dictName) {
    const soundPath = `${rawPath}`.replace(/^sound:\/*/i, '').trim();
    if (!soundPath) return null;
    return rewriteDictionaryMediaPath(soundPath, dictName);
}

function rewriteSoundMediaIn(root, dictName) {
    if (!root || !dictName) return;
    // H1(审查) / TODO-1215 同威胁模型：扩展环境（window.__fushiDictMedia 已设）
    // 下 rewriteDictionaryMediaPath 返回带 sync token 的 http URL，绝不能写进宿主页
    // DOM 的 data-href/href（shadow root 是 open 模式、content script 跑 <all_urls>，
    // 宿主页脚本可读）。扩展不执行词典脚本，programmatic data-href 读取本就不存在，
    // 故直接不重写——保留 sound://，点击由共享 popup.js handleGlossaryAnchorClick
    // 的 sound: 分支在点击时才拼 token URL（BUG-1261，token 只活在一次调用里）。
    const media = (typeof window !== 'undefined') ? window.__fushiDictMedia : null;
    if (media && media.base && media.token) return;
    root.querySelectorAll('[data-href^="sound:" i], a[href^="sound:" i]').forEach((el) => {
        let rewritten = false;
        if (el.hasAttribute('data-href')) {
            const url = rewriteSoundMediaPath(el.getAttribute('data-href'), dictName);
            if (url) {
                el.setAttribute('data-href', url);
                rewritten = true;
            }
        }
        if (el.tagName === 'A' && el.hasAttribute('href')) {
            const url = rewriteSoundMediaPath(el.getAttribute('href'), dictName);
            if (url) {
                el.setAttribute('href', url);
                rewritten = true;
            }
        }
        if (rewritten) {
            el.setAttribute('data-fushi-sound', 'true');
        }
    });
}

function executeDictScripts(wrapper, dictName) {
    if (!dictName) return;
    const scriptText = window.__dictScriptTexts && window.__dictScriptTexts[dictName];
    if (!scriptText) return;
    // BUG-1651 真机实证：OALDPEX 词条内联 <script>window.__oaldpexReady=true;</script>
    // 是初始化 flag 设置器（oaldpex.js 顶层 if(!window.__oaldpexReady) throw），
    // innerHTML 惰性不执行它 → oaldpex.js 拒绝初始化。与入库脚本同词典信任域，
    // 注入入库脚本前先执行词条自带内联脚本。扩展不注入 __dictScriptTexts，此函数
    // 在扩展为无操作，内联执行不会触发。
    if (wrapper) {
        const inlineScripts = wrapper.querySelectorAll('script:not([src])');
        for (let i = 0; i < inlineScripts.length; i++) {
            const s = inlineScripts[i];
            if (!s.textContent) continue;
            const script = document.createElement('script');
            script.textContent = s.textContent;
            try {
                (document.head || document.documentElement).appendChild(script);
            } catch (_) { /* 单个内联脚本失败不阻断后续与入库脚本 */ }
        }
    }
    window.__fushiDictScriptsExecuted = window.__fushiDictScriptsExecuted || {};
    if (window.__fushiDictScriptsExecuted[dictName] === scriptText) return;
    window.__fushiDictScriptsExecuted[dictName] = scriptText;
    const script = document.createElement('script');
    script.textContent = scriptText;
    (document.head || document.documentElement).appendChild(script);
}

function constructDictCss(css, dictName, scopePrefix) {
    if (!css) return '';
    const prefix = scopePrefix || `[data-dictionary="${dictName}"]`;
    const parts = [];
    let i = 0;
    while (i < css.length) {
        while (i < css.length && /\s/.test(css[i])) {
            parts.push(css[i++]);
        }
        if (css.slice(i, i + 2) === '/*') {
            const end = css.indexOf('*/', i + 2);
            if (end === -1) break;
            parts.push(css.slice(i, end + 2));
            i = end + 2;
            continue;
        }
        const bracePos = css.indexOf('{', i);
        const semiPos = css.indexOf(';', i);
        // Statement at-rules (`@import`, `@charset`, `@namespace`, `@layer a, b;`)
        // terminate with `;` before any block — pass them through verbatim; they
        // carry no selector that could (or should) be scoped.
        if (semiPos !== -1 && (bracePos === -1 || semiPos < bracePos)) {
            const statement = css.slice(i, semiPos + 1);
            if (statement.trimStart().startsWith('@')) {
                parts.push(statement);
                i = semiPos + 1;
                continue;
            }
        }
        if (bracePos === -1) break;
        const selectorPart = css.slice(i, bracePos);
        const selectorPrelude = selectorPart.trim();
        // Block at-rules need their prelude preserved unscoped. Two families:
        //  - Conditional groups (`@media`/`@supports`/`@container`/`@layer`/`@scope`)
        //    wrap nested STYLE RULES, so their inner rules must still be scoped.
        //  - Other at-rules (`@font-face`/`@keyframes`/`@page`/`@font-feature-values`/...)
        //    contain declarations or keyframe-selectors that must NOT be prefixed.
        const atRuleMatch = selectorPrelude.match(/^@([a-z-]+)/i);
        if (atRuleMatch) {
            const atName = atRuleMatch[1].toLowerCase();
            const isConditionalGroup =
                atName === 'media' ||
                atName === 'supports' ||
                atName === 'container' ||
                atName === 'layer' ||
                atName === 'scope';
            // Capture the at-rule's own block so we can decide per-family.
            i = bracePos + 1;
            let atDepth = 1;
            const atBlockStart = i;
            while (i < css.length && atDepth > 0) {
                if (css[i] === '{') atDepth++;
                else if (css[i] === '}') atDepth--;
                i++;
            }
            const atBlockContent = css.slice(atBlockStart, i - 1);
            parts.push(selectorPart, ' {');
            if (isConditionalGroup) {
                // Recurse so inner style rules get the prefix; the prelude stays raw.
                parts.push(constructDictCss(atBlockContent, dictName, scopePrefix));
            } else {
                // @font-face / @keyframes / @page: body is declarations or
                // keyframe selectors — emit verbatim, never prefixed.
                parts.push(atBlockContent);
            }
            parts.push('}');
            continue;
        }
        const selectors = selectorPart.split(',').map(s => {
            const trimmed = s.trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('&')) return s;
            return `${prefix} ${trimmed}`;
        });
        parts.push(selectors.join(', '), ' {');
        i = bracePos + 1;
        let depth = 1;
        let blockStart = i;
        while (i < css.length && depth > 0) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
            i++;
        }
        const blockContent = css.slice(blockStart, i - 1);
        if (blockContent.includes('{')) {
            let pos = 0;
            let properties = '';
            let nestedRules = '';
            while (pos < blockContent.length) {
                while (pos < blockContent.length && /\s/.test(blockContent[pos])) pos++;
                if (pos >= blockContent.length) break;
                let nextSemi = blockContent.indexOf(';', pos);
                let nextBrace = blockContent.indexOf('{', pos);
                if (nextBrace !== -1 && (nextSemi === -1 || nextBrace < nextSemi)) {
                    let nestedDepth = 1;
                    let nestedEnd = nextBrace + 1;
                    while (nestedEnd < blockContent.length && nestedDepth > 0) {
                        if (blockContent[nestedEnd] === '{') nestedDepth++;
                        else if (blockContent[nestedEnd] === '}') nestedDepth--;
                        nestedEnd++;
                    }
                    nestedRules += blockContent.slice(pos, nestedEnd);
                    pos = nestedEnd;
                } else if (nextSemi !== -1) {
                    properties += blockContent.slice(pos, nextSemi + 1);
                    pos = nextSemi + 1;
                } else {
                    properties += blockContent.slice(pos);
                    break;
                }
            }
            parts.push(properties);
            if (nestedRules) parts.push(constructDictCss(nestedRules, dictName, scopePrefix));
        } else {
            parts.push(blockContent);
        }
        parts.push('}');
    }
    return parts.join('');
}
