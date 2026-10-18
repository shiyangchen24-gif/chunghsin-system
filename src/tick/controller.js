// ══════════════════════════════════════════════════════════
//  新版資料層（三站整合）
//  原版：每勾一次就讀整份 zhongxin_v4、再覆寫 zhongxin_v4 + zhongxin_hist_v4 兩大份 JSON，
//        其他裝置收到 Postgres Changes 後再整張表重抓，另外每 30 秒全量輪詢 → Egress 爆量的主因。
//  新版：一勾只寫一列（tick_set_status RPC，約 200 bytes），其他裝置只收到該客戶的小事件；
//        db／historyLog 等記憶體結構維持原格式，原版畫面程式（卡片、後台表、列印、趨勢圖）不用改。
//  lockLocal 只保護畫面；真正防止覆寫靠伺服器 revision 比對與 request_id 去重。
// ══════════════════════════════════════════════════════════

let ZXC = null;
let tickSync = null;
let serviceDateISO = null;            // 目前營業日（伺服器決定，不看裝置時鐘）
const codeOf = new Map();             // 顯示名稱 → 客戶代號
const nameOf = new Map();             // 客戶代號 → 顯示名稱
let tickStreak = new Map();           // 名稱 → 連續未叫天數（後台表用，切到後台才讀）
let warn3Overrides = new Map();       // 客戶代號 → 'add' | 'remove'
let warn3Codes = new Set();           // 伺服器算好的三天未叫（自動＋手動）
let dailyCounts = new Map();          // 'YYYY/MM/DD' → { ord, no, total }
const countsLoadedMonths = new Set();
let manualDataSynced = {};
let noticesSynced = new Map();        // 舊 id → 資料庫 id
let seriesDefs = [];                  // [{ id, key, label, rule }]
let groupIds = new Map();             // 群組名 → id

function isoToSlash(iso) { return iso ? iso.replace(/-/g, '/') : ''; }
function hhmm(ts) {
  const d = ts ? new Date(ts) : new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 原版的推送函式不再需要（保留空殼，避免遺漏的呼叫報錯）
function lockLocal() {}
function unlockLocal() {}
function touchTs() { return Date.now(); }
function save() {}
function saveHistory() {}
function pushInBackground() {}

/* ---------------- 讀取 ---------------- */

async function fetchAll(table, cols, apply) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols);
    if (apply) q = apply(q);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function loadServiceDay() {
  let { data, error } = await sb.from('tick_service_days').select('service_date').eq('status', 'open').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    // 全新專案還沒有營業日：開立第一天（今天）
    const r = await sb.rpc('tick_reset_day', { p_expected_open: null, p_new_date: todayISO, p_request_id: zxSync.uuid() });
    if (r.error) throw new Error(r.error.message);
    data = { service_date: r.data.open };
  }
  serviceDateISO = data.service_date;
  todayStr = isoToSlash(serviceDateISO);
  today = new Date(serviceDateISO + 'T00:00:00');
  document.getElementById('topbar-date').textContent = todayStr;
}

async function loadCustomers() {
  const rows = await fetchAll('tick_customers', 'customer_code,fixed,legacy_name,is_listed,customers(name)', q => q.eq('is_listed', true).order('customer_code'));
  const next = {};
  codeOf.clear(); nameOf.clear();
  rows.forEach(r => {
    const name = r.legacy_name || (r.customers && r.customers.name) || r.customer_code;
    codeOf.set(name, r.customer_code);
    nameOf.set(r.customer_code, name);
    const old = db[name];
    next[name] = { status: old ? old.status : '未叫貨', date: old ? old.date : '', fixed: r.fixed || '',
                   _code: r.customer_code, _rev: old ? old._rev : null, _id: old ? old._id : null };
  });
  db = next;
}

