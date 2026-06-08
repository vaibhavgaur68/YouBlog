// ============================================================
//  INKBLOT — app.js
//  Shared Supabase client + auth + utilities
//  Include this FIRST on every page via:
//  <script src="app.js"></script>
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ────────────────────────────────────────────────────────────
// CONFIG — replace with your Supabase project values
// ────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://fpiupnbqtpwefmctprtx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwaXVwbmJxdHB3ZWZtY3RwcnR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MjU3MjcsImV4cCI6MjA5NjUwMTcyN30.Zl6lDmovzVGgexcZzSMqZRvKl9H4wd7Hh1RO5QZ6Pkk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});


// ────────────────────────────────────────────────────────────
// AUTH HELPERS
// ────────────────────────────────────────────────────────────

/** Returns the current session or null */
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Returns the current user or null */
export async function getUser() {
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

/** Returns the current user's profile row or null */
export async function getMyProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  return data;
}

/**
 * Sign up with email + password.
 * Pass { username, display_name } in meta.
 */
export async function signUp(email, password, meta = {}) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: meta },
  });
  return { data, error };
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/auth.html';
}

/**
 * Guard: redirect to auth if not logged in.
 * Call at top of any protected page.
 */
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/auth.html';
    return null;
  }
  return session.user;
}

/**
 * Guard: redirect to feed if already logged in.
 * Call on auth.html.
 */
export async function redirectIfAuthed() {
  const session = await getSession();
  if (session) window.location.href = '/index.html';
}


// ────────────────────────────────────────────────────────────
// PROFILE HELPERS
// ────────────────────────────────────────────────────────────

export async function getProfile(usernameOrId) {
  const isUuid = /^[0-9a-f-]{36}$/.test(usernameOrId);
  const { data, error } = await supabase
    .from('profile_stats')
    .select('*')
    .eq(isUuid ? 'id' : 'username', usernameOrId)
    .single();
  return { data, error };
}

export async function updateProfile(updates) {
  const user = await getUser();
  if (!user) return { error: { message: 'Not authenticated' } };
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id)
    .select()
    .single();
  return { data, error };
}

