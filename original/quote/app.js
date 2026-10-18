/* ===================== 報價單匯出系統 - 前端邏輯（Supabase 版） ===================== */

// 請填入你的 Supabase 專案資訊：Supabase 後台 →「Project Settings」→「API」
//   - SUPABASE_URL：例如 https://abcdefghijklmnop.supabase.co（結尾不要加斜線 /，也不要自己加 /rest/v1 之類的路徑）
//   - SUPABASE_ANON_KEY：「Project API keys」裡的 anon / public key（不是 service_role！）
// 這把 anon key 之後會直接出現在網頁原始碼裡，這是正常且必要的（前端本來就要用它連線），
// 資料的存取權限由 Supabase 那邊的 Row Level Security 規則控制，不是靠隱藏這把 key 來保護。
const SUPABASE_URL = 'https://ovjdtzzvpafomivbuecb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92amR0enp2cGFmb21pdmJ1ZWNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NTMyODUsImV4cCI6MjEwNDQyOTI4NX0.gJleE2ca_bPoKgAJsJqb6sn5RVBczIxHUxImxStjWDE';
const FRONTEND_VERSION = '2026-09-25-supabase-v22';

// 驗證是不是一個「看起來像樣」的 Supabase URL：https 開頭、能被解析成正常網址、
// 且不是還沒填的預設值。單純檢查字串開頭不是預設文字是不夠的——像是貼到多餘的空白、
// 斜線、引號，或是把 anon key 貼錯欄位，都可能造成 Supabase 用戶端內部組網址失敗，
// 出現「Invalid path specified in request URL」這種不容易懂的錯誤，所以這裡先擋掉。
function isConfiguredSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.indexOf('YOUR_SUPABASE_URL') !== -1) return false;
  const trimmed = url.trim();
  if (trimmed !== url) return false; // 前後有多餘空白，代表複製貼上時可能出錯
  try {
    const u = new URL(trimmed);
    return u.protocol === 'https:' && u.hostname.length > 3 && (u.pathname === '' || u.pathname === '/');
  } catch (e) { return false; }
}
function isConfiguredSupabaseKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.indexOf('YOUR_SUPABASE_ANON_KEY') !== -1) return false;
  return key.trim() === key && key.length > 20;
}

const _sbConfigOk = typeof supabase !== 'undefined' && isConfiguredSupabaseUrl(SUPABASE_URL) && isConfiguredSupabaseKey(SUPABASE_ANON_KEY);
let sb = null;
let sbInitError = '';
if (_sbConfigOk) {
  try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    sbInitError = 'Supabase 用戶端建立失敗：' + err.message + '（請確認 SUPABASE_URL／SUPABASE_ANON_KEY 是否貼對、貼完整）';
  }
} else if (typeof supabase === 'undefined') {
  sbInitError = 'Supabase 函式庫沒有載入成功，請確認 index.html 裡的 supabase-js CDN 標籤沒被刪掉、網路也能連到 cdn.jsdelivr.net';
} else if (!isConfiguredSupabaseUrl(SUPABASE_URL)) {
  sbInitError = 'SUPABASE_URL 格式不正確或還沒填：請確認是完整的 https://xxxxxxxx.supabase.co（結尾不要有斜線、前後不要有空白或引號）';
} else if (!isConfiguredSupabaseKey(SUPABASE_ANON_KEY)) {
  sbInitError = 'SUPABASE_ANON_KEY 格式不正確或還沒填：請確認貼的是 Project Settings → API 裡的 anon / public key';
}

function assertSb() {
  if (!sb) throw new Error(sbInitError || '尚未設定 Supabase 連線資訊，請在 app.js 開頭填入 SUPABASE_URL 與 SUPABASE_ANON_KEY');
}

const TARGET_FIELDS_BASE = [
  { key: '貨號',     label: '客戶貨號 *',   required: true },
  { key: '品名',     label: '客戶商品名稱', required: false },
  { key: '單位',     label: '客戶規格單位', required: false },
  { key: '單價',     label: '單價 *',       required: true },
  { key: '備註',     label: '備註',         required: false },
  { key: '產區品種', label: '產區/品種',    required: false },
  { key: '裝箱方式', label: '裝箱方式',     required: false },
  { key: '包裝資材', label: '包裝資材',     required: false },
  { key: '產地',     label: '產地',         required: false },
  { key: '不報價原因', label: '不報價原因', required: false },
  { key: '變價原因', label: '變價原因',     required: false }
];
// 「無貨號」客戶改用商品名稱當識別欄位；必填標記需要跟著換
function getTargetFields(productCodeMode) {
  const noCode = productCodeMode === '無貨號';
  return TARGET_FIELDS_BASE.map(f => {
    if (f.key === '貨號') return Object.assign({}, f, { required: !noCode, label: noCode ? '客戶貨號（無則留空）' : '客戶貨號 *' });
    if (f.key === '品名') return Object.assign({}, f, { required: noCode, label: noCode ? '客戶商品名稱 *' : '客戶商品名稱' });
    return f;
  });
}
function getIdentityField(productCodeMode) {
  return productCodeMode === '無貨號' ? '品名' : '貨號';
}

const OUTPUT_HEADERS = ['*客戶代號','客戶名稱','*客戶貨號','客戶商品名稱','客戶規格單位','*單價','備註','產區/品種','裝箱方式','包裝資材','產地','不報價原因','變價原因'];
const OUTPUT_FIELD_ORDER = [null, null, '貨號', '品名', '單位', '單價', '備註', '產區品種', '裝箱方式', '包裝資材', '產地', '不報價原因', '變價原因'];

const QUOTE_CYCLE_DAYS = { '7天': 7, '10天': 10, '15天': 15, '30天': 30 };

// Supabase 的 timestamptz 欄位回傳的是標準 ISO 字串（例如 2026-09-06T01:43:00+00:00），
// 用原生 Date 建構子就能正確解析，不再需要自己拼格式，也不會有 Google Sheets 自動轉型的問題。
function parseDateLoose(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function formatDateShort(d) {
  if (!d) return '';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
// 依「報價週期」與「最後匯出時間」計算到期日：never(從沒匯出過) / active(有效期內) / overdue(逾期未匯出)
function computeDueInfo(c) {
  const days = QUOTE_CYCLE_DAYS[c.quoteCycle] || 7;
  const last = parseDateLoose(c.lastExportTime);
  if (!last) return { state: 'never', due: null };
  const due = new Date(last.getTime());
  due.setDate(due.getDate() + days);
  const now = new Date();
  return { state: now >= due ? 'overdue' : 'active', due };
}
let state = {
  customers: [],
  activeTab: 'hasCode', // hasCode | noCode
  stageFilter: 'ready', // setup | pending | ready — 取代原本的統計卡篩選
  cycleFilter: 'all', // all | 7天 | 10天 | 15天 | 30天
  unitCategoryFilter: 'all', // all | kg | 台斤 | '' — 只有無貨號頁籤會用到，因為報價單位不同，匯出時不能混在一起
  search: '',
  activeDetailCode: null, // 目前在右側詳情面板顯示的客戶代號
  masterItems: [], // {itemCode, itemName, unit}[] — 全公司共用，切到「無貨號客戶」頁籤時載入
  selectedCodes: new Set(), // 目前頁籤內被勾選、供批次修改／批次匯出使用的客戶代號（僅限「可批次匯出」階段的客戶）
  wizard: null, // 見 openWizard()
  lookupWizard: null // 見 openLookupWizard()（無貨號客戶：上傳料號對照表）
};

/* ---------------- 資料列轉換：Supabase 的 snake_case 欄位 → 前端慣用的 camelCase ---------------- */
// 客戶清單查詢共用的欄位（不含 last_item_codes/item_code_lookup/quoted_prices 這幾個可能較大的欄位，
// 那些只有真的要用時才單獨查，見 fetchPreviousCodes／fetchItemCodeLookup／fetchQuotedPrices）
const CUSTOMER_SELECT_COLS = 'code,name,quote_cycle,trade_status,export_status,last_export_time,last_export_filename,mapping,product_code_mode,last_export_item_count,item_code_lookup_count,quoted_prices_count,last_quote_upload_time,saved_records_count,notes,unit_category,quote_file_location';

function rowToCustomer(row) {
  return {
    code: row.code,
    name: row.name || '',
    quoteCycle: row.quote_cycle || '7天',
    tradeStatus: row.trade_status || '核准交易',
    exportStatus: row.export_status || '未匯出',
    lastExportTime: row.last_export_time || '',
    lastExportFileName: row.last_export_filename || '',
    mapping: row.mapping || null,
    productCodeMode: row.product_code_mode || '有貨號',
    lastExportItemCount: row.last_export_item_count || 0,
    itemCodeLookupCount: row.item_code_lookup_count || 0,
    quotedPricesCount: row.quoted_prices_count || 0,
    lastQuoteUploadTime: row.last_quote_upload_time || '',
    savedRecordsCount: row.saved_records_count || 0,
    notes: row.notes || '',
    unitCategory: row.unit_category || '',
    quoteFileLocation: row.quote_file_location || ''
  };
}

// Supabase/PostgREST 預設每次查詢最多回傳 1000 筆（伺服器端安全上限，不是分頁功能關掉），
// 超過的資料會被悄悄截斷、不會報錯，所以像忠欣品項主檔這種可能上千筆的資料表，
// 一定要用 .range() 分批撈完整份，不能只信任一次 select() 就拿到全部。
async function fetchAllRows(tableName, selectCols, orderCol) {
  const PAGE_SIZE = 1000;
  let allRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from(tableName).select(selectCols).order(orderCol).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    allRows = allRows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

/* ---------------- API（Supabase：讀取） ---------------- */
async function loadCustomers(showLoading) {
  if (showLoading) setLoading(true, '載入客戶資料…');
  try {
    assertSb();
    const data = await fetchAllRows('customers', CUSTOMER_SELECT_COLS, 'code');
    state.customers = (data || []).map(rowToCustomer);
    renderStageCards();
    renderCustomerList();
    renderDetailPanel();
    renderExportTray();
  } catch (err) {
    toast('err', '載入失敗：' + err.message);
  } finally {
    if (showLoading) setLoading(false);
  }
}

// Realtime：資料在任何裝置異動時，Supabase 會主動推播通知，收到就重新整理一次，
// 不必再像過去那樣高度依賴輪詢；下面仍保留一個低頻率輪詢當作保險（例如忘了在後台開 Realtime 時）。
let realtimeChannel = null;
function setupRealtime() {
  if (!sb || realtimeChannel) return;
  try {
    realtimeChannel = sb.channel('customers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, () => {
        loadCustomers(false);
      })
      .subscribe();
  } catch (err) {
    console.warn('Realtime 訂閱失敗（不影響基本功能，仍會靠輪詢同步）：', err);
  }
}

/* ---------------- 共用 UI 工具 ---------------- */
function setLoading(on, text, progress) {
  const ov = document.getElementById('loadingOverlay');
  if (text) document.getElementById('loadingText').textContent = text;
  ov.classList.toggle('open', !!on);
  const wrap = document.getElementById('loadingProgressWrap');
  const bar = document.getElementById('loadingProgressBar');
  if (on && typeof progress === 'number' && Number.isFinite(progress)) {
    wrap.style.display = 'block';
    bar.style.width = Math.max(0, Math.min(1, progress)) * 100 + '%';
  } else {
    wrap.style.display = 'none';
    bar.style.width = '0%';
  }
}
function toast(kind, msg) {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, 3200);
}
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
});
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(ov.id); });
});

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 清掉常見的數值雜訊：千分位逗號、貨幣符號、多餘空白、括號表示的負數（會計格式）
function cleanNumericString(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if (!s) return '';
  const negParen = /^\((.+)\)$/.exec(s);
  if (negParen) s = '-' + negParen[1];
  s = s.replace(/[,$￥\s]|NT\$?/gi, '');
  return s;
}
function toNumberIfPossible(v) {
  if (v === '' || v == null) return null;
  const cleaned = cleanNumericString(v);
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : v;
}

/* ---------------- 延遲載入大型函式庫（加快首次進入頁面速度） ---------------- */
const _loadedScripts = {};
function loadScriptOnce(url) {
  if (_loadedScripts[url]) return _loadedScripts[url];
  _loadedScripts[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => { delete _loadedScripts[url]; reject(new Error('資源載入失敗：' + url)); };
    document.head.appendChild(s);
  });
  return _loadedScripts[url];
}
function ensureXLSX() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  return loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
}
function ensureExcelJS() {
  return Promise.all([
    typeof ExcelJS !== 'undefined' ? Promise.resolve() : loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'),
    typeof saveAs !== 'undefined' ? Promise.resolve() : loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js')
  ]);
}

/* ---------------- 讀取 Excel 檔為原始二維陣列 ---------------- */
async function readWorkbookRaw(file) {
  await ensureXLSX();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: false });
        const firstSheetName = wb.SheetNames[0];
        const ws = wb.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        // 客戶的報價單常常會用 Excel「隱藏列」處理不報價/停用的品項，這種列不該被當成資料匯入。
        // 偵測隱藏列並清空內容，讓既有「整列空白就跳過」的邏輯自然把它們排除掉。
        const rowMeta = ws['!rows'] || [];
        let hiddenCount = 0;
        rowMeta.forEach((meta, idx) => {
          if (meta && meta.hidden && rows[idx] && rows[idx].some(c => String(c || '').trim() !== '')) {
            rows[idx] = [];
            hiddenCount++;
          }
        });
        resolve({ sheetName: firstSheetName, rows, hiddenCount });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('檔案讀取失敗'));
    reader.readAsArrayBuffer(file);
  });
}

/* ---------------- 品項清單（用於比對新增品項） ---------------- */
async function fetchPreviousCodes(code) {
  try {
    assertSb();
    const { data, error } = await sb.from('customers').select('last_item_codes').eq('code', code).maybeSingle();
    if (error || !data) return [];
    return Array.isArray(data.last_item_codes) ? data.last_item_codes : [];
  } catch (err) { return []; }
}

/* ---------------- 無貨號客戶：料號對照（客戶品名 → 忠欣料號） ---------------- */
async function fetchItemCodeLookup(code) {
  try {
    assertSb();
    const { data, error } = await sb.from('customers').select('item_code_lookup').eq('code', code).maybeSingle();
    if (error || !data) return [];
    return Array.isArray(data.item_code_lookup) ? data.item_code_lookup : [];
  } catch (err) { return []; }
}
// 整份取代（不是合併）：使用者重新上傳，代表要用新的那份為準
async function saveItemCodeLookup(code, lookupArray) {
  assertSb();
  const { data, error } = await sb.from('customers').update({
    item_code_lookup: lookupArray, updated_at: new Date().toISOString()
  }).eq('code', code).select(CUSTOMER_SELECT_COLS).single();
  if (error) throw new Error(error.message);
  return rowToCustomer(data);
}

/* ---------------- 無貨號客戶：報價先儲存，之後批次匯出 ---------------- */
async function fetchQuotedPrices(code) {
  try {
    assertSb();
    const { data, error } = await sb.from('customers').select('quoted_prices').eq('code', code).maybeSingle();
    if (error || !data || !data.quoted_prices) return { matched: [], unmatched: [] };
    return {
      matched: Array.isArray(data.quoted_prices.matched) ? data.quoted_prices.matched : [],
      unmatched: Array.isArray(data.quoted_prices.unmatched) ? data.quoted_prices.unmatched : []
    };
  } catch (err) { return { matched: [], unmatched: [] }; }
}
// 「上傳報價單」比對完成後不立即產生檔案，先把結果存起來，之後用「批次匯出」一次把選取的
// 客戶合併成一份多欄檔案。這裡同時把 last_item_codes 更新好，下次上傳才能正確比對新增品項。
async function saveQuotedPrices(customer, records) {
  assertSb();
  const identityField = getIdentityField(customer.productCodeMode);
  const matched = records.filter(r => !r._unmatched).map(r => ({ code: r['貨號'], price: toNumberIfPossible(r['單價']), isNew: r._isNew }));
  const unmatched = records.filter(r => r._unmatched).map(r => ({ name: r['品名'], unit: r['單位'] || '', price: toNumberIfPossible(r['單價']) }));
  const codes = records.map(r => getDiffKey(r, customer.productCodeMode)).filter(Boolean);
  const nowIso = new Date().toISOString();
  const { data, error } = await sb.from('customers').update({
    quoted_prices: { matched, unmatched },
    last_item_codes: codes,
    last_quote_upload_time: nowIso,
    last_export_item_count: records.length,
    updated_at: nowIso
  }).eq('code', customer.code).select(CUSTOMER_SELECT_COLS).single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, customer: rowToCustomer(data) };
}

