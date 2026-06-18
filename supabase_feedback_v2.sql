-- ============================================================
-- お問い合わせ v2: 이모지 리액션 + 글 고정
-- Supabase Dashboard → SQL Editor 에서 1회 실행 (v1 다음 실행)
-- ============================================================

-- ① 글 고정 (관리자만 토글)
alter table public.feedback_posts add column if not exists pinned boolean not null default false;
create index if not exists feedback_posts_pinned_idx on public.feedback_posts (pinned) where pinned = true;

-- ② 리액션 테이블 (글 또는 답글)
create table if not exists public.feedback_reactions (
  id          bigserial primary key,
  post_id     bigint references public.feedback_posts(id)   on delete cascade,
  reply_id    bigint references public.feedback_replies(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji       text not null,
  created_at  timestamptz not null default now(),
  -- 한 대상(post 또는 reply)에 한 이모지 한 번
  constraint feedback_reactions_target_check
    check ((post_id is not null and reply_id is null) or (post_id is null and reply_id is not null))
);

create unique index if not exists feedback_reactions_unique_post
  on public.feedback_reactions (user_id, post_id, emoji) where post_id is not null;
create unique index if not exists feedback_reactions_unique_reply
  on public.feedback_reactions (user_id, reply_id, emoji) where reply_id is not null;
create index if not exists feedback_reactions_post_idx  on public.feedback_reactions (post_id);
create index if not exists feedback_reactions_reply_idx on public.feedback_reactions (reply_id);

alter table public.feedback_reactions enable row level security;

drop policy if exists "fre_read_all"   on public.feedback_reactions;
drop policy if exists "fre_insert_own" on public.feedback_reactions;
drop policy if exists "fre_delete_own" on public.feedback_reactions;
create policy "fre_read_all"   on public.feedback_reactions for select to authenticated using (true);
create policy "fre_insert_own" on public.feedback_reactions for insert to authenticated with check (auth.uid() = user_id);
create policy "fre_delete_own" on public.feedback_reactions for delete to authenticated using (auth.uid() = user_id);

-- ③ Realtime 활성화 (Supabase Dashboard → Database → Replication 에서도 활성화 필요)
alter publication supabase_realtime add table public.feedback_posts;
alter publication supabase_realtime add table public.feedback_replies;
alter publication supabase_realtime add table public.feedback_reactions;