export async function uploadAvatar(file) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const ext = file.name.split('.').pop();
  const path = `${user.id}/avatar.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: true });
  if (uploadError) return { error: uploadError };
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  await updateProfile({ avatar_url: data.publicUrl });
  return { url: data.publicUrl };
}


// ────────────────────────────────────────────────────────────
// BLOG HELPERS
// ────────────────────────────────────────────────────────────

/** Fetch paginated published feed */
export async function getFeed({ page = 0, limit = 10, tag = null } = {}) {
  let query = supabase
    .from('blog_feed')
    .select('*')
    .order('published_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);
  if (tag) query = query.contains('tags', [tag]);
  const { data, error } = await query;
  return { data, error };
}

/** Fetch blogs from accounts the current user follows */
export async function getFollowingFeed({ page = 0, limit = 10 } = {}) {
  const user = await getUser();
  if (!user) return { data: [], error: null };
  const { data: follows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', user.id);
  if (!follows?.length) return { data: [], error: null };
  const ids = follows.map(f => f.following_id);
  const { data, error } = await supabase
    .from('blog_feed')
    .select('*')
    .in('author_id', ids)
    .order('published_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);
  return { data, error };
}

/** Fetch a single blog by slug (increments view_count) */
export async function getBlog(slug) {
  const { data, error } = await supabase
    .from('blog_feed')
    .select('*')
    .eq('slug', slug)
    .single();
  if (data) {
    // fire-and-forget view increment
    supabase.from('blogs')
      .update({ view_count: (data.view_count ?? 0) + 1 })
      .eq('id', data.id)
      .then(() => {});
  }
  return { data, error };
}

/** Create or update a blog */
export async function saveBlog(fields, blogId = null) {
  const user = await getUser();
  if (!user) return { error: { message: 'Not authenticated' } };
  // Auto-generate slug if new
  if (!blogId && !fields.slug) {
    const base = slugify(fields.title);
    const rand = Math.random().toString(36).slice(2, 6);
    fields.slug = `${base}-${rand}`;
  }
  const payload = { ...fields, author_id: user.id };
  if (blogId) {
    const { data, error } = await supabase
      .from('blogs').update(payload).eq('id', blogId).select().single();
    return { data, error };
  } else {
    const { data, error } = await supabase
      .from('blogs').insert(payload).select().single();
    return { data, error };
  }
}

export async function deleteBlog(blogId) {
  const { error } = await supabase.from('blogs').delete().eq('id', blogId);
  return { error };
}

/** Publish a draft blog */
export async function publishBlog(blogId) {
  const { data, error } = await supabase
    .from('blogs')
    .update({ status: 'published' })
    .eq('id', blogId)
    .select()
    .single();
  return { data, error };
}

/** Full-text search on blogs */
export async function searchBlogs(query, { page = 0, limit = 10 } = {}) {
  const { data, error } = await supabase
    .from('blog_feed')
    .select('*')
    .textSearch('title', query, { type: 'websearch', config: 'english' })
    .range(page * limit, page * limit + limit - 1);
  return { data, error };
}

/** Get blogs by a specific user */
export async function getUserBlogs(userId, { drafts = false } = {}) {
  let query = supabase
    .from('blogs')
    .select(`*, profiles(username, display_name, avatar_url)`)
    .eq('author_id', userId)
    .order('created_at', { ascending: false });
  if (!drafts) query = query.eq('status', 'published');
  const { data, error } = await query;
  return { data, error };
}


// ────────────────────────────────────────────────────────────
// LIKE HELPERS
// ────────────────────────────────────────────────────────────

export async function likeBlog(blogId) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const { error } = await supabase
    .from('likes')
    .insert({ user_id: user.id, blog_id: blogId });
  return { error };
}

export async function unlikeBlog(blogId) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const { error } = await supabase
    .from('likes')
    .delete()
    .eq('user_id', user.id)
    .eq('blog_id', blogId);
  return { error };
}

export async function isLiked(blogId) {
  const user = await getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('likes')
    .select('blog_id')
    .eq('user_id', user.id)
    .eq('blog_id', blogId)
    .maybeSingle();
  return !!data;
}

/** Returns a Set of liked blog IDs for the current user (for batch feed rendering) */
export async function getMyLikedIds(blogIds) {
  const user = await getUser();
  if (!user || !blogIds?.length) return new Set();
  const { data } = await supabase
    .from('likes')
    .select('blog_id')
    .eq('user_id', user.id)
    .in('blog_id', blogIds);
  return new Set((data ?? []).map(r => r.blog_id));
}

/** Returns a Set of bookmarked blog IDs for the current user */
export async function getMyBookmarkedIds(blogIds) {
  const user = await getUser();
  if (!user || !blogIds?.length) return new Set();
  const { data } = await supabase
    .from('bookmarks')
    .select('blog_id')
    .eq('user_id', user.id)
    .in('blog_id', blogIds);
  return new Set((data ?? []).map(r => r.blog_id));
}


// ────────────────────────────────────────────────────────────
// BOOKMARK HELPERS
// ────────────────────────────────────────────────────────────

export async function toggleBookmark(blogId) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const { data: existing } = await supabase
    .from('bookmarks')
    .select('blog_id')
    .eq('user_id', user.id)
    .eq('blog_id', blogId)
    .maybeSingle();
  if (existing) {
    await supabase.from('bookmarks').delete()
      .eq('user_id', user.id).eq('blog_id', blogId);
    return { bookmarked: false };
  } else {
    await supabase.from('bookmarks').insert({ user_id: user.id, blog_id: blogId });
    return { bookmarked: true };
  }
}

export async function getMyBookmarks({ page = 0, limit = 10 } = {}) {
  const user = await getUser();
  if (!user) return { data: [] };
  const { data, error } = await supabase
    .from('bookmarks')
    .select(`blog_id, created_at, blogs(*, profiles(username, display_name, avatar_url))`)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);
  return { data, error };
}


// ────────────────────────────────────────────────────────────
// COMMENT HELPERS
// ────────────────────────────────────────────────────────────

export async function getComments(blogId) {
  const { data, error } = await supabase
    .from('comments')
    .select(`*, profiles(id, username, display_name, avatar_url)`)
    .eq('blog_id', blogId)
    .is('parent_id', null)
    .order('created_at', { ascending: true });
  return { data, error };
}

export async function getReplies(parentId) {
  const { data, error } = await supabase
    .from('comments')
    .select(`*, profiles(id, username, display_name, avatar_url)`)
    .eq('parent_id', parentId)
    .order('created_at', { ascending: true });
  return { data, error };
}

export async function postComment(blogId, content, parentId = null) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const { data, error } = await supabase
    .from('comments')
    .insert({ blog_id: blogId, author_id: user.id, content, parent_id: parentId })
    .select(`*, profiles(id, username, display_name, avatar_url)`)
    .single();
  return { data, error };
}

export async function deleteComment(commentId) {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  return { error };
}

export async function likeComment(commentId) {
  const user = await getUser();
  if (!user) return;
  const { data: existing } = await supabase
    .from('comment_likes')
    .select('comment_id').eq('user_id', user.id).eq('comment_id', commentId).maybeSingle();
  if (existing) {
    await supabase.from('comment_likes').delete()
      .eq('user_id', user.id).eq('comment_id', commentId);
    return { liked: false };
  } else {
    await supabase.from('comment_likes').insert({ user_id: user.id, comment_id: commentId });
    return { liked: true };
  }
}


// ────────────────────────────────────────────────────────────
// FOLLOW HELPERS
// ────────────────────────────────────────────────────────────

export async function followUser(targetId) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const { error } = await supabase
    .from('follows')
    .insert({ follower_id: user.id, following_id: targetId });
  return { error };
}

export async function unfollowUser(targetId) {
  const user = await getUser();
  if (!user) return { error: 'Not authenticated' };
  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', user.id)
    .eq('following_id', targetId);
  return { error };
}

export async function isFollowing(targetId) {
  const user = await getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', user.id)
    .eq('following_id', targetId)
    .maybeSingle();
  return !!data;
}


// ────────────────────────────────────────────────────────────
// NOTIFICATION HELPERS
// ────────────────────────────────────────────────────────────

export async function getNotifications({ limit = 20 } = {}) {
  const user = await getUser();
  if (!user) return { data: [] };
  const { data, error } = await supabase
    .from('notifications')
    .select(`*, actor:profiles!actor_id(username, display_name, avatar_url), blogs(title, slug)`)
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { data, error };
}

export async function markAllNotificationsRead() {
  const user = await getUser();
  if (!user) return;
  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('recipient_id', user.id)
    .eq('is_read', false);
}

export async function getUnreadNotificationCount() {
  const user = await getUser();
  if (!user) return 0;
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', user.id)
    .eq('is_read', false);
  return count ?? 0;
}


// ────────────────────────────────────────────────────────────
// REALTIME SUBSCRIPTIONS
// ────────────────────────────────────────────────────────────

/**
 * Subscribe to realtime comments for a blog.
 * callback(payload) is called on INSERT/DELETE.
 */
export function subscribeToComments(blogId, callback) {
  return supabase
    .channel(`comments:${blogId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'comments',
      filter: `blog_id=eq.${blogId}`,
    }, callback)
    .subscribe();
}