/* ---------------- 有貨號客戶：報價也先儲存，之後批次匯出 ---------------- */
async function fetchSavedRecords(code) {
  try {
    assertSb();
    const { data, error } = await sb.from('customers').select('saved_records').eq('code', code).maybeSingle();
    if (error || !data || !Array.isArray(data.saved_records)) return [];
    return data.saved_records;
  } catch (err) { return []; }
}
// 「上傳報價單」比對完成後不立即產生檔案，先把整理好的品項列存起來，之後用「批次匯出」把選取的
// 客戶串成同一份檔案（客戶代號/客戶名稱是逐列欄位，天生就能跟其他客戶的列共存）。
async function saveHasCodeRecords(customer, records) {
  assertSb();
  const codes = records.map(r => getDiffKey(r, customer.productCodeMode)).filter(Boolean);
  const nowIso = new Date().toISOString();
  const toSave = records.map(r => ({
    貨號: r['貨號'] || '', 品名: r['品名'] || '', 單位: r['單位'] || '', 單價: r['單價'],
    備註: r['備註'] || '', 產區品種: r['產區品種'] || '', 裝箱方式: r['裝箱方式'] || '',
    包裝資材: r['包裝資材'] || '', 產地: r['產地'] || '', 不報價原因: r['不報價原因'] || '', 變價原因: r['變價原因'] || '',
    _isNew: !!r._isNew
  }));
  const { data, error } = await sb.from('customers').update({
    saved_records: toSave,
    last_item_codes: codes,
    last_quote_upload_time: nowIso,
    last_export_item_count: records.length,
    updated_at: nowIso
  }).eq('code', customer.code).select(CUSTOMER_SELECT_COLS).single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, customer: rowToCustomer(data) };
}

/* ---------------- 忠欣品項主檔（全公司共用） ---------------- */
async function loadMasterItems() {
  try {
    assertSb();
    const data = await fetchAllRows('master_items', 'item_code,item_name,unit,spec_code,grade', 'item_code');
    state.masterItems = (data || []).map(r => ({ itemCode: r.item_code, itemName: r.item_name || '', unit: r.unit || '', specCode: r.spec_code || '', grade: r.grade || '' }));
    const countEl = document.getElementById('masterItemsCount');
    if (countEl) countEl.textContent = state.masterItems.length;
    const countElTop = document.getElementById('masterItemsCountTop');
    if (countElTop) countElTop.textContent = state.masterItems.length;
  } catch (err) {
    toast('err', '載入忠欣品項主檔失敗：' + err.message);
  }
}
// 整份取代：刪掉舊的、寫入新的（主檔用 code 當 key，這裡直接整批 upsert；
// 若使用者上傳的檔案刪掉了某些舊料號，舊料號仍會留著，畢竟不確定是真的下架還是漏帶，
// 由使用者自行到 Supabase 後台刪除比較保險）
async function saveMasterItems(rows) {
  assertSb();
  const payload = rows.map(r => ({ item_code: r.itemCode, item_name: r.itemName, unit: r.unit, spec_code: r.specCode || '', grade: r.grade || '', updated_at: new Date().toISOString() }));
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { error } = await sb.from('master_items').upsert(chunk, { onConflict: 'item_code' });
    if (error) throw new Error(error.message);
  }
  await loadMasterItems();
}

// 核心轉換：套用欄位對應 + 無單價自動補0 + 與上次匯出比對新增品項，回傳排序後的紀錄陣列
// itemCodeLookup：該客戶自己的「客戶品名 → 忠欣料號」對照（只有無貨號客戶會用到）
// masterItems：忠欣品項主檔（全公司共用），用比對到的料號回填官方單位
// 比對「有沒有比過上次」用的識別鍵：無貨號客戶一旦比對到料號，就該用料號比（同一個品項，
// 客戶下次打的名稱字句可能有些微差異，但只要比對到同一個忠欣料號就該視為同一項）；
// 真的比對不到料號時才退回用客戶自己的品名。有貨號客戶維持原本直接用貨號。
function getDiffKey(rec, productCodeMode) {
  if (productCodeMode === '無貨號') return rec['貨號'] || rec['品名'];
  return rec['貨號'];
}

// rawRowsList：一或多個檔案各自解析出來的二維陣列（單一客戶一次可以上傳多個檔案，
// 只要這些檔案的欄位格式相同，就能套用同一組 dataStartRowIdx/columnMap 一次處理）
// 有些客戶的報價單是「多欄並排的重複區塊」格式——同一張表裡橫向擺了好幾組（品名/單位/單價），
// 不是單純一路往下的單一清單。這裡先把 columnMap 依照「識別欄位」（品名或貨號）出現的欄位順序
// 切成好幾組，每組各自只包含自己那個區塊範圍內的欄位對應；一般只有一組的情況（欄位對應裡
// 識別欄位只出現一次）跟原本行為完全一樣，不影響既有客戶。
function splitColumnMapIntoGroups(columnMap, identityField) {
  const sortedCols = Object.keys(columnMap).map(Number).sort((a, b) => a - b);
  const groups = [];
  let currentGroup = null;
  sortedCols.forEach(colIdx => {
    const field = columnMap[colIdx];
    if (field === identityField || !currentGroup) {
      currentGroup = {};
      groups.push(currentGroup);
    }
    currentGroup[colIdx] = field;
  });
  return groups.length ? groups : [{}];
}

function buildConvertedRecords(rawRowsList, dataStartRowIdx, columnMap, productCodeMode, previousCodes, itemCodeLookup, masterItems) {
  const identityField = getIdentityField(productCodeMode);
  const prevSet = new Set(previousCodes || []);
  const noCode = productCodeMode === '無貨號';
  const lookupMap = new Map((itemCodeLookup || []).map(x => [x.name, x.code]));
  const masterMap = new Map((masterItems || []).map(m => [m.itemCode, m]));
  const groups = splitColumnMapIntoGroups(columnMap, identityField);
  const recs = [];
  rawRowsList.forEach(rawRows => {
    for (let r = dataStartRowIdx; r < rawRows.length; r++) {
      const row = rawRows[r] || [];
      if (row.every(c => String(c == null ? '' : c).trim() === '')) continue;
      groups.forEach(group => {
        const rec = {};
        Object.keys(group).forEach(idxStr => {
          const idx = +idxStr, field = group[idxStr];
          let v = row[idx]; v = v == null ? '' : String(v).trim();
          rec[field] = v;
        });
        if (!rec[identityField]) return; // 這個區塊這一列沒有品名/貨號，跳過（常見於各區塊筆數不一致、尾端留白）
        const priceWasZeroOrBlank = !rec['單價'] || !String(rec['單價']).trim() || String(rec['單價']).trim() === '0';
        if (!rec['單價'] || !String(rec['單價']).trim()) rec['單價'] = '0'; // 無單價自動補0
        // 有貨號客戶：只要有實際報價（單價不是 0），「不報價原因」一律清空，避免跟有報價的品項邏輯矛盾；
        // 沒報價時（單價是 0 或空白）不自動補任何文字，單價是 0 已經足以表示沒報價，
        // 不報價原因維持客戶檔案裡原本寫的內容（沒填就是空白）
        if (!noCode && !priceWasZeroOrBlank) {
          rec['不報價原因'] = '';
        }
        if (noCode) {
          const matchedCode = lookupMap.get(rec['品名']);
          if (matchedCode) {
            rec['貨號'] = matchedCode;
            rec._unmatched = false;
            const master = masterMap.get(matchedCode);
            if (master && !rec['單位']) rec['單位'] = master.unit; // 客戶沒填單位時，用忠欣官方單位補上
          } else {
            rec['貨號'] = '';
            rec._unmatched = true;
          }
        }
        rec._isNew = prevSet.size > 0 ? !prevSet.has(getDiffKey(rec, productCodeMode)) : false;
        recs.push(rec);
      });
    }
  });
  // 排序：一般品項 → 新增品項(黃底) → 比對不到料號(橘底，最需要處理，排最後最顯眼)
  recs.sort((a, b) => {
    const rank = x => x._unmatched ? 2 : (x._isNew ? 1 : 0);
    return rank(a) - rank(b);
  });
  return recs;
}

// 匯出檔案時跳出「另存新檔」視窗，讓使用者自己選要存在電腦的哪裡。
// File System Access API 目前只有 Chrome/Edge 等 Chromium 系瀏覽器支援，Firefox/Safari 沒有，
// 所以偵測不到就退回原本「直接下載到瀏覽器預設下載資料夾」的方式，不會讓功能整個掛掉。
// 回傳 true 代表檔案已經存好（不管是用哪種方式）；回傳 false 代表使用者在另存新檔視窗按了取消。
async function saveWorkbookFile(buffer, suggestedName) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Excel 檔案', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(buffer);
      await writable.close();
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false; // 使用者自己按取消，不要接著又觸發預設下載
      // 其他例外（少數瀏覽器版本問題等）就退回下面的預設下載方式
    }
  }
  saveAs(new Blob([buffer], { type: 'application/octet-stream' }), suggestedName);
  return true;
}

