/**
 * 一次性把随包发布的本地快照（data/db.json）搬进云端库。
 *
 * 只在满足三个条件时才动手：云端驱动 + 库里还没有任何帖子 + 快照文件存在且非空。
 * 之所以不直接倒 SQL：SupabaseStore 由数据库侧生成 id，硬编码 id 的 SQL 会让
 * posts.images / comments.post_id / likes.post_id 指向不存在的旧 id。这里改为
 * “插入→拿回新 id→建立旧新映射→再插下游表”，引用关系才不会断。
 */
'use strict';
const fs = require('fs');

async function migrateSnapshotToCloud(store, snapshotFile) {
  if (store.kind !== 'supabase') return null;            // 本地预览不需要
  if ((await store.countPosts()) > 0) return null;       // 云端已有内容，绝不重复导入
  if (!fs.existsSync(snapshotFile)) return null;

  let snap;
  try { snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); }
  catch (e) { console.error('[migrate] 快照解析失败，跳过：', e.message); return null; }
  if (!snap || !Array.isArray(snap.posts) || snap.posts.length === 0) return null;

  const imgMap = new Map();
  for (const im of snap.images || []) {
    imgMap.set(im.id, await store.saveImage(im.mime, im.data));
  }

  const postMap = new Map();
  for (const p of snap.posts) {
    const created = await store.createPost({
      content: p.content || '',
      location: p.location || null,
      images: (p.images || []).map((id) => imgMap.get(id)).filter(Boolean),
      // 音视频是外链描述、不含大字段，原样搬即可。漏了这一行的话，
      // 本地写好的视频在迁移到云端后会静默消失，而迁移只在空库时跑一次、事后不会补。
      media: Array.isArray(p.media) ? p.media : [],
      status: p.status === 'draft' ? 'draft' : 'published',
      created_at: p.created_at, // 帖子时间原样保留，信息流排序不变
    });
    postMap.set(p.id, created.id);
  }

  // 评论按时间升序插入，回复的旧 id 才能在其被处理时已经拿到新 id
  const comments = (snap.comments || []).slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const cmtMap = new Map();
  let skippedComments = 0;
  for (const c of comments) {
    const postId = postMap.get(c.post_id);
    if (!postId) { skippedComments++; continue; }        // 挂在已删除帖子下的评论
    const created = await store.addComment({
      post_id: postId,
      name: c.name,
      content: c.content,
      reply_to_id: c.reply_to_id ? (cmtMap.get(c.reply_to_id) || null) : null,
      reply_to_name: c.reply_to_name || null,
      client_key: c.client_key || null,
      site: c.site || null,
      status: c.status || 'visible',                      // 待审/屏蔽状态一并带过去
      flag_reason: c.flag_reason || null,
    });
    cmtMap.set(c.id, created.id);
  }

  let skippedLikes = 0;
  for (const l of snap.likes || []) {
    const postId = postMap.get(l.post_id);
    if (!postId) { skippedLikes++; continue; }
    await store.addLike(postId, l.client_key, l.name || '游客');
  }

  if (snap.settings && Object.keys(snap.settings).length) {
    await store.setSettings(snap.settings);
  }

  // 访客集合并入（本地若已计过往来访客，迁移后不该从 0 重新开始）
  const visitorHashes = (snap.visitors || []).map((v) => v && v.hash).filter(Boolean);
  if (visitorHashes.length) await store.seedVisitors(visitorHashes);

  let links = 0;
  for (const ln of (snap.links || []).slice()
    .sort((a, b) => (a.sort - b.sort) || (new Date(a.created_at) - new Date(b.created_at)))) {
    await store.createLink({ name: ln.name, url: ln.url, descr: ln.descr, sort: ln.sort });
    links++;
  }

  return {
    images: imgMap.size,
    posts: postMap.size,
    comments: cmtMap.size,
    skippedComments,
    likes: (snap.likes || []).length - skippedLikes,
    skippedLikes,
    links,
    visitors: visitorHashes.length,
  };
}

module.exports = { migrateSnapshotToCloud };
