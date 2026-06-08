-- ============================================================
--  INKBLOT — Supabase SQL Schema
--  Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 0. EXTENSIONS
-- ────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- for full-text search on blogs


-- ────────────────────────────────────────────────────────────
-- 1. PROFILES
--    Extends auth.users with public display data.
-- ────────────────────────────────────────────────────────────
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  display_name  text,
  bio           text,
  avatar_url    text,
  website       text,
  created_at    timestamptz default now() not null,
  updated_at    timestamptz default now() not null
);

-- Auto-create a profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', null)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();


-- ────────────────────────────────────────────────────────────
-- 2. FOLLOWS
-- ────────────────────────────────────────────────────────────
create table public.follows (
  follower_id   uuid not null references public.profiles(id) on delete cascade,
  following_id  uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz default now() not null,
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create index follows_follower_idx  on public.follows(follower_id);
create index follows_following_idx on public.follows(following_id);


-- ────────────────────────────────────────────────────────────
-- 3. BLOGS
-- ────────────────────────────────────────────────────────────
create type blog_status as enum ('draft', 'published');

create table public.blogs (
  id            uuid primary key default uuid_generate_v4(),
  author_id     uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  slug          text unique not null,
  subtitle      text,
  cover_url     text,
  content       text not null,          -- stored as HTML or Markdown
  tags          text[] default '{}',
  status        blog_status default 'draft',
  read_time     int generated always as (greatest(1, (length(content) / 1000))) stored,
  like_count    int default 0 not null,
  comment_count int default 0 not null,
  view_count    int default 0 not null,
  published_at  timestamptz,
  created_at    timestamptz default now() not null,
  updated_at    timestamptz default now() not null
);

create index blogs_author_idx     on public.blogs(author_id);
create index blogs_status_idx     on public.blogs(status);
create index blogs_published_idx  on public.blogs(published_at desc) where status = 'published';
create index blogs_tags_idx       on public.blogs using gin(tags);
-- Full-text search index
create index blogs_fts_idx on public.blogs
  using gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(subtitle,'') || ' ' || coalesce(content,'')));

create trigger blogs_updated_at
  before update on public.blogs
  for each row execute procedure public.set_updated_at();

-- Auto-set published_at when status changes to published
create or replace function public.handle_blog_publish()
returns trigger language plpgsql as $$
begin
  if new.status = 'published' and (old.status is distinct from 'published') then
    new.published_at = now();
  end if;
  return new;
end;
$$;

create trigger blogs_publish
  before update on public.blogs
  for each row execute procedure public.handle_blog_publish();

