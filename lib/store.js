/**
 * 存储驱动：LocalStore（本地 JSON，开发预览用）/ SupabaseStore（QW Pages 运行时注入凭证后自动启用）
 * 两套驱动暴露完全相同的异步接口，业务代码无感切换。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const genId = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

/* 访客计数缓存时长：这是个装饰性数字，60 秒的陈旧度换来每分钟内只查一次 */
const VISITOR_CACHE_MS = 60 * 1000;

/* 会话表的列清单，两个驱动共用：
 * updateSession 只接受这些键。本地 JSON 没有"列"概念，写错键只会默默多出一个字段；
 * 而云端 PostgREST 遇到未知列是把整条 PATCH 打回 400——同一段业务代码在本地跑得好、
 * 上线就报错。所以本地也按这份白名单过滤，让两边行为一致、错误在本地就能暴露。 */
const SESSION_COLS = ['visitor_hash', 'ip', 'geo_label', 'geo_country', 'geo_region', 'geo_city',
  'geo_isp', 'ua', 'device', 'browser', 'os', 'bot', 'admin', 'referrer', 'page',
  'started_at', 'last_seen', 'duration_ms', 'pv', 'event_count', 'ended'];

/* ---------------- Local JSON Store ---------------- */
class LocalStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.imgDir = path.join(dataDir, 'images');
    // 与 SupabaseStore 同名属性：业务层统一读它来提示"媒体没存上"，本地永远为空
    this.mediaWarning = '';
    fs.mkdirSync(this.imgDir, { recursive: true });
    this.db = { posts: [], comments: [], likes: [], images: [], settings: {}, links: [], visitors: [], visit_sessions: [], visit_events: [], ip_geo: {} };
    if (fs.existsSync(this.file)) {
      try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { /* 损坏则重建 */ }
    }
    // 兼容旧数据：评论补齐 status，补齐 links 容器
    for (const c of this.db.comments) if (!c.status) c.status = 'visible';
    if (!Array.isArray(this.db.links)) this.db.links = [];
    if (!Array.isArray(this.db.visitors)) this.db.visitors = []; // 旧快照里没有该表，补齐
    // 访客记录三张容器同理：老快照（包括从另一台设备同步来的 db.json）里没有
    if (!Array.isArray(this.db.visit_sessions)) this.db.visit_sessions = [];
    if (!Array.isArray(this.db.visit_events)) this.db.visit_events = [];
    if (!this.db.ip_geo || typeof this.db.ip_geo !== 'object') this.db.ip_geo = {};
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }
  /* 心跳/行为上报是"每秒可能好几次、每次都整文件重写"的量级，而本库是单文件 JSON，
   * db.json 里还内联着 base64 图片（现在约 4MB）。每来一次心跳就重写的开销完全不成比例。
   * 所以追踪类写入走这里：合并同一个时间窗内的多次变更，只落一次盘。
   * 代价是崩掉时可能丢最后几百毫秒的遥测——丢的只是访问日志，正文与评论照旧同步落盘；
   * 另外 endSession（一次访问的收尾）会强制同步写，正常关页面不会丢。 */
  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this._save();
    }, 250);
    if (this._saveTimer.unref) this._saveTimer.unref(); // 别让一个待写的定时器吊住进程退出
  }
  _flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._dirty) this._save();
  }
  async listPosts(includeDrafts) {
    return this.db.posts
      .filter((p) => includeDrafts || p.status === 'published')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((p) => ({ ...p, images: [...(p.images || [])], media: [...(p.media || [])] }));
  }
  async getPost(id) {
    const p = this.db.posts.find((x) => x.id === id);
    return p ? { ...p, images: [...(p.images || [])], media: [...(p.media || [])] } : null;
  }
  async createPost(fields) {
    const row = {
      id: genId('post'),
      content: fields.content || '',
      location: fields.location || null,
      images: fields.images || [],
      media: fields.media || [],
      status: fields.status || 'published',
      created_at: fields.created_at || new Date().toISOString(),
    };
    this.db.posts.push(row);
    this._save();
    return { ...row, images: [...row.images], media: [...row.media] };
  }
  async updatePost(id, patch) {
    const p = this.db.posts.find((x) => x.id === id);
    if (!p) return null;
    for (const k of ['content', 'location', 'images', 'media', 'status']) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    this._save();
    return { ...p, images: [...(p.images || [])], media: [...(p.media || [])] };
  }
  /* 本地 JSON 库没有"列"的概念，media 字段天然可用；
     与 SupabaseStore 保持同名接口，业务层不必分辨驱动。 */
  async supportsMedia() { return true; }
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

  /* ---------------- 访客记录（会话 + 行为流水 + IP 归属地缓存） ----------------
   * 云端表叫 visit_sessions / visit_events / ip_geo_cache（见 README「发布」），
   * 本地用同名容器，两套驱动的入参出参一致，lib/visit.js 不分辨驱动。 */
  async createSession(row) { this.db.visit_sessions.push({ ...row }); this._scheduleSave(); return { ...row }; }
  async getSession(id) {
    const s = this.db.visit_sessions.find((x) => x.id === id);
    return s ? { ...s } : null;
  }
  async updateSession(id, patch) {
    const s = this.db.visit_sessions.find((x) => x.id === id);
    if (!s) return null;
    for (const k of SESSION_COLS) if (patch[k] !== undefined) s[k] = patch[k];
    // 一次访问的收尾必须同步落盘：这是这条记录唯一的"完整落库时机"，
    // 合并写入的窗口只该留给中间态心跳。
    if (patch.ended === true) this._save(); else this._scheduleSave();
    return { ...s };
  }
  _matchSession(s, f) {
    if (f.since && Date.parse(s.started_at || 0) < Date.parse(f.since)) return false;
    if (!f.includeAdmin && s.admin) return false;
    if (f.q) {
      const hay = [s.ip, s.geo_label, s.device, s.browser, s.os, s.referrer, s.ua]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }
  async listSessions(f) {
    // f.cols：只取统计要用的几列。本地是整对象，取完再挑，只为与云端行为一致
    // （云端 PostgREST 的 select 能真正把宽度压下去，见 SupabaseStore.listSessions）
    const matched = this.db.visit_sessions.filter((s) => this._matchSession(s, f));
    const pick = (s) => (f.cols && f.cols.length
      ? f.cols.reduce((o, k) => { if (s[k] !== undefined) o[k] = s[k]; return o; }, { id: s.id })
      : { ...s });
    const rows = matched
      .sort((a, b) => (Date.parse(b.last_seen || b.started_at) || 0) - (Date.parse(a.last_seen || a.started_at) || 0))
      .slice(f.offset || 0, (f.offset || 0) + f.limit)
      .map(pick);
    return { rows, total: matched.length };
  }
  async listEventsBySessions(ids, limit) {
    const set = new Set(ids);
    return this.db.visit_events
      .filter((e) => set.has(e.session_id))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .slice(0, limit || 600)
      .map((e) => ({ ...e }));
  }
  async addEvents(rows) {
    for (const r of rows || []) this.db.visit_events.push({ id: genId('ev'), ...r });
    this._scheduleSave();
    return (rows || []).length;
  }
  async deleteSessionsByIds(ids) {
    const set = new Set(ids);
    this.db.visit_sessions = this.db.visit_sessions.filter((s) => !set.has(s.id));
    this.db.visit_events = this.db.visit_events.filter((e) => !set.has(e.session_id));
    this._save();
    return ids.length;
  }
  async purgeVisits({ before, maxSessions, maxEvents }) {
    const b = Date.parse(before) || 0;
    let removedSessions = 0, removedEvents = 0;
    const keepS = this.db.visit_sessions.filter((s) => {
      const stale = (Date.parse(s.started_at) || 0) < b;
      if (stale) removedSessions++;
      return !stale;
    });
    this.db.visit_sessions = keepS;
    const live = new Set(keepS.map((s) => s.id));
    this.db.visit_events = this.db.visit_events.filter((e) => {
      const stale = (Date.parse(e.created_at) || 0) < b || !live.has(e.session_id);
      if (stale) removedEvents++;
      return !stale;
    });
    if (this.db.visit_sessions.length > maxSessions) {
      const drop = this.db.visit_sessions.length - maxSessions;
      this.db.visit_sessions.sort((a, b2) => (Date.parse(a.last_seen || a.started_at) || 0) - (Date.parse(b2.last_seen || b2.started_at) || 0));
      this.db.visit_events = this.db.visit_events.filter((e) => !this.db.visit_sessions.slice(0, drop).some((s) => s.id === e.session_id));
      this.db.visit_sessions = this.db.visit_sessions.slice(drop);
      removedSessions += drop;
    }
    if (this.db.visit_events.length > maxEvents) {
      const cut = this.db.visit_events.length - maxEvents;
      this.db.visit_events.sort((a, b2) => (Date.parse(a.created_at) || 0) - (Date.parse(b2.created_at) || 0));
      this.db.visit_events = this.db.visit_events.slice(cut);
      removedEvents += cut;
    }
    this._save();
    return { sessions: removedSessions, events: removedEvents };
  }
  async getGeo(ip) { return this.db.ip_geo[ip] || null; }
  async setGeo(ip, value) {
    this.db.ip_geo[ip] = { value: value || null, updated_at: new Date().toISOString() };
    this._scheduleSave();
    return true;
  }
}

