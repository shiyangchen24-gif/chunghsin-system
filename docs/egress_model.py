#!/usr/bin/env python3
"""忠欣三站 Supabase 一般 Egress 試算模型（單次大小已用本機測試堆疊實測校正；整月總量仍為試算）。

公式：每月出站 ≈ Σ(API 回應 bytes × 次數) + Σ(推播下行 bytes × 接收連線數) + 心跳／認證
單位：1 GB = 10^9 bytes。所有大小為「未壓縮 JSON + 約 400 B HTTP 標頭」的保守估計。
實測後請把 PARAMS 換成 zxMeter.report() 量到的數字重新執行：
    python3 egress_model.py [devices]
"""
import sys

DEVICES = int(sys.argv[1]) if len(sys.argv) > 1 else 8
HOURS, DAYS = 8, 26
HDR = 400                     # 每次 HTTP 回應標頭 bytes
BCAST = 391                   # 一則 Broadcast 小事件（本機實測 2026-10-18：782 B / 2 則）
CUSTOMERS = 500

def resp(body):               # 一次 API 回應總 bytes
    return body + HDR

rows = []                      # (站別, 項目, 每日 bytes, 說明)
def add(site, item, per_day, note):
    rows.append((site, item, per_day, note))

# ---------------- 打勾單 ----------------
snap = 12 * HDR + 800 + CUSTOMERS * 430   # 本機實測：12 次請求、每位客戶約 430 B（客戶＋負責人＋當日狀態＋群組）
add('打勾單', '首載（客戶+當日狀態+群組+留言）', DEVICES * 6 * snap, f'{DEVICES} 台 × 6 次/日 × {snap/1e3:.0f} KB')
changes = 550
add('打勾單', '勾選／編輯（寫入回應+推播）', changes * (resp(207) + BCAST * DEVICES), f'{changes} 次/日；每次推播給 {DEVICES} 台')
add('打勾單', '歷史與趨勢（分頁 50 筆）', 30 * resp(50 * 200) + 20 * resp(20_000), '30 頁 + 20 次趨勢彙總/日')

# ---------------- 異常／交接 ----------------
snap = resp(40 * 450) + resp(30 * 250) + resp(CUSTOMERS * 70)
add('異常交接', '首載（當日兩表+客戶名稱）', DEVICES * 6 * snap, f'{DEVICES} 台 × 6 次/日 × {snap/1e3:.0f} KB')
changes = 120
add('異常交接', '新增／編輯（推播+同日裝置讀該列）', changes * (resp(200) + DEVICES * (BCAST + resp(450))), f'{changes} 次/日')
add('異常交接', '歷史分頁', 40 * resp(50 * 450), '40 頁/日 × 50 筆')

# ---------------- 報價 ----------------
quote_devices = min(3, DEVICES)
add('報價', '首頁清單（v_quote_customer_list）', quote_devices * 4 * resp(CUSTOMERS * 250), f'{quote_devices} 台 × 4 次/日')
add('報價', '品項主檔（IndexedDB 快取，版本變才抓）', quote_devices * 4 * resp(3000 * 110) / DAYS + quote_devices * 4 * resp(60), '每月 4 次變更 × 3,000 品項；平時只比對版本')
add('報價', '開客戶詳情（品項+料號對照）', 60 * (resp(200 * 250) + resp(300 * 80)), '60 次/日')
add('報價', '上傳儲存（回應+推播）', 30 * (resp(80) + 3 * BCAST * DEVICES), '30 次/日；每次 ≤3 則事件')
add('報價', '批次匯出（讀取必要欄位）', 2 * 100 * resp(200 * 120), '2 次/日 × 100 客戶 × 200 品項')

# ---------------- 共用 ----------------
dash_devices = min(2, DEVICES)                 # 儀表板通常只開在 1～2 台（辦公室電腦）
add('共用', '儀表板彙總＋異常分析', dash_devices * (6 + HOURS * 60) * (resp(3500) + resp(1500)),
    f'{dash_devices} 台；有異動時最快每 60 秒重抓一次（上限 {HOURS * 60} 次/日）× 約 3.5 + 1.5 KB')
