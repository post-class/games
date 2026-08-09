/**
 * input/selection.ts — 選択と編成（T-M5-07。`06§2` / `06§5`）
 *
 * 実装する操作:
 *  | 左クリック            | 単体選択                                            |
 *  | 左ドラッグ            | 範囲選択                                            |
 *  | `Alt`+ドラッグ        | **村人を除いて**範囲選択                            |
 *  | 左ダブルクリック      | **画面内**の同種すべて                              |
 *  | `Ctrl`+クリック       | **マップ全体**の同種すべて                          |
 *  | `Shift`+左クリック    | 選択に追加／入っていれば除外                        |
 *  | `Ctrl`+`A`            | 全戦闘ユニット。**戦域の兵は含めない**（§16-6）     |
 *  | `Ctrl`+`Shift`+`A`    | 戦域の兵も含める                                    |
 *  | `7`〜`0`              | 部隊グループ 4 つ（`Ctrl`+ で登録 / `Ctrl`+`Shift`+ で追加） |
 *
 * ■ 層の責務（手順書 §9.1）
 *   **選択状態は端末ローカル。`Command` にしない。**
 *   「選択した瞬間に手動になる」のは `moveUnits` などの Command が `manual` を立てるからで、
 *   選択そのものは sim を書き換えない。ここでは World を読むだけ。
 */

import { EntityKind, INVALID_ENTITY, type EntityId, type PlayerId } from '@/shared/types';
import { buildingDef } from '@/sim/core/defs';
import { idOfIndex, isAlive, resolveIndex } from '@/sim/core/entity';
import { isCombatUnit } from '@/sim/core/front';
import { FX_ONE } from '@/sim/core/fx';
import { isVillagerIndex } from '@/sim/core/gather';
import type { World } from '@/sim/core/world';
import { areAllies } from '@/sim/core/world';
import { type Camera, tileToScreen } from '@/render/iso';
import type { VisibilityQuery } from '@/render/spriteLayer';

/** 部隊グループの数（`7`〜`0` の 4 つ）。 */
export const UNIT_GROUP_COUNT = 4;

/** クリックでユニットを掴める距離（マス）。1 マス = 村人 1 体分の幅（`07§1`）。 */
const UNIT_PICK_RADIUS_TILES = 0.7;

/** 範囲選択の絞り込み条件。 */
export interface RectSelectOptions {
  /** `Alt`+ドラッグ: 村人を除く（`06§5`「前線で村人を巻き込まないため」）。 */
  readonly excludeVillagers?: boolean;
}

/** 画面座標の矩形。 */
export interface ScreenRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// ---------------------------------------------------------------- 選択状態

/** 端末ローカルの選択状態。 */
export class Selection {
  /** 選択中の EntityId（重複なし・挿入順）。 */
  private ids: EntityId[] = [];
  /** 部隊グループ（`7`〜`0`）。 */
  private readonly groups: EntityId[][] = Array.from({ length: UNIT_GROUP_COUNT }, () => []);
  /** 同じグループキーを 2 回続けて押したかの判定用。 */
  private lastGroupRecalled = -1;

  size(): number {
    return this.ids.length;
  }

  list(): readonly EntityId[] {
    return this.ids;
  }

  has(id: EntityId): boolean {
    return this.ids.includes(id);
  }

  /** 描画層に渡す集合（選択円の判定に使う）。 */
  asSet(): ReadonlySet<EntityId> {
    return new Set(this.ids);
  }

  clear(): void {
    this.ids = [];
  }

  set(ids: readonly EntityId[]): void {
    this.ids = dedupe(ids);
  }

  add(ids: readonly EntityId[]): void {
    this.ids = dedupe([...this.ids, ...ids]);
  }

  remove(ids: readonly EntityId[]): void {
    const drop = new Set(ids);
    this.ids = this.ids.filter((id) => !drop.has(id));
  }

  /** `Shift`+クリック: 入っていれば外し、無ければ足す。 */
  toggle(id: EntityId): void {
    if (this.has(id)) this.remove([id]);
    else this.add([id]);
  }

