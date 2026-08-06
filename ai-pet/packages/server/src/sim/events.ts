/**
 * 島の出来事（docs/02_ゲーム実装プラン/04_サーバ設計.md §5）
 *
 * ここで作られたイベントは3つの行き先を持つ:
 *   1. DB（island_event）… 島の客観ログ
 *   2. 近くにいたペットの記憶（M4以降。onFlushの購読者として足す）
 *   3. 接続中クライアントへの通知
 *
 * イベントの文面は日本語1文。ペットのプロンプトにそのまま載る前提で書く。
 */
import type { EntityId, IslandEvent, IslandEventKind, Vec2 } from '@ai-pet/shared';
import type { WorldClock } from './clock.ts';

/** 種別ごとの既定の重要度（docs 07章 §3.2） */
export const DEFAULT_IMPORTANCE: Record<IslandEventKind, number> = {
  born: 8,
  died: 8,
  quarrel: 6,
  befriend: 6,
  harvest: 3,
  build: 5,
  weather: 2,
  player_say: 5,
  pet_say: 4,
};

export interface EmitInput {
  kind: IslandEventKind;
  text: string;
  actorId?: EntityId;
  targetId?: EntityId;
  pos?: Vec2;
  /** 省略時は種別の既定値 */
  importance?: number;
}

/** 直近の重要な出来事を保持する数（留守中サマリの材料） */
const RECENT_KEEP = 60;

export class EventBus {
  private clock: WorldClock;
  private queue: IslandEvent[] = [];
  private recent: IslandEvent[] = [];
  private subscribers: ((events: IslandEvent[]) => void)[] = [];
  private totalEmitted = 0;
  private countByKind = new Map<IslandEventKind, number>();

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(clock: WorldClock) {
    this.clock = clock;
  }

  /** flush時にまとめて呼ばれる購読者を登録する（DB書き込み・記憶・通知） */
  onFlush(fn: (events: IslandEvent[]) => void): void {
    this.subscribers.push(fn);
  }

  emit(tick: number, input: EmitInput): void {
    const ev: IslandEvent = {
      kind: input.kind,
      tick,
      islandDay: this.clock.islandDay,
      text: input.text,
      importance: input.importance ?? DEFAULT_IMPORTANCE[input.kind],
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.pos !== undefined ? { pos: { x: input.pos.x, y: input.pos.y } } : {}),
    };
    this.queue.push(ev);
    this.totalEmitted++;
    this.countByKind.set(ev.kind, (this.countByKind.get(ev.kind) ?? 0) + 1);
  }

  /** 1tickの終わりに呼ぶ。溜まったイベントを購読者へ流して空にする */
  flush(): IslandEvent[] {
    if (this.queue.length === 0) return [];
    const batch = this.queue;
    this.queue = [];

    for (const ev of batch) {
      if (ev.importance >= 6) {
        this.recent.push(ev);
        if (this.recent.length > RECENT_KEEP) this.recent.shift();
      }
    }

    for (const fn of this.subscribers) {
      try {
        fn(batch);
      } catch (e) {
        // 購読者の失敗でシミュレーションを止めない
        console.error('[events] 購読者でエラー', e);
      }
    }
    return batch;
  }

  /** 重要な出来事の直近ぶん（新しい順）。留守中サマリに使う */
  recentImportant(limit = 10, minImportance = 6): IslandEvent[] {
    return this.recent
      .filter((e) => e.importance >= minImportance)
      .slice(-limit)
      .reverse();
  }

  pending(): number {
    return this.queue.length;
  }

  stats(): { total: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const [k, v] of this.countByKind) byKind[k] = v;
    return { total: this.totalEmitted, byKind };
  }
}

// ---------- 文面のテンプレート ----------
// ペットのプロンプトに載るので、主語と出来事が1文でわかるように書く。

export function textBorn(childName: string, parentName?: string): string {
  return parentName ? `${parentName}に子どもの${childName}が生まれた` : `${childName}が生まれた`;
}

export function textDied(name: string, byStarvation: boolean): string {
  return byStarvation ? `${name}が弱って巣に帰った` : `${name}が年をとって巣に帰った`;
}

export function textQuarrel(a: string, b: string, over: string): string {
  return `${a}と${b}が${over}を取り合ってケンカした`;
}

export function textBefriend(a: string, b: string): string {
  return `${a}と${b}が仲良くなった`;
}

export function textWeather(weather: string, season: string): string {
  const w: Record<string, string> = {
    clear: '晴れた',
    cloudy: '曇ってきた',
    rain: '雨が降りだした',
    fog: '霧が出てきた',
  };
  return `${season}の島で${w[weather] ?? '天気が変わった'}`;
}

export function textHarvest(who: string, what: string): string {
  return `${who}が${what}を収穫した`;
}
