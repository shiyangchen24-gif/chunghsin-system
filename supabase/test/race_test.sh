#!/bin/bash
# 交易 A 先拿到 seq/txid 但晚提交；交易 B 後開始、先提交。
# 正確行為：A 提交前，sync 不得把游標推過 A（否則 A 會永久漏掉）。
P="psql -h /var/tmp/zxsock -p 5544 -U postgres -q -d zx -At"
AS="set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);"
C0=$($P -c "$AS select public.sync_changes(null)->>'cursor'" | tail -1)
$P -c "begin; insert into public.vehicles(car_no) values ('RACE-A'); select pg_sleep(3); commit;" >/dev/null &
sleep 1
$P -c "insert into public.vehicles(car_no) values ('RACE-B');" >/dev/null
R1=$($P -c "$AS select public.sync_changes('$C0')" | tail -1)
echo "while A open : $R1"
wait
C1=$(echo "$R1" | python3 -c "import json,sys;print(json.load(sys.stdin)['cursor'])")
R2=$($P -c "$AS select public.sync_changes('$C1')" | tail -1)
echo "after A commit: $R2"
ALL=$(python3 -c "import json,sys;a=json.loads(sys.argv[1]);b=json.loads(sys.argv[2]);print(sorted(c['v']['car_no'] for c in a['changes']+b['changes']))" "$R1" "$R2")
echo "union seen   : $ALL"
[ "$ALL" = "['RACE-A', 'RACE-B']" ] && echo "PASS: no change missed despite out-of-order commit" || echo "FAIL"
