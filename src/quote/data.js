/* ===================== 新版資料層（取代原 customers 大型 JSONB 讀寫） =====================
 * 原版每次異動都整列 update customers（含 saved_records / quoted_prices / item_code_lookup 等大 JSONB），
 * 並在 customers 有任何變更時重抓全表 + 每 60 秒全量輪詢。新版：
 *   - 首頁只讀 v_quote_customer_list（無大型欄位）；品項／料號對照／範本只在用到時讀
 *   - 寫入一律走 RPC（單一交易、request_id 去重），回傳該客戶最新的一列 → upsertCustomer 局部更新
 *   - 其他裝置靠 Broadcast 小事件（客戶代號＋版本）只重讀被改動的那幾位客戶
 * 下列函式名稱與回傳格式與原版相同，原版其餘程式（精靈、匯出、畫面）完全不用改。 */

function profileRowToCustomer(row) {
  const c = rowToCustomer(row);
  return c;
}

const mappingCache = new Map();   // code → { version, mapping }
const MAPPING_PENDING = Object.freeze({ __pending: true, dataStartRowIdx: null, columnMap: {} });

// 只有真的要套用範本（上傳精靈、批次匯入報價單）時才讀完整欄位對應
async function ensureMapping(customer) {
  if (!customer || !customer.hasMapping) return customer;
  const hit = mappingCache.get(customer.code);
  if (hit && hit.version === customer.detailVersion) { customer.mapping = hit.mapping; return customer; }
  const { data, error } = await sb.from('customer_quote_mappings').select('data_start_row_idx,column_map').eq('customer_code', customer.code).maybeSingle();
  if (error) throw new Error(error.message);
  const mapping = data ? { dataStartRowIdx: data.data_start_row_idx, columnMap: data.column_map || {} } : null;
  mappingCache.set(customer.code, { version: customer.detailVersion, mapping });
  customer.mapping = mapping;
  return customer;
}

function rowsToCustomers(rows) { return (rows || []).map(rowToCustomer); }

