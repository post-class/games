/**
 * Nav 到着時の間合い (T2-⑤)。
 *
 * ■ 何が問題だったか
 * 出現位置は「Nav の座標 + `SpawnGroupDef.offset`」だけで決まっていた。
 * offset は演出のために数km単位で置かれている一方、Nav の到達半径も
 * 900〜2600m ある。両者が足し合わさると、**到着した瞬間に主目標が
 * 6〜11km 先**という状態が普通に起きる。この距離では画面に何も映らず、
 * 制限時間だけが減っていく（第1章の実プレイで確認済み）。
 *
 * ■ どう直したか（3つのうち「出現位置のオフセット」を選んだ理由）
 * 候補は (a) Nav の到達半径を広げる (b) 出現位置を寄せる
 * (c) オートパイロットの停止距離を詰める、の3つだった。
 *
 * - (a) は到達半径が `escortArrive` の判定半径・`pushOutOfClearZones` の
 *   空白域・オートパイロットの停止距離を兼ねているため、広げると
 *   「Nav の手前で勝手に到達扱いになる」副作用が出る。
 * - (c) だけでは offset 由来の距離（最大 6.3km）が残る。
 * - (b) は Nav の意味も到達判定も変えずに、**到着時に見える**という
 *   目的だけを達成できる。群ごとに base をまとめて動かすので、
 *   隊形（相対位置）は崩れない。
 *
 * よって (b) を主とし、加えて「隊形が横に伸びすぎて端の機体が
 * 見えなくなる」問題（第3章の避難船18隻は既定式で片側 11.9km に達した）を
 * 隊列幅の上限で抑える。
 *
 * ■ 保証する値
 * - 群の中心（隊形の基準点）: 自機から `NAV_ARRIVE_TARGET_RANGE` 以内
 * - 群のどの機体も: 自機から `navArrivalMemberRange()` 以内
 *
 * `MissionRunner.spawnGroup()` と、上限を固定するテストの両方が
 * このファイルの関数を使う（判定式を二重に持たない）。
 */

import { Vector3 } from 'three';
import type { MissionDef, ObjectiveSpec, SpawnGroupDef } from './types';

/** Nav 到着時、その Nav に紐づく主目標の中心をここまで寄せる (m) */
export const NAV_ARRIVE_TARGET_RANGE = 2600;
/** 隊形が横へ伸びる幅の上限 (片側, m)。端の機体が視界外へ出ないようにする */
export const NAV_ARRIVE_FORMATION_HALF_WIDTH = 1400;
/** 1機ごとのばらけ幅の上限 (m)。宣言された `spread` がこれを超えたら詰める */
export const NAV_ARRIVE_SPREAD_CAP = 700;

/** 目標が読む（＝主目標である）タグの一覧 */
export function objectiveTagsOf(def: MissionDef): Set<string> {
  const tags = new Set<string>();
  const add = (t?: string) => {
    if (t) tags.add(t);
  };
  for (const o of def.objectives) add((o.spec as Extract<ObjectiveSpec, { tag: string }>).tag);
  for (const s of def.capitalStages ?? []) add(s.tag);
  for (const s of def.capitalSequence ?? []) add(s.tag);
  return tags;
}

/**
 * この群は「Nav 到着時に見えていなければならない主目標」か。
 *
 * - Nav に紐づいて出る群だけを対象にする（開始時に出る群は自機の隣から始まる）。
 * - 目標が読まないタグ（背景の艦・演出用の群）は動かさない。
 */
export function isArrivalTarget(g: SpawnGroupDef, objectiveTags: ReadonlySet<string>): boolean {
  return g.atNav !== undefined && !!g.tag && objectiveTags.has(g.tag);
}

/** 到着時に詰める前提での、1機ごとのばらけ幅 */
export function arrivalSpread(spread: number): number {
  return Math.min(spread, NAV_ARRIVE_SPREAD_CAP);
}

/**
 * 隊列の1機ぶんの間隔。
 * 既定式は `spread * 0.9` だが、隻数が多いと片側の幅が
 * `spread * 0.9 * (count-1)/2` まで伸びる（18隻・spread 2400 で 11.9km）。
 * 片側 `NAV_ARRIVE_FORMATION_HALF_WIDTH` に収まるところまで詰める。
 */
export function arrivalFormationStep(spread: number, count: number): number {
  const step = arrivalSpread(spread) * 0.9;
  const half = Math.max(1, (count - 1) / 2);
  return Math.min(step, NAV_ARRIVE_FORMATION_HALF_WIDTH / half);
}

/**
 * 群の中心を、基準点（到着した自機）から `NAV_ARRIVE_TARGET_RANGE` 以内へ引き寄せる。
 * 遠いときだけ縮めるので、もともと近い群は一切動かない。
 * `base` を破壊的に更新する。
 */
export function pullIntoArriveRange(base: Vector3, ref: Vector3): void {
  const d = base.distanceTo(ref);
  if (d <= NAV_ARRIVE_TARGET_RANGE || d < 1e-6) return;
  base.lerp(ref, 1 - NAV_ARRIVE_TARGET_RANGE / d);
}

/** 群のどの機体も、基準点からこの距離以内に出る（隊列幅とばらけ幅の worst case） */
export function navArrivalMemberRange(spread: number, count: number): number {
  const s = arrivalSpread(spread);
  const half = arrivalFormationStep(spread, count) * Math.max(0, (count - 1) / 2);
  const dx = s + half;
  const dy = s * 0.4;
  const dz = s;
  return NAV_ARRIVE_TARGET_RANGE + Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface NavArrivalRange {
  navIndex: number;
  navName: string;
  tag: string;
  shipId: string;
  count: number;
  /** 到着した自機から群の中心までの上限 (m) */
  centerRange: number;
  /** 到着した自機から群のどの機体までの上限 (m) */
  memberRange: number;
}

/**
 * 「Nav に到着した時点で主目標が何m先か」の上限を全ミッションぶん測るための一覧。
 * テストがこの値の上限を固定する。
 */
export function navArrivalRanges(def: MissionDef): NavArrivalRange[] {
  const objectiveTags = objectiveTagsOf(def);
  const out: NavArrivalRange[] = [];
  for (const g of def.spawns) {
    if (!isArrivalTarget(g, objectiveTags)) continue;
    const nav = def.navs[g.atNav!];
    if (!nav) continue;
    // 出現位置は「Nav 座標 + offset」を自機まで引き寄せたもの。
    // 引き寄せ後の中心距離は必ず NAV_ARRIVE_TARGET_RANGE 以下になる。
    const rawOffset = new Vector3(...(g.offset ?? [0, 0, 0])).length();
    const arriveRadius = nav.arriveRadius ?? 900;
    const spread = g.spread ?? 260;
    out.push({
      navIndex: g.atNav!,
      navName: nav.name,
      tag: g.tag!,
      shipId: g.shipId,
      count: g.count,
      centerRange: Math.min(NAV_ARRIVE_TARGET_RANGE, rawOffset + arriveRadius),
      memberRange: Math.min(NAV_ARRIVE_TARGET_RANGE, rawOffset + arriveRadius) +
        (navArrivalMemberRange(spread, g.count) - NAV_ARRIVE_TARGET_RANGE),
    });
  }
  return out;
}
