/* =========================================================
   異常表與交接表｜資料層與同步（新版）
   - 不再每 8 秒拉全表：首載只取目前日期範圍、每頁 50 筆（keyset），之後靠 Broadcast 小事件局部更新
   - 寫入：新增帶 request_id（斷線重送不重複）、修改帶 revision（陳舊畫面不會悄悄覆蓋）
   - 刪除／刪除全部：只限管理員（伺服器 RLS／RPC 驗證）
   列印預覽與匯出 Excel 沿用原版程式碼（見下方「原版保留」區塊），僅在執行前先把目前範圍資料載入完整
   ========================================================= */

const TABLES = { abnormal: 'abnormal_reports', handover: 'handover_reports' };
const COLS = {
  abnormal: 'id,date,report_date,car_no,store,reason,exchange_type,category,responsibility,note,created_at,revision,customer_code,car_no_source',
  handover: 'id,date,report_date,store,content,created_at,revision,customer_code'
};
const PAGE_SIZE = 50;
const RANGE_STORE_KEY = 'zx-report-range';

let sb = null;
let ZXC = null;            // 登入後的 ctx：{ user, member, can }
let syncer = null;
let abnormalRows = [];
let handoverRows = [];
const view = {
  abnormal: { preset: 'today', from: null, to: null, cursor: null, hasMore: false, loading: false },
  handover: { preset: 'today', from: null, to: null, cursor: null, hasMore: false, loading: false }
};
const editing = { abnormal: null, handover: null };   // 正在行內編輯的 id → 收到遠端更新時保留草稿並提示

function rowsOf(type){ return type === 'abnormal' ? abnormalRows : handoverRows; }
function setRows(type, rows){ if (type === 'abnormal') abnormalRows = rows; else handoverRows = rows; }

/* ---------------- 資料轉換（維持原版中文欄位鍵，另外附帶內部欄位） ---------------- */

function dbRowToAppRow(type, row){
  const base = type === 'abnormal' ? {
    'id': row.id,
    '日期': row.date || (row.report_date || ''),
    '車號': row.car_no || '',
    '店家': row.store || '',
    '狀況說明': row.reason || '',
    '處理方式': row.exchange_type || '',
    '異常類別': row.category || '',
    '責任歸屬': row.responsibility || '',
    '補充說明': row.note || '',
    '建立時間': row.created_at ? new Date(row.created_at).toLocaleString('zh-TW') : ''
  } : {
    'id': row.id,
    '日期': row.date || (row.report_date || ''),
    '客戶名稱+車號': row.store || '',
    '事項': row.content || ''
  };
  base._rev = row.revision;
  base._date = row.report_date;
  base._created = row.created_at;
  base._code = row.customer_code || null;
  return base;
}

function appDataToDbRow(type, data){
  if (type === 'abnormal'){
    return {
      date: data.date || '',
      report_date: /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : null,
      car_no: data.carNo || '',
      store: data.store || '',
      reason: data.reason || '',
      issue_description: data.reason || '',
      exchange_type: data.exchangeType || '',
      category: data.category || '',
      responsibility: data.responsibility || '',
      note: data.note || '',
      customer_code: data.customerCode || null,
      car_no_source: data.carNoSource || null
    };
  }
  return {
    date: data.date || '',
    report_date: /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : null,
    store: data.store || '',
    content: data.content || '',
    handover_description: data.content || ''
  };
}

/* ---------------- 日期範圍 ---------------- */

function localISO(d){
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function presetRange(preset){
  const today = new Date();
  const back = n => { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d); };
  if (preset === 'today') return { from: localISO(today), to: localISO(today) };
  if (preset === '7d') return { from: back(6), to: localISO(today) };
  if (preset === '30d') return { from: back(29), to: localISO(today) };
  if (preset === 'all') return { from: null, to: null };
  return null;
}
const PRESET_LABEL = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部', custom: '自訂' };

