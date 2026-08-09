import type { Faction } from './ships';
import { FACTION_ID_MAP, VEIL_FACTIONS, type VeilFactionId } from './veil/world';

/**
 * 勢力間の関係。
 *
 * - `hostile`: 交戦する。AI・照準・ミサイル判定のすべてで敵として扱う。
 * - `neutral`: 交戦しない。攻撃されれば防衛するが、判定上は非敵対。
 *
 * 表示色（HUD・照準）と実挙動（敵対判定）は、どちらもこのテーブルから
 * 生成する。表示だけを変えて実挙動が変わらない状態を作らないため、
 * `isHostile` / `factionColor` は同じ `factionStance` を経由する。
 */
export type FactionStance = 'hostile' | 'neutral';

/**
 * 既定の敵対関係（世界観_歴史仕様 §03）。
 *
 * - 連邦 ↔ キルラシー: 全面交戦。
 * - セレシオン: 武装中立。誰とも交戦しない。
 * - オルド: 条件付き協力。非敵対（第4章の重力戦術官は敵ではない）。
 * - ニューロウム: 意図不明。既定では連邦・キルラシー双方と敵対（第6章で交戦）。
 * - neutral: 民間・救難など。誰とも非敵対（既存挙動）。
 *
 * 対称な関係のみを扱うため、キーは `stanceKey()` で正規化した組にする。
 * 表に無い組み合わせは `neutral`（非敵対）として扱う。
 */
const DEFAULT_HOSTILE_PAIRS: readonly (readonly [Faction, Faction])[] = [
  ['confed', 'kilrathi'],
  ['confed', 'neurowm'],
  ['kilrathi', 'neurowm'],
];

/** 対称なキー（並び順に依存しない）を作る。 */
function stanceKey(a: Faction, b: Faction): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildDefaultStances(): Map<string, FactionStance> {
  const m = new Map<string, FactionStance>();
  for (const [a, b] of DEFAULT_HOSTILE_PAIRS) m.set(stanceKey(a, b), 'hostile');
  return m;
}

/**
 * 実行時の関係テーブル。第8章以降の共同作戦のように、
 * キャンペーン進行で関係が変わる場面では `setFactionStance` で上書きする。
 */
let stances: Map<string, FactionStance> = buildDefaultStances();

/** 現在の関係を返す。同一勢力・`neutral` を含む組は常に非敵対。 */
export function factionStance(a: Faction, b: Faction): FactionStance {
  if (a === b) return 'neutral';
  if (a === 'neutral' || b === 'neutral') return 'neutral';
  return stances.get(stanceKey(a, b)) ?? 'neutral';
}

/**
 * 関係を実行時に上書きする（例: 第8章の連邦とキルラシーの共同作戦）。
 * 対称に適用され、`resetFactionStances()` で既定値へ戻る。
 */
export function setFactionStance(a: Faction, b: Faction, stance: FactionStance): void {
  if (a === b || a === 'neutral' || b === 'neutral') return;
  stances.set(stanceKey(a, b), stance);
}

/** 関係テーブルを既定値（世界観仕様どおり）へ戻す。ミッション開始時に呼ぶ。 */
export function resetFactionStances(): void {
  stances = buildDefaultStances();
}

/** 陣営の敵対関係。neutral はどちらとも交戦しない。 */
export function isHostile(a: Faction, b: Faction): boolean {
  return factionStance(a, b) === 'hostile';
}

/** 既存 `Faction` から資料側 id への逆引き（表示名・色を world.ts から取るため）。 */
const VEIL_ID_BY_FACTION = new Map<string, VeilFactionId>(
  (Object.keys(FACTION_ID_MAP) as VeilFactionId[]).map((id) => [FACTION_ID_MAP[id], id]),
);

function veilDef(f: Faction): (typeof VEIL_FACTIONS)[number] | undefined {
  const id = VEIL_ID_BY_FACTION.get(f);
  if (!id) return undefined;
  return VEIL_FACTIONS.find((v) => v.id === id);
}

export function factionLabel(f: Faction): string {
  // 既存表示（連邦 / キルラシー / 中立）は HUD・無線・戦況文で使われているため維持する。
  switch (f) {
    case 'confed':
      return '連邦';
    case 'kilrathi':
      return 'キルラシー';
    case 'neutral':
      return '中立';
    default:
      // 新勢力の表示名は world.ts（世界観仕様）を単一の出所とする。
      return veilDef(f)?.name ?? '中立';
  }
}

/** 勢力固有色（名鑑の色値）。CSS 変数名は `--faction-<id>`。 */
export function factionColorVar(f: Faction): string {
  if (f === 'neutral') return 'var(--neutral)';
  return `var(--faction-${f})`;
}

/**
 * 勢力固有色の実値（SVG の fill など、CSS 変数を使えない箇所用）。
 * 値は world.ts の名鑑色と同一で、`ui.css` の `--faction-*` と同じ出所。
 */
export const FACTION_HEX: Record<Faction, string> = {
  confed: veilDef('confed')!.color,
  kilrathi: veilDef('kilrathi')!.color,
  serecion: veilDef('serecion')!.color,
  ordo: veilDef('ordo')!.color,
  neurowm: veilDef('neurowm')!.color,
  neutral: '#ffd166',
};

/**
 * HUD の色 (プレイヤー陣営を味方色として扱う)。
 *
 * 敵味方軸: 自陣営 = `--friend`、敵対 = `--enemy`、中立 = `--neutral`。
 * 非敵対の他勢力（セレシオン・オルド、共同作戦中の相手など）は敵色にせず、
 * 勢力固有色で表示する。敵対判定は `isHostile` と同じテーブルを参照する。
 */
export function factionColor(f: Faction, playerFaction: Faction): string {
  if (f === 'neutral') return 'var(--neutral)';
  if (f === playerFaction) return 'var(--friend)';
  if (isHostile(playerFaction, f)) return 'var(--enemy)';
  return factionColorVar(f);
}