  /** 死んだ・世代が変わった EntityId を捨てる（毎フレーム呼ぶ）。 */
  prune(w: World): void {
    this.ids = this.ids.filter((id) => isAlive(w.entities, id));
    for (let g = 0; g < this.groups.length; g++) {
      this.groups[g] = this.groups[g]!.filter((id) => isAlive(w.entities, id));
    }
  }

  /** `Ctrl`+`7`〜`0`: 今の選択をグループに登録。 */
  setGroup(group: number, ids: readonly EntityId[] = this.ids): boolean {
    if (!validGroup(group)) return false;
    this.groups[group] = dedupe(ids);
    return true;
  }

  /** `Ctrl`+`Shift`+`7`〜`0`: グループに追加（増援の合流）。 */
  addToGroup(group: number, ids: readonly EntityId[] = this.ids): boolean {
    if (!validGroup(group)) return false;
    this.groups[group] = dedupe([...this.groups[group]!, ...ids]);
    return true;
  }

  /** グループの中身（HUD 表示用）。 */
  groupMembers(group: number): readonly EntityId[] {
    return validGroup(group) ? this.groups[group]! : [];
  }

  /**
   * `7`〜`0`: グループを呼び出す。
   * @returns `jump` が true なら「2 回続けて押された」= 視点を飛ばす（`06§5`）
   */
  recallGroup(group: number): { ok: boolean; jump: boolean } {
    if (!validGroup(group)) return { ok: false, jump: false };
    const members = this.groups[group]!;
    if (members.length === 0) return { ok: false, jump: false };
    const jump = this.lastGroupRecalled === group;
    this.set(members);
    this.lastGroupRecalled = group;
    return { ok: true, jump };
  }

  /** 別の操作をしたらグループの連打判定を解除する。 */
  resetGroupRecall(): void {
    this.lastGroupRecalled = -1;
  }
}

function validGroup(g: number): boolean {
  return Number.isInteger(g) && g >= 0 && g < UNIT_GROUP_COUNT;
}

function dedupe(ids: readonly EntityId[]): EntityId[] {
  const out: EntityId[] = [];
  const seen = new Set<EntityId>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- 拾う

/** そのエンティティが viewer から見えるか（敵は可視マスのみ）。 */
function pickable(
  w: World,
  i: number,
  viewer: PlayerId,
  vision: VisibilityQuery | null,
): boolean {
  const e = w.entities;
  const owner = e.owner[i]!;
  if (owner === viewer || areAllies(w, owner, viewer)) return true;
  if (vision === null) return true;
  return vision.isVisible(Math.floor(e.x[i]! / FX_ONE), Math.floor(e.y[i]! / FX_ONE));
}

/**
 * その地点にあるものを 1 つ拾う（左クリック）。
 * 優先順位は **ユニット → 建物・付属物 → 資源**（上に描かれているものから）。
 * 見つからなければ `INVALID_ENTITY`。
 */
export function pickEntityAt(
  w: World,
  viewer: PlayerId,
  tileX: number,
  tileY: number,
  vision: VisibilityQuery | null = null,
): EntityId {
  const e = w.entities;
  let bestUnit = -1;
  let bestUnitD = UNIT_PICK_RADIUS_TILES * UNIT_PICK_RADIUS_TILES;
  let bestOther = -1;
  let bestOtherD = Infinity;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const kind = e.kind[i]!;
    if (kind === EntityKind.None || kind === EntityKind.Projectile) continue;
    if (!pickable(w, i, viewer, vision)) continue;
    const ex = e.x[i]! / FX_ONE;
    const ey = e.y[i]! / FX_ONE;
    const dx = ex - tileX;
    const dy = ey - tileY;
    const d = dx * dx + dy * dy;

    if (kind === EntityKind.Unit) {
      if (d <= bestUnitD) {
        bestUnitD = d;
        bestUnit = i;
      }
      continue;
    }
    if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
      const def = buildingDef(e.typeId[i]!);
      const halfW = def.sizeW / 2;
      const halfH = def.sizeH / 2;
      if (Math.abs(dx) <= halfW && Math.abs(dy) <= halfH && d < bestOtherD) {
        bestOtherD = d;
        bestOther = i;
      }
      continue;
    }
    // 資源ノード（採集の右クリック対象にもなる）
    if (d <= 1 && d < bestOtherD) {
      bestOtherD = d;
      bestOther = i;
    }
  }
  const pick = bestUnit >= 0 ? bestUnit : bestOther;
  return pick < 0 ? INVALID_ENTITY : idOfIndex(e, pick);
}