/**
 * Subscribe to like count changes for a blog.
 */
export function subscribeToBlogLikes(blogId, callback) {
  return supabase
    .channel(`blog_likes:${blogId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'likes',
      filter: `blog_id=eq.${blogId}`,
    }, callback)
    .subscribe();
}

/**
 * Subscribe to new notifications for the current user.
 */
export async function subscribeToNotifications(callback) {
  const user = await getUser();
  if (!user) return null;
  return supabase
    .channel(`notifications:${user.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `recipient_id=eq.${user.id}`,
    }, callback)
    .subscribe();
}

/**
 * Subscribe to new published blogs (global feed updates).
 */
export function subscribeToFeed(callback) {
  return supabase
    .channel('feed:new_blogs')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'blogs',
      filter: `status=eq.published`,
    }, callback)
    .subscribe();
}

/** Unsubscribe a channel */
export function unsubscribe(channel) {
  if (channel) supabase.removeChannel(channel);
}


// ────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────────────────────

/** Convert a string to a url-safe slug */
export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** Format a number for display: 1200 → "1.2k" */
export function formatCount(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/** Relative time: "3 min ago", "2 days ago" */
export function timeAgo(dateStr) {
  const now  = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60)        return 'just now';
  if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000)   return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 31536000)  return `${Math.floor(diff / 2592000)}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}

/** Returns initials from a display name (for avatar fallback) */
export function initials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

/**
 * Debounce a function.
 * Usage: const dSearch = debounce(search, 400);
 */
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Strip HTML tags for plain-text previews */
export function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

/** Clamp text to N characters with ellipsis */
export function truncate(str, n = 120) {
  if (!str) return '';
  const plain = stripHtml(str);
  return plain.length > n ? plain.slice(0, n).trimEnd() + '…' : plain;
}

/** Show a toast notification */
export function toast(message, type = 'info') {
  // Remove any existing toast
  document.querySelector('.ib-toast')?.remove();
  const el = document.createElement('div');
  el.className = `ib-toast ib-toast--${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('ib-toast--show'));
  setTimeout(() => {
    el.classList.remove('ib-toast--show');
    setTimeout(() => el.remove(), 400);
  }, 3000);
}

