/**
 * sim/hash.ts — 状態ハッシュ FNV-1a 32bit（実装手順書 §4.5）
 *
 * 用途: ロックステップ対戦のデシンク検出（毎 250 tick = 10 秒ごとに突き合わせ。T-M14-06）と
 * リプレイ回帰テスト（tests/golden）。
 *
 * ハッシュ対象（順序も固定。**入れる順序を変えると過去の期待値が全部無効になる**）:
 *   1. tick
 *   2. 各プレイヤー（id 昇順）: 資源 4 種・忠誠度・時代・人口・人口上限・研究済み・
 *      戦域スロット数・投了/敗北フラグ
 *   3. 全エンティティ（index 昇順）: alive、生存なら generation, kind, owner, typeId,
 *      x, y, hp, morale, frontId, manual、行動状態一式、
 *      **lastDamagedBy / lastDamagedTick**（掟の犯人特定に使う実状態。統合で追加）
 *   4. 戦域（owner 昇順 → slot 昇順）: active, x, y, radius, advantage, defected。
 *      未使用スロットは**発生候補（孵化中）の状態**を混ぜる（交戦継続 tick 数・実ダメージ観測・
 *      前 tick の HP 合計・候補重心）。ここを飛ばすと「戦域が立つ前の食い違い」を検出できない。
 *   5. 市場の相場（資源 index 昇順）と最終戻し tick
 *   6. 破壊跡地（`World.destroyedSites` の並び順のまま = tick 昇順 → (y, x) 昇順）
 *   7. 地形の通行可否（壁の穴・跡地で変わる）
 *   8. 各 rng の状態（combat → ai → map）
 *   9. gameOver / winner
 *
 * 5〜7 は「マップ上の共有状態」なので、エンティティと戦域の後・rng の前にまとめて置く。
 * **6 を後から足したので、これ以前に取った golden ハッシュは無効。**
 *
 * `World.scratch` とグリッド（`builtTick` など索引の派生物）は対象外。
 * 派生物を入れると「再構築のタイミング違い」で偽のデシンクが出るため。
 *
 * 32bit なので誤検出（衝突）の確率は 2^-32 程度。1 ビットの状態差は必ず変化する
 * （FNV-1a はバイト単位で乗算 + XOR を繰り返すため。T-M2-07）。
 */

import { MAX_PRODUCTION_QUEUE } from './core/entity';
import type { World } from './core/world';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 1 バイトを混ぜる。 */
function mixByte(h: number, b: number): number {
  return Math.imul(h ^ (b & 0xff), FNV_PRIME) >>> 0;
}

/** 32bit 値をリトルエンディアン 4 バイトとして混ぜる。 */
function mixU32(h: number, v: number): number {
  const u = v >>> 0;
  let r = mixByte(h, u);
  r = mixByte(r, u >>> 8);
  r = mixByte(r, u >>> 16);
  r = mixByte(r, u >>> 24);
  return r;
}

/** 真偽値を混ぜる。 */
function mixBool(h: number, b: boolean): number {
  return mixByte(h, b ? 1 : 0);
}

/** 整数配列（TypedArray）を index 昇順で混ぜる。 */
function mixArray(h: number, a: Int32Array | Uint32Array | Uint8Array | Uint16Array): number {
  let r = h;
  for (let i = 0; i < a.length; i++) r = mixU32(r, a[i]!);
  return r;
}

/**
 * World の状態ハッシュ。
 * 同一状態 → 同一値、1 ビットでも違えば別値（実質的に）。
 */
