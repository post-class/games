/**
 * ai/view.ts — AI に渡す「そのプレイヤーに見えているものだけ」の視界
 *
 * ■ なぜ World をそのまま渡さないのか
 * `07§11` は「**難易度を上げてもズル（視界の透視・資源の増量）はしません**」と定めている。
 * これをコメントや紳士協定で守るのは無理で、`World` を渡せば必ずどこかで
 * 「敵の資源を見て動く AI」が生まれる。**見えないデータは渡さない**のが唯一の担保。
 *
 * だから AI は `World` ではなく `AiView` を受け取る。ここに無いものは AI から読めない。
 *
 * ■ 決定論について
 * AI の判断は試合結果に影響するので、**全端末で同じ結果にならなければデシンクする**。
 *  - 視界はここで **World の状態から毎回計算する**（キャッシュを持たない）。
 *    整数演算のみ・反復は index 昇順なので、どの端末でも同じ結果になる。
 *  - 乱数が必要なら `world.rngAi` を使う（`AiView` からは触らせない。
 *    `AiPlayer` が World から受け取る）。
 *  - 呼ぶ頻度は判断間隔ごと（1〜8 秒に 1 回）なので、毎 tick の全走査でも負荷は小さい。
 *
 * ■ 何が見えるか（`07§7` の規則そのまま）
 *  - 自軍のすべて（座標・HP・資源・研究・時代・忠誠度）
 *  - **視界内**の敵ユニット・敵建物（位置・種類・HP・`EntityId`）
 *    `EntityId` は「見えているものを名指しで撃つ」ためだけの名前。
 *    視界を通った敵しか入らないので情報量は増えない（`SeenEntity.id` の注記参照）。
 *  - 敵の戦域は **輪の数と位置だけ**（中の兵種・数は見えない ＝ 囮が成立する根拠）
 *  - 市場の相場（全プレイヤー共通なので誰でも見える。`07§8`）
 *  - 地形（探索済みかどうかまでは区別しない。**AI は地形を記憶している扱い**にする。
 *    理由: 地形の記憶を持たせないと経路探索が使えず、AI が動けなくなる。
 *    これは「透視」ではない ―― 人間のプレイヤーも一度見た地形は覚えている）
 *
 * ■ 見えないもの（渡さないので読めない）
 *  - 敵の資源・研究・時代・忠誠度・人口
 *  - 視界外の敵ユニット・建物
 *  - 敵の戦域の中身（所属兵数・令）
 *  - `World` 本体（`stepWorld` を呼ぶ・状態を書き換える、が構造的に不可能）
 */

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { entitySightFx } from '@/sim/core/sight';
import type { Fx } from '@/sim/core/fx';
import { distSq } from '@/sim/core/fx';
import { idOfIndex, isAliveIndex } from '@/sim/core/entity';
import { PROGRESS_DONE } from '@/sim/core/entity';
import { resourceNodeDef } from '@/sim/core/gather';
import type { FrontRing } from '@/sim/core/front';
import { visibleEnemyFronts } from '@/sim/core/front';
import type { MapState, World } from '@/sim/core/world';
import { areAllies } from '@/sim/core/world';

/** 自軍のユニット・建物 1 件（全部見える）。 */
export interface OwnEntity {
  readonly index: number;
  /** `EntityId`（`Command` に載せるのに必要）。 */
  readonly id: EntityId;
  readonly kind: number;
  readonly typeId: number;
  readonly x: Fx;
  readonly y: Fx;
  readonly hp: Fx;
  readonly hpMax: Fx;
  /** 0 = 戦域外、1..6 = 戦域スロット。 */
  readonly frontId: number;
  /** 手動操作中か（AI は自分では立てないが、代行中の切り替えで残ることがある）。 */
  readonly manual: boolean;
  /** 建物なら完成しているか。 */
  readonly complete: boolean;
  /**
   * いま何をしているか（`UnitState`）。**自分のユニットの状態なので透視ではない。**
   *
   * これが無いと AI は「村人が遊んでいる」ことに気付けない。実測で
   * **村人 22 人のうち 14 人が遊休**（採集していたのは 6 人だけ）なのに、
   * 食料ノードは 10,880 も残っていた ―― 食料が足りないのではなく、
   * **働かせられていなかった**。人間はひと目で分かること（`06§5` の
   * 「`.` で遊休村人へジャンプ」も同じ情報を前提にしている）。
   */
  readonly state: number;
}

