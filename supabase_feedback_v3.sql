-- ============================================================
-- お問い合わせ v3: 관리자 권한 (admin_users 테이블)
-- Supabase Dashboard → SQL Editor 에서 1회 실행
-- ============================================================

-- ① 관리자 이메일 화이트리스트 (간단·안전)
create table if not exists public.admin_users (
  email text primary key,
  added_at timestamptz not null default now()
);

-- ★ 사용자 본인 이메일 등록 (LOGIN_DOMAIN 사용 중이면 가짜 도메인)
insert into public.admin_users (email) values ('paku@smartweb.local')
  on conflict (email) do nothing;

-- 누구나 (인증된 사용자) 관리자 목록 읽기 가능 (UI 가 admin 표시용)
alter table public.admin_users enable row level security;
drop policy if exists "admin_read_all" on public.admin_users;
create policy "admin_read_all" on public.admin_users for select to authenticated using (true);

-- ② 관리자 전용 정책: 모든 글/답글/리액션 update + delete
-- 글
drop policy if exists "fp_admin_update" on public.feedback_posts;
drop policy if exists "fp_admin_delete" on public.feedback_posts;
create policy "fp_admin_update" on public.feedback_posts for update to authenticated using (
  exists (select 1 from public.admin_users where email = auth.jwt() ->> 'email')
);
create policy "fp_admin_delete" on public.feedback_posts for delete to authenticated using (
  exists (select 1 from public.admin_users where email = auth.jwt() ->> 'email')
);

-- 답글
drop policy if exists "fr_admin_update" on public.feedback_replies;
drop policy if exists "fr_admin_delete" on public.feedback_replies;
create policy "fr_admin_update" on public.feedback_replies for update to authenticated using (
  exists (select 1 from public.admin_users where email = auth.jwt() ->> 'email')
);
create policy "fr_admin_delete" on public.feedback_replies for delete to authenticated using (
  exists (select 1 from public.admin_users where email = auth.jwt() ->> 'email')
);

-- 리액션
drop policy if exists "fre_admin_delete" on public.feedback_reactions;
create policy "fre_admin_delete" on public.feedback_reactions for delete to authenticated using (
  exists (select 1 from public.admin_users where email = auth.jwt() ->> 'email')
);

-- 추가 관리자가 필요하면:
-- insert into public.admin_users (email) values ('another@smartweb.local');
