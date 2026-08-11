/**
 * ai/econGoals.ts — 内政の AI（T-M13-02。実装手順書 §10）
 *
 * 担当:
 *  1. 村人を出し続ける（人口枠がある限り）
 *  2. 家を建て増す（**人口上限に当たる前に**）
 *  3. 資源の偏りを見て手を打つ（伐採所・採掘場・農地・市場での交換）
 *  4. 研究と時代進化（`allowAdvanceAge`）
 *
 * ズルをしない前提（`07§11`）: 読めるのは `AiView` だけ。
 * 自分の資源・人口・時代は見えるが、**敵の資源・時代は渡ってこない**。
 *
 * 数値は `config.json` からのみ引く（§0.5）。このファイルに balance 数値は書かない。
 *
 * **申し送り（`AiView` の穴）**:
 *  - `AiView` に**資源ノード（中立エンティティ）が入っていない**ため、
 *    AI は `gather` コマンドの対象を名指しできない。したがって
 *    「新しい村人を最寄りの森に就かせる」ができず、生産された村人は
 *    **建設係**として使っている（家・伐採所・農地を建てる → 建物経由で内政を伸ばす）。
 *    恒久対策は `AiView` に `seenResourceNodes`（視界内の中立資源ノード）を足すこと。
 *  - 同じ理由で「村人配分の組み替え」も直接はできないので、
 *    偏りへの対処は **建物（伐採所・採掘場・農地）と市場の交換**で表している。
 *    （その後 `AiView` に `seenResourceNodes` が入ったので、いまは
 *     `gather` で直接組み替えている。下の「需要にもとづく割り当て」を参照。）
 *
 * ■ 「需要にもとづく割り当て」に変えた理由（実測。段階 4・ローマ 対 ヤマト・席 0・30 分）
 * ```
 *  5分 時代0 兵0  村14 人口14/20 家2 生産元0 food10   wood38 stone100 gold50  運搬中:食6木5金0  手ぶら3
 * 15分 時代1 兵9  村26 人口35/40 家6 生産元0 food406  wood10 stone100 gold180 運搬中:食13木6金4 手ぶら3
 * 25分 時代1 兵13 村26 人口39/40 家6 生産元0 food1291 wood11 stone100 gold847 運搬中:食12木4金1 手ぶら9
 * 30分 時代1 兵12 村26 人口38/40 家6 生産元0 food1838 wood11 stone100 gold907 運搬中:食6木4金6  手ぶら10
 * ```
 * 30 分の試合が**一度も決着しない**原因はこの 1 本の連鎖だった:
 *  1. **木材が 11 で枯れている**のに、食料 1,838・金 907 が使われずに余っている。
 *     村人の配分が「食料 12〜13 / 木材 3〜4 / 金 1〜6」で固定され、
 *     **余っている資源を採り続け、詰まっている資源を採らない**。
 *  2. 木材が無いので**家が 6 棟で止まり**、人口上限 40 に張り付く（人口 38/40）。
 *     人口が増えないので兵も村人も増えない。
 *  3. 木材が無いので**兵舎・射場・厩が 1 棟も建たない**（生産元 0）。
 *     青銅の世なのに `producedAt: town_center` の黎明の兵しか作れない。
 * 木材 → 家 → 人口上限 → 生産元 → 兵の質と数、が全部同じ 1 つの詰まりから来ている。
 *
 * だから割り当てを「**何人目かで決める数の割り当て**」から
 * 「**不足額に比例した需要の割り当て**」に変えた（`villagerDemandPlan`）。
 * あわせて、木材が枯れた本当の内訳も実測で分かった:
 *  - 農地を 14 面（木材 840）建てていた（`assignedByResource` が減らない数字だったため
 *    上限が効かず、食料が 1,838 余っているのに建て続けていた）。
 *  - 進化条件の建物（`pickAgeGateBuilding`）が払えないと `pickEconBuilding` が
 *    そこで打ち切っていたので、**30 木材の家すら建たなかった**（下の `planEconBuilding`）。
 *  - 記憶した資源ノードは**伐り尽くして消えたあとも残り続けていた**ので、
 *    村人は「もう無い森」へ送られ、搬入点も「近くにある」と誤判定されていた
 *    （`forgetVanishedNodes`）。
 *
 * ■ 直したあとの実測（同じ種・同じ組み合わせ。席 0 / 席 1 の 2 行ずつ）
 * ```
 *  5分 時代0 兵0  村15 人口15/30 家4  農地1 生産元0 food41  wood207 gold50
 *  5分 時代0 兵0  村16 人口16/30 家4  農地1 生産元0 food21  wood137 gold50
 * 10分 時代0 兵3  村24 人口27/40 家6  農地2 生産元0 food347 wood508 gold50
 * 10分 時代0 兵3  村23 人口26/40 家6  農地2 生産元0 food310 wood409 gold50
 * 15分 時代1 兵8  村24 人口32/50 家8  農地7 生産元2 food444 wood50  gold70
 * 15分 時代1 兵11 村23 人口34/50 家8  農地4 生産元1 food436 wood105 gold70
 * 20分 時代1 兵16 村23 人口39/50 家8  農地5 生産元2 food414 wood23  gold79
 * 25分 時代1 兵11 村26 人口37/50 家8  農地5 生産元2 food407 wood3   gold79
 * 30分 時代1 兵21 村24 人口45/55 家9  農地2 生産元2 food417 wood13  gold89
 * 30分 時代1 兵3  村17 人口20/60 家10 農地0 生産元2 food363 wood11  gold90
 * ```
 * 変わったところ（席 0・30 分時点）:
 *  - 生産元 **0 → 2 棟**。青銅の兵が出るようになった
 *    （兵の内訳が `sword10,ranged2` → `spear6,ranged10,sword5` の 3 系統に）
 *  - 家 **6 → 9 棟**、人口 **38/40 で張り付き → 45/55（余裕あり）**
 *  - 兵 **12 → 21 体**、青銅の世の到達が **15 分 → 13 分**
 *  - 食料の余り **1,838 → 417**（余らせずに使えている）
 *
 * **木材は 30 分時点でも 13 しか残らない**（「100 以上」には届いていない）。
 * ただし意味は変わっている: 元は「採れないから枯れていた」（木材の累計収入が
 * 15 分以降 1,793 → 1,903 で完全に止まっていた）。いまは**入った木材を
 * 家・生産元・遠隔兵に使い切っている**（累計収入は 30 分で 2,243 まで伸び続ける）。
 * ■ 続き: **鉄器の世に届かない**という後退を直したときの実測（段階 4・3 組・30 分）
 *
 * 上の直しで兵は増えたが、金が 50 → 89 で頭打ちになり、
 * **鉄器の世（食料 800 + 金 200）に 3 組 6 席すべてが 30 分間一度も届かなかった**
 * （変更前は 25 分前後で届いていた）。原因は 5 つあり、全部別物だった:
 *  1. 採る目標に**取り置きの割合**（0.5）を使っていたので、目標が食料 400・金 100 に
 *     なって「足りている」と判断していた（`resourceDeficits`）。
 *  2. 不足額に比例配分するだけでは、木材（生産元 2 棟 + 搬入点 = 610 前後）が常に勝ち、
 *     金に人が回らない（`ageWorkerMinPercent` を追加）。
 *  3. 取り置きが 0.5 固定なので、兵が「取り置きを超えたぶん」を毎回食べて
 *     手持ちが 400 に張り付いた（`ageFinishFromPercent`＝上がる直前は貯め切る）。
 *  4. 進化条件の建物（いまの世の建物 2 種）を**安い順**に選んでいたため、
 *     手持ちでは永久に払えない鍛冶場（木材 150）を待ち続けた
 *     （`pickAgeGateBuilding` を「不足額の合計がいちばん小さいもの」に変更）。
 *  5. 家を無条件に最優先にしていたため、**入った木材が全部先読みの家に消え**、
 *     進化条件の建物が候補にすら上がらなかった（30 分の着工試行に鍛冶場も櫓も無い）。
 *     いまは「人口が詰まる寸前の家」だけを進化条件より先にする。
 * ```
 * 直す前（時代/兵、5 分ごと。P0/P1）      直したあと
 * viking 対 yamato                       viking 対 yamato
 *  20分 時代1/1 兵16/5   金 90/110        20分 時代1/1 兵7/13  金 78/189
 *  30分 時代1/1 兵16/1   金123/170        25分 時代2/2 兵7/4   金 88/14
 *                                        30分 時代2/2 兵8/6   金 45/84
 * roma 対 yamato                         roma 対 yamato
 *  20分 時代1/1 兵16/15  金 79/90         20分 時代1/1 兵8/9   金150/228
 *  30分 時代1/1 兵21/3   金 89/90         30分 時代2/2 兵7/4   金 65/317
 * mongol 対 azteca                       mongol 対 azteca
 *  20分 時代1/1 兵13/5   金133/95         20分 時代1/1 兵11/12 金 19/157
 *  30分 時代1/1 兵22/4   金133/106        30分 時代2/2 兵15/7  金 79/212
 * ```
 * **6 席すべてが 25〜30 分で鉄器の世に到達する**（直す前は 0 席）。
 * 代わりに 30 分時点の兵は 16〜22 → 4〜15 に減る。これは取引で、
 * 鉄器 1 回ぶんの費用（食料 800 + 金 200）がおよそ兵 20 体ぶんに当たるため
 * ―― 時代は兵の質・戦域スロット・研究・攻城兵器のすべての上限なので、
 * ここでは時代を採った（`armyFloorSquads` を 3〜5 に上げて兵を取り戻す形も試したが、
 * 序盤に兵を抱えて内政が細り、**青銅の世が 15 分 → 20〜30 分に遅れて**逆に悪化した）。
 *
 * 残る壁は**遠い森の採集効率**で、これは AI の外側にある:
 * 拠点のそばの森が尽きたあと、40 マス以上先の森に伐採所を 3 棟建てても
 * 木材の収入は 10 分で +10 しか増えなかった（`ai.economy.test.ts` の冒頭が書いている
 * 「開始村人が動けなくなる」`movement` 側の申し送りと同じ場所の可能性が高い）。
 */

import type { CivId, EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE, cfgAges, cfgInt, cfgNum } from '@/sim/core/config';
import {
  BUILDING_DEFS,
  UNIT_DEFS,
  buildingDef,
  buildingDefById,
  canCivBuild,
  canCivResearch,
  civUnitsAtAge,
  resolveBuildingForCiv,
  techDefById,
  unitDef,
  unitDefById,
} from '@/sim/core/defs';
import type { Fx } from '@/sim/core/fx';
import { FX_HALF, FX_ONE, fx, fxMul, fxToInt, idiv } from '@/sim/core/fx';
import { Move, hasTerrain, isPassableFor } from '@/sim/core/terrain';
import { AGE_IDS } from '@/shared/types';

import type { AiContext } from './AiPlayer';
import { VILLAGER_BUILDER, VILLAGER_GATHERER, memGet, memSet } from './AiPlayer';
import { UnitState } from '@/sim/core/entity';
import type { OwnEntity } from './view';

// ---------------------------------------------------------------- データ由来の定数

/** 家 1 棟が増やす人口（`population.housePop`）。この余裕を切ったら建て増す。 */
const HOUSE_POP = cfgInt('population.housePop');

/** 人口上限の上限値（`population.defaultCap`）。ここまで来たら家は要らない。 */
const POP_CAP_MAX = cfgInt('population.defaultCap');

/** 「自軍の建物の内側」と見なす距離（`morale.insideOwnWallsRadiusTiles`）。町を広げる範囲に使う。 */
const TOWN_RADIUS_TILES = cfgInt('morale.insideOwnWallsRadiusTiles');

/** 市場での交換の刻み（`economy.carryCapacity` = 村人 1 往復ぶん）。 */
const TRADE_UNIT = cfgInt('economy.carryCapacity');

/**
 * 資源のそばに搬入点を建てるときに探す半径（マス）。
 *
 * **運搬損失が上限に達する距離**から逆算する（`economy` の式:
 * `min(haulLossMax, floor(片道距離 / haulLossTilesPerStep) * haulLossPer4Tiles)`）。
 * その距離より遠くに搬入点を建てても村人は損失上限で運ぶので、
 * 「そばに建てた」意味が無い。いまの値では 4 × (0.5 / 0.05) = 40 マス。
 */
const NEAR_SITE_MAX_TILES = Math.round(
  cfgInt('economy.haulLossTilesPerStep') *
    (cfgNum('economy.haulLossMax') / cfgNum('economy.haulLossPer4Tiles')),
);

/**
 * 「搬入点がそばにある」と見なしたい距離（マス）。
 *
 * `economy` の運搬損失は `haulLossTilesPerStep`（4 マス）ごとに `haulLossPer4Tiles`（5%）
 * ずつ増える。**2 段（10%）以内**に収めたいので 2 倍を取る。
 * `NEAR_SITE_MAX_TILES`（40 マス = 損失が上限に達する距離）は
 * 「そこに建てても意味が無くなる距離」なので、
 * 「建てたい距離」の判定にそれを使うと**損失 50% でも「そばにある」と見なしてしまう**。
 * 実測（下の `planDropOffForDemand` の注記）で、これが木材が止まる原因だった。
 */
const DROP_OFF_WANT_TILES = cfgInt('economy.haulLossTilesPerStep') * 2;

/** 町の中心の建物 ID（文明置換は `resolveBuildingForCiv` が解く）。 */
const TOWN_CENTER_ID = 'town_center';

/** 村人のユニット ID。 */
const VILLAGER_ID = 'villager';

/** 家の建物 ID。 */
const HOUSE_ID = 'house';

/** 市場の建物 ID（余った資源を詰まっている資源に変える唯一の手段）。 */
const MARKET_ID = 'market';

/** コストに「家 1 棟ぶん」を足した必要額（Fx）。使い切り防止の予備。 */
function withHouseReserve(cost: Int32Array): Int32Array {
  const h = buildingDefById(HOUSE_ID).cost;
  const out = new Int32Array(cost.length);
  for (let r = 0; r < out.length; r++) out[r] = cost[r]! + h[r]!;
  return out;
}

/**
 * 内政の建物を建てる優先順（**ID の並びであって数値ではない**）。
 * 家が最優先なのは「人口で詰まると何も出せなくなる」ため。
 * 伐採所・採掘場・農地・市場は時代進化の条件（前の世の建物 2 種）も兼ねる。
 */
const ECON_BUILD_ORDER: readonly string[] = [
  'house',
  'lumber_camp',
  'mining_camp',
  // **市場は農地より先。**
  // 農地（木材 60）は掘り切ると消えるので建て直し続ける支出だが、
  // 市場（木材 175）は 1 棟で残り、**余った資源を詰まっている資源に変え続ける**。
  // 実測（段階 5・30 分）で食料 1,730 が余る一方で木材が 12 になり、
  // 攻城工房（木材 200）が建てられなかった ―― その局面を解けるのは市場だけだった。
  'market',
  'farm',
];

/**
 * 資源 → その資源を運び込む小屋（`RESOURCE_IDS` の添字順）。
 * 食料は農地が拠点のそばに建つので専用の小屋は使わない（`null` 相当で載せない）。
 */
const DROP_OFF_BY_RESOURCE: Readonly<Record<number, string>> = {
  [RESOURCE_IDS.indexOf('wood')]: 'lumber_camp',
  [RESOURCE_IDS.indexOf('stone')]: 'mining_camp',
  [RESOURCE_IDS.indexOf('gold')]: 'mining_camp',
};

/**
 * 1 判断で採集に戻す遊休村人の数の上限。
 * 全員に一度に命令を出すと同じノードへ殺到して往復が詰まるので、少しずつ戻す。
 * 判断は 2〜8 秒ごとなので、この数でも数十秒で全員が戻る。
 */
