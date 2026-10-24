// ==UserScript==
// @name         链接净化 · 直达
// @namespace    local.xbrowser.linkcleaner
// @version      1.0.0
// @description  去掉搜索结果/分享链接的中转跳转，点击直达目标地址；已知中转页（百度 link）自动秒跳，不等倒计时。零界面无感运行。
// @author       me
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @updateURL    https://orange123eee.github.io/xb-video-kit/link-cleaner.user.js
// @downloadURL  https://orange123eee.github.io/xb-video-kit/link-cleaner.user.js
// ==/UserScript==

// 设计思路借鉴 ClearURLs / "AC-baidu 重定向"：显式站点规则为主、
// 通用规则保守放行（路径/子域得长得像中转端点才动），宁可漏不可误伤。

(function () {
  'use strict';

  if (window.__XB_LINK_CLEANER__) return;
  window.__XB_LINK_CLEANER__ = true;

  /* ------------------------------------------------------------------ *
   *  规则表（以后加站点改这里）
   * ------------------------------------------------------------------ */

  // 这些参数名的值是真实目标地址（http(s) 才认；相对路径不认，避免误伤站内路由）
  var PARAM_KEYS = ['url', 'target', 'link', 'redirect', 'redirect_url', 'redirecturl',
    'to', 'u', 'jump', 'goto', 'fwd', 'uurl'];

  // 只对这些参数名尝试 base64 解码（值必须是 base64 且解出来是 http(s)）
  var B64_KEYS = ['u', 'url', 'link', 'target'];

  // 显式站点规则：host + 可选路径匹配 → 指定参数名（明确的中转端点，放心改写）
  var HOST_RULES = [
    { re: /(^|\.)douban\.com$/i,  path: /^\/link2?\//i, keys: ['url'], explicit: true },      // www.douban.com/link2/?url=
    { re: /(^|\.)zhihu\.com$/i,   path: /^\/?$/,        keys: ['target'], explicit: true },   // link.zhihu.com/?target=
    { re: /(^|\.)juejin\.cn$/i,   path: /^\/?$/,        keys: ['target'], explicit: true },   // link.juejin.cn/?target=
    { re: /(^|\.)csdn\.net$/i,    path: /^\/?$/,        keys: ['target'], explicit: true },   // link.csdn.net/?target=
    { re: /(^|\.)oschina\.net$/i, path: /^\/redirect\//i, keys: ['url'], explicit: true },
    { re: /(^|\.)jianshu\.com$/i, path: /^\/go\//i,    keys: ['url'], explicit: true }
  ];

  // 通用规则：任意站点，但要求"长得像中转端点"——
  // 路径是 /link /redirect /jump /go /out /goto，或子域是 link./jump./go./out./redirect.
  var GENERIC_PATH = /^\/(link|redirect|jump|go|out|goto|adurl|d)(?:[\/.?]|$)/i;
  var GENERIC_HOST = /^(link|jump|go|out|redirect|goto|href|url|d)\./i;

  // 已知"中转页"（点开后是一张带倒计时/广告的网页而不是 302）：
  // 在页面里找到真实目标就立即跳过去
  var INTERSTITIALS = [
    { re: /(^|\.)baidu\.com$/i, path: /^\/link(\.html)?$/i }   // 百度搜索结果中转页
  ];

  var IS_TOP = true;
  try { IS_TOP = (window.top === window.self); } catch (e) { IS_TOP = false; }

  /* ------------------------------------------------------------------ *
   *  目标提取
   * ------------------------------------------------------------------ */

  function ruleFor(U) {
    for (var i = 0; i < HOST_RULES.length; i++) {
      var r = HOST_RULES[i];
      if (r.re.test(U.hostname) && (!r.path || r.path.test(U.pathname))) return r;
    }
    if (GENERIC_HOST.test(U.hostname) || GENERIC_PATH.test(U.pathname)) {
      return { keys: PARAM_KEYS, generic: true };
    }
    return null;
  }

  // 值 → http(s) 地址；支持一次/二次 URL 编码；不是地址返回 null
  function tryDecode(v) {
    if (!v || v.length < 8) return null;
    if (/^https?:\/\//i.test(v)) return v;
    var d1;
    try { d1 = decodeURIComponent(v); } catch (e) { d1 = null; }
    if (d1 && /^https?:\/\//i.test(d1)) return d1;
    return null;
  }

  // base64 值 → http(s) 地址；仅白名单参数名使用
  function tryB64(v) {
    if (!v || v.length < 20 || !/^[A-Za-z0-9+/\-_]={0,2}$/.test(v)) return null;
    try {
      var b = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
      if (/^https?:\/\/[\x21-\x7e]+$/i.test(b)) return b;
    } catch (e) {}
    return null;
  }

  function oneHop(href) {
    var U;
    try { U = new URL(href, location.href); } catch (e) { return null; }
    if (!/^https?:$/.test(U.protocol)) return null;
    var rule = ruleFor(U);
    if (!rule) return null;

    var keys = rule.keys || PARAM_KEYS;
    var raw = null;
    for (var i = 0; i < keys.length && !raw; i++) {
      var v0 = U.searchParams.get(keys[i]);
      if (!v0) continue;
      raw = tryDecode(v0);
      if (!raw && B64_KEYS.indexOf(keys[i]) >= 0) raw = tryB64(v0);
    }
    if (!raw) return null;

    var V;
    try { V = new URL(raw); } catch (e) { return null; }
    if (!/^https?:$/.test(V.protocol)) return null;
    // 同域目标多半是站内路由（?url=/view 之类），不动；显式规则放行
    if (V.host === U.host && !rule.explicit) return null;
    return V.href;
  }

  // 链式中转最多解 3 层（a → redirect?url=b → b?url=c → c）
  function extractTarget(href) {
    var cur = href, hops = 0;
    while (hops++ < 3) {
      var next = oneHop(cur);
      if (!next) break;
      cur = next;
    }
    return (cur !== href && /^https?:\/\//i.test(cur)) ? cur : null;
  }

  /* ------------------------------------------------------------------ *
   *  改写 + 增量监听
   * ------------------------------------------------------------------ */

  var cleaned = 0;
  var toastShown = false;

  function cleanRoot(root) {
    if (!root || !root.querySelectorAll) return;
    var as = root.querySelectorAll('a[href]');
    for (var i = 0; i < as.length; i++) {
      var a = as[i];
      if (a.__xlc) continue;
      a.__xlc = 1;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) continue;
      var t = null;
      try { t = extractTarget(href); } catch (e) {}
      if (t) {
        try { a.setAttribute('href', t); cleaned++; } catch (e) {}
      }
    }
    if (cleaned > 0) setTimeout(maybeToast, 700);
  }

  var moTimer = 0;
  function scheduleClean() {
    if (moTimer) return;
    moTimer = setTimeout(function () {
      moTimer = 0;
      cleanRoot(document.body);
    }, 300);
  }

  // 每页最多提示一次，1.5 秒消失，不打扰
  function maybeToast() {
    if (toastShown || !cleaned || !document.body) return;
    toastShown = true;
    var d = document.createElement('div');
    d.textContent = '已清理 ' + cleaned + ' 个跳转链接';
    d.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%) translateY(8px);' +
      'background:rgba(17,19,23,.9);color:#e9ebef;padding:7px 12px;border-radius:9px;' +
      'font:12px/1.4 -apple-system,"PingFang SC","Noto Sans SC",sans-serif;z-index:2147483647;' +
      'pointer-events:none;border:1px solid rgba(255,255,255,.08);opacity:0;transition:opacity .2s,transform .2s';
    document.body.appendChild(d);
    try {
      requestAnimationFrame(function () {
        d.style.opacity = '1';
        d.style.transform = 'translateX(-50%) translateY(0)';
      });
    } catch (e) { d.style.opacity = '1'; }
    setTimeout(function () {
      d.style.opacity = '0';
      setTimeout(function () { try { d.remove(); } catch (e) {} }, 250);
    }, 1600);
  }

  /* ------------------------------------------------------------------ *
   *  中转页秒跳（当前页就是中转页时）
   * ------------------------------------------------------------------ */

  function interstitialJump() {
    var hit = null;
    for (var i = 0; i < INTERSTITIALS.length && !hit; i++) {
      var r = INTERSTITIALS[i];
      if (r.re.test(location.hostname) && r.path.test(location.pathname)) hit = r;
    }
    if (!hit) return;

    var html = '';
    try { html = document.documentElement.outerHTML; } catch (e) {}
    if (!html) return;

    // 中转页把真实地址写在 location.replace()/location.href=/meta refresh 里
    var m = html.match(/location\.replace\(\s*(['"])(https?:\/\/[^'"]+?)\1/i) ||
      html.match(/location\.href\s*=\s*(['"])(https?:\/\/[^'"]+?)\1/i) ||
      html.match(/http-equiv=['"]?refresh['"]?[^>]*?url=([^'">]+)/i);
    var t = m && (m[2] || m[1]);
    if (!t) return;
    try { t = decodeURIComponent(t); } catch (e) {}
    if (!/^https?:\/\//i.test(t)) return;
    var V;
    try { V = new URL(t); } catch (e) { return; }
    // 目标是自己 host 的不跳（防死循环）
    if (V.host === location.host) return;
    location.replace(V.href);
  }

  /* ------------------------------------------------------------------ *
   *  启动
   * ------------------------------------------------------------------ */

  function start() {
    try { cleanRoot(document.body); } catch (e) {}
    try { interstitialJump(); } catch (e) {}
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) { scheduleClean(); return; }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