-- Helper: generate a url-safe slug from title
create or replace function public.slugify(text)
returns text language sql immutable strict as $$
  select lower(regexp_replace(regexp_replace($1, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));
$$;


-- ────────────────────────────────────────────────────────────
-- 4. LIKES
-- ────────────────────────────────────────────────────────────
create table public.likes (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  blog_id    uuid not null references public.blogs(id) on delete cascade,
  created_at timestamptz default now() not null,
  primary key (user_id, blog_id)
);

create index likes_blog_idx on public.likes(blog_id);
create index likes_user_idx on public.likes(user_id);

-- Keep like_count in sync
create or replace function public.update_like_count()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    update public.blogs set like_count = like_count + 1 where id = new.blog_id;
  elsif TG_OP = 'DELETE' then
    update public.blogs set like_count = greatest(0, like_count - 1) where id = old.blog_id;
  end if;
  return null;
end;
$$;

create trigger likes_count_insert
  after insert on public.likes
  for each row execute procedure public.update_like_count();

create trigger likes_count_delete
  after delete on public.likes
  for each row execute procedure public.update_like_count();


-- ────────────────────────────────────────────────────────────
-- 5. COMMENTS
-- ────────────────────────────────────────────────────────────
create table public.comments (
  id          uuid primary key default uuid_generate_v4(),
  blog_id     uuid not null references public.blogs(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  parent_id   uuid references public.comments(id) on delete cascade, -- for threaded replies
  content     text not null,
  like_count  int default 0 not null,
  created_at  timestamptz default now() not null,
  updated_at  timestamptz default now() not null
);

create index comments_blog_idx    on public.comments(blog_id);
create index comments_author_idx  on public.comments(author_id);
create index comments_parent_idx  on public.comments(parent_id);

create trigger comments_updated_at
  before update on public.comments
  for each row execute procedure public.set_updated_at();

-- Keep comment_count in sync
create or replace function public.update_comment_count()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    update public.blogs set comment_count = comment_count + 1 where id = new.blog_id;
  elsif TG_OP = 'DELETE' then
    update public.blogs set comment_count = greatest(0, comment_count - 1) where id = old.blog_id;
  end if;
  return null;
end;
$$;

create trigger comments_count_insert
  after insert on public.comments
  for each row execute procedure public.update_comment_count();

create trigger comments_count_delete
  after delete on public.comments
  for each row execute procedure public.update_comment_count();


-- ────────────────────────────────────────────────────────────
-- 6. COMMENT LIKES  (separate from blog likes)
-- ────────────────────────────────────────────────────────────
create table public.comment_likes (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  comment_id uuid not null references public.comments(id) on delete cascade,
  created_at timestamptz default now() not null,
  primary key (user_id, comment_id)
);

create or replace function public.update_comment_like_count()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    update public.comments set like_count = like_count + 1 where id = new.comment_id;
  elsif TG_OP = 'DELETE' then
    update public.comments set like_count = greatest(0, like_count - 1) where id = old.comment_id;
  end if;
  return null;
end;
$$;

create trigger comment_likes_count_insert
  after insert on public.comment_likes
  for each row execute procedure public.update_comment_like_count();

create trigger comment_likes_count_delete
  after delete on public.comment_likes
  for each row execute procedure public.update_comment_like_count();


-- ────────────────────────────────────────────────────────────
-- 7. NOTIFICATIONS
-- ────────────────────────────────────────────────────────────
create type notification_type as enum (
  'new_follower', 'blog_like', 'blog_comment', 'comment_reply', 'comment_like'
);

create table public.notifications (
  id            uuid primary key default uuid_generate_v4(),
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  actor_id      uuid references public.profiles(id) on delete set null,
  type          notification_type not null,
  blog_id       uuid references public.blogs(id) on delete cascade,
  comment_id    uuid references public.comments(id) on delete cascade,
  is_read       boolean default false not null,
  created_at    timestamptz default now() not null
);

create index notifications_recipient_idx on public.notifications(recipient_id, is_read, created_at desc);

-- Trigger: notify on follow
create or replace function public.notify_on_follow()
returns trigger language plpgsql security definer as $$
begin
  insert into public.notifications (recipient_id, actor_id, type)
  values (new.following_id, new.follower_id, 'new_follower');
  return new;
end;
$$;

create trigger follows_notify
  after insert on public.follows
  for each row execute procedure public.notify_on_follow();

-- Trigger: notify on blog like
create or replace function public.notify_on_like()
returns trigger language plpgsql security definer as $$
declare v_author uuid;
begin
  select author_id into v_author from public.blogs where id = new.blog_id;
  if v_author <> new.user_id then
    insert into public.notifications (recipient_id, actor_id, type, blog_id)
    values (v_author, new.user_id, 'blog_like', new.blog_id);
  end if;
  return new;
end;
$$;

create trigger likes_notify
  after insert on public.likes
  for each row execute procedure public.notify_on_like();

-- Trigger: notify on comment
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer as $$
declare v_author uuid;
begin
  -- Notify blog author
  select author_id into v_author from public.blogs where id = new.blog_id;
  if v_author <> new.author_id then
    insert into public.notifications (recipient_id, actor_id, type, blog_id, comment_id)
    values (v_author, new.author_id, 'blog_comment', new.blog_id, new.id);
  end if;
  -- If reply, also notify parent comment author
  if new.parent_id is not null then
    declare v_parent_author uuid;
    begin
      select author_id into v_parent_author from public.comments where id = new.parent_id;
      if v_parent_author <> new.author_id then
        insert into public.notifications (recipient_id, actor_id, type, blog_id, comment_id)
        values (v_parent_author, new.author_id, 'comment_reply', new.blog_id, new.id);
      end if;
    end;
  end if;
  return new;
end;
$$;

create trigger comments_notify
  after insert on public.comments
  for each row execute procedure public.notify_on_comment();


-- ────────────────────────────────────────────────────────────
-- 8. BOOKMARKS
-- ────────────────────────────────────────────────────────────
create table public.bookmarks (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  blog_id    uuid not null references public.blogs(id) on delete cascade,
  created_at timestamptz default now() not null,
  primary key (user_id, blog_id)
);

create index bookmarks_user_idx on public.bookmarks(user_id, created_at desc);


-- ────────────────────────────────────────────────────────────
-- 9. STORAGE BUCKET (run separately in Supabase dashboard
--    or uncomment if using service role)
-- ────────────────────────────────────────────────────────────
-- insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
-- insert into storage.buckets (id, name, public) values ('covers', 'covers', true);


-- ────────────────────────────────────────────────────────────
-- 10. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────

-- PROFILES
alter table public.profiles enable row level security;
create policy "Profiles are viewable by everyone"          on public.profiles for select using (true);
create policy "Users can insert their own profile"         on public.profiles for insert with check (auth.uid() = id);
create policy "Users can update their own profile"         on public.profiles for update using (auth.uid() = id);

-- BLOGS
alter table public.blogs enable row level security;
create policy "Published blogs are viewable by everyone"   on public.blogs for select using (status = 'published' or auth.uid() = author_id);
create policy "Authenticated users can create blogs"       on public.blogs for insert with check (auth.uid() = author_id);
create policy "Authors can update their own blogs"         on public.blogs for update using (auth.uid() = author_id);
create policy "Authors can delete their own blogs"         on public.blogs for delete using (auth.uid() = author_id);

-- FOLLOWS
alter table public.follows enable row level security;
create policy "Follows are viewable by everyone"           on public.follows for select using (true);
create policy "Authenticated users can follow"             on public.follows for insert with check (auth.uid() = follower_id);
create policy "Users can unfollow"                         on public.follows for delete using (auth.uid() = follower_id);

-- LIKES
alter table public.likes enable row level security;
create policy "Likes are viewable by everyone"             on public.likes for select using (true);
create policy "Authenticated users can like"               on public.likes for insert with check (auth.uid() = user_id);
create policy "Users can unlike"                           on public.likes for delete using (auth.uid() = user_id);

-- COMMENTS
alter table public.comments enable row level security;
create policy "Comments are viewable by everyone"          on public.comments for select using (true);
create policy "Authenticated users can comment"            on public.comments for insert with check (auth.uid() = author_id);
create policy "Authors can update their own comments"      on public.comments for update using (auth.uid() = author_id);
create policy "Authors can delete their own comments"      on public.comments for delete using (auth.uid() = author_id);

-- COMMENT LIKES
alter table public.comment_likes enable row level security;
create policy "Comment likes viewable by everyone"         on public.comment_likes for select using (true);
create policy "Authenticated users can like comments"      on public.comment_likes for insert with check (auth.uid() = user_id);
create policy "Users can unlike comments"                  on public.comment_likes for delete using (auth.uid() = user_id);

-- NOTIFICATIONS
alter table public.notifications enable row level security;
create policy "Users can see their own notifications"      on public.notifications for select using (auth.uid() = recipient_id);
create policy "Users can mark notifications as read"       on public.notifications for update using (auth.uid() = recipient_id);
create policy "System can insert notifications"            on public.notifications for insert with check (true);

-- BOOKMARKS
alter table public.bookmarks enable row level security;
create policy "Users can see their own bookmarks"          on public.bookmarks for select using (auth.uid() = user_id);
create policy "Users can bookmark"                         on public.bookmarks for insert with check (auth.uid() = user_id);
create policy "Users can remove bookmarks"                 on public.bookmarks for delete using (auth.uid() = user_id);


-- ────────────────────────────────────────────────────────────
-- 11. REALTIME
--    Enable realtime for the tables that need live updates
-- ────────────────────────────────────────────────────────────
-- Run these in Supabase Dashboard → Database → Replication
-- or via the SQL editor:

begin;
  -- Add tables to supabase_realtime publication
  alter publication supabase_realtime add table public.blogs;
  alter publication supabase_realtime add table public.likes;
  alter publication supabase_realtime add table public.comments;
  alter publication supabase_realtime add table public.comment_likes;
  alter publication supabase_realtime add table public.follows;
  alter publication supabase_realtime add table public.notifications;
commit;


-- ────────────────────────────────────────────────────────────
-- 12. USEFUL VIEWS
-- ────────────────────────────────────────────────────────────

-- Feed view: published blogs with author info
create or replace view public.blog_feed as
  select
    b.*,
    p.username,
    p.display_name,
    p.avatar_url,
    (select count(*) from public.follows where following_id = b.author_id) as follower_count
  from public.blogs b
  join public.profiles p on p.id = b.author_id
  where b.status = 'published'
  order by b.published_at desc;

-- Profile stats view
create or replace view public.profile_stats as
  select
    p.*,
    (select count(*) from public.follows    where following_id = p.id) as follower_count,
    (select count(*) from public.follows    where follower_id  = p.id) as following_count,
    (select count(*) from public.blogs      where author_id    = p.id and status = 'published') as blog_count
  from public.profiles p;