const IDLE_REASSIGN_PER_DECISION = 4;

const FOOD = RESOURCE_IDS.indexOf('food');
const WOOD = RESOURCE_IDS.indexOf('wood');
const GOLD = RESOURCE_IDS.indexOf('gold');

// ---------------------------------------------------------------- 公開: 内政の判断

/**
 * 見えている資源ノードを記憶に足す（`AiMemory.nodeIds` ほか）。
 *
 * `AiView.seenResourceNodes` は**その瞬間に視界に入っているものだけ**なので、
 * 覚えないと「斥候が通り過ぎた金鉱」を二度と使えない。
 * 記憶は**発見順に足すだけ**（並べ替えない）ので、どの端末でも同じ順になる。
 *
 * 枯れたノードは、見えている状態で埋蔵量 0 になったときに落とす
 * （見えていないものは判断できないので残す。使おうとして失敗しても
 * `sim` 側が次のノードへ移してくれる ―― `economy.ts` の `seekSameResource`）。
 */
export function rememberNodes(ctx: AiContext): void {
  const m = ctx.memory;
  const seen = ctx.view.seenResourceNodes;
  for (let k = 0; k < seen.length; k++) {
    const n = seen[k]!;
    let at = -1;
    for (let i = 0; i < m.nodeIds.length; i++) {
      if (m.nodeIds[i] === n.id) {
        at = i;
        break;
      }
    }
    if (n.amount <= 0) {
      // 枯れた。記憶から抜く（末尾を詰めると発見順が壊れるので splice する）
      if (at >= 0) {
        m.nodeIds.splice(at, 1);
        m.nodeResource.splice(at, 1);
        m.nodeX.splice(at, 1);
        m.nodeY.splice(at, 1);
      }
      continue;
    }
    if (at >= 0) continue; // 既に覚えている
    m.nodeIds.push(n.id);
    m.nodeResource.push(n.resource);
    m.nodeX.push(n.x);
    m.nodeY.push(n.y);
  }
  forgetVanishedNodes(ctx);
}

/**
 * **無くなったノードを記憶から落とす。**
 *
 * ■ なぜ必要か（実測。木材が枯れた本当の理由の 1 つ）
 * `rememberNodes` が記憶から落とすのは「見えている状態で埋蔵量 0 になったとき」だけ。
 * ところが伐り尽くした森は**エンティティごと消える**ので、二度と
 * `seenResourceNodes` に現れない ―― つまり**永久に記憶に残る**。
 * 実測（段階 4・30 分）:
 * ```
 * 20分 記憶ノード 木24  木ノード（拠点30マス内の実在）0 / 全 7,634  wood20
 * 30分 記憶ノード 木35  木ノード（拠点30マス内の実在）0 / 全 7,034  wood20
 * ```
 * 記憶の中の「拠点のすぐ隣の森」はもう存在しない。それでも
 *  - `nearestNodeOf` はその幽霊を返すので、村人は**無い森へ送られる**
 *  - `planDropOffForDemand` は「いちばん近い森のそばには搬入点がある」と判断して
 *    **遠い森のそばに伐採所を建てない**
 * この 2 つで木材の収入が止まっていた（森はマップに 7,000 残っている）。
 *
 * ■ どう判定するか（透視にならない形で）
 * **自軍の誰かの視界の内側にあるはずなのに、視界に入って来ない**なら、そこには無い。
 * 視界の広さは `units.json` / `buildings.json` の `sight`（自分の駒の性能なので
 * AI が知っていて当然のこと。研究による加算は見ないので、判定はいつも控えめになる）。
 *
 * ■ 「隣に立ったら分かる」では直らなかった（実測。順序が大事なので残す）
 * 最初は「自軍ユニットが 1 マス以内にいるのに見えないなら無い」で書いた。
 * ところが**幽霊ノードを `gather` の対象にした村人はそこへ歩かない**
 * （`sim` は死んだ対象の命令を捨てる）。だから隣に立つ機会が永久に来ず、
 * 木材の累計収入が 15 分以降 **1,793 → 1,903 で完全に止まった**まま
 * 「幽霊に割り当てる → 動かない → 手空き → また幽霊」を繰り返していた。
 * 拠点のそばの森はいつでも視界の内側なので、視界で判定すれば即座に落ちる。
 */
function forgetVanishedNodes(ctx: AiContext): void {
  const m = ctx.memory;
  const seen = ctx.view.seenResourceNodes;
  for (let k = m.nodeIds.length - 1; k >= 0; k--) {
    // 見えているなら残す（`rememberNodes` が枯れ具合を見ている）。
    let visible = false;
    for (let i = 0; i < seen.length; i++) {
      if (seen[i]!.id === m.nodeIds[k]) {
        visible = true;
        break;
      }
    }
    if (visible) continue;
    // 自軍の誰かの視界の内側にあるか（無ければ「まだ分からない」ので残す）。
    let inSight = false;
    const list = ctx.view.ownEntities;
    for (let i = 0; i < list.length; i++) {
      const oe = list[i]!;
      // **`kind` で必ず場合分けする。** `ownEntities` には建物でも兵でもないもの
      // （`EntityKind.Attachment` の井戸・種倉）が入る。`typeId` の引き先は
      // 種類ごとに別の表なので、建物として引くと範囲外で落ちる
      // （実測でヴァイキング戦が `defs: 範囲外の building typeId 39` で停止した）。
      const sight =
        oe.kind === EntityKind.Unit
          ? unitDef(oe.typeId).sight
          : oe.kind === EntityKind.Building && oe.complete
            ? buildingDef(oe.typeId).sight
            : 0;
      if (sight <= 0) continue;
      const dx = oe.x - m.nodeX[k]!;
      const dy = oe.y - m.nodeY[k]!;
      if (dx * dx + dy * dy <= sight * sight) {
        inSight = true;
        break;
      }
    }
    if (!inSight) continue;
    // 隣にいるのに見えない → 無くなっている。発見順を壊さないよう `splice` で抜く。
    m.nodeIds.splice(k, 1);
    m.nodeResource.splice(k, 1);
    m.nodeX.splice(k, 1);
    m.nodeY.splice(k, 1);
  }
}

/** この判断 tick に出す内政の `Command`。 */
export function planEconomy(ctx: AiContext): Command[] {
  const cmds: Command[] = [];
  // 見えている資源ノードを覚える（**判断より先に**。今回の割り当てに使う）。
  rememberNodes(ctx);
  const fresh = classifyVillagers(ctx);

  // 1) 新しくできた村人を採集に就ける（**建てる前に採らせる**。
  //    資源が入らないと家も資源施設も建たないので、順序はこちらが先）。
  for (const c of gatherCommandsFor(ctx, fresh)) cmds.push(c);

  // 1a) **遊んでいる村人を採集に戻す。**
  //     採集していた資源が枯れると `sim` 側が次のノードを探すが、
  //     見つからなければ手空きのまま止まる。実測では**村人 22 人のうち 14 人が遊休**で、
  //     食料ノードは 10,880 も残っていた ―― 足りないのではなく働かせていなかった。
  for (const c of planIdleVillagers(ctx)) cmds.push(c);

  // 1b) 世が変わって必要な資源が変わったら、**既にいる村人を移す**。
  //     移せないと「村人を出し切ったあとに世が上がる」→ 新しく必要になった資源に
  //     誰も就かない、が起きる（実測: 青銅に上がっても金が 50 のまま動かず、
  //     鉄器の要求 200 に永久に届かなかった）。
  for (const c of reassignForNextAge(ctx)) cmds.push(c);

  // 1c) **すでに働いている村人の配置換え**（需要にもとづく割り当て）。
  //     ここが無いと、一度食料に就いた村人は食料が 1,838 余っても食料を採り続け、
  //     木材が 11 で枯れて家も生産元も建たない（ファイル冒頭の実測表）。
  for (const c of planReassignVillagers(ctx)) cmds.push(c);

  // 2) 時代進化（段階 3 以上。`ai.json` の allowAdvanceAge）。
  //
  // **この判断のいちばん最初に出す。** 理由は 2 つあり、どちらも実測で踏んだ:
  //  - `Command` は並んだ順に同じ tick で実行される。村人の生産や着工を先に出すと
  //    そこで食料を使ってしまい、進化の費用が 1 体ぶん足りなくなって弾かれる
  //    （費用は貯まるのに age が 0 のままだった原因）。
  //  - 町の中心は「研究中は進化できない」（`canAdvanceAge` が `researchTech !== 0`
  //    を弾く）ので、研究より先に出さないと研究が居座る。
  //
  // 進化を出したこの判断では**他に資源を使わない**（次の判断から再開する）。
  const advance = planAgeAdvance(ctx);
  if (advance !== null) {
    cmds.push(advance);
    return cmds;
  }

  // 3) 村人を出し続ける（人口枠と目標数の範囲で。`07§2`「0〜5 分は村人だけを増やす時間」）。
  pushVillagerProduction(ctx, cmds);

  // 4) 建物（家 → 資源施設 → 市場）。1 回の判断で 1 棟だけ着工する
  //    （同じ tick に何棟も着工すると資源を使い切って村人が止まる）。
  // **搬入点が先。** 拠点のそばの森を伐り尽くしたあと、遠い森のそばに伐採所が無いと
  // 木材の収入が実質 0 になる（`planDropOffForDemand` の実測表）。
  // 収入が止まっているときは、次の 1 棟より先に収入を直すほうが常に得。
  const drop = planDropOff(ctx);
  const build = drop.cmd !== null ? drop.cmd : planEconBuilding(ctx, drop.saving);
  if (build !== null) cmds.push(build);

  // 4) 研究（自軍の建物が持つ研究のうち、まだ取っていない最初のもの）。
  //    **進化の費用が貯まっているときは研究しない**（町の中心を空けておく）。
  const research = canAffordNextAge(ctx) ? null : planResearch(ctx);
  if (research !== null) cmds.push(research);

  // 5) 資源の偏り: 金が余っていて足りない資源があるなら市場で交換する（`07§8`）。
  const trade = planMarketTrade(ctx);
  if (trade !== null) cmds.push(trade);

  return cmds;
}

// ---------------------------------------------------------------- 村人

/**
 * 村人を「採集係」「建設係」に分類する。
 *
 * `AiView` には「手空きか」が入っていないので、**初めて見た tick** で決める:
 *  - 最初の判断（tick 0 近く）で既に居る村人 → `setup` が資源に就かせている = 採集係
 *  - 後から現れた村人 → 生産されたばかりで手空き = 建設係
 * index が再利用されて別人になったら `EntityId` が変わるので再分類する。
 */
function classifyVillagers(ctx: AiContext): OwnEntity[] {
  const m = ctx.memory;
  const villagerType = unitDefById(VILLAGER_ID).index;
  const firstLook = m.villagerKnownId.length === 0;
  const list = ctx.view.ownEntities;

  // 今いる建設係の数。**枠が空いているぶんだけ**新しい村人を建設係にする。
  let builders = 0;
  if (!firstLook) {
    for (let k = 0; k < list.length; k++) {
      const oe = list[k]!;
      if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
      if (memGet(m.villagerRole, oe.index) === VILLAGER_BUILDER) builders++;
    }
  }

  /** この判断で新しく採集に就ける村人（`planEconomy` が `gather` を出す）。 */
  const toGather: OwnEntity[] = [];
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    if (memGet(m.villagerKnownId, oe.index) === id) continue;
    memSet(m.villagerKnownId, oe.index, id);
    memSet(m.villagerBusyUntil, oe.index, 0);
    if (firstLook) {
      // 開始時の村人は `setup` が資源に就かせている。触らない。
      memSet(m.villagerRole, oe.index, VILLAGER_GATHERER);
      continue;
    }
    // 生産されたばかりの村人。**建設係の枠が埋まっていたら、その場で採集に送る。**
    //
    // 以前は「全員いったん建設係にして、余ったら後で採集に回す」形だった。
    // これだと建設係が建設で塞がっている間は余りが見えず、実測で
    // **30 分に `gather` が 1 回しか出なかった**（＝生産された村人がほぼ全員遊んでいた）。
    // 遊ばせるくらいなら採らせるほうが常に得なので、既定を採集側に寄せる。
    if (builders < ctx.cfg.villagerBuilderCount) {
      memSet(m.villagerRole, oe.index, VILLAGER_BUILDER);
      builders++;
    } else {
      memSet(m.villagerRole, oe.index, VILLAGER_GATHERER);
      toGather.push(oe);
    }
  }
  return toGather;
}

/**
 * 村人 1 体を出すのに必要な手持ち = 村人のコスト + 家 1 棟のコスト。
 *
 * **家の資源まで使い切ってはいけない。** 使い切ると人口上限に当たったときに
 * 家が建てられず、そこから何も出せなくなって内政が破綻する（T-M13-02 の
 * 「破綻せず回す」はこれを指す）。数値はデータ（`units.json` / `buildings.json`）由来。
 */
const VILLAGER_RESERVE: Int32Array = (() => {
  const v = unitDefById(VILLAGER_ID).cost;
  const h = buildingDefById('house').cost;
  const out = new Int32Array(v.length);
  for (let r = 0; r < out.length; r++) out[r] = v[r]! + h[r]!;
  return out;
})();

/** 自軍の村人の数（生産中は数えない）。 */
export function countOwnVillagers(ctx: AiContext): number {
  const villagerType = unitDefById(VILLAGER_ID).index;
  let n = 0;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind === EntityKind.Unit && oe.typeId === villagerType) n++;
  }
  return n;
}

/** 村人を 1 体ずつ町の中心に積む（人口枠と手持ち資源が足りているときだけ）。 */
function pushVillagerProduction(ctx: AiContext, out: Command[]): void {
  const own = ctx.view.own;
  if (own.pop >= own.popCap) return; // 上限に当たっている（`07§8`「生産ボタンが止まります」）
  // **目標数で止める。** 止めないと入ってきた資源を全部村人に変えてしまい、
  // 手持ちが 0 付近に張り付いて次の世に上がれない（`AiLevelConfig.villagerTarget` 参照）。
  // **目標数で止める。**
  //
  // 止めないと入った食料をその場で村人に変え続け、手持ちが 0 付近に張り付いて
  // 次の世に上がれない。逆に止めるのが早すぎると採集人数が増えず、
  // やはり上がれない ―― 実測で「12 体で貯め始める」形にしたら
  // **村人 12 体のまま 30 分間固定**になった（費用も貯まらない）。
  //
  // だから貯めるための別のしきい値は持たず、**目標数まで出したら自然に止まる**
  // 形にしている（`villagerTarget` に達したあとは食料が余り始め、
  // その余りが次の世の費用になる）。軍事の生産も同じ目標数を待つので、
  // 「村人を揃える → 世を上げる → 兵を出す」の順に流れる。
  const villagers = countOwnVillagers(ctx);
  if (villagers >= ctx.cfg.villagerTarget) return;
  // ■ 「一定数で止めて貯める」を入れないことにした（実測で振った結果）
  //
  //   村人を止めて貯める形にすると青銅の世は 17〜23 分に早まるが、
  //   貯めているあいだ軍が細って**戦域が 1 本も立たなくなる**。
  //   逆に軍の下限を上げると戦域は立つが青銅に届かなくなる。
  //   止めない形（村人を目標数まで出し切る）が、**世に上がるのと戦域が立つのが
  //   両方成り立つ**唯一の組み合わせだった。`villagerBankFrom` は使っていない。
  void villagers;
  const udef = unitDefById(VILLAGER_ID);
  if (!canAfford(own.resources, VILLAGER_RESERVE)) return;
  const tc = findTownCenter(ctx);
  if (tc === null) return;
  // **1 体できあがるまで次を頼まない**（`AiMemory.produceTick` の注記）。
  //
  // 村人は 20 秒（500 tick）かかるので、判断ごとに `produce` を出すと
  // その間の判断ぶん（段階 4 で 10 件、段階 5 で 20 件）が同じ 1 体のために積み増しになる。
  // 実測では `villagerTarget` 22/26 に対して**どちらも村人 33〜36 体**になり、
  // 超過ぶんの食料（1 体 50）が時代進化の費用を食べていた。
  // 段階 5 は積み増しが 2 倍なのでとくに重く、**30 分で黎明の世のまま**の席が出ていた。
  if (!canQueueProduce(ctx, tc.index, udef.buildTicks)) return;
  markProduce(ctx, tc.index);
  out.push({
    t: 'produce',
    p: ctx.playerId,
    building: ctx.idOf(tc.index),
    unit: udef.id,
    count: 1,
  });
}

