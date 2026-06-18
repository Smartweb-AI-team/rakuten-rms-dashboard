-- ============================================================
-- フィードバック / Q&A 게시판 스키마
-- Supabase Dashboard → SQL Editor 에서 1회 실행
-- ============================================================

-- ---------- ① 글 (posts) ----------
create table if not exists public.feedback_posts (
  id          bigserial primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  user_email  text,
  title       text not null,
  body        text not null,
  category    text not null default 'question'
              check (category in ('question','bug','feature','other')),
  status      text not null default 'open'
              check (status in ('open','answered','resolved','wont_fix')),
  attachment_paths text[] not null default array[]::text[],
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists feedback_posts_created_at_idx on public.feedback_posts (created_at desc);
create index if not exists feedback_posts_category_idx   on public.feedback_posts (category);
create index if not exists feedback_posts_status_idx     on public.feedback_posts (status);

-- ---------- ② 답글 (replies) ----------
create table if not exists public.feedback_replies (
  id          bigserial primary key,
  post_id     bigint not null references public.feedback_posts(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  user_email  text,
  body        text not null,
  attachment_paths text[] not null default array[]::text[],
  created_at  timestamptz not null default now()
);

create index if not exists feedback_replies_post_id_idx on public.feedback_replies (post_id);

-- ---------- ③ RLS (Row Level Security) ----------
alter table public.feedback_posts   enable row level security;
alter table public.feedback_replies enable row level security;

-- 로그인된 사용자: 모든 글/답글 읽기
drop policy if exists "fp_read_all"  on public.feedback_posts;
drop policy if exists "fr_read_all"  on public.feedback_replies;
create policy "fp_read_all" on public.feedback_posts   for select to authenticated using (true);
create policy "fr_read_all" on public.feedback_replies for select to authenticated using (true);

-- 로그인된 사용자: 본인 글 작성
drop policy if exists "fp_insert_own" on public.feedback_posts;
drop policy if exists "fr_insert_own" on public.feedback_replies;
create policy "fp_insert_own" on public.feedback_posts   for insert to authenticated with check (auth.uid() = user_id);
create policy "fr_insert_own" on public.feedback_replies for insert to authenticated with check (auth.uid() = user_id);

-- 본인 글만 수정/삭제
drop policy if exists "fp_update_own" on public.feedback_posts;
drop policy if exists "fp_delete_own" on public.feedback_posts;
drop policy if exists "fr_update_own" on public.feedback_replies;
drop policy if exists "fr_delete_own" on public.feedback_replies;
create policy "fp_update_own" on public.feedback_posts   for update to authenticated using (auth.uid() = user_id);
create policy "fp_delete_own" on public.feedback_posts   for delete to authenticated using (auth.uid() = user_id);
create policy "fr_update_own" on public.feedback_replies for update to authenticated using (auth.uid() = user_id);
create policy "fr_delete_own" on public.feedback_replies for delete to authenticated using (auth.uid() = user_id);

-- ---------- ④ updated_at 자동 갱신 트리거 ----------
create or replace function public._touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists fp_touch_updated on public.feedback_posts;
create trigger fp_touch_updated before update on public.feedback_posts
  for each row execute function public._touch_updated_at();

-- ---------- ⑤ Storage Bucket: スクリーンショット첨부 ----------
-- (Supabase Dashboard → Storage → New bucket 「feedback-attachments」 public 체크 도 가능)
insert into storage.buckets (id, name, public)
  values ('feedback-attachments', 'feedback-attachments', true)
  on conflict (id) do update set public = true;

-- 인증된 사용자만 업로드. 누구나 (public bucket) 읽기.
drop policy if exists "feedback_storage_upload" on storage.objects;
create policy "feedback_storage_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'feedback-attachments');

drop policy if exists "feedback_storage_delete_own" on storage.objects;
create policy "feedback_storage_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'feedback-attachments' and owner = auth.uid());
