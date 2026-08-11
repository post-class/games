import type { MissionDef } from '../mission/types';
import { RECOVERY_HOLD_SECONDS } from '../sim/recovery';
import { speakerName } from './veil/missions/shared';
import { veilPerson } from './veil/people';
import { veilTheater, type VeilTheaterId } from './veil/world';

/**
 * 動的作戦が扱う戦域id（THE VEIL FRONT）。
 *
 * 戦域の事実・圧力・表示名は `veil/world.ts` の `VEIL_THEATERS` を単一の
 * 出所とし、idもそちらの正典表記をそのまま使う（名前は再定義しない）。
 *
 * 8戦域のうち動的作戦の対象はここに挙げた5つだけ。
 * `ashcrown-corridor`（灰冠回廊）／`lagrange-rift`（ラグランジュ裂谷）／
 * `notary-relay`（ヴェガ門公証中継所）は本編の章専用の舞台なので、
 * 常設・動的作戦は発生させない。
 */
export type FrontlineSystemId = 'orion-port' | 'vega-gate' | 'quiet-sea' | 'deep-mining-belt' | 'hive-veins';
export type DynamicMissionKind = 'patrol' | 'escort' | 'strike' | 'rescue' | 'quiet' | 'capital';

/** 動的作戦の対象戦域。`VEIL_THEATERS` の部分集合であることを型で担保する。 */
export const FRONTLINE_SYSTEM_IDS = [
  'orion-port',
  'vega-gate',
  'quiet-sea',
  'deep-mining-belt',
  'hive-veins',
] as const satisfies readonly VeilTheaterId[] satisfies readonly FrontlineSystemId[];

/**
 * 旧セーブ（マッカフリー戦役）の戦域名 → 新戦域id。
 *
 * 方針: 既定値へ落とすのではなく**値を引き継いで移行する**。
 * control / pressure / logistics はどちらも同じ 0〜100 の意味なので、
 * プレイヤーが積み上げた戦況を捨てる理由がない。対応の根拠は、
 * 旧 McCaffrey が連邦側の後方拠点＝オリオン港、旧 Gimle が敵補給所を
 * 叩く資源地帯＝深層採掘帯、旧 Vega が決戦線＝ヴェガ門であること。
 */
const LEGACY_SYSTEM_ID_MAP: Record<string, FrontlineSystemId> = {
  McCaffrey: 'orion-port',
  Gimle: 'deep-mining-belt',
  Vega: 'vega-gate',
};

/** 戦域の日本語表示名。`VEIL_THEATERS` から引くので重複定義しない。 */
export function frontlineSystemName(id: FrontlineSystemId): string {
  return veilTheater(id).name;
}

/**
 * 未知・旧世代の戦域名を新戦域idへ寄せる。判別できない値は undefined。
 * セーブ読み込み（`save.ts`）と `normalizeFrontline` の両方で使う。
 */
export function migrateFrontlineSystemId(raw: unknown): FrontlineSystemId | undefined {
  if (typeof raw !== 'string') return undefined;
  if ((FRONTLINE_SYSTEM_IDS as readonly string[]).includes(raw)) return raw as FrontlineSystemId;
  return LEGACY_SYSTEM_ID_MAP[raw];
}

/**
 * 捜索救難の収容半径 (m)。
 *
 * 目標文と `spec.radius` の両方から参照して、表示と判定が必ず同じ値になるようにする。
 * 難民船は大きいので veil の 300m より少し広く取る。
 */
const RESCUE_RADIUS = 360;

/** 動的作戦の全種別。訓練室・外周作戦・テストの走査でこの並びを唯一の出所にする。 */
export const DYNAMIC_KINDS: DynamicMissionKind[] = ['patrol', 'escort', 'strike', 'rescue', 'quiet', 'capital'];

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