// ---------------------------------------------------------------- 建物

/**
 * 家が要るか（**人口上限に当たる前に**建てる）。
 *
 * しきい値は `ai.json` の `houseHeadroomPop`（既定は家 1 棟ぶん = `population.housePop`）。
 * 実測で**家が 6 棟で止まり人口 38/40 に張り付いた**ので、
 * 段階が上ほど広めに先読みさせる ―― 上限に当たってから建てると、
 * 家 1 棟が建つあいだ村人も兵も 1 体も出せない。
 */
function needsHouse(ctx: AiContext): boolean {
  const own = ctx.view.own;
  if (own.popCap >= POP_CAP_MAX) return false;
  const headroom = ctx.cfg.houseHeadroomPop > 0 ? ctx.cfg.houseHeadroomPop : HOUSE_POP;
  return own.popCap - own.pop <= headroom;
}

/**
 * 次に建てる内政建物を決める。
 *  - 人口の余裕が家 1 棟ぶんを切ったら家（最優先）
 *  - まだ持っていない資源施設のうち、**いちばん足りない資源**に効くもの
 *  - 建設係の村人が空いていなければ何もしない
 */
/**
 * 次に建てる内政建物を 1 棟だけ着工する。
 *
 * ■ **優先順に「試す」** ようにした理由（実測。決着しない原因の 1 つ）
 * 元の実装は候補を **1 つだけ選んで** `placeBuildingCommand` に渡していた。
 * その 1 つが払えなければ `null` を返して**その判断では何も建てない**。
 * 青銅の世でこうなっていた:
 *  - 進化条件の建物（`pickAgeGateBuilding`）は鍛冶場（木材 150）
 *  - 手持ちの木材は 11
 * 木材が貯まらないので鍛冶場は永久に建たず、**30 木材の家すら建たなかった**。
 * 家が 6 棟で止まって人口上限 40 に張り付いたのは、木材不足そのものより
 * この「打ち切り」が効いていた。
 *
 * 「払えないものを選んで諦める」のではなく、
 * **優先順に見て、いま払えるものを建てる**（人間も同じ順に手を動かす）。
 * 木材を進化用に貯めたい気持ちは `hasWoodForAgeGate`（農地の建て増しを止める）で
 * 表しているので、安い家を先に建てても進化用の木材は食い潰されない。
 */
export function planEconBuilding(ctx: AiContext, houseOnly = false): Command | null {
  const wishes = pickEconBuildings(ctx, houseOnly);
  for (let i = 0; i < wishes.length; i++) {
    const cmd = placeBuildingCommand(ctx, wishes[i]!);
    if (cmd !== null) return cmd;
  }
  return null;
}

/** 建てたい内政建物を**優先順**に並べて返す（`planEconBuilding` が上から試す）。 */
function pickEconBuildings(ctx: AiContext, houseOnly = false): string[] {
  const civ = ctx.view.own.civ as CivId;
  const out: string[] = [];
  // **人口が詰まる寸前の家だけがいちばん先。** 人口で詰まると村人も兵も
  // 1 体も出せなくなる（＝他の建物を建てる意味も無くなる）。
  //
  // ■ 「家を常にいちばん先」にしていたら時代が止まった（実測。原因の本体）
  // `houseHeadroomPop`（先読み。段階 4 で 10）を満たす家は 30 木材でいつでも払えるので、
  // **毎回の判断で家が選ばれ、進化条件の建物が候補にすら上がらなかった**:
  // ```
  // 30分 時代1 食料843 金193（費用は満たしている）建物の種1
  //      30 分間の着工試行 = 家9・農地5・射場2・伐採所1
  //      （鍛冶場も櫓も一度も試していない ―― 木材が入るたびに家に消えていた）
  // ```
  // だから「詰まる寸前（余裕が家 1 棟ぶん以下）」の家だけを進化条件より先にし、
  // **先読みの家は進化条件のあと**に回す。時代は兵の質・戦域スロット・研究・
  // 攻城兵器のすべての上限なので、1 棟の家より優先して構わない。
  const own = ctx.view.own;
  const house = resolveBuildingForCiv(civ, HOUSE_ID);
  const canHouse = house !== null && canCivBuild(civ, house);
  const jamming = own.popCap < POP_CAP_MAX && own.popCap - own.pop <= HOUSE_POP;
  if (canHouse && jamming) out.push(house!);
  // **次の世に上がるための建物条件。**
  //
  // `cfgAges` の `requireBuildingsOfPrevAge` は「**いまの世の建物を N 種類**持つこと」。
  // 実測では食料 1,414 / 金 250 と費用を満たしているのに鉄器に上がれなかった
  // ―― 青銅の世の建物を 1 種しか持っていなかった（`countCurrentAgeBuildingKinds`）。
  // 費用だけ見て建物条件を見ていないと、貯め続けるだけで永久に上がらない。
  // **次の世に上がるための建物は、搬入点のために貯めているあいだでも建てる。**
  //
  // `cfgAges` の `requireBuildingsOfPrevAge` は「**いまの世の建物を N 種類**持つこと」。
  // 実測では食料 1,414 / 金 250 と費用を満たしているのに鉄器に上がれなかった
  // ―― 青銅の世の建物を 1 種しか持っていなかった（`countCurrentAgeBuildingKinds`）。
  // 費用だけ見て建物条件を見ていないと、貯め続けるだけで永久に上がらない。
  const gate = pickAgeGateBuilding(ctx);
  if (gate !== null) out.push(gate);
  // **余りを詰まりに変える手段（市場）は、先読みの家より先。**
  //
  // ■ なぜここに置くのか（実測。攻城工房が建たない最後の壁）
  // ```
  // 25分 時代2 食料1,496 金203 木材31  → 木材 200 の攻城工房が建てられない
  // 30分 時代2 食料1,730 金193 木材12  → 30 分の着工試行に工房が一度も出てこない
  // ```
  // 拠点のそばの森が尽きたあと木材の収入は距離の壁で伸びず、
  // **木材 175 以上のものは 20 分以降どうやっても建てられない**。
  // 唯一の抜け道が市場（余った食料 → 金 → 木材）なのに、
  // 元の並び（資源施設と農地のあと）では木材の余っている時期に順番が回って来ず、
  // 30 分間 1 棟も建たなかった。**建てられる時期に建てないと二度と建てられない。**
  if (canBuildMarketForTrade(ctx)) {
    const market = resolveBuildingForCiv(civ, MARKET_ID);
    if (market !== null && canCivBuild(civ, market)) out.push(market);
  }
  // 先読みの家（`houseHeadroomPop`）は進化条件のあと。人口に余裕を作るのは大事だが、
  // 上の実測どおり、これを先に置くと木材が家に消えて時代が止まる。
  if (canHouse && !jamming && needsHouse(ctx)) out.push(house!);
  // **ここから下は「搬入点のために貯めている」あいだは建てない**（`planDropOff` の `saving`）。
  // 収入が止まっているのに農地や市場へ木材を使うと、伐採所の 100 が永久に貯まらない。
  //
  // ■ 家と進化条件の建物だけは例外にした（実測。これが最後の詰まりだった）
  // 貯め始めると `saving` が立ち、木材の収入がほぼ無い局面ではそれが永久に続く。
  // 以前は貯めているあいだ**家しか**建てなかったので、
  // 進化条件の建物が**候補にすら上がらなかった**:
  // ```
  // 30分 時代1 食料843 金193（費用は満たしている）建物の種1
  //      30 分間の着工試行 = 家9・農地5・射場2・伐採所1（鍛冶場も櫓も一度も試していない）
  // ```
  // 伐採所を建てて木材の収入を直すのは大事だが、**時代が止まるほうが致命的**
  // （時代は兵の質・戦域スロット・研究・攻城兵器のすべての上限）。
  // 進化条件の建物は 1 棟だけなので、これを許しても貯金は続く。
  if (houseOnly) return out;
  // **次の世に足りない資源**を優先して施設を建てる。
  //
  // ここを `scarcestResource`（手持ちの単純比較）にしていたら、
  // 果樹が枯れて食料が 200 で止まっているのに「石材のほうが数値が小さい」ため
  // 農地が 1 面も建たず、青銅の世の 500 に永久に届かなかった（実測）。
  // 農地は食料ノードを作り直せる唯一の手段なので、ここの選び方が効く。
  const scarce = deficitOrScarcest(ctx);
  for (let k = 0; k < ECON_BUILD_ORDER.length; k++) {
    const id = ECON_BUILD_ORDER[k]!;
    if (id === 'house') continue; // 家は上で見た
    const resolved = resolveBuildingForCiv(civ, id);
    if (resolved === null || !canCivBuild(civ, resolved)) continue;
    const bdef = buildingDefById(resolved);
    if (bdef.age > ctx.view.own.age) continue;
    // **いま採っていない資源の搬入点は建てない。**
    //
    // 黎明の世では石材も金も使い道が無い（青銅の費用は食料だけ）のに、
    // 実測では 3 分の時点で採掘場（木材 100）を建てていた。
    // 木材は序盤いちばん細い資源で、100 は農地 1.7 面ぶん ―― 農地が遅れれば
    // 食料も遅れ、青銅の到達が丸ごと遅れる。
    if (!isNeededDropOff(ctx, id)) continue;
    // 棟数上限のある建物（市場）は 1 棟持っていたら要らない。
    const have = countOwnBuildings(ctx, bdef.index);
    if (bdef.maxCount > 0 && have >= bdef.maxCount) continue;
    // 資源施設は 1 棟ずつでよい。農地だけは「足りない資源が食料のとき」建て増す。
    //
    // ただし **働き手の数を超えて建てない。**
    // 農地は食料ノードを載せるだけで、誰も就いていなければ 1 も採れない。
    // 実測（席 1 側）で農地 13 面まで建てながら食料が 166 で止まり、
    // 木材を農地に吸われて家が建たず、人口 30 で詰まって
    // **青銅の世に一度も上がらなかった**（席 0 側は農地 6 面で上がった）。
    // 誰も働かない農地は木材を捨てているのと同じ。
    // 農地は「食料が足りない」かつ「働き手の数以内」かつ
    // **進化用の建物 1 棟ぶんの木材を残せる**ときだけ建て増す。
    //
    // 木材の予備を見ないと、食料が細っている時期に農地を建て続けて
    // **木材が 25 まで枯れ、青銅の世の建物（木材 150〜175）が建てられなくなる**。
    // すると進化の建物条件（いまの世の建物 2 種）を満たせず、
    // 食料が 3,206 余っていても鉄器に上がれない（実測）。
    //
    // ■ さらに 2 つ条件を足した（実測。ファイル冒頭の表の「木材 11」の内訳）
    //  1. 働き手の数を `assignedByResource[FOOD]`（**これまでに何人を食料に就けたか**の
    //     累計。減らない数字）で見ていたため上限が事実上効かず、
    //     **農地を 14 面（木材 840）建てていた**。木材が枯れた最大の使い道がこれ。
    //     いまは `currentAssignment`（**いま食料に就いている人数**）で見る。
    //  2. **木材そのものが不足しているときは建てない。**
    //     農地は「木材を食料に変える」建物なので、食料が 1,838 余っていて
    //     木材が 11 の局面で建てるのは資源をドブに捨てているのと同じ。
    //  3. 「近くに果樹が残っているなら農地を建てない」も試したが**食料が枯れた**
    //     （30 分時点で食料ノードの残りが全マップで 1、村人 18・兵 3 まで落ちた）。
    //     果樹は有限で、遠くの果樹は運搬損失で実質使えない ―― 農地は必要。
    //     いまは 2. の「木材の不足が 0 のときだけ」＝ **余った木材の範囲で**建て増す
    //     形で釣り合わせている（木材の必要額には次の世の生産元も入っているので、
    //     兵舎ぶんの木を農地に食われることはない）。
    //  4. 面数の上限は**食料の働き手の割合**（`farmsPerFoodWorkerPercent`）。
    //     村人の目標を 32〜36 に上げたら、働き手そのままの上限では
    //     農地が 12〜21 面（木材 720〜1,260）建ち、攻城工房（木材 200）が
    //     最後まで建たなかった（実測で 30 分の着工試行に一度も出てこない）。
    const foodWorkers = currentAssignment(ctx, collectGatherers(ctx)).counts[FOOD]!;
    const deficits = resourceDeficits(ctx);
    const canGrowFarms =
      id === 'farm' &&
      scarce === FOOD &&
      deficits[WOOD] === 0 &&
      have < idiv(foodWorkers * ctx.cfg.farmsPerFoodWorkerPercent, 100) &&
      hasWoodForAgeGate(ctx, bdef.cost);
    if (have > 0 && !canGrowFarms) continue;
    out.push(resolved);
  }
  return out;
}

/**
 * 市場を建てる価値があるか（**まだ持っておらず、変換したい偏りがある**）。
 *
 * 「余っている資源が `marketSurplusUnits` を超えていて、足りない資源がある」＝
 * 交換で解ける偏りがある状態。市場は 1 棟で残り、以後ずっと効き続ける。
 */
function canBuildMarketForTrade(ctx: AiContext): boolean {
  const civ = ctx.view.own.civ as CivId;
  const market = resolveBuildingForCiv(civ, MARKET_ID);
  if (market === null || !canCivBuild(civ, market)) return false;
  const bdef = buildingDefById(market);
  if (bdef.age > ctx.view.own.age) return false;
  if (countOwnBuildings(ctx, bdef.index) > 0) return false;
  // **「余りが出てから」では遅い。**
  //
  // 最初は「余っている資源が `marketSurplusUnits` を超えていたら建てる」にしていた。
  // ところが余りが出るのは 20 分以降で、そのときには木材が 5〜30 しか無く
  // 市場（木材 175）自体が建てられない ―― 実測で 16 席のうち 13 席が 30 分間
  // 1 棟も建てられなかった。木材が余っているのは**青銅に上がった直後の数分だけ**で、
  // そこを農地（1 面 60）に使ってしまうと二度と機会が来ない。
  // だから「偏りが解けていない（＝何かが不足している）」なら建てる。
  // 市場は 1 棟で残り、以後ずっと効き続けるので、早いほど得。
  const deficits = resourceDeficits(ctx);
  for (let r = 0; r < RESOURCE_IDS.length; r++) if (deficits[r]! > 0) return true;
  return false;
}

/** いちばん足りない資源の添字（同値は添字の小さい方 = RESOURCE_IDS 順で固定）。 */
export function scarcestResource(resources: readonly number[]): number {
  let best = 0;
  for (let r = 1; r < resources.length; r++) {
    if (resources[r]! < resources[best]!) best = r;
  }
  return best;
}

/**
 * 建物 1 棟の着工コマンドを作る（村人 1 名を付ける）。
 * 置ける場所か資源が無ければ `null`。**村人を付けないと永久に完成しない**ので、
 * 建設係が空いていないときは着工しない。
 */