/* ---------------- Supabase (PostgREST) Store ---------------- */
class SupabaseStore {
  constructor() {
    this.base = process.env.SUPABASE_URL.replace(/\/$/, '');
    this.key = process.env.SUPABASE_ANON_KEY;
    this._vc = { n: null, at: 0 }; // 访客计数缓存（n=null 表示尚未取得）
    this._vcWarned = false;
    /* 音视频列是否存在的探测缓存：null=还没探过，true/false=结论。
       为什么要探：createPost 无条件带 media 字段，而线上若还没执行
       "ALTER TABLE posts ADD COLUMN media"，PostgREST 会把整条写入打回 400 ——
       连纯文字帖子都发不出去，等于把一个可选功能变成全站写入事故。
       探测到缺列时降级为"不带 media 照发"，并把 warning 透出给后台，
       让发帖的人明确知道"这条的视频没存下"，而不是静默丢失。 */
    this._mediaCol = null;
    this.mediaWarning = '';
  }
  async supportsMedia() {
    if (this._mediaCol !== null) return this._mediaCol;
    try {
      await this._req('GET', `${this._tb('posts')}?select=media&limit=1`);
      this._mediaCol = true;
    } catch (e) {
      this._mediaCol = false;
      console.warn('[media] 云端 posts 表读不到 media 列，音视频暂不写入：' + e.message.slice(0, 160));
    }
    return this._mediaCol;
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

  /* 带精确总数的查询。总数只在 Content-Range 响应头里（`0-19/123` 的第三段），
   * _req 只回 body，所以分页列表单独走这里。
   * 拿不到 Content-Range 时退回"本页条数"而不是猜一个总数——
   * 后台会把页码算错，但不会因为一个假总数而显示不出数据。 */
  async _reqCounted(method, url, body, extraHeaders) {
    const res = await fetch(url, {
      method,
      headers: this._headers({ Prefer: 'count=exact', ...(extraHeaders || {}) }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
    const data = text ? JSON.parse(text) : [];
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    return { rows: data, total: m ? Number(m[1]) : data.length };
  }

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
    const row = {
      content: f.content || '',
      location: f.location || null,
      images: f.images || [],
      // media 是 jsonb 列（视频/音频外链描述）；缺列时见 supportsMedia 的降级说明
      media: f.media || [],
      status: f.status || 'published',
      created_at: f.created_at || new Date().toISOString(),
    };
    if (!(await this.supportsMedia())) {
      delete row.media;
      this.mediaWarning = '云端数据库还没有 media 列，这条的音视频未保存；请执行 README「音视频」里的 ALTER TABLE 后重新编辑。';
    } else {
      this.mediaWarning = '';
    }
    const rows = await this._req('POST', this._tb('posts'), [row], { Prefer: 'return=representation' });
    return rows[0];
  }
  async updatePost(id, patch) {
    const body = {};
    for (const k of ['content', 'location', 'images', 'media', 'status']) if (patch[k] !== undefined) body[k] = patch[k];
    if (body.media !== undefined && !(await this.supportsMedia())) {
      delete body.media;
      this.mediaWarning = '云端数据库还没有 media 列，音视频改动未保存；请执行 README「音视频」里的 ALTER TABLE 后重试。';
    } else {
      this.mediaWarning = '';
    }
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
    // 用 return=representation 而不是 minimal：能不能拿到"这次真的插入了一行"，
    // 决定了要不要重算计数。重复访客直接复用缓存，省掉一次往返。
    let created = [];
    try {
      created = (await this._req('POST', this._tb('visitors'), [{ hash }],
        { Prefer: 'resolution=ignore-duplicates,return=representation' })) || [];
    } catch (e) {
      if (!/duplicate|409/i.test(e.message)) throw e;
    }
    if (created.length) {
      // 新访客：缓存里就地 +1，避免每次新增都发一次 count 查询
      if (this._vc.n !== null) { this._vc.n += 1; this._vc.at = Date.now(); return this._vc.n; }
      return this.countVisitors(true);
    }
    return this.countVisitors(false);
  }

  async seedVisitors(hashes) {
    const list = (hashes || []).filter(Boolean);
    for (let i = 0; i < list.length; i += 500) {
      await this._req('POST', this._tb('visitors'), list.slice(i, i + 500).map((h) => ({ hash: h })),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
    return this.countVisitors(true);
  }

  async countVisitors(force) {
    // 精确计数只在 Content-Range 响应头里（_req 拿不到头），所以单开一次请求。
    // 三条硬约束：① 结果缓存 60 秒；② 兜底请求也带 limit=1，绝不整表拉回；
    // ③ 连 Content-Range 都拿不到时退回上次缓存值并告警一次，而不是猜一个。
    const now = Date.now();
    if (!force && this._vc.n !== null && now - this._vc.at < VISITOR_CACHE_MS) return this._vc.n;
    try {
      const res = await fetch(`${this._tb('visitors')}?select=hash&limit=1`, {
        method: 'GET', headers: this._headers({ Prefer: 'count=exact', Range: '0-0' }),
      });
      await res.arrayBuffer();
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (res.ok && m) { this._vc = { n: Number(m[1]), at: now }; return this._vc.n; }
      if (!this._vcWarned) {
        this._vcWarned = true;
        console.warn('[visitors] 网关未回 Content-Range，计数只能用本地推算值（不做全表扫描）');
      }
    } catch (e) {
      if (!this._vcWarned) { this._vcWarned = true; console.warn('[visitors] 计数请求失败：', e.message); }
    }
    this._vc = { n: this._vc.n === null ? 0 : this._vc.n, at: now };
    return this._vc.n;
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

  /* ---------------- 访客记录 ----------------
   * 表结构见 README「发布」：visit_sessions / visit_events / ip_geo_cache。
   * 三张表都以 text 主键 + 客户端生成的 id 落地（与 images 同一套做法），
   * 这样"按 id 批量删""按 offset 裁剪最老的一批"都能直接用 PostgREST 做，
   * 不需要额外的 RPC。 */
  async createSession(row) {
    const rows = await this._req('POST', this._tb('visit_sessions'), [row], { Prefer: 'return=representation' });
    return rows[0];
  }
  async getSession(id) {
    const rows = await this._req('GET', `${this._tb('visit_sessions')}?select=*&id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  }
  async updateSession(id, patch) {
    const body = {};
    // 白名单列：把未知键发给 PostgREST 是整条 PATCH 报 400，而不是"忽略这一列"
    for (const k of SESSION_COLS) if (patch[k] !== undefined) body[k] = patch[k];
    if (!Object.keys(body).length) return null;
    const rows = await this._req('PATCH', `${this._tb('visit_sessions')}?id=eq.${encodeURIComponent(id)}`, body, { Prefer: 'return=representation' });
    return rows && rows[0] ? rows[0] : null;
  }
  async listSessions(f) {
    const cols = (f.cols && f.cols.length) ? f.cols.join(',') : '*';
    let url = `${this._tb('visit_sessions')}?select=${cols}&order=last_seen.desc.nullslast`;
    if (f.since) url += `&started_at=gte.${encodeURIComponent(f.since)}`;
    if (f.includeAdmin === false) url += '&admin=eq.false';
    if (f.q) {
      // or() 里的逗号是语法分隔符，q 必须先在 lib/visit.js 的 cleanQ() 里去掉逗号/引号/括号
      const or = ['ip', 'geo_label', 'device', 'browser', 'os', 'referrer']
        .map((c) => `${c}.ilike.${encodeURIComponent('%' + f.q + '%')}`).join(',');
      url += `&or=(${or})`;
    }
    url += `&limit=${f.limit}&offset=${f.offset || 0}`;
    // 分页总数只在 Content-Range 里，_req 拿不到响应头，所以单独走一次带计数的请求
    return this._reqCounted('GET', url);
  }
  async listEventsBySessions(ids, limit) {
    if (!ids.length) return [];
    const inList = ids.map((x) => `"${encodeURIComponent(x)}"`).join(',');
    return this._req('GET', `${this._tb('visit_events')}?select=*&session_id=in.(${inList})&order=created_at.asc&limit=${limit || 600}`);
  }
  async addEvents(rows) {
    const list = (rows || []).map((r) => ({ id: r.id || genId('ev'), ...r }));
    if (!list.length) return 0;
    await this._req('POST', this._tb('visit_events'), list, { Prefer: 'return=minimal' });
    return list.length;
  }
  async deleteSessionsByIds(ids) {
    if (!ids.length) return 0;
    const inList = ids.map((x) => `"${encodeURIComponent(x)}"`).join(',');
    await this._req('DELETE', `${this._tb('visit_events')}?session_id=in.(${inList})`);
    await this._req('DELETE', `${this._tb('visit_sessions')}?id=in.(${inList})`);
    return ids.length;
  }
  /* 超行数上限的裁剪：按时间正序把最老的 beyond-max 那批 id 捞出来（每轮最多 500，
   * 剩下的下一轮再收），然后按 id 删。 */
  async _trim(table, max, orderCol) {
    const doomed = await this._req('GET',
      `${this._tb(table)}?select=id&order=${orderCol}.asc&limit=500&offset=${max}`).catch(() => []);
    if (!doomed || !doomed.length) return 0;
    const inList = doomed.map((x) => `"${encodeURIComponent(x.id)}"`).join(',');
    await this._req('DELETE', `${this._tb(table)}?id=in.(${inList})`);
    return doomed.length;
  }
  /* 云端删除没有"affected rows"可拿，条数只在 return=representation 的响应体里。
   * 清理每 6 小时才跑一次、量级也小，所以这里为准确数字付一次回表是划算的。 */
  async purgeVisits({ before, maxSessions, maxEvents }) {
    const rep = undefined;
    const prefer = { Prefer: 'return=representation' };
    const b = encodeURIComponent(before);
    const oldEvents = await this._req('DELETE', `${this._tb('visit_events')}?created_at=lt.${b}`, rep, prefer).catch(() => []);
    const oldSessions = await this._req('DELETE', `${this._tb('visit_sessions')}?started_at=lt.${b}`, rep, prefer).catch(() => []);
    // 归属地缓存没必要留着：30 天有效期的东西存一年以上毫无意义
    await this._req('DELETE', `${this._tb('ip_geo_cache')}?updated_at=lt.${encodeURIComponent(new Date(Date.parse(before) - 90 * 86400000).toISOString())}`, rep).catch(() => {});
    const trimmedEvents = await this._trim('visit_events', maxEvents, 'created_at');
    const trimmedSessions = await this._trim('visit_sessions', maxSessions, 'last_seen');
    /* 说明：删会话不会连带删掉它名下的动作（PostgREST 表达不了跨表 DELETE...WHERE IN 子查询，
     * 那需要一个 RPC）。两边都按 created_at / last_seen 过期，所以"孤儿动作"最长存活一个
     * 留存周期就会被上面第一条 DELETE 收走，不会无限累积。 */
    return {
      sessions: (oldSessions || []).length + trimmedSessions,
      events: (oldEvents || []).length + trimmedEvents,
    };
  }
  async getGeo(ip) {
    const rows = await this._req('GET', `${this._tb('ip_geo_cache')}?select=value,updated_at&ip=eq.${encodeURIComponent(ip)}`);
    return rows[0] || null;
  }
  async setGeo(ip, value) {
    // jsonb 列存 SQL NULL 会让"这行存在"和"没查到"在回读时难以区分，所以未命中写哨兵对象
    await this._req('POST', this._tb('ip_geo_cache'),
      [{ ip, value: value || { miss: true }, updated_at: new Date().toISOString() }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    return true;
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
