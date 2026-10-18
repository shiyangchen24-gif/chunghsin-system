/* =====================================================================
 * zx-nav.js — 三站共用側邊欄（同一個網站內切換三個獨立頁面）
 * 用法：<script src="../shared/zx-nav.js" data-site="tick" data-root="../"></script>
 *   data-site：home | tick | report | quote | monthly | devices | tools（目前頁面，決定反白項目）
 *   data-root：網站根目錄的相對路徑（根目錄 index.html 用 "./"，子頁用 "../"）
 * 桌機：固定在左側，可收合成圖示列（記住在本機）；手機／平板（< 900px）：左下角按鈕開啟抽屜。
 * 列印時完全隱藏、不佔版面，不影響原本的列印與 Excel 格式。
 * ===================================================================== */
(function () {
  'use strict';
  var me = document.currentScript;
  var SITE = (me && me.dataset.site) || '';
  var ROOT = (me && me.dataset.root) || '../';
  var KEY = 'zx-nav-collapsed';

  var ICON = {
    home: '<path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    tick: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>',
    report: '<path d="M12 4 3.5 19h17z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    quote: '<path d="M7 3.5h7l4.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16h7"/>',
    tools: '<path d="M4 7h11M4 12h16M4 17h9"/><path d="m17 5 3 2-3 2M15 15l3 2-3 2"/>',
    monthly: '<path d="M5 20V10M10 20V5M15 20v-7M20 20V8"/>',
    devices: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.7v.4M12 16.6v.3"/>',
    logout: '<path d="M14 4.5h3.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 16l-4-4 4-4M6 12h9"/>',
    collapse: '<path d="m14.5 6-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>';
  }

  var MENU = [
    { key: 'home', icon: 'home', label: '儀表板', href: ROOT + 'index.html' },
    { key: 'tick', icon: 'tick', label: '打勾單', href: ROOT + 'tick/' },
    { key: 'report', icon: 'report', label: '異常表與交接表', href: ROOT + 'report/' },
    { key: 'quote', icon: 'quote', label: '報價單匯出', href: ROOT + 'quote/' },
    { key: 'monthly', icon: 'monthly', label: '經營月報', href: ROOT + 'reports/monthly.html' }
  ];
  var GENERAL = [
    { key: 'devices', icon: 'devices', label: '裝置管理', href: ROOT + 'tools/devices.html', admin: true },
    { key: 'tools', icon: 'tools', label: '資料搬移', href: ROOT + 'tools/migrate.html', admin: true },
    { key: 'help', icon: 'help', label: '使用說明', href: 'https://github.com/shiyangchen24-gif/chunghsin-system#readme', external: true },
    { key: 'logout', icon: 'logout', label: '登出', action: 'logout', authOnly: true }
  ];

  var CSS = '' +
    ':root{--zx-nav-w:236px;--zx-nav-w-mini:76px}' +
    'html.zx-has-nav body{padding-left:var(--zx-nav-w)}' +
    'html.zx-has-nav.zx-nav-mini body{padding-left:var(--zx-nav-w-mini)}' +
    '.zx-sidebar{position:fixed;left:0;top:0;bottom:0;width:var(--zx-nav-w);z-index:900;display:flex;flex-direction:column;' +
      'padding:20px 14px 16px;background:var(--zx-surface,#fff);border-right:1px solid var(--zx-border,#E3E8E5);' +
      'font-family:var(--font-body,system-ui);transition:width .2s ease,transform .22s ease;overflow-x:hidden;overflow-y:auto}' +
    'html.zx-nav-mini .zx-sidebar{width:var(--zx-nav-w-mini)}' +
    '.zx-nav-brand{display:flex;align-items:center;gap:10px;padding:2px 6px 22px;text-decoration:none;color:var(--zx-text,#1C2520)}' +
    '.zx-nav-brand .zx-nav-logo{width:38px;height:38px;flex:none;border-radius:11px;background:var(--zx-primary,#15805A);display:flex;align-items:center;justify-content:center}' +
    '.zx-nav-brand .zx-nav-logo img{width:38px;height:38px;border-radius:11px}' +
    '.zx-nav-brand b{font:700 17px var(--font-body,system-ui);white-space:nowrap;letter-spacing:-.01em}' +
    '.zx-nav-sec{font:600 12px var(--font-body,system-ui);color:var(--zx-text-3,#66716B);padding:0 10px 8px;white-space:nowrap}' +
    '.zx-nav-list{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:2px}' +
    '.zx-nav-list li[hidden]{display:none}' +
    '.zx-nav-link{display:flex;align-items:center;gap:11px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:transparent;' +
      'text-decoration:none;color:var(--zx-text-2,#5A6660);font:500 14px var(--font-body,system-ui);white-space:nowrap;cursor:pointer;text-align:left;' +
      'transition:background .15s,color .15s}' +
    '.zx-nav-link svg{flex:none}' +
    '.zx-nav-link:hover{background:var(--zx-surface-2,#F6F8F7);color:var(--zx-text,#1C2520)}' +
    '.zx-nav-link[aria-current="page"]{background:var(--zx-primary-soft,#E3F2EA);color:var(--zx-primary-ink,#0E5E42);font-weight:600}' +
    '.zx-nav-link:focus-visible,.zx-nav-btn:focus-visible,.zx-nav-help a:focus-visible{outline:none;box-shadow:var(--focus-ring,0 0 0 3px #15805A)}' +
    'html.zx-nav-mini .zx-nav-label,html.zx-nav-mini .zx-nav-brand b,html.zx-nav-mini .zx-nav-sec,html.zx-nav-mini .zx-nav-help,' +
      'html.zx-nav-mini .zx-nav-collapse span{display:none}' +
    'html.zx-nav-mini .zx-nav-link{justify-content:center}' +
    'html.zx-nav-mini .zx-nav-sec+.zx-nav-list{margin-top:8px}' +
    '.zx-nav-foot{margin-top:auto;display:flex;flex-direction:column;gap:10px}' +
    '.zx-nav-help{background:var(--zx-primary-soft,#E3F2EA);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:6px}' +
    '.zx-nav-help b{font:700 14px var(--font-body,system-ui);color:var(--zx-text,#1C2520)}' +
    '.zx-nav-help p{margin:0 0 6px;font-size:12.5px;line-height:1.5;color:var(--zx-text-2,#5A6660)}' +
    '.zx-nav-help .zx-nav-sync{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--zx-primary-ink,#0E5E42)}' +
    '.zx-nav-help .zx-nav-sync::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}' +
    '.zx-nav-help .zx-nav-sync[data-state="fallback"],.zx-nav-help .zx-nav-sync[data-state="catching-up"]{color:#9A5B00}' +
    '.zx-nav-help .zx-nav-sync[data-state="offline"],.zx-nav-help .zx-nav-sync[data-state="error"]{color:#B91C1C}' +
    '.zx-nav-help a{display:block;text-align:center;text-decoration:none;font:600 13px var(--font-body,system-ui);padding:8px 10px;border-radius:9px}' +
    '.zx-nav-help a.primary{background:var(--zx-primary,#15805A);color:#fff}' +
    '.zx-nav-help a.secondary{background:#fff;color:var(--zx-text,#1C2520);border:1px solid var(--zx-border,#E3E8E5)}' +
    '.zx-nav-btn{border:0;cursor:pointer;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;' +
      'background:transparent;color:var(--zx-text-3,#66716B);font:600 12.5px var(--font-body,system-ui)}' +
    '.zx-nav-btn:hover{background:var(--zx-surface-2,#F6F8F7)}' +
    'html.zx-nav-mini .zx-nav-collapse{justify-content:center}html.zx-nav-mini .zx-nav-collapse svg{transform:rotate(180deg)}' +
    '.zx-nav-fab{display:none}' +
    '.zx-nav-scrim{display:none}' +
    '@media (max-width:899px){' +
      'html.zx-has-nav body,html.zx-has-nav.zx-nav-mini body{padding-left:0}' +
      '.zx-sidebar,html.zx-nav-mini .zx-sidebar{width:min(280px,86vw);transform:translateX(-105%);z-index:9500;box-shadow:var(--zx-shadow-pop)}' +
      'html.zx-nav-open .zx-sidebar{transform:none}' +
      'html.zx-nav-mini .zx-nav-label,html.zx-nav-mini .zx-nav-brand b,html.zx-nav-mini .zx-nav-sec{display:inline}' +
      'html.zx-nav-mini .zx-nav-help{display:flex}html.zx-nav-mini .zx-nav-link{justify-content:flex-start}' +
      '.zx-nav-collapse{display:none!important}' +
      '.zx-nav-fab{display:flex;position:fixed;left:14px;bottom:14px;z-index:9400;width:48px;height:48px;border:1px solid var(--zx-border,#E3E8E5);border-radius:14px;' +
        'align-items:center;justify-content:center;cursor:pointer;background:var(--zx-surface,#fff);color:var(--zx-primary,#15805A);box-shadow:var(--zx-shadow-hover)}' +
      'html.zx-nav-open .zx-nav-scrim{display:block;position:fixed;inset:0;z-index:9450;background:rgba(16,24,20,.35)}' +
    '}' +
    '@media (prefers-reduced-motion:reduce){.zx-sidebar,.zx-nav-link{transition:none!important}}' +
    '@media print{.zx-sidebar,.zx-nav-fab,.zx-nav-scrim{display:none!important;transition:none!important}' +
      'html.zx-has-nav body,html.zx-has-nav.zx-nav-mini body{padding-left:0!important}}';

  function itemHtml(it) {
    var inner = svg(it.icon) + '<span class="zx-nav-label">' + it.label + '</span>';
    var attrs = ' data-key="' + it.key + '" title="' + it.label + '"';
    var li = '<li' + (it.admin ? ' data-admin hidden' : '') + (it.authOnly ? ' data-auth hidden' : '') + '>';
    if (it.action) return li + '<button type="button" class="zx-nav-link"' + attrs + ' data-action="' + it.action + '">' + inner + '</button></li>';
    return li + '<a class="zx-nav-link" href="' + it.href + '"' + attrs + (it.external ? ' target="_blank" rel="noopener"' : '') +
      (it.key === SITE ? ' aria-current="page"' : '') + '>' + inner + '</a></li>';
  }

  function build() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    var html = document.documentElement;
    html.classList.add('zx-has-nav');
    try { if (localStorage.getItem(KEY) === '1') html.classList.add('zx-nav-mini'); } catch (e) {}

    var nav = document.createElement('nav');
    nav.className = 'zx-sidebar';
    nav.id = 'zx-sidebar';
    nav.setAttribute('aria-label', '系統選單');
    nav.innerHTML =
      '<a class="zx-nav-brand" href="' + ROOT + 'index.html" title="忠欣蔬果">' +
        '<span class="zx-nav-logo"><img src="' + ROOT + 'shared/logo.svg" alt=""></span><b>忠欣蔬果</b></a>' +
      '<div class="zx-nav-sec" id="zx-nav-sec-menu">選單</div>' +
      '<ul class="zx-nav-list" aria-labelledby="zx-nav-sec-menu">' + MENU.map(itemHtml).join('') + '</ul>' +
      '<div class="zx-nav-sec" id="zx-nav-sec-general">一般</div>' +
      '<ul class="zx-nav-list" aria-labelledby="zx-nav-sec-general">' + GENERAL.map(itemHtml).join('') + '</ul>' +
      '<div class="zx-nav-foot">' +
        '<div class="zx-nav-help"><b>即時同步</b>' +
          '<span class="zx-nav-sync" data-state="pending" aria-live="polite">登入後開始同步</span>' +
          '<p>所有裝置的變更會在 1～3 秒內自動出現，不需要重新整理。</p>' +
          '<a class="primary" href="https://github.com/shiyangchen24-gif/chunghsin-system#readme" target="_blank" rel="noopener">操作說明</a></div>' +
        '<button type="button" class="zx-nav-btn zx-nav-collapse" aria-controls="zx-sidebar">' + svg('collapse') + '<span>收合選單</span></button>' +
      '</div>';
    document.body.insertBefore(nav, document.body.firstChild);

    var scrim = document.createElement('div');
    scrim.className = 'zx-nav-scrim';
    document.body.appendChild(scrim);
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'zx-nav-fab';
    fab.setAttribute('aria-label', '開啟系統選單');
    fab.setAttribute('aria-controls', 'zx-sidebar');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = svg('menu');
    document.body.appendChild(fab);

    var collapse = nav.querySelector('.zx-nav-collapse');
    function syncCollapse() {
      var mini = html.classList.contains('zx-nav-mini');
      collapse.setAttribute('aria-expanded', mini ? 'false' : 'true');
      collapse.title = mini ? '展開選單' : '收合選單';
    }
    collapse.addEventListener('click', function () {
      html.classList.toggle('zx-nav-mini');
      try { localStorage.setItem(KEY, html.classList.contains('zx-nav-mini') ? '1' : '0'); } catch (e) {}
      syncCollapse();
    });
    syncCollapse();

    function setOpen(open) {
      html.classList.toggle('zx-nav-open', open);
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var cur = nav.querySelector('[aria-current="page"]') || nav.querySelector('a'); cur.focus(); }
      else fab.focus();
    }
    fab.addEventListener('click', function () { setOpen(!html.classList.contains('zx-nav-open')); });
    scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && html.classList.contains('zx-nav-open')) setOpen(false);
    });

    // 登入後才知道角色：管理員才顯示「資料搬移」
    document.addEventListener('zx:ready', function (e) {
      if (e.detail && e.detail.role === 'admin') nav.querySelectorAll('[data-admin]').forEach(function (li) { li.hidden = false; });
      // 暱稱裝置不顯示「登出」：登出後再進來會被當成新裝置（改暱稱在右上角）
      if (!(e.detail && e.detail.anonymous)) nav.querySelectorAll('[data-auth]').forEach(function (li) { li.hidden = false; });
    });
    nav.addEventListener('click', function (e) {
      var b = e.target.closest('[data-action="logout"]');
      if (!b || !window.sb) return;
      window.sb.auth.signOut().finally(function () { location.reload(); });
    });
    // 側邊欄的同步狀態跟著頁面的同步徽章走
    var navSync = nav.querySelector('.zx-nav-sync');
    var TEXT = { live: '已同步', 'catching-up': '同步中…', fallback: '即時連線中斷，每 30 秒檢查', offline: '離線中', paused: '分頁未顯示，已暫停', pending: '儲存中…', error: '同步失敗，將自動重試' };
    new MutationObserver(function () {
      var badge = document.getElementById('zx-sync-badge');
      if (!badge || !badge.dataset.state) return;
      // 只在狀態真的改變時才寫入：側邊欄本身也在觀察範圍內，無條件寫入會觸發自己而無限循環
      if (navSync.dataset.state === badge.dataset.state) return;
      navSync.dataset.state = badge.dataset.state;
      navSync.textContent = TEXT[badge.dataset.state] || badge.textContent;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    try { if (SITE && ['tick', 'report', 'quote'].indexOf(SITE) > -1) localStorage.setItem('zx-last-site', SITE); } catch (e) {}
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
