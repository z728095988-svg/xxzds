import {timingSafeEqual} from 'node:crypto';

export const EXPECTED_BOT_USERNAME = 'rdhjvcxsbot';
export function isExpectedBot(me) {
  return Number.isSafeInteger(me?.id) && me.id > 0 && me.is_bot === true &&
    typeof me.username === 'string' && me.username.toLowerCase() === EXPECTED_BOT_USERNAME;
}

export class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    // Never include Telegram request URLs, raw bodies, tokens, or user messages.
    super(`Telegram request failed (${Number(code) || 0})`);
    this.code = Number(code) || 0;
    this.retryAfter = Math.max(0, Number(retryAfter) || 0);
  }
}
export class Telegram {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetchImpl = fetchImpl; }
  async call(method, payload = {}, signal) {
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35000 : 8000);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload), redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new TelegramError(data.error_code || response.status, data.parameters?.retry_after);
      return data.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(0);
    }
  }
  async send(chatId, text, signal) {
    const result = await this.call('sendMessage', {chat_id: chatId, text, link_preview_options: {is_disabled: true}}, signal);
    if (!Number.isSafeInteger(result?.message_id)) throw new TelegramError(0);
    return result.message_id;
  }
}

export function matchesPair(message, code, now = Date.now()) {
  if (!message || message.chat?.type !== 'private' || message.from?.is_bot ||
      !Number.isSafeInteger(message.chat.id) || message.chat.id <= 0 || message.chat.id !== message.from?.id) return false;
  const sentAt = Number(message.date) * 1000;
  if (!Number.isFinite(sentAt) || now - sentAt > 600000 || sentAt > now + 30000) return false;
  const candidate = /^\/start\s+([A-Za-z0-9_-]{32,64})$/.exec(String(message.text || '').trim())?.[1];
  if (!candidate || candidate.length !== code.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(code));
}

export function consumeUpdates(store, updates, code, now = Date.now()) {
  if (!Array.isArray(updates)) throw Error('Invalid updates');
  store.atomic(() => {
    let offset = store.get('telegramOffset', 0);
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      offset = update.update_id + 1;
      const owner = store.get('chatId');
      if (!owner && matchesPair(update.message, code, now)) {
        store.set('chatId', String(update.message.chat.id));
        store.set('pairedAt', now);
        store.enqueue('paired', 'Telegram 已绑定。仓位检查按每 60 秒启动一轮，变化需复核后提醒；第一次检查只建立基准。若数分钟后仍未收到“基准已建立”，请用 /status 查看状态。', now);
      } else if (owner && update.message?.chat?.type === 'private' &&
          String(update.message.chat.id) === owner && String(update.message.text).trim() === '/status') {
        const at = store.get('lastCheckAt');
        const memory = store.get('memory', {health: {}});
        const time = at ? new Date(at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) : '尚未完成';
        const states = {live: '正常', offline: '不可用', unstable: '待复核'};
        store.enqueue(`status:${update.update_id}`, `监控频率：60 秒/轮\n最近完成检查：${time}（北京时间）\n币安：${states[memory.health.binance] || '等待数据'}\nOKX：${states[memory.health.okx] || '等待数据'}\n待发送通知：${store.pendingCount()}\n这是数据检查状态，不保证手机已收到推送。`, now);
      }
    }
    store.set('telegramOffset', offset);
  });
}

export async function deliverOne(store, telegram, now = Date.now(), signal) {
  const chatId = store.get('chatId');
  if (!chatId) return {status: 'unpaired'};
  const item = store.nextMessage(now);
  if (!item) return {status: 'idle'};
  try {
    const messageId = await telegram.send(chatId, item.text, signal);
    store.sent(item.id, messageId, now);
    return {status: 'accepted'};
  } catch (error) {
    const retryMs = Math.max(5000 * 2 ** Math.min(item.attempts, 8),
      (error.retryAfter || 0) * 1000, [401,403,409].includes(error.code) ? 600000 : 0);
    store.retry(item.id, now + retryMs);
    return {status: 'retry', code: error.code || 0};
  }
}