/** 視界内の敵 1 件（**位置・種類・HP まで**。それ以上は見えない）。 */
export interface SeenEntity {
  /**
   * `EntityId`。**「見えているものを名指しで撃つ」ためだけに持つ。**
   *
   * ■ なぜこれを足してよいのか（`07§11` の「ズルなし」と矛盾しない理由）
   * `07§11` が禁じているのは **視界の透視と資源の増量**であって、
   * 「見えているものをクリックして攻撃する」のは人間が普通に行う操作そのもの
   * （`06§5` の「選択して指示した部隊は令から外れて手動になる」）。
   * ここに入るのは**視界の判定を通った敵だけ**なので、見えていないものの
   * `EntityId` は 1 件も漏れない ―― 情報量は増えず、
   * 「見えているあれ」を `Command` に載せる**名前**が手に入るだけ。
   *
   * ■ 無いと何が起きたか（実測。30 分・AI 段階 4 同士）
   * ```
   *  5分 兵 0/0  建物 8/10  町中心HP 2400/2400 敵拠点まで  -/-  戦域 0
   * 15分 兵 5/7  建物 17/18 町中心HP 2400/2400 敵拠点まで 67/50 戦域 0
   * 25分 兵 20/4 建物 21/17 町中心HP 2400/2400 敵拠点まで 14/137 戦域 1
   * 30分 兵 24/5 建物 19/14 町中心HP 2400/2400 敵拠点まで 18/107 戦域 1
   * ```
   * 兵は敵拠点の 14〜18 マスまで寄るのに、**町の中心の HP が 30 分間 1 も減らない**。
   * `attackTarget` は目標の `EntityId` を要求するのに `SeenEntity` が
   * `id` を持たず、AI が拠点を名指しできなかったのが原因（112 試合すべて時間切れ）。
   * 勝利条件は `03§10`「相手の町の中心をすべて破壊」なので、
   * これが名指しできないと**永久に決着しない**。
   */
  readonly id: EntityId;
  readonly owner: PlayerId;
  readonly kind: number;
  readonly typeId: number;
  readonly x: Fx;
  readonly y: Fx;
  readonly hp: Fx;
  readonly hpMax: Fx;
}

/**
 * 視界内の資源ノード（中立エンティティ）。
 *
 * **これが無いと AI は村人を森に就かせられない**（`gather` の対象を名指しできない）。
 * 資源ノードは中立なので「敵の情報」ではなく、視界内なら人間にも見えている。
 */
export interface SeenResourceNode {
  readonly id: EntityId;
  /** `RESOURCE_NODE_DEFS` の添字（`core/gather.ts`）。 */
  readonly typeId: number;
  /** `RESOURCE_IDS` の添字（0=food, 1=wood, 2=stone, 3=gold）。 */
  readonly resource: number;
  readonly x: Fx;
  readonly y: Fx;
  /** 残り埋蔵量（Fx）。 */
  readonly amount: Fx;
}

/** 自分の戦域（令まで見える）。 */
export interface OwnFront {
  readonly slot: number;
  readonly x: Fx;
  readonly y: Fx;
  readonly radius: Fx;
  readonly order: string | null;
  readonly orderLower: string | null;
  /** 配達中の令があるか（あるなら次の令は出せない）。 */
  readonly pending: boolean;
  readonly advantage: Fx;
  /** 崩れかけ（`07§3` の警告状態）。 */
  readonly warning: boolean;
  readonly memberCount: number;
  /** 忠誠度による離反中（令が効かない）。 */
  readonly defected: boolean;
}

/** 自分の状態（`07§11` の「ズルなし」の範囲）。 */
export interface OwnState {
  readonly playerId: PlayerId;
  readonly civ: string;
  /** 資源 4 種（Fx）。RESOURCE_IDS の順。 */
  readonly resources: readonly number[];
  readonly age: number;
  readonly pop: number;
  readonly popCap: number;
  readonly loyalty: Fx;
  readonly frontSlots: number;
  /** 研究済みフラグ（tech index）。 */
  readonly researched: readonly boolean[];
}

/** AI が読める世界。**ここに無いものは AI から読めない。** */
export interface AiView {
  readonly tick: number;
  readonly own: OwnState;
  readonly ownEntities: readonly OwnEntity[];
  /** 視界内の敵（味方は含まない）。 */
  readonly seenEnemies: readonly SeenEntity[];
  /** 視界内の資源ノード（中立。村人を就かせる対象）。 */
  readonly seenResourceNodes: readonly SeenResourceNode[];
  readonly ownFronts: readonly OwnFront[];
  /** 敵の戦域。**中心と半径と番号だけ**（`07§7`）。 */
  readonly enemyFronts: readonly FrontRing[];
  /** 地形（読み取り専用）。 */
  readonly map: MapState;
  /** 市場の相場（全員共通）。 */
  readonly marketPriceMul: readonly number[];
  /** 味方かどうか（チーム戦の判定）。 */
  isAlly(other: PlayerId): boolean;
}

/**
 * `World` からそのプレイヤーの視界を作る。
 *
 * **`World` への参照を持たせない**（`map` だけは大きいので参照を渡すが、
 * `MapState` は地形しか含まないので敵の情報は漏れない）。
 */
