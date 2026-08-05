import type { MissionDef } from '../mission/types';

export type FrontlineSystemId = 'McCaffrey' | 'Gimle' | 'Vega';
export type DynamicMissionKind = 'patrol' | 'escort' | 'strike' | 'rescue' | 'quiet' | 'capital';

const DYNAMIC_KINDS: DynamicMissionKind[] = ['patrol', 'escort', 'strike', 'rescue', 'quiet', 'capital'];

export interface FrontlineSystemState {
  /** 0 = 帝国優勢、100 = 連邦優勢 */
  control: number;
  /** 敵の攻勢。高いほど増援が多い */
  pressure: number;
  /** 艦隊に残る補給余力 */
  logistics: number;
}

export interface FrontlineState {
  systems: Record<FrontlineSystemId, FrontlineSystemState>;
  operations: number;
  lastSystem: FrontlineSystemId;
  lastKind?: DynamicMissionKind;
}

export interface DynamicMissionRef {
  id: string;
  system: FrontlineSystemId;
  kind: DynamicMissionKind;
  seed: number;
  returnNode: string;
}

export function newFrontlineState(): FrontlineState {
  return {
    systems: {
      McCaffrey: { control: 54, pressure: 38, logistics: 78 },
      Gimle: { control: 48, pressure: 50, logistics: 70 },
      Vega: { control: 43, pressure: 62, logistics: 64 },
    },
    operations: 0,
    lastSystem: 'McCaffrey',
  };
}

export function normalizeFrontline(raw: unknown): FrontlineState {
  const fallback = newFrontlineState();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<FrontlineState>;
  for (const id of Object.keys(fallback.systems) as FrontlineSystemId[]) {
    const incoming = r.systems?.[id];
    if (!incoming) continue;
    fallback.systems[id] = {
      control: clamp(numberOr(incoming.control, fallback.systems[id].control), 0, 100),
      pressure: clamp(numberOr(incoming.pressure, fallback.systems[id].pressure), 0, 100),
      logistics: clamp(numberOr(incoming.logistics, fallback.systems[id].logistics), 0, 100),
    };
  }
  if (typeof r.operations === 'number' && Number.isFinite(r.operations)) fallback.operations = Math.max(0, Math.floor(r.operations));
  if (r.lastSystem && r.lastSystem in fallback.systems) fallback.lastSystem = r.lastSystem;
  if (r.lastKind && DYNAMIC_KINDS.includes(r.lastKind)) {
    fallback.lastKind = r.lastKind;
  }
  return fallback;
}

export function applyFrontlineOutcome(
  state: FrontlineState,
  ref: DynamicMissionRef,
  outcome: 'win' | 'loss',
  summary: { escortLost?: boolean; kills?: number },
): void {
  const system = state.systems[ref.system];
  if (!system) return;
  const win = outcome === 'win';
  const kills = Math.max(0, Math.floor(numberOr(summary.kills, 0)));
  const pressureSwing = win ? -5 : 8;
  const controlSwing = win
    ? (ref.kind === 'quiet' ? 2 : 7 + Math.min(3, Math.floor(kills / 4)))
    : -6;
  // 補給線を直接扱う任務だけが logistics を大きく動かす。哨戒や強襲の
  // 成功を補給回復として扱うと、戦況の三つの値が同じ意味になってしまう。
  const logisticsSwing = win
    ? ref.kind === 'escort'
      ? summary.escortLost ? -5 : 8
      : ref.kind === 'rescue'
        ? 3
        : ref.kind === 'capital'
          ? 4
          : 0
    : ref.kind === 'escort' || summary.escortLost ? -7 : -2;
  system.control = clamp(system.control + controlSwing, 0, 100);
  system.pressure = clamp(system.pressure + pressureSwing, 0, 100);
  system.logistics = clamp(system.logistics + logisticsSwing, 0, 100);
  state.operations += 1;
  state.lastSystem = ref.system;
  state.lastKind = ref.kind;
}

/** 次の補給・哨戒作戦を決める。結果は seed だけで再現できる。 */
export function chooseDynamicMission(
  state: FrontlineState,
  returnNode: string,
  serial: number,
): DynamicMissionRef {
  const systems = Object.keys(state.systems) as FrontlineSystemId[];
  if (systems.length === 0) throw new Error('frontline has no systems');
  const safeSerial = Number.isFinite(serial) ? Math.max(0, Math.floor(serial)) : 0;
  const system = [...systems].sort((a, b) => dangerOf(state.systems[b]) - dangerOf(state.systems[a]))[safeSerial % systems.length];
  const frontline = state.systems[system];
  const kinds: DynamicMissionKind[] =
    frontline.logistics < 35
      ? ['rescue', 'escort', 'quiet']
      : frontline.pressure > 72
        ? ['capital', 'strike', 'patrol']
        : ['patrol', 'escort', 'strike', 'rescue', 'quiet'];
  const kind = kinds[safeSerial % kinds.length];
  return { id: `dynamic-${safeSerial}-${system}-${kind}`, system, kind, seed: safeSerial, returnNode };
}

/**
 * 固定キャンペーンの隙間に差し込む作戦群。
 * quiet は「何も起きない哨戒」を明示的に実装したものだが、帰投まで
 * の航路と戦況の変化は残るので、単なる待ち時間にはならない。
 */
