/**
 * 官方群聊过滤（与 Flutter chat_moderation_service 规则一致）
 */
const PHONE_131 = /1\s*3\s*[1-9]\s*\d[\s-]?\d{4}[\s-]?\d{4}/;
const PHONE_170 = /1\s*7\s*[0-9]\s*\d[\s-]?\d{4}[\s-]?\d{4}/;
const QQ = /(qq|q\s*群|扣扣)/i;
const WECHAT = /(微信|weixin|wechat|微\s*信|v\s*信|vx|wx\s*号)/i;
const SCAM = /(诈骗|欺骗|传销|资金盘|割韭菜|稳赚|躺赚|日入|月入百万|拉人头|发展下线|交入会费|高额回报|保本保息|一夜暴富|刷单返利|杀猪盘|庞氏)/;

const SEND_INTERVAL_MS = 30_000;
const lastSendAt = new Map();

function blockedReason(text) {
  const content = String(text || '').trim();
  if (!content) return '消息不能为空';
  if (content.length > 200) return '单条消息不超过 200 字';
  if (WECHAT.test(content)) return '禁止发布微信等站外联系方式';
  if (QQ.test(content)) return '禁止发布 QQ 等站外联系方式';
  if (PHONE_131.test(content)) return '禁止发布 131-139 号段电话';
  if (PHONE_170.test(content)) return '禁止发布 170-179 号段电话';
  if (SCAM.test(content)) return '疑似诈骗/传销/欺骗类内容';
  return null;
}

function checkSend({ sender, content }) {
  const reason = blockedReason(content);
  if (reason) return { ok: false, reason };

  const key = sender || 'anonymous';
  const last = lastSendAt.get(key) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < SEND_INTERVAL_MS) {
    const left = Math.ceil((SEND_INTERVAL_MS - elapsed) / 1000);
    return { ok: false, reason: `发言太频繁，请 ${left} 秒后再发` };
  }
  lastSendAt.set(key, Date.now());
  return { ok: true };
}

module.exports = { blockedReason, checkSend, SEND_INTERVAL_MS };