/**
 * 範囲選択（左ドラッグ）。**自軍のユニットだけ**が対象。
 * `excludeVillagers` で村人を外す（`Alt`+ドラッグ）。
 */
export function selectInScreenRect(
  w: World,
  viewer: PlayerId,
  cam: Camera,
  rect: ScreenRect,
  opts: RectSelectOptions = {},
): EntityId[] {
  const e = w.entities;
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);
  const out: EntityId[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== viewer) continue;
    if (opts.excludeVillagers === true && isVillagerIndex(e, i)) continue;
    const p = tileToScreen(cam, e.x[i]! / FX_ONE, e.y[i]! / FX_ONE);
    if (p.sx < x0 || p.sx > x1 || p.sy < y0 || p.sy > y1) continue;
    out.push(idOfIndex(e, i));
  }
  return out;
}

/**
 * 画面内の同種すべて（左ダブルクリック。`06§2`）。
 * 「同種」= 同じ `typeId` の**自軍ユニット**。
 */
export function sameTypeInView(
  w: World,
  viewer: PlayerId,
  cam: Camera,
  typeId: number,
): EntityId[] {
  return selectInScreenRect(w, viewer, cam, { x0: 0, y0: 0, x1: cam.viewW, y1: cam.viewH }).filter(
    (id) => {
      const i = resolveIndex(w.entities, id);
      return i >= 0 && w.entities.typeId[i] === typeId;
    },
  );
}

/** マップ全体の同種すべて（`Ctrl`+クリック。`06§2`）。 */
export function sameTypeOnMap(w: World, viewer: PlayerId, typeId: number): EntityId[] {
  const e = w.entities;
  const out: EntityId[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== viewer) continue;
    if (e.typeId[i] !== typeId) continue;
    out.push(idOfIndex(e, i));
  }
  return out;
}

/**
 * `Ctrl`+`A` / `Ctrl`+`Shift`+`A`（`06§5`, 手順書 §16-6）。
 *
 * **既定では戦域に属している兵を含めない。**
 * 全戦線の自律が一斉に止まるのを防ぐための規則なので、
 * `includeFrontUnits` を既定 true にしてはいけない。
 */
export function selectAllCombatUnits(
  w: World,
  viewer: PlayerId,
  includeFrontUnits = false,
): EntityId[] {
  const e = w.entities;
  const out: EntityId[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== viewer) continue;
    if (!isCombatUnit(e, i)) continue; // 村人・非戦闘は含めない
    if (!includeFrontUnits && e.frontId[i] !== 0) continue;
    out.push(idOfIndex(e, i));
  }
  return out;
}

/** 選択中の内訳（`05§6-8` の選択一覧。typeId ごとにまとめる）。 */
export interface SelectionGroupInfo {
  readonly typeId: number;
  readonly kind: number;
  readonly ids: EntityId[];
}

/** 選択を種類ごとにまとめる（typeId 昇順）。 */
export function groupSelectionByType(w: World, ids: readonly EntityId[]): SelectionGroupInfo[] {
  const e = w.entities;
  const byType = new Map<number, SelectionGroupInfo>();
  for (const id of ids) {
    const i = resolveIndex(e, id);
    if (i < 0) continue;
    const key = e.kind[i]! * 100000 + e.typeId[i]!;
    let g = byType.get(key);
    if (g === undefined) {
      g = { typeId: e.typeId[i]!, kind: e.kind[i]!, ids: [] };
      byType.set(key, g);
    }
    g.ids.push(id);
  }
  return [...byType.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}
