import {normalizeBinance, normalizeOkx} from './monitor-model.ts';
export const SOURCE_URLS = {
  binance: 'https://qwer22.com/api/ao-ying/messages?limit=1&offset=0&positionLimit=5&positionOffset=0&muteLimit=1&muteOffset=0',
  okx: 'https://qwer22.com/api/ao-ying/leader-positions',
};
export async function samples({fetchImpl = fetch, now = Date.now, signal} = {}) {
  const pairs = await Promise.all(Object.entries(SOURCE_URLS).map(async ([source, url]) => {
    try {
      const timeout = AbortSignal.timeout(12000);
      const response = await fetchImpl(url, {
        headers: {Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AoyingReadOnlyMonitor/1.2)'},
        redirect: 'manual', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!response.ok) throw Error('upstream failure');
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        length += value.length;
        if (length > 1200000) { await reader.cancel(); throw Error('oversized response'); }
        chunks.push(value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const snapshot = source === 'binance' ? normalizeBinance(data, now()) : normalizeOkx(data, now());
      return [source, {snapshot}];
    } catch {
      return [source, {error: '数据源不可用、数据过期或快照未通过校验'}];
    }
  }));
  return Object.fromEntries(pairs);
}
