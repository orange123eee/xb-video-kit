// ==UserScript==
// @name         视频提取器 · 万能播放/下载
// @namespace    local.xbrowser.videokit
// @version      2.7.1
// @description  自动嗅探网页视频（直链 / m3u8 / MSE 流），自带播放器（倍速、清晰度切换、全片拖动），多线程下载并合并为 mp4。
// @author       me
// @match        *://*/*
// @match        file:///*
// @run-at       document-start
// @grant        none
// @updateURL    https://orange123eee.github.io/xb-video-kit/video-extractor.user.js
// @downloadURL  https://orange123eee.github.io/xb-video-kit/video-extractor.user.js
// ==/UserScript==

// 设计参考（开源实现，只借鉴思路，未引入运行时依赖）：
//   - 猫抓 cat-catch / js/m3u8.downloader.js：多线程分片下载、按 index 归并、AbortController 中断、退避重试
//   - puemos/hls-downloader / m3u8-parser.ts：EXT-X-BYTERANGE、EXT-X-MAP、逐片 EXT-X-KEY 轮换
//   - video-dev/hls.js：点播显式设置 MediaSource.duration 以扩展 seekable、按播放位置切换码率、
//     跳转时复用同一个 MSE（换 Transmuxer 续写，不清空已缓冲画面）
//   - Plyr / Video.js / DPlayer / xgplayer：拖动时冻结进度更新、记录 pendingSeekTime、touchcancel 还原
// UI 方向参考 B 站移动端播放器：粉色主色、底部细进度条、倍速/清晰度弹层、居中重播键。
// 唯一的外部资源：转封装时按需加载 mux.js（CDN，失败自动回退存 .ts）。

