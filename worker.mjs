import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from './store.mjs';
import {Telegram, consumeUpdates, deliverOne, isExpectedBot} from './telegram.mjs';
import {samples} from './source.mjs';
import {evaluateSamples} from './evaluation.ts';
import {notifications} from './format.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const code = process.env.TELEGRAM_PAIR_CODE || '';
if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) || !/^[A-Za-z0-9_-]{32,64}$/.test(code)) {
  console.error('配置未完成：请在服务器安全变量中填写 TELEGRAM_BOT_TOKEN 和 32–64 位随机 TELEGRAM_PAIR_CODE。');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || './data';
mkdirSync(dataDir, {recursive: true, mode: 0o700});
const store = new Store(join(dataDir, 'monitor.sqlite'));
const telegram = new Telegram(token);
const owner = randomUUID();
if (!store.lease(owner)) { console.error('已有监控实例使用此数据库，请只运行一个副本。'); store.close(); process.exit(1); }
const controller = new AbortController();
const {signal} = controller;
const sleep = ms => delay(ms, undefined, {signal});
let telegramReady = false, leaseValid = true, heartbeat = Date.now(), fatalError = false;
const leaseTimer = setInterval(() => {
  try { leaseValid = store.lease(owner); } catch { leaseValid = false; }
  if (!leaseValid) { console.error('监控进程失去锁，停止运行。'); controller.abort(); }
}, 15000);
const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/healthz') { response.writeHead(404); return response.end(); }
  const live = leaseValid && Date.now() - heartbeat < 150000;
  response.writeHead(live ? 200 : 503, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  // This endpoint never reveals credentials, the recipient, or position content.
  response.end(JSON.stringify({ok: live, paired: !!store.get('chatId'), telegramReady,
    intervalSeconds: 60, lastCheckAt: store.get('lastCheckAt'), pendingNotifications: store.pendingCount()}));
});
server.listen(Number(process.env.PORT) || 8080, '0.0.0.0');
for (const event of ['SIGINT','SIGTERM']) process.once(event, () => controller.abort());

async function pollingLoop() {
  while (!signal.aborted) {
    try {
      if (!telegramReady) {
        const me = await telegram.call('getMe', {}, signal);
        if (!isExpectedBot(me)) {
          console.error('Token 对应的机器人不是指定的 @rdhjvcxsbot，停止运行。');
          fatalError = true; controller.abort(); break;
        }
        const webhook = await telegram.call('getWebhookInfo', {}, signal);
        if (webhook.url) { console.error('机器人已设置其他 Webhook，请使用专用机器人；没有更改原有 Webhook。'); await sleep(60000); continue; }
        const previousBot = store.get('botId');
        if (previousBot && previousBot !== me.id) { console.error('机器人身份与已有绑定不一致，停止运行。'); fatalError = true; controller.abort(); break; }
        store.set('botId', me.id); telegramReady = true;
        console.log('Telegram 机器人验证通过，等待或恢复私人聊天绑定。');
      }
      const updates = await telegram.call('getUpdates', {offset: store.get('telegramOffset', 0),
        timeout: 25, limit: 100, allowed_updates: ['message']}, signal);
      consumeUpdates(store, updates, code);
    } catch {
      if (signal.aborted) break;
      telegramReady = false;
      console.warn('Telegram 暂时不可用，稍后重试；仓位检查独立运行。');
      await sleep(10000).catch(() => {});
    }
  }
}
async function monitorLoop() {
  while (!signal.aborted) {
    heartbeat = Date.now();
    if (!store.get('chatId')) { await sleep(1000); continue; }
    const due = store.get('nextCheckAt', 0);
    if (Date.now() < due) { await sleep(Math.min(due - Date.now(), 1000)); continue; }
    const started = Date.now();
    store.set('nextCheckAt', started + 60000);
    const before = store.get('memory', {snapshots: {}, health: {}});
    const first = await samples({signal});
    await sleep(21000);
    const second = await samples({signal});
    if (signal.aborted || !leaseValid) break;
    const now = Date.now();
    const result = evaluateSamples(before, first, second, now);
    const messages = notifications(result, now);
    for (const source of ['binance','okx']) {
      if (!before.snapshots[source] && result.memory.snapshots[source]) {
        const name = source === 'binance' ? '币安' : 'OKX';
        messages.push({id: `baseline:${source}`, text: `熬鹰 ${name} 的比较基准已建立，当前 ${result.memory.snapshots[source].positions.length} 个仓位。后续按每 60 秒启动检查，并在复核变化后提醒。这条消息可用于确认 Telegram 接收通道。`});
      }
    }
    store.saveCheck(result.memory, messages, now);
    heartbeat = now;
    console.log(JSON.stringify({event: 'check_complete', at: new Date(now).toISOString(),
      health: result.memory.health, changes: result.changes.length, queued: messages.length}));
    // A slow round never causes a burst of catch-up requests.
    if (now >= started + 60000) store.set('nextCheckAt', now + 60000);
  }
}
async function deliveryLoop() {
  while (!signal.aborted) {
    if (telegramReady && leaseValid) await deliverOne(store, telegram, Date.now(), signal);
    await sleep(1200);
  }
}
const loops = [pollingLoop(), monitorLoop(), deliveryLoop()].map(p => p.catch(() => {
  if (!signal.aborted) { console.error('监控进程遇到运行错误，停止并等待托管服务重启。'); fatalError = true; controller.abort(); }
}));
await Promise.all(loops);
clearInterval(leaseTimer);
server.close();
store.release(owner); store.close();
process.exitCode = leaseValid && !fatalError ? 0 : 1;
