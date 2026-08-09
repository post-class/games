/**
 * render/vision.ts — 視界バッファ 3 状態（T-M5-05。`07§7` / 手順書 §7.2）
 *
 * 1 マス単位で 3 状態を持つ:
 *   未探索（真っ暗） / 既知（暗がり） / 可視
 *
 * ■ 既知が覚えているもの（`07§7` の表そのまま）
 *   - **最後に見た時点の地形**（`knownTile`）
 *   - **最後に見た時点の建物の形**（`knownBuilding` = typeId + 1、`knownOwner`）
 *   覚えないもの: 今そこにいる敵 / 建物の体力 / 破壊されたかどうか。
 *   したがって「建物は嘘をつく」（壊れていても古い形が残る）が自動的に成立する。
 *   HP を覚える列を**足してはいけない**。
 *
 * ■ 更新間隔
 *   毎 tick 更新する必要はない（見た目に影響しない）ので
 *   `config.json` の `vision.updateIntervalTicks`（= 5 tick）ごとに更新する。
 *
 * ■ 層
 *   これは端末ローカルの派生情報なので **World に持たせない**（決定論の対象外）。
 *   sim は読むだけ（手順書 §3.1）。
 */

import { EntityKind, NEUTRAL_OWNER, type PlayerId } from '@/shared/types';
import { cfgInt } from '@/sim/core/config';
import { buildingDef, unitDef } from '@/sim/core/defs';
import { FX_ONE } from '@/sim/core/fx';
import { hasTerrain, tileIndex } from '@/sim/core/terrain';
import type { MapState, World } from '@/sim/core/world';
import { areAllies } from '@/sim/core/world';

/** 視界の 3 状態。`VisionBuffer.state` の値。 */
export const VisionState = {
  /** 未探索。地形も資源も分からない。 */
  Unexplored: 0,
  /** 既知。最後に見た地形と建物の形だけ。 */
  Known: 1,
  /** 可視。敵の位置・種類・体力、資源の残量まで見える。 */
  Visible: 2,
} as const;
export type VisionStateId = (typeof VisionState)[keyof typeof VisionState];

/** 視界更新の間隔（tick）。`config.json` の `vision.updateIntervalTicks`。 */
export const VISION_UPDATE_INTERVAL_TICKS: number = cfgInt('vision.updateIntervalTicks');

/** 1 マス単位の視界バッファ。 */
export class VisionBuffer {
  readonly widthTiles: number;
  readonly heightTiles: number;

  /** 3 状態（`VisionState`）。 */
  readonly state: Uint8Array;
  /** 最後に見た地形（`Tile`）。未探索は 0。 */
  readonly knownTile: Uint8Array;
  /** 最後に見た建物の typeId + 1（0 = 建物なし）。**HP は持たない。** */
  readonly knownBuilding: Uint16Array;
  /** 最後に見た建物の所有者（255 = 中立）。 */
  readonly knownOwner: Uint8Array;

  private lastUpdateTick = -1;
  /** 全開放（観戦・リプレイ）。 */
  private revealed = false;

  constructor(widthTiles: number, heightTiles: number) {
    this.widthTiles = widthTiles;
    this.heightTiles = heightTiles;
    const n = widthTiles * heightTiles;
    this.state = new Uint8Array(n);
    this.knownTile = new Uint8Array(n);
    this.knownBuilding = new Uint16Array(n);
    this.knownOwner = new Uint8Array(n).fill(NEUTRAL_OWNER);
  }

  /** map の大きさから作る。 */
  static forMap(map: MapState): VisionBuffer {
    return new VisionBuffer(map.widthTiles, map.heightTiles);
  }

  /** 今の tick で更新すべきか（5 tick ごと）。 */
  shouldUpdate(tick: number): boolean {
    if (this.lastUpdateTick < 0) return true;
    return tick - this.lastUpdateTick >= VISION_UPDATE_INTERVAL_TICKS;
  }

  /** 最後に更新した tick（テスト用）。 */
  updatedAtTick(): number {
    return this.lastUpdateTick;
  }

  private idx(tx: number, ty: number): number {
    return ty * this.widthTiles + tx;
  }