export function placeBuildingCommand(
  ctx: AiContext,
  buildingId: string,
  /** 建てたい辺り（省略時は拠点の周り）。近くの空きマスを探す。 */
  near?: { x: Fx; y: Fx },
): Command | null {
  const bdef = buildingDefById(buildingId);
  // **家 1 棟ぶんは常に残す。** 使い切ると人口上限に当たったときに家が建てられず、
  // そこから何も出せなくなる（家そのものを建てるときは当然この予備を要求しない）。
  const reserve = buildingId === HOUSE_ID ? bdef.cost : withHouseReserve(bdef.cost);
  if (!canAfford(ctx.view.own.resources, reserve)) return null;
  const builder = takeBuilder(ctx, bdef.buildTicks);
  if (builder < 0) return null;
  const site =
    near === undefined
      ? pickBuildSite(ctx, bdef.sizeW, bdef.sizeH)
      : pickBuildSiteNear(ctx, bdef.sizeW, bdef.sizeH, near);
  if (site === null) return null;
  ctx.memory.buildTick = ctx.view.tick;
  return {
    t: 'placeBuilding',
    p: ctx.playerId,
    type: buildingId,
    x: site.x,
    y: site.y,
    villagers: [builder],
  };
}

/**
 * 建設係の村人を 1 名借りる（**採集係には手を付けない**）。
 * 借りた村人はその建物の `buildTicks` ぶん塞がっている扱いにする。
 * 空いていなければ -1。
 */
function takeBuilder(ctx: AiContext, buildTicks: number): EntityId {
  const m = ctx.memory;
  const tick = ctx.view.tick;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit) continue;
    if (memGet(m.villagerRole, oe.index) !== VILLAGER_BUILDER) continue;
    if (memGet(m.villagerBusyUntil, oe.index) > tick) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    memSet(m.villagerBusyUntil, oe.index, tick + buildTicks);
    return id;
  }
  return -1 as EntityId;
}

/** 自軍の建物の棟数（typeId 指定。建設中も数える）。 */
export function countOwnBuildings(ctx: AiContext, typeId: number): number {
  let n = 0;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind === EntityKind.Building && oe.typeId === typeId) n++;
  }
  return n;
}

/** 自軍の完成した町の中心（index 昇順の最初の 1 棟）。 */
export function findTownCenter(ctx: AiContext): OwnEntity | null {
  const id = resolveBuildingForCiv(ctx.view.own.civ as CivId, TOWN_CENTER_ID);
  if (id === null) return null;
  const typeId = buildingDefById(id).index;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind === EntityKind.Building && oe.typeId === typeId && oe.complete) return oe;
  }
  return null;
}

/**
 * 建設地を選ぶ。
 *
 * 町の中心のまわり（`morale.insideOwnWallsRadiusTiles` の範囲）を
 * **Chebyshev 距離昇順に固定した候補表**で走査し、
 *  - マップ内で、足跡のマスすべてが陸で通行可能
 *  - 既にある自軍の建物の足跡と重ならない
 * を満たす最初のマスを返す。走査の開始位置だけ `rngAi` でずらす
 * （毎回同じ場所を試して失敗し続けるのを避けるため。乱数は AI 専用ストリーム）。
 */
export function pickBuildSite(ctx: AiContext, sizeW: number, sizeH: number): { x: Fx; y: Fx } | null {
  const tc = findTownCenter(ctx);
  if (tc === null) return null;
  const baseTx = idiv(tc.x, FX_ONE);
  const baseTy = idiv(tc.y, FX_ONE);
  const offsets = buildSiteOffsets();
  const start = ctx.rng.nextInt(offsets.length);
  for (let k = 0; k < offsets.length; k++) {
    const o = offsets[(start + k) % offsets.length]!;
    const tx = baseTx + o[0]!;
    const ty = baseTy + o[1]!;
    if (!footprintFree(ctx, tx, ty, sizeW, sizeH)) continue;
    if (overlapsOwnBuilding(ctx, tx, ty, sizeW, sizeH)) continue;
    return { x: tx * FX_ONE + FX_HALF, y: ty * FX_ONE + FX_HALF };
  }
  return null;
}

/**
 * 指定した辺りの近くで建てられるマスを探す（**遠い資源のそばに搬入点を建てる**のに使う）。
 *
 * 内側から外側へ広げて探すので、いちばん資源に近いマスが選ばれる。
 * 乱数を使わない（`pickBuildSite` は拠点周りをばらけさせるために乱数を使うが、
 * こちらは「資源のいちばん近く」が正解なので順番に探す）。
 */
export function pickBuildSiteNear(
  ctx: AiContext,
  sizeW: number,
  sizeH: number,
  near: { x: Fx; y: Fx },
): { x: Fx; y: Fx } | null {
  const cx = idiv(near.x, FX_ONE);
  const cy = idiv(near.y, FX_ONE);
  // 資源ノードの真上には建てられないので、2 マス外から探し始める。
  for (let r = 2; r <= NEAR_SITE_MAX_TILES; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // 輪の縁だけを見る（内側は前の r で見終わっている）
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (!footprintFree(ctx, tx, ty, sizeW, sizeH)) continue;
        if (overlapsOwnBuilding(ctx, tx, ty, sizeW, sizeH)) continue;
        return { x: tx * FX_ONE + FX_HALF, y: ty * FX_ONE + FX_HALF };
      }
    }
  }
  return null;
}

/** 足跡のマスがすべてマップ内・陸・通行可能か。 */
function footprintFree(ctx: AiContext, tx: number, ty: number, w: number, h: number): boolean {
  const map = ctx.view.map;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= map.widthTiles || y >= map.heightTiles) return false;
      if (hasTerrain(map) && !isPassableFor(map, x, y, Move.Land)) return false;
    }
  }
  return true;
}

/** 既にある自軍の建物の足跡と重なるか（視界に入っている自軍の建物だけを見る）。 */
function overlapsOwnBuilding(
  ctx: AiContext,
  tx: number,
  ty: number,
  w: number,
  h: number
): boolean {
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Building) continue;
    const bdef = buildingDef(oe.typeId);
    const ox = idiv(oe.x, FX_ONE);
    const oy = idiv(oe.y, FX_ONE);
    if (tx < ox + bdef.sizeW && ox < tx + w && ty < oy + bdef.sizeH && oy < ty + h) return true;
  }
  return false;
}

/**
 * 建設候補のマス（町の中心からの相対座標）。
 * 距離 → dy → dx の昇順に固定した**レイアウト表**（バランス数値ではない）。
 * 生成は 1 回だけ。
 */
let SITE_OFFSETS: readonly (readonly [number, number])[] | null = null;

function buildSiteOffsets(): readonly (readonly [number, number])[] {
  if (SITE_OFFSETS !== null) return SITE_OFFSETS;
  // 町の中心の足跡（4×4）を避ける最小距離から、町の内側の範囲まで。
  const tcSize = buildingDefById(TOWN_CENTER_ID).sizeW;
  const min = tcSize;
  const max = tcSize + TOWN_RADIUS_TILES;
  const out: [number, number][] = [];
  for (let d = min; d <= max; d++) {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        const cheb = Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy);
        if (cheb !== d) continue;
        out.push([dx, dy]);
      }
    }
  }
  SITE_OFFSETS = out;
  return out;
}

// ---------------------------------------------------------------- 研究・時代進化

/**
 * 研究を 1 件だけ選ぶ。自軍の建物が持つ `researches` を**建物の index 昇順・
 * 定義順**に見て、まだ取っておらず、文明が禁じておらず、時代が来ているものの最初。
 * 令の仕組みに関わる研究（旗竿・早馬・復唱・二重旗）も同じ経路で入る。
 */
export function planResearch(ctx: AiContext): Command | null {
  const own = ctx.view.own;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Building || !oe.complete) continue;
    const bdef = buildingDef(oe.typeId);
    for (let t = 0; t < bdef.researches.length; t++) {
      const techId = bdef.researches[t]!;
      const tdef = techDefById(techId);
      if (tdef.age > own.age) continue;
      if (!canCivResearch(own.civ as CivId, techId)) continue;
      if (own.researched[tdef.index] === true) continue;
      if (!hasPrereqs(ctx, tdef.requires)) continue;
      if (!canAfford(own.resources, tdef.cost)) continue;
      return { t: 'research', p: ctx.playerId, building: ctx.idOf(oe.index), tech: techId };
    }
  }
  return null;
}

function hasPrereqs(ctx: AiContext, requires: readonly string[]): boolean {
  for (let i = 0; i < requires.length; i++) {
    const tdef = techDefById(requires[i]!);
    if (ctx.view.own.researched[tdef.index] !== true) return false;
  }
  return true;
}

/**
 * 余った建設係を採集に就ける（`07§2` の「村人を遊ばせない」）。
 *
 * ■ なぜ必要になったか（実測で分かった不具合）
 * `classifyVillagers` は「後から現れた村人 = 建設係」と決めるが、建設係は
 * `takeBuilder` に借りられるまで**何もしない**。着工は 1 回の判断で 1 棟だけなので、
 * 生産された村人はほぼ全員が手空きのまま立ち続けていた。
 * 実測（8 人・30 分）で **石材と金の累計採集量が 0**、食料も設計値の約 1/20 で、
 * 結果として誰も鉄器の世に到達せず**文明ごとの兵種が 1 体も出なかった**。
 *
 * ■ 直し方
 * 建設係を `villagerBuilderCount` 人だけ残し、**それを超えた手空きの村人は
 * いちばん足りない資源のノードへ送って採集係にする**。
 * 一度採集係にしたら触らない（`sim` 側が枯れたら次のノードへ移してくれる）。
 *
 * ■ 決定論
 * `ownEntities` は index 昇順、`seenResourceNodes` も index 昇順。
 * 距離は平方距離の整数比較で、同距離なら**先に見つけたノード**を採る。
 * 乱数を使わないので全端末で同じ結論になる。
 */
export function gatherCommandsFor(ctx: AiContext, villagers: readonly OwnEntity[]): Command[] {
  if (villagers.length === 0) return [];
  const m = ctx.memory;
  // **記憶から選ぶ**（視界内だけだと拠点の周りの森と果樹しか選べない）。
  if (m.nodeIds.length === 0) return [];

  // ■ 決め方を 3 度作り直している。経緯を残す:
  //  1. 「いちばん足りない資源」だけを狙わせた → 食料と木材は入った瞬間に消えるので
  //     常にこの 2 つが最下位になり、**石材と金は 30 分で 0 のまま**だった。
  //  2. 4 資源に均等に散らした → 石材と金は入るようになったが、こんどは
  //     **食料が 200 前後で止まり**、青銅の世の 500 に届かなかった（1/4 しか採らない）。
  //  3. 「半分は `gatherTargets` を順番に、半分は次の世に足りない資源へ」。
  //     これは**数の割り当て**であって需要を見ていない。次の世の費用は食料と金なので、
  //     木材は「順番の 1/3 の半分」= 全体の 1/6 しか回らず、実測の 4/26 と一致した。
  //     その結果、食料 1,838・金 907 が余る一方で**木材 11 で枯れ**、
  //     家 6 棟・生産元 0 棟のまま人口上限に張り付いた（ファイル冒頭の表）。
  //  4. いま: **不足額に比例した需要の割り当て**（`villagerDemandPlan`）。
  //     「余っているものを採り続け、詰まっているものを採らない」を構造的に無くす。
  //
  // 乱数は使わない。同じ盤面・同じ記憶なら同じ配分になる（§0.3）。
  const gatherers = collectGatherers(ctx);
  const { counts } = currentAssignment(ctx, gatherers);
  const desired = villagerDemandPlan(ctx, gatherers.length);
  memSet(m.gatherAssignSeq, 0, memGet(m.gatherAssignSeq, 0) + villagers.length);
  return gatherAssignCommands(ctx, villagers, counts, desired);
}

// ------------------------------------------------- 需要にもとづく村人の割り当て
//
// ここから下の 6 つの関数が、このファイルの心臓部（ファイル冒頭の実測表を参照）。
//  `resourceDeficits`     … 資源ごとの「いくら足りないか」（Fx）
//  `wishBuildings`        … いま建てたい建物（家・進化条件・生産元）
//  `villagerDemandPlan`   … 不足額に比例した「資源ごとの望ましい人数」
//  `currentAssignment`    … 記憶から数えた「資源ごとのいまの人数」
//  `gatherAssignCommands` … 村人の一覧を受け取り、望ましい配分に近づける `gather` を出す
//  `planReassignVillagers`… すでに働いている村人の配置換え（人数の上限つき）

/**
 * いま建てたい建物とその棟数（**優先順**。数値ではなく「何を欲しいか」の表）。
 *
 * 不足額の計算にも、`planEconBuilding` の建てる順にも同じものを使う。
 * 別々に持つと「木材を採らせないのに木材の建物を建てようとする」という
 * ねじれが起きる（実測でまさにそれが起きていた ―― 進化条件の建物を
 * 建てたがるのに、木材には 26 人中 3〜4 人しか就いていなかった）。
 */
export function wishBuildings(ctx: AiContext): { id: string; count: number }[] {
  const out: { id: string; count: number }[] = [];
  const civ = ctx.view.own.civ as CivId;
  const own = ctx.view.own;
  // 1) 家。**人口上限に届いていない限り、常に「次の 1 棟」を欲しがる。**
  //    家が 6 棟で止まって人口 38/40 に張り付いたのが決着しない原因の中心だった。
  if (own.popCap < POP_CAP_MAX) {
    const house = resolveBuildingForCiv(civ, HOUSE_ID);
    if (house !== null && canCivBuild(civ, house)) {
      out.push({ id: house, count: ctx.cfg.housePlanAhead });
    }
  }
  // 2) 次の世に上がるための建物（`requireBuildingsOfPrevAge`）。
  const gate = pickAgeGateBuilding(ctx);
  if (gate !== null) out.push({ id: gate, count: 1 });
  // 3) 兵の生産元（兵舎・射場・厩）。無いと青銅以降の兵が 1 体も作れない。
  const producer = missingProducerBuilding(ctx, own.age);
  if (producer !== null && producer !== gate) {
    out.push({ id: producer, count: ctx.cfg.producerPlanAhead });
  }
  // 4) **次の世で欲しくなる生産元も、いまから木材を貯める対象に入れる。**
  //
  // ■ なぜ先読みするのか（実測）
  // 黎明の世では木材の使い道が家（30）だけなので、不足額で割り当てると
  // 木材に 2 人しか就かない。そのまま青銅に上がった瞬間に兵舎（木材 175）が
  // 欲しくなるが、手持ちは 0〜85 しか無く、そこから 175 貯めるあいだ
  // **生産元が 1 棟も建たない**（実測で 30 分ずっと生産元 0・青銅なのに黎明の兵だけ）。
  // 人間は「次の世で兵舎を建てる」と分かっているので黎明のうちから木を伐る。
  // 建てる判断（`pickEconBuildings` / `planMilitaryBuilding`）は世が上がるまで
  // 動かないので、ここで需要だけ先に立てても早く建ててしまうことはない。
  if (ctx.cfg.allowAdvanceAge && own.age + 1 < AGE_IDS.length) {
    const nextProducer = missingProducerBuilding(ctx, own.age + 1);
    if (nextProducer !== null && nextProducer !== gate && nextProducer !== producer) {
      out.push({ id: nextProducer, count: ctx.cfg.producerPlanAhead });
    }
  }
  // 5) **採っている資源の搬入点 1 棟ぶん**を常に見込む（伐採所・採掘場）。
  //
  // ■ なぜ「まだ要らない」ものを見込むのか（実測。これを入れないと元に戻る）
  // 森は枯れる。拠点のそばを伐り尽くしたら**遠い森のそばに伐採所を建てる**しかないが、
  // その時点で木材が 3 しか無ければ 100 の伐採所は建てられず、
  // **木材の収入が二度と戻らない**（実測: 20 分以降ずっと wood 3・木材を運ぶ村人 0 人、
  // 森はマップに 6,974 残ったまま）。
  // 農地の建て増しは「木材の不足が 0 のとき」だけなので、ここに 1 棟ぶん積んでおくと
  // **その 100 は農地に使われず、枯れたときの伐採所ぶんとして残る**。
  for (let i = 0; i < RESOURCE_IDS.length; i++) {
    const camp = gatherTargets(ctx).includes(i) ? dropOffBuildingFor(ctx, i) : null;
    if (camp === null) continue;
    let dup = false;
    for (let k = 0; k < out.length; k++) if (out[k]!.id === camp) dup = true;
    if (!dup) out.push({ id: camp, count: 1 });
  }
  return out;
}