async function loadDayStatuses() {
  const rows = await fetchAll('daily_order_status', 'id,customer_code,status,revision,last_actor_name,last_actor_icon,updated_at',
    q => q.eq('service_date', serviceDateISO));
  Object.values(db).forEach(d => { d.status = '未叫貨'; d.date = ''; d._rev = null; d._id = null; });
  const editLog = {};
  rows.forEach(r => {
    const n = nameOf.get(r.customer_code);
    if (!n || !db[n]) return;
    db[n].status = r.status;
    db[n].date = r.status === '未叫貨' ? '' : 'ordered';
    db[n]._rev = r.revision;
    db[n]._id = r.id;
    if (r.last_actor_name) editLog[n] = [{ time: hhmm(r.updated_at), status: r.status, user: r.last_actor_name, icon: r.last_actor_icon || '' }];
  });
  historyLog = [{ date: todayStr, records: {}, editLog, _lite: true }];
}

// 後台表需要今日完整操作紀錄：切到後台時才讀（原版每次同步都整份傳）
let todayLogFull = false;
async function loadTodayEvents() {
  const rows = await fetchAll('order_status_events', 'customer_code,new_status,actor_name,actor_icon,created_at,commit_seq',
    q => q.eq('service_date', serviceDateISO).order('commit_seq'));
  const editLog = {};
  rows.forEach(r => {
    const n = nameOf.get(r.customer_code);
    if (!n) return;
    (editLog[n] = editLog[n] || []).push({ time: hhmm(r.created_at), status: r.new_status, user: r.actor_name || '?', icon: r.actor_icon || '' });
  });
  historyLog = [{ date: todayStr, records: {}, editLog }];
  todayLogFull = true;
}

async function loadGroups() {
  const groups = await fetchAll('order_groups', 'id,kind,name,sort_order,rule', q => q.order('sort_order'));
  const members = await fetchAll('order_group_members', 'group_id,customer_code,sort_order', q => q.order('sort_order'));
  groupIds = new Map();
  groupOrder = {};
  seriesDefs = [];
  const byId = new Map(groups.map(g => [g.id, g]));
  groups.forEach(g => {
    if (g.kind === 'group') { groupIds.set(g.name, g.id); groupOrder[g.name] = []; }
    else seriesDefs.push({ id: g.id, key: g.name, label: g.name, rule: g.rule || { prefix: [g.name] }, members: [] });
  });
  members.forEach(m => {
    const g = byId.get(m.group_id);
    const n = nameOf.get(m.customer_code);
    if (!g || !n) return;
    if (g.kind === 'group') groupOrder[g.name].push(n);
    else { const s = seriesDefs.find(x => x.id === g.id); if (s) s.members.push(n); }
  });
  SERIES_LIST.length = 0;
  seriesDefs.forEach(s => SERIES_LIST.push({ key: s.key, label: s.label }));
}

async function loadWarn3() {
  const [{ data: w, error: e1 }, { data: o, error: e2 }] = await Promise.all([
    sb.from('v_tick_warn3').select('customer_code,source'),
    sb.from('tick_warn3_overrides').select('customer_code,mode')
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  warn3Codes = new Set(w.map(r => r.customer_code));
  warn3Overrides = new Map(o.map(r => [r.customer_code, r.mode]));
  manualWarn3 = new Set(w.map(r => nameOf.get(r.customer_code)).filter(Boolean));
}

async function loadStreaks() {
  const rows = await fetchAll('v_tick_streak', 'customer_code,streak');
  tickStreak = new Map(rows.map(r => [nameOf.get(r.customer_code), r.streak]));
}

async function loadManualData() {
  const rows = await fetchAll('order_manual_trend', 'period,payload');
  manualData = {};
  rows.forEach(r => { manualData[r.period] = r.payload; });
  manualDataSynced = JSON.parse(JSON.stringify(manualData));
}

async function loadNotices() {
  const { data, error } = await sb.from('order_notices').select('id,body,author_name,created_at,legacy_ref').order('created_at', { ascending: false }).limit(NOTICE_MAX);
  if (error) return;
  noticesSynced = new Map();
  notices = data.reverse().map(r => {
    const d = new Date(r.created_at);
    const id = r.legacy_ref ? r.legacy_ref.replace(/^notices_v1#/, '') : r.id;
    noticesSynced.set(id, r.id);
    return { id, author: r.author_name || '?', text: r.body,
             time: String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ' ' + hhmm(r.created_at) };
  });
}

async function ensureMonthCounts(y, m) {
  const key = y + '-' + m;
  if (countsLoadedMonths.has(key)) return;
  const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const to = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
  const { data, error } = await sb.rpc('tick_daily_counts', { p_from: from, p_to: to });
  if (error) { toast('⚠ 趨勢資料讀取失敗：' + error.message, true); return; }
  data.forEach(r => dailyCounts.set(isoToSlash(r.service_date), { ord: r.ord, no: r.no, total: r.total }));
  countsLoadedMonths.add(key);
}

async function loadEverything() {
  setLoadingProgress(40, '讀取營業日與客戶…');
  await loadServiceDay();
  await loadCustomers();
  setLoadingProgress(70, '讀取今日叫貨狀態…');
  await Promise.all([loadDayStatuses(), loadGroups(), loadWarn3(), loadManualData(), loadNotices()]);
  todayLogFull = false;
  setLoadingProgress(100);
  buildFixedFilter();
  renderAll();
  setTimeout(() => { const w = document.getElementById('loading-bar-wrap'); if (w) w.style.opacity = '0'; }, 300);
}

/* ---------------- 同步（Broadcast 小事件；斷線時每 30 秒水位檢查） ---------------- */

let renderTimer = null;
function scheduleRender(full) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (full) { buildFixedFilter(); renderAll(); }
    else {
      updateStats(); renderSeriesStrip();
      if (document.getElementById('backend-page').classList.contains('active')) renderTable();
    }
  }, 120);
}

