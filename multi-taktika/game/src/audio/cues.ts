/**
 * audio/cues.ts — 「いま何が起きたか」を World の変化から拾って効果音の名前にする
 *
 * ■ なぜこのファイルが必要になったか
 * `sfx.ts` は 10 枠の名前を用意し、`synth.ts` は 10 枠すべての音を作れる。
 * それでも**鳴っていたのは `warning` の 1 枠だけ**だった ――
 * 残る 9 枠は `sfx.play(...)` を呼ぶ場所が**どこにも無かった**
 * （`grep -rn "sfx.play" src` の結果が 1 件）。
 * 枠と音があっても、鳴らす場所が無ければ無音のままになる。
 *
 * ■ なぜ sim 側に「音を鳴らせ」と書かないのか
 * `sim` は全端末で同じ結果を出す層で、ui/audio を import できない（ESLint が弾く）。
 * 音を sim から鳴らすと、**音の有無が試合結果に混ざる**恐れが出る。
 * だからここは **World を読むだけ**にして、前回の値との差から出来事を割り出す。
 * World への書き込みは一切しない（`readonly` の World しか受け取らない）。
 *
 * ■ 差分で拾うことの限界（承知の上）
 * 1 フレームの間に「兵が 1 体できて 1 体死んだ」場合、人口の差は 0 なので
 * 生産完了の音は鳴らない。**音は数えるためのものではなく気付くためのもの**なので、
 * 取りこぼしよりも「無関係な音が鳴らないこと」を優先している。
 *
 * ■ 誰の耳で聞くか
 * 出来事は**自分（viewer）に関わるものだけ**鳴らす。
 * 相手の建物が完成した音まで鳴ると、視界の外の出来事が耳から漏れる
 * （`07§7`・`07§11` の「見えないものは分からない」を音で破ってしまう）。
 */

import { EntityKind } from '@/shared/types';
import type { PlayerId } from '@/shared/types';
import { PROGRESS_DONE } from '@/sim/core/entity';
import type { World } from '@/sim/core/world';
import type { SfxName } from './sfx';

/** 前フレームの値。**これと比べて出来事を割り出す。** */
interface Snapshot {
  /** 自分の戦域が立っているか（slot ごと）。 */
  readonly frontActive: boolean[];
  /**
   * 戦域に載っている令（`slot` ごと）。**上位と下位を別々に持つ。**
   *
   * 最初は `"上位/下位"` の 1 本の文字列にまとめていたが、
   * それだと**令が外れたときも「変わった」**ことになり（`"push/" → "/"`）、
   * 届いていないのに到着音が鳴った（テストが捕まえた）。
   * 「新しく載ったか」を見るには、枠ごとに独立して比べる必要がある。
   */
  readonly frontOrder: (string | null)[];
  readonly frontOrderLower: (string | null)[];
  age: number;
  pop: number;
  /** 完成した自軍の建物の数。 */
  buildings: number;
  gameOver: boolean;
}

/**
 * World の変化を見て効果音の名前を返す。
 *
 * **戻り値を返すだけで、鳴らさない。** 鳴らすのは呼び出し側（`main.ts`）で、
 * こうしておくと「どの出来事でどの音が鳴るか」をテストで確かめられる
 * （Web Audio が無い環境でも検証できる）。
 */
export class AudioCues {
  private prev: Snapshot | null = null;
  /** 直前に見ていた World（試合が替わったら作り直す）。 */
  private lastWorld: World | null = null;

  /**
   * 1 フレーム分の出来事を拾う。**鳴らす順は返した配列の順**。
   *
   * 最初の呼び出しでは何も返さない（開始時の状態は「変化」ではない ――
   * 試合が始まった瞬間に建物の完成音が 8 個鳴るのを避ける）。
   */
  step(w: World, viewer: PlayerId): SfxName[] {
    const now = snapshot(w, viewer);
    // 試合が替わった（別の World になった）ら比較しない。
    if (this.prev === null || this.lastWorld !== w) {
      this.prev = now;
      this.lastWorld = w;
      return [];
    }
    const prev = this.prev;
    const out: SfxName[] = [];

    // 1) 戦域の開閉（`07§3`）。**見ていない場所で起きるので音がいちばん要る。**
    for (let s = 0; s < now.frontActive.length; s++) {
      const was = prev.frontActive[s] === true;
      const is = now.frontActive[s] === true;
      if (!was && is) out.push('front_open');
      else if (was && !is) out.push('front_close');
    }

    // 2) 令が届いた（`05§14` の「出した瞬間ではなく届いた瞬間」）。
    //    立っている戦域の令が別のものに変わったら、それが到着。
    for (let s = 0; s < now.frontOrder.length; s++) {
      if (now.frontActive[s] !== true || prev.frontActive[s] !== true) continue;
      // **「別の令になった」ではなく「新しい令が載った」で鳴らす。**
      // 令が外れた（null になった）のは到着ではないので鳴らさない。
      const upperArrived =
        (now.frontOrder[s] ?? null) !== null &&
        (prev.frontOrder[s] ?? null) !== (now.frontOrder[s] ?? null);
      const lowerArrived =
        (now.frontOrderLower[s] ?? null) !== null &&
        (prev.frontOrderLower[s] ?? null) !== (now.frontOrderLower[s] ?? null);
      if (upperArrived || lowerArrived) out.push('order_arrive');
    }

    // 3) 時代が進んだ。
    if (now.age > prev.age) out.push('age_up');

    // 4) 生産が完了した（人口が増えた）。
    //    **人口で見る理由**: 生産の完了は sim の内側の出来事で、外から見える印は人口だけ。
    //    人口上限に当たって生産が止まっているときは増えないので、音も鳴らない（正しい）。
    if (now.pop > prev.pop) out.push('unit_ready');

    // 5) 建物が完成した／壊された。
    if (now.buildings > prev.buildings) out.push('build_done');
    else if (now.buildings < prev.buildings) out.push('building_lost');

    // 6) 勝敗が決まった。
    if (now.gameOver && !prev.gameOver) out.push('match_end');

    this.prev = now;
    this.lastWorld = w;
    return out;
  }

  /** 試合を作り直したときに呼ぶ（次のフレームを基準にし直す）。 */
  reset(): void {
    this.prev = null;
    this.lastWorld = null;
  }
}

/** いまの状態を写し取る。**World は読むだけ。** */
function snapshot(w: World, viewer: PlayerId): Snapshot {
  const frontActive: boolean[] = [];
  const frontOrder: (string | null)[] = [];
  const frontOrderLower: (string | null)[] = [];
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    const mine = f.active && f.owner === viewer;
    frontActive.push(mine);
    frontOrder.push(mine ? f.order : null);
    frontOrderLower.push(mine ? f.orderLower : null);
  }

  const e = w.entities;
  let buildings = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.owner[i] !== viewer) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.buildProgress[i]! < PROGRESS_DONE) continue; // 建てかけは数えない
    buildings++;
  }

  const pl = w.players[viewer];
  return {
    frontActive,
    frontOrder,
    frontOrderLower,
    age: pl === undefined ? 0 : pl.age,
    pop: pl === undefined ? 0 : pl.pop,
    buildings,
    gameOver: w.gameOver,
  };
}