(function () {
  'use strict';

  if (window.__XB_VIDEO_KIT__) return;
  window.__XB_VIDEO_KIT__ = true;

  var IS_TOP = true;
  try { IS_TOP = (window.top === window.self); } catch (e) { IS_TOP = false; }

  var MAX_ITEMS = 40;
  var VERSION = '2.7.1';

  // ---- 设置 ----
  var CFG_KEY = 'xbvk.cfg';
  var cfg = {
    autoTakeover: true,   // 网页播放器自动接管
    resume: true,         // 记忆播放进度
    gestures: true,       // 画面手势（拖动/双击/长按/音量亮度）
    skipIntro: 0,         // 跳过片头秒数
    speed: 1,             // 默认倍速
    segCache: true        // 边看边缓存（关掉就完全不占内存）
  };
  function loadCfg() {
    try {
      var o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      for (var k in cfg) { if (o[k] !== undefined && o[k] !== null) cfg[k] = o[k]; }
    } catch (e) {}
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  // 播放器图标（内联 SVG，避免额外请求）
  var ICON = {
    play: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="7" y="5.4" width="3.4" height="13.2" rx="1.2"/><rect x="13.6" y="5.4" width="3.4" height="13.2" rx="1.2"/></svg>',
    bigplay: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>',
    vol: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z"/><path d="M15.6 9.2a4 4 0 010 5.6"/></svg>',
    mute: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z"/><path d="M16 9.6l4.6 4.8M20.6 9.6L16 14.4"/></svg>',
    full: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
    replay: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 10-2.4 5.7"/><path d="M20 4.8V11h-6.2"/></svg>',
    dl: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v9.6M8 10.2l4 4 4-4M5 19.4h14"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    pip: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.4"/><rect x="12" y="12" width="6.4" height="4.8" rx="1.2" fill="currentColor" stroke="none"/></svg>'
  };

  // 脚本自己的网络请求必须走原生 fetch：否则会被我们自己的 hookFetch 再抓一次，
  // 变成"预解析子清晰度 → 又进列表"的自污染
  var rawFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;

  // 脚本自己发起的 URL：资源时序里也会出现，不能回流进列表（否则预解析会把列表刷乱）
  var selfReqs = new Set();
  // 已知主列表的子清晰度：它们是同一个视频，不必各占一行
  var variantSet = new Set();

  function netFetch(url, init) {
    if (!rawFetch) return Promise.reject(new Error('内核不支持 fetch'));
    try {
      selfReqs.add(String(url));
      if (selfReqs.size > 500) selfReqs.delete(selfReqs.keys().next().value);   // 有界，别无限涨
    } catch (e) {}
    return rawFetch(url, init);
  }

  // 出现在网络请求里就算媒体（不收录单个 .ts / .m4s，避免一个视频刷出几百条）
  var NET_RE = /\.(mp4|m4v|webm|mkv|mov|flv|m3u8|mpd)(?:[?#]|$)/i;
  // 媒体元素上的 src 可以更宽松
  var SRC_RE = /\.(mp4|m4v|webm|mkv|mov|flv|m3u8|mpd|ts|m4s|ogv)(?:[?#]|$)/i;
  // 没后缀的播放接口只能靠响应头认（排除 video/mp2t，那是分片不是片子）
  var MIME_RE = /^(video\/(mp4|webm|quicktime|x-matroska|x-flv)|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

  var items = new Map();   // url -> item
  var blobs = new Map();   // blobUrl -> {kind:'mse'|'blob', blob, mime}
  var seq = 0;
  var hasMse = false;
  var hasVideoEl = false;
  var ui = null;
  var fabEl = null;
  var sheetEl = null;
  var listEl = null;
  var setEl = null;
  var settingsOpen = false;
  var playerEl = null;
  var videoEl = null;
  var toastEl = null;
  var progressEl = null;
  var menuOpen = false;
  var hls = null;
  var current = null;
  var playerOpen = false;
  var sheetOpen = false;
  var userPaused = false;      // 用户主动暂停过：之后的重建/补数据不许自动续播
  var forcedEnded = false;     // 片源最后没有完整帧、播放器停在终点前：按播完处理
  // 打开面板/播放器后的 450ms 内忽略点击：移动端 touchend 之后浏览器会补发一次 click，
  // 此时球已隐藏，click 会落到刚出现的遮罩上，把面板瞬间关掉（表现为"点一下闪一下"）
  var uiGuardUntil = 0;
  var siteVideo = null;        // 被接管的网页播放器
  var siteWasPlaying = false;  // 接管前它是不是在播，退出接管要还原
  var takeoverTried = false;
  var playerHiddenForSheet = false;   // 从播放器打开列表时先把播放器藏起来，收起列表要放回去
  var deepScanTick = 0;
  var speedIdx = 2;
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  var pos = loadPos();

  // 性能相关状态
  var listDirty = false;       // 面板没开时只记脏，不重排 DOM
  var fabState = '';           // 悬浮球上次的显示状态，避免每轮扫描都写 style
  var hasShadow = false;       // 页面用过 attachShadow 才值得深扫
  var buildingUI = false;      // 正在建我们自己的 shadow root
  var perfIndex = 0;           // 资源时序只处理新增条目
  var idleTicks = 0;           // 连续没发现视频的轮数，用于降频
  var playCache = new Map();   // m3u8 -> Promise<{r, pl}>，点播放时省掉一次往返
  var textCache = new Map();   // m3u8 原文，直接从页面的响应里截获，避免重复请求
  var bufCache = new Map();    // url -> {buf, ts}，只放 init 段这类小文件
  // 边看边缓存：分片密文存内存，重看/切码率/重开播放器都不用再下载
  var segCache = new Map();
  var segCacheBytes = 0;
  var SEG_CACHE_MAX = 40 * 1024 * 1024;

  function putSegCache(key, buf) {
    if (!cfg.segCache) return;                          // 用户关掉了缓存
    if (!buf || !buf.byteLength) return;
    if (buf.byteLength > 8 * 1024 * 1024) return;      // 单片太大就不占内存了
    if (segCache.has(key)) return;
    segCache.set(key, { buf: buf, ts: Date.now() });
    segCacheBytes += buf.byteLength;
    while (segCacheBytes > SEG_CACHE_MAX && segCache.size > 1) {
      var first = segCache.keys().next().value;
      var v = segCache.get(first);
      segCacheBytes -= (v && v.buf && v.buf.byteLength) || 0;
      segCache.delete(first);
    }
  }

  /* ------------------------------------------------------------------ *
   *  工具
   * ------------------------------------------------------------------ */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function absolutize(u) {
    try { return new URL(u, location.href).href; } catch (e) { return u; }
  }

  function fmtBytes(n) {
    if (!n || n < 0) return '';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(0) + 'KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
    return (n / 1073741824).toFixed(2) + 'GB';
  }

  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  }

  function hexToBytes(hex) {
    hex = String(hex).replace(/[^0-9a-f]/gi, '');
    if (hex.length % 2) hex = '0' + hex;
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function loadPos() {
    try {
      var p = JSON.parse(localStorage.getItem('xbvk.pos') || 'null');
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) {}
    return null;
  }

  function savePos(x, y) {
    pos = { x: x, y: y };
    try { localStorage.setItem('xbvk.pos', JSON.stringify(pos)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  嗅探：网络层
   * ------------------------------------------------------------------ */

  function hookXHR() {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__xbvk_url = url; } catch (e) {}
      return open.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var u = xhr.responseURL || xhr.__xbvk_url;
            if (!u) return;
            var rawType = xhr.getResponseHeader('content-type') || '';
            var type = rawType.split(';')[0].trim().toLowerCase();
            var byUrl = NET_RE.test(u);
            // 很多站点的播放接口根本没有后缀，只能靠 Content-Type 认
            if (!byUrl && !MIME_RE.test(type)) return;
            if (!allowByMime(type, byUrl)) return;

            var size = parseInt(xhr.getResponseHeader('content-length') || '0', 10) || 0;
            var kind = kindFromMime(type);
            var abs = absolutize(u);
            addItem(abs, kind, { from: 'net', size: size, mime: type, score: kind ? 55 : 50 });

            // 顺手把 m3u8 文本喂给缓存：既不重复请求，也不会踩一次性签名
            if (kind === 'hls' || /\.m3u8(?:[?#]|$)/i.test(u)) {
              try {
                if (!xhr.responseType || xhr.responseType === 'text') seedText(abs, xhr.responseText);
              } catch (e) {}
            }
          } catch (e) {}
        });
      } catch (e) {}
      return send.apply(this, arguments);
    };
  }

  function hookFetch() {
    if (!window.fetch) return;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input
          : (window.URL && input instanceof URL) ? input.href
          : (input && input.url) || '';
      } catch (e) {}
      var p = orig.apply(this, arguments);
      try {
        if (url) {
          if (NET_RE.test(url)) addItem(absolutize(url), null, { from: 'net', score: 50 });

          p.then(function (r) {
            try {
              var rawType = r.headers.get('content-type') || '';
              var type = rawType.split(';')[0].trim().toLowerCase();
              var byUrl = NET_RE.test(url);
              if (!byUrl && !MIME_RE.test(type)) return;
              if (!allowByMime(type, byUrl)) return;

              var size = parseInt(r.headers.get('content-length') || '0', 10) || 0;
              var kind = kindFromMime(type);
              var abs = absolutize(url);
              addItem(abs, kind, { from: 'net', size: size, mime: type, score: kind ? 55 : 50 });

              if (kind === 'hls' || /\.m3u8(?:[?#]|$)/i.test(url)) {
                // clone 在页面读取 body 之前先 tee 一份，拿去当播放列表缓存
                r.clone().text().then(function (t) { seedText(abs, t); }, function () {});
              }
            } catch (e) {}
          }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  function kindFromMime(type) {
    if (!type) return null;
    if (/mpegurl/i.test(type)) return 'hls';
    if (/dash\+xml/i.test(type)) return 'dash';
    return null;
  }

  // 只靠 Content-Type 认出来的，可能是 DASH 分片，限量收录，别把列表刷爆
  var ctItemCount = 0;
  function allowByMime(type, byUrl) {
    if (byUrl) return true;
    if (/mpegurl|dash\+xml/i.test(type)) return true;
    if (ctItemCount >= 10) return false;
    ctItemCount++;
    return true;
  }

  // 兜底：资源时序里能捞到脚本启动前就已经发出的请求（只处理新增条目，避免重复全量遍历）
  function scanPerf() {
    try {
      if (!performance || !performance.getEntriesByType) return;
      var es = performance.getEntriesByType('resource');
      if (es.length < perfIndex) perfIndex = 0;   // 缓冲区被清空过
      for (var i = perfIndex; i < es.length; i++) {
        var n = es[i].name;
        if (n && NET_RE.test(n)) {
          addItem(n, null, {
            from: 'perf',
            size: es[i].encodedBodySize || es[i].transferSize || 0,
            score: 40
          });
        }
      }
      perfIndex = es.length;
    } catch (e) {}
  }

  function watchPerf() {
    try {
      if (!window.PerformanceObserver) return;
      var po = new PerformanceObserver(function (l) {
        var es = l.getEntries();
        for (var i = 0; i < es.length; i++) {
          var n = es[i].name;
          if (n && NET_RE.test(n)) {
            addItem(n, null, { from: 'perf', size: es[i].encodedBodySize || 0, score: 40 });
          }
        }
      });
      po.observe({ type: 'resource' });   // 历史条目由 scanPerf 统一处理，避免重复
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  嗅探：媒体元素
   * ------------------------------------------------------------------ */

  function onMediaUrl(el, value, from) {
    if (!value) return;
    var v = String(value);
    if (v.indexOf('data:') === 0) return;

    if (v.indexOf('blob:') === 0) {
      var info = blobs.get(v);
      if (info && info.kind === 'blob' && info.blob) {
        addItem(v, 'blob', { from: from || 'dom', score: 70, blob: info.blob, mime: info.mime });
      } else {
        hasMse = true;
        if (sheetOpen) scheduleRender();
        ensureFab();
      }
      return;
    }

    if (!/^https?:/i.test(absolutize(v))) return;
    if (!SRC_RE.test(v) && !/^https?:\/\/[^?#]+$/i.test(v)) return;

    var kind = null;
    if (/\.m3u8(?:[?#]|$)/i.test(v)) kind = 'hls';
    else if (/\.mpd(?:[?#]|$)/i.test(v)) kind = 'dash';
    else if (/\.flv(?:[?#]|$)/i.test(v)) kind = 'flv';
    else if (/\.ts(?:[?#]|$)/i.test(v)) kind = 'ts';

    addItem(absolutize(v), kind, { from: from || 'dom', score: 100 });
  }

  function hookSrcProp(proto) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!d || !d.set) return;
    try {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          try { onMediaUrl(this, v, 'dom'); } catch (e) {}
          return d.set.call(this, v);
        }
      });
    } catch (e) {}
  }

  function hookMedia() {
    hookSrcProp(window.HTMLMediaElement && HTMLMediaElement.prototype);
    hookSrcProp(window.HTMLSourceElement && HTMLSourceElement.prototype);

    var setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      // 快路径：绝大多数 setAttribute 都不是 src，先做长度+字符串比较，避免 toLowerCase 分配
      if (name === 'src' || (name.length === 3 && String(name).toLowerCase() === 'src')) {
        try {
          var tag = this.tagName;
          if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') onMediaUrl(this, value, 'dom');
        } catch (e) {}
      }
      return setAttr.apply(this, arguments);
    };

    // 页面从没建过 shadow root 的话，就不必每轮去遍历整棵 DOM 找 shadow 里的 video
    try {
      var attach = Element.prototype.attachShadow;
      if (attach) {
        Element.prototype.attachShadow = function () {
          if (!buildingUI) hasShadow = true;   // 我们自己的 UI 不算
          return attach.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  function trimBlobs() {
    // 页面可能不停地 createObjectURL，只留最近 3 个，避免内存无限涨
    while (blobs.size > 3) blobs.delete(blobs.keys().next().value);
  }

  function hookObjectUrl() {
    if (!window.URL || !URL.createObjectURL) return;
    var orig = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      var u = orig.apply(this, arguments);
      try {
        if (window.MediaSource && obj instanceof MediaSource) {
          blobs.set(u, { kind: 'mse' });
          trimBlobs();
        } else if (window.Blob && obj instanceof Blob) {
          var t = obj.type || '';
          // 只留最近的小体积视频 Blob，超大对象交给页面自己管，别把内存顶爆（3×64MB 封顶）
          if ((t.indexOf('video/') === 0 || t.indexOf('audio/') === 0) && obj.size < 64 * 1024 * 1024) {
            blobs.set(u, { kind: 'blob', blob: obj, mime: t });
            trimBlobs();
          }
        }
      } catch (e) {}
      return u;
    };
  }

  function collectVideos(root, out) {
    out = out || [];
    try {
      var vs = root.querySelectorAll ? root.querySelectorAll('video') : [];
      for (var i = 0; i < vs.length; i++) out.push(vs[i]);
    } catch (e) {}
    return out;
  }

  function scanDom() {
    var vids = collectVideos(document);
    if (vids.length) {
      hasVideoEl = true;
      if (IS_TOP) ensureFab();
    }
    // 只有页面真的用过 shadow DOM 才值得遍历整棵树，且降频到约 12 秒一次
    if (!vids.length && hasShadow && (deepScanTick++ % 8 === 0)) {
      try {
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length && i < 3000; i++) {
          if (all[i].shadowRoot) collectVideos(all[i].shadowRoot, vids);
        }
      } catch (e) {}
    }
    for (var k = 0; k < vids.length; k++) {
      var v = vids[k];
      try {
        if (v.currentSrc) onMediaUrl(v, v.currentSrc, 'dom');
        if (v.src) onMediaUrl(v, v.src, 'dom');
        var ss = v.querySelectorAll('source');
        for (var j = 0; j < ss.length; j++) {
          if (ss[j].src) onMediaUrl(ss[j], ss[j].src, 'dom');
        }
      } catch (e) {}
    }
    // 检测到主播放器就自动接管（像 QQ 浏览器那样，不需要用户点任何东西）
    if (vids.length && IS_TOP) scheduleAutoTakeover();

    // 同源 iframe 也顺手扫一下
    try {
      var ifs = document.querySelectorAll('iframe');
      for (var n = 0; n < ifs.length; n++) {
        var doc = null;
        try { doc = ifs[n].contentDocument; } catch (e) { doc = null; }
        if (!doc) continue;
        var iv = collectVideos(doc);
        for (var m = 0; m < iv.length; m++) {
          if (iv[m].currentSrc) onMediaUrl(iv[m], iv[m].currentSrc, 'dom');
          if (iv[m].src) onMediaUrl(iv[m], iv[m].src, 'dom');
        }
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  数据源
   * ------------------------------------------------------------------ */

  function guessKind(url) {
    if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
    if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
    if (/\.flv(?:[?#]|$)/i.test(url)) return 'flv';
    if (/\.ts(?:[?#]|$)/i.test(url)) return 'ts';
    if (/\.webm(?:[?#]|$)/i.test(url)) return 'webm';
    if (/^blob:/i.test(url)) return 'blob';
    return 'mp4';
  }

  function guessTitle(it) {
    var name = '';
    if (/^blob:/i.test(it.url)) {
      return sanitize(document.title || 'video');
    }
    try {
      var u = new URL(it.url);
      name = decodeURIComponent((u.pathname.split('/').pop() || ''));
      name = name.replace(/\.(mp4|m4v|webm|mkv|mov|flv|m3u8|mpd|ts|m4s)$/i, '');
      if (!name) name = u.hostname;
    } catch (e) {}
    var generic = /^(index|master|playlist|main|video|media|out|output|manifest|stream|hls|chunklist|prog_index|file|1|0)$/i;
    if (!name || generic.test(name) || name.length < 3) {
      var t = sanitize(document.title || '');
      if (t) name = t + (name ? '_' + name : '');
    }
    return sanitize(name || 'video');
  }

  function addItem(url, kind, extra) {
    if (!url) return null;
    extra = extra || {};
    var key = url;
    var old = items.get(key);

    if (old) {
      var bumped = false;
      if (extra.score && extra.score > old.score) { old.score = extra.score; bumped = true; }
      if (extra.size && extra.size > old.size) { old.size = extra.size; bumped = true; }
      if (extra.mime && !old.mime) { old.mime = extra.mime; bumped = true; }
      if (bumped) {
        listDirty = true;
        if (sheetOpen) scheduleRender();
      }
      return old;
    }

    // 自己拉的、或已知主列表的子清晰度，不要再作为新条目出现
    if ((selfReqs.has(key) || variantSet.has(key)) && extra.from !== 'dom' && extra.from !== 'frame') return null;

    if (items.size >= MAX_ITEMS) {
      var worstKey = null, worst = 1e9;
      items.forEach(function (v, k) {
        if (v.score < worst) { worst = v.score; worstKey = k; }
      });
      if (!worstKey) return null;
      if (worst > (extra.score || 0)) return null;   // 新的还不如旧的，直接丢弃
      items.delete(worstKey);
    }

    var it = {
      id: ++seq,
      url: key,
      kind: kind || guessKind(key),
      from: extra.from || 'net',
      mime: extra.mime || '',
      size: extra.size || 0,
      blob: extra.blob || null,
      score: extra.score || 30,
      ts: Date.now()
    };
    it.title = guessTitle(it);
    items.set(key, it);
    listDirty = true;
    if (!IS_TOP) postToParent(it);          // 子框架把地址抛给顶层
    if (sheetOpen) scheduleRender();
    ensureFab();

    // 嗅探到 m3u8 就后台预解析（只拉几 KB 的文本 + init 段），点播放时几乎零等待
    if (IS_TOP && it.kind === 'hls' && hlsPrefetchCount < 3) {
      hlsPrefetchCount++;
      setTimeout(function () { getPlaylist(it.url).catch(function () {}); }, 600);
    }
    // 拿到地址后也许就能接管网页播放器了
    if (IS_TOP) scheduleAutoTakeover();
    return it;
  }

  function sortedItems() {
    var arr = [];
    items.forEach(function (v) { arr.push(v); });
    arr.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.ts - b.ts;
    });
    return arr;
  }

  /* ------------------------------------------------------------------ *
   *  UI
   * ------------------------------------------------------------------ */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
    '.fab{position:fixed;height:42px;padding:0 13px 0 11px;border-radius:21px;display:flex;align-items:center;gap:5px;',
    'background:rgba(22,24,29,.95);border:1px solid rgba(255,255,255,.18);box-shadow:0 6px 22px rgba(0,0,0,.5);',
    'pointer-events:auto;touch-action:none;z-index:9;transition:opacity .18s,transform .18s}',
    '.fab .lb{font:600 12px/1 -apple-system,"PingFang SC","Noto Sans SC",sans-serif;color:#e9ebef;letter-spacing:.5px}',
    '.fab:active{transform:scale(.94)}',
    '.fab.press{transform:scale(.9);opacity:.85}',
    '.fab .dot{position:absolute;top:3px;right:3px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;',
    'background:#4f8cff;color:#fff;font:600 10px/16px -apple-system,sans-serif;text-align:center;display:none}',
    '.fab.has .dot{display:block}',
    '.fab .tip{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);white-space:nowrap;',
    'background:rgba(22,24,29,.96);color:#e9ebef;font:12px/1 -apple-system,sans-serif;padding:8px 10px;',
    'border-radius:8px;border:1px solid rgba(255,255,255,.16);box-shadow:0 4px 14px rgba(0,0,0,.45);display:none}',
    '.fab.tipon .tip{display:block}',
    '.fab .tip.b{bottom:auto;top:58px}',
    '.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s;z-index:1}',
    '.mask.on{opacity:1;pointer-events:auto}',
    '.sheet{position:fixed;left:0;right:0;bottom:0;background:#16181d;color:#e9ebef;border-radius:18px 18px 0 0;',
    'box-shadow:0 -10px 40px rgba(0,0,0,.6);transform:translateY(105%);transition:transform .26s cubic-bezier(.2,.85,.25,1);',
    'pointer-events:auto;z-index:2;max-height:74vh;display:flex;flex-direction:column;',
    'font:14px/1.45 -apple-system,"PingFang SC","Noto Sans SC",sans-serif;padding-bottom:calc(8px + env(safe-area-inset-bottom))}',
    '.sheet.open{transform:translateY(0)}',
    '.hd{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.hd h3{margin:0;font-size:15px;font-weight:600;flex:1}',
    '.hd .cnt{font-size:12px;color:#8b93a1}',
    '.hd button{background:rgba(255,255,255,.08);border:0;color:#cfd5de;border-radius:9px;padding:6px 10px;font-size:12px}',
    '.hint{padding:0 16px 8px;font-size:11.5px;color:#79808d}',
    '.list{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 0}',
    '.empty{padding:24px 20px;color:#8b93a1;font-size:13px;text-align:center;line-height:1.8}',
    '.empty b{color:#cfd5de;font-weight:600}',
    '.empty .mini{margin-top:12px;height:34px;padding:0 18px;border-radius:9px;border:1px solid rgba(255,255,255,.14);',
    'background:rgba(255,255,255,.07);color:#dde2ea;font-size:12.5px}',
    '.it{padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.055)}',
    '.it:last-child{border-bottom:0}',
    '.r1{display:flex;align-items:center;gap:7px;margin-bottom:3px}',
    '.badge{font:600 10px/1 -apple-system,sans-serif;padding:4px 6px;border-radius:5px;background:rgba(79,140,255,.18);',
    'color:#7fa9ff;letter-spacing:.3px;flex:none}',
    '.badge.mse{background:rgba(255,171,64,.16);color:#ffb545}',
    '.badge.hls{background:rgba(56,205,150,.16);color:#3ecd96}',
    '.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;color:#e9ebef}',
    '.sz{font-size:11px;color:#79808d;flex:none}',
    '.u{font-size:11px;color:#6d7480;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:8px;direction:rtl;text-align:left}',
    '.acts{display:flex;gap:8px}',
    '.acts button{flex:1;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.1);',
    'background:rgba(255,255,255,.06);color:#dde2ea;font-size:12.5px;font-weight:500}',
    '.acts button:active{background:rgba(255,255,255,.14)}',
    '.acts button.pri{background:#2f6fd0;border-color:#2f6fd0;color:#fff}',
    '.ft{padding:10px 16px 4px;display:flex;gap:8px;align-items:center}',
    '.ft .ver{font-style:normal;font-size:10px;color:#5d6470;flex:none}',
    '.ft button{flex:1;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);',
    'color:#cfd5de;font-size:13px}',
    '.pl{position:fixed;inset:0;background:#000;display:none;flex-direction:column;pointer-events:auto;z-index:3;overscroll-behavior:contain}',
    '.pl.open{display:flex}',
    '.pl.embed{border-radius:10px;overflow:hidden;box-shadow:0 10px 34px rgba(0,0,0,.55)}',
    '.pl .top{display:flex;align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top)) 12px 10px;',
    'background:linear-gradient(rgba(0,0,0,.74),rgba(0,0,0,0));position:absolute;left:0;right:0;top:0;z-index:4;transition:opacity .25s}',
    '.pl .top button{height:34px;min-width:34px;width:34px;padding:0;border-radius:50%;border:0;background:rgba(0,0,0,.3);',
    'color:#fff;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)}',
    '.pl .top button:active{background:rgba(255,255,255,.2)}',
    '.pl .t{flex:1;color:#fff;font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.95;letter-spacing:.1px}',
    '.pl .stage{position:absolute;inset:0;display:flex;background:#000}',
    '.pl .dim{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2}',
    // 加载中：画面先透出网页原来的样子（海报/首帧），别一上来就是黑屏
    '.pl.embed.loading{background:transparent}',
    '.pl.embed.loading video{background:transparent}',
    '.pl.loading .bigplay,.pl.loading .ctl,.pl.loading .top,.pl.loading .side{opacity:0;pointer-events:none}',
    '.pl .spin{position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;',
    'border:3px solid rgba(255,255,255,.25);border-top-color:#fff;background:rgba(0,0,0,.38);',
    'box-shadow:0 2px 14px rgba(0,0,0,.55);animation:xbspin .8s linear infinite;',
    'display:none;z-index:6}',
    '.pl.loading .spin{display:block}',
    '@keyframes xbspin{to{transform:rotate(360deg)}}',
    '.pl video{flex:1;width:100%;height:100%;object-fit:contain;background:#000;display:block}',
    '.pl .bigplay{position:absolute;left:50%;top:50%;width:72px;height:72px;margin:-36px 0 0 -36px;border-radius:50%;',
    'background:rgba(251,114,153,.94);border:0;color:#fff;display:none;align-items:center;',
    'justify-content:center;z-index:3;box-shadow:0 8px 30px rgba(251,114,153,.34),0 4px 16px rgba(0,0,0,.42);',
    'transition:transform .16s,background .16s}',
    '.pl .bigplay svg{width:34px;height:34px;margin-left:3px}',
    '.pl .bigplay .bp-play,.pl .bigplay .bp-replay{display:flex;align-items:center;justify-content:center}',
    '.pl .bigplay .bp-replay{display:none}',
    '.pl.ended .bigplay .bp-play{display:none}',
    '.pl.ended .bigplay .bp-replay{display:flex}',
    '.pl.paused .bigplay{display:flex;animation:xbpop .18s ease-out}',
    '.pl.paused .bigplay:active{transform:scale(.92);background:rgba(251,114,153,1)}',
    '@keyframes xbpop{from{transform:scale(.82);opacity:.5}to{transform:scale(1);opacity:1}}',
    // 加载中不显示大播放键（此时还没内容，显示它反而像卡住了）
    '.pl.loading .bigplay{display:none}',
    // 跳转/缓冲中：保留控件，只把大播放键换成转圈（否则会被误认为已暂停）
    '.pl.seeking .bigplay{display:none!important}',
    '.pl.seeking .spin{display:block}',
    '.pl.buffering .bigplay{display:none!important}',
    '.pl.buffering .spin{display:block}',
    // 重建 MSE 前把最后一帧留在画面上，加载期间不黑屏
    '.pl .freeze{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:none;z-index:1;pointer-events:none}',
    '.pl .seekpreview{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;align-items:center;',
    'gap:10px;background:rgba(18,19,23,.84);color:#fff;padding:10px 15px;border-radius:12px;z-index:5;pointer-events:none;',
    'border:1px solid rgba(255,255,255,.1);box-shadow:0 6px 22px rgba(0,0,0,.42);backdrop-filter:blur(10px)}',
    '.pl .seekpreview b{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}',
    '.pl .seekpreview i{font-style:normal;font-size:12px;opacity:.9;color:#ff9dbb;font-variant-numeric:tabular-nums}',
    '.pl .seekpreview.hud{flex-direction:column;align-items:flex-start;gap:7px;min-width:94px;padding:10px 12px}',
    '.pl .seekpreview.hud b{font-size:17px}',
    '.pl .seekpreview.hud i{font-size:10.5px;color:rgba(255,255,255,.7);order:-1;letter-spacing:.5px}',
    '.pl .seekpreview .bar{display:none;width:74px;height:3px;border-radius:2px;background:rgba(255,255,255,.22);overflow:hidden}',
    '.pl .seekpreview .bar em{display:block;width:0;height:100%;border-radius:2px;background:#fb7299}',
    '.pl .seekpreview.hud .bar{display:block}',
    '.pl .seekpreview.left{left:17%}',
    '.pl .seekpreview.right{left:83%}',
    '.pl .ctl{position:absolute;left:0;right:0;bottom:0;z-index:4;padding:32px 14px calc(10px + env(safe-area-inset-bottom));',
    'background:linear-gradient(transparent,rgba(0,0,0,.78) 40%,rgba(0,0,0,.94));transition:opacity .25s}',
    '.pl.hideui .top,.pl.hideui .ctl{opacity:0;pointer-events:none}',
    '.pl .seek{position:relative;height:34px;display:flex;align-items:center;touch-action:none;cursor:pointer;margin-bottom:0}',
    '.pl .seek .track{position:absolute;left:0;right:0;height:3px;border-radius:2px;background:rgba(255,255,255,.18)}',
    '.pl .seek .buf{position:absolute;left:0;width:0;height:3px;border-radius:2px;background:rgba(255,255,255,.3)}',
    '.pl .seek .bar{position:absolute;left:0;width:0;height:3px;border-radius:2px;background:#fb7299;box-shadow:0 0 7px rgba(251,114,153,.42)}',
    '.pl .seek .knob{position:absolute;left:0;width:12px;height:12px;border-radius:50%;background:#fff;',
    'margin-left:-6px;border:2px solid #fb7299;box-shadow:0 2px 8px rgba(0,0,0,.45);transition:transform .12s}',
    '.pl .seek.on .knob{transform:scale(1.28)}',
    '.pl .seek .tip{position:absolute;bottom:30px;left:0;transform:translateX(-50%);background:rgba(20,21,25,.94);',
    'color:#fff;font:600 11px/1 -apple-system,"PingFang SC",sans-serif;padding:6px 8px;border-radius:7px;',
    'white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s;z-index:5;font-variant-numeric:tabular-nums;',
    'border:1px solid rgba(255,255,255,.1)}',
    '.pl .seek.on .tip{opacity:1}',
    '.pl .ctlrow{display:flex;align-items:center;gap:6px;height:38px}',
    '.pl .ctlrow button{height:30px;padding:0 9px;border-radius:8px;border:0;background:rgba(255,255,255,.09);',
    'color:#f1f3f6;font-size:12px;font-weight:500;flex:none}',
    '.pl .ctlrow button:active{background:rgba(255,255,255,.2)}',
    '.pl .ctlrow button.ico{width:34px;padding:0;background:transparent;display:flex;align-items:center;justify-content:center}',
    '.pl .ctlrow button.ico:active{background:rgba(255,255,255,.12)}',
    '.pl .ctlrow button.on{background:rgba(251,114,153,.18);color:#ff9dbb}',
    '.pl .ctlrow button[data-a="speed"]::after,.pl .ctlrow button[data-a="q"]::after{content:"";display:inline-block;',
    'width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid currentColor;',
    'margin-left:5px;opacity:.65;vertical-align:middle}',
    '.pl .side{position:absolute;right:10px;bottom:calc(100px + env(safe-area-inset-bottom));z-index:4;display:flex;',
    'flex-direction:column;gap:10px;transition:opacity .25s}',
    '.pl .side button{width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.36);',
    'color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;backdrop-filter:blur(6px)}',
    '.pl .side button:active{transform:scale(.94);background:rgba(255,255,255,.18)}',
    '.pl .side button i{font-style:normal;font-size:8.5px;color:rgba(255,255,255,.78);line-height:1}',
    '.pl.embed .side{bottom:calc(92px + env(safe-area-inset-bottom));gap:8px}',
    '.pl.embed .side button{width:36px;height:36px}',
    '.pl.embed .side button i{font-size:8px}',
    // 嵌入的小框放不下三个按钮，画中画留给全屏用
    '.pl.embed .side [data-a="pip"]{display:none}',
    '.pl.hideui .side{opacity:0;pointer-events:none}',
    '.pl .ctlrow .tm{font-size:11.5px;color:rgba(255,255,255,.78);font-variant-numeric:tabular-nums;flex:none;white-space:nowrap}',
    '.pl .ctlrow .stat{font-size:10px;color:rgba(255,255,255,.42);flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pl.embed .ctlrow .stat{display:none}',
    '.pl .ctlrow .sp{flex:1}',
    // 倍速 / 清晰度弹层
    '.pl .pmask{position:absolute;inset:0;z-index:7;display:none;background:rgba(0,0,0,.16)}',
    '.pl .pmask.on{display:block}',
    '.pl .pmenu{position:absolute;right:12px;bottom:calc(60px + env(safe-area-inset-bottom));z-index:8;display:none;',
    'min-width:150px;max-width:calc(100% - 24px);max-height:52vh;overflow-y:auto;-webkit-overflow-scrolling:touch;',
    'background:rgba(22,23,28,.97);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:8px;',
    'box-shadow:0 10px 30px rgba(0,0,0,.55);backdrop-filter:blur(14px);',
    'font:12.5px/1.4 -apple-system,"PingFang SC","Noto Sans SC",sans-serif}',
    '.pl .pmenu.on{display:block;animation:xbmenupop .16s ease-out}',
    '@keyframes xbmenupop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
    '.pl .pmenu .pmt{font-size:10.5px;color:#8b93a1;padding:2px 6px 7px;letter-spacing:.3px}',
    '.pl .pmenu button{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;height:32px;',
    'padding:0 9px;border:0;border-radius:7px;background:transparent;color:#e9ebef;font-size:12.5px;text-align:left}',
    '.pl .pmenu button:active{background:rgba(255,255,255,.1)}',
    '.pl .pmenu button.on{color:#ff9dbb;background:rgba(251,114,153,.14);font-weight:600}',
    '.pl .pmenu button.on::after{content:"✓";font-size:11px;color:#fb7299}',
    '.pl .pmenu.grid{width:232px}',
    '.pl .pmenu.grid .pmbody{display:grid;grid-template-columns:repeat(4,minmax(48px,1fr));gap:4px}',
    '.pl .pmenu.grid button{justify-content:center;height:30px;padding:0 4px;font-size:12px}',
    '.pl .pmenu.grid button.on::after{content:""}',
    '.toast{position:fixed;left:50%;bottom:130px;transform:translate(-50%,10px);background:rgba(24,26,31,.96);color:#e9ebef;',
    'padding:10px 14px;border-radius:10px;font:13px/1.4 -apple-system,sans-serif;max-width:80vw;text-align:center;',
    'opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:20;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
    '.toast.on{opacity:1;transform:translate(-50%,0)}',
    '.pg{position:fixed;left:16px;right:16px;bottom:150px;background:rgba(24,26,31,.97);border-radius:12px;padding:12px 14px;',
    'z-index:21;color:#e9ebef;font:12.5px/1.4 -apple-system,sans-serif;display:none;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
    '.pg.on{display:block}',
    '.pg .row{display:flex;align-items:center;gap:10px;margin-bottom:8px}',
    '.pg .row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pg .row button{background:rgba(255,255,255,.1);border:0;color:#cfd5de;border-radius:7px;padding:4px 9px;font-size:11.5px}',
    '.pg .track{height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden}',
    '.pg .fill{height:100%;width:0;background:#4f8cff;transition:width .18s}',
    // 设置面板
    '.set{position:fixed;left:0;right:0;bottom:0;background:#16181d;color:#e9ebef;border-radius:18px 18px 0 0;z-index:12;',
    'transform:translateY(105%);transition:transform .24s cubic-bezier(.2,.85,.25,1);pointer-events:auto;',
    'max-height:78vh;display:flex;flex-direction:column;padding-bottom:calc(10px + env(safe-area-inset-bottom))}',
    '.set.open{transform:translateY(0)}',
    '.set .hd{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.set .hd h3{margin:0;font-size:15px;font-weight:600;flex:1}',
    '.set .hd button{background:rgba(255,255,255,.1);border:0;color:#cfd5de;border-radius:9px;padding:7px 14px;font-size:12.5px}',
    '.set .sbody{padding:4px 16px 8px;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '.srow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;',
    'border-bottom:1px solid rgba(255,255,255,.05);font-size:13.5px;color:#dfe4ec}',
    '.srow:last-child{border-bottom:0}',
    '.srow.col{flex-direction:column;align-items:stretch;gap:10px}',
    '.srow.col>span{color:#aeb6c2;font-size:12.5px}',
    '.sw{width:44px;height:26px;border-radius:13px;background:rgba(255,255,255,.16);position:relative;flex:none;transition:background .2s}',
    '.sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s}',
    '.sw.on{background:#3ea6ff}',
    '.sw.on::after{left:21px}',
    '.seg{display:flex;gap:8px}',
    '.seg button{flex:1;height:36px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);',
    'color:#cfd5de;font-size:12.5px}',
    '.seg button.on{background:#2f6fd0;border-color:#2f6fd0;color:#fff}',
    '.srow .cwrap{display:flex;align-items:center;gap:10px}',
    '.srow .csz{font-style:normal;color:#8b93a1;font-size:12px}',
    '.srow .mini{height:28px;padding:0 12px;border-radius:8px;border:1px solid rgba(255,255,255,.14);',
    'background:rgba(255,255,255,.07);color:#cfd5de;font-size:12px}',
    // 窄屏：段数状态和间距让一让，别把控制栏挤爆
    '@media (max-width:400px){',
    '.pl .ctlrow{gap:5px}',
    '.pl .ctlrow .stat{display:none}',
    '.pl .ctlrow .tm{font-size:10.5px}',
    '.pl .ctlrow button[data-a="q"]{padding:0 7px}',
    '}',
    // 横屏：刘海在左右两侧，边距要按 safe-area 让开；控件也收紧一点
    '@media (orientation:landscape){',
    '.pl .top{padding:calc(6px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 6px calc(16px + env(safe-area-inset-left))}',
    '.pl .ctl{padding:22px calc(18px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left))}',
    '.pl .side{right:calc(14px + env(safe-area-inset-right));bottom:calc(84px + env(safe-area-inset-bottom))}',
    '.pl .seek{height:30px}',
    '.pl .seek .tip{bottom:27px}',
    '.pl .bigplay{width:64px;height:64px;margin:-32px 0 0 -32px}',
    '.pl .bigplay svg{width:30px;height:30px}',
    '.pl .pmenu{bottom:calc(56px + env(safe-area-inset-bottom))}',
    '}'
  ].join('');

  function buildUI() {
    if (ui) return ui;
    if (!document.documentElement) return null;

    var host = document.createElement('div');
    host.id = '__xb_video_kit__';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2147483647;';
    var root = null;
    if (host.attachShadow) {
      buildingUI = true;
      try { root = host.attachShadow({ mode: 'open' }); } finally { buildingUI = false; }
    }
    if (!root) return null;

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    // 悬浮球
    fabEl = document.createElement('div');
    fabEl.className = 'fab';
    fabEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="#e9ebef" stroke-width="1.8">' +
      '<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="3.2"/>' +
      '<path d="M10.2 9.3l5 2.7-5 2.7z" fill="#e9ebef" stroke="none"/></svg>' +
      '<span class="lb">视频</span>' +
      '<i class="dot">0</i>' +
      '<b class="tip">点我播放 · 长按列表</b>';
    fabEl.style.right = '14px';
    fabEl.style.bottom = '150px';
    if (pos) {
      var px = Math.max(4, Math.min(window.innerWidth - 80, pos.x));
      var py = Math.max(4, Math.min(window.innerHeight - 50, pos.y));
      fabEl.style.left = px + 'px';
      fabEl.style.top = py + 'px';
      fabEl.style.right = 'auto';
      fabEl.style.bottom = 'auto';
    }
    root.appendChild(fabEl);

    var mask = document.createElement('div');
    mask.className = 'mask';
    root.appendChild(mask);

    // 面板
    sheetEl = document.createElement('div');
    sheetEl.className = 'sheet';
    sheetEl.innerHTML =
      '<div class="hd"><h3>视频提取</h3><span class="cnt"></span>' +
      '<button data-a="set">设置</button><button data-a="rescan">重扫</button><button data-a="close">收起</button></div>' +
      '<div class="hint">点「播放」用内置播放器 · 点「下载」存到手机</div>' +
      '<div class="list"></div>' +
      '<div class="ft"><button data-a="rec">录制当前画面</button><i class="ver">v' + VERSION + '</i></div>';
    root.appendChild(sheetEl);

    // 设置面板
    setEl = document.createElement('div');
    setEl.className = 'set';
    setEl.innerHTML =
      '<div class="hd"><h3>设置</h3><button data-a="close">完成</button></div>' +
      '<div class="sbody">' +
      '<div class="srow"><span>自动接管网页播放器</span><b class="sw" data-k="autoTakeover"></b></div>' +
      '<div class="srow"><span>记忆播放进度</span><b class="sw" data-k="resume"></b></div>' +
      '<div class="srow"><span>画面手势（拖动/双击/长按/音量亮度）</span><b class="sw" data-k="gestures"></b></div>' +
      '<div class="srow col"><span>跳过片头</span><div class="seg" data-k="skipIntro">' +
      '<button data-v="0">关</button><button data-v="5">5 秒</button><button data-v="10">10 秒</button><button data-v="20">20 秒</button>' +
      '</div></div>' +
      '<div class="srow col"><span>默认倍速</span><div class="seg" data-k="speed">' +
      '<button data-v="1">1.0x</button><button data-v="1.25">1.25x</button><button data-v="1.5">1.5x</button><button data-v="2">2.0x</button>' +
      '</div></div>' +
      '<div class="srow"><span>边看边缓存</span><b class="sw" data-k="segCache"></b></div>' +
      '<div class="srow"><span>缓存占用</span><div class="cwrap"><i class="csz">0 MB</i>' +
      '<button data-a="clearcache" class="mini">清空</button></div></div>' +
      '</div>';
    root.appendChild(setEl);
    listEl = sheetEl.querySelector('.list');

    // 播放器
    playerEl = document.createElement('div');
    playerEl.className = 'pl';
    playerEl.innerHTML =
      '<div class="stage">' +
      '<video playsinline webkit-playsinline preload="auto"></video>' +
      '<canvas class="freeze"></canvas>' +
      '<div class="dim"></div>' +
      '<div class="spin"></div>' +
      '<div class="bigplay"><span class="bp-play">' + ICON.bigplay + '</span><span class="bp-replay">' + ICON.replay + '</span></div>' +
      '<div class="seekpreview"><b>0:00</b><i>+0:00</i><span class="bar"><em></em></span></div>' +
      '</div>' +
      '<div class="top"><button data-a="close">' + ICON.back + '</button><div class="t"></div></div>' +
      '<div class="side">' +
      '<button data-a="dl">' + ICON.dl + '<i>下载</i></button>' +
      '<button data-a="pip">' + ICON.pip + '<i>画中画</i></button>' +
      '<button data-a="list">' + ICON.list + '<i>列表</i></button>' +
      '</div>' +
      '<div class="ctl">' +
      '<div class="seek"><i class="track"></i><i class="buf"></i><i class="bar"></i><b class="knob"></b><span class="tip">0:00</span></div>' +
      '<div class="ctlrow">' +
      '<button data-a="toggle" class="ico">' + ICON.play + '</button>' +
      '<span class="tm">0:00 / 0:00</span>' +
      '<span class="stat"></span>' +
      '<span class="sp"></span>' +
      '<button data-a="speed">1.0x</button>' +
      '<button data-a="q" style="display:none">清晰度</button>' +
      '<button data-a="mute" class="ico">' + ICON.vol + '</button>' +
      '<button data-a="full" class="ico">' + ICON.full + '</button>' +
      '</div></div>' +
      '<div class="pmask"></div>' +
      '<div class="pmenu"><div class="pmt"></div><div class="pmbody"></div></div>';
    root.appendChild(playerEl);
    videoEl = playerEl.querySelector('video');

    // toast + 进度
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    root.appendChild(toastEl);

    progressEl = document.createElement('div');
    progressEl.className = 'pg';
    progressEl.innerHTML =
      '<div class="row"><span class="txt">准备中…</span><button data-a="cancel">取消</button></div>' +
      '<div class="track"><i class="fill"></i></div>';
    root.appendChild(progressEl);

    document.documentElement.appendChild(host);
    ui = { host: host, root: root, mask: mask };

    bindUI();
    return ui;
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function playerOff() { return (hls && hls.ptsOffset) || 0; }
  function curPos() { return Math.max(0, ((videoEl && videoEl.currentTime) || 0) - playerOff()); }

  // ---- 播放进度记忆：同一个地址下次打开接着看 ----
  function posKey(it) {
    var u = (it && it.url) || '';
    return 'xbvk.p:' + u.slice(0, 400);
  }
  function savePlayPos(it, sec) {
    if (!it || !sec || sec < 5) return;
    try {
      localStorage.setItem(posKey(it), String(Math.round(sec)));
      if (++posSavedCount % 25 === 0) prunePlayPos();
    } catch (e) {}
  }

  // 进度记录不能无限涨，超过 150 条就把最早的删掉
  var posSavedCount = 0;
  function prunePlayPos() {
    try {
      var keys = [], i, k;
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        if (k && k.indexOf('xbvk.p:') === 0) keys.push(k);
      }
      if (keys.length <= 150) return;
      for (i = 0; i < keys.length - 120; i++) localStorage.removeItem(keys[i]);
    } catch (e) {}
  }
  function loadPlayPos(it) {
    if (!it) return 0;
    try {
      var v = parseInt(localStorage.getItem(posKey(it)) || '0', 10);
      return (v > 5 && v < 100000) ? v : 0;
    } catch (e) { return 0; }
  }
  function playerDur() {
    var d = videoEl && videoEl.duration;
    if (!d || !isFinite(d) || d <= 0) return 0;
    return Math.max(0, d - playerOff());
  }
  var freezeOn = false;
  function showFreeze() {
    var v = videoEl;
    if (!v || !v.videoWidth || !v.videoHeight || !playerEl) return;
    var c = playerEl.querySelector('.freeze');
    if (!c) return;
    try {
      if (c.width !== v.videoWidth) c.width = v.videoWidth;
      if (c.height !== v.videoHeight) c.height = v.videoHeight;
      var ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      c.style.display = 'block';
      freezeOn = true;
    } catch (e) {}
  }
  function hideFreeze() {
    if (!freezeOn) return;
    freezeOn = false;
    if (!playerEl) return;
    var c = playerEl.querySelector('.freeze');
    if (c) c.style.display = 'none';
  }
  function syncProgress() {
    if (!playerOpen || !playerEl || !videoEl) return;
    if (seekBusy()) return;      // 手指按在进度条上时，播放事件不许改滑块

    var dur = playerDur();
    if (dur > 0) seekUI.lastDur = dur;
    var pos = Math.max(0, (videoEl.currentTime || 0) - playerOff());
    var wasPending = seekUI.pending;

    if (seekUI.pending) {
      var want = seekUI.target;
      var near = dur > 0 && !videoEl.seeking && Math.abs(pos - want) < 1.0;
      if (near || Date.now() - seekUI.pendingAt > 10000) {
        seekUI.pending = false;                   // 到位了（或等太久），恢复跟播放走
      } else {
        // HLS 重建时 duration 会短暂变 NaN；沿用上次已知时长，
        // 别让进度条和“当前时间”一起掉回 0（Video.js 的 pendingSeekTime 同理）
        pos = want;
        dur = dur || seekUI.lastDur;
      }
    }
    if (wasPending && !seekUI.pending) showUI();

    // 片源最后没有完整帧：停在离终点很近的地方、分片又全部下完了，按播完处理
    if (!forcedEnded && hls && hls.finished && !seekUI.pending && dur > 0 &&
        !videoEl.paused && !videoEl.ended && videoEl.readyState < 3 && dur - pos < 0.7) {
      forcedEnded = true;
      try { videoEl.pause(); } catch (e) {}
      showUI();
    }

    var pct = dur ? Math.min(1, Math.max(0, pos / dur)) : 0;

    var bar = playerEl.querySelector('.seek .bar');
    var knob = playerEl.querySelector('.seek .knob');
    if (bar) bar.style.width = (pct * 100).toFixed(2) + '%';
    if (knob) knob.style.left = (pct * 100).toFixed(2) + '%';

    var bufEl = playerEl.querySelector('.seek .buf');
    if (bufEl) {
      var end = 0;
      try {
        var b = videoEl.buffered;
        for (var i = 0; i < b.length; i++) {
          if (b.start(i) <= videoEl.currentTime + 0.6) end = Math.max(end, b.end(i));
        }
      } catch (e) {}
      var bp = dur ? Math.min(1, Math.max(0, (end - playerOff()) / dur)) : 0;
      bufEl.style.width = (bp * 100).toFixed(2) + '%';
    }
    var tm = playerEl.querySelector('.tm');
    if (tm) tm.textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
    var tb = playerEl.querySelector('.ctlrow [data-a="toggle"]');
    if (tb) tb.innerHTML = videoEl.paused ? ICON.play : ICON.pause;
    playerEl.classList.toggle('paused', !!videoEl.paused);
    playerEl.classList.toggle('ended', !!videoEl.ended || forcedEnded);
    if (!seekUI.pending) { seekUI.hard = false; }
    playerEl.classList.toggle('seeking', !!seekUI.pending && (seekUI.hard || !!(hls && (hls.softSeek || hls.restarting))));
    if (!seekUI.pending) hideFreeze();
  }
  function togglePlay() {
    if (!videoEl) return;
    if (forcedEnded) {
      forcedEnded = false;
      try { videoEl.currentTime = playerOff(); } catch (e) {}
    }
    if (videoEl.paused) {
      userPaused = false;
      // 已经播完再点播放，从头来
      if (videoEl.ended) { try { videoEl.currentTime = playerOff(); } catch (e) {} }
      safePlay(videoEl);
    } else {
      userPaused = true;
      try { videoEl.pause(); } catch (e) {}
    }
    setTimeout(syncProgress, 40);
  }
  var uiHideTimer = 0;
  var lastSaveAt = 0;
  var loadTimer = 0;
  var brightVal = 1;   // 画面亮度（0~1），用黑色蒙层模拟

  function applyBright() {
    var d = playerEl && playerEl.querySelector('.dim');
    if (d) d.style.opacity = String(((1 - brightVal) * 0.85).toFixed(3));
  }
  // 进度条交互状态：拖动中、以及松手后等待跳转落地时，进度显示由这里接管。
  // 否则播放中的 timeupdate 会不断把滑块拽回当前位置（Plyr / Video.js 都用同类状态）。
  var seekUI = {
    dragging: false, gesture: false,
    ratio: 0, target: 0,
    pending: false, pendingAt: 0,
    lastDur: 0, touchId: null, lastTouchAt: 0,
    hard: false
  };
  function seekBusy() { return seekUI.dragging || seekUI.gesture; }
  function resetSeekUI() {
    seekUI.dragging = false;
    seekUI.gesture = false;
    seekUI.pending = false;
    seekUI.pendingAt = 0;
    seekUI.ratio = 0;
    seekUI.target = 0;
    seekUI.lastDur = 0;
    seekUI.touchId = null;
    seekUI.hard = false;
    if (playerEl) playerEl.classList.remove('seeking');
    hideFreeze();
  }
  function showUI() {
    if (!playerEl) return;
    playerEl.classList.remove('hideui');
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(function () {
      if (seekBusy() || seekUI.pending || menuOpen) return;   // 拖动/跳转/弹层打开时不要藏控件
      // 只有全屏时才自动隐藏控件；嵌在网页播放框里就常驻，否则用户不知道能点
      if (playerOpen && videoEl && !videoEl.paused && !playerEl.classList.contains('embed')) {
        playerEl.classList.add('hideui');
      }
    }, 3200);
  }

  function fmtSpeed(n) {
    return Number(n).toFixed(2).replace(/0$/, '') + 'x';
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }

  function closeMenus(quiet) {
    menuOpen = false;
    if (playerEl) {
      var m = playerEl.querySelector('.pmenu');
      var mk = playerEl.querySelector('.pmask');
      if (m) m.classList.remove('on');
      if (mk) mk.classList.remove('on');
      var on = playerEl.querySelectorAll('.ctlrow button.on');
      for (var i = 0; i < on.length; i++) on[i].classList.remove('on');
    }
    if (!quiet) showUI();
  }

  function openMenu(kind, anchor) {
    if (!playerEl) return;
    closeMenus(true);
    var menu = playerEl.querySelector('.pmenu');
    var mask = playerEl.querySelector('.pmask');
    var title = playerEl.querySelector('.pmenu .pmt');
    var body = playerEl.querySelector('.pmenu .pmbody');
    if (!menu || !body || !title) return;

    var html = '';
    if (kind === 'speed') {
      title.textContent = '播放速度';
      menu.classList.add('grid');
      for (var i = 0; i < SPEEDS.length; i++) {
        html += '<button data-a="spd" data-v="' + SPEEDS[i] + '"' +
          (i === speedIdx ? ' class="on"' : '') + '>' + fmtSpeed(SPEEDS[i]) + '</button>';
      }
    } else {
      var vs = (hls && hls.variants) || [];
      if (vs.length < 2) return;
      title.textContent = '清晰度';
      menu.classList.remove('grid');
      for (var j = 0; j < vs.length; j++) {
        var lab = (vs[j] && vs[j].label) || ('清晰度 ' + (j + 1));
        html += '<button data-a="qsel" data-v="' + j + '" data-l="' + escHtml(lab) + '"' +
          (j === (hls.variantIndex || 0) ? ' class="on"' : '') + '>' + escHtml(lab) + '</button>';
      }
    }
    body.innerHTML = html;
    menu.classList.add('on');
    if (mask) mask.classList.add('on');
    menuOpen = true;
    if (anchor) anchor.classList.add('on');
    showUI();
  }
  function exitFull() {
    try { if (window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    var ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (!ex) return;
    try {
      // exitFullscreen 返回 Promise，不在全屏时是异步 reject，必须接住
      var p = ex.call(document);
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  var preFullSource = null;   // 进全屏前的嵌入目标，退出全屏要回到原位
  function togglePip() {
    if (!videoEl) return;
    try {
      if (document.pictureInPictureElement) {
        var p0 = document.exitPictureInPicture();
        if (p0 && p0.catch) p0.catch(function () {});
        return;
      }
      if (!videoEl.requestPictureInPicture) { toast('这个浏览器不支持画中画'); return; }
      var p = videoEl.requestPictureInPicture();
      if (p && p.catch) p.catch(function () { toast('画中画打不开（可能要等画面出来）'); });
    } catch (e) { toast('画中画不可用'); }
  }

  // 锁屏/通知栏显示标题
  function setMediaMeta(it) {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (it && it.title) || '视频',
        artist: location.hostname || '',
        album: '视频提取'
      });
    } catch (e) {}
  }

  function toggleFull() {
    var isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFull) { exitFull(); return; }

    // 从"嵌在网页播放框里"切到全屏
    if (playerEl.classList.contains('embed')) {
      preFullSource = embedTarget;
      playerEl.classList.remove('embed');
      playerEl.style.cssText = '';
      embedTarget = null;
      try {
        window.removeEventListener('scroll', syncEmbed, true);
        window.removeEventListener('resize', syncEmbed);
      } catch (e) {}
      syncProgress();
    }

    // 全屏的是整个宿主（而不是播放器本身），这样列表、toast 在全屏下也能看见
    var fsEl = document.getElementById('__xb_video_kit__') || playerEl;
    var req = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen;
    if (req) {
      try { var p = req.call(fsEl); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }
    // 真全屏之后才允许锁横屏，这样视频和手机一起横过来
    setTimeout(function () {
      try {
        if (window.screen && screen.orientation && screen.orientation.lock) {
          var r = screen.orientation.lock('landscape');
          if (r && r.catch) {
            r.catch(function () { toast('这个浏览器不支持自动横屏，请手动旋转手机'); });
          }
        }
      } catch (e) {}
    }, 200);
    showUI();
  }

  function bindUI() {
    // 悬浮球：拖动 + 点击
    // 手指点击几乎必然有 5~10px 抖动，阈值太小会把"点击"误判成"拖动"，
    // 表现就是"点了没反应"。这里用 14px，并以抬手时的实际位移为准。
    var sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    var pressTimer = 0, lastTap = 0;
    var TAP_SLOP = 14;

    function tapFab() {
      var now = Date.now();
      if (now - lastTap < 400) return;      // 防止 touchend + click 双重触发
      lastTap = now;
      if (playerOpen) return;               // 播放器已经开着，别重复起播
      try { quickPlay(); } catch (err) { toast('播放器打不开：' + ((err && err.message) || '未知错误')); }
    }

    function pressStart(x, y) {
      dragging = true; moved = false;
      var r = fabEl.getBoundingClientRect();
      sx = x; sy = y; ox = r.left; oy = r.top;
      fabEl.classList.add('press');
      clearTimeout(pressTimer);
      // 长按打开列表：点一下直接播，长按看全部
      pressTimer = setTimeout(function () {
        if (dragging && !moved) {
          dragging = false;
          fabEl.classList.remove('press');
          lastTap = Date.now();          // 让随后的 tap 被去重挡掉
          try { openSheet(); } catch (err) {}
        }
      }, 550);
    }

    function pressEnd(x, y) {
      clearTimeout(pressTimer);
      fabEl.classList.remove('press');
      if (!dragging) { tapFab(); return; }   // 没收到 touchstart 也当成点击，别把事件丢了
      dragging = false;
      var dx = (x == null) ? 0 : Math.abs(x - sx);
      var dy = (y == null) ? 0 : Math.abs(y - sy);
      if (moved && (dx + dy) > TAP_SLOP) {
        var r = fabEl.getBoundingClientRect();
        savePos(Math.round(r.left), Math.round(r.top));
      } else {
        moved = false;
        tapFab();
      }
    }

    fabEl.addEventListener('touchstart', function (e) {
      if (!e.touches[0]) return;
      pressStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    fabEl.addEventListener('touchmove', function (e) {
      if (!dragging || !e.touches[0]) return;
      var dx = e.touches[0].clientX - sx;
      var dy = e.touches[0].clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > TAP_SLOP) {
        moved = true;
        clearTimeout(pressTimer);
      }
      if (!moved) return;
      var bw = fabEl.offsetWidth || 70, bh = fabEl.offsetHeight || 42;
      var x = Math.max(4, Math.min(window.innerWidth - bw - 4, ox + dx));
      var y = Math.max(4, Math.min(window.innerHeight - bh - 4, oy + dy));
      fabEl.style.left = x + 'px';
      fabEl.style.top = y + 'px';
      fabEl.style.right = 'auto';
      fabEl.style.bottom = 'auto';
      e.preventDefault();
    }, { passive: false });

    fabEl.addEventListener('touchend', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      pressEnd(t ? t.clientX : null, t ? t.clientY : null);
    }, { passive: true });

    fabEl.addEventListener('touchcancel', function () {
      clearTimeout(pressTimer);
      fabEl.classList.remove('press');
      dragging = false;
      moved = false;
    }, { passive: true });

    fabEl.addEventListener('click', function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); return; }
      tapFab();
    });

    // 刚打开时的补发 click 直接忽略，否则面板会被瞬间关掉
    ui.mask.addEventListener('click', function () {
      if (Date.now() < uiGuardUntil) return;
      if (settingsOpen) { closeSettings(); return; }
      closeSheet();
    });

    if (setEl) {
      setEl.addEventListener('click', function (e) {
        if (Date.now() < uiGuardUntil) return;
        var t = e.target;
        if (!t || !t.getAttribute) return;
        if (t.getAttribute('data-a') === 'close') { closeSettings(); return; }
        if (t.getAttribute('data-a') === 'clearcache') {
          segCache.clear();
          segCacheBytes = 0;
          renderSettings();
          toast('缓存已清空');
          return;
        }

        if (t.classList && t.classList.contains('sw')) {
          var k = t.getAttribute('data-k');
          cfg[k] = !cfg[k];
          // 关掉缓存就立刻释放已占的内存
          if (k === 'segCache' && !cfg[k]) {
            segCache.clear();
            segCacheBytes = 0;
          }
          saveCfg(); renderSettings(); applyCfg();
          if (k === 'autoTakeover') toast(cfg.autoTakeover ? '已开启自动接管' : '已关闭自动接管');
          if (k === 'segCache') toast(cfg[k] ? '已开启缓存' : '已关闭缓存，内存已释放');
          return;
        }
        if (t.tagName === 'BUTTON' && t.getAttribute('data-v') !== null &&
            t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('seg')) {
          var kk = t.parentNode.getAttribute('data-k');
          cfg[kk] = Number(t.getAttribute('data-v'));
          saveCfg(); renderSettings(); applyCfg();
        }
      });
    }

    sheetEl.addEventListener('click', function (e) {
      if (Date.now() < uiGuardUntil) return;
      var t = e.target;
      if (!t || t.tagName !== 'BUTTON') return;
      var a = t.getAttribute('data-a');
      if (a === 'close') return closeSheet();
      if (a === 'set') return openSettings();
      if (a === 'rescan') { scanDom(); scanPerf(); toast('已重新扫描'); return; }
      if (a === 'rec') return startRecord();

      var row = t.closest('.it');
      if (!row) return;
      var id = parseInt(row.getAttribute('data-id'), 10);
      var it = null;
      items.forEach(function (v) { if (v.id === id) it = v; });
      if (!it) return;

      var act = t.getAttribute('data-act');
      if (act === 'play') playItem(it);
      else if (act === 'dl') downloadItem(it);
      else if (act === 'copy') copyText(it.url);
    });

    var pmaskEl = playerEl.querySelector('.pmask');
    if (pmaskEl) {
      pmaskEl.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenus();
      });
    }

    playerEl.addEventListener('click', function (e) {
      if (Date.now() < uiGuardUntil) return;
      var el = e.target;
      while (el && el !== playerEl && !(el.getAttribute && el.getAttribute('data-a'))) el = el.parentNode;
      var a = (el && el.getAttribute) ? el.getAttribute('data-a') : null;
      if (!a) return;

      if (a === 'close') closePlayer();
      else if (a === 'list') {
        // 只把播放器藏起来，别销毁 —— 否则收起列表后播放器就没了，还得刷新
        playerHiddenForSheet = true;
        closeMenus(true);
        exitFull();                 // 全屏下底部列表不好看，先退出来
        playerEl.classList.remove('open');
        // 播放器藏了就把网页原来的画面也藏起来，免得列表下面露出原播放器
        try { if (siteVideo) siteVideo.style.visibility = 'hidden'; } catch (e) {}
        openSheet();
      }
      else if (a === 'toggle') togglePlay();
      else if (a === 'full') toggleFull();
      else if (a === 'pip') togglePip();
      else if (a === 'mute') {
        videoEl.muted = !videoEl.muted;
        el.innerHTML = videoEl.muted ? ICON.mute : ICON.vol;
      }
      else if (a === 'speed') {
        openMenu('speed', el);
      } else if (a === 'q') {
        openMenu('quality', el);
      } else if (a === 'spd') {
        var sv = parseFloat(el.getAttribute('data-v'));
        var si = SPEEDS.indexOf(sv);
        if (si >= 0) {
          speedIdx = si;
          try { videoEl.playbackRate = SPEEDS[si]; } catch (e) {}
          var spb = playerEl.querySelector('[data-a="speed"]');
          if (spb) spb.textContent = fmtSpeed(SPEEDS[si]);
          toast('倍速 ' + SPEEDS[si] + 'x');
        }
        closeMenus();
      } else if (a === 'qsel') {
        var qi = parseInt(el.getAttribute('data-v'), 10);
        var qlab = el.getAttribute('data-l') || '';
        closeMenus();
        if (!hls || isNaN(qi) || qi === (hls.variantIndex || 0)) return;
        var qb = playerEl.querySelector('[data-a="q"]');
        if (qb) qb.textContent = qlab || '清晰度';
        toast('切换到 ' + (qlab || '清晰度'));
        hls.switchTo(qi).then(function () {
          if (hls) updateQualityBtn(hls);
        }, function () {
          toast('切换失败');
          if (hls) updateQualityBtn(hls);
        });
      } else if (a === 'dl' && current) {
        // 用户可能在播放器里切过清晰度，下载要跟着当前选中的那一路走
        var dlTarget = current;
        if (hls && hls.url && current.kind === 'hls' && hls.url !== current.url) {
          dlTarget = {};
          for (var dk in current) { if (Object.prototype.hasOwnProperty.call(current, dk)) dlTarget[dk] = current[dk]; }
          dlTarget.url = hls.url;
          var qv = hls.variants && hls.variants[hls.variantIndex];
          if (qv && qv.label) dlTarget.title = current.title + '_' + qv.label;
        }
        downloadItem(dlTarget);
      }
      else if (a === 'copy' && current) copyText(current.url);
    });

    progressEl.addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute('data-a') === 'cancel') {
        if (progressEl.__cancel) progressEl.__cancel();
      }
    });

    // ---- 画面手势：左右拖动快进/快退、双击 ±10s、长按 2 倍速、轻点暂停 ----
    var stage = playerEl.querySelector('.stage');
    var stX = 0, stY = 0, stT = 0, stDrag = false, stTarget = 0, stW = 1, lastTouchAt = 0;
    var tapTimer = 0, lastTapAt = 0, lastTapX = 0, pressTimer = 0, longPress = false;
    var stMode = '', stVol = 1, stBri = 1, stH = 1, stWoke = false;

    function previewAt(target) {
      var el = playerEl.querySelector('.seekpreview');
      if (!el) return;
      el.classList.remove('hud', 'left', 'right');
      var em = el.querySelector('.bar em');
      if (em) em.style.width = '0';
      stTarget = target;
      el.querySelector('b').textContent = fmtTime(target);
      var d = target - stT;
      el.querySelector('i').textContent = (d >= 0 ? '+' : '-') + fmtTime(Math.abs(d));
      el.style.display = 'flex';
    }
    function badge(big, small, side, level) {
      var el = playerEl.querySelector('.seekpreview');
      if (!el) return;
      el.classList.remove('hud', 'left', 'right');
      if (side === 'left' || side === 'right') el.classList.add(side);
      el.querySelector('b').textContent = big;
      el.querySelector('i').textContent = small || '';
      var em = el.querySelector('.bar em');
      if (level != null) {
        el.classList.add('hud');
        if (em) em.style.width = (Math.max(0, Math.min(1, level)) * 100).toFixed(1) + '%';
      } else if (em) em.style.width = '0';
      el.style.display = 'flex';
    }
    function hidePreview() {
      var el = playerEl.querySelector('.seekpreview');
      if (el) el.style.display = 'none';
    }
    function stageTap() {
      if (playerEl.classList.contains('hideui')) { showUI(); return; }
      togglePlay();
      showUI();
    }
    function jumpBy(sec) {
      var dur = playerDur();
      if (!dur) return;
      var t = Math.max(0, Math.min(dur, curPos() + sec));
      commitSeek(dur ? t / dur : 0);
      badge((sec > 0 ? '+' : '') + sec + 's', '');
      setTimeout(hidePreview, 550);
    }

    if (stage) {
      stage.addEventListener('touchstart', function (e) {
        if (Date.now() < uiGuardUntil) return;
        var t0 = e.touches[0];
        if (!t0) return;
        // 控件藏起来时，手指一碰就立刻唤醒（不等双击判定），否则马上拖动会落到画面手势上
        stWoke = playerEl.classList.contains('hideui');
        if (stWoke) showUI();
        stX = t0.clientX; stY = t0.clientY; stT = curPos(); stDrag = false; stTarget = stT;
        stW = stage.getBoundingClientRect().width || 1;
        stH = stage.getBoundingClientRect().height || 1;
        stMode = '';
        stVol = videoEl ? (videoEl.muted ? 0 : videoEl.volume) : 1;
        stBri = brightVal;
        longPress = false;
        clearTimeout(pressTimer);
        // 长按加速（手势关闭时不启用）
        if (cfg.gestures) {
          pressTimer = setTimeout(function () {
            if (stDrag || longPress || !videoEl || videoEl.paused) return;
            longPress = true;
            try { videoEl.playbackRate = 2; } catch (e) {}
            badge('2x', '倍速中，松手恢复');
          }, 480);
        }
      }, { passive: true });

      stage.addEventListener('touchmove', function (e) {
        if (Date.now() < uiGuardUntil) return;
        if (!cfg.gestures) return;
        var t0 = e.touches[0];
        if (!t0) return;
        var dx = t0.clientX - stX;
        var dy = t0.clientY - stY;

        // 第一次明显移动时决定这次是"横向找进度"还是"纵向调音量/亮度"
        if (!stMode) {
          // 嵌在网页里时纵向留给页面滚动，只有全屏才启用音量/亮度
          var allowVB = !playerEl.classList.contains('embed');
          if (Math.abs(dx) > 16 && Math.abs(dx) >= Math.abs(dy)) {
            stMode = 'seek';
            clearTimeout(pressTimer);
            // 画面横拖同样由 seekUI 接管进度显示，防止播放事件把预览位置拽回去
            seekUI.pending = false;
            seekUI.gesture = true;
            showUI();
          } else if (allowVB && Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx)) {
            stMode = stX < stW / 2 ? 'bri' : 'vol';
            clearTimeout(pressTimer);
          }
        }
        if (!stMode) return;

        if (stMode === 'seek') {
          stDrag = true;
          var dur = playerDur();
          if (!dur) { seekUI.gesture = false; return; }
          // 一个屏幕宽度大约对应 180 秒，长片也不会太灵敏
          var span = Math.min(dur, 180);
          previewAt(Math.max(0, Math.min(dur, stT + (dx / stW) * span)));
          paintSeek(stTarget / dur);   // 进度条跟着手势走（分片预取也在里面）
        } else if (stMode === 'vol') {
          var v = Math.max(0, Math.min(1, stVol - dy / (stH * 0.7)));
          try { videoEl.volume = v; videoEl.muted = false; } catch (err) {}
          badge(Math.round(v * 100) + '%', '音量', 'right', v);
        } else if (stMode === 'bri') {
          brightVal = Math.max(0, Math.min(1, stBri - dy / (stH * 0.7)));
          applyBright();
          badge(Math.round(brightVal * 100) + '%', '亮度', 'left', brightVal);
        }
        e.preventDefault();
      }, { passive: false });

      stage.addEventListener('touchend', function (e) {
        clearTimeout(pressTimer);
        lastTouchAt = Date.now();

        if (longPress) {
          longPress = false;
          try { videoEl.playbackRate = SPEEDS[speedIdx]; } catch (e) {}
          hidePreview();
          return;
        }
        if (stDrag) {
          stDrag = false;
          stMode = '';
          hidePreview();
          var dur = playerDur();
          if (dur) commitSeek(Math.max(0, Math.min(1, stTarget / dur)));
          else { seekUI.gesture = false; syncProgress(); }
          return;
        }
        // 调音量/亮度结束，不算点击
        if (stMode === 'vol' || stMode === 'bri') {
          stMode = '';
          hidePreview();
          return;
        }
        stMode = '';

        var t0 = e.changedTouches && e.changedTouches[0];
        var x = t0 ? t0.clientX : stX;
        var now = Date.now();

        // 双击左右两侧快退/快进 10 秒
        if (cfg.gestures && now - lastTapAt < 300 && Math.abs(x - lastTapX) < 70) {
          clearTimeout(tapTimer);
          lastTapAt = 0;
          var r = stage.getBoundingClientRect();
          var rel = (x - r.left) / (r.width || 1);
          if (rel < 0.35) jumpBy(-10);
          else if (rel > 0.65) jumpBy(10);
          else { togglePlay(); showUI(); }
          return;
        }
        lastTapAt = now; lastTapX = x;
        clearTimeout(tapTimer);
        // 这一下只是把控件唤醒，不再触发暂停/播放
        if (stWoke) { stWoke = false; return; }
        tapTimer = setTimeout(function () { stageTap(); }, 260);   // 等一下看是不是双击
      });

      stage.addEventListener('touchcancel', function () {
        clearTimeout(pressTimer);
        if (longPress) {
          longPress = false;
          try { videoEl.playbackRate = SPEEDS[speedIdx]; } catch (e) {}
        }
        stDrag = false;
        stMode = '';
        stWoke = false;
        hidePreview();
        if (seekUI.gesture) { seekUI.gesture = false; syncProgress(); showUI(); }
      });

      // 鼠标/桌面：touch 已经处理过的 600ms 内不再响应，避免重复
      stage.addEventListener('click', function () {
        if (Date.now() < uiGuardUntil) return;
        if (Date.now() - lastTouchAt < 600) return;
        stageTap();
      });
    }

    var seekBar = playerEl.querySelector('.seek');

    function seekRatioAt(x) {
      var r = seekBar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)));
    }
    function paintSeek(ratio) {
      ratio = Math.max(0, Math.min(1, ratio));
      var dur = playerDur();
      if (dur > 0) seekUI.lastDur = dur;
      var shownDur = dur || seekUI.lastDur;
      seekUI.ratio = ratio;
      seekUI.target = ratio * shownDur;
      var bar = playerEl.querySelector('.seek .bar');
      var knob = playerEl.querySelector('.seek .knob');
      if (bar) bar.style.width = (ratio * 100).toFixed(2) + '%';
      if (knob) knob.style.left = (ratio * 100).toFixed(2) + '%';
      if (seekBar) seekBar.classList.toggle('on', !!seekUI.dragging);
      var tip = playerEl.querySelector('.seek .tip');
      if (tip) {
        tip.textContent = fmtTime(seekUI.target);
        tip.style.left = (Math.max(0.06, Math.min(0.94, ratio)) * 100).toFixed(2) + '%';
      }
      var tm = playerEl.querySelector('.tm');
      if (tm) tm.textContent = fmtTime(seekUI.target) + ' / ' + fmtTime(shownDur);
      // 拖动时预取目标分片，松手就能立刻出画
      if (hls && seekUI.target) hls.prefetchAt(seekUI.target);
    }
    function commitSeek(ratio) {
      var dur = playerDur() || seekUI.lastDur;
      if (!dur) {
        seekUI.dragging = false; seekUI.gesture = false;
        seekUI.touchId = null; seekUI.pending = false;
        syncProgress();
        return;
      }
      forcedEnded = false;
      if (playerEl) playerEl.classList.remove('ended');
      var t = Math.max(0, Math.min(dur, ratio * dur));
      // 拖到最末尾时别往没有完整帧的尾部钻，留一点让它自然播完（直播不这样处理）
      if ((!hls || hls.endlist) && dur > 1 && dur - t < 0.35) t = Math.max(0, dur - 0.35);
      seekUI.dragging = false;
      seekUI.gesture = false;
      seekUI.touchId = null;
      seekUI.ratio = t / dur;
      seekUI.target = t;
      seekUI.pending = true;
      seekUI.pendingAt = Date.now();
      seekUI.lastDur = dur;
      // 目标不在现有缓冲里：先把当前画面冻住，重建/补数据期间不黑屏
      seekUI.hard = !isBuffered(videoEl, t + playerOff());
      if (seekUI.hard) {
        if (playerEl) playerEl.classList.add('seeking');
        showFreeze();
      } else if (playerEl) playerEl.classList.remove('seeking');
      paintSeek(seekUI.ratio);
      var cur = Math.max(0, (videoEl.currentTime || 0) - playerOff());
      if (Math.abs(cur - t) < 0.2 && !videoEl.seeking) {
        seekUI.pending = false;                    // 点的就是当前位置，不用真跳
      } else if (hls && hls.seekTo) {
        hls.seekTo(t);
      } else {
        try { videoEl.currentTime = t; } catch (e) {}
      }
      showUI();
      if (!seekUI.pending) syncProgress();
    }
    function seekDragStart(x) {
      if (seekUI.dragging) return false;
      if (!playerDur() && !seekUI.lastDur) return false;
      seekUI.dragging = true;
      seekUI.pending = false;
      seekUI.hard = false;
      forcedEnded = false;
      if (playerEl) playerEl.classList.remove('ended');
      seekUI.ratio = seekRatioAt(x);
      if (playerEl) playerEl.classList.remove('seeking');
      hideFreeze();
      showUI();
      paintSeek(seekUI.ratio);
      return true;
    }
    function seekDragEnd(commit, x) {
      if (!seekUI.dragging) return;
      if (x != null) paintSeek(seekRatioAt(x));
      seekUI.dragging = false;
      seekUI.touchId = null;
      if (seekBar) seekBar.classList.remove('on');
      if (commit) commitSeek(seekUI.ratio);
      else { seekUI.pending = false; syncProgress(); showUI(); }
    }
    function touchById(list, id) {
      if (!list) return null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
      return (id == null && list.length) ? list[0] : null;
    }
    if (seekBar) {
      seekBar.addEventListener('touchstart', function (e) {
        if (e.touches.length > 1) return;
        var t0 = e.touches[0];
        if (!t0) return;
        seekUI.lastTouchAt = Date.now();
        seekUI.touchId = t0.identifier;
        if (!seekDragStart(t0.clientX)) return;
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
      seekBar.addEventListener('touchmove', function (e) {
        if (!seekUI.dragging) return;
        var t0 = touchById(e.touches, seekUI.touchId);
        if (!t0) return;
        paintSeek(seekRatioAt(t0.clientX));
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
      seekBar.addEventListener('touchend', function (e) {
        if (!seekUI.dragging) return;
        seekUI.lastTouchAt = Date.now();
        var t0 = touchById(e.changedTouches, seekUI.touchId);
        if (!t0) return;                           // 抬的是另一根手指
        seekDragEnd(true, t0.clientX);
      });
      seekBar.addEventListener('touchcancel', function () {
        if (!seekUI.dragging) return;
        seekUI.lastTouchAt = Date.now();
        seekDragEnd(false);                        // 被系统打断：还原，不提交
      });
      seekBar.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (Date.now() - seekUI.lastTouchAt < 700) return;   // 触屏后的合成鼠标事件
        if (!seekDragStart(e.clientX)) return;
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!seekUI.dragging) return;
        if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
          seekDragEnd(false);                      // 在窗口外松开了，别卡在拖动态
          return;
        }
        paintSeek(seekRatioAt(e.clientX));
      });
      window.addEventListener('mouseup', function (e) {
        if (!seekUI.dragging) return;
        seekDragEnd(true, e.clientX);
      });
      window.addEventListener('blur', function () {
        if (seekUI.dragging) seekDragEnd(false);
      });
    }

    var evs = ['timeupdate', 'progress', 'durationchange', 'play', 'pause', 'loadedmetadata', 'seeked', 'waiting', 'stalled'];
    for (var ei = 0; ei < evs.length; ei++) {
      videoEl.addEventListener(evs[ei], function () { syncProgress(); });
    }

    // 锁屏 / 通知栏 / 耳机按键
    if (navigator.mediaSession) {
      try {
        var ms = navigator.mediaSession;
        ms.setActionHandler('play', function () { userPaused = false; if (videoEl) safePlay(videoEl); });
        ms.setActionHandler('pause', function () { userPaused = true; try { videoEl.pause(); } catch (e) {} });
        ms.setActionHandler('seekbackward', function () { jumpBy(-10); });
        ms.setActionHandler('seekforward', function () { jumpBy(10); });
        ms.setActionHandler('seekto', function (d) {
          if (!d || d.seekTime == null) return;
          var dd = playerDur();
          if (dd) commitSeek(Math.max(0, Math.min(1, d.seekTime / dd)));
        });
      } catch (e) {}
    }

    // "缓冲中…" 可能因为没触发 playing 而一直挂着，多几个清除时机
    var clearBufText = function () {
      var st = playerEl && playerEl.querySelector('.stat');
      if (st && st.textContent === '缓冲中…') st.textContent = '';
    };
    videoEl.addEventListener('seeked', clearBufText);
    videoEl.addEventListener('timeupdate', function () {
      if (!videoEl.paused) clearBufText();
    });

    // 记住看到哪了：暂停时、以及播放中每 6 秒存一次
    videoEl.addEventListener('pause', function () {
      if (current) savePlayPos(current, curPos());
      if (playerEl && !(hls && hls.restarting) && !seekUI.pending) playerEl.classList.remove('buffering');
      // 暂停/播完时把控件亮出来（B 站也是暂停即显示控制栏）
      if (playerOpen) showUI();
    });
    videoEl.addEventListener('timeupdate', function () {
      if (!current) return;
      if (Date.now() - lastSaveAt < 6000) return;
      lastSaveAt = Date.now();
      savePlayPos(current, curPos());
    });

    // 换源后倍速会被重置，播放时补回来
    videoEl.addEventListener('play', function () {
      userPaused = false;
      forcedEnded = false;
      try { videoEl.playbackRate = SPEEDS[speedIdx]; } catch (e) {}
    });

    // 退出全屏（含系统返回手势）后，回到网页播放框原来的位置
    var onFsChange = function () {
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      if (!playerOpen || !preFullSource) return;
      var src = preFullSource;
      preFullSource = null;
      applyEmbed(src);
      syncProgress();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // 静音状态跟着实际状态走（自动播放被限制时会被强制静音）
    videoEl.addEventListener('volumechange', function () {
      var mb = playerEl.querySelector('[data-a="mute"]');
      if (mb) mb.innerHTML = videoEl.muted ? ICON.mute : ICON.vol;
    });

    // 内置播放器真的出画了，才把网页原来的播放器藏起来（没出画就不动它）
    videoEl.addEventListener('playing', function () {
      if (playerEl) {
        playerEl.classList.remove('loading');
        playerEl.classList.remove('buffering');
      }
      hideFreeze();
      clearTimeout(loadTimer);
      var st0 = playerEl && playerEl.querySelector('.stat');
      if (st0 && st0.textContent === '缓冲中…') st0.textContent = '';
      if (hls) { hls.retried = false; hls.everPlayed = true; hls.recover = 0; hls.hardRetried = false; }
      if (!playerOpen || !siteVideo) return;
      try {
        siteVideo.pause();
        siteVideo.style.visibility = 'hidden';
      } catch (e) {}
    });

    // 缓冲/跳转中的视觉状态：转圈 + 冻住最后一帧，别让用户以为暂停了
    videoEl.addEventListener('waiting', function () {
      if (playerOpen && !videoEl.paused && playerEl) playerEl.classList.add('buffering');
    });
    videoEl.addEventListener('canplay', function () {
      if (playerEl && videoEl.readyState >= 3) playerEl.classList.remove('buffering');
      if (!seekUI.pending) hideFreeze();
    });
    videoEl.addEventListener('loadeddata', function () {
      if (!seekUI.pending) hideFreeze();
    });
    videoEl.addEventListener('seeked', function () {
      if (!seekUI.pending) hideFreeze();
    });

    // 地址失效 / 编码不支持：先尝试自己修一次，修不好再退回网页播放
    videoEl.addEventListener('error', function () {
      if (!playerOpen) return;
      var e = videoEl.error;
      if (!e) return;

      // 跳转/重建过程中的瞬时报错交给 seek 流程处理（它会重试或回退重建），
      // 否则会被误判成"编码不支持"把播放器关掉
      if (hls && (hls.softSeek || hls.restarting || (seekUI.pending && Date.now() - seekUI.pendingAt < 5000))) return;

      // 解码类错误（3/4）多半是跳转后时间轴错乱，先自己修，别急着销毁播放器
      if ((e.code === 3 || e.code === 4) && hls) {
        var at = hls.pendingSeek != null ? hls.pendingSeek : Math.max(0, curPos());
        // 第一步：如果现在是"直接吃 mp2t"，换成自己转封装
        if (!hls.transmux && !hls.triedTransmux) {
          hls.triedTransmux = true;
          toast('换个解码方式…');
          hls.forceTransmux(at).catch(function () {});
          return;
        }
        // 第二步：已经正常播过的，只在原地重建，绝不关掉播放器
        if (hls.everPlayed) {
          if ((hls.recover || 0) < 3) {
            hls.recover = (hls.recover || 0) + 1;
            toast('画面出错，正在恢复…');
            hls.reloadAt(at).catch(function () {});
            return;
          }
          toast('播放出错，拖一下进度条可以重试');
          return;
        }
        // 第三步：刚打开就失败，再重建一次
        if (!hls.retried) {
          hls.retried = true;
          hls.reloadAt(at).catch(function () {});
          return;
        }
      }

      var why = e.code === 4 ? '地址不可用或格式不支持'
        : e.code === 3 ? '解码失败'
        : e.code === 2 ? '网络错误'
        : '播放出错 ' + e.code;
      if (playerEl) playerEl.classList.remove('loading');
      var host = '';
      try { host = new URL((current && current.url) || videoEl.src || '').host; } catch (err) {}
      var msg = '放不了：' + why + (host ? '（' + host + '）' : '');
      var t = playerEl.querySelector('.t');
      if (t) t.textContent = msg;
      toast(msg + '，稍后返回网页播放');
      setTimeout(function () { if (playerOpen) closePlayer(); }, 4000);
    });
  }

  function ensureFab() {
    if (!IS_TOP) return;
    buildUI();
    if (!fabEl) return;
    var n = items.size;
    var show = !playerOpen && !sheetOpen && (n > 0 || hasMse || hasVideoEl);
    var sig = (show ? '1' : '0') + '|' + n;     // 状态没变就别碰样式，省掉每轮的样式重算
    if (sig === fabState) return;
    fabState = sig;
    var dot = fabEl.querySelector('.dot');
    if (dot) dot.textContent = n > 99 ? '99+' : String(n);
    fabEl.classList.toggle('has', n > 0);
    fabEl.style.display = show ? 'flex' : 'none';
    if (show) {
      helloOnce();
      if (n > 0) showFabTip();
    }
  }

  // 第一次出现时告诉用户这个球是干嘛的，之后不再打扰
  var fabTipped = false;
  function showFabTip() {
    if (!fabEl || fabTipped) return;
    fabTipped = true;
    try { if (localStorage.getItem('xbvk.tipped') === '1') return; } catch (e) {}

    var tip = fabEl.querySelector('.tip');
    if (tip) {
      var r = fabEl.getBoundingClientRect();
      if (r.top < 80) tip.className = 'tip b';   // 球贴近顶部时气泡改到下方
    }
    fabEl.classList.add('tipon');
    setTimeout(function () { if (fabEl) fabEl.classList.remove('tipon'); }, 9000);
  }

  // 装好/升级后弹一次原生提示：alert 不受页面样式和层级影响，能弹出来就说明脚本真的在跑
  function helloOnce() {
    try {
      if (localStorage.getItem('xbvk.hello') === VERSION) return;
      localStorage.setItem('xbvk.hello', VERSION);
    } catch (e) { return; }
    setTimeout(function () {
      try {
        alert('视频提取 v' + VERSION + ' 已启动\n\n' +
          '· 网页开始播放时，自动用内置播放器接管那块画面\n' +
          '· 右下角「视频」按钮：点一下全屏播放，长按看列表\n\n' +
          '看到这个弹窗，说明脚本运行正常。');
      } catch (e) {}
    }, 1500);
  }

  // 界面没显示出来时用原生弹窗报状态，绕开所有样式问题
  var visWarned = false;
  function ensureVisible(el, tag) {
    setTimeout(function () {
      if (visWarned || !el) return;
      var r = null, disp = '';
      try { r = el.getBoundingClientRect(); disp = getComputedStyle(el).display; } catch (e) {}
      if (!r) return;
      var ok = r.height > 40 && r.width > 40 && r.bottom > 20 && r.top < (window.innerHeight - 20) && disp !== 'none';
      if (ok) return;
      visWarned = true;
      try {
        alert('界面没有正常显示（' + tag + '）\n\n' +
          '尺寸 ' + Math.round(r.width) + '×' + Math.round(r.height) +
          '，位置 ' + Math.round(r.left) + ',' + Math.round(r.top) +
          '，display ' + disp +
          '\n视口 ' + window.innerWidth + '×' + window.innerHeight +
          '\n\n把这张截图发给我。');
      } catch (e) {}
    }, 700);
  }

  function openSheet() {
    buildUI();
    if (!sheetEl) return;
    if (fabEl) {
      fabEl.classList.remove('tipon');
      try { localStorage.setItem('xbvk.tipped', '1'); } catch (e) {}
    }
    scanDom();
    sheetOpen = true;
    uiGuardUntil = Date.now() + 450;   // 吃掉 touchend 之后补发的那次 click
    renderList();
    sheetEl.classList.add('open');
    ui.mask.classList.add('on');
    ensureFab();
    ensureVisible(sheetEl, '面板');
  }

  function renderSettings() {
    if (!setEl) return;
    var sws = setEl.querySelectorAll('.sw');
    for (var i = 0; i < sws.length; i++) {
      sws[i].classList.toggle('on', !!cfg[sws[i].getAttribute('data-k')]);
    }
    var segs = setEl.querySelectorAll('.seg');
    for (var j = 0; j < segs.length; j++) {
      var k = segs[j].getAttribute('data-k');
      var bs = segs[j].querySelectorAll('button');
      for (var n = 0; n < bs.length; n++) {
        bs[n].classList.toggle('on', Number(bs[n].getAttribute('data-v')) === Number(cfg[k]));
      }
    }
    var csz = setEl.querySelector('.csz');
    if (csz) csz.textContent = (segCacheBytes / 1048576).toFixed(1) + ' MB';
  }

  function applyCfg() {
    var idx = SPEEDS.indexOf(Number(cfg.speed));
    if (idx >= 0) speedIdx = idx;
    if (playerOpen && videoEl && !videoEl.paused) {
      try { videoEl.playbackRate = SPEEDS[speedIdx]; } catch (e) {}
    }
    var spb = playerEl && playerEl.querySelector('[data-a="speed"]');
    if (spb) spb.textContent = fmtSpeed(SPEEDS[speedIdx]);
  }

  function openSettings() {
    buildUI();
    if (!setEl) return;
    settingsOpen = true;
    renderSettings();
    setEl.classList.add('open');
    ui.mask.classList.add('on');
    uiGuardUntil = Date.now() + 320;
  }

  function closeSettings() {
    if (!setEl) return;
    settingsOpen = false;
    setEl.classList.remove('open');
    if (!sheetOpen) ui.mask.classList.remove('on');
  }

  function closeSheet() {
    if (!sheetEl) return;
    if (settingsOpen) closeSettings();
    sheetOpen = false;
    sheetEl.classList.remove('open');
    ui.mask.classList.remove('on');
    // 是从播放器点「列表」进来的，收起列表后把播放器放回去
    if (playerHiddenForSheet && playerOpen) {
      playerHiddenForSheet = false;
      playerEl.classList.add('open');
      syncProgress();
    }
    ensureFab();
  }

  var renderPending = false;
  // 面板开着时，一帧内的多次变更合并成一次重排
  function scheduleRender() {
    if (!sheetOpen || renderPending) return;
    renderPending = true;
    var run = function () {
      renderPending = false;
      if (sheetOpen) renderList();
    };
    try { window.requestAnimationFrame(run); } catch (e) { setTimeout(run, 16); }
  }

  function renderList() {
    if (!listEl) return;
    listDirty = false;
    var arr = sortedItems();
    var cnt = sheetEl.querySelector('.cnt');
    if (cnt) cnt.textContent = arr.length ? arr.length + ' 个' : '';

    if (!arr.length) {
      listEl.innerHTML = '';
      var d = document.createElement('div');
      d.className = 'empty';
      var msg;
      if (hasVideoEl) msg = '<b>页面里有视频，但还没拿到地址</b><br>先在页面里点一下播放，再回来看看';
      else if (hasMse) msg = '<b>这是 MSE 流，抓不到直链</b><br>可以用下面的「录制当前画面」';
      else msg = '<b>这个页面暂时没有视频</b><br>换个页面，或者点下面重新扫一次';
      d.innerHTML = msg + '<br><button data-a="rescan" class="mini">重新扫描</button>';
      listEl.appendChild(d);
      return;
    }

    listEl.innerHTML = '';
    for (var i = 0; i < arr.length; i++) {
      listEl.appendChild(renderItem(arr[i]));
    }
  }

  function renderItem(it) {
    var row = document.createElement('div');
    row.className = 'it';
    row.setAttribute('data-id', String(it.id));

    var label = it.kind === 'hls' ? 'HLS' : it.kind === 'dash' ? 'DASH'
      : it.kind === 'blob' ? 'BLOB' : it.kind === 'flv' ? 'FLV'
      : it.kind === 'ts' ? 'TS' : it.kind === 'webm' ? 'WEBM' : 'MP4';

    var r1 = document.createElement('div');
    r1.className = 'r1';
    var b = document.createElement('span');
    b.className = 'badge' + (it.kind === 'hls' ? ' hls' : '');
    b.textContent = label;
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.title;
    r1.appendChild(b);
    r1.appendChild(nm);
    if (it.size) {
      var sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = fmtBytes(it.size);
      r1.appendChild(sz);
    }
    row.appendChild(r1);

    var u = document.createElement('div');
    u.className = 'u';
    u.textContent = it.url;
    row.appendChild(u);

    var acts = document.createElement('div');
    acts.className = 'acts';

    var playable = (it.kind !== 'dash');
    var pb = document.createElement('button');
    pb.className = playable ? 'pri' : '';
    pb.setAttribute('data-act', 'play');
    pb.textContent = playable ? '播放' : '不支持';
    if (!playable) pb.disabled = true;
    acts.appendChild(pb);

    var db = document.createElement('button');
    db.setAttribute('data-act', 'dl');
    db.textContent = '下载';
    acts.appendChild(db);

    var cb = document.createElement('button');
    cb.setAttribute('data-act', 'copy');
    cb.textContent = '复制';
    acts.appendChild(cb);

    row.appendChild(acts);
    return row;
  }

  var toastTimer = null;
  function toast(msg) {
    buildUI();
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2600);
  }

  function showProgress(title) {
    buildUI();
    progressEl.classList.add('on');
    var txt = progressEl.querySelector('.txt');
    var fill = progressEl.querySelector('.fill');
    txt.textContent = title;
    fill.style.width = '0%';
    var obj = {
      cancelled: false,
      onCancel: null,
      set: function (t) { txt.textContent = t; },
      progress: function (cur, total) {
        var p = total ? Math.min(100, cur / total * 100) : 0;
        fill.style.width = p.toFixed(1) + '%';
        txt.textContent = title + '  ' + cur + '/' + total;
      },
      close: function () { progressEl.classList.remove('on'); progressEl.__cancel = null; }
    };
    progressEl.__cancel = function () {
      obj.cancelled = true;
      txt.textContent = '正在取消…';
      if (typeof obj.onCancel === 'function') { try { obj.onCancel(); } catch (e) {} }
    };
    return obj;
  }

  /* ------------------------------------------------------------------ *
   *  播放器
   * ------------------------------------------------------------------ */

  // 嵌入位置不能超出视口（有的网站视频框比屏幕还高，横屏时尤其明显）
  function embedRect(r) {
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    var L = Math.max(0, Math.min(r.left, Math.max(0, vw - 120)));
    var T = Math.max(0, Math.min(r.top, Math.max(0, vh - 120)));
    return {
      left: L,
      top: T,
      width: Math.max(120, Math.min(r.width, vw - L)),
      height: Math.max(90, Math.min(r.height, vh - T))
    };
  }

  // 把播放器摆到网页播放框的位置上（可重复调用，监听不会重复注册）
  function applyEmbed(src) {
    if (!src) return false;
    var r;
    try { r = src.getBoundingClientRect ? src.getBoundingClientRect() : src; } catch (e) { return false; }
    if (!r || r.width < 40 || r.height < 30) return false;
    var er = embedRect(r);
    playerEl.classList.add('embed');
    playerEl.style.left = er.left + 'px';
    playerEl.style.top = er.top + 'px';
    playerEl.style.width = er.width + 'px';
    playerEl.style.height = er.height + 'px';
    playerEl.style.right = 'auto';
    playerEl.style.bottom = 'auto';
    embedTarget = src.getBoundingClientRect ? src : null;
    window.removeEventListener('scroll', syncEmbed, true);
    window.removeEventListener('resize', syncEmbed);
    window.addEventListener('scroll', syncEmbed, { passive: true, capture: true });
    window.addEventListener('resize', syncEmbed);
    return true;
  }

  function openPlayer(title, rect) {
    buildUI();
    playerOpen = true;
    resetSeekUI();
    closeMenus(true);
    userPaused = false;
    forcedEnded = false;
    playerEl.classList.remove('ended');
    var spb0 = playerEl.querySelector('[data-a="speed"]');
    if (spb0) spb0.textContent = fmtSpeed(SPEEDS[speedIdx]);
    playerHiddenForSheet = false;
    // 加载中先透出网页原本的画面，别一上来就黑屏
    playerEl.classList.add('loading');
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      // 12 秒还没出画：恢复控件让人能关闭/重试，但继续转圈并藏住大播放键
      if (playerEl && playerEl.classList.contains('loading')) {
        playerEl.classList.remove('loading');
        playerEl.classList.add('buffering');
      }
    }, 12000);
    uiGuardUntil = Date.now() + 450;
    playerEl.classList.add('open');
    playerEl.querySelector('.t').textContent = title || '';
    var qb = playerEl.querySelector('[data-a="q"]');
    if (qb) qb.style.display = 'none';

    // 传了 rect 就"嵌入"到网页原来的播放框位置，而不是全屏盖住
    if (rect && rect.width > 40 && rect.height > 30) {
      if (applyEmbed(rect.source || rect) && rect.source) {
        try { rect.source.pause(); } catch (e) {}   // 别两个声音一起响
      }
    } else {
      playerEl.classList.remove('embed');
      playerEl.style.cssText = '';
      embedTarget = null;
    }

    if (sheetEl) {
      sheetOpen = false;
      sheetEl.classList.remove('open');
      ui.mask.classList.remove('on');
    }
    ensureFab();
    ensureVisible(playerEl, '播放器');
    syncProgress();
    showUI();
  }

  // 嵌入模式下跟着网页滚动/缩放走
  var embedTarget = null;
  function syncEmbed() {
    if (!playerOpen || !embedTarget || !embedTarget.getBoundingClientRect) return;
    try {
      var r = embedTarget.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) return;
      var er = embedRect(r);
      playerEl.style.left = er.left + 'px';
      playerEl.style.top = er.top + 'px';
      playerEl.style.width = er.width + 'px';
      playerEl.style.height = er.height + 'px';
    } catch (e) {}
  }

  function closePlayer() {
    if (current) savePlayPos(current, curPos());
    resetSeekUI();
    closeMenus(true);
    userPaused = false;
    forcedEnded = false;
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (e) {}
    exitFull();
    preFullSource = null;
    clearTimeout(uiHideTimer);
    clearTimeout(loadTimer);
    playerEl.classList.remove('hideui');
    playerEl.classList.remove('paused');
    playerEl.classList.remove('ended');
    playerEl.classList.remove('loading');
    playerEl.classList.remove('seeking');
    playerEl.classList.remove('buffering');
    hideFreeze();
    playerEl.classList.remove('open');
    playerEl.classList.remove('embed');
    playerEl.style.cssText = '';
    embedTarget = null;
    try {
      window.removeEventListener('scroll', syncEmbed, true);
      window.removeEventListener('resize', syncEmbed);
    } catch (e) {}
    restoreSiteVideo();
    playerOpen = false;
    current = null;
    ensureFab();
  }

  function safePlay(v) {
    if (!v) return;
    var p;
    try { p = v.play(); } catch (e) { return; }
    if (!p || !p.catch) return;
    p.catch(function (e) {
      if (e && e.name === 'NotAllowedError') {
        try {
          v.muted = true;
          var p2 = v.play();
          if (p2 && p2.catch) p2.catch(function () {});
          toast('内核限制了自动播放，已静音播放（可点音量开启声音）');
        } catch (err) {}
      }
    });
  }

  function updateQualityBtn(inst) {
    var btn = playerEl && playerEl.querySelector('[data-a="q"]');
    if (!btn) return;
    var vs = (inst && inst.variants) || [];
    if (vs.length < 2) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    var v = vs[inst.variantIndex || 0];
    btn.textContent = (v && v.label) || '清晰度';
  }

  // 点球直接播：优先用内置播放器，实在放不了再退回网页自带的播放
  function quickPlay() {
    var arr = sortedItems();
    var pick = null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].kind === 'dash') continue;    // DASH 内置放不了，跳过
      pick = arr[i];
      break;
    }
    if (!pick) { openSheet(); return; }        // 没有可播的，退回列表说明原因
    playItem(pick);
  }

  // 网页自己的播放器一开播，就用内置播放器接管这块画面（自动接管失败时的兜底）
  function tryTakeover(v) {
    if (takeoverTried || playerOpen || !IS_TOP) return;
    if (!v || v === videoEl || v.tagName !== 'VIDEO') return;
    if (v.videoWidth && v.videoWidth < 200) return;        // 小窗/贴片广告不接管

    var r;
    try { r = v.getBoundingClientRect(); } catch (e) { return; }
    if (!r || r.width < 160 || r.height < 90) return;      // 太小的播放框不动

    var it = pickPlayable(v);
    if (!it) return;                                       // 没得换，就让网页自己播

    takeoverTried = true;
    siteVideo = v;
    try { siteWasPlaying = !v.paused; v.pause(); } catch (e) {}
    playItem(it, { left: r.left, top: r.top, width: r.width, height: r.height, source: v });
  }

  // 找一个能播的源：优先和这个 video 的地址对得上的，其次是最优 HLS
  function pickPlayable(v) {
    var url = (v && (v.currentSrc || v.src)) || '';
    if (url && /^https?:/i.test(url)) {
      var hit = items.get(absolutize(url));
      if (hit) return hit;
    }
    var arr = sortedItems();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].kind === 'hls' && arr[i].score >= 50) return arr[i];
    }
    return null;
  }

  // 像 QQ 浏览器那样：检测到页面主播放器就直接换成我们的，不用点任何东西
  var autoTakeoverTimer = 0;
  function scheduleAutoTakeover() {
    if (!cfg.autoTakeover) return;
    if (takeoverTried || playerOpen || !IS_TOP || autoTakeoverTimer) return;
    autoTakeoverTimer = setTimeout(function () {
      autoTakeoverTimer = 0;
      autoTakeoverNow();
    }, 900);
  }

  function autoTakeoverNow() {
    if (takeoverTried || playerOpen || !IS_TOP) return;

    var vids = collectVideos(document);
    var best = null, bestArea = 0, bestRect = null;
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (v === videoEl) continue;
      var r;
      try { r = v.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || r.width < 260 || r.height < 140) continue;              // 小窗不动
      if (r.bottom < 60 || r.top > window.innerHeight - 60) continue;    // 必须在可视区
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; bestRect = r; }
    }
    if (!best) return;

    var it = pickPlayable(best);
    if (!it) return;

    takeoverTried = true;
    siteVideo = best;
    try { siteWasPlaying = !best.paused; best.pause(); } catch (e) {}
    playItem(it, {
      left: bestRect.left, top: bestRect.top,
      width: bestRect.width, height: bestRect.height, source: best
    });
  }

  function restoreSiteVideo() {
    if (!siteVideo) return;
    try { siteVideo.style.visibility = ''; } catch (e) {}
    // 接管前它是在播的，就接着播，别让用户以为网站坏了
    if (siteWasPlaying) {
      try { var p = siteVideo.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }
    siteWasPlaying = false;
    siteVideo = null;
  }

  function playItem(it, rect) {
    if (!it) return;
    current = it;
    setMediaMeta(it);
    if (it.kind === 'dash') { toast('DASH 流暂不支持直接播放，已复制地址'); copyText(it.url); return; }

    openPlayer(it.title, rect);

    if (it.kind === 'hls') {
      videoEl.removeAttribute('src');
      var stat = playerEl.querySelector('.stat');
      stat.textContent = '解析播放列表…';
      var inst = new HlsPlayer(it.url, videoEl, function (s) {
        if (s && s.total) stat.textContent = s.buffered + '/' + s.total + ' 段';
        else if (s && s.msg) stat.textContent = s.msg;
      });
      hls = inst;
      var resume = cfg.resume ? loadPlayPos(it) : 0;
      inst.start().then(function () {
        stat.textContent = '';
        updateQualityBtn(inst);
        // 上次看到结尾附近就别续播了，直接从头开始
        if (resume > 5 && (!inst.total || resume < inst.total - 15)) {
          inst.seekTo(resume);
          setTimeout(function () { toast('从上次的 ' + fmtTime(resume) + ' 继续'); }, 1200);
        } else if (Number(cfg.skipIntro) > 0 && (!inst.total || cfg.skipIntro < inst.total - 30)) {
          inst.seekTo(Number(cfg.skipIntro));
        }
      }, function (err) {
        stat.textContent = '';
        try { inst.destroy(); } catch (e) {}
        if (hls === inst) hls = null;
        try { videoEl.removeAttribute('src'); videoEl.load(); } catch (e) {}
        // 明确告诉用户为什么放不了，而不是静默退回
        var why = (err && err.message) ? err.message : '未知错误';
        var t = playerEl.querySelector('.t');
        if (t) t.textContent = '放不了：' + why;
        toast('内置播放器放不了：' + why);
        setTimeout(function () { if (playerOpen) closePlayer(); }, 4000);
      });
      return;
    }

    if (it.kind === 'ts') { playTs(it.url); return; }

    if (it.kind === 'flv') {
      toast('浏览器不支持 FLV 直接播放，请先下载');
    }

    videoEl.src = it.url;
    var resume2 = cfg.resume ? loadPlayPos(it) : 0;
    var startAt = resume2 > 5 ? resume2 : (Number(cfg.skipIntro) || 0);
    if (startAt > 0) {
      var once = function () {
        videoEl.removeEventListener('loadedmetadata', once);
        try {
          var d = videoEl.duration;
          if (resume2 > 5 && isFinite(d) && d > 0 && resume2 > d - 15) return;   // 已经看到结尾了，从头来
          videoEl.currentTime = startAt;
          if (resume2 > 5) setTimeout(function () { toast('从上次的 ' + fmtTime(resume2) + ' 继续'); }, 1200);
        } catch (e) {}
      };
      videoEl.addEventListener('loadedmetadata', once);
    }
    safePlay(videoEl);
  }

  // 单个 TS 文件也能塞进 MSE 播放
  function playTs(url) {
    var mime = pickMime(false);
    if (!mime) { toast('内核不支持 TS 播放，请先下载'); return; }
    var ms = new MediaSource();
    var objUrl = URL.createObjectURL(ms);
    videoEl.src = objUrl;
    ms.addEventListener('sourceopen', function () {
      var sb;
      try { sb = ms.addSourceBuffer(mime); } catch (e) { toast('TS 播放失败'); return; }
      fetchBuf(url).then(function (buf) {
        return appendTo(sb, buf);
      }).then(function () {
        try { ms.endOfStream(); } catch (e) {}
        safePlay(videoEl);
      }).catch(function () {
        toast('TS 加载失败，可先下载');
      });
    }, { once: true });
  }

  /* ------------------------------------------------------------------ *
   *  HLS 引擎（MSE，自包含，不依赖外部库）
   * ------------------------------------------------------------------ */

  function parseAttrs(s) {
    var out = {};
    var re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m;
    while ((m = re.exec(s))) {
      out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
    }
    return out;
  }

  // 跨域抓取：先用 same-origin 凭据（大多数 CDN 只允许 *），失败再退回 include
  // opt: {signal, range}  —— range 形如 "0-1233"，用于 EXT-X-BYTERANGE
  function xfetch(url, asText, opt) {
    opt = opt || {};
    function once(cred) {
      var init = { credentials: cred };
      if (opt.signal) init.signal = opt.signal;
      if (opt.range) init.headers = { Range: 'bytes=' + opt.range };
      return netFetch(url, init).then(function (r) {
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        return asText ? r.text() : r.arrayBuffer();
      });
    }
    return once('same-origin').catch(function (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e && /^HTTP /.test(e.message)) throw e;   // 服务端明确报错，不必重试
      return once('include');
    });
  }

  function fetchText(url, opt) {
    var hit = textCache.get(url);
    if (hit && Date.now() - hit.ts < 30000) {
      textCache.delete(url);        // 只吃一次，别拿旧列表去播
      return Promise.resolve(hit.text);
    }
    return xfetch(url, true, opt);
  }

  // 页面自己拉过的 m3u8 原文，直接拿来用：省一次请求，也绕开一次性签名
  function seedText(url, text) {
    if (!text || text.length > 2 * 1024 * 1024) return;
    if (text.indexOf('#EXTM3U') < 0) return;
    textCache.set(url, { text: text, ts: Date.now() });
    if (textCache.size > 8) textCache.delete(textCache.keys().next().value);
  }
  function fetchBuf(url, opt) { return xfetch(url, false, opt); }

  function qualityLabel(attrs) {
    var res = attrs.RESOLUTION || '';
    var m = /x(\d{3,4})$/i.exec(res);
    if (m) return m[1] + 'P';
    var bw = parseInt(attrs.BANDWIDTH || '0', 10);
    if (bw >= 1000000) return (bw / 1000000).toFixed(1) + 'M';
    if (bw) return Math.round(bw / 1000) + 'K';
    return '默认';
  }

  function resolvePlaylist(url, depth) {
    depth = depth || 0;
    if (depth > 3) return Promise.reject(new Error('播放列表层级过深'));
    return fetchText(url).then(function (text) {
      if (text.indexOf('#EXT-X-STREAM-INF') < 0) return { text: text, url: url, variants: [], codecs: '' };

      var lines = text.split(/\r?\n/);
      var variants = [];
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
          var a = parseAttrs(lines[i]);
          var bw = parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10);
          var j = i + 1;
          while (j < lines.length && (!lines[j].trim() || lines[j].charAt(0) === '#')) j++;
          if (j < lines.length) {
            variants.push({
              url: absolutize2(lines[j].trim(), url),
              bw: bw,
              label: qualityLabel(a),
              codecs: a.CODECS || ''
            });
          }
        }
      }
      if (!variants.length) return { text: text, url: url, variants: [], codecs: '' };
      variants.sort(function (x, y) { return y.bw - x.bw; });
      // 记下子清晰度，避免它们被当成"另一个视频"再进列表；
      // 页面自己的播放器常常抢在预解析之前就把子清晰度拉进列表了，这里顺手清掉
      var pruned = false;
      for (var vj = 0; vj < variants.length && variantSet.size < 60; vj++) {
        var vurl = variants[vj].url;
        variantSet.add(vurl);
        if (items.delete(vurl)) pruned = true;
      }
      if (pruned) {
        listDirty = true;
        if (sheetOpen) scheduleRender();
        ensureFab();
      }

      return resolvePlaylist(variants[0].url, depth + 1).then(function (r) {
        r.variants = variants;
        r.codecs = variants[0].codecs || '';
        return r;
      });
    });
  }

  // 播放列表缓存：嗅探到 m3u8 就顺手拉一次，点播放时直接命中，省掉 1~2 个往返
  var hlsPrefetchCount = 0;

  function getPlaylist(url, maxAge) {
    var now = Date.now();
    var hit = playCache.get(url);
    var ttl = (typeof maxAge === 'number') ? maxAge : 60000;   // 注意：0 是合法值，不能用 ||
    // 点播列表是固定不变的，命中就一直用：既省请求，也不会过期后去重拉一次性签名链接
    if (hit && (hit.endlist === true || now - hit.ts < ttl)) return hit.p;

    var rec = { ts: now, p: null, endlist: false };
    rec.p = resolvePlaylist(url).then(function (r) {
      var pl = parseMedia(r.text, r.url);
      rec.endlist = (pl.endlist === true);

      // 主列表已经解析出来的那一路子列表，顺手缓存一份：切清晰度/下载时不用再发请求
      if (r.variants && r.variants.length && r.url !== url && !playCache.has(r.url)) {
        playCache.set(r.url, {
          ts: Date.now(),
          endlist: rec.endlist,
          p: Promise.resolve({ r: { text: r.text, url: r.url, variants: [], codecs: r.codecs }, pl: pl })
        });
        if (playCache.size > 16) {
          var oldest = playCache.keys().next().value;
          if (oldest !== url) playCache.delete(oldest);
        }
      }

      // init 段很小，顺手预取，起播能再省一个往返
      if (pl.map && pl.map.uri) prefetchBuf(pl.map.uri, pl.map.range).catch(function () {});
      return { r: r, pl: pl };
    });
    playCache.set(url, rec);
    if (playCache.size > 16) playCache.delete(playCache.keys().next().value);

    rec.p.catch(function () {
      if (playCache.get(url) === rec) playCache.delete(url);
    });
    return rec.p;
  }

  // 同一个文件用 BYTERANGE 切 init 和分片时 url 完全相同，必须把 range 拼进 key，否则串数据
  function cacheKey(url, range) { return range ? url + '#' + range : url; }

  function prefetchBuf(url, range) {
    var k = cacheKey(url, range);
    var hit = bufCache.get(k);
    if (hit && Date.now() - hit.ts < 120000) return Promise.resolve(hit.buf);
    return fetchBuf(url, { range: range }).then(function (buf) {
      if (buf && buf.byteLength && buf.byteLength < 4 * 1024 * 1024) {
        bufCache.set(k, { buf: buf, ts: Date.now() });
        if (bufCache.size > 6) bufCache.delete(bufCache.keys().next().value);
      }
      return buf;
    });
  }

  function getBufCached(url, range, signal) {
    var k = cacheKey(url, range);
    var hit = bufCache.get(k);
    // 命中后保留，拖动进度条重建 MSE 时还能复用，省一个往返
    if (hit && Date.now() - hit.ts < 120000) return Promise.resolve(hit.buf);
    return fetchBuf(url, { range: range, signal: signal });
  }

  function absolutize2(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function rangeOf(spec, lastEnd) {
    if (!spec) return null;
    var p = String(spec).split('@');
    var len = parseInt(p[0], 10) || 0;
    var off = p.length > 1 ? parseInt(p[1], 10) : (lastEnd || 0);
    if (!len) return null;
    return off + '-' + (off + len - 1);
  }

  function parseMedia(text, baseUrl) {
    var lines = text.split(/\r?\n/);
    var segs = [];
    var key = null, map = null, dur = 0, endlist = false, mediaSeq = 0;
    var pendingRange = null, lastRangeEnd = 0, gapNext = false;

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      if (l.indexOf('#EXT-X-KEY') === 0) {
        var ka = parseAttrs(l);
        if (ka.METHOD === 'NONE') key = null;
        else key = { method: ka.METHOD, uri: ka.URI ? absolutize2(ka.URI, baseUrl) : null, iv: ka.IV || null };
      } else if (l.indexOf('#EXT-X-MAP') === 0) {
        var ma = parseAttrs(l);
        // 按规范，MAP 之前的 KEY 同样作用于 init 段
        if (ma.URI) map = { uri: absolutize2(ma.URI, baseUrl), range: rangeOf(ma.BYTERANGE, 0), key: key };
      } else if (l.indexOf('#EXT-X-BYTERANGE') === 0) {
        var spec = l.slice(l.indexOf(':') + 1).split('@');
        var len = parseInt(spec[0], 10) || 0;
        var off = spec.length > 1 ? parseInt(spec[1], 10) : lastRangeEnd;
        if (len) { pendingRange = { offset: off, length: len }; lastRangeEnd = off + len; }
      } else if (l.indexOf('#EXTINF') === 0) {
        var p = l.split(':')[1];
        dur = parseFloat((p || '0').split(',')[0]) || 0;
      } else if (l.indexOf('#EXT-X-MEDIA-SEQUENCE') === 0) {
        mediaSeq = parseInt(l.split(':')[1], 10) || 0;
      } else if (l.indexOf('#EXT-X-ENDLIST') === 0) {
        endlist = true;
      } else if (l.indexOf('#EXT-X-GAP') === 0) {
        gapNext = true;   // 占位分片：时长留着占时间轴，但不下载
      } else if (l.charAt(0) !== '#') {
        segs.push({
          url: absolutize2(l, baseUrl),
          dur: dur,
          key: key,
          start: 0,
          map: map,
          gap: gapNext,
          range: pendingRange ? (pendingRange.offset + '-' + (pendingRange.offset + pendingRange.length - 1)) : null
        });
        pendingRange = null;
        gapNext = false;
        dur = 0;
      }
    }

    var t = 0;
    for (var k = 0; k < segs.length; k++) {
      segs[k].start = t;
      t += segs[k].dur;
    }
    return { segs: segs, map: map, total: t, endlist: endlist, mediaSeq: mediaSeq };
  }

  function pickMime(isFmp4, codecs) {
    var base = isFmp4 ? 'video/mp4' : 'video/mp2t';
    var list = [];
    // 主列表里带了 CODECS 就用精确串，比猜 AVC 更可靠（HEVC 也能正确判出来）
    if (codecs) list.push(base + '; codecs="' + codecs + '"');
    list = list.concat(isFmp4 ? [
      'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4; codecs="avc1.4D401F,mp4a.40.2"',
      'video/mp4; codecs="avc1.64001F,mp4a.40.2"',
      'video/mp4'
    ] : [
      'video/mp2t; codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp2t; codecs="avc1.4D401F,mp4a.40.2"',
      'video/mp2t'
    ]);
    for (var i = 0; i < list.length; i++) {
      try { if (window.MediaSource && MediaSource.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return null;
  }

  var keyBytesCache = new Map();
  var cryptoKeyCache = new Map();

  function getKeyBytes(uri) {
    if (!uri) return Promise.reject(new Error('缺少密钥地址'));
    if (keyBytesCache.has(uri)) return keyBytesCache.get(uri);
    var p = fetchBuf(uri);
    keyBytesCache.set(uri, p);
    p.catch(function () { keyBytesCache.delete(uri); });
    return p;
  }

  function getCryptoKey(uri) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('页面非 HTTPS，解密接口不可用'));
    if (cryptoKeyCache.has(uri)) return cryptoKeyCache.get(uri);
    var p = getKeyBytes(uri).then(function (kb) {
      return crypto.subtle.importKey('raw', kb, 'AES-CBC', false, ['decrypt']);
    });
    cryptoKeyCache.set(uri, p);
    p.catch(function () { cryptoKeyCache.delete(uri); });
    return p;
  }

  function decryptAes(data, key, seq) {
    var iv;
    if (key.iv) {
      // 规范要求 128 位，但很多服务端会省前导零（IV=0x1 / 0x1234），必须左补零到 16 字节
      var raw = hexToBytes(key.iv.replace(/^0x/i, ''));
      iv = new Uint8Array(16);
      if (raw.length >= 16) iv.set(raw.subarray(raw.length - 16));
      else if (raw.length) iv.set(raw, 16 - raw.length);
    } else {
      iv = new Uint8Array(16);
      var n = seq;
      for (var i = 15; i >= 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); }
    }
    return getCryptoKey(key.uri).then(function (ck) {
      return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, ck, data);
    });
  }

  // 加密流前置检查：把"放不了/下不了"的原因提前说清楚，
  // 而不是让每个分片各自失败重试，最后只留一句模糊的"解码失败"
  function checkCryptoSupport(pl) {
    if (!pl) return '';
    var keys = [];
    if (pl.map && pl.map.key) keys.push(pl.map.key);
    for (var i = 0; i < pl.segs.length; i++) {
      var k = pl.segs[i] && pl.segs[i].key;
      if (k && keys.indexOf(k) < 0) keys.push(k);   // KEY 对象按行复用，去重后很少
    }
    for (var j = 0; j < keys.length; j++) {
      var m = keys[j].method;
      if (!m || m === 'NONE') continue;
      if (m !== 'AES-128') return '不支持的加密方式 ' + m + '（仅支持 AES-128）';
      // crypto.subtle 只在安全上下文（HTTPS / localhost）存在
      if (!window.crypto || !crypto.subtle) return '加密流需要在 HTTPS 页面播放（内核限制）';
    }
    return '';
  }

  function appendTo(sb, buf) {
    // 同一个 SourceBuffer 同时只能有一个 appendBuffer，这里串行化
    var prev = sb.__xbq || Promise.resolve();
    var p = prev.then(function () {
      return new Promise(function (res, rej) {
        var done = false;
        function ok() { if (done) return; done = true; cleanup(); res(); }
        function bad(e) { if (done) return; done = true; cleanup(); rej(e || new Error('append 失败')); }
        function cleanup() {
          sb.removeEventListener('updateend', ok);
          sb.removeEventListener('error', bad);
        }
        sb.addEventListener('updateend', ok);
        sb.addEventListener('error', bad);
        try { sb.appendBuffer(buf); } catch (e) { bad(e); }
      });
    });
    sb.__xbq = p.catch(function () {});
    return p;
  }

  function aheadSeconds(v) {
    try {
      var t = v.currentTime, b = v.buffered;
      for (var i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 0.6 && t <= b.end(i)) return b.end(i) - t;
      }
      return b.length ? b.end(b.length - 1) - t : 0;
    } catch (e) { return 0; }
  }

  function isBuffered(v, t) {
    try {
      var b = v.buffered;
      for (var i = 0; i < b.length; i++) {
        if (t >= b.start(i) && t <= b.end(i) - 0.15) return true;
      }
    } catch (e) {}
    return false;
  }

  function findSegIndex(segs, t) {
    for (var i = 0; i < segs.length; i++) {
      if (t < segs[i].start + segs[i].dur) return i;
    }
    return segs.length - 1;
  }

  function HlsPlayer(url, video, onState) {
    this.url = url;
    this.video = video;
    this.onState = onState || function () {};
    this.gen = 0;
    this.dead = false;
    this.segs = [];
    this.map = null;
    this.mediaSeq = 0;
    this.ms = null;
    this.sb = null;
    this.mime = '';
    this.objUrl = null;
    this.pendingSeek = null;
    this.restarting = false;
    this.aligned = false;
    this.autoPlay = true;
    this.variants = [];
    this.variantIndex = 0;
    this.fails = new Map();
    this.boundSeek = null;
    this.ctrl = null;
    this.seekTimer = 0;
    // 内核不支持 video/mp2t 时，用 mux.js 把 TS 实时转成 fMP4 再喂 MSE
    this.transmux = false;
    this.txmux = null;
    this.txInit = null;
    this.txOut = [];
    this.ptsOffset = null;   // 流的 PTS 起点偏移，seek 时要用
    this.softSeek = false;   // 正在往现有 MSE 里补跳转数据
    this.softSeekT = 0;
    this.softFailed = false;
    this.hardRetried = false;
    this.finished = false;    // 点播分片已经全部处理完
  }

  HlsPlayer.prototype.start = function () {
    var self = this;
    return getPlaylist(this.url).then(function (c) {
      var r = c.r, pl = c.pl;
      if (!pl.segs.length) throw new Error('播放列表为空');
      var encErr = checkCryptoSupport(pl);
      if (encErr) throw new Error(encErr);
      self.segs = pl.segs;
      self.map = pl.map;
      self.mediaSeq = pl.mediaSeq;
      self.total = pl.total;
      self.endlist = pl.endlist;
      self.variants = r.variants || [];
      self.variantIndex = 0;
      for (var vi = 0; vi < self.variants.length; vi++) {
        if (self.variants[vi].url === r.url) { self.variantIndex = vi; break; }
      }
      var mime = pickMime(!!pl.map, r.codecs);
      self.transmux = false;
      self.codecs = r.codecs || '';
      if (!mime && !pl.map) {
        // 有些老内核的 MSE 不吃 mp2t，退回“自己转封装成 fMP4”
        mime = pickMime(true, r.codecs);
        if (mime) self.transmux = true;
      }
      if (!mime) throw new Error('内核不支持该封装（可能是 HEVC）');
      self.mime = mime;
      self.bindSeek();
      return self.load(0, null);
    });
  };

  // 切换码率：沿用当前播放位置重新装载（hls.js 的 level 切换思路）
  HlsPlayer.prototype.switchTo = function (i) {
    var self = this;
    var vs = this.variants || [];
    var v = vs[i];
    if (!v) return Promise.reject(new Error('没有该清晰度'));
    var t = this.video.currentTime || 0;
    this.variantIndex = i;
    this.url = v.url;
    return getPlaylist(v.url, 0).then(function (c) {
      var pl = c.pl;
      if (!pl.segs.length) throw new Error('播放列表为空');
      var encErr2 = checkCryptoSupport(pl);
      if (encErr2) throw new Error(encErr2);
      var mime = pickMime(!!pl.map, v.codecs);
      self.transmux = false;
      if (!mime && !pl.map) {
        mime = pickMime(true, v.codecs);
        if (mime) self.transmux = true;
      }
      if (!mime) throw new Error('该清晰度的编码不支持');
      self.mime = mime;
      self.segs = pl.segs;
      self.map = pl.map;
      self.mediaSeq = pl.mediaSeq;
      self.total = pl.total;
      self.endlist = pl.endlist;
      self.autoPlay = true;
      return self.load(findSegIndex(pl.segs, t), t);
    });
  };

  // 拖动进度条：已在缓冲里就直接跳；不在就从目标分片往现有缓冲区里续补，
  // 不重建 MediaSource —— 这样已经下过的部分一直可用，往回拖是瞬间的
  // 拖动过程中提前把目标分片拉下来（只下数据，不动播放位置），松手就能立刻播
  HlsPlayer.prototype.prefetchAt = function (t) {
    if (this.dead) return;
    var i = findSegIndex(this.segs, t);
    if (i < 0) return;
    if (this._pfIdx === i) return;      // 同一片不重复发
    var now = Date.now();
    if (this._pfAt && now - this._pfAt < 200) return;   // 拖太快就别狂发请求
    this._pfAt = now;
    this._pfIdx = i;
    var seg = this.segs[i];
    if (!seg || seg.gap) return;
    var key = cacheKey(seg.url, seg.range);
    if (segCache.has(key)) return;
    try {
      fetchBuf(seg.url, { range: seg.range }).then(function (b) {
        putSegCache(key, b);
      }).catch(function () {});
    } catch (e) {}
  };

  // 转封装流的跳转：不重建 MSE，换一个新的 Transmuxer 接着往原 SourceBuffer 里补。
  // 旧画面会一直留着，直到新分片解码出来（hls.js 处理 TS 跳转也是这个思路）。
  HlsPlayer.prototype.seekTransmux = function (t) {
    if (this.dead || !this.txmux || !this.sb || !this.ms) return false;
    if (this.ms.readyState !== 'open') return false;
    if (this.ptsOffset == null) return false;   // 起播还没对齐时间轴，先整体重建更稳
    var i = findSegIndex(this.segs, t);
    if (i < 0) return false;
    var muxjs = window.muxjs;
    if (!muxjs) return false;

    var wasPlaying = false;
    try { wasPlaying = !this.video.paused; } catch (e) {}
    if (this.ctrl) { try { this.ctrl.abort(); } catch (e) {} }
    var gen = ++this.gen;
    this.ctrl = new AbortController();
    this.pendingSeek = t;
    this.aligned = false;
    this.softSeek = true;
    this.softSeekT = t;
    this.softFailed = false;
    this.autoPlay = wasPlaying;
    this.finished = false;

    try {
      this.txOut.length = 0;
      this.txInit = null;
      this.txmux = new muxjs.mp4.Transmuxer();
      // 时间轴接在已有缓冲后面（转封装输出从 0 起算，这里对齐到该分片的逻辑时间）
      if (i > 0 && typeof this.txmux.setBaseMediaDecodeTime === 'function') {
        this.txmux.setBaseMediaDecodeTime(Math.round(this.segs[i].start * 90000));
      }
      var self = this;
      this.txmux.on('data', function (seg) {
        if (!self.txInit && seg.initSegment && seg.initSegment.byteLength) self.txInit = seg.initSegment;
        if (seg.data && seg.data.byteLength) self.txOut.push(seg.data);
      });
    } catch (e) {
      this.softSeek = false;
      return false;
    }

    showFreeze();
    this.pump(i, gen, this.sb, null);
    return true;
  };

  HlsPlayer.prototype.seekTo = function (t) {
    if (this.dead) return;
    var off = this.ptsOffset || 0;
    var target = t + off;

    if (isBuffered(this.video, target)) {
      this.lastSetTime = Date.now();
      try { this.video.currentTime = target; } catch (e) {}
      return;
    }

    var i = findSegIndex(this.segs, t);
    if (i < 0) return;

    // TS 流要转封装，转封装器是"顺序"处理的：换一个新的 Transmuxer 接着写原 SourceBuffer，
    // 这样不会把旧画面清掉；实在接不上（MSE 已结束/异常）才整体重建。
    if (this.transmux) {
      if (!this.seekTransmux(t)) {
        var self0 = this;
        this.load(i, t).catch(function () { self0.onState({ msg: '跳转失败，请重试' }); });
      }
      return;
    }

    if (!this.sb || !this.ms || this.ms.readyState !== 'open' || this.ptsOffset == null) {
      var self1 = this;
      this.load(i, t).catch(function () { self1.onState({ msg: '跳转失败，请重试' }); });
      return;
    }

    if (this.ctrl) { try { this.ctrl.abort(); } catch (e) {} }
    var gen = ++this.gen;
    this.ctrl = new AbortController();
    this.pendingSeek = t;
    this.failStreak = 0;
    this.softSeek = true;
    this.softSeekT = t;
    this.softFailed = false;
    this.finished = false;
    // 先把播放头挪过去：不然数据没到时旧画面还会继续往下播一小段
    try {
      this.video.currentTime = target;
      this.lastSetTime = Date.now();
    } catch (e) {}
    var st = playerEl && playerEl.querySelector('.stat');
    if (st) st.textContent = '缓冲中…';
    this.pump(i, gen, this.sb, null);
  };

  // 画面出错时从当前位置重建一次，比直接退回网页播放体面
  HlsPlayer.prototype.reloadAt = function (t) {
    var i = findSegIndex(this.segs, t);
    return this.load(Math.max(0, i), t);
  };

  // 内核嘴上说支持 mp2t、实际解不了时，改用"自己转封装成 fMP4"再来一次
  HlsPlayer.prototype.forceTransmux = function (t) {
    var m = pickMime(true, this.codecs);
    if (!m) return Promise.reject(new Error('内核也不支持 fMP4'));
    this.mime = m;
    this.transmux = true;
    this.triedTransmux = true;
    var i = findSegIndex(this.segs, t || 0);
    return this.load(Math.max(0, i), t || null);
  };

  HlsPlayer.prototype.bindSeek = function () {
    var self = this;
    if (this.boundSeek) this.video.removeEventListener('seeking', this.boundSeek);
    this.boundSeek = function () {
      if (self.restarting || self.dead) return;
      if (self.pendingSeek != null) return;
      if (Date.now() - (self.lastSetTime || 0) < 800) return;
      var t = self.video.currentTime;
      if (isBuffered(self.video, t)) return;
      // 拖进度条会连续触发 seeking，合并成一次，避免狂发请求
      clearTimeout(self.seekTimer);
      self.seekTimer = setTimeout(function () {
        if (self.dead || self.restarting) return;
        var t2 = self.video.currentTime;
        if (isBuffered(self.video, t2)) return;
        self.seekTo(t2 - (self.ptsOffset || 0));
      }, 260);
    };
    this.video.addEventListener('seeking', this.boundSeek);
  };

  HlsPlayer.prototype.load = function (index, seekTime) {
    var self = this;
    var gen = ++this.gen;

    // 重载会打断播放，先记住原来是不是在播，装好第一个分片后自动续播
    var wasPlaying = false;
    try { wasPlaying = !this.video.paused; } catch (e) {}
    if (wasPlaying) this.autoPlay = true;

    // 换源/跳转时把上一轮还在飞的请求掐掉，别白费流量
    if (this.ctrl) { try { this.ctrl.abort(); } catch (e) {} }
    var ctrl = new AbortController();
    this.ctrl = ctrl;

    this.restarting = true;
    // 切清晰度/错误恢复时的重建也按"缓冲中"处理：不弹大播放键，控件仍可点
    if (playerEl && !playerEl.classList.contains('loading')) playerEl.classList.add('buffering');
    this.pendingSeek = seekTime;
    this.aligned = false;
    this.ptsOffset = null;
    this.softSeek = false;
    this.finished = false;

    // 起播加速：init 段和首个分片同时发出去，不等 MediaSource 打开
    var mapP = this.map ? getBufCached(this.map.uri, this.map.range) : null;
    var muxP = this.transmux ? loadMux() : null;
    var firstP = null;
    if (!this.transmux && index < this.segs.length && !this.segs[index].gap) {
      firstP = this.fetchSeg(this.segs[index], index, ctrl.signal);
      firstP.catch(function () {});
    }

    try { this.video.pause(); } catch (e) {}
    if (this.objUrl) { try { URL.revokeObjectURL(this.objUrl); } catch (e) {} this.objUrl = null; }
    if (this.ms) { try { this.ms.endOfStream(); } catch (e) {} }
    // 换源前把最后一帧冻在画面上，重建 MSE 期间不黑屏
    showFreeze();

    var ms;
    try { ms = new MediaSource(); } catch (e) { return Promise.reject(e); }
    this.ms = ms;
    this.objUrl = URL.createObjectURL(ms);
    this.video.src = this.objUrl;

    return new Promise(function (res, rej) {
      var timer = setTimeout(function () { rej(new Error('MediaSource 打开超时')); }, 15000);
      ms.addEventListener('sourceopen', function () { clearTimeout(timer); res(); }, { once: true });
    }).then(function () {
      if (gen !== self.gen) return;
      var sb;
      try { sb = ms.addSourceBuffer(self.mime); } catch (e) { throw new Error('addSourceBuffer 失败'); }
      self.sb = sb;
      try { sb.mode = 'segments'; } catch (e) {}

      var initP = mapP ? mapP.then(function (b) {
        if (self.map && self.map.key && self.map.key.method === 'AES-128') {
          return decryptAes(b, self.map.key, self.mediaSeq).then(function (d) { return appendTo(sb, d); });
        }
        return appendTo(sb, b);
      }) : Promise.resolve();

      // 转封装模式：每次重建 MSE 都要换一个新的 Transmuxer（init 段才会重新吐出来）
      var prep = muxP ? muxP.then(function (muxjs) {
        if (gen !== self.gen) return;
        self.txOut.length = 0;
        self.txInit = null;
        self.txmux = new muxjs.mp4.Transmuxer();
        // 跳转重建时把时间轴对齐到该分片起点，否则每次都会从 0 重新计时
        if (index > 0 && typeof self.txmux.setBaseMediaDecodeTime === 'function') {
          try { self.txmux.setBaseMediaDecodeTime(Math.round(self.segs[index].start * 90000)); } catch (e) {}
        }
        self.txmux.on('data', function (seg) {
          if (!self.txInit && seg.initSegment && seg.initSegment.byteLength) self.txInit = seg.initSegment;
          if (seg.data && seg.data.byteLength) self.txOut.push(seg.data);
        });
      }) : Promise.resolve();

      return prep.then(function () {
        return initP.then(function () {
          if (gen !== self.gen) return;
          self.restarting = false;
          self.pump(index, gen, sb, firstP);
        });
      });
    }).catch(function (e) {
      if (gen === self.gen) {
        self.restarting = false;
        if (playerEl) playerEl.classList.remove('buffering');
      }
      throw e;
    });
  };

  // 把若干 Uint8Array 拼成一个
  function concatBytes(list) {
    var len = 0, i;
    for (i = 0; i < list.length; i++) len += list[i].byteLength;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < list.length; i++) {
      out.set(new Uint8Array(list[i]), off);
      off += list[i].byteLength;
    }
    return out;
  }

  // 普通分片直接 append；转封装分片先 append init 再 append 数据
  function appendChunk(sb, chunk) {
    if (!chunk || !chunk.data) return appendTo(sb, chunk);
    var p = chunk.init ? appendTo(sb, chunk.init) : Promise.resolve();
    return p.then(function () { return appendTo(sb, chunk.data); });
  }

  HlsPlayer.prototype.fetchSeg = function (seg, i, signal) {
    var self = this;
    var myGen = this.gen;
    var key = cacheKey(seg.url, seg.range);
    var hit = segCache.get(key);
    var p = hit
      ? Promise.resolve(hit.buf)
      : fetchBuf(seg.url, { range: seg.range, signal: signal }).then(function (buf) {
          putSegCache(key, buf);
          return buf;
        });
    return p.then(function (buf) {
      var kp = (seg.key && seg.key.method === 'AES-128')
        ? decryptAes(buf, seg.key, self.mediaSeq + i)
        : Promise.resolve(buf);
      return kp.then(function (data) {
        // 期间已经发起了新的 seek/load：旧数据不能再喂给新的转封装器
        if (self.gen !== myGen) {
          var st = new Error('stale segment');
          st.name = 'AbortError';
          throw st;
        }
        return self.transmux ? self.txSegment(data) : data;
      });
    });
  };

  // TS → fMP4：一个 Transmuxer 走完整个会话，init 段只在第一片出现
  HlsPlayer.prototype.txSegment = function (ts) {
    if (!this.txmux) return Promise.reject(new Error('转封装器未就绪'));
    this.txOut.length = 0;
    this.txInit = null;
    try {
      this.txmux.push(new Uint8Array(ts));
      this.txmux.flush();
    } catch (e) { return Promise.reject(e); }

    var init = this.txInit, out = this.txOut.slice();
    this.txOut.length = 0;
    this.txInit = null;
    if (!out.length) return Promise.reject(new Error('转封装无输出'));
    return Promise.resolve({ init: init, data: concatBytes(out) });
  };

  // append 结束 ≠ buffered 已更新。这里等它真的可用，再对齐播放点、设置时长、起播，
  // 否则会出现“currentTime 停在缓冲区间之外，一直转圈”的卡死。
  HlsPlayer.prototype.settle = function (index, tries, gen) {
    var self = this;
    if (this.dead || gen !== this.gen) return;   // 期间又发起新 load 就作废

    var b = null;
    try {
      // SourceBuffer.buffered 在 updateend 之后立刻有效，比 video.buffered 更可靠
      if (this.sb && this.sb.buffered && this.sb.buffered.length) b = this.sb.buffered;
      else if (this.video.buffered.length) b = this.video.buffered;
    } catch (e) {}
    if ((!b || !b.length) && tries < 60) {   // 最多等 3 秒，网络慢时也不放弃
      setTimeout(function () { self.settle(index, tries + 1, gen); }, 50);
      return;
    }

    if (b && b.length) {
      // 记录 PTS 偏移（很多流不从 0 开始），后面 seek 直接用它换算
      if (this.ptsOffset == null) {
        var first = this.segs[index] ? this.segs[index].start : 0;
        this.ptsOffset = b.start(0) - first;
      }

      // 点播流要显式给 duration，seekable 才会覆盖全片（hls.js 的做法）
      if (this.endlist && this.total > 0 && this.ms) {
        this.setDuration(this.total + Math.max(0, this.ptsOffset || 0), 0, gen);
      }
      try {
        if (this.pendingSeek != null) {
          var t = this.pendingSeek;
          this.pendingSeek = null;
          this.softSeek = false;
          this.softSeekT = 0;
          this.lastSetTime = Date.now();
          var target = t + (this.ptsOffset || 0);
          this.video.currentTime = target;
          if (!isBuffered(this.video, target)) {
            this.video.currentTime = b.start(0) + 0.05;
          }
        } else if (!isBuffered(this.video, this.video.currentTime)) {
          this.lastSetTime = Date.now();
          this.video.currentTime = b.start(0) + 0.05;
        }
      } catch (e) {}
    }

    if (this.autoPlay) {
      this.autoPlay = false;
      if (!userPaused) safePlay(this.video);
    }
  };

  // 点播最后一段的真实长度经常比 EXTINF 短一点（本地流 39.8s vs 40s），
  // 如果按 40s 标终点，播放会永远卡在 39.8s 转圈。全部下载完后用真实缓冲末尾收尾。
  HlsPlayer.prototype.finalizeDuration = function () {
    var self = this;
    if (this.dead || !this.ms || !(this.endlist && this.total > 0)) return;
    var ms0 = this.ms, sb0 = this.sb, myGen = this.gen;
    var tries = 0;
    function run() {
      if (self.dead || self.gen !== myGen || self.ms !== ms0) return;
      if (sb0 && sb0.updating) {
        if (tries++ < 40) setTimeout(run, 50);
        return;
      }
      var end = 0;
      try {
        var b = (sb0 && sb0.buffered) || (self.video && self.video.buffered);
        if (b && b.length) end = b.end(b.length - 1);
      } catch (e) { return; }
      if (!end) return;
      var expected = self.total + Math.max(0, self.ptsOffset || 0);
      if (Math.abs(end - expected) > 2) return;
      try { ms0.duration = end; return; } catch (e) {}

      // Chrome 不允许 duration 低于最后已编码帧的 PTS；先把尾巴 remove 掉再设
      try {
        var oldDur = expected;
        try { oldDur = ms0.duration || expected; } catch (e) {}
        if (!(end < oldDur)) return;
        var onUp = function () {
          try { sb0.removeEventListener('updateend', onUp); } catch (e) {}
          if (self.dead || self.gen !== myGen || self.ms !== ms0) return;
          try { ms0.duration = end; } catch (e2) {}
        };
        sb0.addEventListener('updateend', onUp);
        try { sb0.remove(end, oldDur); }
        catch (e) { try { sb0.removeEventListener('updateend', onUp); } catch (e2) {} }
      } catch (e) {}
    }
    run();
  };

  // SourceBuffer 正在 append 时设 duration 会抛 InvalidStateError，等它空闲再设
  HlsPlayer.prototype.setDuration = function (val, tries, gen) {
    var self = this;
    if (this.dead || gen !== this.gen) return;
    if (this.sb && this.sb.updating) {
      if (tries < 20) setTimeout(function () { self.setDuration(val, tries + 1, gen); }, 50);
      return;
    }
    try { this.ms.duration = val; } catch (e) {}
  };

  HlsPlayer.prototype.pump = function (index, gen, sb, firstP) {
    var self = this;
    var i = index;
    var signal = this.ctrl ? this.ctrl.signal : undefined;

    function step() {
      if (self.dead || gen !== self.gen) return;
      if (i >= self.segs.length) {
        // 点播已经用 duration 标了终点：保持 open，之后往回/往前跳还能继续 append
        if (!(self.endlist && self.total > 0)) {
          try { if (self.ms && self.ms.readyState === 'open') self.ms.endOfStream(); } catch (e) {}
        } else {
          self.finished = true;
          if (self.finalizeDuration) self.finalizeDuration();
        }
        return;
      }
      // 缓冲够了就等一等，别把整部片子一口气拉下来（正在跳转时不拦）
      if (self.pendingSeek == null && aheadSeconds(self.video) > 60) {
        setTimeout(step, 300);
        return;
      }

      var seg = self.segs[i];
      if (seg.gap) { i++; setTimeout(step, 0); return; }   // 占位分片：不请求，时间轴留着
      var p = (i === index && firstP) ? firstP : self.fetchSeg(seg, i, signal);
      if (i === index) firstP = null;

      p.then(function (buf) {
        if (self.dead || gen !== self.gen) return;
        return appendChunk(sb, buf).then(function () {
          self.failStreak = 0;
          i++;
          if (!self.aligned || self.pendingSeek != null) {
            self.aligned = true;
            self.settle(index, 0, gen);   // 等 buffered 可用后再对齐/设时长/起播
          }
          self.onState({ buffered: i, total: self.segs.length });
          setTimeout(step, 0);
        });
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return;   // 主动取消，不算失败
        // 往现有 MSE 补数据失败（多为时间轴/解码器不认）：退回整体重建一次
        if (self.softSeek && !self.softFailed) {
          self.softFailed = true;
          var softT = self.softSeekT;
          self.softSeek = false;
          self.onState({ msg: '正在恢复…' });
          var retryP;
          if (!self.transmux && /^video\/mp2t/i.test(self.mime || '')) {
            retryP = self.forceTransmux(softT);   // 内核自称支持 mp2t 但补数据失败：改用转封装
          } else {
            retryP = self.load(findSegIndex(self.segs, softT), softT);
          }
          retryP.catch(function () {
            self.onState({ msg: '跳转失败，请重试' });
          });
          return;
        }
        var n = (self.fails.get(i) || 0) + 1;
        self.fails.set(i, n);
        if (n >= 3) {
          self.failStreak = (self.failStreak || 0) + 1;
          if (self.failStreak > 6) {
            if (!self.hardRetried) {
              self.hardRetried = true;
              self.failStreak = 0;
              var rt = self.pendingSeek != null ? self.pendingSeek
                : Math.max(0, (self.video.currentTime || 0) - (self.ptsOffset || 0));
              self.onState({ msg: '正在恢复…' });
              self.load(findSegIndex(self.segs, rt), rt).catch(function () {
                self.onState({ msg: '跳转失败，请重试' });
              });
              return;
            }
            self.dead = true;
            self.onState({ msg: '解码失败，请重试或下载' });
            return;
          }
          i++;
          setTimeout(step, 0);
        } else setTimeout(step, 700);
      });
    }
    step();
  };

  HlsPlayer.prototype.destroy = function () {
    this.dead = true;
    this.gen++;
    clearTimeout(this.seekTimer);
    if (this.ctrl) { try { this.ctrl.abort(); } catch (e) {} this.ctrl = null; }
    if (this.boundSeek) { try { this.video.removeEventListener('seeking', this.boundSeek); } catch (e) {} }
    try { if (this.ms) this.ms.endOfStream(); } catch (e) {}
    if (this.objUrl) { try { URL.revokeObjectURL(this.objUrl); } catch (e) {} }
  };

  /* ------------------------------------------------------------------ *
   *  下载
   * ------------------------------------------------------------------ */

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    try { a.click(); } catch (e) {}
    setTimeout(function () { try { a.remove(); } catch (e) {} }, 8000);
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 600000);
    toast('已保存：' + name + '（没反应就长按链接另存）');
  }

  function anchorDownload(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    try { a.click(); } catch (e) {}
    setTimeout(function () { try { a.remove(); } catch (e) {} }, 8000);
  }

  // 直链的尺寸常常拿不到（<video src> 不经过 fetch），先探一次 Content-Length
  function probeSize(url) {
    // 探测只是优化：挂住或被墙都不能卡住下载，8 秒拿不到就按未知大小走
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 8000);
    function done(n) { clearTimeout(timer); return n; }
    return netFetch(url, { method: 'HEAD', credentials: 'same-origin', signal: ctrl.signal })
      .then(function (r) {
        return done(parseInt(r.headers.get('content-length') || '0', 10) || 0);
      })
      .catch(function () { return done(0); });
  }

  function downloadItem(it) {
    if (!it) return;
    var name = it.title || 'video';

    if (it.kind === 'hls') return downloadHls(it);
    if (it.kind === 'dash') { copyText(it.url); toast('DASH 地址已复制'); return; }

    if (it.blob) { saveBlob(it.blob, name + extOf(it)); return; }

    var pg = showProgress('准备下载…');
    var ctrl = new AbortController();
    pg.onCancel = function () { try { ctrl.abort(); } catch (e) {} };

    (it.size ? Promise.resolve(it.size) : probeSize(it.url)).then(function (known) {
      // 直链大文件交给浏览器下载器：内存占用低、能后台续传，通常还是多线程的
      if (known > 150 * 1024 * 1024) {
        anchorDownload(it.url, name + extOf(it));
        toast('大文件（' + fmtBytes(known) + '）已交给浏览器下载');
        return;
      }

      return netFetch(it.url, { credentials: 'same-origin', signal: ctrl.signal }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var total = parseInt(r.headers.get('content-length') || '0', 10) || 0;
        var type = r.headers.get('content-type') || 'video/mp4';

        if (!r.body || !r.body.getReader) {
          return r.blob().then(function (b) { saveBlob(b, name + extOf(it)); });
        }
        var reader = r.body.getReader();
        var chunks = [];
        var buckets = [];          // 每满 16MB 就固化成一个 Blob，避免大文件内存翻倍
        var bucketBytes = 0;
        var got = 0;
        var lastPaint = 0;

        function flushBucket() {
          if (!chunks.length) return;
          buckets.push(new Blob(chunks, { type: type }));
          chunks = [];
          bucketBytes = 0;
        }

        function loop() {
          return reader.read().then(function (res) {
            if (res.done) {
              flushBucket();
              saveBlob(new Blob(buckets, { type: type }), name + extOf(it));
              return;
            }
            chunks.push(res.value);
            got += res.value.length;
            bucketBytes += res.value.length;
            if (bucketBytes > 16 * 1024 * 1024) flushBucket();

            var now = Date.now();
            if (now - lastPaint > 120) {
              lastPaint = now;
              if (total) pg.progress(got, total);
              else pg.set('已下载 ' + fmtBytes(got));
            }
            return loop();
          });
        }
        return loop();
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') { toast('已取消下载'); return; }
      // CORS 或流读取失败：退回普通链接，交给浏览器下载器
      anchorDownload(it.url, name + extOf(it));
      toast('直接读取被限制，已转交浏览器下载');
    }).then(function () {
      pg.close();
    });
  }

  function extOf(it) {
    if (it.kind === 'webm') return '.webm';
    if (it.kind === 'flv') return '.flv';
    if (it.kind === 'ts') return '.ts';
    var m = it.mime || '';
    if (/webm/i.test(m)) return '.webm';
    if (/matroska/i.test(m)) return '.mkv';
    if (/quicktime/i.test(m)) return '.mov';
    return '.mp4';
  }

  // 借鉴 cat-catch：多线程抓分片、按 index 归位、再顺序合并
  // 借鉴 cat-catch 的“合并为 MP4”：借 mux.js 把 TS 转封装成 fMP4
  var MUX_CDN = 'https://cdn.jsdelivr.net/npm/mux.js@7.0.3/dist/mux.min.js';
  var muxPromise = null;

  function loadMux() {
    if (window.muxjs) return Promise.resolve(window.muxjs);
    if (muxPromise) return muxPromise;
    muxPromise = new Promise(function (res, rej) {
      var done = false;
      var s = document.createElement('script');
      s.src = MUX_CDN;
      s.onload = function () {
        if (done) return;
        done = true;
        if (window.muxjs) res(window.muxjs);
        else rej(new Error('mux.js 不可用'));
      };
      s.onerror = function () { if (done) return; done = true; rej(new Error('mux.js 加载失败')); };
      (document.head || document.documentElement).appendChild(s);
      setTimeout(function () { if (!done) { done = true; rej(new Error('mux.js 加载超时')); } }, 8000);
    });
    // 失败后允许下次重试，不要永久缓存一个失败的 Promise
    muxPromise.catch(function () { muxPromise = null; });
    return muxPromise;
  }

  function blobToBuffer(x) {
    if (x && typeof x.arrayBuffer === 'function') return x.arrayBuffer();
    return Promise.resolve(x);   // 已经是 ArrayBuffer
  }

  function remuxToMp4(parts, onProgress) {
    return loadMux().then(function (muxjs) {
      return new Promise(function (res, rej) {
        var t = new muxjs.mp4.Transmuxer();
        var init = null, blobs = [];
        var idx = 0, settled = false, tries = 0;

        function finish(ok, val) {
          if (settled) return;
          settled = true;
          if (ok) res(val); else rej(val);
        }

        t.on('data', function (seg) {
          if (!init && seg.initSegment && seg.initSegment.byteLength) init = seg.initSegment;
          if (seg.data && seg.data.byteLength) blobs.push(new Blob([seg.data]));
        });

        function complete() {
          if (settled) return;
          if ((!init || !blobs.length) && tries++ < 20) { setTimeout(complete, 25); return; }
          if (!init || !blobs.length) { finish(false, new Error('转封装失败')); return; }
          finish(true, new Blob([init].concat(blobs), { type: 'video/mp4' }));
        }

        // 每次只把 4 个分片读回内存、push、flush，输出立刻转成 Blob。
        // 原始分片始终留在 blob 存储里，失败时还能原样回退成 .ts，不会丢数据。
        function chunk() {
          if (settled) return;
          var end = Math.min(idx + 4, parts.length);
          var batch = [];
          for (; idx < end; idx++) batch.push(parts[idx]);

          Promise.all(batch.map(blobToBuffer)).then(function (bufs) {
            if (settled) return;
            for (var k = 0; k < bufs.length; k++) {
              try {
                t.push(new Uint8Array(bufs[k]));
                t.flush();
              } catch (e) { finish(false, e); return; }
            }
            if (onProgress) onProgress(idx, parts.length);
            if (idx < parts.length) setTimeout(chunk, 0);
            else setTimeout(complete, 0);
          }).catch(function (e) { finish(false, e); });
        }
        chunk();
        setTimeout(function () { finish(false, new Error('转封装超时')); }, 60000);
      });
    });
  }

  function downloadHls(it) {
    var pg = showProgress('解析播放列表…');
    var ctrl = new AbortController();
    pg.onCancel = function () { try { ctrl.abort(); } catch (e) {} };

    var name = it.title || 'video';
    var tasks = [], results = [], pl = null, doneCount = 0, failed = 0, streak = 0;
    var THREADS = 6;

    function grab(t, attempt) {
      var p = t.isMap
        ? getBufCached(t.url, t.range, ctrl.signal)
        : fetchBuf(t.url, { range: t.range, signal: ctrl.signal });

      return p.then(function (buf) {
        if (t.key && t.key.method === 'AES-128') return decryptAes(buf, t.key, t.seq);
        return buf;
      }).catch(function (e) {
        if ((e && e.name === 'AbortError') || ctrl.signal.aborted) throw e;
        if (attempt >= 2) {
          failed++;
          streak++;
          // 单片坏掉不该让整部片子白下：允许少量缺失，但连续挂 8 个或超过 15% 才中止
          var limit = Math.max(3, Math.ceil(tasks.length * 0.15));
          if (streak >= 8 || failed > limit) throw new Error('分片连续失败，已中止');
          return null;
        }
        return sleep(400 * (attempt + 1)).then(function () { return grab(t, attempt + 1); });
      });
    }

    getPlaylist(it.url).then(function (c) {
      pl = c.pl;
      if (!pl.segs.length) throw new Error('播放列表为空');
      var encErr = checkCryptoSupport(pl);
      if (encErr) throw new Error(encErr);

      if (pl.map) {
        tasks.push({ url: pl.map.uri, range: pl.map.range, key: pl.map.key || null, seq: 0, isMap: true });
      }
      for (var i = 0; i < pl.segs.length; i++) {
        if (pl.segs[i].gap) continue;   // 占位分片不下载（seq 仍按原始序号算）
        tasks.push({
          url: pl.segs[i].url,
          range: pl.segs[i].range,
          key: pl.segs[i].key,
          seq: pl.mediaSeq + i
        });
      }
      results = new Array(tasks.length);

      var next = 0;
      function worker() {
        if (next >= tasks.length) return Promise.resolve();
        var idx = next++;
        return grab(tasks[idx], 0).then(function (buf) {
          if (buf) streak = 0;
          // 一律固化成 Blob：交给浏览器的 blob 存储管理（大了会落盘），
          // 后面无论是拼 mp4 还是回退成 ts 都能直接用，也不会因为置空而丢数据
          results[idx] = buf ? new Blob([buf]) : null;
          doneCount++;
          pg.progress(doneCount, tasks.length);
          return worker();
        });
      }

      var ws = [];
      var n = Math.min(THREADS, tasks.length);
      for (var w = 0; w < n; w++) ws.push(worker());
      return Promise.all(ws);
    }).then(function () {
      var parts = results.filter(function (x) { return x; });
      var totalBytes = 0;
      for (var i = 0; i < parts.length; i++) totalBytes += parts[i].size || 0;
      var tail = (failed ? '，' + failed + ' 个分片失败' : '') + (pl.endlist ? '' : '，直播流仅当前片段');

      // fMP4 分片本身就能直接拼成 mp4
      if (pl.map) {
        // init 段没下下来：没有它拼出的 mp4 任何播放器都打不开，直接报错别产出废文件
        if (!results[0]) throw new Error('init 段下载失败，无法合并 MP4');
        saveBlob(new Blob(parts, { type: 'video/mp4' }), name + '.mp4');
        pg.close();
        toast('已合并保存为 MP4（' + THREADS + ' 线程' + tail + '）');
        return;
      }

      // 太大的文件不做转封装，避免手机内存吃不住
      if (totalBytes > 300 * 1024 * 1024) {
        saveBlob(new Blob(parts, { type: 'video/mp2t' }), name + '.ts');
        pg.close();
        toast('文件较大，已保存为 TS（VLC / MX 可播' + tail + '）');
        return;
      }

      pg.set('正在转封装为 MP4…');
      return remuxToMp4(parts, function (cur, total) { pg.progress(cur, total); }).then(function (blob) {
        if (!blob || blob.size < totalBytes * 0.4) throw new Error('输出异常');
        saveBlob(blob, name + '.mp4');
        pg.close();
        toast('已合并保存为 MP4（' + THREADS + ' 线程' + tail + '）');
      }).catch(function () {
        saveBlob(new Blob(parts, { type: 'video/mp2t' }), name + '.ts');
        pg.close();
        toast('已保存为 TS（MP4 转封装不可用' + tail + '）');
      });
    }).catch(function (err) {
      try { ctrl.abort(); } catch (e) {}
      pg.close();
      if (err && err.name === 'AbortError') { toast('已取消下载'); return; }
      toast('下载失败：' + (err && err.message ? err.message : '未知') + '，可点“复制”用其他工具');
    });
  }

  /* ------------------------------------------------------------------ *
   *  录制兜底（MSE 流抓不到地址时）
   * ------------------------------------------------------------------ */

  var recorder = null;
  var recChunks = [];
  var recName = '';

  function startRecord() {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    var v = null;
    var vs = collectVideos(document);
    for (var i = 0; i < vs.length; i++) {
      if (!vs[i].paused && vs[i].videoWidth) { v = vs[i]; break; }
    }
    if (!v && vs.length) v = vs[0];
    if (!v) { toast('没找到可录制的视频'); return; }
    if (!v.captureStream) { toast('当前内核不支持录制'); return; }

    try {
      var stream = v.captureStream();
      var mime = 'video/webm;codecs=vp8,opus';
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
      recChunks = [];
      recName = sanitize(document.title || 'video') + '.webm';
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = function () {
        var blob = new Blob(recChunks, { type: 'video/webm' });
        saveBlob(blob, recName);
        recorder = null;
        var btn = sheetEl && sheetEl.querySelector('[data-a="rec"]');
        if (btn) btn.textContent = '录制当前画面';
        closeSheet();
      };
      recorder.start(1000);
      var recBtn = sheetEl && sheetEl.querySelector('[data-a="rec"]');
      if (recBtn) recBtn.textContent = '停止录制';
      toast('开始录制，再点一次结束（实时，别退出页面）');
    } catch (e) {
      if (e && e.name === 'SecurityError') toast('视频跨域受保护，内核禁止录制画面');
      else toast('录制启动失败');
    }
  }

  /* ------------------------------------------------------------------ *
   *  杂项
   * ------------------------------------------------------------------ */

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, fallback);
        return;
      }
    } catch (e) {}
    fallback();

    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;left:-9999px;';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('已复制');
      } catch (e) { toast('复制失败，请手动长按地址'); }
    }
  }

  function startScanner() {
    var ticks = 0;
    function tick() {
      if (document.hidden) { setTimeout(tick, 3000); return; }
      ticks++;
      scanDom();
      if (ticks % 5 === 0) scanPerf();
      // 长时间没有任何视频线索就降频，别在普通页面上一直空转
      var quiet = !hasVideoEl && !hasMse && items.size === 0;
      idleTicks = quiet ? idleTicks + 1 : 0;
      setTimeout(tick, idleTicks > 20 ? 4000 : 1500);
    }
    setTimeout(tick, 400);
  }

  // 子框架把新地址交给父级（多级嵌套会逐层往上传）
  function postToParent(it) {
    try {
      var msg = { __xbvk: 1, url: it.url, kind: it.kind, score: it.score };
      // blob: 只在创建它的源里有效，父窗口拿去也用不了，所以把 Blob 本身克隆过去
      if (it.kind === 'blob' && it.blob) { msg.blob = it.blob; msg.mime = it.mime; }
      window.parent.postMessage(msg, '*');
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  启动
   * ------------------------------------------------------------------ */

  function boot() {
    loadCfg();
    var _si = SPEEDS.indexOf(Number(cfg.speed));
    if (_si >= 0) speedIdx = _si;
    hookMedia();
    hookObjectUrl();
    hookXHR();
    hookFetch();
    watchPerf();

    // 顶层收子框架上报；子框架收到再往上传，兼容多层嵌套
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.__xbvk !== 1) return;
      // 只认自己直接子框架发来的（parent 属性跨源也可读）：别的窗口不能往列表里塞东西
      var fromChild = false;
      try { fromChild = !!(e.source && e.source !== window && e.source.parent === window); } catch (err) {}
      if (!fromChild) return;
      if (d.blob) {
        try {
          var u = URL.createObjectURL(d.blob);
          blobs.set(u, { kind: 'blob', blob: d.blob, mime: d.mime || '' });
          // 子框架可能一直上报，这里也要有上限，否则 Blob 会把内存吃掉
          while (blobs.size > 3) {
            var oldU = blobs.keys().next().value;
            blobs.delete(oldU);
            try { URL.revokeObjectURL(oldU); } catch (e2) {}
          }
          addItem(u, 'blob', { from: 'frame', score: 90, blob: d.blob, mime: d.mime });
        } catch (err) {}
        return;
      }
      if (!d.url) return;
      addItem(d.url, d.kind || null, { from: 'frame', score: d.score || 90 });
    });

    startScanner();
    scanPerf();   // 只做一次全量兜底，之后靠 hook + 增量

    // 网页自己的播放器一开播，就接管那块画面（不需要点悬浮球）
    try {
      document.addEventListener('play', function (e) {
        var v = e.target;
        if (v && v.tagName === 'VIDEO') tryTakeover(v);
      }, true);
    } catch (e) {}

    document.addEventListener('DOMContentLoaded', function () {
      if (IS_TOP) scanDom();
    });

    window.addEventListener('load', function () {
      if (IS_TOP) { scanDom(); scanPerf(); }
    });
  }

  boot();
})();