let reloadTimer = null;
function scheduleReload(what) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      if (what === 'all') await loadEverything();
      else if (what === 'customers') { await loadCustomers(); await Promise.all([loadDayStatuses(), loadGroups(), loadWarn3()]); scheduleRender(true); }
      else if (what === 'groups') { await loadGroups(); scheduleRender(true); }
      else if (what === 'warn3') { await loadWarn3(); scheduleRender(true); }
      else if (what === 'manual') { await loadManualData(); if (document.getElementById('analytics-page').classList.contains('active')) renderAnalytics(); }
      else if (what === 'notices') { await loadNotices(); renderNotices(); }
      else if (what === 'day') { await loadDayStatuses(); scheduleRender(true); }
    } catch (e) { console.warn('reload failed', e); }
  }, 200);
}

function onRemoteChange(c) {
  switch (c.t) {
    case 'daily_order_status': {
      if (c.k === '*') { scheduleReload('day'); countsLoadedMonths.clear(); return; }
      const v = c.v || {};
      if (c.op === 'D' || v.service_date !== serviceDateISO) { countsLoadedMonths.clear(); return; }
      const n = nameOf.get(v.customer_code);
      if (!n || !db[n]) return;
      if (db[n]._rev != null && c.rev != null && db[n]._rev >= c.rev) return;   // 自己剛寫的
      db[n].status = v.status;
      db[n].date = v.status === '未叫貨' ? '' : 'ordered';
      db[n]._rev = c.rev;
      db[n]._id = c.k;
      const entry = getTodayEntry();
      if (entry && v.last_actor_name) {
        const logs = entry.editLog[n] = entry.editLog[n] || [];
        const item = { time: hhmm(v.updated_at), status: v.status, user: v.last_actor_name, icon: v.last_actor_icon || '' };
        if (entry._lite) logs.splice(0, logs.length, item); else logs.push(item);
      }
      updateCardDOM(n);
      scheduleRender(false);
      return;
    }
    case 'tick_service_days': scheduleReload('all'); countsLoadedMonths.clear(); toast('🔄 其他裝置已重置今日，已切換到新的營業日'); return;
    case 'tick_customers': case 'customers': scheduleReload('customers'); return;
    case 'order_groups': case 'order_group_members': scheduleReload('groups'); return;
    case 'tick_warn3_overrides': scheduleReload('warn3'); return;
    case 'order_manual_trend': scheduleReload('manual'); return;
    case 'order_notices': scheduleReload('notices'); return;
  }
}

function syncStatusToDot(s) {
  ZX.syncBadge(s);
  if (s === 'live') setSyncDot('');
  else if (s === 'catching-up') setSyncDot('syncing');
  else if (s === 'offline' || s === 'fallback') setSyncDot('error');
}

/* ---------------- 寫入 ---------------- */