/**
 * 戦域の初期値。世界観spec §05「戦域別の状態と圧力」を3値へ写したもの。
 *
 * pressure は §05 の「圧力」を段階で固定し、戦域ごとに揺らさない:
 *   中 = 44 / 高 = 62 / 極高 = 82 / 不明 = 53
 * 「不明」は観測できていないだけで安全という意味ではないため、
 * 中(44)と高(62)の中間値 53 とする。楽観にも悲観にも寄せない。
 *
 * control は「0=帝国優勢 / 100=連邦優勢」なので、その戦域を実際に
 * 押さえている勢力と連邦の到達度で決める。連邦拠点＞共同航行圏＞
 * 中立勢力圏＞ニューロウム圏の順に低くなる。
 *
 * logistics は「連邦艦隊の補給余力」。修理設備の有無、航路の安定、
 * 資源の入手可否で決める。
 */
export function newFrontlineState(): FrontlineState {
  return {
    systems: {
      // オリオン港（連邦・圧力「高」）: 連邦の補給・修理拠点なので control は高い。
      // ただし避難民が流入して物資を食うため、拠点にしては logistics を抑える。
      'orion-port': { control: 72, pressure: 62, logistics: 66 },
      // ヴェガ門（共同設備・圧力「極高」）: 通行権をめぐる睨み合いで拮抗＝control は
      // ほぼ中央。門の稼働が不安定で補給が読めないため logistics は最低水準に近い。
      'vega-gate': { control: 48, pressure: 82, logistics: 44 },
      // 静穏海（セレシオン・圧力「中」）: 中立回廊が生きているので連邦機も通れるが、
      // 支配しているのはセレシオン。救難船団が航路を維持している分 logistics は最良。
      'quiet-sea': { control: 58, pressure: 44, logistics: 74 },
      // 深層採掘帯（オルド・圧力「中」）: オルド圏で連邦の影響は薄く control は劣勢寄り。
      // 採掘停止で未精製資源が手に入らず価格が急騰しているため logistics が痛い。
      'deep-mining-belt': { control: 40, pressure: 44, logistics: 38 },
      // 巣脈群（ニューロウム・圧力「不明」）: 連邦の足場が最も薄いので
      // control は最低。通信障害で補給の調整自体が通らないため logistics も低い。
      'hive-veins': { control: 32, pressure: 53, logistics: 46 },
    },
    operations: 0,
    // 戦役の起点は連邦の前進拠点。
    lastSystem: 'orion-port',
  };
}

export function normalizeFrontline(raw: unknown): FrontlineState {
  const fallback = newFrontlineState();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as { systems?: Record<string, unknown>; operations?: unknown; lastSystem?: unknown; lastKind?: unknown };
  // 旧セーブは McCaffrey / Gimle / Vega をキーに持つ。キー側を走査して
  // 移行表を通すので、未知のキーは例外にせず単に無視される。
  for (const [key, value] of Object.entries(r.systems ?? {})) {
    const id = migrateFrontlineSystemId(key);
    if (!id || !value || typeof value !== 'object') continue;
    const incoming = value as Partial<FrontlineSystemState>;
    fallback.systems[id] = {
      control: clamp(numberOr(incoming.control, fallback.systems[id].control), 0, 100),
      pressure: clamp(numberOr(incoming.pressure, fallback.systems[id].pressure), 0, 100),
      logistics: clamp(numberOr(incoming.logistics, fallback.systems[id].logistics), 0, 100),
    };
  }
  if (typeof r.operations === 'number' && Number.isFinite(r.operations)) fallback.operations = Math.max(0, Math.floor(r.operations));
  // lastSystem も移行表を通す。未知の値は既定値（オリオン港）のまま。
  const lastSystem = migrateFrontlineSystemId(r.lastSystem);
  if (lastSystem) fallback.lastSystem = lastSystem;
  if (typeof r.lastKind === 'string' && DYNAMIC_KINDS.includes(r.lastKind as DynamicMissionKind)) {
    fallback.lastKind = r.lastKind as DynamicMissionKind;
  }
  return fallback;
}

/**
 * 訓練室・チュートリアル・外周作戦の土台になる作戦定義。
 * quiet は「何も起きない哨戒」を明示的に実装したものだが、帰投まで
 * の航路と戦況の変化は残るので、単なる待ち時間にはならない。
 */
/** 動的作戦のブリーフィング話者。ウィリアム・ハート艦長 */
const HART_ID = 'confed-06';

