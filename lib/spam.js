/**
 * 评论反垃圾筛查（启发式）：广告/营销、违法违规、引流联系方式、外链、刷屏。
 * 命中 → 评论标记为 pending（前台不展示，进后台待审）。
 */
'use strict';

const AD_KEYWORDS = [
  '加微信', '加qq', '加 qq', 'v信', '微❤', '微商', '代购', '返利', '优惠券', '免费领取',
  '点击链接', '推广', '刷单', '兼职', '日赚', '日入', '代开发票', '虚开发票', '代办发票', '办证', '刻章',
  '贷款', '借款', 'pos机', '信用卡套现', '六合彩', '博彩', '赌场', '彩票', '开奖', '投注',
  '菠菜', '网赚', '招代理', '加盟', '招商', '私信我', '详询', '询价', '一件代发', '厂家批发',
  '包过', '代写', '枪手', '涨粉', '引流', '接单', '低息', '无抵押贷款', '养卡', '提额',
];
const ILLEGAL_KEYWORDS = [
  '枪支', '仿真枪', '弹药', '毒品', '冰毒', '海洛因', '摇头丸', '迷药', '迷魂', '听话水',
  '春药', '偷拍', '跟踪定位', '窃听', '黑客', '外挂', '辅助器', '透视挂', '赌博', '色情',
  '裸聊', '约炮', '招嫖', '卖淫', '走私', '违禁', '办假证', '假证', '四件套', '开房记录',
  '查出轨', '定位找人', '个人信息买卖', '黑客接单', '翻墙', '破解',
];

const URL_RE = /(https?:\/\/|www\.[\w-]+|[a-z0-9-]+\.(com|cn|net|top|xyz|vip|club|shop|cc)\b)/i;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/; // 前后不能再接数字，避免长数字串里误命中
/* 必须带显式锚点词。旧写法 /[qq扣]{0,3}\s*[:：]?\s*\d{5,12}/i 里字符类与冒号都允许零次，
 * 等价于"正文含任意 5–12 位连续数字即判引流"，把 ISO 100000、邮编、日期、序列号全误伤了。 */
const CONTACT_RE = /(微信|weixin|vx|v信|扣扣|企鹅|电话|手机号|联系方式)\s*(号)?\s*[:：=]?\s*[a-z0-9_-]{5,}/i;
const QQ_RE = /(qq|扣扣|企鹅)\s*(号)?\s*[:：=]?\s*\d{5,12}/i;

function screenComment(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  if (URL_RE.test(raw)) return { flagged: true, reason: '包含外部链接' };
  for (const k of ILLEGAL_KEYWORDS) if (t.includes(k.toLowerCase())) return { flagged: true, reason: '疑似违规/违法内容' };
  for (const k of AD_KEYWORDS) if (t.includes(k.toLowerCase())) return { flagged: true, reason: '疑似广告/营销' };
  if (PHONE_RE.test(raw)) return { flagged: true, reason: '疑似手机号引流' };
  if (CONTACT_RE.test(raw) || QQ_RE.test(raw)) return { flagged: true, reason: '疑似联系方式引流' };
  const compact = raw.replace(/\s/g, '');
  const uniq = new Set(compact).size;
  if (compact.length >= 15 && uniq <= 3) return { flagged: true, reason: '疑似刷屏内容' };
  return { flagged: false, reason: null };
}

module.exports = { screenComment };