function isTransient(err) {
  return !err || !err.code || err.message === 'Failed to fetch' || /^(08|57P|PGRST00)/.test(err.code);
}

// 叫貨狀態：本機立即更新（樂觀）→ 伺服器確認後才標示已同步；失敗或衝突就復原
async function changeStatus(n, s, via) {
  if (!ZXC.can.write) { toast('⚠ 唯讀帳號無法變更叫貨狀態', true); return; }
  const d = db[n];
  const prev = { status: d.status, date: d.date };
  d.status = s;
  d.date = s === '未叫貨' ? '' : 'ordered';
  logEditTime(n, s);
  updateCardDOM(n);
  updateStats();
  renderSeriesStrip();
  toast(n + ' → ' + s);
  setSyncDot('syncing');
  ZX.syncBadge('pending');
  const args = {
    p_service_date: serviceDateISO, p_customer_code: d._code, p_new_status: s,
    p_expected_revision: d._rev, p_via: via || 'click',
    p_actor_name: currentUser.name || ZXC.member.display_name || '?', p_actor_icon: currentUser.icon || ''
  };
  try {
    const res = await zxSync.writeRpc(sb, 'tick_set_status', args);
    if (res && res.ok) {
      d._rev = res.revision;
      d._id = res.id;
      setSyncDot('');
      ZX.syncBadge('live');
      return;
    }
    // 伺服器拒絕：還原並說明
    d.status = prev.status; d.date = prev.date;
    const entry = getTodayEntry();
    if (entry && entry.editLog[n]) entry.editLog[n].pop();
    if (res && res.reason === 'conflict') {
      toast('⚠ ' + n + ' 已在其他裝置更新，已載入最新狀態', true);
      scheduleReload('day');
    } else if (res && res.reason === 'day_closed') {
      toast('⚠ 今日已被重置，正在切換到新的營業日', true);
      scheduleReload('all');
    } else {
      toast('⚠ ' + ((res && res.message) || '無法變更'), true);
    }
    updateCardDOM(n); updateStats(); renderSeriesStrip();
    setSyncDot('');
    ZX.syncBadge('live');
  } catch (err) {
    d.status = prev.status; d.date = prev.date;
    const entry = getTodayEntry();
    if (entry && entry.editLog[n]) entry.editLog[n].pop();
    updateCardDOM(n); updateStats(); renderSeriesStrip();
    setSyncDot('error');
    ZX.syncBadge('error');
    toast('⚠ 儲存失敗（已復原）：' + err.message + (isTransient(err) ? '，網路恢復後請再點一次' : ''), true);
  }
}

function toggle(n) {
  if (dragMode) return; // 拖曳模式中停用點擊
  // ★ 只允許「未叫貨 → 有叫貨」，已叫貨點擊不做任何事（伺服器端也會再檢查一次）
  if (db[n].status === '未叫貨') changeStatus(n, '有叫貨', 'click');
}
function rightClick(e, n) {
  e.preventDefault();
  if (dragMode) return;
  if (db[n].status === '有叫貨') { toast('已叫貨的客戶請用編輯視窗修改', true); return; }
  changeStatus(n, db[n].status === '今日不叫貨' ? '未叫貨' : '今日不叫貨', 'right_click');
}

async function saveClient() {
  const name = document.getElementById('m-name').value.trim();
  const status = document.getElementById('m-status').value;
  const fixed = document.getElementById('m-fixed').value.trim();
  if (!name) { alert('請輸入客戶名稱'); return; }
  if (!ZXC.can.write) { toast('⚠ 唯讀帳號無法修改', true); return; }
  const code = editing ? db[editing]._code : null;
  try {
    const res = await zxSync.writeRpc(sb, 'tick_save_customer', { p_code: code, p_name: name, p_fixed: fixed });
    if (!res.ok) { alert(res.message || '該名稱已存在'); return; }
    const prevStatus = editing ? db[editing].status : '未叫貨';
    const prevRev = editing ? db[editing]._rev : null;
    closeModal();
    await loadCustomers();
    if (status !== prevStatus) {
      const r = await zxSync.writeRpc(sb, 'tick_set_status', {
        p_service_date: serviceDateISO, p_customer_code: res.code, p_new_status: status, p_expected_revision: prevRev,
        p_via: 'modal', p_actor_name: currentUser.name || ZXC.member.display_name || '?', p_actor_icon: currentUser.icon || ''
      });
      if (!r.ok) toast('⚠ 狀態未變更：' + (r.reason === 'conflict' ? '已在其他裝置更新' : (r.message || '')), true);
    }
    await Promise.all([loadDayStatuses(), loadGroups(), loadWarn3()]);
    buildFixedFilter(); renderAll();
    toast('✅ 儲存成功');
  } catch (err) {
    toast('⚠ 儲存失敗：' + err.message, true);
  }
}

