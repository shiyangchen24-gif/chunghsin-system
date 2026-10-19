#!/bin/bash
# 建立本機開發資料庫 zxdev：Supabase 介面模擬 → 01~06 → 模擬搬移資料 → 07 → 測試帳號
set -e
cd "$(dirname "$0")"
P="psql -h /var/tmp/zxsock -p 5544 -U postgres -v ON_ERROR_STOP=1 -q"
SQL="$(cd "$(dirname "$0")/../supabase/sql" && pwd)"
$P -c "drop database if exists zxdev with (force)" -c "create database zxdev" >/dev/null
$P -d zxdev -f ../supabase/test/supabase_stub.sql >/dev/null
$P -d zxdev -f devstub_extra.sql >/dev/null
for f in 01_backup 02_core_shared 03_tick 04_report 05_quote 06_import_staging 12_dashboard 13_nickname_access 14_analytics; do $P -d zxdev -f $SQL/$f.sql >/dev/null 2>&1 || { echo "FAIL $f"; exit 1; }; done
[ "${1:-}" = "--empty" ] || $P -d zxdev -f ${SEED:-../supabase/test/staging_sim.sql} >/dev/null
$P -d zxdev -f $SQL/07_backfill.sql >/dev/null 2>&1 || { echo "FAIL backfill"; exit 1; }
python3 - <<'PY' | $P -d zxdev >/dev/null
import json
for u in json.load(open('users.json')):
    print(f"insert into auth.users(id,email) values ('{u['id']}','{u['email']}') on conflict do nothing;")
    print(f"insert into public.app_members(user_id,role,display_name,icon) values ('{u['id']}','{u['role']}','{u['display_name']}','{u['icon']}') on conflict (user_id) do update set role=excluded.role;")
PY
$P -d zxdev -f $SQL/15_api_grants.sql >/dev/null 2>&1 || { echo "FAIL 15_api_grants"; exit 1; }   # 比照正式環境：資料表授權只靠 15
$P -d zxdev -c "notify pgrst, 'reload schema';" >/dev/null
echo "zxdev ready"