export function dynamicMissionDef(ref: DynamicMissionRef): MissionDef {
  const name = frontlineSystemName(ref.system);
  const common = {
    id: ref.id,
    system: name,
    briefingSpeaker: `${speakerName(HART_ID)} 艦長`,
    briefingSpeakerRole: veilPerson(HART_ID).role,
    briefingSpeakerId: HART_ID,
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
      title: `${name} 哨戒 — 静かな航路`,
      briefing: ['定時哨戒だ。今日は敵影の報告がない。', '何も起きない一日を、何も起こさずに終わらせろ。'],
      spawns: [],
      objectives: [{ id: 'home', text: '航路を確認して帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } }],
    } as MissionDef;
  }

  if (ref.kind === 'escort') {
    return {
      ...common,
      title: `${name} 補給線護衛`,
      briefing: ['補給船団を一つ、前線まで通す。', '敵が来ても船団を見失うな。撃墜数は目的ではない。'],
      spawns: [
        { shipId: 'drayman', count: 1, faction: 'confed', tag: 'convoy', offset: [0, -300, 1500], speed: 34, cruiseToNav: 0 },
        { shipId: 'kf03-greyhaul', count: 2, faction: 'kilrathi', atNav: 0, delay: 1, offset: [1800, 400, -900], tag: 'raiders' },
        { shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', atNav: 0, delay: 34, offset: [-1800, -400, -1200], tag: 'raiders' },
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
      title: `${name} 捜索救難 — 帰還信号`,
      briefing: ['救難信号を拾った。敵の勢力圏だ。', '救える人数だけでいい。だが、信号を無視するな。'],
      spawns: [
        { shipId: 'refugee-liner', count: 1, faction: 'confed', atNav: 0, tag: 'survivors', speed: 8 },
        { shipId: 'ke04-mirage', count: 3, faction: 'kilrathi', atNav: 0, delay: 2, offset: [1900, 400, -1000] },
      ],
      objectives: [
        /*
         * T4-⑮: 収容は操作になった（近づいて減速し数秒保つ）。**目標文にも操作を書く。**
         * 条件の数値は `sim/recovery.ts` が唯一の出所なので、そこから文を組む
         * （ここで `3秒` などを直書きすると、条件を変えたときに表示だけ取り残される）。
         */
        {
          id: 'rescue',
          text: `生存者を収容（${RESCUE_RADIUS}m 以内で減速し${RECOVERY_HOLD_SECONDS}秒保つ）`,
          required: true,
          spec: { kind: 'rescue', tag: 'survivors', radius: RESCUE_RADIUS },
        },
        { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
      ],
    } as MissionDef;
  }

  if (ref.kind === 'capital') {
    return {
      ...common,
      title: `${name} 強襲 — 補給拠点`,
      briefing: ['敵の補給拠点を叩く。防衛線が薄い今だけの機会だ。', '砲塔、エンジンの順に機能を止め、最後に魚雷を撃ち込め。魚雷を無駄にするな。'],
      playerMissiles: [{ missileId: 'heat-seeker', count: 2 }, { missileId: 'torpedo', count: 3 }],
      spawns: [
        { shipId: 'kilrashi-destroyer', count: 1, faction: 'kilrathi', atNav: 0, tag: 'capital', speed: 20 },
        { shipId: 'kf06-talon', count: 2, faction: 'kilrathi', atNav: 0, delay: 1, tag: 'escort' },
        { shipId: 'kb02-bastion', count: 2, faction: 'kilrathi', atNav: 0, delay: 48, tag: 'escort' },
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
    title: `${name} ${strike ? '攻撃機掃討' : '前線哨戒'}`,
    briefing: strike
      ? ['敵の前線拠点を短時間で叩く。', '目標を見失わず、撃破を確認して帰投せよ。']
      : ['敵の哨戒隊が航路へ接近している。', '接触したら追い払い、深追いはするな。'],
    spawns: strike
      ? [
          { shipId: 'kb05-boarbreaker', count: 1, faction: 'kilrathi', atNav: 0, tag: 'target', speed: 24 },
          { shipId: 'kf03-greyhaul', count: 3, faction: 'kilrathi', atNav: 0, delay: 2, tag: 'escort' },
        ]
      : [{ shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', atNav: 0, delay: 1, tag: 'patrol' }],
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
