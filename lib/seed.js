/**
 * 首次启动且库为空时写入示例内容：6 张旅行样图 + 7 条朋友圈（含评论、点赞）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

async function saveDemoImage(store, demoDir, file) {
  const p = path.join(demoDir, file);
  if (!fs.existsSync(p)) throw new Error(`缺少示例图: ${file}`);
  const data = fs.readFileSync(p).toString('base64');
  return store.saveImage('image/jpeg', data);
}

async function seedIfEmpty(store, demoDir) {
  if ((await store.countPosts()) > 0) return;

  const imgs = {};
  for (const f of ['dunhuang.jpg', 'chaka.jpg', 'chongqing.jpg', 'dali.jpg', 'kyoto.jpg', 'iceland.jpg']) {
    imgs[f.replace('.jpg', '')] = await saveDemoImage(store, demoDir, f);
  }

  const demo = [
    {
      key: 'dunhuang', text: '鸣沙山的日落把影子拉得很长，驼队走得很慢，时间在这里好像也不着急。',
      location: '敦煌·鸣沙山月牙泉', at: ago(2),
      likes: ['阿岚', 'Kevin', '小满'],
      comments: [
        { name: 'Kevin', content: '这构图绝了，用的什么镜头？' },
        { name: 'Ming', content: '70-200，长焦压缩出来的剪影效果', reply: 'Kevin' },
      ],
    },
    {
      key: 'chaka', text: '都说茶卡是天空之镜，到了才发现，镜子也是需要运气的。',
      location: '青海·茶卡盐湖', at: ago(26),
      likes: ['Luna', '小鱼干'],
      comments: [{ name: '小鱼干', content: '这个倒影也太干净了吧' }],
    },
    {
      key: 'chongqing', text: '洪崖洞确实像《千与千寻》，人也是真的多。',
      location: '重庆·洪崖洞', at: ago(24 * 3),
      likes: ['Kevin', '阿岚', 'Mia'],
      comments: [],
    },
    {
      key: 'dali', text: '在洱海边醒来，日出比闹钟温柔。',
      location: '大理·双廊', at: ago(24 * 6),
      likes: ['小满', 'Luna'],
      comments: [
        { name: '阿岚', content: '下次带上我！' },
        { name: 'Ming', content: '安排', reply: '阿岚' },
      ],
    },
    {
      key: 'kyoto', text: '清晨七点的千本鸟居，几乎没有人，只有光。',
      location: '京都·伏见稻荷大社', at: ago(24 * 10),
      likes: ['Mia'],
      comments: [],
    },
    {
      key: 'iceland', text: '走到瀑布后面的时候整个人被水汽包围，很冷，但值得。',
      location: '冰岛·塞里雅兰瀑布', at: ago(24 * 15),
      likes: ['Kevin', 'Luna', '小满', 'Mia'],
      comments: [],
    },
    {
      key: null, text: '这几个月在路上的一些碎片，攒着攒着就满了。',
      location: null, at: ago(24 * 20),
      images: ['kyoto', 'chaka', 'chongqing', 'dali', 'iceland', 'dunhuang'],
      likes: ['阿岚', 'Kevin', '小满', 'Luna', 'Mia'],
      comments: [{ name: '小鱼干', content: '每一张都想加进我的行程单里' }],
    },
  ];

  for (const d of demo) {
    const imageIds = d.key ? [imgs[d.key]] : (d.images || []).map((k) => imgs[k]);
    const post = await store.createPost({
      content: d.text,
      location: d.location,
      images: imageIds,
      status: 'published',
      created_at: d.at,
    });
    for (const name of d.likes) {
      await store.addLike(post.id, `seed_${name}`, name);
    }
    for (const c of d.comments) {
      const all = await store.listComments(post.id);
      const target = c.reply ? all.find((x) => x.name === c.reply) : null;
      await store.addComment({
        post_id: post.id,
        name: c.name,
        content: c.content,
        reply_to_id: target ? target.id : null,
        reply_to_name: target ? target.name : null,
      });
    }
  }
  console.log(`[seed] 已写入 ${demo.length} 条示例内容`);
}

module.exports = { seedIfEmpty };