/**
 * いまの世で作れる兵の一覧（`militaryGoals.producibleUnits` の内政側の写し）。
 *
 * `militaryGoals` を import すると `econGoals` と相互参照になるので、
 * ここでは**必要な範囲だけ**を自前で数える。
 *
 * ■ **船は数えない**（実測で踏んだ罠。必ず残すこと）
 * `militaryGoals.producibleUnits` は水域の割合を見て船を外す（平野では作らない）。
 * こちらでその条件を落としたら、黎明の世で「船の生産元 = 港（木材 100）」が
 * 「まだ持っていないいちばん安い生産元」に選ばれ、**建てるつもりの無い建物のために
 * 木材の需要が 100 増えた**。結果、木材に人が流れて食料が細り、
 * 青銅の世が 15 分 → 25 分に遅れた（村人も 26 → 22 に減った）。
 * 建てないものを欲しがってはいけない。
 */
function producibleUnitIdsForEcon(ctx: AiContext, age: number): string[] {
  const civ = ctx.view.own.civ as CivId;
  const out: string[] = [];
  for (let i = 0; i < UNIT_DEFS.length; i++) {
    const u = UNIT_DEFS[i]!;
    if (u.civ !== null) continue; // 文明固有はツリーから拾う
    if (u.lineIdx === 0) continue; // 村人・斥候・伝令は軍事の対象外
    if (u.role === 'ship') continue; // 上の注記を参照
    if (u.age > age) continue;
    out.push(u.id);
  }
  const tree = civUnitsAtAge(civ, age);
  for (let i = 0; i < tree.length; i++) {
    const u = unitDefById(tree[i]!);
    if (u.age > age) continue;
    if (u.role === 'ship') continue;
    out.push(u.id);
  }
  return out;
}

/**
 * まだ持っていない兵の生産元のうち、いちばん安いもの（無ければ null）。
 *
 * ■ なぜ「生産元」を不足額に入れるのか（実測）
 * 青銅の世に上がっても**生産元が 0 棟**で、兵は棍棒兵と狩人
 * （`units.json` で `producedAt: town_center`）だけだった。
 * 兵舎・射場は木材 175 で、木材が 11 のあいだは永久に建たない。
 * 「建てたいのに払えない」ものを不足額に入れないと、
 * 村人はその木材を採りに行かない ―― 需要と採集がつながらない。
 *
 * 段階で禁じているものは欲しがらない（攻城工房は `allowSiege`、
 * 城・大天幕は `allowDecoy`。`militaryGoals.planMilitaryBuilding` と同じ条件）。
 */
function missingProducerBuilding(ctx: AiContext, age: number): string | null {
  const civ = ctx.view.own.civ as CivId;
  const units = producibleUnitIdsForEcon(ctx, age);
  let bestId: string | null = null;
  let bestCost = 0;
  for (let i = 0; i < units.length; i++) {
    const udef = unitDefById(units[i]!);
    if (udef.role === 'siege' && !ctx.cfg.allowSiege) continue;
    const src = resolveBuildingForCiv(civ, udef.producedAt);
    if (src === null || !canCivBuild(civ, src)) continue;
    const bdef = buildingDefById(src);
    if (bdef.age > age) continue;
    if (bdef.frontSlotBonus > 0 && !ctx.cfg.allowDecoy) continue;
    if (countOwnBuildings(ctx, bdef.index) > 0) continue; // 町の中心もここで外れる
    let total = 0;
    for (let r = 0; r < bdef.cost.length; r++) total += bdef.cost[r]!;
    // 同額なら ID 昇順（乱数を使わない。§0.3）。
    if (bestId === null || total < bestCost || (total === bestCost && src < bestId)) {
      bestId = src;
      bestCost = total;
    }
  }
  return bestId;
}

/** いま作れる兵のうちいちばん安いもの（不足額に「兵の費用」を入れるのに使う）。 */
function cheapestProducibleUnit(ctx: AiContext): string | null {
  const units = producibleUnitIdsForEcon(ctx, ctx.view.own.age);
  let bestId: string | null = null;
  let bestCost = 0;
  for (let i = 0; i < units.length; i++) {
    const udef = unitDefById(units[i]!);
    if (udef.role === 'siege' && !ctx.cfg.allowSiege) continue;
    let total = 0;
    for (let r = 0; r < udef.cost.length; r++) total += udef.cost[r]!;
    if (bestId === null || total < bestCost || (total === bestCost && udef.id < bestId)) {
      bestId = udef.id;
      bestCost = total;
    }
  }
  return bestId;
}

/**
 * 資源ごとの**不足額**（Fx。足りているものは 0）。
 *
 * 必要額 = 次の世のための取り置き（`ageReserveFx`）
 *        + 建てたい建物の費用（`wishBuildings`）
 *        + 作りたい兵の費用（`unitDemandCount` 体ぶん）
 * 不足額 = max(0, 必要額 − 手持ち)。
 *
 * ■ なぜ「不足額」で測るのか
 * 元の実装は「いちばん足りない資源」＝ **手持ちの大小**で決めていた。
 * これだと使い道の無い石材（100）が常に最下位に見え、
 * 逆に**本当に詰まっている木材（11）が「食料 1,838 より少ないだけ」に見えない**。
 * 見るべきは「手持ちが少ないか」ではなく「**やりたいことに対して足りないか**」。
 *
 * すべて Fx（Q8 の整数）で計算する。浮動小数は使わない（§0.3）。
 */
export function resourceDeficits(ctx: AiContext): Int32Array {
  const n = RESOURCE_IDS.length;
  const need = new Int32Array(n);
  // **次の世に上がるのに要る額は「取り置きの割合」ではなく満額で数える。**
  //
  // ■ なぜ直したか（実測。この 1 行が鉄器の世に届かない原因だった）
  // `ageReserveFx` は 2 つ目以降の世を `ageReserveRatioAfterFirst`（0.5）倍にしている。
  // これは「兵に使い切らないための取り置き」＝**使い方の話**なので半分でよいが、
  // それをそのまま「採る目標」に使うと、鉄器の世（食料 800・金 200）に対して
  // 目標が食料 400・金 100 になり、**そこで不足額が 0 になって人が離れる**。
  // 実測（段階 4・3 組・30 分）では食料が 400〜520、金が 89〜170 で頭打ちになり、
  // **3 組すべてが 30 分間ずっと青銅の世のまま**だった（変更前は 25 分前後で鉄器）。
  // 時代は兵の質・戦域スロット・研究のすべての上限なので、ここが止まると決着しない。
  const ageNeed = nextAgeCostFx(ctx);
  const reserve = ageReserveFx(ctx);
  for (let r = 0; r < n; r++) need[r] = ageNeed[r]! > reserve[r]! ? ageNeed[r]! : reserve[r]!;
  const wish = wishBuildings(ctx);
  for (let i = 0; i < wish.length; i++) {
    const cost = buildingDefById(wish[i]!.id).cost;
    for (let r = 0; r < n; r++) need[r] = need[r]! + cost[r]! * wish[i]!.count;
  }
  const unit = cheapestProducibleUnit(ctx);
  if (unit !== null && ctx.cfg.unitDemandCount > 0) {
    const cost = unitDefById(unit).cost;
    for (let r = 0; r < n; r++) need[r] = need[r]! + cost[r]! * ctx.cfg.unitDemandCount;
  }
  const have = ctx.view.own.resources;
  const out = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    const d = need[r]! - (have[r] ?? 0);
    out[r] = d > 0 ? d : 0;
  }
  return out;
}

/**
 * 次の世の費用（Fx。資源 index 順）。上げない段階・最終世は 0。
 *
 * `ageReserveFx` と違って**割合を掛けない**（あちらは「兵に使わずに取り置く額」、
 * こちらは「上がるのに要る額」。混ぜると `resourceDeficits` の注記の事故になる）。
 */
function nextAgeCostFx(ctx: AiContext): Int32Array {
  const out = new Int32Array(RESOURCE_IDS.length);
  if (!ctx.cfg.allowAdvanceAge) return out;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return out;
  const next = cfgAges()[age + 1];
  if (next === undefined) return out;
  for (const [resId, amount] of Object.entries(next.cost)) {
    const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
    if (r >= 0) out[r] = fx(amount);
  }
  return out;
}

/**
 * 資源ごとの**望ましい人数**（合計が `total` になる整数の配分）。
 *
 * 決め方:
 *  1. **下限を先に確保する**（`ai.json` の 3 つの百分率。下の「なぜ下限が要るか」）。
 *  2. 残りを**不足額に比例**して割る（`gatherTargets` に入っている資源だけ）。
 *  3. 端数は「余り（`rest * 不足額 % 合計`）の大きい順、同値は資源の添字昇順」に
 *     1 人ずつ。**割り方まで一意に決める**（同じ盤面なら全端末で同じ配分。§0.3）。
 *
 * 不足額がどこも 0（＝やりたいことは全部払える）なら、
 * `gatherTargets` に均等（端数は添字の小さい方）。余っているものをさらに
 * 集めても意味はないが、村人を遊ばせるのはもっと悪い。
 *
 * ■ なぜ下限が 3 つ要るか（**比例配分だけでは足りない**。実測で 2 度踏んだ）
 *  - `foodWorkerMinPercent`（食料）: 食料は村人と兵の元。切らすと立て直せない。
 *    下限を 30% にしたとき食料ノードを掘り切って**村人 24 → 15・兵 3** まで落ちた。
 *  - `woodWorkerMinPercent`（木材）: 家と生産元の元。木材が枯れると家が止まって
 *    人口上限に張り付き、兵舎も建たない（この改修のいちばん最初の実測表）。
 *  - `ageWorkerMinPercent`（**次の世にまだ足りない資源**）: ここが今回の追加。
 *    **時代が上がることの価値は不足額の大きさに比例しない。**
 *    「あと金 110 で鉄器」のときの金 110 は、木材 610 よりはるかに効く
 *    （時代は兵の質・戦域スロット・研究・攻城兵器のすべての上限）。
 *    比例配分だけだと木材の不足額（生産元 2 棟＋搬入点＝ 610 前後）が常に大きく、
 *    金には人が回らない ―― 実測（3 組・30 分）で金が 89〜170 で頭打ちになり、
 *    **3 組すべてが 30 分ずっと青銅の世**だった。
 * 下限の合計が村人の数を超えたら、**添字昇順に配れるだけ**配る（一意に決まる）。
 */
export function villagerDemandPlan(ctx: AiContext, total: number): Int32Array {
  const n = RESOURCE_IDS.length;
  const desired = new Int32Array(n);
  if (total <= 0) return desired;
  const targets = gatherTargets(ctx);
  if (targets.length === 0) return desired;

  const deficits = resourceDeficits(ctx);
  const weight = new Int32Array(n);
  let sum = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i]!;
    weight[r] = deficits[r]!;
    sum += deficits[r]!;
  }

  if (sum === 0) {
    // どこも足りていない資源が無い → `gatherTargets` に均等。
    const base = idiv(total, targets.length);
    let left = total - base * targets.length;
    for (let i = 0; i < targets.length; i++) {
      desired[targets[i]!] = base + (left > 0 ? 1 : 0);
      if (left > 0) left--;
    }
    return desired;
  }

  // 1) 下限（百分率は整数のまま。`idiv` は整数除算なので浮動小数は出ない）。
  const floors = new Int32Array(n);
  floors[FOOD] = idiv(total * ctx.cfg.foodWorkerMinPercent, 100);
  // **木材の下限は「木材が足りていないとき」だけ。**
  //
  // 下限を無条件にしたら、木材が要求額を超えて余っている局面でも 2 割が森に張り付いた。
  // 実測（`tests/balance/civ.distinct.test.ts`）で**ローマだけ 20 分で青銅の世に
  // 上がれなくなった**（15 分時点で木材 475 を抱えながら食料は 146）。
  // ローマは「畑が貧しい」文明（`civs.json`）なので食料の取り分に最も敏感で、
  // ここが最初に折れる。食料の下限を無条件にしているのは、
  // 食料だけは village の生産そのものが止まると立て直せないため（非対称は意図）。
  if (deficits[WOOD]! > 0) floors[WOOD] = idiv(total * ctx.cfg.woodWorkerMinPercent, 100);
  // **次の世にまだ足りない資源**に、まとめて `ageWorkerMinPercent` ぶんを配る。
  // 対象が 2 つ（鉄器なら食料と金）なら等分し、端数は添字の小さい方へ。
  // 食料のように既に下限を持つ資源は `max` を採る（足し合わせると二重になる）。
  const ageShort: number[] = [];
  {
    const ageNeed = nextAgeCostFx(ctx);
    // **進化の建物条件の費用も「次の世に足りないもの」に数える。**
    //
    // 進化には費用のほかに「**いまの世の建物を 2 種**」が要る（`03§2`）。
    // 費用だけを見ていたので、実測ではこうなっていた:
    // ```
    // 30分 時代1 食料802 金218（費用は満たしている）建物の種1 → 進化の空打ち 163 回
    // 30分 時代1 食料815 金320（同じ）             建物の種1 → 空打ち 336 回
    // ```
    // 足りないのは資源ではなく**鍛冶場（木材 150）1 棟**で、
    // その木材に人が回らないので永久に建たない。ここに入れれば下限が付く。
    const gate = pickAgeGateBuilding(ctx);
    const gateCost = gate === null ? null : buildingDefById(gate).cost;
    const have = ctx.view.own.resources;
    for (let r = 0; r < n; r++) {
      const want = ageNeed[r]! + (gateCost === null ? 0 : gateCost[r]!);
      if (want > 0 && (have[r] ?? 0) < want) ageShort.push(r);
    }
  }
  if (ageShort.length > 0) {
    const ageTotal = idiv(total * ctx.cfg.ageWorkerMinPercent, 100);
    const base = idiv(ageTotal, ageShort.length);
    let extra = ageTotal - base * ageShort.length;
    for (let i = 0; i < ageShort.length; i++) {
      const r = ageShort[i]!;
      const share = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      if (share > floors[r]!) floors[r] = share;
    }
  }
  // 下限の合計が村人の数を超えたら、添字昇順に配れるだけ配る（残りは 0 に切る）。
  let floorSum = 0;
  for (let r = 0; r < n; r++) {
    if (floorSum + floors[r]! > total) floors[r] = total - floorSum;
    if (floors[r]! < 0) floors[r] = 0;
    floorSum += floors[r]!;
  }
  const rest = total - floorSum;

  // 2) 比例配分（切り捨て）と端数の記録。
  const remainder = new Int32Array(n);
  let assigned = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i]!;
    const num = rest * weight[r]!;
    const q = idiv(num, sum);
    desired[r] = q;
    remainder[r] = num - q * sum;
    assigned += q;
  }
  // 3) 端数を配る（余りの大きい順 → 添字昇順。走査は添字昇順なので同値は先勝ち = 添字昇順）。
  let left = rest - assigned;
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i]!;
      if (best < 0 || remainder[r]! > remainder[best]!) best = r;
    }
    if (best < 0) break;
    desired[best] = desired[best]! + 1;
    remainder[best] = -1; // 一度配ったら次の候補に譲る
    left--;
  }
  // 4) 下限を足し戻す。配り切れなかった端数（`left`）は食料へ（人口の元なので無駄にならない）。
  for (let r = 0; r < n; r++) desired[r] = desired[r]! + floors[r]!;
  desired[FOOD] = desired[FOOD]! + left;
  return desired;
}

