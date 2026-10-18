/* =====================================================================
 * zx-auth.js — 三站共用：建立 Supabase client（全域 sb）、登入畫面、成員角色、同步狀態徽章
 * 依賴：supabase-js@2（UMD，全域 supabase）、zx-config.js
 * 用法：ZX.boot({ site: 'report', onReady: async ctx => { ... } })
 *   ctx = { sb, user, member: {role, display_name, icon}, can: {write, delete} }
 * 三站部署在同一個 GitHub Pages 網域時共用登入狀態（storageKey 相同）。
 * ===================================================================== */
(function (global) {
  'use strict';

  var cfg = global.ZX_CONFIG;
  var sb = null;
  var ctx = null;

  var CSS = '' +
    '.zx-login{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;' +
    'background:rgba(244,241,250,.92);backdrop-filter:blur(6px);font-family:var(--font-body,system-ui)}' +
    '.zx-login[hidden]{display:none}' +
    '.zx-login-card{width:100%;max-width:380px;background:var(--clay-surface,#FBFAFE);border-radius:var(--radius-card,32px);' +
    'box-shadow:var(--clay-shadow);padding:32px 28px;color:var(--clay-text,#332F3A)}' +
    '.zx-login-card h1{font-family:var(--font-heading);font-size:22px;margin:12px 0 4px;text-align:center}' +
    '.zx-login-card p{margin:0 0 18px;color:var(--clay-text-2,#635F69);font-size:14px;text-align:center}' +
    '.zx-login-card label{display:block;font-size:13px;font-weight:700;margin:12px 0 6px}' +
    '.zx-login-card input{width:100%;box-sizing:border-box}' +
    '.zx-login-card .zx-login-btn{width:100%;margin-top:20px}' +
    '.zx-login-err{color:#B91C1C;font-size:13px;min-height:18px;margin-top:10px;text-align:center}' +
    '.zx-login-logo{display:block;width:72px;height:72px;margin:0 auto}' +
    '.zx-user-chip{display:inline-flex;align-items:center;gap:8px;font:600 13px var(--font-body,system-ui);' +
    'padding:4px 6px 4px 10px;border-radius:999px;background:var(--clay-surface,#fff);box-shadow:var(--clay-shadow);color:var(--clay-text,#332F3A)}' +
    '.zx-user-chip img{width:22px;height:22px;border-radius:50%;object-fit:contain}' +
    '.zx-user-chip .zx-role{font-size:11px;color:var(--clay-text-2,#635F69)}' +
    '.zx-user-chip button{border:0;background:transparent;color:var(--clay-text-2,#635F69);font:600 12px inherit;cursor:pointer;' +
    'padding:4px 8px;border-radius:999px}.zx-user-chip button:hover{background:var(--clay-surface-sunken,#ECE8F4)}' +
    '.zx-env-dev{position:fixed;left:8px;bottom:8px;z-index:9999;font:700 11px var(--font-mono,monospace);background:#FEF3C7;' +
    'color:#92400E;padding:3px 8px;border-radius:8px}' +
    '@media print{.zx-login,.zx-user-chip,.zx-env-dev,.sync-badge{display:none!important}}';

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html != null) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var ROLE_LABEL = { admin: '管理員', staff: '一般', viewer: '唯讀' };

  // 使用者圖示（沿用打勾單的 PNG）集中放在 shared/icons/；舊資料只存檔名，例如 kitty.png
  var SHARED_BASE = (function () {
    var s = document.querySelector('script[src*="zx-auth.js"]');
    return s ? s.getAttribute('src').replace(/zx-auth\.js.*$/, '') : '../shared/';
  })();
  function iconUrl(icon) {
    if (!icon) return '';
    if (/^(https?:|data:|\/)/.test(icon) || icon.indexOf('/') > -1) return icon;
    return SHARED_BASE + 'icons/' + icon;
  }

  function loginOverlay(siteTitle, logoSrc) {
    var ov = document.getElementById('zx-login');
    if (ov) return ov;
    ov = el('div', { id: 'zx-login', class: 'zx-login', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'zx-login-title' },
      '<form class="zx-login-card" novalidate>' +
        (logoSrc ? '<img class="zx-login-logo" src="' + esc(logoSrc) + '" alt="">' : '') +
        '<h1 id="zx-login-title">' + esc(siteTitle) + '</h1>' +
        '<p>忠欣蔬果內部系統，請以公司帳號登入</p>' +
        '<label for="zx-login-email">Email</label>' +
        '<input class="clay-input" id="zx-login-email" type="email" autocomplete="username" required>' +
        '<label for="zx-login-pw">密碼</label>' +
        '<input class="clay-input" id="zx-login-pw" type="password" autocomplete="current-password" required>' +
        '<button class="clay-btn clay-btn--primary zx-login-btn" type="submit">登入</button>' +
        '<div class="zx-login-err" role="alert" aria-live="assertive"></div>' +
      '</form>');
    document.body.appendChild(ov);
    return ov;
  }

  function renderUserChip(member, user) {
    var host = document.getElementById('zx-user-chip');
    if (!host) return;
    var icon = member.icon ? '<img src="' + esc(iconUrl(member.icon)) + '" alt="">' : '';
    host.className = 'zx-user-chip';
    host.innerHTML = icon + '<span>' + esc(member.display_name || user.email) + '</span>' +
      '<span class="zx-role">' + esc(ROLE_LABEL[member.role] || member.role) + '</span>' +
      '<button type="button" data-zx-logout>登出</button>';
    host.querySelector('[data-zx-logout]').onclick = function () {
      sb.auth.signOut().finally(function () { location.reload(); });
    };
  }

  async function loadMember(user) {
    var r = await sb.from('app_members').select('role,display_name,icon,is_active').eq('user_id', user.id).maybeSingle();
    if (r.error) throw r.error;
    return r.data && r.data.is_active ? r.data : null;
  }

  async function boot(opts) {
    var style = el('style', {}, CSS);
    document.head.appendChild(style);
    if (cfg.env !== 'production') document.body.appendChild(el('div', { class: 'zx-env-dev' }, '本機測試環境'));

    sb = global.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'zx-auth-' + cfg.url.replace(/\W/g, '') },
      global: opts.fetch ? { fetch: opts.fetch } : undefined,
      realtime: { params: { eventsPerSecond: 20 } }
    });
    global.sb = sb;

    var sessionRes = await sb.auth.getSession();
    var session = sessionRes.data.session;
    if (!session) session = await askLogin(opts);

    var member;
    try { member = await loadMember(session.user); }
    catch (e) { member = null; console.error('[zx-auth] 讀取成員資料失敗', e); }
    if (!member) {
      var ov = loginOverlay(opts.title || '忠欣蔬果', opts.logo);
      ov.hidden = false;
      ov.querySelector('.zx-login-err').textContent = '這個帳號尚未加入成員名單（app_members），請聯絡管理員。';
      ov.querySelector('form').onsubmit = function (e) { e.preventDefault(); sb.auth.signOut().finally(function () { location.reload(); }); };
      ov.querySelector('.zx-login-btn').textContent = '改用其他帳號';
      return null;
    }
    renderUserChip(member, session.user);
    sb.realtime.setAuth(session.access_token);
    sb.auth.onAuthStateChange(function (ev, s) {
      if (ev === 'SIGNED_OUT') location.reload();
      if (s && s.access_token) sb.realtime.setAuth(s.access_token);
    });

    ctx = {
      sb: sb, user: session.user, member: member,
      can: { write: member.role === 'admin' || member.role === 'staff', delete: member.role === 'admin' }
    };
    document.documentElement.dataset.zxRole = member.role;
    await opts.onReady(ctx);
    return ctx;
  }

  function askLogin(opts) {
    return new Promise(function (resolve) {
      var ov = loginOverlay(opts.title || '忠欣蔬果', opts.logo);
      ov.hidden = false;
      var form = ov.querySelector('form');
      var err = ov.querySelector('.zx-login-err');
      // 只在使用者還沒開始輸入時才自動聚焦，避免密碼管理員或快速輸入時把焦點搶回 Email 欄
      setTimeout(function () {
        var email = ov.querySelector('#zx-login-email');
        if (!ov.contains(document.activeElement) && !email.value) email.focus();
      }, 50);
      form.onsubmit = async function (e) {
        e.preventDefault();
        err.textContent = '';
        var btn = form.querySelector('.zx-login-btn');
        btn.disabled = true; btn.textContent = '登入中…';
        var r = await sb.auth.signInWithPassword({
          email: form.querySelector('#zx-login-email').value.trim(),
          password: form.querySelector('#zx-login-pw').value
        });
        btn.disabled = false; btn.textContent = '登入';
        if (r.error) { err.textContent = r.error.message === 'Invalid login credentials' ? '帳號或密碼錯誤' : r.error.message; return; }
        ov.hidden = true;
        resolve(r.data.session);
      };
    });
  }

  /* 同步狀態徽章：state = live | catching-up | fallback | offline | paused | pending | error */
  var BADGE_TEXT = {
    live: '已同步', 'catching-up': '同步中…', fallback: '即時連線中斷，每 30 秒檢查', offline: '離線中，恢復後自動補同步',
    paused: '分頁未顯示，已暫停', pending: '儲存中…', error: '同步失敗，將自動重試'
  };
  function syncBadge(state, text) {
    var b = document.getElementById('zx-sync-badge');
    if (!b) return;
    b.dataset.state = state;
    b.textContent = text || BADGE_TEXT[state] || state;
  }

  global.ZX = { boot: boot, syncBadge: syncBadge, esc: esc, iconUrl: iconUrl, get ctx() { return ctx; } };
})(window);