export function createAiView(w: World, p: PlayerId): AiView {
  const e = w.entities;
  const pl = w.players[p];
  if (pl === undefined) throw new Error(`createAiView: 未知の playerId ${p}`);

  const ownEntities: OwnEntity[] = [];
  const seenEnemies: SeenEntity[] = [];
  const seenResourceNodes: SeenResourceNode[] = [];

  // 1) 自軍を集めながら、視界の元（座標と視界半径）も同時に作る。
  //    index 昇順（§0.3）。
  const sightX: number[] = [];
  const sightY: number[] = [];
  const sightR2: number[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i)) continue;
    const owner = e.owner[i]!;
    if (owner !== p) continue;
    const kind = e.kind[i]!;
    const complete = kind !== EntityKind.Building || e.buildProgress[i]! >= PROGRESS_DONE;
    ownEntities.push({
      index: i,
      id: idOfIndex(e, i),
      kind,
      typeId: e.typeId[i]!,
      x: e.x[i]!,
      y: e.y[i]!,
      hp: e.hp[i]!,
      hpMax: e.hpMax[i]!,
      frontId: e.frontId[i]!,
      manual: e.manual[i] === 1,
      complete,
      state: e.state[i]!,
    });
    // 視界を持つのはユニットと完成した建物だけ。
    //
    // **`kind` を明示して分岐する。** 以前は「ユニットでなければ建物」と決めつけていたが、
    // 自軍が所有する `EntityKind.Resource`（**農地が載せる食料ノード**は所有者付き）が
    // 建物として読まれ、資源ノードの typeId を `buildingDef` に渡して
    // 「範囲外の building typeId」で落ちた。
    //
    // 視界の値そのものは `sim/core/sight.ts` の `entitySightFx` で求める
    // （**画面の霧（`render/vision.ts`）と同じ関数**）。以前はここで
    // `buildingDef(...).sight` を直に読んでいたため、研究「測量」（建物の視界 +4）が
    // AI にも画面にも効いていなかった。片方だけ直すと視界がずれ、
    // AI 側が広ければ `07§11` の「ズルなし」を破ることになる。
    //
    // 未完成の建物を視界に数えないのはここだけの判定（画面は建てかけも見せる）。
    const sight =
      kind === EntityKind.Unit || complete ? entitySightFx(w, i) : 0;
    if (sight > 0) {
      sightX.push(e.x[i]!);
      sightY.push(e.y[i]!);
      sightR2.push(sight * sight);
    }
  }

  // 2) 敵で「自軍の視界に入っているもの」だけを集める。
  //    平方距離で比較する（§0.3。平方根を取らない）。
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i)) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue; // 中立（資源ノード）は敵ではない
    if (areAllies(w, p, owner as PlayerId)) continue;
    const ex = e.x[i]!;
    const ey = e.y[i]!;
    let visible = false;
    for (let k = 0; k < sightX.length; k++) {
      if (distSq(ex, ey, sightX[k]!, sightY[k]!) <= sightR2[k]!) {
        visible = true;
        break;
      }
    }
    if (!visible) continue;
    seenEnemies.push({
      id: idOfIndex(e, i),
      owner: owner as PlayerId,
      kind: e.kind[i]!,
      typeId: e.typeId[i]!,
      x: ex,
      y: ey,
      hp: e.hp[i]!,
      hpMax: e.hpMax[i]!,
    });
  }

  // 3) 視界内の資源ノード（中立）。敵の走査は `owner >= playerCount` で中立を弾くので別に集める。
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i)) continue;
    if (e.kind[i] !== EntityKind.Resource) continue;
    if (e.amount[i]! <= 0) continue;
    const nx = e.x[i]!;
    const ny = e.y[i]!;
    let visible = false;
    for (let k = 0; k < sightX.length; k++) {
      if (distSq(nx, ny, sightX[k]!, sightY[k]!) <= sightR2[k]!) {
        visible = true;
        break;
      }
    }
    if (!visible) continue;
    seenResourceNodes.push({
      id: idOfIndex(e, i),
      typeId: e.typeId[i]!,
      resource: resourceNodeDef(e.typeId[i]!).resource,
      x: nx,
      y: ny,
      amount: e.amount[i]!,
    });
  }

  // 4) 自分の戦域（令まで見える）。
  const ownFronts: OwnFront[] = [];
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active || f.owner !== p) continue;
    ownFronts.push({
      slot: f.slot,
      x: f.x,
      y: f.y,
      radius: f.radius,
      order: f.order,
      orderLower: f.orderLower,
      pending: f.pendingOrder !== null,
      advantage: f.advantage,
      warning: f.advantage < 0,
      memberCount: f.memberCount,
      defected: f.defected,
    });
  }

  const researched: boolean[] = [];
  for (let t = 0; t < pl.researched.length; t++) researched.push(pl.researched[t] === 1);

  return {
    tick: w.tick,
    own: {
      playerId: p,
      civ: pl.civ,
      resources: Array.from(pl.resources),
      age: pl.age,
      pop: pl.pop,
      popCap: pl.popCap,
      loyalty: pl.loyalty,
      frontSlots: pl.frontSlots,
      researched,
    },
    ownEntities,
    seenEnemies,
    seenResourceNodes,
    ownFronts,
    enemyFronts: visibleEnemyFronts(w, p),
    map: w.map,
    marketPriceMul: Array.from(w.market.priceMul),
    isAlly: (other: PlayerId) => areAllies(w, p, other),
  };
}