// 有貨號客戶的匯出：可以把「多個客戶」合併成一份檔案——客戶代號/客戶名稱本來就是逐列欄位，
// 每位客戶各自的品項列直接串接在同一張表裡即可，不需要像無貨號客戶那樣分欄。
// customersWithRecords: [{ customer, records }, ...]
async function exportBatchWorkbook(customersWithRecords) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('匯入格式');
  const FONT_NAME = '微軟正黑體';
  const FONT_SIZE = 11;
  // 效能關鍵：樣式物件在迴圈外先建立好、重複參照使用，不要每個儲存格都 new 一個新物件——
  // 幾百列 x 13 欄下來，光是物件配置(GC 壓力)就佔掉不少時間。ExcelJS 支援共用同一個樣式物件參照。
  const THIN = { style: 'thin', color: { argb: 'FF000000' } };
  const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const FONT_NORMAL = { name: FONT_NAME, size: FONT_SIZE };
  const FONT_NEW = { name: FONT_NAME, size: FONT_SIZE, color: { argb: 'FFFF524D' } };
  const FONT_UNMATCHED = { name: FONT_NAME, size: FONT_SIZE, color: { argb: 'FFB35400' } };
  const ALIGN_DEFAULT = { vertical: 'middle' };
  const ALIGN_LEFT = { vertical: 'middle', horizontal: 'left' };
  const FILL_NEW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFDE5A' } };
  const FILL_UNMATCHED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE6D1' } };

  const headerRow = ws.addRow(OUTPUT_HEADERS);
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = FONT_NORMAL;
    cell.border = BORDER;
    cell.alignment = colNumber === 3 ? ALIGN_LEFT : ALIGN_DEFAULT;
  });

  const widths = [12, 16, 12, 26, 14, 10, 16, 14, 14, 14, 10, 14, 14];
  ws.columns = widths.map(w => ({ width: w }));

  // 攤平所有客戶的品項列：客戶代號/客戶名稱直接寫在每一列上，天生就能跟其他客戶的列共存在同一張表
  const flatRows = [];
  customersWithRecords.forEach(cw => {
    cw.records.forEach(rec => flatRows.push({ customer: cw.customer, rec }));
  });

  // 效能關鍵：先把所有列的值組成二維陣列，一次用 addRows 批次插入，
  // 比逐列呼叫 addRow 快上不少（ExcelJS 內部對批次插入有做優化）。
  // 這裡在匯出當下再次強制校正「有報價就清空不報價原因」，不依賴上傳當下是否已經處理過——
  // 這樣就算是「上傳報價單並儲存」發生在這個規則加上去之前的舊資料，匯出時還是會被正確修正。
  const rowValues = flatRows.map(({ customer, rec }) => {
    const priceNum = toNumberIfPossible(rec['單價']);
    const hasRealPrice = typeof priceNum === 'number' && Number.isFinite(priceNum) && priceNum !== 0;
    const reason = hasRealPrice ? '' : (rec['不報價原因'] || '');
    return [
      customer.code,
      customer.name || '',
      rec['貨號'] || '',
      rec['品名'] || '',
      rec['單位'] || '',
      priceNum,
      rec['備註'] || '',
      rec['產區品種'] || '',
      rec['裝箱方式'] || '',
      rec['包裝資材'] || '',
      rec['產地'] || '',
      reason,
      rec['變價原因'] || ''
    ];
  });
  const addedRows = ws.addRows(rowValues);
  addedRows.forEach((row, i) => {
    const rec = flatRows[i].rec;
    row.getCell(3).numFmt = '@';
    const font = rec._unmatched ? FONT_UNMATCHED : (rec._isNew ? FONT_NEW : FONT_NORMAL);
    const fill = rec._unmatched ? FILL_UNMATCHED : (rec._isNew ? FILL_NEW : null);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.font = font;
      cell.border = BORDER;
      cell.alignment = colNumber === 3 ? ALIGN_LEFT : ALIGN_DEFAULT;
      if (fill) cell.fill = fill;
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  const today = new Date();
  const stamp = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
  const outName = customersWithRecords.length === 1
    ? `${customersWithRecords[0].customer.code}_${customersWithRecords[0].customer.name || ''}_報價單匯入_${stamp}.xlsx`
    : `多客戶報價單_${customersWithRecords.length}家_${stamp}.xlsx`;
  const saved = await saveWorkbookFile(buf, outName);
  return saved ? outName : null;
}

// 無貨號客戶的匯出：可以把「多個客戶」合併成一份檔案——A-E 欄是共用的忠欣品項主檔（固定筆數、固定順序），
// 每個客戶各自佔一欄（F、G、H...），該客戶這次報價比對到的單價填進對應品項那一列；沒被報價的品項留空。
// 比對不到料號的品項（customer 打的名稱在料號對照表裡找不到）沒有主檔列可以對應，
// 依客戶分段附加在整份主檔之後，一樣秉持「不會被默默漏掉」的原則。
// customersWithData: [{ customer, matched:[{code,price,isNew}], unmatched:[{name,unit,price}] }, ...]
async function exportNoCodeBatchWorkbook(customersWithData, masterItems) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('多客戶報價單格式');
  const FONT_NAME = '微軟正黑體';
  const FONT_SIZE = 12;
  const THIN = { style: 'thin', color: { argb: 'FF000000' } };
  const FONT_NORMAL = { name: FONT_NAME, size: FONT_SIZE };
  const FONT_NEW = { name: FONT_NAME, size: FONT_SIZE, color: { argb: 'FFFF524D' } };
  const FONT_UNMATCHED = { name: FONT_NAME, size: FONT_SIZE, color: { argb: 'FFB35400' } };
  const FILL_NEW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFDE5A' } };
  const FILL_UNMATCHED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE6D1' } };
  // 客戶指定的範本格式：A-E 欄（品項代號~等級，這幾欄是所有客戶共用的忠欣主檔部分）在表頭三列
  // 要有淡藍底色，跟後面客戶各自的價格欄位（沒有底色）做區隔；不要更動這個顏色跟格線配置
  const FILL_HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDEEBF7' } };
  const ALIGN_L = { horizontal: 'left', vertical: 'center' };
  const ALIGN_R = { horizontal: 'right', vertical: 'center' };
  const PRICE_FMT = '#,##0_);[Red](#,##0)';
  const N = customersWithData.length;

  ws.columns = [{ width: 23.875 }, { width: 31.125 }, { width: 11.375 }, { width: 9.625 }, { width: 14.125 }]
    .concat(customersWithData.map(() => ({ width: 18 })));

  // 每個客戶各自的「品項代號 → 比對結果」，之後逐列查比 O(1)
  const priceMaps = customersWithData.map(cw => {
    const m = new Map();
    (cw.matched || []).forEach(x => m.set(x.code, x));
    return m;
  });

  // 第1列：對象識別，每個客戶欄都固定填 1
  const row1 = ws.addRow(['對象識別', '', '', '', ''].concat(customersWithData.map(() => 1)));
  row1.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = FONT_NORMAL;
    cell.alignment = ALIGN_L;
    if (colNumber === 1 || colNumber > 5) cell.border = { top: THIN, bottom: THIN };
    if (colNumber <= 5) cell.fill = FILL_HEADER;
  });
  for (let i = 0; i < N; i++) row1.getCell(6 + i).numFmt = '_-* #,##0_-;-* #,##0_-;_-* "-"??_-;_-@_-';

  // 第2列：每個客戶欄填自己的客戶代號
  const row2 = ws.addRow(['客戶代號/報價群組代號', '', '', '', ''].concat(customersWithData.map(cw => cw.customer.code)));
  row2.eachCell({ includeEmpty: true }, (cell, colNumber) => { if (colNumber <= 5) cell.fill = FILL_HEADER; });
  row2.getCell(1).font = FONT_NORMAL; row2.getCell(1).alignment = ALIGN_L; row2.getCell(1).border = { bottom: THIN };
  for (let i = 0; i < N; i++) {
    const cell = row2.getCell(6 + i);
    cell.font = FONT_NORMAL; cell.alignment = ALIGN_L; cell.border = { top: THIN, bottom: THIN }; cell.numFmt = '@';
  }

  // 第3列：欄位標題，每個客戶欄填自己的客戶名稱；E 欄右側細框線是後面所有列的分隔線
  const row3 = ws.addRow(['品項代號', '品項名稱', '規格代號', '規格', '等級'].concat(customersWithData.map(cw => cw.customer.name || '')));
  row3.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = FONT_NORMAL;
    cell.alignment = ALIGN_L;
    cell.border = colNumber === 5 ? { top: THIN, bottom: THIN, right: THIN } : { top: THIN, bottom: THIN };
    if (colNumber <= 5) cell.fill = FILL_HEADER;
  });
  for (let i = 0; i < N; i++) row3.getCell(6 + i).numFmt = '@';

  // 第4列起：忠欣品項主檔全部列出，每個客戶欄各自填自己比對到的單價；E 欄右側細框線貫穿整張表
  const rowValues = masterItems.map(item => {
    const base = [item.itemCode, item.itemName, item.specCode || '', item.unit, item.grade || ''];
    const prices = priceMaps.map(m => { const match = m.get(item.itemCode); return match ? match.price : null; });
    return base.concat(prices);
  });
  const addedRows = ws.addRows(rowValues);
  addedRows.forEach((row, i) => {
    const item = masterItems[i];
    row.getCell(1).font = FONT_NORMAL; row.getCell(1).alignment = ALIGN_R;
    row.getCell(2).font = FONT_NORMAL; row.getCell(2).alignment = ALIGN_L;
    row.getCell(3).font = FONT_NORMAL; row.getCell(3).alignment = ALIGN_L; row.getCell(3).numFmt = '@';
    row.getCell(4).font = FONT_NORMAL; row.getCell(4).alignment = ALIGN_L;
    row.getCell(5).font = FONT_NORMAL; row.getCell(5).alignment = ALIGN_L; row.getCell(5).border = { right: THIN };
    for (let ci = 0; ci < N; ci++) {
      const match = priceMaps[ci].get(item.itemCode);
      const isNew = !!(match && match.isNew);
      const cell = row.getCell(6 + ci);
      cell.numFmt = PRICE_FMT;
      cell.font = isNew ? FONT_NEW : FONT_NORMAL;
      cell.alignment = ALIGN_R;
      if (isNew) cell.fill = FILL_NEW;
    }
  });

  // 比對不到料號的品項：主檔沒有對應列可以填，依客戶分段附加在最後，橘底標示提醒需要補上料號對照表
  customersWithData.forEach((cw, ci) => {
    const unmatched = cw.unmatched || [];
    if (!unmatched.length) return;
    const noteVals = ['', `— ${cw.customer.code} ${cw.customer.name || ''} 以下 ${unmatched.length} 項比對不到忠欣品項代號，請確認 —`, '', '', '']
      .concat(customersWithData.map(() => ''));
    const noteRow = ws.addRow(noteVals);
    noteRow.eachCell({ includeEmpty: true }, cell => { cell.font = { name: FONT_NAME, size: FONT_SIZE, italic: true, color: { argb: 'FFB35400' } }; });
    const rows = unmatched.map(u => {
      const base = ['', u.name || '', '', u.unit || '', ''];
      const prices = customersWithData.map((_, j) => j === ci ? toNumberIfPossible(u.price) : null);
      return base.concat(prices);
    });
    const added = ws.addRows(rows);
    added.forEach(row => {
      row.getCell(6 + ci).numFmt = PRICE_FMT;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = FONT_UNMATCHED;
        cell.alignment = colNumber === (6 + ci) ? ALIGN_R : ALIGN_L;
        if (colNumber === 5) cell.border = { right: THIN };
        cell.fill = FILL_UNMATCHED;
      });
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  const today = new Date();
  const stamp = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
  const outName = N === 1
    ? `${customersWithData[0].customer.code}_${customersWithData[0].customer.name || ''}_報價單匯入_${stamp}.xlsx`
    : `多客戶報價單_${N}家_${stamp}.xlsx`;
  const saved = await saveWorkbookFile(buf, outName);
  return saved ? outName : null;
}


/* ---------------- 統計與表格渲染 ---------------- */
// 三階段分類（取代原本用統計卡做的 全部/已匯出/尚未匯出/尚未設定 篩選）：
// setup=還沒設定欄位對應；pending=格式設好了但這期還沒上傳報價單暫存任何品項；ready=已暫存品項、可以批次匯出
function computeStage(customer) {
  if (!customer.mapping) return 'setup';
  const stagedCount = customer.productCodeMode === '無貨號' ? (customer.quotedPricesCount || 0) : (customer.savedRecordsCount || 0);
  return stagedCount > 0 ? 'ready' : 'pending';
}
const STAGE_DEFS = [
  { key: 'setup', step: '1', title: '待設定匯出格式', sub: '家 · 第一次上傳需設定欄位' },
  { key: 'pending', step: '2', title: '待上傳報價單', sub: '家' },
  { key: 'ready', step: '3', title: '可批次匯出', sub: '家 · 已暫存品項' }
];
// 只有無貨號客戶頁籤才會顯示：這張卡跟上面三張的「格式/上傳/匯出」進度軸是獨立的另一條軸線
// （料號對照表是不是設定好了），同一個客戶完全可能同時出現在這張卡跟上面某張卡裡
const LOOKUP_STAGE_DEF = { key: 'needsLookup', step: '🔗', title: '待設定料號對照表', sub: '家 · 尚未建立客戶品名→忠欣料號對照' };

function renderStageCards() {
  const wantMode = state.activeTab === 'noCode' ? '無貨號' : '有貨號';
  const inTab = state.customers.filter(c => c.productCodeMode === wantMode);
  const counts = { setup: 0, pending: 0, ready: 0 };
  let overdueN = 0;
  let needsLookupN = 0;
  inTab.forEach(c => {
    counts[computeStage(c)]++;
    if (computeDueInfo(c).state === 'overdue') overdueN++;
    if (!(c.itemCodeLookupCount > 0)) needsLookupN++;
  });
  const el = document.getElementById('stageRow');
  if (!el) return;
  let defs = STAGE_DEFS;
  if (wantMode === '無貨號') defs = STAGE_DEFS.concat([LOOKUP_STAGE_DEF]);
  el.innerHTML = defs.map(s => {
    const on = s.key === state.stageFilter;
    const count = s.key === 'needsLookup' ? needsLookupN : counts[s.key];
    const sub = (s.key === 'pending' && overdueN > 0) ? `家 · 其中 ${overdueN} 家已逾期` : s.sub;
    const numFg = s.key === 'pending' ? 'var(--red-bad)' : (s.key === 'ready' ? 'var(--green-ok)' : (s.key === 'needsLookup' ? 'var(--red-bad)' : 'var(--ink-soft)'));
    return `<button class="stage-card${on ? ' active' : ''}" data-stage="${s.key}">
      <div class="stage-top"><span class="stage-chip">${s.step}</span><span class="stage-title">${s.title}</span></div>
      <div style="display:flex;align-items:baseline;gap:9px;margin-top:10px;">
        <span class="stage-num" style="color:${numFg};">${count}</span>
        <span class="hint">${sub}</span>
      </div>
    </button>`;
  }).join('');
}

function filteredCustomers() {
  const kw = state.search.trim().toLowerCase();
  const wantMode = state.activeTab === 'noCode' ? '無貨號' : '有貨號';
  return state.customers.filter(c => {
    if (c.productCodeMode !== wantMode) return false;
    // 有輸入搜尋關鍵字時，讓使用者能跨「階段」直接找到客戶，不受目前選的階段卡片限制；
    // 沒有關鍵字時才照常套用階段篩選
    if (!kw) {
      if (state.stageFilter === 'needsLookup') {
        if (c.itemCodeLookupCount > 0) return false;
      } else if (computeStage(c) !== state.stageFilter) return false;
    }
    if (state.cycleFilter !== 'all' && c.quoteCycle !== state.cycleFilter) return false;
    if (state.unitCategoryFilter && state.unitCategoryFilter !== 'all' && (c.unitCategory || '') !== state.unitCategoryFilter) return false;
    if (kw && !(String(c.code).toLowerCase().includes(kw) || String(c.name).toLowerCase().includes(kw))) return false;
    return true;
  });
}

const STAGE_LIST_META = {
  setup: { stText: '尚未設定格式', stBg: 'var(--red-bad-bg)', stFg: 'var(--red-bad)', actText: '設定匯出格式' },
  pending: { stText: '待上傳報價單', stBg: 'var(--red-bad-bg)', stFg: 'var(--red-bad)', actText: '上傳報價單' },
  ready: { stText: '已上傳 · 可匯出', stBg: 'var(--green-ok-bg)', stFg: 'var(--green-ok)', actText: '重新上傳' }
};

function renderCustomerList() {
  const wantMode = state.activeTab === 'noCode' ? '無貨號' : '有貨號';
  const allInTab = state.customers.filter(c => c.productCodeMode === wantMode);
  const totalInTab = allInTab.length;
  const list = filteredCustomers();
  const empty = document.getElementById('emptyState');
  const head = document.getElementById('custListHead');
  const body = document.getElementById('custListBody');
  const foot = document.getElementById('custListFoot');
  const titles = { setup: '① 待設定匯出格式', pending: '② 待上傳報價單', ready: '③ 可批次匯出', needsLookup: '🔗 待設定料號對照表' };
  const hints = {
    setup: '第一次上傳報價單時設定欄位對應，之後自動套用',
    pending: '格式已設定好，把這期的報價單丟進來就會自動解析',
    ready: '已解析並暫存品項，勾選後合併成一份匯入檔',
    needsLookup: '這些客戶還沒建立「客戶品名 → 忠欣料號」對照表，上傳報價單時會全部比對不到料號'
  };
  document.getElementById('listTitle').textContent = state.search.trim() ? '🔍 搜尋結果' : titles[state.stageFilter];
  document.getElementById('listHint').textContent = state.search.trim() ? '跨所有階段搜尋，不受目前選的階段卡片限制' : hints[state.stageFilter];

  const readyInTab = allInTab.filter(c => computeStage(c) === 'ready');
  const allChecked = readyInTab.length > 0 && readyInTab.every(c => state.selectedCodes.has(c.code));
  head.innerHTML = `
    <span style="width:18px;flex-shrink:0;"><input type="checkbox" id="selectAllCheckbox" title="全選（僅限可匯出的客戶）" ${allChecked ? 'checked' : ''}></span>
    <span style="width:72px;flex-shrink:0;">客戶代號</span>
    <span style="flex:1;min-width:0;">客戶名稱</span>
    <span style="width:150px;flex-shrink:0;">準備狀態</span>
    <span style="width:130px;flex-shrink:0;">到期日</span>
    <span style="width:190px;flex-shrink:0;text-align:right;">下一步</span>`;

  if (!list.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    empty.querySelector('h3').textContent = state.customers.length ? '這個階段目前沒有客戶' : '還沒有客戶資料';
    empty.querySelector('p').textContent = state.customers.length ? '試試調整搜尋、報價週期，或切換其他階段' : '請先「新增客戶」或「批次匯入客戶」建立客戶主檔';
  } else {
    empty.style.display = 'none';
    body.innerHTML = list.map(c => {
      const stage = computeStage(c);
      const m = STAGE_LIST_META[stage];
      const info = computeDueInfo(c);
      const due = stage === 'setup' ? '—' : (info.due ? (info.state === 'overdue' ? '⚠ 已逾期 ' : '到期 ') + formatDateShort(info.due) : '—');
      const dueFg = info.state === 'overdue' ? 'var(--red-bad)' : 'var(--ink-soft)';
      const isActive = c.code === state.activeDetailCode;
      const checked = state.selectedCodes.has(c.code) ? 'checked' : '';
      const noteBadge = c.notes ? `<button class="customer-note" data-act="shownote" data-code="${escapeHtml(c.code)}" style="flex-shrink:0;" title="點擊查看完整備註">備註 : ${escapeHtml(c.notes)}</button>` : '';
      return `<div class="cust-row${isActive ? ' active' : ''}" data-open-code="${escapeHtml(c.code)}">
        <span style="width:18px;flex-shrink:0;" data-stop-row><input type="checkbox" class="rowCheckbox" data-code="${escapeHtml(c.code)}" ${checked} ${stage !== 'ready' ? 'disabled' : ''}></span>
        <span class="mono" style="width:72px;flex-shrink:0;font-size:12.5px;font-weight:700;color:var(--ink);">${escapeHtml(c.code)}</span>
        <span style="flex:1;min-width:0;display:flex;align-items:center;gap:8px;">
          <span style="font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name)}</span>
          ${noteBadge}
        </span>
        <span style="width:150px;flex-shrink:0;"><span class="badge" style="background:${m.stBg};color:${m.stFg};">${m.stText}</span></span>
        <span style="width:130px;flex-shrink:0;font-size:12.5px;font-weight:600;color:${dueFg};">${due}</span>
        <span style="width:190px;flex-shrink:0;display:flex;justify-content:flex-end;">
          <button class="btn small ${stage === 'ready' ? 'btn-secondary' : 'btn-upload'}" data-act="upload" data-code="${escapeHtml(c.code)}" data-stop-row>${m.actText}</button>
        </span>
      </div>`;
    }).join('');
  }
  const stageTotal = state.search.trim()
    ? totalInTab
    : allInTab.filter(c => state.stageFilter === 'needsLookup' ? !(c.itemCodeLookupCount > 0) : computeStage(c) === state.stageFilter).length;
  foot.innerHTML = `<span>顯示 ${list.length} / ${stageTotal} 家（共 ${totalInTab} 家${wantMode}客戶）</span><span class="mono">前端版本 ${FRONTEND_VERSION}</span>`;
  syncSelectAllCheckbox();
}

function renderDetailPanel() {
  const el = document.getElementById('detailCard');
  const customer = state.customers.find(c => c.code === state.activeDetailCode);
  if (!customer) {
    el.innerHTML = `<div class="detail-empty">點左側任一客戶，這裡會顯示他的格式、品項與紀錄</div>`;
    return;
  }
  const stage = computeStage(customer);
  const m = STAGE_LIST_META[stage];
  const info = computeDueInfo(customer);
  const due = info.due ? (info.state === 'overdue' ? '⚠ 已逾期 ' : '到期 ') + formatDateShort(info.due) : '—';
  const dueFg = info.state === 'overdue' ? 'var(--red-bad)' : 'var(--ink-soft)';
  const noCode = customer.productCodeMode === '無貨號';
  const stagedCount = noCode ? (customer.quotedPricesCount || 0) : (customer.savedRecordsCount || 0);
  const noteHtml = customer.notes
    ? `<div style="display:inline-flex;align-items:center;color:#FF524D;font-size:11.5px;font-weight:700;border:1.5px dashed #FF524D;border-radius:999px;padding:4px 11px;margin-top:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">備註 : ${escapeHtml(customer.notes)}</div>`
    : '';
  const lookupCount = customer.itemCodeLookupCount || 0;
  el.innerHTML = `
    <div class="detail-card">
      <div class="detail-head">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
          <div>
            <div class="mono" style="font-size:12.5px;font-weight:700;color:var(--ink-soft);">${escapeHtml(customer.code)}</div>
            <h2 style="margin:3px 0 0;font-size:19px;font-weight:700;">${escapeHtml(customer.name)}</h2>
          </div>
          <button data-act="closedetail" style="width:30px;height:30px;border:none;border-radius:10px;background:var(--paper-100);color:var(--ink-soft);font-size:14px;flex-shrink:0;">✕</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <span class="badge" style="background:${m.stBg};color:${m.stFg};">${m.stText}</span>
          <span style="font-size:12.5px;font-weight:600;color:${dueFg};">${due}</span>
          <span class="hint">· 報價週期 ${escapeHtml(customer.quoteCycle)}${customer.unitCategory ? '（' + escapeHtml(customer.unitCategory) + '）' : ''}</span>
        </div>
        ${noteHtml}
      </div>
      <div class="detail-body">
        <button class="btn ${stage === 'ready' ? 'btn-secondary' : 'btn-upload'}" data-act="upload" data-code="${escapeHtml(customer.code)}" style="width:100%;">${m.actText}</button>
        <div class="detail-grid">
          <div class="detail-grid-cell">
            <div class="hint" style="font-weight:600;">匯出格式</div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;">
              <span class="badge ${customer.mapping ? 'badge-green' : 'badge-red'}">${customer.mapping ? '已設定' : '尚未設定'}</span>
              ${customer.mapping ? `<button class="text-link" data-act="reconfigure" data-code="${escapeHtml(customer.code)}" style="margin:0;padding:2px 4px;">重新設定</button>` : ''}
            </div>
          </div>
          <div class="detail-grid-cell">
            <div class="hint" style="font-weight:600;">最後匯出</div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;">
              <span style="font-size:12.5px;font-weight:700;">${customer.lastExportTime ? formatDateShort(new Date(customer.lastExportTime)) : '—'}</span>
              <button class="text-link" data-act="history" data-code="${escapeHtml(customer.code)}" style="margin:0;padding:2px 4px;">查看紀錄</button>
            </div>
          </div>
          ${noCode ? `
          <div class="detail-grid-cell" style="grid-column:1 / -1;">
            <div class="hint" style="font-weight:600;">料號對照表</div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;">
              <span class="badge ${lookupCount > 0 ? 'badge-green' : 'badge-red'}">${lookupCount > 0 ? `已設定（${lookupCount} 筆）` : '尚未設定'}</span>
              <button class="text-link" data-act="lookup" data-code="${escapeHtml(customer.code)}" style="margin:0;padding:2px 4px;">${lookupCount > 0 ? '管理對照' : '設定'}</button>
            </div>
          </div>` : ''}
          <div class="detail-grid-cell" style="grid-column:1 / -1;">
            <div class="hint" style="font-weight:600;">報價單檔案位置</div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;">
              <span style="font-size:12.5px;color:${customer.quoteFileLocation ? 'var(--ink)' : 'var(--ink-soft)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;" title="${escapeHtml(customer.quoteFileLocation)}">${customer.quoteFileLocation ? escapeHtml(customer.quoteFileLocation) : '尚未填寫'}</span>
              ${customer.quoteFileLocation ? `<button class="text-link" data-act="copyloc" data-code="${escapeHtml(customer.code)}" style="margin:0;padding:2px 4px;flex-shrink:0;">複製</button>` : `<button class="text-link" data-act="edit" data-code="${escapeHtml(customer.code)}" style="margin:0;padding:2px 4px;flex-shrink:0;">填寫</button>`}
            </div>
          </div>
        </div>
        <div>
          <div class="hint" style="font-weight:700;margin-bottom:7px;">本次暫存品項${stagedCount ? `（${stagedCount} 項）` : ''}</div>
          ${stagedCount > 0
            ? `<div style="border:1px solid var(--line);border-radius:12px;padding:12px;font-size:12.5px;color:var(--ink-soft);">已暫存 ${stagedCount} 項，勾選後可在「本期匯出清單」批次匯出成一份檔案。</div>`
            : `<div style="border:1.5px dashed var(--line);border-radius:12px;padding:16px;text-align:center;font-size:12.5px;color:var(--ink-soft);">${customer.mapping ? '這期還沒上傳報價單，上傳後品項會先暫存在這裡。' : '這家客戶還沒設定欄位對應，上傳第一份報價單時設定一次即可。'}</div>`}
        </div>
        <div class="detail-actions">
          <button class="text-link" data-act="edit" data-code="${escapeHtml(customer.code)}">編輯客戶</button>
          <button class="text-link" data-act="history" data-code="${escapeHtml(customer.code)}">匯出紀錄</button>
          <button class="text-link" data-act="unexport" data-code="${escapeHtml(customer.code)}">清除紀錄</button>
          <div style="flex:1;"></div>
          <button class="text-link danger" data-act="delete" data-code="${escapeHtml(customer.code)}">刪除</button>
        </div>
      </div>
    </div>`;
}

function renderExportTray() {
  const wantMode = state.activeTab === 'noCode' ? '無貨號' : '有貨號';
  const trayCustomers = Array.from(state.selectedCodes)
    .map(code => state.customers.find(c => c.code === code))
    .filter(c => c && c.productCodeMode === wantMode);
  const countField = wantMode === '無貨號' ? 'quotedPricesCount' : 'savedRecordsCount';
  document.getElementById('trayCount').textContent = trayCustomers.length;
  const list = document.getElementById('trayList');
  if (!trayCustomers.length) {
    list.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:12.5px;color:var(--ink-soft);">還沒有勾選客戶。在「可批次匯出」清單裡勾選要合併的客戶。</div>`;
  } else {
    list.innerHTML = trayCustomers.map(c => `
      <div class="tray-row">
        <span class="mono" style="width:52px;flex-shrink:0;font-size:11.5px;font-weight:700;">${escapeHtml(c.code)}</span>
        <span style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name)}</span>
        <span class="mono hint" style="flex-shrink:0;">${c[countField] || 0} 項</span>
        <button data-act="untray" data-code="${escapeHtml(c.code)}" style="border:none;background:transparent;color:var(--ink-soft);font-size:13px;flex-shrink:0;">✕</button>
      </div>`).join('');
  }
  const trayItems = trayCustomers.reduce((a, c) => a + (c[countField] || 0), 0);
  document.getElementById('trayItemsTotal').textContent = trayItems + ' 項';
  updateBulkButtonsState();
}

/* ---------------- 頁籤切換（有貨號／無貨號客戶） ---------------- */
document.getElementById('tabRow').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  const tab = btn.getAttribute('data-tab');
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('masterItemsPanel').style.display = tab === 'noCode' ? 'flex' : 'none';
  document.getElementById('btnMasterItemsTop').style.display = tab === 'noCode' ? 'inline-flex' : 'none';
  document.getElementById('unitCategoryFilterSelect').style.display = tab === 'noCode' ? 'inline-block' : 'none';
  // 階段篩選跟頁籤內選取都是「頁籤內」的概念，切頁籤時重置，避免帶著上個頁籤的篩選條件卻找不到東西
  state.stageFilter = 'ready';
  state.cycleFilter = 'all';
  state.unitCategoryFilter = 'all';
  document.getElementById('unitCategoryFilterSelect').value = 'all';
  state.selectedCodes.clear();
  state.activeDetailCode = null;
  renderStageCards();
  renderCustomerList();
  renderDetailPanel();
  renderExportTray();
  if (tab === 'noCode' && !state.masterItems.length) loadMasterItems();
});