async function rpcOrThrow(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

// 取某位客戶的全部列（超過 1000 筆也能完整取回）
async function fetchAllFiltered(table, cols, filters, orderCols) {
  const PAGE_SIZE = 1000;
  let all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = sb.from(table).select(cols);
    Object.keys(filters).forEach(k => { q = Array.isArray(filters[k]) ? q.in(k, filters[k]) : q.eq(k, filters[k]); });
    orderCols.forEach(o => { q = q.order(o); });
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

/* ---------------- 品項清單（用於比對新增品項） ---------------- */
async function fetchPreviousCodes(code) {
  try {
    assertSb();
    const { data, error } = await sb.from('customer_quote_baselines').select('item_codes').eq('customer_code', code).maybeSingle();
    if (error || !data) return [];
    return Array.isArray(data.item_codes) ? data.item_codes : [];
  } catch (err) { return []; }
}

/* ---------------- 無貨號客戶：料號對照（客戶品名 → 忠欣料號） ---------------- */
async function fetchItemCodeLookup(code) {
  try {
    assertSb();
    const rows = await fetchAllFiltered('customer_item_code_mappings', 'customer_item_name,item_code,item_name', { customer_code: code }, ['sort_order', 'customer_item_name']);
    return rows.map(r => ({ name: r.customer_item_name, code: r.item_code, itemName: r.item_name || '' }));
  } catch (err) { return []; }
}
// 整份取代（不是合併）：使用者重新上傳，代表要用新的那份為準
async function saveItemCodeLookup(code, lookupArray) {
  assertSb();
  const rows = await rpcOrThrow('quote_replace_lookups', {
    p_customer_code: code,
    p_entries: (lookupArray || []).map(x => ({ name: x.name, code: x.code, itemName: x.itemName || '' })),
    p_request_id: zxSync.uuid()
  });
  return rowToCustomer(rows[0]);
}

/* ---------------- 無貨號客戶：報價先儲存，之後批次匯出 ---------------- */
async function fetchQuotedPrices(code) {
  try {
    assertSb();
    const rows = await fetchAllFiltered('customer_quote_items', 'list_kind,line_no,item_code,item_name,unit,price,is_new', { customer_code: code, list_kind: ['matched', 'unmatched'] }, ['list_kind', 'line_no']);
    return {
      matched: rows.filter(r => r.list_kind === 'matched').map(r => ({ code: r.item_code, price: toNumberIfPossible(r.price), isNew: r.is_new })),
      unmatched: rows.filter(r => r.list_kind === 'unmatched').map(r => ({ name: r.item_name, unit: r.unit || '', price: toNumberIfPossible(r.price) }))
    };
  } catch (err) { return { matched: [], unmatched: [] }; }
}

function priceText(v) {
  const n = toNumberIfPossible(v);
  return n == null ? '' : String(n);
}

async function saveQuoteItems(customer, items, records) {
  assertSb();
  const codes = records.map(r => getDiffKey(r, customer.productCodeMode)).filter(Boolean);
  try {
    const res = await rpcOrThrow('quote_save_items', {
      p_customer_code: customer.code,
      p_items: items,
      p_baseline: codes,
      p_item_count: records.length,
      p_new_lookups: [],
      p_expected_revision: null,
      p_request_id: zxSync.uuid()
    });
    if (!res.ok) return { ok: false, error: '資料已在別處更新，請重新開啟上傳精靈' };
    mappingCache.delete(customer.code);
    return { ok: true, customer: rowToCustomer(res.rows[0]) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 「上傳報價單」比對完成後不立即產生檔案，先把結果存起來，之後用「批次匯出」一次把選取的
// 客戶合併成一份多欄檔案。這裡同時更新上次品項，下次上傳才能正確比對新增品項。
async function saveQuotedPrices(customer, records) {
  const items = records.map(r => r._unmatched
    ? { list_kind: 'unmatched', item_name: r['品名'], unit: r['單位'] || '', price: priceText(r['單價']) }
    : { list_kind: 'matched', item_code: r['貨號'], price: priceText(r['單價']), is_new: !!r._isNew });
  return saveQuoteItems(customer, items, records);
}

/* ---------------- 有貨號客戶：報價也先儲存，之後批次匯出 ---------------- */
async function fetchSavedRecords(code) {
  try {
    assertSb();
    const rows = await fetchAllFiltered('customer_quote_items',
      'line_no,item_code,item_name,unit,price,note,origin_variety,packing,packaging_material,origin,no_quote_reason,price_change_reason,is_new',
      { customer_code: code, list_kind: 'saved' }, ['line_no']);
    return rows.map(r => ({
      貨號: r.item_code || '', 品名: r.item_name || '', 單位: r.unit || '', 單價: r.price,
      備註: r.note || '', 產區品種: r.origin_variety || '', 裝箱方式: r.packing || '',
      包裝資材: r.packaging_material || '', 產地: r.origin || '', 不報價原因: r.no_quote_reason || '',
      變價原因: r.price_change_reason || '', _isNew: !!r.is_new
    }));
  } catch (err) { return []; }
}
async function saveHasCodeRecords(customer, records) {
  const items = records.map(r => ({
    list_kind: 'saved',
    item_code: r['貨號'] || '', item_name: r['品名'] || '', unit: r['單位'] || '',
    price: r['單價'] == null ? '' : String(r['單價']),
    note: r['備註'] || '', origin_variety: r['產區品種'] || '', packing: r['裝箱方式'] || '',
    packaging_material: r['包裝資材'] || '', origin: r['產地'] || '', no_quote_reason: r['不報價原因'] || '',
    price_change_reason: r['變價原因'] || '', is_new: !!r._isNew
  }));
  return saveQuoteItems(customer, items, records);
}

/* ---------------- 忠欣品項主檔（全公司共用；本機快取，版本有變才重抓） ---------------- */
const MASTER_CACHE_KEY = 'zx-quote-master-items-v1';
async function loadMasterItems() {
  try {
    assertSb();
    const { data: ver } = await sb.from('dataset_versions').select('version').eq('name', 'master_items').maybeSingle();
    const version = ver ? ver.version : 0;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(MASTER_CACHE_KEY) || 'null'); } catch (e) { cached = null; }
    let items;
    if (cached && cached.version === version && cached.url === ZX_CONFIG.url && Array.isArray(cached.items)) {
      items = cached.items;
    } else {
      const data = await fetchAllRows('master_items', 'item_code,item_name,unit,spec_code,grade', 'item_code');
      items = (data || []).map(r => ({ itemCode: r.item_code, itemName: r.item_name || '', unit: r.unit || '', specCode: r.spec_code || '', grade: r.grade || '' }));
      try { localStorage.setItem(MASTER_CACHE_KEY, JSON.stringify({ version, url: ZX_CONFIG.url, items })); } catch (e) { /* 空間不足就不快取 */ }
    }
    state.masterItems = items;
    const countEl = document.getElementById('masterItemsCount');
    if (countEl) countEl.textContent = state.masterItems.length;
    const countElTop = document.getElementById('masterItemsCountTop');
    if (countElTop) countElTop.textContent = state.masterItems.length;
  } catch (err) {
    toast('err', '載入忠欣品項主檔失敗：' + err.message);
  }
}
// 整批 upsert（原版行為：檔案沒帶到的舊料號保留，不自動刪除）
async function saveMasterItems(rows) {
  assertSb();
  const payload = rows.map(r => ({ item_code: r.itemCode, item_name: r.itemName, unit: r.unit, spec_code: r.specCode || '', grade: r.grade || '' }));
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    await rpcOrThrow('master_items_upsert', { p_items: payload.slice(i, i + CHUNK), p_has_spec: true });
  }
  await loadMasterItems();
}

/* ---------------- 單一客戶操作 ---------------- */
async function unexportCustomer(customer) {
  if (!confirm(`確定要清除 ${customer.code} 的匯出紀錄嗎？清除後將視為「尚未匯出過」，到期日重新計算。`)) return;
  setLoading(true, '更新狀態…');
  try {
    assertSb();
    const rows = await rpcOrThrow('quote_patch_profiles', {
      p_codes: [customer.code], p_patch: { export_status: '未匯出', last_export_time: null, last_export_filename: '' }
    });
    rowsToCustomers(rows).forEach(upsertCustomer);
    toast('ok', `已清除 ${customer.code} 的匯出紀錄`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
}

async function reconfigureMapping(customer) {
  if (!confirm(`確定要清除 ${customer.code} 已設定的欄位對應範本嗎？下次上傳時需要重新設定。`)) return;
  setLoading(true, '清除設定中…');
  try {
    assertSb();
    const rows = await rpcOrThrow('quote_set_mapping', { p_customer_code: customer.code, p_mapping: null });
    mappingCache.delete(customer.code);
    rowsToCustomers(rows).forEach(upsertCustomer);
    toast('ok', `已清除 ${customer.code} 的欄位對應設定`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
}

async function deleteCustomerSingle(customer) {
  if (!ZXC.can.delete) { toast('err', '刪除客戶只限管理員'); return; }
  if (!confirm(`確定要刪除客戶 ${customer.code} ${customer.name || ''} 嗎？此操作無法復原，客戶的欄位對應、匯出紀錄都會一併刪除。`)) return;
  setLoading(true, '刪除中…');
  try {
    assertSb();
    await rpcOrThrow('quote_delete_customers', { p_codes: [customer.code] });
    state.customers = state.customers.filter(c => c.code !== customer.code);
    state.selectedCodes.delete(customer.code);
    if (state.activeDetailCode === customer.code) state.activeDetailCode = null;
    renderStageCards(); renderCustomerList(); renderDetailPanel(); renderExportTray(); updateBulkButtonsState();
    toast('ok', `已刪除 ${customer.code}`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
}

// 新增/編輯客戶寫入邏輯：只有「匯出狀態」真的有變動時才動到 last_export_time，
// 避免只是改個名字之類的無關編輯，卻不小心把到期日重新起算。
async function saveCustomerToBackend(payload) {
  assertSb();
  const existing = state.customers.find(c => c.code === payload.code) || null;
  const desired = payload.exportStatus === '已匯出' ? '已匯出' : '未匯出';
  const nowIso = new Date().toISOString();

  const upsertRow = {
    code: payload.code,
    name: payload.name || '',
    product_code_mode: payload.productCodeMode === '無貨號' ? '無貨號' : '有貨號',
    quote_cycle: ['7天', '10天', '15天', '30天'].includes(payload.quoteCycle) ? payload.quoteCycle : '7天',
    unit_category: ['kg', '台斤'].includes(payload.unitCategory) ? payload.unitCategory : '',
    notes: payload.notes || '',
    quote_file_location: payload.quoteFileLocation || ''
  };
  if (!existing) {
    upsertRow.export_status = desired;
    upsertRow.last_export_time = desired === '已匯出' ? nowIso : null;
  } else if (desired !== (existing.exportStatus || '未匯出')) {
    upsertRow.export_status = desired;
    if (desired === '已匯出') {
      upsertRow.last_export_time = nowIso;
    } else {
      upsertRow.last_export_time = null;
      upsertRow.last_export_filename = '';
    }
  }
  const rows = await rpcOrThrow('quote_upsert_customers', { p_rows: [upsertRow], p_request_id: zxSync.uuid() });
  return rowToCustomer(rows[0]);
}

async function saveMappingForCustomer() {
  try {
    assertSb();
    const mapping = { dataStartRowIdx: state.wizard.dataStartRowIdx, columnMap: state.wizard.columnMap };
    const rows = await rpcOrThrow('quote_set_mapping', { p_customer_code: state.wizard.customer.code, p_mapping: mapping });
    if (rows && rows.length) {
      const customer = rowToCustomer(rows[0]);
      mappingCache.set(customer.code, { version: customer.detailVersion, mapping });
      customer.mapping = mapping;
      state.wizard.customer = customer;
      upsertCustomer(customer);
    }
  } catch (err) { /* 靜默失敗，不影響匯出流程 */ }
}

/* ---------------- 即時同步：只重讀被改動的客戶 ---------------- */
const pendingCodes = new Set();
let pendingTimer = null;
function queueCustomerRefresh(code) {
  pendingCodes.add(code);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushCustomerRefresh, 150);
}
async function flushCustomerRefresh() {
  const codes = Array.from(pendingCodes);
  pendingCodes.clear();
  if (!codes.length) return;
  const { data, error } = await sb.from('v_quote_customer_list').select(CUSTOMER_SELECT_COLS).in('code', codes);
  if (error) { console.warn('refresh customers failed', error); return; }
  const got = new Set();
  (data || []).forEach(row => { got.add(row.code); upsertCustomer(rowToCustomer(row)); });
  const gone = codes.filter(c => !got.has(c));
  if (gone.length) {
    state.customers = state.customers.filter(c => !gone.includes(c.code));
    gone.forEach(c => state.selectedCodes.delete(c));
    if (gone.includes(state.activeDetailCode)) state.activeDetailCode = null;
    renderStageCards(); renderCustomerList(); renderDetailPanel(); renderExportTray();
  }
}

function onRemoteChange(c) {
  if (c.t === 'customer_quote_profiles') {
    if (c.k === '*') { loadCustomers(false); return; }
    const local = state.customers.find(x => x.code === c.k);
    if (local && c.rev != null && local.revision >= c.rev) return;    // 自己剛寫入的
    queueCustomerRefresh(c.k);
  } else if (c.t === 'customers') {
    if (c.k === '*') { loadCustomers(false); return; }
    if (state.customers.some(x => x.code === c.k)) queueCustomerRefresh(c.k);
  } else if (c.t === 'master_items') {
    if (state.masterItems.length) loadMasterItems();
  }
}

let quoteSync = null;
function setupRealtime() {
  quoteSync = zxSync.createSync({
    sb, sites: ['quote', 'shared'],
    onChange: onRemoteChange,
    onReset: () => loadCustomers(false),
    onStatus: s => ZX.syncBadge(s)
  });
  return quoteSync;
}
