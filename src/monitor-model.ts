export type Source = 'binance' | 'okx';
export type Position = {
  key: string; symbol: string; side: 'LONG' | 'SHORT'; quantity: string;
  entryPrice: number | null; markPrice: number | null; pnl: number | null;
  leverage: number | null; margin: number | null; liquidationPrice: number | null;
};
export type Snapshot = {
  source: Source; sourceAt: string; detailAt: string | null; marginBalance: number | null;
  positions: Position[]; detailsAligned: boolean;
};
export type MonitorEvent = {
  id: string; source: Source; type: 'open' | 'add' | 'reduce' | 'close' | 'baseline' | 'gap';
  symbol: string; side: string; before: string; after: string; sourceAt: string; detectedAt: string;
  mode?: 'hourly'; intervalStart?: string; intervalEnd?: string;
};
export type SourceState = {
  snapshot: Snapshot | null; baseline: Snapshot | null; pending: Snapshot | null;
  pendingSince: number; healthyAt: number; status: 'live' | 'offline' | 'pending';
  error: string | null;
};
export type PublicSource = Omit<SourceState, 'baseline' | 'pending' | 'pendingSince'> & { pending: boolean };
export type FeedItem = { id: string; text: string; at: string; };
export type MonitorResponse = {
  checkedAt: string | null; nextCheckMs: number;
  sources: Record<Source, PublicSource>; events: MonitorEvent[];
  messages: FeedItem[]; sourceHistory: FeedItem[]; busy?: boolean;
  background?: {configured:boolean;cadenceMinutes:number;channel:string;configuredAt:string|null;lastCheckAt:string|null;
    health:Record<string,string>;lastChangeCount:number;lastNotificationPreparedAt:string|null};
};
type Bag = Record<string, any>;
export const SOURCE_NAMES = { binance: '熬鹰币安', okx: '熬鹰 OKX' };
export const EXPECTED_PORTFOLIO = '5075281354358777856';
const decimalPattern = /^\d{1,18}(?:\.\d{1,18})?$/;
export function quantity(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!decimalPattern.test(s) || !(Number(s) > 0)) throw Error('持仓数量格式不完整');
  const [integer, fraction = ''] = s.split('.');
  const cleaned = fraction.replace(/0+$/, '');
  return String(BigInt(integer)) + (cleaned ? '.' + cleaned : '');
}
export function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * (10n ** 18n) + BigInt(fraction.padEnd(18, '0'));
}
function num(value: unknown): number | null {
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const n = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
  return Number.isFinite(n) ? n : null;
}
function positive(value: unknown): number | null {
  const n = num(value); return n != null && n > 0 ? n : null;
}
function validAt(value: unknown, now: number, maxAge: number): string {
  if (typeof value !== 'string') throw Error('缺少来源时间');
  const n = Date.parse(value);
  if (!Number.isFinite(n) || n > now + 30000 || now - n > maxAge) throw Error('来源数据已过期，等待同步恢复');
  return new Date(n).toISOString();
}
function identity(p: Bag) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!/^[A-Z0-9_\-]{2,32}$/.test(symbol) || !['LONG', 'SHORT'].includes(p.side)) throw Error('仓位标识不完整');
  return { key: symbol + ':' + p.side, symbol, side: p.side as 'LONG' | 'SHORT', quantity: quantity(p.quantity) };
}
function unique(positions: Position[]) {
  if (new Set(positions.map(p => p.key)).size !== positions.length || positions.length > 100) throw Error('仓位列表存在重复或异常');
}
function blankMetrics() {
  return { entryPrice: null, markPrice: null, pnl: null, leverage: null, margin: null, liquidationPrice: null };
}
export function parsePositionText(text: string) {
  const count = text.match(/持仓数量[：:]\s*(\d+)/);
  if (!count) return null;
  if (Number(count[1]) === 0) return /当前无持仓/.test(text) ? [] : null;
  const blocks = text.match(/\d+\.\s*币种：[^\n]+[\s\S]*?(?=\n\n\d+\.\s*币种：|\n\n总保证金|$)/g) || [];
  const rows: Position[] = [];
  for (const block of blocks) {
    const symbol = block.match(/币种：\s*([^\s|]+)/)?.[1];
    const size = block.match(/持仓量：\s*([\d,.]+)/)?.[1]?.replace(/,/g, '');
    const sideMatch = block.match(/方向：\s*(做空|做多)/)?.[1];
    if (!symbol || !size || !sideMatch) return null;
    const field = (name: string) => num(block.match(new RegExp(name + '[：:]\\s*([+\\-]?[\\d,.]+)'))?.[1]);
    try {
      rows.push({ ...identity({symbol, quantity: size, side: sideMatch === '做空' ? 'SHORT' : 'LONG'}),
        entryPrice: field('开仓均价'), markPrice: field('标记价格'), margin: field('保证金'),
        pnl: field('浮动收益'), liquidationPrice: field('强平价格'),
        leverage: num(block.match(/永续\s*\|[^|]+\|\s*([\d.]+)x/)?.[1]) });
    } catch { return null; }
  }
  return rows.length === Number(count[1]) ? rows : null;
}
export function normalizeBinance(data: Bag, now = Date.now()): Snapshot {
  if (data.status !== 'ok' || data.syncOnline !== true) throw Error('来源同步器离线，保留最后有效仓位');
  const account = data.binanceAccount;
  if (!account || account.version !== 1 || account.source !== 'aoying-binance' ||
      account.portfolioId !== EXPECTED_PORTFOLIO || account.currency !== 'USDT') throw Error('源账户身份校验未通过');
  const sourceAt = validAt(account.positionsObservedAt, now, 90000);
  validAt(account.observedAt, now, 90000);
  if (!Array.isArray(account.positions)) throw Error('未收到完整仓位列表');
  const positions: Position[] = account.positions.map((p: Bag) => ({ ...identity(p), ...blankMetrics() }));
  unique(positions);
  const textSnapshot = Array.isArray(data.positions) ? data.positions.find((p: Bag) => /^熬鹰当前全部持仓/m.test(String(p.text || ''))) : null;
  let aligned = false, detailAt: string | null = null;
  if (textSnapshot) {
    try {
      detailAt = validAt(textSnapshot.updatedAt || textSnapshot.postedAt, now, 180000);
      const details = parsePositionText(textSnapshot.text);
      aligned = !!details && details.length === positions.length && positions.every(p => {
        const detail = details.find(d => d.key === p.key);
        return detail && Math.abs(Number(detail.quantity) - Number(p.quantity)) <= 0.0050000001;
      });
      if (aligned && details) for (const p of positions) {
        const detail = details.find(d => d.key === p.key)!;
        Object.assign(p, detail, {quantity: p.quantity});
      }
    } catch { aligned = false; detailAt = null; }
  }
  return { source: 'binance', sourceAt, detailAt, positions, detailsAligned: aligned, marginBalance: positive(account.accountMarginBalance) };
}
export function normalizeOkx(data: Bag, now = Date.now()): Snapshot {
  const leader = data?.leaders?.['aoying-okx'];
  if (data.status !== 'ok' || !leader || leader.key !== 'aoying-okx' || leader.stale !== false) throw Error('OKX 来源暂不可用，保留最后有效仓位');
  const sourceAt = validAt(leader.observedAt, now, 180000);
  if (!Array.isArray(leader.positions)) throw Error('未收到完整 OKX 仓位列表');
  const positions: Position[] = leader.positions.map((p: Bag) => ({
    ...identity(p), entryPrice: positive(p.entryPrice), markPrice: positive(p.markPrice),
    pnl: num(p.unrealizedPnl), leverage: positive(p.leverage), margin: num(p.marginUsdt),
    liquidationPrice: positive(p.liquidationPrice),
  }));
  unique(positions);
  return { source: 'okx', sourceAt, detailAt: sourceAt, positions, detailsAligned: true, marginBalance: num(leader.marginBalance) };
}
export function emptyState(): SourceState {
  return { snapshot: null, baseline: null, pending: null, pendingSince: 0, healthyAt: 0, status: 'offline', error: '等待首次同步' };
}
export function fingerprint(s: Snapshot) {
  return s.positions.map(p => p.key + '=' + p.quantity).sort().join('|');
}
export function compareSnapshots(before: Snapshot, after: Snapshot, now = Date.now()): MonitorEvent[] {
  const old = new Map(before.positions.map(p => [p.key, p]));
  const current = new Map(after.positions.map(p => [p.key, p]));
  const events: MonitorEvent[] = [];
  for (const key of new Set([...old.keys(), ...current.keys()])) {
    const a = old.get(key), b = current.get(key), p = (b || a)!;
    const delta = units(b?.quantity || '0') - units(a?.quantity || '0');
    if (delta === 0n) continue;
    const type = !a ? 'open' : !b ? 'close' : delta > 0n ? 'add' : 'reduce';
    events.push({ id: after.source + ':' + after.sourceAt + ':' + key + ':' + type, source: after.source, type,
      symbol: p.symbol, side: p.side, before: a?.quantity || '0', after: b?.quantity || '0',
      sourceAt: after.sourceAt, detectedAt: new Date(now).toISOString() });
  }
  return events;
}
export function advance(previous: SourceState | undefined, snapshot: Snapshot, now = Date.now()): {state: SourceState; events: MonitorEvent[]} {
  const prev = previous || emptyState();
  if (prev.snapshot && Date.parse(snapshot.sourceAt) < Date.parse(prev.snapshot.sourceAt)) {
    return {state: {...prev, status: 'offline', error: '收到较旧快照，等待最新数据', pending: null}, events: []};
  }
  const state: SourceState = {...prev, snapshot, healthyAt: now, status: 'live', error: null};
  if (!prev.baseline || now - prev.healthyAt > 120000) {
    const type = prev.baseline ? 'gap' : 'baseline';
    return { state: {...state, baseline: snapshot, pending: null, pendingSince: 0},
      events: [{id: snapshot.source + ':' + type + ':' + now, source: snapshot.source, type, symbol: '', side: '',
        before: '', after: '', sourceAt: snapshot.sourceAt, detectedAt: new Date(now).toISOString()}] };
  }
  if (fingerprint(prev.baseline) === fingerprint(snapshot)) {
    return {state: {...state, pending: null, pendingSince: 0}, events: []};
  }
  if (prev.pending && fingerprint(prev.pending) === fingerprint(snapshot) &&
      Date.parse(snapshot.sourceAt) > Date.parse(prev.pending.sourceAt) && now - prev.pendingSince >= 10000) {
    return { state: {...state, baseline: snapshot, pending: null, pendingSince: 0}, events: compareSnapshots(prev.baseline, snapshot, now) };
  }
  const samePending = prev.pending && fingerprint(prev.pending) === fingerprint(snapshot);
  return {state: {...state, status: 'pending', pending: samePending ? prev.pending : snapshot,
    pendingSince: samePending ? prev.pendingSince : now}, events: []};
}
export function failed(previous: SourceState | undefined, error: string): SourceState {
  return {...(previous || emptyState()), status: 'offline', error, pending: null, pendingSince: 0};
}