/** 自軍の採集係（`ownEntities` の index 昇順）。 */
function collectGatherers(ctx: AiContext): OwnEntity[] {
  const m = ctx.memory;
  const villagerType = unitDefById(VILLAGER_ID).index;
  const out: OwnEntity[] = [];
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    if (memGet(m.villagerRole, oe.index) !== VILLAGER_GATHERER) continue;
    out.push(oe);
  }
  return out;
}

/**
 * いま資源ごとに何人を就かせているか（`AiMemory.villagerResource` から数える）。
 *
 * `AiView` は「その村人が何を採っているか」を渡してくれないので、
 * **自分が出した命令の記録**で数える（`villagerResource` の注記を参照）。
 * まだ命じていない村人（開始時の村人）は `unknown` に入れる ――
 * どこに就いているか分からないので、どの資源の人数にも数えず、
 * **配置換えの最初の候補**にする（余っている資源に張り付いているのは彼らなので）。
 */
function currentAssignment(
  ctx: AiContext,
  gatherers: readonly OwnEntity[],
): { counts: Int32Array; unknown: OwnEntity[]; byResource: OwnEntity[][] } {
  const m = ctx.memory;
  const counts = new Int32Array(RESOURCE_IDS.length);
  const unknown: OwnEntity[] = [];
  const byResource: OwnEntity[][] = [];
  for (let r = 0; r < RESOURCE_IDS.length; r++) byResource.push([]);
  for (let k = 0; k < gatherers.length; k++) {
    const oe = gatherers[k]!;
    const r = memGet(m.villagerResource, oe.index) - 1;
    if (r < 0 || r >= RESOURCE_IDS.length) {
      unknown.push(oe);
      continue;
    }
    counts[r] = counts[r]! + 1;
    byResource[r]!.push(oe);
  }
  return { counts, unknown, byResource };
}

/**
 * 渡された村人を、望ましい配分にいちばん足りない資源へ就ける `gather` を作る。
 *
 * `counts` は**この呼び出しの中で増やしながら**使う（同じ資源に全員を送らないため）。
 * 同じノードへ行く村人は **1 コマンドに束ねる**
 * ―― 人間なら「まとめて選んで資源をクリック」＝ 1 操作なので、
 * 1 人ずつ出すと APM を過大に数えることになる（実測で 86.5 まで上がった）。
 */
function gatherAssignCommands(
  ctx: AiContext,
  villagers: readonly OwnEntity[],
  counts: Int32Array,
  desired: Int32Array,
): Command[] {
  const m = ctx.memory;
  const byTarget = new Map<number, EntityId[]>();
  for (let k = 0; k < villagers.length; k++) {
    const oe = villagers[k]!;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    // **不足の大きい資源から**。ノードの場所を知らない資源は飛ばす
    // （知らない場所へは送れない ―― 探索の仕事。`scoutGoals`）。
    let want = -1;
    let bestGap = 0;
    let target: EntityId | null = null;
    for (let r = 0; r < RESOURCE_IDS.length; r++) {
      const gap = desired[r]! - counts[r]!;
      if (gap <= 0) continue;
      if (want >= 0 && gap <= bestGap) continue; // 同値は添字の小さい方（先勝ち）
      const node = nearestNodeOf(ctx, oe, r);
      if (node === null) continue;
      want = r;
      bestGap = gap;
      target = node;
    }
    if (want < 0 || target === null) {
      // 望ましい配分がもう埋まっている（または場所を知らない）。
      // それでも遊ばせるより採らせるほうが得だが、**行き先は「いま使う資源」に限る**。
      //
      // 以前は「いちばん近いノード」に落としていた。そのせいで拠点のそばに石切場が
      // ある文明（ヤマト）では余った村人が石材に流れ、**使い道の無い石材が 710** まで
      // 積み上がっていた（そのあいだ木材は 19 で、進化用の建物が建てられない）。
      // `gatherTargets` の中から近い順に探し、それでも無ければ最後の手段で何でも採る。
      const targetsNow = gatherTargets(ctx);
      for (let i = 0; i < targetsNow.length && target === null; i++) {
        const node = nearestNodeOf(ctx, oe, targetsNow[i]!);
        if (node !== null) {
          want = targetsNow[i]!;
          target = node;
        }
      }
      if (target === null) {
        const any = nearestNodeOf(ctx, oe, -1);
        if (any === null) break;
        want = FOOD;
        target = any;
      }
    }
    const prev = memGet(m.villagerResource, oe.index) - 1;
    if (prev >= 0 && prev < RESOURCE_IDS.length) counts[prev] = counts[prev]! - 1;
    counts[want] = counts[want]! + 1;
    memSet(m.villagerResource, oe.index, want + 1);
    memSet(m.villagerMoveTick, oe.index, ctx.view.tick);
    memSet(m.assignedByResource, want, memGet(m.assignedByResource, want) + 1);
    const bucket = byTarget.get(target);
    if (bucket === undefined) byTarget.set(target, [id]);
    else bucket.push(id);
  }
  // **`Map` の反復順に依存しない**（§0.3）。対象の EntityId 昇順で出す。
  const ids = Array.from(byTarget.keys()).sort((a, b) => a - b);
  const cmds: Command[] = [];
  for (let i = 0; i < ids.length; i++) {
    const t = ids[i]!;
    cmds.push({ t: 'gather', p: ctx.playerId, units: byTarget.get(t)!, target: t as EntityId });
  }
  return cmds;
}

/**
 * **すでに働いている村人の配置換え。**
 *
 * ■ なぜ必要か（実測。ファイル冒頭の表）
 * 元の実装が組み替えるのは**遊休の村人だけ**だった（`planIdleVillagers`）。
 * だから一度食料に就いた村人は、食料が 1,838 余っていても食料を採り続け、
 * 木材は 26 人中 3〜4 人のまま 11 で枯れた。
 * 人間は「木が無い」と気付いたら畑から人を引き抜く。それをここで行う。
 *
 * ■ 誰を動かすか（順序まで固定する。§0.3）
 *  1. **まだ命じていない村人**（開始時の村人）。どこに就いているか記録が無く、
 *     かつ「余っている資源に張り付いている」のはこの人たちなので最初に動かす。
 *  2. 望ましい人数を**超えている資源**に就いている村人（資源の添字昇順、
 *     その中では `ownEntities` の index 昇順）。
 *
 * ■ 動かさない村人
 *  - **運搬中**（`UnitState.Hauling`）。担いだものを搬入させてから動かす
 *    ―― いま動かすと往復ぶんの採集が丸ごと無駄になる。次の判断で拾える。
 *  - 建設中・建設のために借りている村人（建てかけが止まる）。
 *
 * ■ 何人まで動かすか
 * `reassignPerDecision` 人まで（`ai.json`）。全員を一度に動かすと採集が止まり、
 * `gather` コマンドが毎判断ごとに出て APM の上限（60）を食い潰す。
 */
export function planReassignVillagers(ctx: AiContext): Command[] {
  const m = ctx.memory;
  if (m.nodeIds.length === 0) return [];
  const limit = ctx.cfg.reassignPerDecision;
  if (limit <= 0) return [];
  const gatherers = collectGatherers(ctx);
  if (gatherers.length === 0) return [];
  const { counts, unknown, byResource } = currentAssignment(ctx, gatherers);
  const desired = villagerDemandPlan(ctx, gatherers.length);

  /** 動かす候補（上の「誰を動かすか」の順）。 */
  const cands: OwnEntity[] = [];
  for (let k = 0; k < unknown.length; k++) cands.push(unknown[k]!);
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    let surplus = counts[r]! - desired[r]!;
    const list = byResource[r]!;
    for (let k = 0; k < list.length && surplus > 0; k++) {
      cands.push(list[k]!);
      surplus--;
    }
  }

  // **同じ村人を続けて動かさない**（`reassignCooldownSec`）。
  // これが無いと 2 秒ごとに行き先が変わり、1 度も搬入しないまま歩き続ける
  // （実測: 食料の手持ちが 10 分で 423 → 35 に落ちた）。
  const cooldown = ctx.cfg.reassignCooldownSec * TICK_RATE;
  const move: OwnEntity[] = [];
  for (let k = 0; k < cands.length && move.length < limit; k++) {
    const oe = cands[k]!;
    if (oe.state === UnitState.Hauling) continue; // 搬入させてから
    if (oe.state === UnitState.Building) continue;
    if (memGet(m.villagerBusyUntil, oe.index) > ctx.view.tick) continue;
    const last = memGet(m.villagerMoveTick, oe.index);
    if (last > 0 && ctx.view.tick - last < cooldown) continue;
    move.push(oe);
  }
  if (move.length === 0) return [];
  return gatherAssignCommands(ctx, move, counts, desired);
}

/**
 * **いちばん詰まっている資源のそばに搬入点を建てる。**
 *
 * ■ なぜ必要か（実測。段階 4・ローマ・30 分）
 * ```
 * 15分 木ノード 近1691→327 / 全 8384  wood206  農地15
 * 20分 木ノード 近0        / 全 7356  wood3    運搬中:木4
 * 30分 木ノード 近0        / 全 6974  wood3    運搬中:木0
 * ```
 * **拠点のそばの森を伐り尽くしたあと、木材の収入がほぼ 0 になる。**
 * 森はまだ 6,974 も残っているのに、遠すぎて運搬損失が上限（50%）に張り付き、
 * 往復に時間を取られて実質的に採れていない。人間はここで**森のそばに伐採所を建てる**。
 *
 * `reassignForNextAge` が同じことを「次の世の費用に載っている資源」だけに行っていた
 * （黎明→青銅は食料、青銅→鉄器は食料と金）。**木材は一度も対象にならない** ――
 * だから木材だけがこの穴に落ちていた。ここでは「不足額がいちばん大きい資源」で見る。
 *
 * 1 判断で 1 棟だけ。対象は**いちばん近い既知のノード**なので、
 * そこが覆われたら（＝そのノードが枯れて記憶から消えるまで）もう建てない
 * ―― 小屋を延々と建て続けることはない。
 */
export function planDropOffForDemand(ctx: AiContext): Command | null {
  return planDropOff(ctx).cmd;
}

/**
 * 搬入点の判断（`planDropOffForDemand` の中身）。
 *
 * `saving` は「**搬入点を建てたいが、まだ資源が足りない**」状態。
 * このときは家以外の建物を建てない ―― 収入が止まっているのに他のものに使うと、
 * 伐採所の 100 が永久に貯まらない（実測: 木材が 20 前後を上下し続け、
 * 森が 7,000 残っているのに木材を運ぶ村人が 1〜3 人のままだった）。
 * 家だけは例外（30 で安く、人口で詰まるとすべてが止まる）。
 */
function planDropOff(ctx: AiContext): { cmd: Command | null; saving: boolean } {
  const m = ctx.memory;
  const deficits = resourceDeficits(ctx);
  const targets = gatherTargets(ctx);
  // 不足額がいちばん大きい資源（同値は添字の小さい方 = `RESOURCE_IDS` 順で固定）。
  let want = -1;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i]!;
    if (deficits[r]! <= 0) continue;
    if (want < 0 || deficits[r]! > deficits[want]!) want = r;
  }
  const none = { cmd: null, saving: false };
  if (want < 0) return none;
  const camp = dropOffBuildingFor(ctx, want);
  if (camp === null) return none; // 食料は農地が拠点のそばに建つので小屋を持たない
  const tc = findTownCenter(ctx);
  if (tc === null) return none;
  // **搬入点がまだ届いていないノードのうち、拠点からいちばん近いもの**を選ぶ。
  //
  // 「いちばん近いノード」だけを見ていたら、そこに 1 棟建てた時点で
  // 「近くに搬入点がある」と判定され、**残りの 17 か所の森は最後まで裸のまま**だった
  // （木材の累計収入が 15 分以降の 15 分間で 260 しか伸びなかった）。
  // 村人は自分にいちばん近い森へ行くので、覆われていない森があるかぎり
  // 運搬損失が上限に張り付いたままになる。
  const node = nearestUncoveredNodeIndexOf(ctx, tc.x, tc.y, want);
  if (node < 0) return none;
  const nx = m.nodeX[node]!;
  const ny = m.nodeY[node]!;
  const cmd = placeBuildingCommand(ctx, camp, { x: nx, y: ny });
  // 建てたいが払えない → **貯める**（家以外は建てない）。
  return { cmd, saving: cmd === null };
}

/**
 * その村人にいちばん近い資源ノード（`resource` が -1 なら種類を問わない）。
 * 平方距離で比べる（平方根を取らない。§0.3）。
 */
function nearestNodeOf(ctx: AiContext, from: OwnEntity, resource: number): EntityId | null {
  const m = ctx.memory;
  let best: EntityId | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let k = 0; k < m.nodeIds.length; k++) {
    if (resource >= 0 && m.nodeResource[k] !== resource) continue;
    const dx = m.nodeX[k]! - from.x;
    const dy = m.nodeY[k]! - from.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = m.nodeIds[k] as EntityId;
    }
  }
  return best;
}

/**
 * 建てる施設を選ぶときの「足りない資源」。
 * 次の世の費用に足りないものがあればそれを、無ければ手持ちがいちばん少ないものを返す。
 */
export function deficitOrScarcest(ctx: AiContext): number {
  if (!canAffordNextAge(ctx)) return nextAgeDeficitResource(ctx);
  return scarcestResource(ctx.view.own.resources);
}

/**
 * 次の世の費用に対していちばん足りない資源（同値は `RESOURCE_IDS` 順で固定）。
 * 足りないものが無ければ食料（いつでも人口の元になる）。
 */
export function nextAgeDeficitResource(ctx: AiContext): number {
  const age = ctx.view.own.age;
  const next = cfgAges()[age + 1];
  const res = ctx.view.own.resources;
  if (next === undefined) return scarcestResource(res);
  let best = -1;
  let bestDeficit = 0;
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    const need = next.cost[RESOURCE_IDS[r]!] ?? 0;
    if (need <= 0) continue;
    const deficit = need - fxToInt(res[r] ?? 0);
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = r;
    }
  }
  // **次の世の費用が全部足りているなら、手持ちがいちばん少ない資源へ回す。**
  //
  // 以前はここで食料に落としていた。そのせいで食料が 3,206 まで余っているのに
  // 人を食料に足し続け、**木材が 25 まで枯れて青銅の世の建物（木材 150〜175）が
  // 建てられず、進化の建物条件（いまの世の建物 2 種）を満たせなかった**。
  // 足りているものをさらに採る意味はない。
  return best < 0 ? scarcestResource(res) : best;
}

/**
 * 世が変わって必要になった資源に、**既にいる採集係を移す**。
 *
 * `gather` は新しくできた村人にしか出していないので、村人を出し切ったあとに
 * 世が上がると、新しく要求される資源（鉄器なら金）に誰も就かないまま終わる。
 *
 * 移すのは **1 判断につき 1 人まで**（全員を一度に動かすと採集が止まる）。
 * 誰を動かすかは `ownEntities` の index 昇順で最初に見つかった採集係
 * ―― 乱数を使わないので全端末で同じ村人が動く。
 */
