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
    'background:var(--zx-canvas,#F3F6F4);font-family:var(--font-body,system-ui)}' +
    '.zx-login[hidden]{display:none}' +
    '.zx-login-card{width:100%;max-width:380px;background:var(--zx-surface,#fff);border:1px solid var(--zx-border,#E3E8E5);' +
    'border-radius:var(--radius-card,16px);box-shadow:var(--zx-shadow-pop);padding:32px 28px;color:var(--zx-text,#1C2520)}' +
    '.zx-login-card h1{font-family:var(--font-heading);font-size:22px;margin:12px 0 4px;text-align:center}' +
    '.zx-login-card p{margin:0 0 18px;color:var(--zx-text-2,#5A6660);font-size:14px;text-align:center}' +
    '.zx-login-card label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px;color:var(--zx-text-2,#5A6660)}' +
    '.zx-login-card input{width:100%;box-sizing:border-box}' +
    '.zx-login-card .zx-login-btn,.zx-login-card .zx-login-start{width:100%;margin-top:20px;justify-content:center;padding:11px 16px}' +
    '.zx-login-card form[hidden]{display:none}' +
    '.zx-login-switch{display:block;margin:14px auto 0;border:0;background:none;color:var(--zx-primary-ink,#0E5E42);' +
    'font:600 13px var(--font-body,system-ui);cursor:pointer;padding:4px 8px;border-radius:8px}' +
    '.zx-login-switch:hover{text-decoration:underline}' +
    '.zx-login-err{color:#B91C1C;font-size:13px;min-height:18px;margin-top:10px;text-align:center}' +
    '.zx-login-logo{display:block;width:64px;height:64px;margin:0 auto;border-radius:16px}' +
    '.zx-user-chip{display:inline-flex;align-items:center;gap:8px;font:600 13px var(--font-body,system-ui);' +
    'padding:4px 6px 4px 6px;border-radius:999px;background:var(--zx-surface,#fff);border:1px solid var(--zx-border,#E3E8E5);color:var(--zx-text,#1C2520)}' +
    '.zx-user-chip img{width:28px;height:28px;border-radius:50%;object-fit:contain;background:var(--zx-primary-soft,#E3F2EA)}' +
    '.zx-user-chip .zx-role{font-size:11px;font-weight:500;color:var(--zx-text-3,#66716B)}' +
    '.zx-user-chip button{border:0;background:transparent;color:var(--zx-text-2,#5A6660);font:600 12px inherit;cursor:pointer;' +
    'padding:5px 10px;border-radius:999px}.zx-user-chip button:hover{background:var(--zx-surface-2,#F6F8F7)}' +
    '.zx-env-dev{position:fixed;right:8px;bottom:8px;z-index:9999;font:700 11px var(--font-mono,monospace);background:#FEF3C7;' +
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
    var lastNick = '';
    try { lastNick = localStorage.getItem('zx-nickname') || ''; } catch (e) {}
    ov = el('div', { id: 'zx-login', class: 'zx-login', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'zx-login-title' },
      '<div class="zx-login-card">' +
        (logoSrc ? '<img class="zx-login-logo" src="' + esc(logoSrc) + '" alt="">' : '') +
        '<h1 id="zx-login-title">' + esc(siteTitle) + '</h1>' +
        // 暱稱模式（預設）：不需帳號，輸入暱稱即可使用
        '<form class="zx-login-nick" novalidate>' +
          '<p>輸入暱稱即可開始使用，暱稱會顯示在操作紀錄上</p>' +
          '<label for="zx-login-nick">暱稱</label>' +
          '<input class="clay-input" id="zx-login-nick" maxlength="12" autocomplete="nickname" placeholder="例如：小美" value="' + esc(lastNick) + '" required>' +
          '<button class="clay-btn clay-btn--primary zx-login-start" type="submit">開始使用</button>' +
          '<button class="zx-login-switch" type="button" id="zx-login-admin">管理員登入</button>' +
        '</form>' +
        // 帳號模式：管理員（刪除、裝置管理）用 Email＋密碼
        '<form class="zx-login-acct" novalidate hidden>' +
          '<p>管理員請以 Email 帳號登入</p>' +
          '<label for="zx-login-email">Email</label>' +
          '<input class="clay-input" id="zx-login-email" type="email" autocomplete="username" required>' +
          '<label for="zx-login-pw">密碼</label>' +
          '<input class="clay-input" id="zx-login-pw" type="password" autocomplete="current-password" required>' +
          '<button class="clay-btn clay-btn--primary zx-login-btn" type="submit">登入</button>' +
          '<button class="zx-login-switch" type="button" id="zx-login-back">← 改用暱稱</button>' +
        '</form>' +
        '<div class="zx-login-err" role="alert" aria-live="assertive"></div>' +
      '</div>');
    document.body.appendChild(ov);
    var nick = ov.querySelector('.zx-login-nick'), acct = ov.querySelector('.zx-login-acct');
    ov.querySelector('#zx-login-admin').onclick = function () {
      nick.hidden = true; acct.hidden = false; ov.querySelector('.zx-login-err').textContent = '';
      ov.querySelector('#zx-login-email').focus();
    };
    ov.querySelector('#zx-login-back').onclick = function () {
      acct.hidden = true; nick.hidden = false; ov.querySelector('.zx-login-err').textContent = '';
      ov.querySelector('#zx-login-nick').focus();
    };
    return ov;
  }

  function renderUserChip(member, user) {
    var host = document.getElementById('zx-user-chip');
    if (!host) return;
    var icon = member.icon ? '<img src="' + esc(iconUrl(member.icon)) + '" alt="">' : '';
    host.className = 'zx-user-chip';
    host.innerHTML = icon + '<span>' + esc(member.display_name || user.email) + '</span>' +
      '<span class="zx-role">' + esc(ROLE_LABEL[member.role] || member.role) + '</span>' +
      (user.is_anonymous ? '<button type="button" data-zx-rename>改暱稱</button>' : '<button type="button" data-zx-logout>登出</button>');
    if (user.is_anonymous) {
      // 暱稱裝置不提供登出：登出後再進來會被當成新裝置
      host.querySelector('[data-zx-rename]').onclick = async function () {
        var n = (prompt('新的暱稱（最多 12 字）', member.display_name || '') || '').trim();
        if (!n) return;
        var r = await sb.rpc('device_register', { p_nickname: n });
        if (r.error || !r.data.ok) { alert('暱稱更新失敗：' + (r.error ? r.error.message : r.data.reason)); return; }
        try { localStorage.setItem('zx-nickname', n); } catch (x) {}
        member.display_name = r.data.display_name;
        renderUserChip(member, user);
      };
      return;
    }
    host.querySelector('[data-zx-logout]').onclick = function () {
      sb.auth.signOut().finally(function () { location.reload(); });
    };
  }

  async function loadMember(user) {
    var r = await sb.from('app_members').select('role,display_name,icon,is_active').eq('user_id', user.id).maybeSingle();
    if (r.error) throw r.error;
    return r.data || null;          // 停用的裝置也回傳（is_active=false），由呼叫端顯示停用訊息
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
    if (!session) session = await askLogin(opts, null);

    var member;
    try { member = await loadMember(session.user); }
    catch (e) { member = null; console.error('[zx-auth] 讀取成員資料失敗', e); }
    // 匿名裝置還沒輸入暱稱（例如上次中途關閉）→ 再請他輸入一次
    if (!member && session.user.is_anonymous && !opts.accountOnly) {
      session = await askLogin(opts, session);
      member = await loadMember(session.user).catch(function () { return null; });
    }
    if (!member || !member.is_active) {
      var ov = loginOverlay(opts.title || '忠欣蔬果', opts.logo);
      ov.hidden = false;
      ov.querySelector('.zx-login-nick').hidden = true;
      ov.querySelector('.zx-login-acct').hidden = false;
      ov.querySelector('.zx-login-err').textContent = member ? '這個裝置／帳號已被管理員停用，請聯絡管理員。'
                                                              : '這個帳號尚未加入成員名單（app_members），請聯絡管理員。';
      ov.querySelector('.zx-login-acct').onsubmit = function (e) { e.preventDefault(); sb.auth.signOut().finally(function () { location.reload(); }); };
      ov.querySelector('.zx-login-btn').textContent = '改用其他帳號';
      return null;
    }
    sb.rpc('device_touch').then(function (r) { if (r.error) console.warn('[zx-auth] device_touch', r.error.message); });
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
    document.dispatchEvent(new CustomEvent('zx:ready', { detail: { role: member.role, anonymous: !!session.user.is_anonymous } }));   // 側邊欄依角色顯示項目
    await opts.onReady(ctx);
    return ctx;
  }

  var REG_MSG = { blocked: '這個裝置已被管理員停用，請聯絡管理員。', disabled: '目前已關閉暱稱登入，請改用帳號登入。' };

  // 登入畫面：預設「輸入暱稱」（匿名登入＋登記裝置），也可切換成管理員帳號登入
  //   existing：已有匿名 session 但尚未登記暱稱時傳入，不再重新匿名登入
  function askLogin(opts, existing) {
    return new Promise(function (resolve) {
      var ov = loginOverlay(opts.title || '忠欣蔬果', opts.logo);
      ov.hidden = false;
      var err = ov.querySelector('.zx-login-err');
      var nickForm = ov.querySelector('.zx-login-nick'), acctForm = ov.querySelector('.zx-login-acct');
      if (existing) ov.querySelector('#zx-login-admin').hidden = true;
      if (opts.accountOnly) {          // 只限管理員的頁面（裝置管理、資料搬移）：直接顯示帳號登入
        nickForm.hidden = true; acctForm.hidden = false;
        ov.querySelector('#zx-login-back').hidden = true;
      }
      // 只在使用者還沒開始輸入時才自動聚焦，避免密碼管理員或快速輸入時把焦點搶回來
      setTimeout(function () {
        var f = ov.querySelector('#zx-login-nick');
        if (ov.contains(document.activeElement)) return;
        if (!nickForm.hidden) f.focus(); else if (!ov.querySelector('#zx-login-email').value) ov.querySelector('#zx-login-email').focus();
      }, 50);

      nickForm.onsubmit = async function (e) {
        e.preventDefault();
        err.textContent = '';
        var nick = ov.querySelector('#zx-login-nick').value.trim();
        if (!nick) { err.textContent = '請輸入暱稱'; return; }
        var btn = nickForm.querySelector('.zx-login-start');
        btn.disabled = true; btn.textContent = '準備中…';
        var done = function (msg) { btn.disabled = false; btn.textContent = '開始使用'; if (msg) err.textContent = msg; };
        var s = existing || (await sb.auth.getSession()).data.session;
        if (!s) {
          var a = await sb.auth.signInAnonymously();
          if (a.error) return done(/anonymous/i.test(a.error.message) ? '暱稱登入尚未開啟（Supabase 需開啟 Anonymous sign-ins），請改用帳號登入。' : a.error.message);
          s = a.data.session;
        }
        var r = await sb.rpc('device_register', { p_nickname: nick });
        if (r.error) return done(r.error.message);
        if (!r.data.ok) {
          if (r.data.reason === 'disabled') await sb.auth.signOut();
          existing = null;
          return done(REG_MSG[r.data.reason] || r.data.reason);
        }
        try { localStorage.setItem('zx-nickname', nick); } catch (x) {}
        done();
        ov.hidden = true;
        resolve(s);
      };

      acctForm.onsubmit = async function (e) {
        e.preventDefault();
        err.textContent = '';
        var btn = acctForm.querySelector('.zx-login-btn');
        btn.disabled = true; btn.textContent = '登入中…';
        var r = await sb.auth.signInWithPassword({
          email: acctForm.querySelector('#zx-login-email').value.trim(),
          password: acctForm.querySelector('#zx-login-pw').value
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