function applyRange(type, preset, from, to){
  const v = view[type];
  v.preset = preset;
  const r = preset === 'custom' ? { from: from || null, to: to || null } : presetRange(preset);
  v.from = r.from; v.to = r.to;
  try { localStorage.setItem(RANGE_STORE_KEY + '-' + type, JSON.stringify({ preset, from: v.from, to: v.to })); } catch (e) {}
  renderRangeBar(type);
  return reload(type);
}

function inRange(type, d){
  const v = view[type];
  if (!v.from && !v.to) return true;
  if (!d) return false;
  return (!v.from || d >= v.from) && (!v.to || d <= v.to);
}

function rangeText(type){
  const v = view[type];
  if (!v.from && !v.to) return '全部日期';
  if (v.from === v.to) return v.from;
  return (v.from || '…') + ' ～ ' + (v.to || '…');
}

function renderRangeBar(type){
  const bar = document.getElementById(type === 'abnormal' ? 'ab-range' : 'ho-range');
  if (!bar) return;
  const v = view[type];
  bar.querySelectorAll('[data-preset]').forEach(b => {
    const on = b.dataset.preset === v.preset;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  bar.querySelector('.range-custom').hidden = v.preset !== 'custom';
  bar.querySelector('[data-range-from]').value = v.from || '';
  bar.querySelector('[data-range-to]').value = v.to || '';
}

/* ---------------- 讀取（欄位投影 + 日期範圍 + keyset 分頁） ---------------- */

async function fetchPage(type, reset){
  const v = view[type];
  if (v.loading) return;
  v.loading = true;
  setSyncState(type, 'loading');
  try{
    let q = sb.from(TABLES[type]).select(COLS[type])
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (v.from) q = q.gte('report_date', v.from);
    if (v.to) q = q.lte('report_date', v.to);
    if (!reset && v.cursor){
      const c = v.cursor;
      q = q.or(`created_at.lt."${c.created_at}",and(created_at.eq."${c.created_at}",id.lt.${c.id})`);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    v.hasMore = data.length > PAGE_SIZE;
    const page = data.slice(0, PAGE_SIZE);
    if (page.length) v.cursor = { created_at: page[page.length - 1].created_at, id: page[page.length - 1].id };
    else if (reset) v.cursor = null;
    const mapped = page.map(r => dbRowToAppRow(type, r));
    setRows(type, reset ? mapped : rowsOf(type).concat(mapped.filter(m => !rowsOf(type).some(r => r.id === m.id))));
    renderType(type);
    setSyncState(type, 'synced');
  }catch(err){
    setSyncState(type, 'error');
    showToast('讀取失敗：' + err.message);
  }finally{
    v.loading = false;
  }
}

function reload(type){ view[type].cursor = null; return fetchPage(type, true); }
async function loadMore(type){ await fetchPage(type, false); }
async function ensureAllLoaded(type){
  let guard = 0;
  while (view[type].hasMore && guard++ < 40) await fetchPage(type, false);
}

// 收到推播後只讀被改動的那幾列；150ms 內的多個事件合併成一次查詢
const pendingFetch = { abnormal: new Set(), handover: new Set() };
let fetchTimer = null;
function queueFetch(type, id){
  pendingFetch[type].add(id);
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(flushFetch, 150);
}
async function flushFetch(){
  for (const type of ['abnormal', 'handover']){
    const ids = Array.from(pendingFetch[type]);
    pendingFetch[type].clear();
    if (!ids.length) continue;
    const { data, error } = await sb.from(TABLES[type]).select(COLS[type]).in('id', ids);
    if (error){ console.warn('fetch rows failed', error); continue; }
    const got = new Set();
    data.forEach(r => { got.add(r.id); upsertLocal(type, dbRowToAppRow(type, r)); });
    ids.filter(id => !got.has(id)).forEach(id => removeLocal(type, id));
    renderType(type);
  }
}

function sortRows(rows){
  return rows.sort((a, b) => (b._created || '').localeCompare(a._created || '') || String(b.id).localeCompare(String(a.id)));
}

function upsertLocal(type, row){
  const rows = rowsOf(type);
  if (!inRange(type, row._date)){ removeLocal(type, row.id); return; }
  const i = rows.findIndex(r => r.id === row.id);
  if (editing[type] === row.id && i > -1 && rows[i]._rev !== row._rev){
    rows[i]._remote = row;                // 保留使用者草稿，只標示「資料已在別處更新」
    markEditConflict(type, row.id);
    return;
  }
  if (i > -1) rows[i] = row; else rows.push(row);
  sortRows(rows);
}

function removeLocal(type, id){
  setRows(type, rowsOf(type).filter(r => r.id !== id));
  if (editing[type] === id){ closeInlineEdits(); showToast('這筆資料已在其他裝置刪除'); }
}

/* ---------------- 即時同步（Broadcast 小事件 + change_log 游標補差） ---------------- */

function onRemoteChange(c){
  const type = c.t === 'abnormal_reports' ? 'abnormal' : c.t === 'handover_reports' ? 'handover' : null;
  if (!type) return;
  if (c.k === '*'){ reload(type); return; }
  if (c.op === 'D'){ removeLocal(type, c.k); renderType(type); return; }
  const existing = rowsOf(type).find(r => r.id === c.k);
  if (existing && c.rev != null && existing._rev >= c.rev) return;      // 本機已是最新（例如自己剛寫入）
  const d = c.v && c.v.report_date;
  if (!inRange(type, d)){
    if (existing){ removeLocal(type, c.k); renderType(type); }
    return;
  }
  queueFetch(type, c.k);
}

/* ---------------- 店家自動帶入（主檔／別名優先，原 STATIC_CUSTOMER_NAMES 當備援，歷史店家保留） ---------------- */

let customerNames = [];        // [{ code, name }]，來自 customers + customer_aliases
async function loadCustomerNames(){
  try{
    const all = [];
    for (let from = 0; ; from += 1000){
      const { data, error } = await sb.from('customers').select('code,name').eq('is_active', true).order('code').range(from, from + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) break;
    }
    const { data: aliases } = await sb.from('customer_aliases').select('customer_code,alias_name').limit(5000);
    (aliases || []).forEach(a => all.push({ code: a.customer_code, name: a.alias_name }));
    customerNames = all.filter(x => x.name);
    refreshStoreDatalist();
  }catch(err){ console.warn('載入客戶主檔失敗，改用內建名單', err); }
}

function refreshStoreDatalist(){
  const datalist = document.getElementById('ab-store-datalist');
  if (!datalist) return;
  const historical = (abnormalRows || []).map(r => (r['店家'] || '').trim()).filter(Boolean);
  const names = Array.from(new Set([...customerNames.map(c => c.name), ...STATIC_CUSTOMER_NAMES, ...historical]))
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  datalist.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function matchCustomerCodes(name){
  const n = (name || '').trim();
  return Array.from(new Set(customerNames.filter(c => c.name === n).map(c => c.code)));
}

let autoFillTimer = null;
let carSource = null;
function handleStoreAutoFill(){
  clearTimeout(autoFillTimer);
  autoFillTimer = setTimeout(doStoreAutoFill, 250);
}
async function doStoreAutoFill(){
  const storeVal = document.getElementById('ab-store').value.trim();
  const carInput = document.getElementById('ab-carNo');
  const label = document.getElementById('ab-car-source');
  label.textContent = '';
  carSource = null;
  if (!storeVal) return;
  // 1) 主檔／別名對到「唯一」客戶 → 讀有效的車輛指派
  const codes = matchCustomerCodes(storeVal);
  if (codes.length > 1) label.textContent = `⚠ 有 ${codes.length} 位客戶同名，請確認`;
  if (codes.length === 1){
    const { data } = await sb.rpc('current_vehicle', { p_customer_code: codes[0] });
    if (data && data.length && data[0].car_no){
      carInput.value = data[0].car_no;
      carSource = 'assignment';
      label.textContent = '車號來源：客戶車輛設定，請確認';
      return;
    }
  }
  // 2) 沒有指派 → 參考該店家最近一筆歷史紀錄（不限目前日期範圍）
  const local = (abnormalRows || []).find(r => (r['店家'] || '').trim().toLowerCase() === storeVal.toLowerCase() && r['車號']);
  let car = local ? local['車號'] : null, when = local ? local['日期'] : null;
  if (!car){
    const { data } = await sb.from('abnormal_reports').select('car_no,date').eq('store', storeVal).neq('car_no', '')
      .order('created_at', { ascending: false }).limit(1);
    if (data && data.length){ car = data[0].car_no; when = data[0].date; }
  }
  if (car){
    carInput.value = car;
    carSource = 'history';
    label.textContent = `車號來源：最近一筆紀錄（${when || '日期不明'}），請確認`;
  }
}

/* ---------------- 寫入（樂觀更新 → 成功才標示已同步；失敗復原並可重試） ---------------- */

function isTransient(err){
  return !err || !err.code || err.message === 'Failed to fetch' || /^(08|57P|PGRST00)/.test(err.code);
}
async function withRetry(fn, retries = 3){
  for (let i = 0; ; i++){
    const r = await fn();
    if (!r.error || !isTransient(r.error) || i >= retries) return r;
    await new Promise(res => setTimeout(res, 800 * Math.pow(2, i) + Math.random() * 400));
  }
}

async function insertRow(type, data){
  const requestId = zxSync.uuid();
  const payload = Object.assign(appDataToDbRow(type, data), { request_id: requestId });
  let r = await withRetry(() => sb.from(TABLES[type]).insert(payload).select(COLS[type]).single());
  if (r.error && r.error.code === '23505'){
    // 斷線重送：第一次其實已寫入 → 用 request_id 取回那一筆
    r = await sb.from(TABLES[type]).select(COLS[type]).eq('request_id', requestId).single();
  }
  if (r.error) throw new Error(r.error.message);
  return dbRowToAppRow(type, r.data);
}

async function updateRow(type, id, data, expectedRev){
  let q = sb.from(TABLES[type]).update(appDataToDbRow(type, data)).eq('id', id);
  if (expectedRev != null) q = q.eq('revision', expectedRev);
  const r = await withRetry(() => q.select(COLS[type]));
  if (r.error) throw new Error(r.error.message);
  if (!r.data.length) return null;               // revision 不符（別處已更新）或沒有權限
  return dbRowToAppRow(type, r.data[0]);
}

async function deleteRow(type, id){
  const r = await withRetry(() => sb.from(TABLES[type]).delete({ count: 'exact' }).eq('id', id));
  if (r.error) throw new Error(r.error.message);
  if (!r.count) throw new Error('沒有刪除權限（只限管理員），或資料已不存在');
}

function optimisticAdd(type, data){
  const temp = dbRowToAppRow(type, Object.assign(appDataToDbRow(type, data), {
    id: 'tmp-' + zxSync.uuid(), created_at: new Date().toISOString(), revision: 0
  }));
  temp._pending = true;
  if (inRange(type, temp._date)){ rowsOf(type).unshift(temp); renderType(type); }
  return temp.id;
}
function settleAdd(type, tempId, row){
  setRows(type, rowsOf(type).filter(r => r.id !== tempId));
  if (row) upsertLocal(type, row);
  renderType(type);
}

async function submitAbnormal(){
  if (!ZXC.can.write){ showToast('唯讀帳號無法新增'); return; }
  const data = {
    date: document.getElementById('ab-date').value,
    carNo: document.getElementById('ab-carNo').value.trim(),
    store: document.getElementById('ab-store').value.trim(),
    reason: document.getElementById('ab-reason').value.trim(),
    exchangeType: document.getElementById('ab-exchangeType').value,
    category: document.getElementById('ab-category').value,
    responsibility: document.getElementById('ab-responsibility').value.trim(),
    note: document.getElementById('ab-note').value.trim()
  };
  if (!data.date || !data.store){
    showToast('請填寫日期與店家');
    return;
  }
  const codes = matchCustomerCodes(data.store);
  data.customerCode = codes.length === 1 ? codes[0] : null;
  data.carNoSource = data.carNo ? (carSource || 'manual') : null;
  const tempId = optimisticAdd('abnormal', data);
  setSyncState('abnormal', 'loading');
  try{
    const row = await insertRow('abnormal', data);
    settleAdd('abnormal', tempId, row);
    showToast('已新增異常紀錄');
    document.getElementById('form-abnormal').reset();
    document.getElementById('ab-date').value = localISO(new Date());
    document.getElementById('ab-car-source').textContent = '';
    carSource = null;
    setSyncState('abnormal', 'synced');
  }catch(err){
    settleAdd('abnormal', tempId, null);
    setSyncState('abnormal', 'error');
    showToast('儲存失敗（表單內容已保留，可再按一次新增）：' + err.message);
  }
}

async function submitHandover(){
  if (!ZXC.can.write){ showToast('唯讀帳號無法新增'); return; }
  const data = {
    date: document.getElementById('ho-date').value,
    store: document.getElementById('ho-store').value.trim(),
    content: document.getElementById('ho-content').value.trim()
  };
  if (!data.date || !data.store){
    showToast('請填寫日期與店家');
    return;
  }
  const tempId = optimisticAdd('handover', data);
  setSyncState('handover', 'loading');
  try{
    const row = await insertRow('handover', data);
    settleAdd('handover', tempId, row);
    showToast('已新增交接紀錄');
    document.getElementById('form-handover').reset();
    document.getElementById('ho-date').value = localISO(new Date());
    setSyncState('handover', 'synced');
  }catch(err){
    settleAdd('handover', tempId, null);
    setSyncState('handover', 'error');
    showToast('儲存失敗（表單內容已保留，可再按一次新增）：' + err.message);
  }
}

function markEditConflict(type, id){
  const form = document.querySelector('.inline-edit-row .inline-edit-form');
  if (!form || form.querySelector('.edit-conflict')) return;
  const box = document.createElement('div');
  box.className = 'field wide edit-conflict';
  box.setAttribute('role', 'alert');
  box.innerHTML = `<div class="conflict-banner">⚠ 資料已在別處更新。你的草稿仍保留在下方，可選擇：
      <button type="button" class="btn btn-secondary" data-conflict="reload">載入最新內容（捨棄草稿）</button>
      <button type="button" class="btn btn-secondary" data-conflict="overwrite">以我的草稿覆蓋</button></div>`;
  form.prepend(box);
  box.querySelector('[data-conflict="reload"]').onclick = () => {
    const row = rowsOf(type).find(r => r.id === id);
    if (row && row._remote){ Object.assign(row, row._remote); delete row._remote; }
    editing[type] = null;
    renderType(type);
    (type === 'abnormal' ? editAbnormal : editHandover)(id);
  };
  box.querySelector('[data-conflict="overwrite"]').onclick = () => {
    const row = rowsOf(type).find(r => r.id === id);
    if (row && row._remote){ row._rev = row._remote._rev; delete row._remote; }
    box.remove();
    (type === 'abnormal' ? saveInlineAbnormal : saveInlineHandover)(id);
  };
}

async function saveInline(type, id, data){
  if (!data.date || !data.store){
    showToast('請填寫日期與店家');
    return;
  }
  const row = rowsOf(type).find(r => r.id === id);
  if (row && row._remote){ markEditConflict(type, id); showToast('資料已在別處更新，請先選擇如何處理'); return; }
  try{
    setSyncState(type, 'loading');
    if (type === 'abnormal'){
      const codes = matchCustomerCodes(data.store);
      data.customerCode = codes.length === 1 ? codes[0] : (row ? row._code : null);
    }
    const updated = await updateRow(type, id, data, row ? row._rev : null);
    if (!updated){
      const { data: fresh } = await sb.from(TABLES[type]).select(COLS[type]).eq('id', id).maybeSingle();
      if (!fresh) { setSyncState(type, 'error'); showToast('沒有修改權限，或資料已被刪除'); return; }
      if (row){ row._remote = dbRowToAppRow(type, fresh); }
      markEditConflict(type, id);
      setSyncState(type, 'synced');
      showToast('資料已在別處更新，草稿已保留');
      return;
    }
    editing[type] = null;
    closeInlineEdits();
    upsertLocal(type, updated);
    renderType(type);
    setSyncState(type, 'synced');
    showToast(type === 'abnormal' ? '已更新異常紀錄' : '已更新交接紀錄');
  }catch(err){
    setSyncState(type, 'error');
    showToast('更新失敗（草稿已保留，可再按一次儲存）：' + err.message);
  }
}

async function saveInlineAbnormal(id){
  await saveInline('abnormal', id, {
    date: document.getElementById(`edit-ab-date-${id}`).value,
    carNo: document.getElementById(`edit-ab-carNo-${id}`).value.trim(),
    store: document.getElementById(`edit-ab-store-${id}`).value.trim(),
    reason: document.getElementById(`edit-ab-reason-${id}`).value.trim(),
    exchangeType: document.getElementById(`edit-ab-exchangeType-${id}`).value,
    category: document.getElementById(`edit-ab-category-${id}`).value,
    responsibility: document.getElementById(`edit-ab-responsibility-${id}`).value.trim(),
    note: document.getElementById(`edit-ab-note-${id}`).value.trim()
  });
}
async function saveInlineHandover(id){
  await saveInline('handover', id, {
    date: document.getElementById(`edit-ho-date-${id}`).value,
    store: document.getElementById(`edit-ho-store-${id}`).value.trim(),
    content: document.getElementById(`edit-ho-content-${id}`).value.trim()
  });
}

async function deleteAbnormal(id){ await deleteOne('abnormal', id, '確定要刪除這筆異常紀錄嗎？'); }
async function deleteHandover(id){ await deleteOne('handover', id, '確定要刪除這筆交接紀錄嗎？'); }
async function deleteOne(type, id, msg){
  if (!ZXC.can.delete){ showToast('刪除只限管理員'); return; }
  if (!confirm(msg)) return;
  const before = rowsOf(type).slice();
  setRows(type, before.filter(r => r.id !== id));
  renderType(type);
  try{
    setSyncState(type, 'loading');
    await deleteRow(type, id);
    setSyncState(type, 'synced');
  }catch(err){
    setRows(type, before);                 // 復原
    renderType(type);
    setSyncState(type, 'error');
    showToast('刪除失敗：' + err.message);
  }
}

async function clearAll(type){
  if (!ZXC.can.delete){ showToast('刪除全部只限管理員'); return; }
  const label = type === 'abnormal' ? '異常表' : '交接表';
  const v = view[type];
  const scope = (!v.from && !v.to) ? '所有日期' : rangeText(type);
  if (!confirm(`確定要刪除「${label}」${scope}的資料嗎？此動作無法復原。`)) return;
  if (!confirm(`再次確認：這會清空 ${scope} 的 ${label} 資料，確定要繼續嗎？`)) return;
  try{
    setSyncState(type, 'loading');
    const { data, error } = await sb.rpc('report_delete_all', { p_table: TABLES[type], p_confirm: '刪除全部', p_from: v.from, p_to: v.to });
    if (error) throw new Error(error.message);
    showToast(`已刪除 ${label} ${data.deleted} 筆資料`);
    await reload(type);
  }catch(err){
    setSyncState(type, 'error');
    showToast('刪除失敗：' + err.message);
  }
}

/* ---------------- 畫面 ---------------- */

function renderType(type){
  // 行內編輯列是 tbody 裡的一列：重繪前先拿下來，重繪後放回原位，使用者的草稿（DOM 輸入值）完整保留
  const tbodyId = type === 'abnormal' ? 'ab-tbody' : 'ho-tbody';
  const editRow = editing[type] ? document.querySelector(`#${tbodyId} > .inline-edit-row`) : null;
  if (editRow) editRow.remove();
  if (type === 'abnormal'){ renderAbnormal(abnormalRows); refreshStoreDatalist(); }
  else renderHandover(handoverRows);
  if (editRow){
    const anchor = document.querySelector(`#${tbodyId} > tr[data-${type === 'abnormal' ? 'ab' : 'ho'}-id="${editing[type]}"]`);
    if (anchor) anchor.after(editRow); else editing[type] = null;
  }
  const rows = rowsOf(type).filter(r => !r._pending);
  const v = view[type];
  const pre = type === 'abnormal' ? 'ab' : 'ho';
  document.getElementById(pre + '-count').textContent = rows.length + (v.hasMore ? '+' : '');
  document.getElementById(pre + '-range-label').textContent = rangeText(type);
  document.getElementById(pre + '-print-meta').textContent = `列印時間：${new Date().toLocaleString('zh-TW')}　共 ${rows.length} 筆`;
  const more = document.getElementById(pre + '-more');
  more.hidden = !v.hasMore;
  more.disabled = v.loading;
}

function actionButtons(type, r){
  if (r._pending) return '<span class="pending-label">儲存中…</span>';
  const edit = ZXC.can.write ? `<button class="btn btn-ghost" onclick="${type === 'abnormal' ? 'editAbnormal' : 'editHandover'}('${r['id']}')" aria-label="編輯">✎</button>` : '';
  const del = ZXC.can.delete ? `<button class="btn btn-ghost" onclick="${type === 'abnormal' ? 'deleteAbnormal' : 'deleteHandover'}('${r['id']}')" aria-label="刪除">✕</button>` : '';
  return edit + del;
}

function renderAbnormal(rows){
  const tbody = document.getElementById('ab-tbody');
  if (!rows || rows.length === 0){
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9"><span class="empty-icon">📋</span>這個日期範圍尚無資料</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr data-ab-id="${r['id']}" class="${r._pending ? 'is-pending' : ''}">
      <td class="mono-cell">${escapeHtml(r['日期'])}</td>
      <td>${escapeHtml(r['車號'])}</td>
      <td>${escapeHtml(r['店家'])}</td>
      <td>${escapeHtml(r['狀況說明'])}</td>
      <td><span class="chip ${chipClass(r['處理方式'])}">${escapeHtml(r['處理方式'])}</span></td>
      <td>${escapeHtml(r['異常類別'])}</td>
      <td>${escapeHtml(r['責任歸屬'])}</td>
      <td>${escapeHtml(r['補充說明'])}</td>
      <td class="col-del">${actionButtons('abnormal', r)}</td>
    </tr>
  `).join('');
}

function renderHandover(rows){
  const tbody = document.getElementById('ho-tbody');
  if (!rows || rows.length === 0){
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><span class="empty-icon">📋</span>這個日期範圍尚無資料</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr data-ho-id="${r['id']}" class="${r._pending ? 'is-pending' : ''}">
      <td class="mono-cell">${escapeHtml(r['日期'])}</td>
      <td>${escapeHtml(r['客戶名稱+車號'])}</td>
      <td>${escapeHtml(r['事項'])}</td>
      <td class="col-del">${actionButtons('handover', r)}</td>
    </tr>
  `).join('');
}

async function refreshAll(){
  await Promise.all([reload('abnormal'), reload('handover')]);
}

/* ---------------- 啟動 ---------------- */

function restoreRange(type){
  try{
    const saved = JSON.parse(localStorage.getItem(RANGE_STORE_KEY + '-' + type) || 'null');
    if (saved && saved.preset){
      const v = view[type];
      v.preset = saved.preset;
      const r = saved.preset === 'custom' ? { from: saved.from, to: saved.to } : presetRange(saved.preset);
      v.from = r.from; v.to = r.to;
      return;
    }
  }catch(e){}
  const r = presetRange('today');
  view[type].from = r.from; view[type].to = r.to;
}

function wireRangeBar(type){
  const bar = document.getElementById(type === 'abnormal' ? 'ab-range' : 'ho-range');
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    if (b.dataset.preset === 'custom'){ view[type].preset = 'custom'; renderRangeBar(type); return; }
    applyRange(type, b.dataset.preset);
  });
  bar.querySelector('[data-range-apply]').addEventListener('click', () => {
    applyRange(type, 'custom', bar.querySelector('[data-range-from]').value, bar.querySelector('[data-range-to]').value);
  });
  document.getElementById(type === 'abnormal' ? 'ab-more' : 'ho-more').addEventListener('click', () => loadMore(type));
}

function gateByRole(){
  if (!ZXC.can.write){
    document.querySelectorAll('#form-abnormal, #form-handover').forEach(f => {
      f.querySelectorAll('input,select,textarea,button').forEach(x => x.disabled = true);
      f.insertAdjacentHTML('beforebegin', '<p class="role-note">此帳號為唯讀，無法新增或修改。</p>');
    });
  }
  if (!ZXC.can.delete){
    document.querySelectorAll('[onclick^="clearAll"]').forEach(b => { b.disabled = true; b.title = '刪除全部只限管理員'; });
  }
}

// 列印／匯出前先把目前範圍的資料全部載入（原版是直接用畫面上的全部資料）
const _origOpenAbnormalPrintPreview = openAbnormalPrintPreview;
openAbnormalPrintPreview = async function(){ await ensureAllLoaded('abnormal'); _origOpenAbnormalPrintPreview(); };
const _origOpenHandoverPrintPreview = openHandoverPrintPreview;
openHandoverPrintPreview = async function(){ await ensureAllLoaded('handover'); _origOpenHandoverPrintPreview(); };
const _origExportAbnormalExcel = exportAbnormalExcel;
exportAbnormalExcel = async function(){ await ensureAllLoaded('abnormal'); return _origExportAbnormalExcel(); };
const _origExportHandoverExcel = exportHandoverExcel;
exportHandoverExcel = async function(){ await ensureAllLoaded('handover'); return _origExportHandoverExcel(); };

// 行內編輯開啟／關閉時記錄 id（收到遠端更新時保留草稿）
const _origEditAbnormal = editAbnormal;
editAbnormal = function(id){ _origEditAbnormal(id); editing.abnormal = id; editing.handover = null; };
const _origEditHandover = editHandover;
editHandover = function(id){ _origEditHandover(id); editing.handover = id; editing.abnormal = null; };
const _origCloseInlineEdits = closeInlineEdits;
closeInlineEdits = function(){ editing.abnormal = null; editing.handover = null; _origCloseInlineEdits(); };

document.getElementById('ab-date').value = localISO(new Date());
document.getElementById('ho-date').value = localISO(new Date());

window.addEventListener('afterprint', () => {
  document.body.classList.remove('previewing');
});

ZX.boot({
  site: 'report',
  title: '異常表與交接表',
  logo: '../shared/logo.svg',
  onReady: async ctx => {
    sb = ctx.sb;
    ZXC = ctx;
    gateByRole();
    ['abnormal', 'handover'].forEach(t => { restoreRange(t); renderRangeBar(t); wireRangeBar(t); });
    syncer = zxSync.createSync({
      sb, sites: ['report'],
      onChange: onRemoteChange,
      onReset: refreshAll,
      onStatus: s => ZX.syncBadge(s)
    });
    await syncer.start(async () => { await Promise.all([refreshAll(), loadCustomerNames()]); });
  }
});