async function hideCustomer(n) {
  if (!ZXC.can.delete) { toast('⚠ 刪除客戶只限管理員', true); return; }
  const { error } = await sb.rpc('tick_hide_customer', { p_code: db[n]._code });
  if (error) { toast('⚠ 刪除失敗：' + error.message, true); return; }
  delete db[n];
  buildFixedFilter(); renderAll();
  toast('已刪除 ' + n + '（歷史紀錄保留，可由管理員還原）');
}
function deleteClient() {
  if (!editing) return;
  const n = editing;
  showConfirm('確定刪除「' + n + '」？\n（新版保留歷史紀錄，只從打勾單移除）', async () => { closeModal(); await hideCustomer(n); });
}
function confirmDeleteHistory(n) {
  showConfirm('確定刪除客戶「' + n + '」？\n（新版保留歷史紀錄，只從打勾單移除）', () => hideCustomer(n));
}

// 重置：伺服器結束目前營業日、開新的一天（兩台同時按只有一台會成功）
function resetAll() {
  if (!ZXC.can.write) { toast('⚠ 唯讀帳號無法重置', true); return; }
  showConfirm('是否確定重置今日叫貨狀態？\n系統將記錄今日最終叫貨狀態後，所有客戶恢復為「未叫貨」。', async () => {
    try {
      const res = await zxSync.writeRpc(sb, 'tick_reset_day', { p_expected_open: serviceDateISO, p_new_date: null });
      if (!res.ok) { toast('⚠ 其他裝置已經重置過了，已載入最新營業日', true); }
      countsLoadedMonths.clear();
      await loadEverything();
      hideResetReminder();
      if (res.ok) toast('✅ 今日狀態已記錄並重置');
    } catch (err) { toast('⚠ 重置失敗：' + err.message, true); }
  });
}

function hasResetToday() {
  // 目前營業日已經是裝置的今天 → 代表今天已經重置過（開了新的一天）
  return serviceDateISO && serviceDateISO >= localISODate(new Date());
}
function localISODate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function updateAllDates() {
  toast('新版由伺服器管理營業日，叫貨日期會自動對應今日，不需要手動更新');
}

// 三天未叫的手動標示：加入／排除（伺服器另有自動判斷：連續 3 個工作天未叫貨）
async function toggleManualWarn3(n) {
  if (!ZXC.can.write) { toast('⚠ 唯讀帳號無法變更', true); return; }
  const code = db[n]._code;
  const inSet = warn3Codes.has(code);
  const ov = warn3Overrides.get(code);
  let q;
  if (ov) q = sb.from('tick_warn3_overrides').delete().eq('customer_code', code);
  else q = sb.from('tick_warn3_overrides').insert({ customer_code: code, mode: inSet ? 'remove' : 'add', set_on: serviceDateISO });
  const { error } = await q;
  if (error) { toast('⚠ 變更失敗：' + error.message, true); return; }
  await loadWarn3();
  renderAll();
  toast(n + (warn3Codes.has(code) ? ' 已標示為三天未叫' : ' 已移除三天未叫標示'));
}

function saveManualWarn3() {}

async function saveOrder(group) {
  const names = groupOrder[group] || [];
  const codes = names.map(n => db[n] && db[n]._code).filter(Boolean);
  const { error } = await sb.rpc('tick_save_group_order', { p_group: group, p_codes: codes });
  if (error) toast('⚠ 排序儲存失敗：' + error.message, true);
}