  private inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.widthTiles && ty < this.heightTiles;
  }

  /** 状態を引く。範囲外は未探索。 */
  stateAt(tx: number, ty: number): number {
    if (this.revealed) return VisionState.Visible;
    if (!this.inBounds(tx, ty)) return VisionState.Unexplored;
    return this.state[this.idx(tx, ty)]!;
  }

  /** 今「可視」か（`spriteLayer.VisibilityQuery` を満たす）。 */
  isVisible(tx: number, ty: number): boolean {
    return this.stateAt(tx, ty) === VisionState.Visible;
  }

  /** 一度でも見たか（既知 or 可視）。 */
  isExplored(tx: number, ty: number): boolean {
    return this.stateAt(tx, ty) !== VisionState.Unexplored;
  }

  /** 既知として覚えている建物の typeId（-1 = なし）。 */
  rememberedBuilding(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return -1;
    const v = this.knownBuilding[this.idx(tx, ty)]!;
    return v === 0 ? -1 : v - 1;
  }

  /** 全マップを可視にする（観戦・リプレイ。`05§14`）。 */
  reveal(on: boolean): void {
    this.revealed = on;
  }

  /** 全開放中か。 */
  isRevealed(): boolean {
    return this.revealed;
  }

  /**
   * 視界を作り直す。**`shouldUpdate` が true のときだけ呼ぶ**（呼び出し側で判定）。
   *
   * 手順:
   *  1. 可視 → 既知に落とす（未探索は据え置き）
   *  2. 自軍・味方のユニット / 建物の視界円を「可視」で塗り、地形を覚え直す
   *  3. 可視マスの建物の記憶を消してから、今見えている建物の形を焼き直す
   *     （壊れた建物が視界内で消えるのはこの手順のおかげ。視界外では古いまま残る）
   */
  update(w: World, viewer: PlayerId): void {
    this.lastUpdateTick = w.tick;
    const map = w.map;
    if (!hasTerrain(map)) return;
    const e = w.entities;

    // 1) 可視 → 既知
    const st = this.state;
    for (let i = 0; i < st.length; i++) {
      if (st[i] === VisionState.Visible) st[i] = VisionState.Known;
    }

    // 2) 視界円
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      const owner = e.owner[i]!;
      if (owner === NEUTRAL_OWNER) continue;
      if (owner !== viewer && !areAllies(w, owner, viewer)) continue;
      const kind = e.kind[i]!;
      let sightFx = 0;
      if (kind === EntityKind.Unit) sightFx = unitDef(e.typeId[i]!).sight;
      else if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
        sightFx = buildingDef(e.typeId[i]!).sight;
      } else continue;
      const r = sightFx / FX_ONE;
      if (r <= 0) continue;
      this.stampCircle(map, Math.floor(e.x[i]! / FX_ONE), Math.floor(e.y[i]! / FX_ONE), r);
    }

    // 3) 可視マスの建物を焼き直す
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      const kind = e.kind[i]!;
      if (kind !== EntityKind.Building && kind !== EntityKind.Attachment) continue;
      const bx = Math.floor(e.x[i]! / FX_ONE);
      const by = Math.floor(e.y[i]! / FX_ONE);
      if (!this.inBounds(bx, by) || this.state[this.idx(bx, by)] !== VisionState.Visible) continue;
      const def = buildingDef(e.typeId[i]!);
      const x0 = bx - ((def.sizeW - 1) >> 1);
      const y0 = by - ((def.sizeH - 1) >> 1);
      for (let ty = y0; ty < y0 + def.sizeH; ty++) {
        for (let tx = x0; tx < x0 + def.sizeW; tx++) {
          if (!this.inBounds(tx, ty)) continue;
          const o = this.idx(tx, ty);
          if (this.state[o] !== VisionState.Visible) continue;
          this.knownBuilding[o] = def.index + 1;
          this.knownOwner[o] = e.owner[i]!;
        }
      }
    }
  }

  /** (cx, cy) から半径 `r`（マス）を可視にし、地形を覚え直す。 */
  private stampCircle(map: MapState, cx: number, cy: number, r: number): void {
    const ri = Math.ceil(r);
    const rr = r * r;
    for (let ty = cy - ri; ty <= cy + ri; ty++) {
      if (ty < 0 || ty >= this.heightTiles) continue;
      for (let tx = cx - ri; tx <= cx + ri; tx++) {
        if (tx < 0 || tx >= this.widthTiles) continue;
        const dx = tx - cx;
        const dy = ty - cy;
        if (dx * dx + dy * dy > rr) continue;
        const o = this.idx(tx, ty);
        // 新しく可視になったマスは建物の記憶をいったん捨てる
        // （壊れた建物を見たときに古い形が残らないようにするため）
        if (this.state[o] !== VisionState.Visible) {
          this.knownBuilding[o] = 0;
          this.knownOwner[o] = NEUTRAL_OWNER;
        }
        this.state[o] = VisionState.Visible;
        this.knownTile[o] = map.tiles[tileIndex(map, tx, ty)]!;
      }
    }
  }
}
