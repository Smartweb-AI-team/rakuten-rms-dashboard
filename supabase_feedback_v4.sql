-- ============================================================
-- v4: 멤버별 楽天 RMS Cookie 저장 (자동 로그인 전환용)
-- Supabase Dashboard → SQL Editor 에서 1회 실행
-- ============================================================

create table if not exists public.member_rakuten_cookies (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  user_email  text,
  shop_id     text,
  cookies     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.member_rakuten_cookies enable row level security;

-- 본인 row 만 읽기/쓰기
drop policy if exists "mrc_select_own" on public.member_rakuten_cookies;
drop policy if exists "mrc_upsert_own" on public.member_rakuten_cookies;
drop policy if exists "mrc_update_own" on public.member_rakuten_cookies;
drop policy if exists "mrc_delete_own" on public.member_rakuten_cookies;
create policy "mrc_select_own" on public.member_rakuten_cookies for select to authenticated using (auth.uid() = user_id);
create policy "mrc_upsert_own" on public.member_rakuten_cookies for insert to authenticated with check (auth.uid() = user_id);
create policy "mrc_update_own" on public.member_rakuten_cookies for update to authenticated using (auth.uid() = user_id);
create policy "mrc_delete_own" on public.member_rakuten_cookies for delete to authenticated using (auth.uid() = user_id);

-- updated_at 자동
drop trigger if exists mrc_touch_updated on public.member_rakuten_cookies;
create trigger mrc_touch_updated before update on public.member_rakuten_cookies
  for each row execute function public._touch_updated_at();
