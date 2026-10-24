/**
 * 存储驱动：LocalStore（本地 JSON，开发预览用）/ SupabaseStore（QW Pages 运行时注入凭证后自动启用）
 * 两套驱动暴露完全相同的异步接口，业务代码无感切换。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const genId = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

/* ---------------- Local JSON Store ---------------- */
class LocalStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.imgDir = path.join(dataDir, 'images');
    fs.mkdirSync(this.imgDir, { recursive: true });
    this.db = { posts: [], comments: [], likes: [], images: [], settings: {}, links: [], visitors: [] };
    if (fs.existsSync(this.file)) {
      try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { /* 损坏则重建 */ }
    }
    // 兼容旧数据：评论补齐 status，补齐 links 容器
    for (const c of this.db.comments) if (!c.status) c.status = 'visible';
    if (!Array.isArray(this.db.links)) this.db.links = [];
    if (!Array.isArray(this.db.visitors)) this.db.visitors = []; // 旧快照里没有该表，补齐
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }
  async listPosts(includeDrafts) {
    return this.db.posts
      .filter((p) => includeDrafts || p.status === 'published')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((p) => ({ ...p, images: [...(p.images || [])] }));
  }
  async getPost(id) {
    const p = this.db.posts.find((x) => x.id === id);
    return p ? { ...p, images: [...(p.images || [])] } : null;
  }
  async createPost(fields) {
    const row = {
      id: genId('post'),
      content: fields.content || '',
      location: fields.location || null,
      images: fields.images || [],
      status: fields.status || 'published',
      created_at: fields.created_at || new Date().toISOString(),
    };
    this.db.posts.push(row);
    this._save();
    return { ...row, images: [...row.images] };
  }
  async updatePost(id, patch) {
    const p = this.db.posts.find((x) => x.id === id);
    if (!p) return null;
    for (const k of ['content', 'location', 'images', 'status']) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    this._save();
    return { ...p, images: [...(p.images || [])] };
  }
  async deletePost(id) {
    this.db.posts = this.db.posts.filter((x) => x.id !== id);
    this.db.comments = this.db.comments.filter((c) => c.post_id !== id);
    this.db.likes = this.db.likes.filter((l) => l.post_id !== id);
    this._save();
  }
  async countPosts() { return this.db.posts.length; }

  /* 独立访客：只存加盐哈希，不落原始 IP。返回计入后的总数。 */
  async touchVisitor(hash) {
    if (!this.db.visitors.some((v) => v.hash === hash)) {
      this.db.visitors.push({ hash, first_seen: new Date().toISOString() });
      this._save();
    }
    return this.db.visitors.length;
  }
  async countVisitors() { return this.db.visitors.length; }
  // 迁移用：一次性并入既有访客哈希（去重，避免逐个 touch 造成 N 次往返）
  async seedVisitors(hashes) {
    const have = new Set(this.db.visitors.map((v) => v.hash));
    let added = 0;
    for (const h of hashes || []) { if (h && !have.has(h)) { this.db.visitors.push({ hash: h, first_seen: new Date().toISOString() }); have.add(h); added++; } }
    if (added) this._save();
    return this.db.visitors.length;
  }

  async listComments(postId) {
    return this.db.comments
      .filter((c) => c.post_id === postId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((c) => ({ ...c }));
  }
  async allComments() {
    return [...this.db.comments].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  async addComment(fields) {
    const row = {
      id: genId('cmt'),
      post_id: fields.post_id,
      name: fields.name,
      content: fields.content,
      reply_to_id: fields.reply_to_id || null,
      reply_to_name: fields.reply_to_name || null,
      client_key: fields.client_key || null,
      site: fields.site || null,
      status: fields.status || 'visible',
      flag_reason: fields.flag_reason || null,
      created_at: new Date().toISOString(),
    };
    this.db.comments.push(row);
    this._save();
    return { ...row };
  }
  async updateComment(id, content) {
    const c = this.db.comments.find((x) => x.id === id);
    if (!c) return null;
    c.content = content;
    this._save();
    return { ...c };
  }
  async updateCommentStatus(id, status, flagReason) {
    const c = this.db.comments.find((x) => x.id === id);
    if (!c) return null;
    c.status = status;
    if (flagReason !== undefined) c.flag_reason = flagReason;
    this._save();
    return { ...c };
  }
  async getComment(id) {
    const c = this.db.comments.find((x) => x.id === id);
    return c ? { ...c } : null;
  }
  async deleteComment(id) {
    this.db.comments = this.db.comments.filter((c) => c.id !== id && c.reply_to_id !== id);
    this._save();
  }

  async listLikes(postId) {
    return this.db.likes.filter((l) => l.post_id === postId).map((l) => ({ ...l }));
  }
  async allLikes() { return [...this.db.likes]; }
  // 双击可累加：不再按 (post_id, client_key) 去重，每次调用记一行
  async addLike(postId, clientKey, name) {
    this.db.likes.push({ id: genId('like'), post_id: postId, client_key: clientKey, name, created_at: new Date().toISOString() });
    this._save();
    return true;
  }
  async removeLike(postId, clientKey) {
    const before = this.db.likes.length;
    this.db.likes = this.db.likes.filter((l) => !(l.post_id === postId && l.client_key === clientKey));
    if (this.db.likes.length !== before) this._save();
  }

  async saveImage(mime, dataB64) {
    const id = genId('img');
    this.db.images.push({ id, mime, data: dataB64, created_at: new Date().toISOString() });
    this._save();
    return id;
  }
  async getImage(id) {
    const img = this.db.images.find((x) => x.id === id);
    return img ? { mime: img.mime, data: img.data } : null;
  }

  async getSettings() { return { ...(this.db.settings || {}) }; }
  async setSettings(obj) {
    this.db.settings = { ...(this.db.settings || {}), ...obj };
    this._save();
    return { ...this.db.settings };
  }

  async listLinks() {
    return this.db.links.slice().sort((a, b) => (a.sort - b.sort) || (new Date(a.created_at) - new Date(b.created_at))).map((l) => ({ ...l }));
  }
  async createLink(f) {
    const row = { id: genId('link'), name: f.name, url: f.url, descr: f.descr || '', sort: Number(f.sort) || 0, created_at: new Date().toISOString() };
    this.db.links.push(row); this._save(); return { ...row };
  }
  async updateLink(id, patch) {
    const l = this.db.links.find((x) => x.id === id); if (!l) return null;
    for (const k of ['name', 'url', 'descr', 'sort']) if (patch[k] !== undefined) l[k] = patch[k];
    this._save(); return { ...l };
  }
  async deleteLink(id) { this.db.links = this.db.links.filter((x) => x.id !== id); this._save(); }
  async deleteCommentsByIds(ids) {
    const set = new Set(ids);
    this.db.comments = this.db.comments.filter((c) => !set.has(c.id) && !set.has(c.reply_to_id));
    this._save(); return ids.length;
  }
  async deleteLinksByIds(ids) {
    const set = new Set(ids);
    this.db.links = this.db.links.filter((l) => !set.has(l.id));
    this._save(); return ids.length;
  }
}

/* ---------------- Supabase (PostgREST) Store ---------------- */
class SupabaseStore {
  constructor() {
    this.base = process.env.SUPABASE_URL.replace(/\/$/, '');
    this.key = process.env.SUPABASE_ANON_KEY;
  }
  _headers(extra) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...(extra || {}),
    };
  }
  async _req(method, url, body, extraHeaders) {
    const res = await fetch(url, {
      method,
      headers: this._headers(extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  _tb(name) { return `${this.base}/rest/v1/${name}`; }

  async listPosts(includeDrafts) {
    let url = `${this._tb('posts')}?select=*&order=created_at.desc`;
    if (!includeDrafts) url += `&status=eq.published`;
    return this._req('GET', url);
  }
  async getPost(id) {
    const rows = await this._req('GET', `${this._tb('posts')}?select=*&id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  }
  async createPost(f) {
    const rows = await this._req('POST', this._tb('posts'), [{
      content: f.content || '',
      location: f.location || null,
      images: f.images || [],
      status: f.status || 'published',
      created_at: f.created_at || new Date().toISOString(),
    }], { Prefer: 'return=representation' });
    return rows[0];
  }
  async updatePost(id, patch) {
    const body = {};
    for (const k of ['content', 'location', 'images', 'status']) if (patch[k] !== undefined) body[k] = patch[k];
    const rows = await this._req('PATCH', `${this._tb('posts')}?id=eq.${encodeURIComponent(id)}`, body, { Prefer: 'return=representation' });
    return rows && rows[0] ? rows[0] : null;
  }
  async deletePost(id) {
    await this._req('DELETE', `${this._tb('comments')}?post_id=eq.${encodeURIComponent(id)}`);
    await this._req('DELETE', `${this._tb('likes')}?post_id=eq.${encodeURIComponent(id)}`);
    await this._req('DELETE', `${this._tb('posts')}?id=eq.${encodeURIComponent(id)}`);
  }
  async countPosts() {
    const rows = await this._req('GET', `${this._tb('posts')}?select=id&limit=1`);
    return rows.length;
  }

  async touchVisitor(hash) {
    await this._req('POST', this._tb('visitors'), [{ hash }],
      { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    return this.countVisitors();
  }

  async seedVisitors(hashes) {
    const list = (hashes || []).filter(Boolean);
    for (let i = 0; i < list.length; i += 500) {
      await this._req('POST', this._tb('visitors'), list.slice(i, i + 500).map((h) => ({ hash: h })),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
    return this.countVisitors();
  }

  async countVisitors() {
    // PostgREST 的精确计数在 Content-Range 响应头里，_req 拿不到头，所以单开一次请求
    try {
      const res = await fetch(`${this._tb('visitors')}?select=hash`, {
        method: 'GET', headers: this._headers({ Prefer: 'count=exact', Range: '0-0' }),
      });
      await res.arrayBuffer(); // 丢掉 body，避免连接悬挂
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (res.ok && m) return Number(m[1]);
    } catch (e) { /* 落到下面的兜底 */ }
    const rows = await this._req('GET', `${this._tb('visitors')}?select=hash`);
    return Array.isArray(rows) ? rows.length : 0;
  }

  async listComments(postId) {
    return this._req('GET', `${this._tb('comments')}?select=*&post_id=eq.${encodeURIComponent(postId)}&order=created_at.asc`);
  }
  async allComments() {
    return this._req('GET', `${this._tb('comments')}?select=*&order=created_at.asc`);
  }
  async addComment(f) {
    const rows = await this._req('POST', this._tb('comments'), [{
      post_id: f.post_id,
      name: f.name,
      content: f.content,
      reply_to_id: f.reply_to_id || null,
      reply_to_name: f.reply_to_name || null,
      client_key: f.client_key || null,
      site: f.site || null,
      status: f.status || 'visible',
      flag_reason: f.flag_reason || null,
    }], { Prefer: 'return=representation' });
    return rows[0];
  }
  async updateComment(id, content) {
    const rows = await this._req('PATCH', `${this._tb('comments')}?id=eq.${encodeURIComponent(id)}`, { content }, { Prefer: 'return=representation' });
    return rows && rows[0] ? rows[0] : null;
  }
  async updateCommentStatus(id, status, flagReason) {
    const patch = { status };
    if (flagReason !== undefined) patch.flag_reason = flagReason;
    const rows = await this._req('PATCH', `${this._tb('comments')}?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: 'return=representation' });
    return rows && rows[0] ? rows[0] : null;
  }
  async getComment(id) {
    const rows = await this._req('GET', `${this._tb('comments')}?select=*&id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  }
  async deleteComment(id) {
    await this._req('DELETE', `${this._tb('comments')}?reply_to_id=eq.${encodeURIComponent(id)}`);
    await this._req('DELETE', `${this._tb('comments')}?id=eq.${encodeURIComponent(id)}`);
  }

  async listLikes(postId) {
    return this._req('GET', `${this._tb('likes')}?select=*&post_id=eq.${encodeURIComponent(postId)}&order=created_at.asc`);
  }
  async allLikes() {
    return this._req('GET', `${this._tb('likes')}?select=*&order=created_at.asc`);
  }
  async addLike(postId, clientKey, name) {
    // 之前先查一次"是否已赞"并靠唯一索引去重；改成双击累加后两者都会吞掉第二次赞，
    // 所以直接插入。仍保留 409 容错：万一库里唯一索引还在，也不要把 500 抛给访客。
    try {
      await this._req('POST', this._tb('likes'), [{ post_id: postId, client_key: clientKey, name }], { Prefer: 'return=minimal' });
    } catch (e) {
      if (!/duplicate|409/i.test(e.message)) throw e;
    }
    return true;
  }
  async removeLike(postId, clientKey) {
    await this._req('DELETE', `${this._tb('likes')}?post_id=eq.${encodeURIComponent(postId)}&client_key=eq.${encodeURIComponent(clientKey)}`);
  }

  async saveImage(mime, dataB64) {
    const id = genId('img');
    await this._req('POST', this._tb('images'), [{ id, mime, data: dataB64 }], { Prefer: 'return=minimal' });
    return id;
  }
  async getImage(id) {
    const rows = await this._req('GET', `${this._tb('images')}?select=mime,data&id=eq.${encodeURIComponent(id)}`);
    return rows[0] ? { mime: rows[0].mime, data: rows[0].data } : null;
  }

  async getSettings() {
    const rows = await this._req('GET', `${this._tb('settings')}?select=value&key=eq.blog`);
    return (rows[0] && rows[0].value) || {};
  }
  async setSettings(obj) {
    const current = await this.getSettings();
    const merged = { ...current, ...obj };
    await this._req('POST', this._tb('settings'), [{ key: 'blog', value: merged }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    return merged;
  }

  async listLinks() {
    return this._req('GET', `${this._tb('links')}?select=*&order=sort.asc,created_at.asc`);
  }
  async createLink(f) {
    const rows = await this._req('POST', this._tb('links'), [{
      name: f.name, url: f.url, descr: f.descr || '', sort: Number(f.sort) || 0,
    }], { Prefer: 'return=representation' });
    return rows[0];
  }
  async updateLink(id, patch) {
    const body = {};
    for (const k of ['name', 'url', 'descr', 'sort']) if (patch[k] !== undefined) body[k] = patch[k];
    const rows = await this._req('PATCH', `${this._tb('links')}?id=eq.${encodeURIComponent(id)}`, body, { Prefer: 'return=representation' });
    return rows && rows[0] ? rows[0] : null;
  }
  async deleteLink(id) {
    await this._req('DELETE', `${this._tb('links')}?id=eq.${encodeURIComponent(id)}`);
  }
  async deleteCommentsByIds(ids) {
    if (!ids.length) return 0;
    const inList = ids.map((x) => `"${encodeURIComponent(x)}"`).join(',');
    await this._req('DELETE', `${this._tb('comments')}?id=in.(${inList})`);
    await this._req('DELETE', `${this._tb('comments')}?reply_to_id=in.(${inList})`);
    return ids.length;
  }
  async deleteLinksByIds(ids) {
    if (!ids.length) return 0;
    const inList = ids.map((x) => `"${encodeURIComponent(x)}"`).join(',');
    await this._req('DELETE', `${this._tb('links')}?id=in.(${inList})`);
    return ids.length;
  }
}

function makeStore(dataDir) {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    console.log('[store] 使用 Supabase 云端存储');
    const s = new SupabaseStore();
    s.kind = 'supabase';
    return s;
  }
  console.log('[store] 使用本地 JSON 存储（预览模式）');
  const s = new LocalStore(dataDir);
  s.kind = 'local';
  return s;
}

module.exports = { makeStore, genId };