export function reassignForNextAge(ctx: AiContext): Command[] {
  const m = ctx.memory;
  // **「まだ誰も就いていない、次の世に必要な資源」**を探す。
  //
  // ここを「いちばん足りない資源」にしていたら、食料の不足が常に最大になって
  // **金にいつまでも人が就かず、鉄器の世（金 200）に永久に届かなかった**。
  // 以前この形にしたときは村人が単独で遠くの金鉱へ歩いて死んだが、
  // それは搬入点を建てる前に送っていたからで、下で先に小屋を建てるようにした。
  // 見るのは **`cfgAges` の「次の世の費用」に載っている資源だけ**。
  // `gatherTargets`（食料と木材を常に含む）で見ると、拠点のそばで足りている
  // 木材のために遠くへ小屋を建てに行ってしまい、青銅の到達がかえって遅れた（実測）。
  let need = -1;
  for (const r of nextAgeCostResources(ctx)) {
    if (memGet(m.assignedByResource, r) === 0) {
      need = r;
      break;
    }
  }
  if (need < 0) return [];
  if (!knowsResource(ctx, need)) return []; // 場所を知らないなら探索の仕事

  // いちばん近いその資源のノード（拠点から見て）。
  const tc = findTownCenter(ctx);
  if (tc === null) return [];
  const node = nearestNodeIndexOf(ctx, tc.x, tc.y, need);
  if (node < 0) return [];
  const nx = m.nodeX[node]!;
  const ny = m.nodeY[node]!;

  // **搬入点が近くに無ければ、まずそれを建てる。**
  //
  // 以前は村人をそのまま送っていた。すると**単独で遠くの金鉱まで歩いて死に**、
  // 村人が 26 → 10、食料が 411 → 12 に落ちた（実測）。
  // 運んだものを置く場所が無ければ、着いても拠点まで往復するだけで
  // 運搬損失が上限に張り付く。順序は「搬入点 → 村人」でなければ意味がない。
  if (!hasDropOffNear(ctx, nx, ny)) {
    const camp = dropOffBuildingFor(ctx, need);
    if (camp === null) return [];
    const cmd = placeBuildingCommand(ctx, camp, { x: nx, y: ny });
    return cmd === null ? [] : [cmd];
  }

  // 搬入点がある。**そこで初めて村人を送る**（1 判断につき 1 人）。
  const villagerType = unitDefById(VILLAGER_ID).index;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    if (memGet(m.villagerRole, oe.index) !== VILLAGER_GATHERER) continue;
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    memSet(m.assignedByResource, need, 1);
    return [{ t: 'gather', p: ctx.playerId, units: [id], target: m.nodeIds[node] as EntityId }];
  }
  return [];
}

/**
 * 農地などを建てたあとも「進化用の建物 1 棟ぶん」の木材が残るか。
 *
 * 進化の建物条件（`requireBuildingsOfPrevAge`）を満たすには、いまの世の建物を
 * 建てる必要がある。その木材まで農地に使ってしまうと進化そのものが止まる。
 */
function hasWoodForAgeGate(ctx: AiContext, cost: Int32Array): boolean {
  const gate = pickAgeGateBuilding(ctx);
  if (gate === null) return true; // 建物条件は満たしている
  const wood = RESOURCE_IDS.indexOf('wood');
  const need = (cost[wood] ?? 0) + buildingDefById(gate).cost[wood]!;
  return (ctx.view.own.resources[wood] ?? 0) >= need;
}

/**
 * 次の世に上がるために足りない「いまの世の建物」を 1 つ選ぶ（足りていなければ null）。
 *
 * `03§2` の進化条件は「前の世の建物 N 種」。AI は費用（食料・金）だけを見ていたので、
 * 条件を満たさないまま貯め続けることがあった。**安いものから建てる**
 * （進化のためだけに建てるので、高い軍事建物を選ぶ理由がない）。
 */
function pickAgeGateBuilding(ctx: AiContext): string | null {
  const age = ctx.view.own.age;
  const next = cfgAges()[age + 1];
  if (next === undefined) return null;
  const needKinds = next.requireBuildingsOfPrevAge;
  if (needKinds <= 0) return null;

  // いま持っている「この世の建物」の種類数（完成済みだけ数えるのは sim と同じ）。
  const civ = ctx.view.own.civ as CivId;
  const owned = new Set<number>();
  for (const oe of ctx.view.ownEntities) {
    if (oe.kind !== EntityKind.Building || !oe.complete) continue;
    const def = buildingDef(oe.typeId);
    if (def.age === age) owned.add(def.index);
  }
  if (owned.size >= needKinds) return null;

  // この世で建てられる建物のうち、まだ持っていないものを**安い順**に。
  //
  // ただし **兵の生産元を先に見る**（同じ 1 棟を建てるなら生産元のほうが常に得）。
  // 実測では鍛冶場（木材 150）が「いちばん安い」ので選ばれ続けたが、
  // 鍛冶場は研究しかできない ―― 青銅の世に上がっているのに
  // **生産元が 0 棟で、黎明の棍棒兵と狩人しか作れなかった**（ファイル冒頭の表）。
  // 兵舎・射場は 175 で 25 だけ高いが、それは家 1 棟にも足りない差額で、
  // 見返りは「青銅以降の兵が作れるようになる」こと。
  const producer = missingProducerBuilding(ctx, ctx.view.own.age);
  const candidates: { id: string; cost: number; isProducer: number; shortfall: number }[] = [];
  for (const def of BUILDING_DEFS) {
    if (def.age !== age) continue;
    if (owned.has(def.index)) continue;
    const resolved = resolveBuildingForCiv(civ, def.id);
    if (resolved === null || !canCivBuild(civ, resolved)) continue;
    const rdef = buildingDefById(resolved);
    if (rdef.age !== age || owned.has(rdef.index)) continue;
    // 壁や門は「種類」としては数えられるが、進化のために建てるものではない
    // （`kind` が normal でないものは除く）。
    if (rdef.kind !== 'normal') continue;
    let total = 0;
    for (let r = 0; r < rdef.cost.length; r++) total += rdef.cost[r]!;
    // **あと何を採れば建てられるか**（不足額の合計）。0 ならいま建てられる。
    // 予備の家 1 棟ぶんも数に入れる ―― `placeBuildingCommand` が同じ条件で弾くので、
    // ここで揃えておかないと「選んだのに永久に着工できない」が起きる。
    const need = withHouseReserve(rdef.cost);
    const have = ctx.view.own.resources;
    let shortfall = 0;
    for (let r = 0; r < need.length; r++) {
      const d = need[r]! - (have[r] ?? 0);
      if (d > 0) shortfall += d;
    }
    candidates.push({
      id: resolved,
      cost: total,
      isProducer: resolved === producer ? 0 : 1,
      shortfall,
    });
  }
  if (candidates.length === 0) return null;
  // 生産元 → **いちばん早く建てられるもの**（不足額の合計） → 安い順 → ID 昇順
  // （全順序。乱数を使わない。§0.3）。
  //
  // ■ なぜ「安い順」ではなく「不足額の合計」なのか（実測。時代が止まる最後の 1 件）
  // 合計額で選ぶと、ヤマトとヴァイキングは鍛冶場（木材 150）を選び続けた。
  // ところが手持ちは **木材 9・石材 100**。木材の収入は拠点のそばの森が尽きたあと
  // ほとんど無いので、150 には永久に届かない。同じ「1 種」を満たせる
  // 櫓（木材 25 + 石材 125）なら**あと石材 25 と木材 16**で建つのに、
  // 合計額が同じ 150 で ID 順に負けるため一度も選ばれず、
  // 30 分間ずっと建物の種が 1 のままだった（＝食料 843・金 193 を貯めても鉄器に上がれない）。
  // 人間は「あと少しで建てられる方」を建てる。安さより先にこれを見る。
  //
  // ■ 生産元より「早く建てられること」を先にした（実測。最後の 1 席がこれで直った）
  // 生産元を先に見ると、ローマは射場を 2 棟持っている状態で
  // **兵舎（木材 175 + 予備 30）を待ち続けた**（手持ち木材 36）。
  // 建物の「種」は同じ射場 2 棟では 1 種にしかならないので、
  // あと木材 19 + 石材 25 で建つ望楼を選べば済む場面だった
  // （実測で 30 分ずっと種 1・食料 839・金 198 のまま鉄器に届かなかった）。
  // 生産元は `militaryGoals.planMilitaryBuilding` が別に建てるので、
  // 進化条件はここでは「早さ」で選ぶのが正しい。
  candidates.sort((a, b) =>
    a.shortfall !== b.shortfall
      ? a.shortfall - b.shortfall
      : a.isProducer !== b.isProducer
        ? a.isProducer - b.isProducer
        : a.cost !== b.cost
          ? a.cost - b.cost
          : a.id < b.id
            ? -1
            : 1,
  );
  return candidates[0]!.id;
}

/**
 * 遊んでいる村人を採集に戻す。
 *
 * ■ なぜ必要か（実測）
 * 採集していたノードが枯れると `sim`（`economy.ts` の `seekSameResource`）が
 * 同じ資源の次のノードを探すが、見つからなければ `Idle` で止まる。
 * その後 AI は何もしていなかったので、**村人 22 人のうち 14 人が遊休**のまま
 * 30 分が終わっていた（食料ノードは 10,880 残っていた）。
 * 人間はこれを `.`（遊休村人へジャンプ）で見つけて就かせ直す（`06§5`）。
 *
 * ■ 何人まで戻すか
 * **1 判断につき `IDLE_REASSIGN_PER_DECISION` 人まで**。
 * 全員に一度に命令を出すと、同じノードへ殺到して往復が詰まる。
 * 就かせる先は**需要にもとづく割り当て**（`villagerDemandPlan`）。
 * 以前は「`gatherTargets` を順番に」だったが、それは詰まりを見ていない
 * ―― 食料が 1,838 余っていても順番が来れば食料に就かせていた。
 */
export function planIdleVillagers(ctx: AiContext): Command[] {
  const m = ctx.memory;
  if (m.nodeIds.length === 0) return [];
  const gatherers = collectGatherers(ctx);
  const { counts } = currentAssignment(ctx, gatherers);
  const desired = villagerDemandPlan(ctx, gatherers.length);
  const villagerType = unitDefById(VILLAGER_ID).index;
  const list = ctx.view.ownEntities;

  const idle: OwnEntity[] = [];
  for (let k = 0; k < list.length && idle.length < IDLE_REASSIGN_PER_DECISION; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit || oe.typeId !== villagerType) continue;
    if (oe.state !== UnitState.Idle) continue;
    // 建設のために借りている村人は放っておく（建てかけが止まる）
    if (memGet(m.villagerBusyUntil, oe.index) > ctx.view.tick) continue;
    idle.push(oe);
  }
  if (idle.length === 0) return [];
  memSet(m.idleAssignSeq, 0, memGet(m.idleAssignSeq, 0) + idle.length);
  // **同じノードへ行く村人は 1 つの命令にまとめる**（`gatherAssignCommands` が束ねる）。
  // 人間なら「遊休の村人をまとめて選んで資源をクリック」＝ 1 操作なので、
  // 1 人ずつコマンドを出すと操作量（APM）を過大に数えることになる
  // （実測で APM が 86.5 まで上がり、`01`「手数で勝たない」の 60 を超えた）。
  return gatherAssignCommands(ctx, idle, counts, desired);
}


/**
 * その建物が「いま採っている資源の搬入点」か。搬入点でない建物（家・農地・市場）は常に true。
 *
 * `gatherTargets`（次の世が要求する資源 + 食料 + 木材）に対応する小屋だけを許す。
 * 黎明の世では石材も金も使い道が無いので、採掘場は建てない。
 */
function isNeededDropOff(ctx: AiContext, buildingId: string): boolean {
  let resource = -1;
  for (const [r, id] of Object.entries(DROP_OFF_BY_RESOURCE)) {
    if (id === buildingId) {
      resource = Number(r);
      break;
    }
  }
  if (resource < 0) return true; // 搬入点ではない
  return gatherTargets(ctx).includes(resource);
}

/**
 * 次の世の費用に載っている資源（`RESOURCE_IDS` の添字。昇順）。
 * 最終世・上げない段階では空。
 */
function nextAgeCostResources(ctx: AiContext): number[] {
  const next = cfgAges()[ctx.view.own.age + 1];
  if (next === undefined) return [];
  const out: number[] = [];
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    if ((next.cost[RESOURCE_IDS[r]!] ?? 0) > 0) out.push(r);
  }
  return out;
}

