/* =====================================================================
 * zx-nav.js — 三站共用側邊欄（同一個網站內切換三個獨立頁面）
 * 用法：<script src="../shared/zx-nav.js" data-site="tick" data-root="../"></script>
 *   data-site：home | tick | report | quote | tools（目前頁面，決定反白項目）
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
    collapse: '<path d="m14.5 6-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>';
  }

  var ITEMS = [
    { key: 'home', label: '首頁', href: ROOT + 'index.html', sub: '系統總覽' },
    { key: 'tick', label: '打勾單', href: ROOT + 'tick/', sub: '每日叫貨狀態' },
    { key: 'report', label: '異常表與交接表', href: ROOT + 'report/', sub: '異常事件・交接事項' },
    { key: 'quote', label: '報價單匯出', href: ROOT + 'quote/', sub: '客戶報價轉匯入格式' },
    { key: 'tools', label: '資料搬移', href: ROOT + 'tools/migrate.html', sub: '只限管理員', admin: true }
  ];

  var CSS = '' +
    ':root{--zx-nav-w:248px;--zx-nav-w-mini:84px}' +
    'html.zx-has-nav body{padding-left:var(--zx-nav-w)}' +
    'html.zx-has-nav.zx-nav-mini body{padding-left:var(--zx-nav-w-mini)}' +
    '.zx-sidebar{position:fixed;left:0;top:0;bottom:0;width:var(--zx-nav-w);z-index:900;display:flex;flex-direction:column;' +
      'gap:6px;padding:18px 14px;background:var(--clay-surface,#FBFAFE);box-shadow:8px 0 32px rgba(124,58,237,.10),' +
      'inset -1px 0 0 rgba(124,58,237,.08);font-family:var(--font-body,system-ui);transition:width .2s ease,transform .22s ease;overflow:hidden}' +
    'html.zx-nav-mini .zx-sidebar{width:var(--zx-nav-w-mini)}' +
    '.zx-nav-brand{display:flex;align-items:center;gap:10px;padding:4px 6px 14px;text-decoration:none;color:var(--clay-text,#332F3A)}' +
    '.zx-nav-brand img{width:44px;height:44px;flex:none;border-radius:16px;background:var(--clay-canvas,#F4F1FA);box-shadow:var(--clay-shadow)}' +
    '.zx-nav-brand b{font:800 18px var(--font-heading,system-ui);white-space:nowrap}' +
    '.zx-nav-brand small{display:block;font:600 11.5px var(--font-body,system-ui);color:var(--clay-text-2,#635F69)}' +
    '.zx-nav-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}' +
    '.zx-nav-list li[hidden]{display:none}' +
    '.zx-nav-link{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:20px;text-decoration:none;' +
      'color:var(--clay-text,#332F3A);white-space:nowrap;transition:background .15s,box-shadow .18s,transform .18s var(--ease-clay,ease)}' +
    '.zx-nav-link svg{flex:none;color:var(--clay-text-2,#635F69)}' +
    '.zx-nav-link span{display:flex;flex-direction:column;min-width:0}' +
    '.zx-nav-link b{font:700 15px var(--font-body,system-ui)}' +
    '.zx-nav-link small{font-size:11.5px;color:var(--clay-text-2,#635F69)}' +
    '.zx-nav-link:hover{background:var(--clay-canvas,#F4F1FA);transform:translateX(2px)}' +
    '.zx-nav-link[aria-current="page"]{background:var(--clay-canvas,#F4F1FA);box-shadow:var(--clay-shadow-pressed)}' +
    '.zx-nav-link[aria-current="page"] svg,.zx-nav-link[aria-current="page"] b{color:var(--clay-purple,#7C3AED)}' +
    '.zx-nav-link[data-key="tick"][aria-current="page"] svg{color:#047857}' +
    '.zx-nav-link[data-key="report"][aria-current="page"] svg{color:#C2261F}' +
    '.zx-nav-link[data-key="quote"][aria-current="page"] svg{color:#1F7A3D}' +
    '.zx-nav-link:focus-visible,.zx-nav-btn:focus-visible{outline:none;box-shadow:var(--focus-ring,0 0 0 3px #7C3AED)}' +
    'html.zx-nav-mini .zx-nav-link span,html.zx-nav-mini .zx-nav-brand span,html.zx-nav-mini .zx-nav-collapse span{display:none}' +
    'html.zx-nav-mini .zx-nav-link{justify-content:center;padding:12px}' +
    '.zx-nav-foot{margin-top:auto;display:flex;flex-direction:column;gap:8px}' +
    '.zx-nav-btn{border:0;cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:18px;' +
      'background:var(--clay-surface-sunken,#ECE8F4);color:var(--clay-text-2,#635F69);font:700 13px var(--font-body,system-ui)}' +
    'html.zx-nav-mini .zx-nav-collapse{justify-content:center}html.zx-nav-mini .zx-nav-collapse svg{transform:rotate(180deg)}' +
    '.zx-nav-fab{display:none}' +
    '.zx-nav-scrim{display:none}' +
    '@media (max-width:899px){' +
      'html.zx-has-nav body,html.zx-has-nav.zx-nav-mini body{padding-left:0}' +
      '.zx-sidebar,html.zx-nav-mini .zx-sidebar{width:min(300px,86vw);transform:translateX(-105%);z-index:9500}' +
      'html.zx-nav-open .zx-sidebar{transform:none}' +
      'html.zx-nav-mini .zx-nav-link span,html.zx-nav-mini .zx-nav-brand span{display:flex}' +
      'html.zx-nav-mini .zx-nav-link{justify-content:flex-start;padding:11px 12px}' +
      '.zx-nav-collapse{display:none!important}' +
      '.zx-nav-fab{display:flex;position:fixed;left:14px;bottom:14px;z-index:9400;width:52px;height:52px;border:0;border-radius:20px;' +
        'align-items:center;justify-content:center;cursor:pointer;background:var(--clay-surface,#fff);color:var(--clay-purple,#7C3AED);box-shadow:var(--clay-shadow)}' +
      'html.zx-nav-open .zx-nav-scrim{display:block;position:fixed;inset:0;z-index:9450;background:rgba(51,47,58,.35)}' +
    '}' +
    '@media (prefers-reduced-motion:reduce){.zx-sidebar,.zx-nav-link{transition:none!important}}' +
    '@media print{.zx-sidebar,.zx-nav-fab,.zx-nav-scrim{display:none!important;transition:none!important}' +
      'html.zx-has-nav body,html.zx-has-nav.zx-nav-mini body{padding-left:0!important}}';

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
        '<img src="' + ROOT + 'shared/logo-teruteru.svg" alt="">' +
        '<span><b>忠欣蔬果</b><small>內部系統</small></span></a>' +
      '<ul class="zx-nav-list">' + ITEMS.map(function (it) {
        return '<li' + (it.admin ? ' data-admin hidden' : '') + '><a class="zx-nav-link" data-key="' + it.key + '" href="' + it.href + '" title="' + it.label + '"' +
          (it.key === SITE ? ' aria-current="page"' : '') + '>' + svg(it.key) +
          '<span><b>' + it.label + '</b><small>' + it.sub + '</small></span></a></li>';
      }).join('') + '</ul>' +
      '<div class="zx-nav-foot">' +
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
    });
    try { if (SITE && SITE !== 'home' && SITE !== 'tools') localStorage.setItem('zx-last-site', SITE); } catch (e) {}
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