async function clearAllHistory() {
  if (!ZXC.can.delete) { toast('⚠ 清除歷史只限管理員', true); return; }
  showConfirm('確定要清除所有歷史記錄？\n此操作無法復原，後台管理的歷史欄位將全部消失。', async () => {
    const { error } = await sb.rpc('tick_clear_history');
    if (error) { toast('⚠ 清除失敗：' + error.message, true); return; }
    countsLoadedMonths.clear(); dailyCounts.clear();
    await loadEverything();
    toast('✅ 歷史記錄已清除');
  });
}

function deleteAnalyticsDay(dateStr) {
  if (!ZXC.can.delete) { toast('⚠ 刪除歷史只限管理員', true); return; }
  showConfirm(`確定刪除 ${dateStr.slice(5)} 的叫貨記錄？\n此操作會從歷史快照中移除該天資料，無法復原。`, async () => {
    const { error } = await sb.rpc('tick_delete_day', { p_date: dateStr.replace(/\//g, '-') });
    if (error) { toast('⚠ 刪除失敗：' + error.message, true); return; }
    dailyCounts.delete(dateStr);
    delete manualData[dateStr];
    countsLoadedMonths.clear();
    renderAnalytics();
    toast('✅ 已刪除 ' + dateStr.slice(5) + ' 的記錄');
  });
}

// 手動趨勢數據：只送出有變動的日期
async function saveManualData() {
  const changed = Object.keys(manualData).filter(k => JSON.stringify(manualData[k]) !== JSON.stringify(manualDataSynced[k]));
  const removed = Object.keys(manualDataSynced).filter(k => !(k in manualData));
  if (changed.length) {
    const { error } = await sb.from('order_manual_trend').upsert(changed.map(k => ({ period: k, payload: manualData[k] })), { onConflict: 'period' });
    if (error) { toast('⚠ 儲存失敗：' + error.message, true); return; }
  }
  if (removed.length) {
    const { error, count } = await sb.from('order_manual_trend').delete({ count: 'exact' }).in('period', removed);
    if (error || !count) { toast('⚠ 刪除手動數據只限管理員', true); await loadManualData(); renderAnalytics(); return; }
  }
  manualDataSynced = JSON.parse(JSON.stringify(manualData));
}

// 留言板（原版畫面已移除，資料與函式保留）
async function saveNotices() {
  const current = new Set(notices.map(n => n.id));
  for (const n of notices) {
    if (noticesSynced.has(n.id)) continue;
    const { data, error } = await sb.from('order_notices').insert({ body: n.text, author_name: n.author }).select('id').single();
    if (!error) noticesSynced.set(n.id, data.id);
  }
  for (const [oldId, dbId] of noticesSynced) {
    if (!current.has(oldId)) {
      const { error } = await sb.from('order_notices').delete().eq('id', dbId);
      if (!error) noticesSynced.delete(oldId);
    }
  }
}

/* ---------------- 系列統計：改存資料庫，可自行新增系列、自訂店家 ---------------- */

const SERIES_LIST = [];
const SERIES_EXTRA = {};
function getSeriesMembers(key) {
  const s = seriesDefs.find(x => x.key === key);
  if (!s) return [];
  const rule = s.rule || {};
  const pre = rule.prefix || [];
  const ex = rule.exclude_prefix || [];
  const extra = new Set([...(rule.extra || []), ...(s.members || [])]);
  return Object.keys(db).filter(n =>
    extra.has(n) || (pre.some(p => n.startsWith(p)) && !ex.some(p => n.startsWith(p))));
}

function openSeriesModal() {
  const list = document.getElementById('series-admin-list');
  list.innerHTML = seriesDefs.map(s => `
    <li><b>${esc(s.label)}</b>
      <span class="series-rule">開頭：${esc((s.rule.prefix || []).join('、') || '—')}${(s.rule.exclude_prefix || []).length ? '｜排除：' + esc(s.rule.exclude_prefix.join('、')) : ''}${(s.rule.extra || []).length ? '｜另加：' + esc(s.rule.extra.join('、')) : ''}</span>
      <span class="series-count">${getSeriesMembers(s.key).length} 家</span>
      <button class="btn btn-ghost btn-sm" onclick="editSeries('${esc(s.id)}')">編輯</button>
      ${ZXC.can.delete ? `<button class="btn btn-danger btn-sm" onclick="deleteSeries('${esc(s.id)}')">刪除</button>` : ''}
    </li>`).join('') || '<li>尚無系列</li>';
  editSeries(null);
  document.getElementById('series-overlay').classList.add('open');
}
function closeSeriesModal() { document.getElementById('series-overlay').classList.remove('open'); }
let editingSeriesId = null;
function editSeries(id) {
  editingSeriesId = id;
  const s = seriesDefs.find(x => x.id === id);
  document.getElementById('series-name').value = s ? s.label : '';
  document.getElementById('series-prefix').value = s ? (s.rule.prefix || []).join('、') : '';
  document.getElementById('series-exclude').value = s ? (s.rule.exclude_prefix || []).join('、') : '';
  document.getElementById('series-extra').value = s ? (s.rule.extra || []).join('、') : '';
  document.getElementById('series-form-title').textContent = s ? '編輯系列：' + s.label : '新增系列';
}
function splitList(v) { return v.split(/[、,，\n]/).map(x => x.trim()).filter(Boolean); }
async function saveSeries() {
  const name = document.getElementById('series-name').value.trim();
  if (!name) { alert('請輸入系列名稱'); return; }
  const rule = { prefix: splitList(document.getElementById('series-prefix').value),
                 exclude_prefix: splitList(document.getElementById('series-exclude').value),
                 extra: splitList(document.getElementById('series-extra').value) };
  if (!rule.prefix.length && !rule.extra.length) rule.prefix = [name];
  const row = { kind: 'series', name, rule, sort_order: editingSeriesId ? undefined : seriesDefs.length + 1 };
  const q = editingSeriesId
    ? sb.from('order_groups').update({ name, rule }).eq('id', editingSeriesId)
    : sb.from('order_groups').insert(row);
  const { error } = await q;
  if (error) { toast('⚠ 系列儲存失敗：' + error.message, true); return; }
  await loadGroups();
  renderSeriesStrip();
  openSeriesModal();
  toast('✅ 系列已儲存');
}
async function deleteSeries(id) {
  if (!confirm('確定刪除這個系列？')) return;
  const { error } = await sb.from('order_groups').delete().eq('id', id);
  if (error) { toast('⚠ 刪除失敗：' + error.message, true); return; }
  await loadGroups();
  renderSeriesStrip();
  openSeriesModal();
}

/* ---------------- 使用者暱稱／圖示（存在伺服器，三站共用） ---------------- */
async function saveUserName() {
  const name = document.getElementById('user-name-input').value.trim().slice(0, 6);
  if (!name) { document.getElementById('user-name-input').focus(); return; }
  currentUser.name = name;
  if (!currentUser.icon) currentUser.icon = USER_ICONS[Math.floor(Math.random() * USER_ICONS.length)];
  const { error } = await sb.rpc('set_my_profile', { p_display_name: name, p_icon: currentUser.icon });
  if (error) { toast('⚠ 暱稱儲存失敗：' + error.message, true); return; }
  updateUserTag();
  closeUserModal();
  toast(`✅ 暱稱已設定為「${name}」`);
}

/* ---------------- 啟動 ---------------- */
function init() {
  document.getElementById('topbar-date').textContent = todayStr;
  ensureTodayEditLog();
  buildFixedFilter();
  renderAll();
  setLoadingProgress(20, '登入中…');
}

window.addEventListener('load', () => {
  init();
  ZX.boot({
    site: 'tick',
    title: '忠欣打勾單系統',
    logo: '../shared/logo.svg',
    onReady: async ctx => {
      sb = ctx.sb;
      ZXC = ctx;
      currentUser = { name: ctx.member.display_name || '', icon: ctx.member.icon || '' };
      updateUserTag();
      document.documentElement.classList.toggle('zx-readonly', !ctx.can.write);
      if (!currentUser.name) setTimeout(openUserModal, 600);
      tickSync = zxSync.createSync({ sb, sites: ['tick', 'shared'], onChange: onRemoteChange,
                                     onReset: loadEverything, onStatus: syncStatusToDot });
      await tickSync.start(loadEverything);
      setInterval(checkResetReminder, 60 * 1000);
    }
  });
});
