-- 本機開發用：讓 PostgREST 的 request.jwt.claims 也能被 auth.uid() 讀到（與真實 Supabase 相同行為），
-- 並把 realtime.messages 的新訊息以 NOTIFY 轉給本機 realtime 閘道
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;
grant anon, authenticated to authenticator;
create or replace function realtime.zx_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('zx_rt', json_build_object('topic', new.topic, 'event', new.event, 'payload', new.payload, 'private', new.private)::text);
  return null;
end $$;
drop trigger if exists zx_notify on realtime.messages;
create trigger zx_notify after insert on realtime.messages for each row execute function realtime.zx_notify();
