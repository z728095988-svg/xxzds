import {createHash} from 'node:crypto';
import {SOURCE_NAMES} from './monitor-model.ts';

const SITE = 'https://aoying-watch-bat-20261113.fuzzycornbread4.chatgpt.site';
const clock = value => new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false});
const labels = {open: '新持仓', add: '净加仓', reduce: '净减仓', close: '持仓归零'};
export function notifications(evaluation, now = Date.now()) {
  const blocks = evaluation.changes.map(e =>
    `${SOURCE_NAMES[e.source]}｜${e.symbol}｜${e.side === 'LONG' ? '多' : '空'}\n${labels[e.type]}：${e.before} → ${e.after}\n比较区间：${clock(e.intervalStart)} → ${clock(e.intervalEnd)}（北京时间）`);
  blocks.push(...evaluation.messages);
  if (!blocks.length) return [];
  const footer = `\n\n每 60 秒检查，变化经二次取数复核。以上是有效快照之间的净变化，不是逐笔成交；快速开平仓可能遗漏。\n${SITE}`;
  const chunks = []; let current = '熬鹰监控提醒';
  for (const block of blocks) {
    if (current.length + block.length + footer.length + 2 > 3800) { chunks.push(current + footer); current = '熬鹰监控提醒（续）'; }
    current += '\n\n' + block;
  }
  chunks.push(current + footer);
  const id = createHash('sha256').update(JSON.stringify([now, evaluation.changes.map(e => e.id), evaluation.messages])).digest('hex').slice(0,24);
  return chunks.map((text, i) => ({id: `${id}:${i}`, text}));
}