// 用單一客戶物件更新本地狀態並重繪，避免每次操作都要整份清單往返
function upsertCustomer(customer) {
  if (!customer) return;
  const idx = state.customers.findIndex(c => c.code === customer.code);
  if (idx === -1) state.customers.push(customer);
  else state.customers[idx] = customer;
  renderStageCards();
  renderCustomerList();
  if (customer.code === state.activeDetailCode) renderDetailPanel();
  renderExportTray();
}

// 客戶清單：按鈕動作（上傳/查看紀錄/備註彈窗）優先判斷；不是按鈕的地方點擊就當作「開啟這列的詳情面板」
document.getElementById('custListBody').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const code = btn.getAttribute('data-code');
    const customer = state.customers.find(c => c.code === code);
    if (!customer) return;
    const act = btn.getAttribute('data-act');
    try {
      if (act === 'upload') openWizard(customer);
      else if (act === 'shownote') openNoteFullText(btn, customer.notes);
    } catch (err) {
      toast('err', '操作失敗，頁面可能不是最新版本，請重新整理或確認部署檔案是否為最新：' + err.message);
    }
    return;
  }
  if (e.target.closest('input')) return; // checkbox 自己的點擊交給下面的 change 監聽處理
  const row = e.target.closest('.cust-row');
  if (!row) return;
  state.activeDetailCode = row.getAttribute('data-open-code');
  renderCustomerList();
  renderDetailPanel();
});

document.getElementById('custListBody').addEventListener('change', e => {
  const cb = e.target.closest('input.rowCheckbox');
  if (!cb) return;
  const code = cb.getAttribute('data-code');
  if (cb.checked) state.selectedCodes.add(code);
  else state.selectedCodes.delete(code);
  updateBulkButtonsState();
  syncSelectAllCheckbox();
  renderExportTray();
});

// 詳情面板裡的動作按鈕：編輯／查看紀錄／清除紀錄／刪除／重新設定欄位對應／料號對照表／關閉
document.getElementById('detailCard').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'closedetail') { state.activeDetailCode = null; renderCustomerList(); renderDetailPanel(); return; }
  const code = btn.getAttribute('data-code');
  const customer = state.customers.find(c => c.code === code);
  if (!customer) return;
  try {
    if (act === 'upload') openWizard(customer);
    else if (act === 'history') openHistoryModal(customer);
    else if (act === 'edit') openCustomerModal(customer);
    else if (act === 'reconfigure') reconfigureMapping(customer);
    else if (act === 'delete') deleteCustomerSingle(customer);
    else if (act === 'lookup') openLookupWizard(customer);
    else if (act === 'unexport') unexportCustomer(customer);
    else if (act === 'copyloc') copyQuoteFileLocation(customer);
  } catch (err) {
    toast('err', '操作失敗，頁面可能不是最新版本，請重新整理或確認部署檔案是否為最新：' + err.message);
  }
});

function copyQuoteFileLocation(customer) {
  const text = customer.quoteFileLocation || '';
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('ok', '已複製報價單檔案位置'),
      () => toast('err', '複製失敗，請手動選取文字複製')
    );
  } else {
    toast('err', '這個瀏覽器不支援自動複製，請手動選取文字複製');
  }
}

// 本期匯出清單裡的 ✕：把這個客戶從勾選清單移除
document.getElementById('trayList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act="untray"]');
  if (!btn) return;
  const code = btn.getAttribute('data-code');
  state.selectedCodes.delete(code);
  renderCustomerList();
  renderExportTray();
});

document.getElementById('btnClearTray').addEventListener('click', () => {
  state.selectedCodes.clear();
  renderCustomerList();
  renderExportTray();
});

document.getElementById('stageRow').addEventListener('click', e => {
  const btn = e.target.closest('.stage-card');
  if (!btn) return;
  state.stageFilter = btn.getAttribute('data-stage');
  renderStageCards();
  renderCustomerList();
});

document.getElementById('cycleFilterSelect').addEventListener('change', e => {
  state.cycleFilter = e.target.value;
  renderCustomerList();
});

document.getElementById('unitCategoryFilterSelect').addEventListener('change', e => {
  state.unitCategoryFilter = e.target.value;
  renderCustomerList();
});

document.getElementById('btnMasterItemsTop').addEventListener('click', () => {
  document.getElementById('btnMasterItems').click();
});

