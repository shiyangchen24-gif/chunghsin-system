/* =====================================================================
 * zx-sync.js — 三站共用同步核心（vanilla JS，無框架）
 * 依賴：supabase-js@2 已建立的 client（變數名 sb，避免與全域 supabase 衝突）
 *
 * 流程（防止「訂閱建立前」的漏件）：
 *   1. cursor = sync_changes(null)        ← 先拿伺服器水位
 *   2. 呼叫端載入目前畫面資料（欄位投影、分頁）
 *   3. 訂閱 private Broadcast 'zx:<site>'，SUBSCRIBED 後立刻 catchUp()
 *   4. 收到 Broadcast → onChange(小摘要)；catchUp 以 seq 去重
 *   5. Realtime 斷線：每 30 秒 catchUp（無變更時回應 < 100 bytes）
 *      連線中：每 5 分鐘 catchUp 一次，補 Broadcast 偶發遺失
 *   6. 頁面隱藏 60 秒 → 退訂；可見／上線 → 重訂閱＋立即 catchUp
 *   7. 失敗 → 指數退避＋jitter
 * 不依賴客戶端時鐘；不會全表重抓（除非伺服器回 reset，才由呼叫端重載「目前畫面」）。
 * ===================================================================== */
(function (global) {
  'use strict';

  function backoff(attempt, base, max) {
    const exp = Math.min(max, base * Math.pow(2, attempt));
    return Math.round(exp / 2 + Math.random() * exp / 2);   // equal jitter
  }

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /**
   * @param {object} o
   * @param {object} o.sb                supabase client
   * @param {string[]} o.sites           例：['tick','shared']
   * @param {(c:object)=>void} o.onChange  c = {s,site,t,k,op,rev,v}；op 'D' 為刪除 tombstone；k '*' 為整批變更
   * @param {()=>Promise<void>} o.onReset  游標過舊：重載目前畫面
   * @param {(state:string)=>void} [o.onStatus] 'live' | 'catching-up' | 'fallback' | 'offline' | 'paused'
   */
  function createSync(o) {
    const sb = o.sb;
    const sites = o.sites;
    const FALLBACK_MS = 30000;
    const SAFETY_MS = 300000;
    const HIDDEN_UNSUB_MS = 60000;

    let cursor = null;
    let channels = [];
    let subscribed = 0;
    let timer = null;
    let hiddenTimer = null;
    let catching = null;
    let failures = 0;
    let stopped = false;
    const seen = new Map();          // seq → 時間，用來去重 Broadcast 與 catchUp

    const status = s => o.onStatus && o.onStatus(s);

    function markSeen(seq) {
      seen.set(seq, Date.now());
      if (seen.size > 5000) {
        const cut = Date.now() - 600000;
        for (const [k, t] of seen) if (t < cut) seen.delete(k);
      }
    }

    function deliver(c) {
      if (c.s != null) {
        if (seen.has(c.s)) return;
        markSeen(c.s);
      }
      try { o.onChange(c); } catch (e) { console.error('[zx-sync] onChange', e); }
    }

    async function catchUp() {
      if (stopped || cursor == null) return;
      if (catching) return catching;
      catching = (async () => {
        if (!subscribed) status('catching-up');
        const { data, error } = await sb.rpc('sync_changes', { p_cursor: cursor, p_sites: sites });
        if (error) throw error;
        if (data.reset) {
          cursor = data.cursor;
          seen.clear();
          await o.onReset();
        } else {
          for (const c of data.changes) deliver(c);
          cursor = data.cursor;
        }
        failures = 0;
      })().catch(err => {
        failures++;
        console.warn('[zx-sync] catchUp failed', err && err.message);
        status(navigator.onLine === false ? 'offline' : 'fallback');
      }).finally(() => {
        catching = null;
        clearTimeout(timer); timer = null;
        schedule();
      });
      return catching;
    }

    // 注意：Realtime 斷線時 realtime-js 每幾秒就重連一次、每次失敗都會觸發這裡；
    // 已排定且更早到期的檢查不可被往後延，否則 30 秒水位檢查永遠不會執行
    let nextAt = 0;
    function schedule() {
      if (stopped || document.visibilityState === 'hidden') { clearTimeout(timer); timer = null; return; }
      const live = subscribed === sites.length;
      status(live ? 'live' : (navigator.onLine === false ? 'offline' : 'fallback'));
      const wait = failures ? backoff(failures, 2000, FALLBACK_MS) : (live ? SAFETY_MS : FALLBACK_MS);
      const at = Date.now() + wait;
      if (timer && nextAt <= at) return;
      clearTimeout(timer);
      nextAt = at;
      timer = setTimeout(() => { timer = null; catchUp(); }, wait);
    }

    function subscribe() {
      unsubscribe();
      subscribed = 0;
      channels = sites.map(site => {
        let ok = false;
        return sb.channel('zx:' + site, { config: { private: true } })
          .on('broadcast', { event: 'chg' }, msg => deliver(Object.assign({ site }, msg.payload)))
          .subscribe((state, err) => {
            if (state === 'SUBSCRIBED') {
              if (!ok) { ok = true; subscribed++; }
              catchUp();                                  // 訂閱完成後立即補差
            } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
              if (ok) { ok = false; subscribed = Math.max(0, subscribed - 1); }
              if (err) console.warn('[zx-sync] channel', site, state, err.message);
              schedule();                                  // 失聯 → 每 30 秒水位檢查
            }
          });
      });
    }

    function unsubscribe() {
      for (const ch of channels) sb.removeChannel(ch);
      channels = [];
      subscribed = 0;
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        hiddenTimer = setTimeout(() => { unsubscribe(); status('paused'); }, HIDDEN_UNSUB_MS);
      } else {
        clearTimeout(hiddenTimer);
        if (!channels.length) subscribe();
        catchUp();
      }
    }
    const onOnline = () => { failures = 0; catchUp(); };
    const onOffline = () => status('offline');

    return {
      /** 1) 取水位 → 2) loadSnapshot() → 3) 訂閱 */
      async start(loadSnapshot) {
        stopped = false;
        const { data, error } = await sb.rpc('sync_changes', { p_cursor: null, p_sites: sites });
        if (error) throw error;
        cursor = data.cursor;
        await loadSnapshot();
        subscribe();
        document.addEventListener('visibilitychange', onVisibility);
        global.addEventListener('online', onOnline);
        global.addEventListener('offline', onOffline);
        schedule();
      },
      stop() {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(hiddenTimer);
        unsubscribe();
        document.removeEventListener('visibilitychange', onVisibility);
        global.removeEventListener('online', onOnline);
        global.removeEventListener('offline', onOffline);
      },
      catchUp,
      get cursor() { return cursor; }
    };
  }

  /**
   * 寫入 RPC：同一個 request_id 重送（斷線重試安全，伺服器去重）
   * 回傳 RPC 的 jsonb；{ok:false,reason:'conflict'} 由呼叫端顯示「資料已在別處更新」並重抓該筆
   */
  async function writeRpc(sb, fn, args, { retries = 3 } = {}) {
    const request_id = uuid();
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await sb.rpc(fn, Object.assign({}, args, { p_request_id: request_id }));
      if (!error) return data;
      const transient = !error.code || /^(08|57P|PGRST00)/.test(error.code) || error.message === 'Failed to fetch';
      if (!transient || attempt >= retries) throw error;
      await new Promise(r => setTimeout(r, backoff(attempt, 1000, 15000)));
    }
  }

  /* ---------------------------------------------------------------
   * 流量計量（測試用）：記錄 API 回應 bytes 與 Realtime 下行 bytes
   * 用法：在建立 sb 之前呼叫 zxMeter.install()，之後 zxMeter.report()
   * --------------------------------------------------------------- */
  const zxMeter = {
    api: {}, ws: { frames: 0, bytes: 0, heartbeats: 0 }, startedAt: Date.now(),
    install() {
      const self = this;
      const origFetch = global.fetch.bind(global);
      self.fetch = async function (input, init) {
        const res = await origFetch(input, init);
        try {
          const url = new URL(typeof input === 'string' ? input : input.url);
          const key = (init && init.method || 'GET') + ' ' + url.pathname.replace(/^\/(rest|auth)\/v1/, '');
          const len = +res.headers.get('content-length') || (await res.clone().arrayBuffer()).byteLength;
          const a = self.api[key] || (self.api[key] = { calls: 0, bytes: 0 });
          a.calls++; a.bytes += len;
        } catch (e) { /* 計量失敗不影響功能 */ }
        return res;
      };
      const OrigWS = global.WebSocket;
      global.WebSocket = function (url, protocols) {
        const ws = new OrigWS(url, protocols);
        ws.addEventListener('message', ev => {
          const n = typeof ev.data === 'string' ? new Blob([ev.data]).size : (ev.data.byteLength || ev.data.size || 0);
          self.ws.frames++; self.ws.bytes += n;
          if (typeof ev.data === 'string' && ev.data.indexOf('phx_reply') > -1 && ev.data.indexOf('"phoenix"') > -1) self.ws.heartbeats++;
        });
        return ws;
      };
      global.WebSocket.prototype = OrigWS.prototype;
      Object.assign(global.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      return self.fetch;     // 傳給 createClient(url, key, { global: { fetch: zxMeter.fetch } })
    },
    report() {
      const hours = (Date.now() - this.startedAt) / 3600000;
      const apiBytes = Object.values(this.api).reduce((s, a) => s + a.bytes, 0);
      return { hours: +hours.toFixed(2), apiBytes, wsBytes: this.ws.bytes, ws: this.ws, api: this.api,
               note: 'content-length 為壓縮後大小；不含 TLS/HTTP 標頭，與 Dashboard 對帳時誤差約 +5～15%' };
    }
  };

  global.zxSync = { createSync, writeRpc, uuid };
  global.zxMeter = zxMeter;
})(window);