/** 記憶の中でその資源のいちばん近いノードの添字（無ければ -1）。 */
function nearestNodeIndexOf(ctx: AiContext, fromX: Fx, fromY: Fx, resource: number): number {
  const m = ctx.memory;
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let k = 0; k < m.nodeIds.length; k++) {
    if (m.nodeResource[k] !== resource) continue;
    const dx = m.nodeX[k]! - fromX;
    const dy = m.nodeY[k]! - fromY;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/**
 * その資源のノードのうち、**搬入点が届いていない**もので拠点にいちばん近いものの添字。
 * 平方距離で比べ、同距離なら記憶の発見順（先勝ち）＝ 全順序（§0.3）。
 */
function nearestUncoveredNodeIndexOf(
  ctx: AiContext,
  fromX: Fx,
  fromY: Fx,
  resource: number,
): number {
  const m = ctx.memory;
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  // **遠すぎる採り場には建てない。**
  // `NEAR_SITE_MAX_TILES`（運搬損失が上限に達する距離）より遠い森に伐採所を建てても、
  // 村人の往復が長すぎて実入りが無い ―― 実測で遠い森に伐採所を 3 棟・採掘場を 2 棟
  // （木材 500）建てたが、木材の累計収入は 10 分で +10 しか増えず、
  // そのぶん生産元が 2 棟 → 1 棟に減った。
  const maxD = NEAR_SITE_MAX_TILES * FX_ONE;
  for (let k = 0; k < m.nodeIds.length; k++) {
    if (m.nodeResource[k] !== resource) continue;
    if (hasDropOffWithin(ctx, m.nodeX[k]!, m.nodeY[k]!, DROP_OFF_WANT_TILES)) continue;
    {
      const ddx = m.nodeX[k]! - fromX;
      const ddy = m.nodeY[k]! - fromY;
      if (ddx * ddx + ddy * ddy > maxD * maxD) continue;
    }
    const dx = m.nodeX[k]! - fromX;
    const dy = m.nodeY[k]! - fromY;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** その座標のそばに自軍の搬入点（町の中心・伐採所・採掘場）があるか。 */
function hasDropOffNear(ctx: AiContext, x: Fx, y: Fx): boolean {
  return hasDropOffWithin(ctx, x, y, NEAR_SITE_MAX_TILES);
}

/** その座標から `tiles` マス以内に自軍の搬入点があるか（平方距離で比べる。§0.3）。 */
function hasDropOffWithin(ctx: AiContext, x: Fx, y: Fx, tiles: number): boolean {
  const reach = tiles * FX_ONE;
  const list = ctx.view.ownEntities;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Building) continue;
    if (!buildingDef(oe.typeId).isDropOff) continue;
    const dx = oe.x - x;
    const dy = oe.y - y;
    if (dx * dx + dy * dy <= reach * reach) return true;
  }
  return false;
}

/**
 * その資源を運び込む小屋の ID（無ければ null）。
 * `buildings.json` の `isDropOff` を持つ建物から、その資源に対応するものを選ぶ。
 */
function dropOffBuildingFor(ctx: AiContext, resource: number): string | null {
  const civ = ctx.view.own.civ as CivId;
  const id = DROP_OFF_BY_RESOURCE[resource];
  if (id === undefined) return null;
  const resolved = resolveBuildingForCiv(civ, id);
  if (resolved === null || !canCivBuild(civ, resolved)) return null;
  if (buildingDefById(resolved).age > ctx.view.own.age) return null;
  return resolved;
}

/**
 * いま人を就かせる価値がある資源（`RESOURCE_IDS` の添字。昇順）。
 *
 *  - **次の世が要求する資源**（これが無いと世が上がらない）
 *  - **食料**（人口の元。常に要る）
 *  - **木材**（家と資源施設の元。常に要る）
 *
 * 石材と金は「次の世が要求するとき」だけ入る。使い道が無いのに採らせると、
 * その村人ぶんの食料を捨てているのと同じになる（実測で石材 800・金 599 が
 * 使われずに余り、そのぶん青銅の世が 25 分まで遅れていた）。
 */
export function gatherTargets(ctx: AiContext): number[] {
  const want = new Set<number>([FOOD, WOOD]);
  const next = cfgAges()[ctx.view.own.age + 1];
  if (next !== undefined) {
    for (const resId of Object.keys(next.cost)) {
      const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
      if (r >= 0) want.add(r);
    }
  }
  // **進化条件の建物に足りない資源も採る。**
  //
  // ■ なぜ必要か（実測。時代が止まる最後の 1 件）
  // 進化には「いまの世の建物 2 種」が要る。ヴァイキングとヤマトはこうなっていた:
  // ```
  // 30分 時代1 食料843 金193 木材9 石材100 → 建物の種1（30 分間ずっと）
  // ```
  // 候補は鍛冶場（木材 150）と櫓（木材 25 + 石材 125）だけで、
  // 木材 9 では前者に永久に届かず、後者は**石材があと 25 足りない**。
  // ところが石材は「次の世の費用に載っていない」ので採る対象に入らず、
  // **誰も 25 を採りに行かないまま試合が終わっていた**。
  // 石材は拠点のそばにあって採るのは速い ―― 人間なら 1 人送って終わる話。
  //
  // ここに入れるだけで人数が付くわけではない（人数は不足額で決まる）が、
  // 対象に入っていなければ 0 人のままなので、この 1 行が要る。
  {
    const gate = pickAgeGateBuilding(ctx);
    if (gate !== null) {
      const cost = buildingDefById(gate).cost;
      const have = ctx.view.own.resources;
      for (let r = 0; r < RESOURCE_IDS.length; r++) {
        if (cost[r]! > 0 && (have[r] ?? 0) < cost[r]!) want.add(r);
      }
    }
  }
  // **`Set` の反復順に依存しない**（§0.3）。添字昇順に並べ直す。
  const out: number[] = [];
  for (let r = 0; r < RESOURCE_IDS.length; r++) if (want.has(r)) out.push(r);
  return out;
}

/** 記憶にその資源のノードがあるか（探索を続けるかの判断に使う）。 */
export function knowsResource(ctx: AiContext, resource: number): boolean {
  const m = ctx.memory;
  for (let k = 0; k < m.nodeResource.length; k++) {
    if (m.nodeResource[k] === resource) return true;
  }
  return false;
}

/**
 * 時代進化（`03§2`）。`allowAdvanceAge` の段階だけ。
 * 前提（前の世の建物 2 種・資源・研究中でない）の判定は `sim` 側が持っているので、
 * ここでは「最終時代でなければ町の中心に出す」だけ。通らなければ黙って捨てられる。
 */
/** 次の世の費用が手元にあるか（無ければ貯める）。最終世なら true（貯める必要が無い）。 */
/**
 * 次の世のために取り置く額（資源 index 順の Fx）。上げない段階と最終世は 0。
 *
 * ■ なぜ取り置くのか
 * 兵は食料を食う。取り置かないと**入った食料が全部兵に変わって永久に世が上がらない**。
 * 実測（段階 4・30 分）で兵が 26 体まで育つ一方、食料は 0〜19 に張り付き、
 * 青銅の世の 500 に一度も届かなかった。石材 500・金 410 は誰も使わずに余っていた。
 *
 * 人間も「次の世のぶんは手を付けない」と決めて兵を出すので、これは自然な形。
 */
export function ageReserveFx(ctx: AiContext): Int32Array {
  const out = new Int32Array(RESOURCE_IDS.length);
  if (!ctx.cfg.allowAdvanceAge) return out;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return out;
  const next = cfgAges()[age + 1];
  if (next === undefined) return out;
  // 最初の世（黎明 → 青銅）は**全額**取り置く。青銅で兵種ツリーが枝分かれするので、
  // ここに上がらないと文明の違いが盤に出ない。
  // 2 つ目以降は割合ぶんだけ（全額のままだと兵が 1 体も出ないまま試合が終わる）。
  //
  // ■ ただし「**上がる直前は貯め切る**」（`ageFinishFromPercent`）
  //
  // 割合を 0.5 のまま固定すると、兵が「取り置きを超えたぶん」を毎回食べるので
  // 手持ちが取り置きの額に張り付く。実測（段階 4・3 組・30 分）で
  // 食料が 400〜520・金が 89〜170 で頭打ちになり、鉄器の世（食料 800・金 200）に
  // **3 組すべてが 30 分間一度も届かなかった**。
  // 逆に常に全額取り置くと今度は兵が細り（30 分で 4〜9 体）、
  // 拠点を殴る手が無くなってこれも決着しない。
  //
  // 人間は「もう少しで上がれる」ところまで来たら**兵を止めて貯め切る**。
  // だから、費用のうち**すでに手元にある割合**がしきい値を超えたら全額取り置きに切り替える。
  // 序盤は半分だけ取り置いて兵を出し続け、山場だけ一気に貯める形になる。
  const finishing = isFinishingAge(ctx, next.cost);
  const ratio = fx(
    age === 0 || finishing ? ctx.cfg.ageReserveRatioFirst : ctx.cfg.ageReserveRatioAfterFirst,
  );
  for (const [resId, amount] of Object.entries(next.cost)) {
    const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
    if (r >= 0) out[r] = fxMul(fx(amount), ratio);
  }
  return out;
}

/**
 * 次の世の費用のうち、**すでに手元にある割合**が `ageFinishFromPercent` 以上か
 * （＝「もう少しで上がれる」局面か）。
 *
 * 数え方は「資源ごとに `min(手持ち, 費用)` を足して、費用の合計と比べる」。
 * `min` を取るのは、余っている食料で足りない金を埋めた気にならないため
 * （実測で食料 1,838・金 89 という偏りが起きる。合計だけ見ると「足りている」に見える）。
 * 整数比較のみ（百分率を掛けてから比べる。割り算を通さないので誤差が出ない）。
 */
function isFinishingAge(ctx: AiContext, cost: Readonly<Record<string, number>>): boolean {
  const pct = ctx.cfg.ageFinishFromPercent;
  if (pct <= 0) return false;
  const res = ctx.view.own.resources;
  let have = 0;
  let need = 0;
  for (const [resId, amount] of Object.entries(cost)) {
    const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
    if (r < 0 || amount <= 0) continue;
    const want = fx(amount);
    const got = res[r] ?? 0;
    have += got < want ? got : want;
    need += want;
  }
  if (need <= 0) return false;
  return have * 100 >= need * pct;
}

/**
 * 「次の世のぶんを取り置いたうえで」その費用を払えるか。
 * 世を上げない段階では取り置きが 0 なので `canAfford` と同じ。
 */
export function canAffordWithAgeReserve(
  ctx: AiContext,
  cost: Int32Array | readonly number[],
): boolean {
  const reserve = ageReserveFx(ctx);
  const res = ctx.view.own.resources;
  for (let r = 0; r < res.length; r++) {
    // **取り置きは 0 で止める。**
    // 引き算のままにすると「取り置き > 手持ち」のとき残りが負になり、
    // **その資源を 1 も使わない兵まで作れなくなる**（実測: 金 50 に対し取り置き 100 で
    // 食料だけの兵も出せず、30 分で兵 0 体だった）。
    const usable = (res[r] ?? 0) - (reserve[r] ?? 0);
    if ((usable > 0 ? usable : 0) < (cost[r] ?? 0)) return false;
  }
  return true;
}

export function canAffordNextAge(ctx: AiContext): boolean {
  if (!ctx.cfg.allowAdvanceAge) return true;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return true;
  const next = cfgAges()[age + 1];
  if (next === undefined) return true;
  const res = ctx.view.own.resources;
  for (const [resId, amount] of Object.entries(next.cost)) {
    const r = RESOURCE_IDS.indexOf(resId as (typeof RESOURCE_IDS)[number]);
    if (r < 0) continue;
    if (fxToInt(res[r] ?? 0) < amount) return false;
  }
  return true;
}

export function planAgeAdvance(ctx: AiContext): Command | null {
  if (!ctx.cfg.allowAdvanceAge) return null;
  const age = ctx.view.own.age;
  if (age >= AGE_IDS.length - 1) return null;
  const tc = findTownCenter(ctx);
  if (tc === null) return null;
  // **資源が足りているときだけ出す。**
  //
  // 以前はここで毎回出していた。`sim` 側は足りなければ黙って捨てるので
  // 動作としては正しく見えるが、実測で**全コマンドの 96〜97% がこの空打ち**になり、
  // 操作量（APM）の計測が意味を失っていた（段階 5 で APM 62 のうち有効な操作は 2 件）。
  // 「出せないなら出さない」は人間の操作でも同じ（UI はボタンを暗くする。`05§4`）。
  if (!canAffordNextAge(ctx)) return null;
  // **建物条件（いまの世の建物 2 種）が満たされていないときも出さない。**
  //
  // `canAdvanceAge`（`sim/systems/production.ts`）は資源のほかに
  // `requireBuildingsOfPrevAge` を見ているので、条件が欠けていると黙って捨てられる。
  // 実測では費用（食料 802・金 218）を満たしたあと**建物の種が 1 しか無く**、
  // 30 分のあいだ `advanceAge` を **163〜336 回**空打ちしていた。
  // 空打ちは APM（`07§11` の 60）を食うだけで何も進まない ―― 人間の UI も
  // 条件が欠けていればボタンを暗くする（`05§4`）。
  // `pickAgeGateBuilding` が `null` = 「建てるべき建物はもう無い」＝ 条件は満たしている。
  if (pickAgeGateBuilding(ctx) !== null) return null;
  return { t: 'advanceAge', p: ctx.playerId, building: ctx.idOf(tc.index) };
}

// ---------------------------------------------------------------- 市場

/**
 * 資源の偏りへの対処（`07§8`）。
 * 金が `economy.marketPriceUnitStep` 単位以上あり、いちばん足りない資源が
 * それより少ないなら、金を売って足りない資源を `economy.carryCapacity` 単位買う。
 * 市場が無ければ `sim` 側が黙って捨てる。
 */
export function planMarketTrade(ctx: AiContext): Command | null {
  const res = ctx.view.own.resources;
  // **次の世の費用を売り払わない。**
  // 鉄器の世は金 200 を要求するが、以前はここで金を売り続けて
  // 金が 90〜100 に張り付き、永久に届かなかった（実測で交換 133 回）。
  // 貯めている最中に貯めているものを手放すのは、どんな相場でも損。
  if (!canAffordNextAge(ctx)) return null;

  // ■ 「余っているもので、詰まっているものを買う」（実測で作り直した）
  //
  // 元は「金が余っていたら、手持ちがいちばん少ない資源を買う」だけだった。
  // ところが実際に詰まる形はこれで、30 分間ずっと同じだった:
  // ```
  // 25分 時代2 食料1,496 木材 31   → 攻城工房（木材 200）が建てられない
  // 30分 時代2 食料1,730 木材 12   → 30 分の着工試行に工房が一度も出てこない
  // ```
  // **食料が余って木材が枯れている。** 拠点のそばの森が尽きたあと木材の収入は
  // 距離の壁で伸びないので、余った食料を木材に変えるのが唯一の手になる。
  // 市場は**金を介した交換しかしない**（`07§8` / `command.ts`）ので 2 手に分ける:
  //   1. 余っている資源を売って金にする
  //   2. その金で詰まっている資源を買う
  // 1 判断で 1 手だけ出す（APM を無駄にしない。次の判断で続きをやる）。
  const deficits = resourceDeficits(ctx);
  // 買いたいもの: 不足額がいちばん大きい資源（金は「介するもの」なので除く）。
  let want = -1;
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    if (r === GOLD || deficits[r]! <= 0) continue;
    if (want < 0 || deficits[r]! > deficits[want]!) want = r;
  }
  if (want < 0) return null;

  // 2) 金が `marketSurplusUnits` 以上あるなら買う（先にこちらを見る ―― 売って貯めた金を
  //    使い切らないと、金だけが積み上がって詰まりが解けない）。
  const surplusUnits = ctx.cfg.marketSurplusUnits;
  if (fxToInt(res[GOLD]!) >= surplusUnits) {
    return {
      t: 'marketTrade',
      p: ctx.playerId,
      sell: RESOURCE_IDS[GOLD]!,
      buy: RESOURCE_IDS[want]!,
      amount: TRADE_UNIT,
    };
  }

  // 1) 売るもの: **必要額を超えて余っている**資源のうち、余りがいちばん大きいもの。
  //    「手持ちが多い」ではなく「必要額を超えている」で見る ―― 次の世の費用や
  //    建てたい建物のぶんを売り払ってはいけない（`resourceDeficits` の必要額）。
  let give = -1;
  let bestSurplus = 0;
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    if (r === GOLD || r === want) continue;
    if (deficits[r]! > 0) continue; // 足りていないものは売らない
    const surplus = fxToInt(res[r]!) - surplusUnits;
    if (surplus <= 0) continue;
    if (give < 0 || surplus > bestSurplus) {
      give = r;
      bestSurplus = surplus;
    }
  }
  if (give < 0) return null;
  return {
    t: 'marketTrade',
    p: ctx.playerId,
    sell: RESOURCE_IDS[give]!,
    buy: RESOURCE_IDS[GOLD]!,
    amount: TRADE_UNIT,
  };
}

// ---------------------------------------------------------------- 補助

/**
 * その建物に生産を命じてよいか（**前に頼んだ 1 体ができあがっているか**）。
 *
 * `AiView` に待ち行列が入っていないので、**自分が命じた tick の記録**で代わりにする
 * （盤面ではなく自分の操作の記憶なのでズルにならない ―― `AiMemory.produceTick`）。
 * 呼んだ側は「命じる」と決めたときに `markProduce` を呼ぶこと。
 *
 * これが無いと判断間隔の速い段階ほど同じ 1 体を何度も注文してしまい、
 * **判断が速いほど弱くなる**（段階 5 が段階 4 に負ける）。詳しくは `produceTick` の注記。
 */
export function canQueueProduce(
  ctx: AiContext,
  buildingIndex: number,
  buildTicks: number,
  /** 兵の注文か（村人と別枠で数える。`AiMemory.armyProduceTick` の注記）。 */
  army = false,
): boolean {
  const last = memGet(army ? ctx.memory.armyProduceTick : ctx.memory.produceTick, buildingIndex);
  if (last <= 0) return true;
  return ctx.view.tick - last >= buildTicks;
}

/** 生産を命じたことを記録する（`canQueueProduce` と対で使う）。 */
export function markProduce(ctx: AiContext, buildingIndex: number, army = false): void {
  memSet(army ? ctx.memory.armyProduceTick : ctx.memory.produceTick, buildingIndex, ctx.view.tick);
}

/** 手持ち（Fx）でコスト（Fx）を払えるか。修飾子は AI からは見えないので基礎コストで見積もる。 */
export function canAfford(have: readonly number[], cost: Int32Array | readonly number[]): boolean {
  for (let r = 0; r < have.length; r++) {
    const c = cost[r] ?? 0;
    if (have[r]! < c) return false;
  }
  return true;
}
