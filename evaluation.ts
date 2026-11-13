import {compareSnapshots, fingerprint, SOURCE_NAMES} from './monitor-model.ts';
import type {Snapshot, Source, MonitorEvent} from './monitor-model';

export type MonitorSample = {snapshot: Snapshot; error?: never} | {snapshot?: never; error: string};
export type MonitorMemory = {
  snapshots: Partial<Record<Source, Snapshot>>;
  health: Partial<Record<Source, 'live'|'offline'|'unstable'>>;
  pending?: Partial<Record<Source, {snapshot: Snapshot; observedAt: number}>>;
};
export type MonitorChange = MonitorEvent & {intervalStart: string; intervalEnd: string};
export type MonitorReport = {
  id: string; checkedAt: string; shouldNotify: boolean; messages: string[]; changes: MonitorChange[];
  health: Partial<Record<Source, string>>; acknowledgedAt?: string;
};
export type MonitorStore = MonitorMemory & {report?: MonitorReport};
export function evaluateSamples(previous: MonitorMemory, first: Record<Source,MonitorSample>, second: Record<Source,MonitorSample>, now: number) {
  const memory: MonitorMemory = {snapshots:{...previous.snapshots},health:{...previous.health},pending:{...previous.pending}};
  const changes: MonitorChange[] = [], messages: string[] = [];
  for (const source of ['binance','okx'] as Source[]) {
    const a = first[source], b = second[source], name = SOURCE_NAMES[source];
    if (!a.snapshot || !b.snapshot) {
      delete memory.pending![source];
      memory.health[source]='offline';
      if (previous.health[source]!=='offline') messages.push(name+'：本次数据源不可用，已保留上次有效基准，不判定开平仓。');
      continue;
    }
    const current=b.snapshot, before=previous.snapshots[source];
    const pending=previous.pending?.[source];
    const changed=!!before&&fingerprint(before)!==fingerprint(current);
    const confirmedAcrossRounds=!!pending&&fingerprint(pending.snapshot)===fingerprint(current)&&
      Date.parse(current.sourceAt)>Date.parse(pending.snapshot.sourceAt)&&now-pending.observedAt>=10000;
    const older=before&&Date.parse(current.sourceAt)<Date.parse(before.sourceAt);
    if (older || fingerprint(a.snapshot)!==fingerprint(current) ||
        (changed && Date.parse(current.sourceAt)<=Date.parse(a.snapshot.sourceAt) && !confirmedAcrossRounds)) {
      memory.health[source]='unstable';
      if(!older)memory.pending![source]={snapshot:current,observedAt:now};
      else delete memory.pending![source];
      if(previous.health[source]!=='unstable') messages.push(name+'：本次仓位变化尚未完成复核，暂不判定开平仓；等待下一轮复核。');
      continue;
    }
    memory.health[source]='live';
    delete memory.pending![source];
    if(previous.health[source]==='offline'||previous.health[source]==='unstable') messages.push(name+'：数据校验已恢复。');
    if(before) changes.push(...compareSnapshots(before,current,now).map(event=>({...event,intervalStart:before.sourceAt,intervalEnd:current.sourceAt})));
    memory.snapshots[source]=current;
  }
  return {memory,changes,messages};
}