export function dynamicMissionDef(ref: DynamicMissionRef): MissionDef {
  const common = {
    id: ref.id,
    system: ref.system,
    briefingSpeaker: 'ハルシオン大佐',
    playerShipId: ref.kind === 'capital' ? 'rapier' : 'hornet',
    navs: [
      { name: '発艦点', pos: [0, 0, -3600] as [number, number, number] },
      { name: '帰投', pos: [0, 0, 0] as [number, number, number], arriveRadius: 1400 },
    ],
    skybox: { nebulaHue: 0.04 + (ref.seed % 5) * 0.12, seed: 7000 + ref.seed },
    debriefWin: ['戦況図に新しい線が引かれた。小さな勝利でも、線は確かに動く。'],
    debriefLoss: ['敵の圧力は増した。艦隊は別の航路を探すことになる。'],
  } satisfies Partial<MissionDef>;

  if (ref.kind === 'quiet') {
    return {
      ...common,
      title: `${ref.system} 哨戒 — 静かな航路`,
      briefing: ['定時哨戒だ。今日は敵影の報告がない。', '何も起きない一日を、何も起こさずに終わらせろ。'],
      spawns: [],
      objectives: [{ id: 'home', text: '航路を確認して帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } }],
    } as MissionDef;
  }

  if (ref.kind === 'escort') {
    return {
      ...common,
      title: `${ref.system} 補給線護衛`,
      briefing: ['補給船団を一つ、前線まで通す。', '敵が来ても船団を見失うな。撃墜数は目的ではない。'],
      spawns: [
        { shipId: 'drayman', count: 1, faction: 'confed', tag: 'convoy', offset: [0, -300, 1500], speed: 34, cruiseToNav: 0 },
        { shipId: 'dralthi', count: 2, faction: 'kilrathi', atNav: 0, delay: 1, offset: [1800, 400, -900], tag: 'raiders' },
        { shipId: 'salthi', count: 2, faction: 'kilrathi', atNav: 0, delay: 34, offset: [-1800, -400, -1200], tag: 'raiders' },
      ],
      objectives: [
        { id: 'convoy', text: '補給船団を守る', required: true, spec: { kind: 'protect', tag: 'convoy' } },
        { id: 'home', text: '船団を帰投させる', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
      ],
    } as MissionDef;
  }

  if (ref.kind === 'rescue') {
    return {
      ...common,
      title: `${ref.system} 捜索救難 — 帰還信号`,
      briefing: ['救難信号を拾った。敵の勢力圏だ。', '救える人数だけでいい。だが、信号を無視するな。'],
      spawns: [
        { shipId: 'refugee-liner', count: 1, faction: 'confed', atNav: 0, tag: 'survivors', speed: 8 },
        { shipId: 'salthi', count: 3, faction: 'kilrathi', atNav: 0, delay: 2, offset: [1900, 400, -1000] },
      ],
      objectives: [
        { id: 'rescue', text: '生存者を回収', required: true, spec: { kind: 'rescue', tag: 'survivors', radius: 360 } },
        { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
      ],
    } as MissionDef;
  }

  if (ref.kind === 'capital') {
    return {
      ...common,
      title: `${ref.system} 強襲 — 補給拠点`,
      briefing: ['敵の補給拠点を叩く。防衛線が薄い今だけの機会だ。', '砲塔、エンジンの順に機能を止め、最後に魚雷を撃ち込め。魚雷を無駄にするな。'],
      playerMissiles: [{ missileId: 'heat-seeker', count: 2 }, { missileId: 'torpedo', count: 3 }],
      spawns: [
        { shipId: 'ralatha', count: 1, faction: 'kilrathi', atNav: 0, tag: 'capital', speed: 20 },
        { shipId: 'jalthi', count: 2, faction: 'kilrathi', atNav: 0, delay: 1, tag: 'escort' },
        { shipId: 'gratha', count: 2, faction: 'kilrathi', atNav: 0, delay: 48, tag: 'escort' },
      ],
      objectives: [
        { id: 'capital', text: '補給拠点を撃破', required: true, spec: { kind: 'destroyTag', tag: 'capital' } },
        { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
      ],
      capitalStages: [
        { id: 'turret', text: '補給拠点の砲塔を無力化', tag: 'capital', subsystem: 'turret' },
        { id: 'engine', text: '補給拠点のエンジンを停止', tag: 'capital', subsystem: 'engine' },
        { id: 'torpedo', text: '補給拠点へ対艦魚雷を発射', tag: 'capital', weapon: 'torpedo' },
      ],
    } as MissionDef;
  }

  const strike = ref.kind === 'strike';
  return {
    ...common,
    title: `${ref.system} ${strike ? '攻撃機掃討' : '前線哨戒'}`,
    briefing: strike
      ? ['敵の前線拠点を短時間で叩く。', '目標を見失わず、撃破を確認して帰投せよ。']
      : ['敵の哨戒隊が航路へ接近している。', '接触したら追い払い、深追いはするな。'],
    spawns: strike
      ? [
          { shipId: 'dorkir', count: 1, faction: 'kilrathi', atNav: 0, tag: 'target', speed: 24 },
          { shipId: 'dralthi', count: 3, faction: 'kilrathi', atNav: 0, delay: 2, tag: 'escort' },
        ]
      : [{ shipId: 'salthi', count: 2, faction: 'kilrathi', atNav: 0, delay: 1, tag: 'patrol' }],
    objectives: strike
      ? [
          { id: 'target', text: '攻撃機を撃破', required: true, spec: { kind: 'destroyTag', tag: 'target' } },
          { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
        ]
      : [
          { id: 'clear', text: '哨戒隊を撃退', required: true, spec: { kind: 'destroyAll' } },
          { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
        ],
  } as MissionDef;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function dangerOf(system: FrontlineSystemState): number {
  // 制宙度の低さを主軸に、敵圧力と補給余力も選定へ反映する。
  return (100 - system.control) * 0.5 + system.pressure * 0.3 + (100 - system.logistics) * 0.2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
