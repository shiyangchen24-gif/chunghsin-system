-- =====================================================================
-- 11_members_template.sql ── 建立成員（帳號 → 角色）
-- 步驟：1) Dashboard → Authentication → Users → Add user（輸入 Email 與密碼，勾 Auto Confirm）
--       2) 把下面的 Email 換成實際帳號後執行。role：admin（管理員，可刪除）／staff（一般）／viewer（唯讀）
-- 可重複執行：已存在的成員只更新角色與名稱。
-- =====================================================================
insert into public.app_members (user_id, role, display_name, icon)
select u.id, m.role, m.display_name, m.icon
from (values
  ('owner@example.com',  'admin',  '老闆', 'kitty.png'),
  ('staff1@example.com', 'staff',  '小美', 'chick.png'),
  ('viewer@example.com', 'viewer', '查看', 'snail.png')
) as m(email, role, display_name, icon)
join auth.users u on lower(u.email) = lower(m.email)
on conflict (user_id) do update set role = excluded.role, display_name = excluded.display_name, is_active = true;

select u.email, m.role, m.display_name from public.app_members m join auth.users u on u.id = m.user_id order by m.role, u.email;