add('共用', '經營月報', 2 * 2 * resp(6000), '每日約 2 次 × 本月＋上月兩份')
add('共用', '裝置上線紀錄 device_touch', DEVICES * 6 * 2 * resp(0), '每次開頁一次（回應無內容）')
add('共用', '儀表板收到的推播（三站全部事件）', dash_devices * (550 + 120 + 90) * BCAST, f'{dash_devices} 台 × 約 760 則/日')
sockets = DEVICES * 2 + dash_devices           # 平均每台同時開 2 站，另加儀表板
hb = sockets * (HOURS * 3600 / 25) * 89        # supabase-js 心跳約 25 秒一次，回覆實測約 89 B
add('共用', 'Realtime 心跳', hb, f'{sockets} 條連線 × 每 25 秒')
add('共用', '補差：連線中每 5 分、斷線時每 30 秒', sockets * (HOURS * 12) * resp(60) + sockets * (HOURS * 120 * 0.10) * resp(60), '假設 10% 時間 Realtime 失聯')
add('共用', 'Auth token 更新', DEVICES * HOURS * 2 * 1500, '每小時一次 × 2 站')

total_day = sum(r[2] for r in rows)
print(f'# Egress 試算（{DEVICES} 台、每日 {HOURS} 小時、每月 {DAYS} 天）— 試算，非實測\n')
print('| 站別 | 項目 | 每日 MB | 每月 MB | 假設 |')
print('|---|---|---:|---:|---|')
by_site = {}
for site, item, d, note in rows:
    by_site[site] = by_site.get(site, 0) + d
    print(f'| {site} | {item} | {d/1e6:.2f} | {d*DAYS/1e6:.0f} | {note} |')
print(f'| **合計** | | **{total_day/1e6:.1f}** | **{total_day*DAYS/1e6:.0f}** | |\n')
budget = {'打勾單': 0.9, '異常交接': 0.7, '報價': 0.9, '共用': 0.5}
print('| 站別 | 每月 GB | 內部預算 GB | 佔預算 |')
print('|---|---:|---:|---:|')
for s, d in by_site.items():
    gb = d * DAYS / 1e9
    print(f'| {s} | {gb:.3f} | {budget[s]} | {gb/budget[s]*100:.0f}% |')
print(f'| **合計** | **{total_day*DAYS/1e9:.3f}** | 3.0 | {total_day*DAYS/1e9/3*100:.0f}% |')

# 對照：舊打勾單（依 nitaaa1119-ai/Chun-Shin-Ltd. index.html 實際程式碼推算）
#  每勾一次：_pushUpdateClient 先讀整份 zhongxin_v4，再 upsert zhongxin_v4 + zhongxin_hist_v4 + zhongxin_ts_v1
#  → Postgres Changes 把「整列 value」推給每台裝置（v4 與 hist 兩列大 JSON）
#  → 其他每台裝置收到事件就 syncFromCloud()：select key,value 整張表
#  另外每台每 30 秒輪詢一次整張表、每次切回分頁再抓一次整張表
print('\n## 舊版打勾單對照（依現行程式碼推算，全表大小待 00_inventory 的 value_bytes 確認）\n')
print('| 全表大小 | 每勾一次 | 每月：勾選 550 次/日 | 每月：30 秒輪詢 | 每月合計 |')
print('|---:|---:|---:|---:|---:|')
for kb in (100, 300, 500):
    table = kb * 1000
    v4 = 638 * 70                                  # 638 位客戶 × 約 70 B
    per_click = resp(v4) + DEVICES * (v4 + (table - v4)) + (DEVICES - 1) * resp(table)
    clicks = per_click * 550 * DAYS / 1e9
    poll = DEVICES * (HOURS * 120) * resp(table) * DAYS / 1e9
    print(f'| {kb} KB | {per_click/1e6:.1f} MB | {clicks:.0f} GB | {poll:.0f} GB | **{clicks+poll:.0f} GB** |')