export function hashWorld(w: World): number {
  let h = FNV_OFFSET_BASIS;

  h = mixU32(h, w.tick);

  // ---- プレイヤー（id 昇順）----
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    h = mixU32(h, pl.id);
    h = mixArray(h, pl.resources);
    h = mixU32(h, pl.loyalty);
    h = mixU32(h, pl.age);
    h = mixU32(h, pl.pop);
    h = mixU32(h, pl.popCap);
    h = mixArray(h, pl.researched);
    h = mixU32(h, pl.frontSlots);
    h = mixBool(h, pl.resigned);
    h = mixBool(h, pl.defeated);
  }

  // ---- エンティティ（index 昇順）----
  const e = w.entities;
  h = mixU32(h, e.highWater);
  h = mixU32(h, e.count);
  for (let i = 0; i < e.highWater; i++) {
    const alive = e.alive[i]!;
    h = mixByte(h, alive);
    if (alive !== 1) continue;
    h = mixU32(h, e.generation[i]!);
    h = mixByte(h, e.kind[i]!);
    h = mixByte(h, e.owner[i]!);
    h = mixU32(h, e.typeId[i]!);
    h = mixU32(h, e.x[i]!);
    h = mixU32(h, e.y[i]!);
    h = mixU32(h, e.hp[i]!);
    h = mixU32(h, e.morale[i]!);
    h = mixByte(h, e.frontId[i]!);
    h = mixByte(h, e.manual[i]!);
    // 行動状態（採集・生産・研究・建設）。これを入れないと
    // 「見た目は同じだが中身が違う」デシンクを取り逃がす。
    h = mixByte(h, e.state[i]!);
    h = mixU32(h, e.target[i]!);
    h = mixByte(h, e.carryKind[i]!);
    h = mixU32(h, e.carryAmount[i]!);
    h = mixU32(h, e.amount[i]!);
    h = mixU32(h, e.buildProgress[i]!);
    h = mixU32(h, e.homeId[i]!);
    h = mixByte(h, e.queueCount[i]!);
    if (e.queueCount[i]! > 0) {
      const q = i * MAX_PRODUCTION_QUEUE;
      for (let k = 0; k < e.queueCount[i]!; k++) h = mixU32(h, e.queueUnit[q + k]!);
      h = mixU32(h, e.prodProgress[i]!);
    }
    h = mixU32(h, e.researchTech[i]!);
    if (e.researchTech[i]! !== 0) h = mixU32(h, e.researchProgress[i]!);
    h = mixByte(h, e.garrisonCount[i]!);
    // 「誰が最後に殴ったか」。掟二・三・五の犯人はこれで決まるので、
    // 食い違うと忠誠度がずれる = 実状態。必ずハッシュに入れる。
    h = mixU32(h, e.lastDamagedBy[i]!);
    h = mixU32(h, e.lastDamagedTick[i]!);
  }

  // ---- 戦域（slot 昇順）----
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    h = mixBool(h, f.active);
    if (!f.active) {
      // **発生候補（孵化中）の状態も混ぜる。**
      // `active === false` を丸ごと飛ばしていた頃は、
      // 「交戦が 2 秒続いたか」の途中状態が食い違っても
      // 実際に戦域が立つまでデシンクを検出できなかった。
      h = mixU32(h, f.candidateTicks);
      if (f.candidateTicks !== 0) {
        h = mixBool(h, f.candidateDamageSeen);
        h = mixU32(h, f.candidateHpOwn);
        h = mixU32(h, f.candidateHpEnemy);
        h = mixU32(h, f.x);
        h = mixU32(h, f.y);
      }
      continue;
    }
    h = mixByte(h, f.owner);
    h = mixU32(h, f.x);
    h = mixU32(h, f.y);
    h = mixU32(h, f.radius);
    h = mixU32(h, f.advantage);
    h = mixBool(h, f.defected);
  }

  // ---- 市場の相場（全プレイヤー共通）----
  h = mixArray(h, w.market.priceMul);
  h = mixU32(h, w.market.lastDecayTick);

  // ---- 破壊跡地（跡地タイマー。配列の並び順そのものが状態なので順序込みで混ぜる）----
  h = mixU32(h, w.destroyedSites.length);
  for (let i = 0; i < w.destroyedSites.length; i++) {
    const s = w.destroyedSites[i]!;
    h = mixU32(h, s.typeId);
    h = mixU32(h, s.tileX);
    h = mixU32(h, s.tileY);
    h = mixU32(h, s.tick);
    h = mixBool(h, s.wasWall);
    h = mixByte(h, s.owner);
  }

  // ---- 地形（壁の穴・跡地で変わるので対象に入れる）----
  // 長さも混ぜる: M3 で確保する前（長さ 0）と後を区別するため。
  h = mixU32(h, w.map.passable.length);
  h = mixArray(h, w.map.passable);

  // ---- 乱数ストリーム（用途順を固定）----
  h = mixArray(h, w.rngCombat.state);
  h = mixArray(h, w.rngAi.state);
  h = mixArray(h, w.rngMap.state);

  // ---- 決着 ----
  h = mixBool(h, w.gameOver);
  h = mixU32(h, w.winner);

  return h >>> 0;
}

/** ハッシュを 8 桁の 16 進文字列にする（ログ・UI 表示用）。 */
export function formatHash(h: number): string {
  return (h >>> 0).toString(16).padStart(8, '0');
}