/** Navigate to a page */
export function navigate(path) {
  window.location.href = path;
}

/** Build a cover image URL from Supabase Storage */
export function coverUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const { data } = supabase.storage.from('covers').getPublicUrl(path);
  return data.publicUrl;
}

/** Upload a cover image and return the public URL */
export async function uploadCover(file, blogId) {
  const ext = file.name.split('.').pop();
  const path = `${blogId}/cover.${ext}`;
  const { error } = await supabase.storage
    .from('covers')
    .upload(path, file, { upsert: true });
  if (error) return { error };
  const { data } = supabase.storage.from('covers').getPublicUrl(path);
  return { url: data.publicUrl };
}

/** Global error handler for Supabase errors */
export function handleError(error, fallback = 'Something went wrong') {
  if (!error) return;
  console.error('[INKBLOT]', error);
  toast(error.message || fallback, 'error');
}

// ────────────────────────────────────────────────────────────
// GLOBAL AUTH STATE LISTENER
// Sets window.__inkblot_user and dispatches 'inkblot:authchange'
// ────────────────────────────────────────────────────────────
supabase.auth.onAuthStateChange((event, session) => {
  window.__inkblot_user = session?.user ?? null;
  window.dispatchEvent(new CustomEvent('inkblot:authchange', {
    detail: { event, user: window.__inkblot_user }
  }));
});

// Expose on window for non-module pages (optional convenience)
window.IB = {
  supabase, getSession, getUser, getMyProfile, signUp, signIn, signOut,
  requireAuth, redirectIfAuthed, getProfile, updateProfile, uploadAvatar,
  getFeed, getFollowingFeed, getBlog, saveBlog, deleteBlog, publishBlog,
  searchBlogs, getUserBlogs, likeBlog, unlikeBlog, isLiked,
  getMyLikedIds, getMyBookmarkedIds, toggleBookmark, getMyBookmarks,
  getComments, getReplies, postComment, deleteComment, likeComment,
  followUser, unfollowUser, isFollowing,
  getNotifications, markAllNotificationsRead, getUnreadNotificationCount,
  subscribeToComments, subscribeToBlogLikes, subscribeToNotifications,
  subscribeToFeed, unsubscribe,
  slugify, formatCount, timeAgo, initials, debounce,
  stripHtml, truncate, toast, navigate, coverUrl, uploadCover, handleError,
};