async function unexportCustomer(customer) {
  if (!confirm(`確定要清除 ${customer.code} 的匯出紀錄嗎？清除後將視為「尚未匯出過」，到期日重新計算。`)) return;
  setLoading(true, '更新狀態…');

  try {
    assertSb();
    const { data, error } = await sb.from('customers').update({
      export_status: '未匯出', last_export_time: null, last_export_filename: '', updated_at: new Date().toISOString()
    }).eq('code', customer.code).select().single();
    if (error) throw new Error(error.message);
    upsertCustomer(rowToCustomer(data));
    toast('ok', `已清除 ${customer.code} 的匯出紀錄`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
}

async function reconfigureMapping(customer) {
  if (!confirm(`確定要清除 ${customer.code} 已設定的欄位對應範本嗎？下次上傳時需要重新設定。`)) return;
  setLoading(true, '清除設定中…');
  try {
    assertSb();
    const { data, error } = await sb.from('customers').update({
      mapping: null, updated_at: new Date().toISOString()
    }).eq('code', customer.code).select().single();
    if (error) throw new Error(error.message);
    upsertCustomer(rowToCustomer(data));
    toast('ok', `已清除 ${customer.code} 的欄位對應設定`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
}

async function deleteCustomerSingle(customer) {
  if (!confirm(`確定要刪除客戶 ${customer.code} ${customer.name || ''} 嗎？此操作無法復原，客戶的欄位對應、匯出紀錄都會一併刪除。`)) return;
  setLoading(true, '刪除中…');
  try {
    assertSb();
    const { error } = await sb.from('customers').delete().eq('code', customer.code);
    if (error) throw new Error(error.message);
    state.customers = state.customers.filter(c => c.code !== customer.code);
    state.selectedCodes.delete(customer.code);
    if (state.activeDetailCode === customer.code) state.activeDetailCode = null;
    renderStageCards(); renderCustomerList(); renderDetailPanel(); renderExportTray(); updateBulkButtonsState();
    toast('ok', `已刪除 ${customer.code}`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
}

/* ---------------- 批次選取 ---------------- */
function updateBulkButtonsState() {
  const n = state.selectedCodes.size;
  const editBtn = document.getElementById('btnBatchEdit');
  const delBtn = document.getElementById('btnBatchDelete');
  const exportBtn = document.getElementById('btnBatchExport');
  editBtn.disabled = n === 0;
  delBtn.disabled = n === 0;
  exportBtn.disabled = n === 0;
  editBtn.textContent = n ? `批次修改 (${n})` : '批次修改';
  delBtn.textContent = n ? `批次刪除 (${n})` : '批次刪除';
  exportBtn.textContent = n ? `批次匯出 (${n})` : '批次匯出';
}
function syncSelectAllCheckbox() {
  const selectAll = document.getElementById('selectAllCheckbox');
  if (!selectAll) return;
  const visible = filteredCustomers();
  const visibleCodes = visible.map(c => c.code);
  const allSelected = visibleCodes.length > 0 && visibleCodes.every(code => state.selectedCodes.has(code));
  selectAll.checked = allSelected;
  selectAll.indeterminate = !allSelected && visibleCodes.some(code => state.selectedCodes.has(code));
}
document.getElementById('custListHead').addEventListener('change', e => {
  const cb = e.target.closest('#selectAllCheckbox');
  if (!cb) return;
  const visible = filteredCustomers().filter(c => computeStage(c) === 'ready');
  if (cb.checked) visible.forEach(c => state.selectedCodes.add(c.code));
  else visible.forEach(c => state.selectedCodes.delete(c.code));
  renderCustomerList();
  updateBulkButtonsState();
  renderExportTray();
});

document.getElementById('btnBatchDelete').addEventListener('click', async () => {
  const codes = Array.from(state.selectedCodes);
  if (!codes.length) return;
  if (!confirm(`確定要刪除選取的 ${codes.length} 筆客戶嗎？此操作無法復原，客戶的欄位對應、匯出紀錄都會一併刪除。`)) return;
  setLoading(true, `批次刪除中… (0/${codes.length})`);
  try {
    assertSb();
    const { error } = await sb.from('customers').delete().in('code', codes);
    if (error) throw new Error(error.message);
    state.customers = state.customers.filter(c => !state.selectedCodes.has(c.code));
    if (state.selectedCodes.has(state.activeDetailCode)) state.activeDetailCode = null;
    state.selectedCodes.clear();
    renderStageCards(); renderCustomerList(); renderDetailPanel(); renderExportTray(); updateBulkButtonsState();
    toast('ok', `已刪除 ${codes.length} 筆客戶`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 批次匯出（無貨號客戶：合併成一份多欄檔案） ---------------- */
document.getElementById('btnBatchExport').addEventListener('click', async () => {
  const codes = Array.from(state.selectedCodes);
  if (!codes.length) return;
  const selectedCustomers = codes.map(code => state.customers.find(c => c.code === code)).filter(Boolean);
  const noCode = state.activeTab === 'noCode';
  const countField = noCode ? 'quotedPricesCount' : 'savedRecordsCount';
  const ready = selectedCustomers.filter(c => (c[countField] || 0) > 0);
  const notReady = selectedCustomers.filter(c => !(c[countField] > 0));
  if (!ready.length) { toast('err', '選取的客戶都還沒有「上傳報價單」儲存過資料，沒有東西可以匯出'); return; }
  if (notReady.length && !confirm(`選取的 ${selectedCustomers.length} 筆客戶中，有 ${notReady.length} 筆還沒上傳過報價單（${notReady.map(c => c.code).join('、')}），會被跳過不列入這次匯出。要繼續嗎？`)) return;
  // 無貨號客戶的報價單位（kg／台斤）不一樣時，混在同一份合併檔案裡數字會誤導人，所以擋下來、
  // 請使用者分開匯出；只有 kg 跟台斤兩者都出現才算衝突，未設定單位的客戶不強制擋
  if (noCode) {
    const cats = new Set(ready.map(c => c.unitCategory).filter(v => v === 'kg' || v === '台斤'));
    if (cats.size > 1) {
      toast('err', `選取的客戶裡同時有 kg 跟台斤兩種單位（${ready.filter(c => c.unitCategory === 'kg' || c.unitCategory === '台斤').map(c => `${c.code}:${c.unitCategory}`).join('、')}），報價單位不同不能合併匯出，請用上方「單位」篩選分開匯出`);
      return;
    }
  }

  setLoading(true, '準備匯出元件…');
  try {
    await ensureExcelJS();
    let outName;
    if (noCode) {
      if (!state.masterItems.length) await loadMasterItems();
      const customersWithData = [];
      for (let i = 0; i < ready.length; i++) {
        const c = ready[i];
        setLoading(true, `讀取已儲存的報價資料…（${i + 1}/${ready.length}：${c.code}）`, (i + 1) / ready.length);
        const prices = await fetchQuotedPrices(c.code);
        customersWithData.push({ customer: c, matched: prices.matched, unmatched: prices.unmatched });
      }
      setLoading(true, '產生合併匯出檔案…');
      outName = await exportNoCodeBatchWorkbook(customersWithData, state.masterItems);
    } else {
      const customersWithRecords = [];
      for (let i = 0; i < ready.length; i++) {
        const c = ready[i];
        setLoading(true, `讀取已儲存的報價資料…（${i + 1}/${ready.length}：${c.code}）`, (i + 1) / ready.length);
        const records = await fetchSavedRecords(c.code);
        customersWithRecords.push({ customer: c, records });
      }
      setLoading(true, '產生合併匯出檔案…');
      outName = await exportBatchWorkbook(customersWithRecords);
    }

    if (!outName) {
      // 使用者在「另存新檔」視窗按了取消：不算失敗，但也不要標記已匯出（檔案根本沒存下來）
      toast('ok', '已取消儲存，客戶的匯出狀態沒有變動');
      return;
    }

    setLoading(true, '更新匯出狀態…');
    const nowIso = new Date().toISOString();
    const readyCodes = ready.map(c => c.code);
    const { data, error } = await sb.from('customers').update({
      export_status: '已匯出', last_export_time: nowIso, last_export_filename: outName, updated_at: nowIso
    }).in('code', readyCodes).select(CUSTOMER_SELECT_COLS);
    if (error) throw new Error(error.message);
    (data || []).forEach(row => upsertCustomer(rowToCustomer(row)));
    state.selectedCodes.clear();
    renderCustomerList(); renderExportTray(); updateBulkButtonsState();
    toast('ok', `已匯出 ${ready.length} 家客戶的合併報價單`);
  } catch (err) {
    toast('err', '批次匯出失敗：' + err.message);
  } finally {
    setLoading(false);
  }
});

/* ---------------- 批次修改 ---------------- */
function wireBatchEditCheckbox(checkboxId, selectId) {
  const cb = document.getElementById(checkboxId);
  const sel = document.getElementById(selectId);
  cb.addEventListener('change', () => { sel.disabled = !cb.checked; });
}
wireBatchEditCheckbox('beApplyMode', 'beMode');
wireBatchEditCheckbox('beApplyCycle', 'beCycle');
wireBatchEditCheckbox('beApplyStatus', 'beStatus');

document.getElementById('btnBatchEdit').addEventListener('click', () => {
  if (!state.selectedCodes.size) return;
  document.getElementById('batchEditSub').textContent = `已選擇 ${state.selectedCodes.size} 筆客戶`;
  ['beApplyMode', 'beApplyCycle', 'beApplyStatus'].forEach(id => { document.getElementById(id).checked = false; });
  ['beMode', 'beCycle', 'beStatus'].forEach(id => { document.getElementById(id).disabled = true; });
  openModal('ovBatchEdit');
});

document.getElementById('btnConfirmBatchEdit').addEventListener('click', async () => {
  const codes = Array.from(state.selectedCodes);
  if (!codes.length) return;
  const applyMode = document.getElementById('beApplyMode').checked;
  const applyCycle = document.getElementById('beApplyCycle').checked;
  const applyStatus = document.getElementById('beApplyStatus').checked;
  if (!applyMode && !applyCycle && !applyStatus) { toast('err', '請至少勾選一個要修改的欄位'); return; }
  const patch = { updated_at: new Date().toISOString() };
  if (applyMode) patch.product_code_mode = document.getElementById('beMode').value;
  if (applyCycle) patch.quote_cycle = document.getElementById('beCycle').value;
  if (applyStatus) {
    const status = document.getElementById('beStatus').value;
    patch.export_status = status;
    // 批次修改沒有個別客戶原本的實際匯出時間可用，「已匯出」就用現在時間起算到期日，
    // 跟批次匯入客戶是同樣的取捨
    patch.last_export_time = status === '已匯出' ? new Date().toISOString() : null;
    if (status !== '已匯出') patch.last_export_filename = '';
  }
  setLoading(true, `批次修改中…（${codes.length} 筆）`);
  try {
    assertSb();
    const { data, error } = await sb.from('customers').update(patch).in('code', codes)
      .select(CUSTOMER_SELECT_COLS);
    if (error) throw new Error(error.message);
    (data || []).forEach(row => upsertCustomer(rowToCustomer(row)));
    closeModal('ovBatchEdit');
    toast('ok', `已修改 ${codes.length} 筆客戶`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 查看紀錄 Modal ---------------- */
function openHistoryModal(customer) {
  const info = computeDueInfo(customer);
  const rows = [
    ['客戶代號', customer.code],
    ['客戶名稱', customer.name || '—'],
    ['備註', customer.notes || '—'],
    ['報價單檔案位置', customer.quoteFileLocation || '—'],
    ['報價種類', customer.productCodeMode],
    ['報價週期', customer.quoteCycle],
    ['匯出格式', customer.mapping ? '已設定' : '尚未設定'],
    ['匯出狀態', info.state === 'active' ? '已匯出' : '尚未匯出'],
    ['最後匯出時間', customer.lastExportTime || '—'],
    ['最後匯出檔名', customer.lastExportFileName || '—'],
    ['最後匯出品項數', customer.lastExportItemCount || 0],
    ['到期日', info.due ? formatDateShort(info.due) : '—']
  ];
  if (customer.productCodeMode === '無貨號') {
    rows.splice(5, 0,
      ['單位分類', customer.unitCategory || '未設定'],
      ['料號對照表', customer.itemCodeLookupCount ? `已設定（${customer.itemCodeLookupCount} 筆）` : '尚未設定'],
      ['已儲存報價（待批次匯出）', customer.quotedPricesCount ? `${customer.quotedPricesCount} 筆` : '尚未上傳'],
      ['最後上傳報價時間', customer.lastQuoteUploadTime || '—']
    );
  }
  document.getElementById('historyTitle').textContent = `匯出紀錄－${customer.code} ${customer.name || ''}`;
  document.getElementById('historyTable').innerHTML = rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  openModal('ovHistory');
}

/* ---------------- 忠欣品項主檔：上傳/更新 ---------------- */
let masterItemsParsed = [];
document.getElementById('btnMasterItems').addEventListener('click', async () => {
  ensureXLSX();
  masterItemsParsed = [];
  document.getElementById('masterItemsPreviewWrap').style.display = 'none';
  document.getElementById('masterItemsFileInput').value = '';
  document.getElementById('btnConfirmMasterItems').disabled = true;
  openModal('ovMasterItems');
  // 確保目前的主檔資料已經載入，之後上傳沒有「規格代號」欄位的檔案時才能正確沿用舊值，不會被空白蓋掉
  if (!state.masterItems.length) { setLoading(true, '載入目前的忠欣品項主檔…'); await loadMasterItems(); setLoading(false); }
});
setupDropzone('masterItemsDropzone', 'masterItemsFileInput', async file => {
  try {
    const { rows } = await readWorkbookRaw(file);
    if (!rows.length) { toast('err', '檔案沒有資料'); return; }
    // 標題列不一定在第一列（例如直接拿「多客戶報價單格式」匯出檔當來源，標題其實在第3列），
    // 掃描前20列找出真正符合「品項代號＋品項名稱」的那一列，找不到才退回用第一列
    const idPattern = /品項代號|料號|品號|產品編號/;
    const namePattern = /品項名稱|品名|名稱/;
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(20, rows.length); i++) {
      const line = (rows[i] || []).map(h => String(h || '').trim());
      if (line.some(h => idPattern.test(h)) && line.some(h => namePattern.test(h))) { headerRowIdx = i; break; }
    }
    const headerRow = rows[headerRowIdx].map(h => String(h || '').trim());
    const codeIdx = headerRow.findIndex(h => idPattern.test(h));
    const nameIdx = headerRow.findIndex(h => namePattern.test(h));
    const specCodeIdx = headerRow.findIndex(h => /規格代號/.test(h));
    const unitIdx = headerRow.findIndex((h, idx) => idx !== specCodeIdx && /規格|單位/.test(h));
    const gradeIdx = headerRow.findIndex(h => /等級/.test(h));
    if (codeIdx === -1 || nameIdx === -1) { toast('err', '找不到「品項代號」或「品項名稱」欄位，請確認檔案裡有標題列'); return; }
    // 檔案完全沒有「規格代號」欄位時（例如只是要更新名稱/單位的簡化版清單），不能整欄蓋成空白，
    // 那樣會把先前手動填好的規格代號全部洗掉；改成先讀出資料庫現有的值，比對到的品項沿用舊值
    let existingSpecCodeMap = new Map();
    if (specCodeIdx === -1 && state.masterItems.length) {
      existingSpecCodeMap = new Map(state.masterItems.map(m => [m.itemCode, m.specCode || '']));
    }
    masterItemsParsed = [];
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const itemCode = String(rows[i][codeIdx] || '').trim();
      if (!itemCode) continue;
      masterItemsParsed.push({
        itemCode,
        itemName: String(rows[i][nameIdx] || '').trim(),
        unit: unitIdx > -1 ? String(rows[i][unitIdx] || '').trim() : '',
        specCode: specCodeIdx > -1 ? String(rows[i][specCodeIdx] || '').trim() : (existingSpecCodeMap.get(itemCode) || ''),
        grade: gradeIdx > -1 ? String(rows[i][gradeIdx] || '').trim() : ''
      });
    }
    document.getElementById('masterItemsSummary').textContent = `辨識到 ${masterItemsParsed.length} 筆品項，確認後會整份取代目前的忠欣品項主檔` +
      (specCodeIdx === -1 ? '（這份檔案沒有「規格代號」欄位，比對得到的品項會沿用資料庫現有的規格代號，比對不到的才會留空）' : '');
    const table = document.getElementById('masterItemsPreviewTable');
    table.innerHTML = '<thead><tr><th>品項代號</th><th>品項名稱</th><th>規格代號</th><th>規格</th><th>等級</th></tr></thead><tbody>' +
      masterItemsParsed.slice(0, 200).map(m => `<tr><td class="mono">${escapeHtml(m.itemCode)}</td><td>${escapeHtml(m.itemName)}</td><td class="mono">${escapeHtml(m.specCode)}</td><td>${escapeHtml(m.unit)}</td><td>${escapeHtml(m.grade)}</td></tr>`).join('') +
      '</tbody>';
    document.getElementById('masterItemsPreviewWrap').style.display = 'block';
    document.getElementById('btnConfirmMasterItems').disabled = masterItemsParsed.length === 0;
  } catch (err) { toast('err', '解析失敗：' + err.message); }
});
document.getElementById('btnConfirmMasterItems').addEventListener('click', async () => {
  if (!masterItemsParsed.length) return;
  setLoading(true, '寫入忠欣品項主檔中…');
  try {
    await saveMasterItems(masterItemsParsed);
    closeModal('ovMasterItems');
    toast('ok', `已更新忠欣品項主檔，共 ${masterItemsParsed.length} 筆`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 客戶料號對照表：上傳（每個無貨號客戶各自一份） ---------------- */
let lookupParsed = [];
let lookupTargetCustomer = null;
let lookupExistingEntries = [];
let editingLookupOriginalName = null; // 正在編輯哪一筆既有對照（用原本的客戶品項名稱識別），null 代表現在是「新增」模式

function populateMasterItemsDatalist() {
  const dl = document.getElementById('masterItemsDatalist');
  if (!dl) return;
  dl.innerHTML = state.masterItems.map(m => `<option value="${escapeHtml(m.itemCode)}">${escapeHtml(m.itemCode)} － ${escapeHtml(m.itemName)}</option>`).join('');
}

function renderLookupExistingTable() {
  document.getElementById('lookupExistingSummary').textContent = `目前已設定 ${lookupExistingEntries.length} 筆對照`;
  const table = document.getElementById('lookupExistingTable');
  if (!lookupExistingEntries.length) {
    table.innerHTML = '<tbody><tr><td class="hint" style="padding:10px;">還沒有任何對照，請用上面的表單新增，或用下面整批上傳</td></tr></tbody>';
    return;
  }
  table.innerHTML = '<thead><tr><th>客戶品項名稱</th><th>忠欣品項名稱</th><th>忠欣料號</th><th></th></tr></thead><tbody>' +
    lookupExistingEntries.map(x => `<tr>
      <td>${escapeHtml(x.name)}</td>
      <td>${escapeHtml(x.itemName || '')}</td>
      <td class="mono">${escapeHtml(x.code)}</td>
      <td style="white-space:nowrap;">
        <button class="text-link" data-act="editlookup" data-name="${escapeHtml(x.name)}">編輯</button>
        <button class="text-link danger" data-act="deletelookup" data-name="${escapeHtml(x.name)}">刪除</button>
      </td>
    </tr>`).join('') +
    '</tbody>';
}

function setLookupEditMode(entry) {
  editingLookupOriginalName = entry ? entry.name : null;
  document.getElementById('lookupFormLabel').textContent = entry ? `編輯對照－ ${entry.name}` : '新增單筆對照';
  document.getElementById('newLookupCustName').value = entry ? entry.name : '';
  document.getElementById('newLookupItemCode').value = entry ? entry.code : '';
  document.getElementById('newLookupItemName').value = entry ? (entry.itemName || '') : '';
  document.getElementById('btnAddLookupEntry').textContent = entry ? '儲存修改' : '新增';
  document.getElementById('btnCancelEditLookupEntry').style.display = entry ? 'inline-flex' : 'none';
}

document.getElementById('lookupExistingTable').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !lookupTargetCustomer) return;
  const name = btn.getAttribute('data-name');
  const entry = lookupExistingEntries.find(x => x.name === name);
  if (!entry) return;
  const act = btn.getAttribute('data-act');
  if (act === 'editlookup') {
    setLookupEditMode(entry);
    document.getElementById('newLookupCustName').focus();
  } else if (act === 'deletelookup') {
    if (!confirm(`確定要刪除「${name}」這筆對照嗎？`)) return;
    setLoading(true, '刪除對照中…');
    try {
      lookupExistingEntries = lookupExistingEntries.filter(x => x.name !== name);
      const customer = await saveItemCodeLookup(lookupTargetCustomer.code, lookupExistingEntries);
      upsertCustomer(customer);
      lookupTargetCustomer = customer;
      renderLookupExistingTable();
      if (editingLookupOriginalName === name) setLookupEditMode(null);
      toast('ok', `已刪除「${name}」`);
    } catch (err) { toast('err', err.message); }
    finally { setLoading(false); }
  }
});

document.getElementById('btnCancelEditLookupEntry').addEventListener('click', () => setLookupEditMode(null));

async function openLookupWizard(customer) {
  lookupTargetCustomer = customer;
  lookupParsed = [];
  document.getElementById('lookupTitle').textContent = `料號對照表 － ${customer.code} ${customer.name || ''}`;
  document.getElementById('lookupPreviewWrap').style.display = 'none';
  document.getElementById('lookupFileInput').value = '';
  document.getElementById('btnConfirmLookup').disabled = true;
  setLookupEditMode(null);
  ensureXLSX();
  openModal('ovLookup');
  setLoading(true, '載入現有對照與忠欣品項主檔…');
  try {
    if (!state.masterItems.length) await loadMasterItems();
    populateMasterItemsDatalist();
    lookupExistingEntries = await fetchItemCodeLookup(customer.code);
    renderLookupExistingTable();
  } finally {
    setLoading(false);
  }
}

// 忠欣料號打出來就自動在忠欣品項主檔查，找到就帶入官方品項名稱；找不到就清空提示
document.getElementById('newLookupItemCode').addEventListener('input', e => {
  const code = e.target.value.trim();
  const match = state.masterItems.find(m => m.itemCode === code);
  document.getElementById('newLookupItemName').value = match ? match.itemName : '';
});

document.getElementById('btnAddLookupEntry').addEventListener('click', async () => {
  if (!lookupTargetCustomer) return;
  const name = document.getElementById('newLookupCustName').value.trim();
  const code = document.getElementById('newLookupItemCode').value.trim();
  const match = state.masterItems.find(m => m.itemCode === code);
  if (!name) { toast('err', '請輸入客戶品項名稱'); return; }
  if (!code || !match) { toast('err', '忠欣料號找不到對應的品項，請確認輸入或從清單選擇'); return; }
  setLoading(true, editingLookupOriginalName ? '儲存修改中…' : '新增對照中…');
  try {
    const entry = { name, code, itemName: match.itemName };
    // 編輯模式下，如果客戶品項名稱被改掉了，要先把原本那筆（用舊名稱找）移除，
    // 不然會變成留著一筆舊名稱的沒用到，另外多一筆新名稱的，等於複製了一筆而不是修改
    if (editingLookupOriginalName && editingLookupOriginalName !== name) {
      lookupExistingEntries = lookupExistingEntries.filter(x => x.name !== editingLookupOriginalName);
    }
    // 用「客戶品項名稱」當key：已存在就更新，否則新增一筆，不會動到其他既有對照
    const idx = lookupExistingEntries.findIndex(x => x.name === name);
    if (idx > -1) lookupExistingEntries[idx] = entry;
    else lookupExistingEntries.push(entry);
    const customer = await saveItemCodeLookup(lookupTargetCustomer.code, lookupExistingEntries);
    upsertCustomer(customer);
    lookupTargetCustomer = customer;
    renderLookupExistingTable();
    const wasEditing = !!editingLookupOriginalName;
    setLookupEditMode(null);
    toast('ok', wasEditing ? `已更新「${name}」對照到 ${match.itemCode}` : `已新增「${name}」對照到 ${match.itemCode}`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

setupDropzone('lookupDropzone', 'lookupFileInput', async file => {
  try {
    const { rows } = await readWorkbookRaw(file);
    if (!rows.length) { toast('err', '檔案沒有資料'); return; }
    const headerRow = rows[0].map(h => String(h || '').trim());
    const custNameIdx = headerRow.findIndex(h => h.includes('客戶') && /品名|名稱/.test(h));
    const officialNameIdx = headerRow.findIndex(h => h.includes('忠欣') && /品名|名稱/.test(h));
    const codeIdx = headerRow.findIndex(h => /料號|貨號|品號/.test(h));
    if (custNameIdx === -1 || codeIdx === -1) { toast('err', '找不到「客戶品項名稱」或「忠欣料號」欄位，請確認第一列是標題列'); return; }
    lookupParsed = [];
    for (let i = 1; i < rows.length; i++) {
      const name = String(rows[i][custNameIdx] || '').trim();
      const itemCode = String(rows[i][codeIdx] || '').trim();
      if (!name || !itemCode) continue;
      const itemName = officialNameIdx > -1 ? String(rows[i][officialNameIdx] || '').trim() : '';
      lookupParsed.push({ name, code: itemCode, itemName });
    }
    document.getElementById('lookupSummary').textContent = `辨識到 ${lookupParsed.length} 筆對應，確認後會整份取代這個客戶目前的料號對照表` +
      (officialNameIdx === -1 ? '（沒有找到「忠欣品項名稱」欄位，這欄留空不影響比對）' : '');
    const table = document.getElementById('lookupPreviewTable');
    table.innerHTML = '<thead><tr><th>客戶品項名稱</th><th>忠欣品項名稱</th><th>忠欣料號</th></tr></thead><tbody>' +
      lookupParsed.slice(0, 200).map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.itemName)}</td><td class="mono">${escapeHtml(x.code)}</td></tr>`).join('') +
      '</tbody>';
    document.getElementById('lookupPreviewWrap').style.display = 'block';
    document.getElementById('btnConfirmLookup').disabled = lookupParsed.length === 0;
  } catch (err) { toast('err', '解析失敗：' + err.message); }
});
document.getElementById('btnConfirmLookup').addEventListener('click', async () => {
  if (!lookupParsed.length || !lookupTargetCustomer) return;
  if (!confirm(`確定要用這 ${lookupParsed.length} 筆整批取代 ${lookupTargetCustomer.code} 目前的料號對照表嗎？現有的對照會被覆蓋掉。`)) return;
  setLoading(true, '寫入料號對照表中…');
  try {
    const customer = await saveItemCodeLookup(lookupTargetCustomer.code, lookupParsed);
    upsertCustomer(customer);
    lookupTargetCustomer = customer;
    lookupExistingEntries = lookupParsed;
    renderLookupExistingTable();
    lookupParsed = [];
    document.getElementById('lookupPreviewWrap').style.display = 'none';
    document.getElementById('lookupFileInput').value = '';
    document.getElementById('btnConfirmLookup').disabled = true;
    toast('ok', `已更新 ${customer.code} 的料號對照表，共 ${customer.itemCodeLookupCount || 0} 筆`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 篩選列（搜尋 / 報價週期） ---------------- */
document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value; renderCustomerList(); syncSelectAllCheckbox();
});

// 備註全文彈出視窗：備註太長時，點擊徽章看完整內容
const noteFullTextEl = document.getElementById('noteFullTextPopover');
function openNoteFullText(btn, text) {
  noteFullTextEl.textContent = text || '';
  noteFullTextEl.style.display = 'block';
  const rect = btn.getBoundingClientRect();
  const boxRect = noteFullTextEl.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + boxRect.height > window.innerHeight) top = rect.top - boxRect.height - 6;
  let left = rect.left;
  if (left + boxRect.width > window.innerWidth - 8) left = window.innerWidth - boxRect.width - 8;
  if (left < 8) left = 8;
  noteFullTextEl.style.top = top + 'px';
  noteFullTextEl.style.left = left + 'px';
}
function closeNoteFullText() { noteFullTextEl.style.display = 'none'; }
document.addEventListener('click', e => {
  if (e.target.closest('#noteFullTextPopover') || e.target.closest('[data-act="shownote"]')) return;
  closeNoteFullText();
});

document.getElementById('btnResetAll').addEventListener('click', async () => {
  if (!confirm('確定要清除「全部」客戶的匯出紀錄嗎？清除後全部客戶會變成「尚未匯出過」，到期日重新計算。')) return;
  setLoading(true, '重置中…');
  try {
    assertSb();
    const { data, error } = await sb.from('customers').update({
      export_status: '未匯出', last_export_time: null, last_export_filename: '', updated_at: new Date().toISOString()
    }).not('code', 'is', null).select();
    if (error) throw new Error(error.message);
    state.customers = (data || []).map(rowToCustomer);
    renderStageCards(); renderCustomerList(); renderDetailPanel(); renderExportTray();
    toast('ok', '已清除全部客戶的匯出紀錄');
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 新增/編輯客戶 Modal ---------------- */
let editingCode = null;
function openCustomerModal(customer) {
  editingCode = customer ? customer.code : null;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; else console.warn('找不到欄位 #' + id + '，頁面可能不是最新版本'); };
  document.getElementById('custModalTitle').textContent = customer ? '編輯客戶' : '新增客戶';
  setVal('custCode', customer ? customer.code : '');
  document.getElementById('custCode').disabled = !!customer;
  setVal('custName', customer ? customer.name : '');
  setVal('custProductCodeMode', customer ? customer.productCodeMode : '有貨號');
  setVal('custQuoteCycle', customer ? customer.quoteCycle : '7天');
  setVal('custExportStatus', customer ? (customer.exportStatus === '已匯出' ? '已匯出' : '未匯出') : '未匯出');
  setVal('custUnitCategory', customer ? (customer.unitCategory || '') : '');
  setVal('custNotes', customer ? (customer.notes || '') : '');
  setVal('custQuoteFileLocation', customer ? (customer.quoteFileLocation || '') : '');
  toggleUnitCategoryField();
  openModal('ovCustomer');
}
function toggleUnitCategoryField() {
  const modeSel = document.getElementById('custProductCodeMode');
  const field = document.getElementById('custUnitCategoryField');
  if (modeSel && field) field.style.display = modeSel.value === '無貨號' ? 'block' : 'none';
}
document.getElementById('custProductCodeMode').addEventListener('change', toggleUnitCategoryField);
document.getElementById('btnAddCustomer').addEventListener('click', () => openCustomerModal(null));

// 新增/編輯客戶寫入邏輯：只有「匯出狀態」真的有變動時才動到 last_export_time，
// 避免只是改個名字之類的無關編輯，卻不小心把到期日重新起算。
async function saveCustomerToBackend(payload) {
  assertSb();
  const { data: existing, error: selErr } = await sb.from('customers').select('export_status').eq('code', payload.code).maybeSingle();
  if (selErr) throw new Error(selErr.message);
  const desired = payload.exportStatus === '已匯出' ? '已匯出' : '未匯出';
  const nowIso = new Date().toISOString();

  const upsertRow = {
    code: payload.code,
    name: payload.name || '',
    product_code_mode: payload.productCodeMode === '無貨號' ? '無貨號' : '有貨號',
    quote_cycle: ['7天', '10天', '15天', '30天'].includes(payload.quoteCycle) ? payload.quoteCycle : '7天',
    unit_category: ['kg', '台斤'].includes(payload.unitCategory) ? payload.unitCategory : '',
    notes: payload.notes || '',
    quote_file_location: payload.quoteFileLocation || '',
    updated_at: nowIso
  };
  if (!existing) {
    upsertRow.export_status = desired;
    upsertRow.last_export_time = desired === '已匯出' ? nowIso : null;
  } else if (desired !== (existing.export_status || '未匯出')) {
    upsertRow.export_status = desired;
    if (desired === '已匯出') {
      upsertRow.last_export_time = nowIso;
    } else {
      upsertRow.last_export_time = null;
      upsertRow.last_export_filename = '';
    }
  }
  const { data, error } = await sb.from('customers').upsert(upsertRow, { onConflict: 'code' }).select().single();
  if (error) throw new Error(error.message);
  return rowToCustomer(data);
}

document.getElementById('btnSaveCustomer').addEventListener('click', async () => {
  const code = document.getElementById('custCode').value.trim();
  const name = document.getElementById('custName').value.trim();
  if (!code) { toast('err', '請輸入客戶代號'); return; }
  setLoading(true, '儲存中…');
  try {
    const customer = await saveCustomerToBackend({
      code, name,
      productCodeMode: document.getElementById('custProductCodeMode').value,
      quoteCycle: document.getElementById('custQuoteCycle').value,
      exportStatus: document.getElementById('custExportStatus').value,
      unitCategory: document.getElementById('custUnitCategory').value,
      notes: document.getElementById('custNotes').value.trim(),
      quoteFileLocation: document.getElementById('custQuoteFileLocation').value.trim()
    });
    upsertCustomer(customer);
    closeModal('ovCustomer');
    toast('ok', '客戶資料已儲存');
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 批次匯入客戶 Modal ---------------- */
let batchParsed = [];
function setupDropzone(zoneId, inputId, onFile) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); });
  ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
}
function setupMultiDropzone(zoneId, inputId, onFiles) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files.length) onFiles(Array.from(input.files)); });
  ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e => { const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (files.length) onFiles(files); });
}
// 純拖曳版本（不綁點擊開檔案，因為批次匯入報價單改用兩個明確按鈕分別觸發「選檔案」跟「選資料夾」）
function setupDropOnly(zoneId, onFiles) {
  const zone = document.getElementById(zoneId);
  ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e => { const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (files.length) onFiles(files); });
}

setupDropzone('batchDropzone', 'batchFileInput', async file => {
  try {
    const { rows } = await readWorkbookRaw(file);
    if (!rows.length) { toast('err', '檔案沒有資料'); return; }
    const headerRow = rows[0].map(h => String(h || '').trim());
    const codeIdx = headerRow.findIndex(h => h.includes('客戶代號') || h.includes('代號'));
    const nameIdx = headerRow.findIndex(h => h.includes('客戶名稱') || h.includes('名稱'));
    const modeIdx = headerRow.findIndex(h => h.includes('報價種類') || h.includes('種類'));
    const cycleIdx = headerRow.findIndex(h => h.includes('報價週期') || h.includes('週期'));
    const statusIdx = headerRow.findIndex(h => h.includes('匯出狀態'));
    if (codeIdx === -1) { toast('err', '找不到「客戶代號」欄位，請確認第一列為標題列'); return; }
    batchParsed = [];
    for (let i = 1; i < rows.length; i++) {
      const code = String(rows[i][codeIdx] || '').trim();
      if (!code) continue;
      const name = nameIdx > -1 ? String(rows[i][nameIdx] || '').trim() : '';
      const modeRaw = modeIdx > -1 ? String(rows[i][modeIdx] || '').trim() : '';
      const cycleRaw = cycleIdx > -1 ? String(rows[i][cycleIdx] || '').trim() : '';
      const statusRaw = statusIdx > -1 ? String(rows[i][statusIdx] || '').trim() : '';
      const productCodeMode = modeRaw === '無貨號' ? '無貨號' : '有貨號';
      const quoteCycle = ['7天', '10天', '15天', '30天'].includes(cycleRaw) ? cycleRaw : '7天';
      const exportStatus = statusRaw === '已匯出' ? '已匯出' : '未匯出'; // 「尚未匯出」「未匯出」或空白都視為未匯出
      batchParsed.push({ code, name, productCodeMode, quoteCycle, exportStatus });
    }
    document.getElementById('batchSummary').textContent = `辨識到 ${batchParsed.length} 筆客戶資料，確認後將新增或更新客戶主檔` +
      (modeIdx === -1 || cycleIdx === -1 || statusIdx === -1 ? '（檔案缺少部分欄位，缺的部分會用預設值：有貨號／7天／尚未匯出）' : '');
    const table = document.getElementById('batchPreviewTable');
    table.innerHTML = '<thead><tr><th>客戶代號</th><th>客戶名稱</th><th>報價種類</th><th>報價週期</th><th>匯出狀態</th></tr></thead><tbody>' +
      batchParsed.slice(0, 200).map(c => `<tr><td class="mono">${escapeHtml(c.code)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.productCodeMode)}</td><td>${escapeHtml(c.quoteCycle)}</td><td>${escapeHtml(c.exportStatus === '已匯出' ? '已匯出' : '尚未匯出')}</td></tr>`).join('') +
      '</tbody>';
    document.getElementById('batchPreviewWrap').style.display = 'block';
    document.getElementById('btnConfirmBatch').disabled = batchParsed.length === 0;
  } catch (err) { toast('err', '解析失敗：' + err.message); }
});

document.getElementById('btnBatchImport').addEventListener('click', () => {
  ensureXLSX();
  batchParsed = [];
  document.getElementById('batchPreviewWrap').style.display = 'none';
  document.getElementById('batchFileInput').value = '';
  document.getElementById('btnConfirmBatch').disabled = true;
  openModal('ovBatch');
});

document.getElementById('btnConfirmBatch').addEventListener('click', async () => {
  if (!batchParsed.length) return;
  setLoading(true, '匯入客戶中…');
  try {
    assertSb();
    const nowIso = new Date().toISOString();
    // Postgres 的 upsert 沒有 GAS 網址長度那種限制，可以一次送一大批；
    // 這裡仍保留適度分批（300 筆一批）純粹是避免單次請求過大，不是為了繞過什麼限制。
    const CHUNK = 300;
    const allRows = [];
    for (let i = 0; i < batchParsed.length; i += CHUNK) {
      const chunk = batchParsed.slice(i, i + CHUNK);
      setLoading(true, `匯入客戶中… (${Math.min(i + CHUNK, batchParsed.length)}/${batchParsed.length})`);
      const payload = chunk.map(c => ({
        code: c.code,
        name: c.name,
        product_code_mode: c.productCodeMode,
        quote_cycle: c.quoteCycle,
        export_status: c.exportStatus,
        // 檔案沒有實際匯出時間可用，「已匯出」就用現在時間起算到期日；重複匯入同一批已匯出的客戶
        // 會讓到期日重新起算，這是這個批次匯入工具的已知取捨（主要設計給初次建立客戶清單用）
        last_export_time: c.exportStatus === '已匯出' ? nowIso : null,
        updated_at: nowIso
      }));
      const { data, error } = await sb.from('customers').upsert(payload, { onConflict: 'code' }).select(CUSTOMER_SELECT_COLS);
      if (error) throw new Error(error.message);
      allRows.push(...(data || []));
    }
    allRows.forEach(row => upsertCustomer(rowToCustomer(row)));
    closeModal('ovBatch');
    toast('ok', `已匯入 ${batchParsed.length} 筆客戶資料`);
  } catch (err) { toast('err', err.message); }
  finally { setLoading(false); }
});

/* ---------------- 批次匯入報價單（依檔名比對客戶） ---------------- */
let batchQuotesFiles = [];
function matchCustomersByFilename(filename) {
  const configured = state.customers.filter(c => c.mapping);
  const lower = filename.toLowerCase();
  return configured.filter(c => {
    const codeHit = c.code && lower.includes(String(c.code).toLowerCase());
    const nameHit = c.name && c.name.trim() && lower.includes(c.name.trim().toLowerCase());
    return codeHit || nameHit;
  });
}

document.getElementById('btnBatchQuotes').addEventListener('click', () => {
  ensureXLSX();
  batchQuotesFiles = [];
  document.getElementById('batchQuotesPreviewWrap').style.display = 'none';
  document.getElementById('batchQuotesProgressWrap').style.display = 'none';
  document.getElementById('batchQuotesProgressBar').style.width = '0%';
  document.getElementById('batchQuotesFileInput').value = '';
  document.getElementById('batchQuotesFolderInput').value = '';
  document.getElementById('btnConfirmBatchQuotes').disabled = true;
  openModal('ovBatchQuotes');
});

// 累加式加入檔案：同檔名再選一次會「更新」那一筆（重新比對），不是整批清掉重來；
// 這樣才能分好幾次選檔案、或選檔案後再選資料夾補充，彼此不會互相蓋掉。
function addBatchQuotesFiles(newFiles) {
  const validExt = /\.(xlsx|xls|csv)$/i;
  const filtered = newFiles.filter(f => validExt.test(f.name));
  if (!filtered.length) { toast('err', '選取的項目裡沒有 .xlsx/.xls/.csv 格式的檔案'); return; }
  filtered.forEach(file => {
    const matches = matchCustomersByFilename(file.name);
    let status, customer = null;
    if (matches.length === 1) { status = 'matched'; customer = matches[0]; }
    else if (matches.length === 0) { status = 'unmatched'; }
    else { status = 'ambiguous'; }
    const entry = { file, matches, status, customer };
    const existingIdx = batchQuotesFiles.findIndex(f => f.file.name === file.name);
    if (existingIdx > -1) batchQuotesFiles[existingIdx] = entry;
    else batchQuotesFiles.push(entry);
  });
  renderBatchQuotesPreview();
}

document.getElementById('btnBatchQuotesPickFiles').addEventListener('click', () => document.getElementById('batchQuotesFileInput').click());
document.getElementById('btnBatchQuotesPickFolder').addEventListener('click', () => document.getElementById('batchQuotesFolderInput').click());
document.getElementById('batchQuotesFileInput').addEventListener('change', e => {
  if (e.target.files.length) addBatchQuotesFiles(Array.from(e.target.files));
  e.target.value = ''; // 清空 value，這樣同一批檔案要再選一次時 change 事件才會再觸發
});
document.getElementById('batchQuotesFolderInput').addEventListener('change', e => {
  if (e.target.files.length) addBatchQuotesFiles(Array.from(e.target.files));
  e.target.value = '';
});
setupDropOnly('batchQuotesDropzone', files => addBatchQuotesFiles(files));
document.getElementById('btnBatchQuotesClear').addEventListener('click', () => {
  batchQuotesFiles = [];
  document.getElementById('batchQuotesPreviewWrap').style.display = 'none';
  document.getElementById('btnConfirmBatchQuotes').disabled = true;
});

function renderBatchQuotesPreview() {
  const okCount = batchQuotesFiles.filter(f => f.status === 'matched').length;
  document.getElementById('batchQuotesSummary').textContent = `共 ${batchQuotesFiles.length} 個檔案，可辨識並匯出 ${okCount} 筆`;
  const table = document.getElementById('batchQuotesPreviewTable');
  table.innerHTML = '<thead><tr><th>檔案名稱</th><th>比對到的客戶</th><th>狀態</th></tr></thead><tbody>' +
    batchQuotesFiles.map(f => {
      let matchText, statusText;
      if (f.status === 'matched') { matchText = `${f.customer.code} ${f.customer.name || ''}`; statusText = '<span class="badge badge-green">可匯出</span>'; }
      else if (f.status === 'unmatched') { matchText = '—'; statusText = '<span class="badge badge-red">找不到相符客戶</span>'; }
      else { matchText = f.matches.map(m => m.code).join('、'); statusText = '<span class="badge badge-red">比對到多個客戶</span>'; }
      return `<tr><td>${escapeHtml(f.file.name)}</td><td>${escapeHtml(matchText)}</td><td>${statusText}</td></tr>`;
    }).join('') + '</tbody>';
  document.getElementById('batchQuotesPreviewWrap').style.display = 'block';
  document.getElementById('btnConfirmBatchQuotes').disabled = okCount === 0;
}

document.getElementById('btnConfirmBatchQuotes').addEventListener('click', async () => {
  const jobs = batchQuotesFiles.filter(f => f.status === 'matched');
  if (!jobs.length) return;
  document.getElementById('batchQuotesProgressWrap').style.display = 'block';
  document.getElementById('btnConfirmBatchQuotes').disabled = true;
  let okN = 0, failN = 0;
  let totalHidden = 0;
  const failLog = [];
  try {
    await ensureExcelJS();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      document.getElementById('batchQuotesProgress').textContent = `處理中 ${i + 1}/${jobs.length}：${job.customer.code} ${job.customer.name || ''}`;
      document.getElementById('batchQuotesProgressBar').style.width = ((i + 1) / jobs.length * 100) + '%';
      try {
        const { rows, hiddenCount } = await readWorkbookRaw(job.file);
        totalHidden += hiddenCount || 0;
        const noCode = job.customer.productCodeMode === '無貨號';
        const previousCodes = await fetchPreviousCodes(job.customer.code);
        const itemCodeLookup = noCode ? await fetchItemCodeLookup(job.customer.code) : [];
        if (noCode && !itemCodeLookup.length) throw new Error('這個客戶還沒有上傳「料號對照表」');
        if (noCode && !state.masterItems.length) await loadMasterItems();
        const records = buildConvertedRecords(rows, job.customer.mapping.dataStartRowIdx, job.customer.mapping.columnMap, job.customer.productCodeMode, previousCodes, itemCodeLookup, state.masterItems);
        if (!records.length) throw new Error('沒有解析到任何品項，請確認欄位對應是否仍然正確');
        if (noCode) {
          // 無貨號客戶不在這裡直接匯出檔案，先儲存比對結果，之後用「批次匯出」合併成一份檔案
          const res = await saveQuotedPrices(job.customer, records);
          if (!res.ok) throw new Error(res.error || '儲存失敗');
          upsertCustomer(res.customer);
        } else {
          // 有貨號客戶現在也是先儲存，不在這裡直接匯出檔案
          const res = await saveHasCodeRecords(job.customer, records);
          if (!res.ok) throw new Error(res.error || '儲存失敗');
          upsertCustomer(res.customer);
        }
        okN++;
      } catch (err) {
        failN++;
        failLog.push(`${job.customer.code}：${err.message}`);
      }
    }
  } finally {
    document.getElementById('batchQuotesProgress').textContent =
      `完成：成功 ${okN} 筆，失敗 ${failN} 筆${totalHidden ? `（共排除 ${totalHidden} 列隱藏列）` : ''}${failLog.length ? '（' + failLog.join('；') + '）' : ''}`;
    document.getElementById('btnConfirmBatchQuotes').disabled = false;
    toast(failN ? 'err' : 'ok', `批次匯出完成：成功 ${okN} 筆${failN ? ('，失敗 ' + failN + ' 筆') : ''}`);
  }
});

/* ---------------- 上傳報價單精靈 ---------------- */
function colLetter(i) {
  let s = ''; i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function openWizard(customer) {
  state.wizard = { customer, rawRowsList: [], dataStartRowIdx: null, columnMap: {}, numCols: 0, convertedRecords: [], step: 1, usingSaved: false, fileNames: [], previousCodes: [], itemCodeLookup: [], isFirstEverExport: true, manualLookupOverrides: [] };
  const noCode = customer.productCodeMode === '無貨號';
  document.getElementById('wizardTitle').textContent = `上傳報價單 － ${customer.code} ${customer.name || ''}`;
  document.getElementById('wizardSub').textContent = customer.mapping
    ? '此客戶已設定欄位對應範本，上傳後將自動套用並儲存；之後可在客戶列表勾選多位客戶，用「批次匯出」合併成一份檔案'
    : '首次上傳此客戶的報價單，需要設定欄位對應（之後可自動套用）；上傳後會先儲存，不會立即產生檔案';
  document.getElementById('wizFileInput').value = '';
  document.getElementById('wizSaveMapping').checked = true;
  goToWizStep(1);
  openModal('ovWizard');
  ensureXLSX();
  ensureExcelJS();
  if (noCode && !state.masterItems.length) loadMasterItems();
}

function goToWizStep(n) {
  state.wizard.step = n;
  document.querySelectorAll('.wiz-panel').forEach(p => { p.style.display = (+p.getAttribute('data-panel') === n) ? 'block' : 'none'; });
  document.querySelectorAll('.wizard-steps .step').forEach(s => {
    const sn = +s.getAttribute('data-step');
    s.classList.toggle('active', sn === n);
    s.classList.toggle('done', sn < n);
  });
  document.getElementById('wizBack').style.display = n > 1 ? 'inline-flex' : 'none';
  document.getElementById('wizNext').style.display = n < 3 ? 'inline-flex' : 'none';
  const exportBtn = document.getElementById('wizExport');
  exportBtn.style.display = n === 3 ? 'inline-flex' : 'none';
  if (n === 3) {
    exportBtn.textContent = '儲存報價';
  }
}

setupMultiDropzone('wizDropzone', 'wizFileInput', async files => {
  try {
    setLoading(true, files.length > 1 ? `解析 ${files.length} 個檔案中…` : '解析檔案中…');
    const noCode = state.wizard.customer.productCodeMode === '無貨號';
    const [parsedFiles, previousCodes, itemCodeLookup] = await Promise.all([
      Promise.all(files.map(f => readWorkbookRaw(f))),
      fetchPreviousCodes(state.wizard.customer.code),
      noCode ? fetchItemCodeLookup(state.wizard.customer.code) : Promise.resolve([])
    ]);
    const rawRowsList = parsedFiles.map(p => p.rows);
    const totalHidden = parsedFiles.reduce((sum, p) => sum + (p.hiddenCount || 0), 0);
    state.wizard.rawRowsList = rawRowsList;
    state.wizard.fileNames = files.map(f => f.name);
    state.wizard.previousCodes = previousCodes;
    state.wizard.itemCodeLookup = itemCodeLookup;
    state.wizard.isFirstEverExport = !previousCodes.length;
    if (totalHidden) toast('ok', `已自動排除 ${totalHidden} 列隱藏列，不會列入辨識`);
    if (noCode && !itemCodeLookup.length) {
      setLoading(false);
      toast('err', '這個客戶還沒有上傳「料號對照表」，請先在客戶列表點「上傳料號對照表」設定好，才能比對出料號');
      return;
    }
    setLoading(false);
    if (!rawRowsList.some(rows => rows.length)) { toast('err', '檔案沒有資料'); return; }
    if (files.length > 1) toast('ok', `已選取 ${files.length} 個檔案，將套用同一組欄位對應解析全部檔案`);
    const customer = state.wizard.customer;
    if (customer.mapping && customer.mapping.columnMap && Object.keys(customer.mapping.columnMap).length) {
      state.wizard.dataStartRowIdx = customer.mapping.dataStartRowIdx;
      state.wizard.columnMap = Object.assign({}, customer.mapping.columnMap);
      state.wizard.usingSaved = true;
      computeConverted();
      if (!state.wizard.convertedRecords.length) {
        toast('err', '套用已存範本後沒有解析到任何品項，請重新設定欄位對應');
        state.wizard.usingSaved = false;
        state.wizard.columnMap = {};
        state.wizard.dataStartRowIdx = null;
        renderMappingStep();
        goToWizStep(2);
        return;
      }
      renderResultStep();
      goToWizStep(3);
    } else {
      state.wizard.usingSaved = false;
      renderMappingStep();
      goToWizStep(2);
    }
  } catch (err) { setLoading(false); toast('err', '解析失敗：' + err.message); }
});

function guessHeaderRowIdx(rows, productCodeMode) {
  const noCode = productCodeMode === '無貨號';
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const line = (rows[i] || []).join('');
    if (noCode) {
      if (/單價/.test(line) && /(品名|規格|名稱)/.test(line)) return i;
    } else {
      if (/單價/.test(line) && /(貨號|品號|產品編號|品名)/.test(line)) return i;
    }
  }
  return -1;
}

function renderMappingStep() {
  const rows = state.wizard.rawRowsList[0];
  const productCodeMode = state.wizard.customer.productCodeMode;
  const headerGuessIdx = guessHeaderRowIdx(rows, productCodeMode);
  if (state.wizard.dataStartRowIdx == null) {
    state.wizard.dataStartRowIdx = headerGuessIdx >= 0 ? headerGuessIdx + 1 : 0;
  }
  const previewRows = rows.slice(0, Math.min(30, rows.length));
  const maxCols = previewRows.reduce((m, r) => Math.max(m, r.length), 0);
  state.wizard.numCols = Math.max(maxCols, 1);

  if (!Object.keys(state.wizard.columnMap).length && headerGuessIdx >= 0) {
    const headerRow = rows[headerGuessIdx] || [];
    const identityField = getIdentityField(state.wizard.customer.productCodeMode);
    let prevField = null;
    headerRow.forEach((txt, idx) => {
      const t = String(txt || '').trim();
      let field = null;
      if (/貨號|品號|產品編號/.test(t)) field = '貨號';
      else if (/單價|價格|報價/.test(t)) field = '單價';
      else if (/單位/.test(t)) field = '單位';
      else if (/品名|規格|名稱/.test(t)) field = '品名';
      // 有些客戶的報價單是橫向並排好幾組「品名/單價」的重複區塊格式，第二組以後的「單價」
      // 表頭常常直接留空（沿用左邊那組的標題意思），所以緊接在識別欄位後面的空白表頭，
      // 就先幫忙猜是單價，猜錯的話使用者在下面的欄位對應下拉選單裡改掉即可
      if (!field && !t && prevField === identityField) field = '單價';
      if (field) state.wizard.columnMap[idx] = field;
      prevField = field;
    });
  }
  renderMapPreviewTable();
  renderMapGrid();
}

function renderMapPreviewTable() {
  const rows = state.wizard.rawRowsList[0];
  const n = state.wizard.numCols;
  const previewRows = rows.slice(0, Math.min(30, rows.length));
  const thead = '<thead><tr><th></th>' + Array.from({ length: n }).map((_, i) => `<th>${colLetter(i)}</th>`).join('') + '</tr></thead>';
  const body = '<tbody>' + previewRows.map((r, idx) => {
    const cls = idx >= state.wizard.dataStartRowIdx ? 'marked-start' : '';
    const cells = Array.from({ length: n }).map((_, ci) => `<td>${escapeHtml(r[ci] != null ? r[ci] : '')}</td>`).join('');
    return `<tr class="header-row-pick ${cls}" data-row-idx="${idx}"><td class="mono" style="color:var(--ink-soft);">#${idx + 1}</td>${cells}</tr>`;
  }).join('') + '</tbody>';
  const table = document.getElementById('wizMapPreviewTable');
  table.innerHTML = thead + body;
  table.querySelectorAll('tr[data-row-idx]').forEach(tr => {
    tr.addEventListener('click', () => {
      state.wizard.dataStartRowIdx = +tr.getAttribute('data-row-idx');
      renderMapPreviewTable();
      renderMapGrid();
    });
  });
}

function renderMapGrid() {
  const rows = state.wizard.rawRowsList[0];
  const sampleRowIdx = state.wizard.dataStartRowIdx != null ? state.wizard.dataStartRowIdx : 0;
  const sampleRow = rows[sampleRowIdx] || [];
  const n = state.wizard.numCols;
  const targetFields = getTargetFields(state.wizard.customer.productCodeMode);
  const grid = document.getElementById('wizMapGrid');
  let html = '';
  for (let i = 0; i < n; i++) {
    const sample = sampleRow[i] != null ? String(sampleRow[i]) : '';
    const current = state.wizard.columnMap[i] || '';
    html += `<div>
      <div class="col-label">欄位 ${colLetter(i)}</div>
      <div class="col-sample" title="${escapeHtml(sample)}">${escapeHtml(sample) || '（空）'}</div>
      <select data-col-idx="${i}" class="mapSelect">
        <option value="">（不使用）</option>
        ${targetFields.map(f => `<option value="${f.key}" ${current === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}
      </select>
    </div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.mapSelect').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = +sel.getAttribute('data-col-idx');
      if (sel.value) state.wizard.columnMap[idx] = sel.value; else delete state.wizard.columnMap[idx];
    });
  });
}

function computeConverted() {
  const { rawRowsList, dataStartRowIdx, columnMap, customer, previousCodes, itemCodeLookup } = state.wizard;
  state.wizard.convertedRecords = buildConvertedRecords(rawRowsList, dataStartRowIdx, columnMap, customer.productCodeMode, previousCodes, itemCodeLookup, state.masterItems);
}

function renderResultStep() {
  const recs = state.wizard.convertedRecords;
  const customer = state.wizard.customer;
  const total = recs.length;
  const newCount = recs.filter(r => r._isNew).length;
  const unmatchedCount = recs.filter(r => r._unmatched).length;
  let extraPill;
  if (state.wizard.isFirstEverExport) {
    extraPill = `<div class="pill">首次匯出，之後上傳可自動比對新增品項</div>`;
  } else if (newCount) {
    extraPill = `<div class="pill warn">新增品項 ${newCount} 項（與上次匯出比較，黃底標示）</div>`;
  } else {
    extraPill = `<div class="pill">與上次匯出比較，沒有新增品項</div>`;
  }
  const unmatchedPill = unmatchedCount
    ? `<div class="pill" style="background:#ffe6d1;color:var(--orange-action);">比對不到忠欣品項代號 ${unmatchedCount} 項（橘底，仍會匯出但代號留空，請補上料號對照表後重新匯出）</div>`
    : '';
  document.getElementById('wizResultSummary').innerHTML = `<div class="pill ok">共 ${total} 項</div>${extraPill}${unmatchedPill}`;
  const table = document.getElementById('wizResultPreviewTable');

  if (customer.productCodeMode === '無貨號') {
    // 無貨號客戶的正式匯出檔是整份忠欣品項主檔（幾千列），這裡的預覽改成只顯示「這次客戶自己報了哪些品項」
    // 以及有沒有比對到忠欣品項代號，不逐列預覽最終檔案本身（那樣會有幾千列，瀏覽器跟人眼都吃不消）。
    // 比對不到的品項：直接在這裡打忠欣料號手動補上，不用先跳去「料號對照表」設定好才能再重新上傳一次。
    const thead = '<thead><tr><th>客戶品項名稱</th><th>比對結果（忠欣品項代號）</th><th>單價</th></tr></thead>';
    const body = '<tbody>' + recs.map((rec, idx) => {
      const rowCls = rec._unmatched ? 'unmatched-row' : (rec._isNew ? 'new-item-row' : '');
      const matchCell = rec._unmatched
        ? `<input type="text" class="manualLookupInput" data-row-idx="${idx}" list="masterItemsDatalist" placeholder="輸入忠欣料號" style="width:120px;padding:4px 7px;border:1px solid var(--rust-600);border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:12px;">`
        : escapeHtml(rec['貨號']);
      return `<tr class="${rowCls}"><td>${escapeHtml(rec['品名'])}</td><td class="mono">${matchCell}</td><td>${escapeHtml(rec['單價'])}</td></tr>`;
    }).join('') + '</tbody>';
    table.innerHTML = thead + body;
    populateMasterItemsDatalist();
    table.querySelectorAll('.manualLookupInput').forEach(input => {
      input.addEventListener('change', () => applyManualLookup(+input.getAttribute('data-row-idx'), input.value.trim()));
    });
    return;
  }

  const thead = '<thead><tr>' + OUTPUT_HEADERS.map(h => `<th>${h}</th>`).join('') + '</tr></thead>';
  const body = '<tbody>' + recs.map(rec => {
    const cells = OUTPUT_FIELD_ORDER.map((f, i) => {
      let v;
      if (i === 0) v = customer.code;
      else if (i === 1) v = customer.name;
      else v = rec[f] || '';
      return `<td>${escapeHtml(v)}</td>`;
    }).join('');
    const rowCls = rec._unmatched ? 'unmatched-row' : (rec._isNew ? 'new-item-row' : '');
    return `<tr class="${rowCls}">${cells}</tr>`;
  }).join('') + '</tbody>';
  table.innerHTML = thead + body;
}

document.getElementById('wizNext').addEventListener('click', () => {
  const step = state.wizard.step;
  if (step === 1) {
    if (!state.wizard.rawRowsList.length) { toast('err', '請先上傳檔案'); return; }
    if (state.wizard.usingSaved) { renderResultStep(); goToWizStep(3); return; }
    renderMappingStep();
    goToWizStep(2);
  } else if (step === 2) {
    const assignedFields = new Set(Object.values(state.wizard.columnMap));
    const targetFields = getTargetFields(state.wizard.customer.productCodeMode);
    const missing = targetFields.filter(f => f.required && !assignedFields.has(f.key));
    if (missing.length) { toast('err', '請先設定：' + missing.map(f => f.label).join('、')); return; }
    computeConverted();
    if (!state.wizard.convertedRecords.length) { toast('err', '依目前設定沒有解析到任何品項，請確認起始列與欄位對應'); return; }
    if (document.getElementById('wizSaveMapping').checked) saveMappingForCustomer();
    renderResultStep();
    goToWizStep(3);
  }
});

document.getElementById('wizBack').addEventListener('click', () => {
  const step = state.wizard.step;
  if (step === 3) {
    if (state.wizard.usingSaved) {
      state.wizard.usingSaved = false;
      renderMappingStep();
    }
    goToWizStep(2);
  } else if (step === 2) {
    goToWizStep(1);
  }
});

async function saveMappingForCustomer() {
  try {
    assertSb();
    const mapping = { dataStartRowIdx: state.wizard.dataStartRowIdx, columnMap: state.wizard.columnMap };
    const { data, error } = await sb.from('customers').update({
      mapping, updated_at: new Date().toISOString()
    }).eq('code', state.wizard.customer.code).select().single();
    if (!error && data) {
      const customer = rowToCustomer(data);
      state.wizard.customer = customer;
      upsertCustomer(customer);
    }
  } catch (err) { /* 靜默失敗，不影響匯出流程 */ }
}

function applyManualLookup(rowIdx, code) {
  const rec = state.wizard.convertedRecords[rowIdx];
  if (!rec) return;
  if (!code) { toast('err', '請輸入忠欣料號'); return; }
  const master = state.masterItems.find(m => m.itemCode === code);
  if (!master) { toast('err', `找不到料號「${code}」，請確認忠欣品項主檔裡有這個代號`); return; }
  rec['貨號'] = code;
  rec._unmatched = false;
  if (!rec['單位']) rec['單位'] = master.unit;
  // 記住這次手動補上的對照，儲存報價時會一併寫進這個客戶的料號對照表，下次上傳就能自動比對到
  const custName = rec['品名'];
  const overrides = state.wizard.manualLookupOverrides;
  const existingIdx = overrides.findIndex(x => x.name === custName);
  const entry = { name: custName, code, itemName: master.itemName };
  if (existingIdx > -1) overrides[existingIdx] = entry; else overrides.push(entry);
  toast('ok', `已將「${custName}」對應到 ${code}（${master.itemName}），儲存報價時會一併加入料號對照表`);
  renderResultStep();
}

document.getElementById('wizExport').addEventListener('click', async () => {
  const { customer, convertedRecords } = state.wizard;
  if (!convertedRecords.length) return;

  // 上傳報價單不再立即產生檔案，先把結果存起來，之後用「批次匯出」把選取的客戶合併成一份檔案
  setLoading(true, '儲存報價中…');
  try {
    const saveFn = customer.productCodeMode === '無貨號' ? saveQuotedPrices : saveHasCodeRecords;
    const res = await saveFn(customer, convertedRecords);
    if (!res.ok) throw new Error(res.error || '儲存失敗');
    let finalCustomer = res.customer;
    // 精靈第3步手動補上的料號對照（原本比對不到、使用者直接打上忠欣料號的），
    // 這裡一併合併進這個客戶的料號對照表，下次上傳同樣的品名就能自動比對到，不用每次都手動補
    const overrides = state.wizard.manualLookupOverrides;
    if (overrides && overrides.length) {
      const existingLookup = await fetchItemCodeLookup(customer.code);
      overrides.forEach(entry => {
        const idx = existingLookup.findIndex(x => x.name === entry.name);
        if (idx > -1) existingLookup[idx] = entry; else existingLookup.push(entry);
      });
      finalCustomer = await saveItemCodeLookup(customer.code, existingLookup);
    }
    upsertCustomer(finalCustomer);
    closeModal('ovWizard');
    toast('ok', `已儲存 ${customer.code} 的報價，共 ${convertedRecords.length} 項${overrides && overrides.length ? `，並補上 ${overrides.length} 筆料號對照` : ''}。之後可在客戶列表勾選需要的客戶，點「批次匯出」合併匯出。`);
  } catch (err) {
    toast('err', '儲存失敗：' + err.message);
  } finally {
    setLoading(false);
  }
});

/* ---------------- 初始化 ---------------- */
const _fvStamp = document.getElementById('frontendVersionStamp');
if (_fvStamp) _fvStamp.textContent = FRONTEND_VERSION; else console.warn('找不到版本標示欄位，頁面可能不是最新版本');
renderStageCards();
renderCustomerList();
renderDetailPanel();
renderExportTray();
if (!sb) {
  toast('err', sbInitError || '尚未設定 Supabase 連線資訊，請在 app.js 開頭填入 SUPABASE_URL 與 SUPABASE_ANON_KEY 後再重新整理');
  console.error('[Supabase 設定問題]', sbInitError);
} else {
  loadCustomers(true);
  setupRealtime();
  // Realtime 是主要同步機制，這裡的輪詢降為低頻率保險，避免忘了在 Supabase 後台開 Realtime 時完全沒有同步
  let pollTimer = setInterval(() => { if (!document.hidden) loadCustomers(false); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadCustomers(false); // 回到分頁時立即補一次，不用等下一輪
  });
}
