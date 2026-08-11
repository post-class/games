/**
 * ai/AiPlayer.ts — AI の本体（T-M13-01 / T-M13-05。実装手順書 §10、`07§11`）
 *
 * ■ 何をするクラスか
 * `think(w)` を毎 tick 呼ぶと、**判断間隔の tick だけ** `Command[]` を返す。
 * 間隔外の tick では空配列を返す（配列を作らないよう定数を返す）。
 *
 * ■ ズルをしない仕組み（`07§11`「難易度を上げてもズルはしません」）
 *  - 盤面の情報は `createAiView(w, playerId)` の戻り値からしか読まない。
 *    `world.players` / `world.fronts` / 敵の資源・研究・時代は**そもそも渡ってこない**。
 *  - `World` から直接使うのは **`rngAi`（AI 専用の乱数ストリーム）だけ**。
 *    `rngCombat` / `rngMap` は触らない（AI の乱数消費が戦闘結果を変えないため。手順書 §4.3）。
 *  - World を書き換えない。出せるのは `Command` だけ（`07§11`「AI も令を通じて部隊を動かします」）。
 *  - 難易度で変わるのは `ai.json` の **判断間隔と使える仕組みの範囲だけ**。
 *    視界・資源・令の遅延・切り替え間隔には一切手を加えない。
 *
 * ■ 唯一の例外（申し送り）: index → EntityId の翻訳
 * `Command` は対象を `EntityId`（generation + index）で名指しする。ところが
 * `AiView.OwnEntity` は `index` しか持たないため、**自軍の index を EntityId に
 * 直す手段が視界の中に無い**。そこで `buildOwnIdTable` だけが
 * `w.entities.generation` を読む。読むのは
 *   「視界に入っている**自軍**エンティティの世代番号」だけ
 * で、盤面の情報（敵・他人の資源）は 1 bit も増えない ―― 名前を引く辞書にすぎない。
 * 恒久対策は `AiView.OwnEntity` に `id: EntityId` を足すこと（`view.ts` は担当外）。
 *
 * ■ 決定論
 *  - 判断のタイミングは `(tick + playerId) % intervalTicks === 0`。**乱数を使わない**
 *    （プレイヤーごとに位相をずらすのは、同 tick に 8 人ぶんの判断が重なるのを避けるため）。
 *  - 反復は必ず index 昇順。浮動小数を状態に持たない（比較・重みは Fx か整数）。
 *  - AI の内部記憶（誰にどの仕事を与えたか）は **index を添字にした配列**で持つ。
 *    `Map` / `Set` の反復順に依存しない（§0.3）。
 */

import aiJson from '@/data/ai.json' with { type: 'json' };

import type { EntityId, PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE } from '@/sim/core/config';
import { makeEntityId } from '@/sim/core/entity';
import type { Rng } from '@/sim/core/rng';
import type { World } from '@/sim/core/world';

import type { AiView } from './view';
import { createAiView } from './view';
import { planScouting } from './scoutGoals';
import { planEconomy } from './econGoals';
import { planMilitary } from './militaryGoals';
import { planFronts } from './frontPolicy';

// ---------------------------------------------------------------- 段階の設定

/** `ai.json` の 1 段階（数値はすべて JSON 由来。コードに書かない）。 */
export interface AiLevelConfig {
  /** `ai.json` のキー（`shirouto` など）。 */
  readonly key: string;
  /** 1..5。 */
  readonly level: number;
  readonly name: string;
  /** 判断間隔（tick）。8/6/4/2/1 秒 → 200/150/100/50/25 tick。 */
  readonly intervalTicks: number;
  /** 使える令 ID。ここに無い令は出さない。 */
  readonly usableOrders: readonly string[];
  /** 立てる戦域の上限（0 = 攻めない）。 */
  readonly maxFronts: number;
  /** 立てたい戦域の下限（`ai.json` に無ければ 0）。 */
  readonly minFronts: number;
  readonly allowDoubleFlag: boolean;
  readonly allowUniqueOrders: boolean;
  readonly allowSiege: boolean;
  /**
   * 見えている敵の建物が「兵の構成比」に足せる重みの上限（棟数）。
   *
   * `config.json` の `counterMatrix` は `siege → building: good` と定めているので、
   * 敵の建物を `building` の役割の重みに足すだけで**攻城の需要がデータから立つ**
   * （攻城のための特別扱いをコードに書かなくてよい）。
   * 上限を置くのは、拠点に近づくと建物が 10 棟以上見えて攻城に寄りすぎるため。
   * 攻城を使わない段階（1〜4。`07§11` の段階表で攻城は段階 5 のみ）でも
   * 「剣は建物に強い」（`sword → building: good`）が効くので 0 にはしない。
   */
  readonly enemyBuildingWeightMax: number;
  readonly allowDecoy: boolean;
  readonly allowAdvanceAge: boolean;
  /**
   * 建設用に残しておく村人の数。**これを超えた村人は採集に就ける**。
   *
   * ここが無いと、生産された村人が全員「建設係」のまま手空きで立ち続ける
   * （実測: 30 分で石材・金の採集量が 0、食料も設計値の 1/20 だった）。
   */
  readonly villagerBuilderCount: number;
  /**
   * 人口の余裕がこの人数以下になったら家を建てる（`population.housePop` = 5 より広く取る）。
   *
   * ■ なぜ設定値にしたか（実測。段階 4・ローマ 対 ヤマト・30 分）
   * ```
   * 15分 時代1 兵9  村26 人口35/40 家6 生産元0 wood10
   * 30分 時代1 兵12 村26 人口38/40 家6 生産元0 wood11
   * ```
   * **家が 6 棟で止まり、人口上限 40 に張り付いた**まま 15 分が過ぎている。
   * 人口が増えないので村人も兵も増えない。上限に当たってから建て始めると、
   * 家 1 棟（20 秒前後）のあいだ生産が完全に止まるので、
   * **余裕がまだあるうちに建て始める**必要がある。段階が上ほど先読みを広く取る。
   */
  readonly houseHeadroomPop: number;
  /**
   * 資源の不足額を数えるときに見込む家の棟数。
   *
   * 家は「建てたいもの」の中でいちばん途切れてはいけないものなので、
   * 1 棟ぶんだけ見込むと採集の割り当てが家を建てた直後に木材から離れてしまう。
   * 数棟ぶんを見込んでおくと木材に人が残る。
   */
  readonly housePlanAhead: number;
  /**
   * 資源の不足額を数えるときに見込む**兵の生産元の棟数**。
   *
   * ■ なぜ 1 棟では足りないか（実測）
   * 木材の必要額に生産元を 1 棟（175）だけ見込むと、それを超えたぶんは
   * 農地に回る。実測では黎明の世のあいだに**農地が 17 面（木材 1,020）**建ち、
   * 青銅に上がった時点の木材は 335 しか残っていなかった。
   * 兵舎（175）と射場（175）で 350 なので、**生産元が 1 棟しか建たない**。
   * 兵種の相性（`03`）があるので近接と遠隔の 2 系統は欲しい ―― だから 2 棟ぶん見込む。
   */
  readonly producerPlanAhead: number;
  /**
   * 1 回の判断で配置換えする村人の上限。
   *
   * すでに働いている村人も動かすようにしたので、上限が無いと
   * 全員が同じ資源へ殺到し、`gather` コマンドが毎判断ごとに出て
   * APM（`07§11` / `tests/balance/apm.test.ts` の 60）を食い潰す。
   */
  readonly reassignPerDecision: number;
  /**
   * 村人のうち**食料に残す最低割合**（百分率。整数）。
   *
   * 不足額に比例して割り当てると、木材が枯れた局面で全員が木材へ動いてしまう。
   * 食料は村人と兵の元なので、切らすと立て直せない。人間も「木が足りない」ときに
   * 畑と果樹を空にはしない。
   */
  readonly foodWorkerMinPercent: number;
  /**
   * 農地の上限を「食料に就いている村人の**何割**か」で表す（百分率。整数）。
   *
   * ■ なぜ上限が要るか（実測）
   * 農地は「木材 60 を食料に変える」建物で、木材のいちばん大きな裁量支出。
   * 上限を「食料の働き手の数」にしていたら、村人の目標を 32〜36 に上げた段階で
   * **農地が 12〜21 面（木材 720〜1,260）**建ち、
   * 攻城工房（木材 200）が最後まで建たなかった（実測で着工試行に一度も出てこない）。
   * 食料は 400〜800 余っている局面が多いので、木材をここに全部流すのは損。
   */
  readonly farmsPerFoodWorkerPercent: number;
  /**
   * 市場で交換するときの「余っている／使ってよい」の目安（資源の単位）。
   *
   * 実測（段階 5・30 分）で**食料 1,730 が余る一方で木材が 12**になり、
   * 攻城工房（木材 200）が最後まで建たなかった。拠点のそばの森が尽きたあと
   * 木材の収入は距離の壁で伸びないので、**余った食料を木材に変える**のが唯一の手。
   * この値より多く持っている資源を売り、この値より多い金で買う。
   */
  readonly marketSurplusUnits: number;
  /**
   * 村人のうち**木材に残す最低割合**（百分率。整数）。
   *
   * 木材は家と生産元の元。枯らすと人口上限に張り付き、兵舎も建たない
   * （この改修の発端になった実測: 木材 11・家 6 棟・生産元 0 棟・人口 38/40）。
   * 下で `ageWorkerMinPercent` に人を回すので、その分ここで底を守る。
   */
  readonly woodWorkerMinPercent: number;
  /**
   * **次の世にまだ足りない資源**に回す村人の最低割合（百分率。整数）。
   * 対象が複数なら等分し、端数は資源の添字が小さい方へ。上げない段階は 0。
   *
   * ■ なぜ比例配分と別に下限が要るのか（実測）
   * **時代が上がることの価値は不足額の大きさに比例しない。**
   * 「あと金 110 で鉄器」のときの金 110 は、木材 610 よりはるかに効く
   * （時代は兵の質・戦域スロット・研究・攻城兵器のすべての上限）。
   * 不足額に比例させるだけだと木材（生産元 2 棟 + 搬入点 = 610 前後）が常に勝ち、
   * 金には人が回らない ―― 実測（段階 4・3 組・30 分）で金が 89〜170 で頭打ちになり、
   * **3 組すべてが 30 分ずっと青銅の世のまま**だった。
   */
  readonly ageWorkerMinPercent: number;
  /**
   * 同じ村人を配置換えできる間隔（秒）。
   *
   * 配置換えは判断ごとに走るので、間隔を置かないと村人が歩き続けて 1 度も搬入しない
   * （実測: 食料が 10 分で 423 → 35 に落ちた）。採集 1 往復ぶんは触らないための値。
   */
  readonly reassignCooldownSec: number;
  /**
   * 資源の不足額を数えるときに見込む兵の体数。
   *
   * 兵を作りたいなら、その費用も「詰まっている資源」の判断に入れる必要がある。
   * 攻めない段階（1）は 0。
   */
  readonly unitDemandCount: number;
  /**
   * 村人を何体まで出すか。**ここで止めて資源を貯める。**
   *
   * これが無いと、AI は入ってきた資源を全部その場で村人に変えてしまい、
   * 手持ちが常に 0 付近に張り付く。実測（30 分）で食料が 0〜32 のまま推移し、
   * 青銅の世の 500 に一度も届かなかった（＝文明ごとの兵種が出ない）。
   * 人間も「村人を出し続ける時間」と「次の世に上がるために貯める時間」を
   * 分けている（`07§2` の 0〜5 分 / 5〜12 分）。
   */
  readonly villagerTarget: number;
  /**
   * 村人がこの数に達したら、**次の世の費用が貯まるまで村人生産を止める**。
   *
   * `villagerTarget` まで出し切ってから貯め始めると間に合わない
   * （入る食料をその場で村人に変え続けるので手持ちが 0 付近に張り付く）。
   * 人間も「ある程度の採集人数を確保したら、次は進化の費用を貯める」順で遊ぶ。
   */
  readonly villagerBankFrom: number;
  /**
   * **2 つ目以降**の世のために取り置く割合（0〜1）。最初の世（黎明 → 青銅）は 1.0 固定。
   *
   * 最初の世を全額取り置くのは、青銅で兵種ツリーが枝分かれするから
   * ―― ここに上がらないと文明の違いが盤に出ない。
   * ただし全額のままにすると、鉄器（食料 800）を貯め終わるまで兵が 1 体も出ない
   * （実測で 30 分・兵 0 体）。上がったあとは**半分だけ取り置いて並行**させる。
   */
  readonly ageReserveRatioAfterFirst: number;
  /** 最初の世（黎明 → 青銅）のために取り置く割合（0〜1）。 */
  readonly ageReserveRatioFirst: number;
  /**
   * 次の世の費用のうち**すでに手元にある割合**（百分率）がこれを超えたら、
   * 取り置きを `ageReserveRatioFirst`（全額）に切り替える ―― **上がる直前は貯め切る**。
   *
   * ■ なぜ動かす必要があるのか（実測。どちらに固定しても決着しなかった）
   *  - 割合を 0.5 に固定 → 兵が「取り置きを超えたぶん」を毎回食べるので手持ちが
   *    取り置きの額に張り付き、食料 400〜520・金 89〜170 で頭打ち。
   *    鉄器の世（食料 800・金 200）に **3 組すべてが 30 分間届かなかった**。
   *  - 常に全額取り置き → 鉄器には 20〜25 分で届くが、兵が 30 分で 4〜9 体に細り、
   *    拠点を殴る手が無くなる（これも決着しない）。
   *  - 兵の下限（`armyFloorSquads`）を 1 → 5 に上げて補う形も試したが、
   *    序盤に兵 8〜9 体を抱えて内政が細り、村人が 24 → 16 に減って
   *    **青銅の世が 15 分 → 20〜30 分に遅れた**。
   * 人間は「もう少しで上がれる」ところまで来たら兵を止めて貯め切る ―― その形。
   */
  readonly ageFinishFromPercent: number;
  /**
   * **取り置きを無視して必ず抱える兵の量**を「戦域 1 本ぶんの何倍か」で表す
   * （`front.spawnMinUnits` の倍数）。0 なら兵を抱えない（＝攻めない段階）。
   *
   * 戦域は双方が `spawnMinUnits` 体を集めたときに立つので、ちょうど 1 倍だと
   * **1 体死ぬたびに戦域が崩れる**。2 倍持つと崩れずに続く（実測で戦域が
   * 立つ／立たないの差になった）。
   */
  readonly armyFloorSquads: number;
  /**
   * **攻城を始めるのに必要な兵の量**を「戦域 1 本ぶんの何倍か」で表す
   * （`front.spawnMinUnits` の倍数）。0 なら拠点を攻めない（段階 1）。
   *
   * なぜ攻城の判断が必要になったかは `militaryGoals.ts` の `planSiege` の注記
   * （30 分 × 112 試合が全部時間切れ・町の中心の HP が 1 も減らなかった実測）を参照。
   */
  readonly siegeMinSquads: number;
  /**
   * 「目標の建物のそばに集まっている」と見なす半径（マス）。
   *
   * **`front.spawnRadiusTiles`（15）より広い 20 にしている。** 理由は実測:
   * 兵は目標の **14〜18 マス**で止まっていた（`militaryGoals.ts` の `ARRIVE_RADIUS`
   * = 15 マスで「着いた」と見なして `releaseManual` で令に返すが、守り手のいない
   * 拠点の前には戦域が立たないので**令の受け皿が無く**、そこで固まる）。
   * 15 のままだと 18 マスで止まった兵を数え落として永久に攻城が始まらない。
   */
  readonly siegeStageRadiusTiles: number;
  /**
   * 「目標の付近に敵兵がいない」と見なす半径（マス）。
   * ここに敵の戦闘ユニットが 1 体でもいれば攻城しない ―― 交戦は戦域（`07§3`）に任せる。
   *
   * 10 マスは `front.spawnRadiusTiles`（15）より**小さく**取っている。
   * 戦域が立つ範囲より広く取ると、戦域が立つより前に攻城を諦めてしまい、
   * 「攻城もしない・戦域も立たない」という元の状態に戻る。
   */
  readonly siegeClearRadiusTiles: number;
}

/** `ai.json` を level 昇順に並べた表。 */
export const AI_LEVELS: readonly AiLevelConfig[] = buildLevels();

/** 段階数（= `ai.json` の項目数）。 */
export const AI_LEVEL_COUNT = AI_LEVELS.length;

function buildLevels(): AiLevelConfig[] {
  const src = aiJson as unknown as Record<string, Record<string, unknown>>;
  const out: AiLevelConfig[] = [];
  for (const key of Object.keys(src)) {
    if (key.startsWith('_')) continue;
    const a = src[key] as Record<string, unknown>;
    out.push({
      key,
      level: int(a['level'], 0),
      name: String(a['name'] ?? key),
      intervalTicks: Math.max(1, Math.round(num(a['decisionIntervalSec'], 1) * TICK_RATE)),
      usableOrders: ((a['usableOrders'] ?? []) as string[]).slice(),
      maxFronts: int(a['maxFronts'], 0),
      minFronts: int(a['minFronts'], 0),
      allowDoubleFlag: a['allowDoubleFlag'] === true,
      allowUniqueOrders: a['allowUniqueOrders'] === true,
      allowSiege: a['allowSiege'] === true,
      enemyBuildingWeightMax: int(a['enemyBuildingWeightMax'], 0),
      allowDecoy: a['allowDecoy'] === true,
      allowAdvanceAge: a['allowAdvanceAge'] === true,
      houseHeadroomPop: int(a['houseHeadroomPop'], 5),
      housePlanAhead: int(a['housePlanAhead'], 1),
      producerPlanAhead: int(a['producerPlanAhead'], 1),
      reassignPerDecision: int(a['reassignPerDecision'], 1),
      foodWorkerMinPercent: int(a['foodWorkerMinPercent'], 40),
      farmsPerFoodWorkerPercent: int(a['farmsPerFoodWorkerPercent'], 100),
      marketSurplusUnits: int(a['marketSurplusUnits'], 400),
      woodWorkerMinPercent: int(a['woodWorkerMinPercent'], 20),
      ageWorkerMinPercent: int(a['ageWorkerMinPercent'], 0),
      reassignCooldownSec: int(a['reassignCooldownSec'], 20),
      unitDemandCount: int(a['unitDemandCount'], 0),
      villagerBuilderCount: int(a['villagerBuilderCount'], 2),
      villagerTarget: int(a['villagerTarget'], 18),
      villagerBankFrom: int(a['villagerBankFrom'], 12),
      ageReserveRatioAfterFirst: num(a['ageReserveRatioAfterFirst'], 0.5),
      ageReserveRatioFirst: num(a['ageReserveRatioFirst'], 1),
      ageFinishFromPercent: int(a['ageFinishFromPercent'], 0),
      armyFloorSquads: int(a['armyFloorSquads'], 2),
      siegeMinSquads: int(a['siegeMinSquads'], 2),
      siegeStageRadiusTiles: int(a['siegeStageRadiusTiles'], 20),
      siegeClearRadiusTiles: int(a['siegeClearRadiusTiles'], 10),
    });
  }
  // level 昇順（`Object.keys` の順に依存しない。§0.3）。
  out.sort((a, b) => (a.level !== b.level ? a.level - b.level : a.key < b.key ? -1 : 1));
  return out;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : fallback;
}

/** 段階 1..5 の設定を引く。範囲外は最も近い段階に丸める（不正な設定で試合が落ちないため）。 */
export function aiLevelConfig(level: number): AiLevelConfig {
  const first = AI_LEVELS[0];
  if (first === undefined) throw new Error('ai.json に段階が 1 つも無い');
  for (let i = 0; i < AI_LEVELS.length; i++) {
    if (AI_LEVELS[i]!.level === level) return AI_LEVELS[i]!;
  }
  return level < first.level ? first : AI_LEVELS[AI_LEVELS.length - 1]!;
}

// ---------------------------------------------------------------- AI の記憶

/**
 * AI が自分で覚えていること。**盤面ではなく「自分が何を命じたか」の記録**なので
 * これはズルではない（人間のプレイヤーも自分の指示は覚えている）。
 *
 * すべて **自軍エンティティの index を添字にした配列**で持つ。値には
 * 命じた時点の `EntityId` を入れる: index が再利用されて別の兵になったら
 * `EntityId` が変わるので「これは新入り」と判定できる（generation の照合を
 * 記憶側だけで完結させるための工夫）。
 */
export interface AiMemory {
  /** 村人を分類したときの EntityId（0 = まだ見たことがない index）。 */
  readonly villagerKnownId: number[];
  /**
   * 村人の役目。`VILLAGER_GATHERER` = 採集に就いている（触らない）、
   * `VILLAGER_BUILDER` = 建設係。
   *
   * 試合開始時に居る村人は `setup.ts` が最寄りの資源に就かせているので**採集係**。
   * 生産された村人は手空きなので**建設係**にする（`AiView` に「手空きか」は
   * 入っていないので、**初見の tick で見分ける**。申し送りに記載）。
   */
  readonly villagerRole: number[];
  /** その建設係が空くと見込まれる tick（建物の `buildTicks` から算出）。 */
  readonly villagerBusyUntil: number[];
  /**
   * **その村人に最後に採らせるよう命じた資源**（`RESOURCE_IDS` の添字 + 1。0 = まだ命じていない）。
   *
   * ■ なぜ必要か
   * `AiView` には「その村人がいま何を採っているか」が入っていない
   * （`carryKind` は盤面側の情報で、視界の構造に載っていない）。
   * それでも**資源ごとの働き手の数**が分からないと、
   * 「余っている資源を採り続け、詰まっている資源を採らない」を直せない。
   * 実測（段階 4・30 分）では村人 26 人の配分が
   * 「食料 12〜13 / 木材 3〜4 / 金 1〜6」で固定され、食料 1,838・金 907 が余る一方で
   * **木材 11 で枯れ、家が 6 棟・生産元 0 棟のまま**だった。
   *
   * これは盤面ではなく**自分が出した命令の記録**なので、ズルにはならない
   * （人間も「あの 5 人を森に送った」ことは覚えている）。
   * 開始時の村人は `setup` が就かせているので 0（未把握）のままで、
   * 配置換えの最初の候補になる。
   */
  readonly villagerResource: number[];
  /**
   * その村人に最後に `gather` を命じた tick（0 = まだ）。
   *
   * **同じ村人を続けて動かさないため**の記録。配置換えは 2 秒ごとの判断で
   * 走るので、これが無いと「森へ歩き出す → 次の判断で果樹へ送られる」を
   * 延々と繰り返し、1 度も搬入しないまま歩き続ける。
   * 実測（この記録を入れる前）では食料の手持ちが 10 分で 423 → 35 に落ちた。
   */
  readonly villagerMoveTick: number[];
  /**
   * 採集先を 4 資源に順番で割り当てるための通し番号（要素 1 個の配列）。
   *
   * 乱数を使わずに散らすための「何人目か」。`memGet`/`memSet` で持つのは
   * 他の記憶と同じ寿命（AI の生存期間）にしたいだけで、意味は単なる整数。
   */
  readonly gatherAssignSeq: number[];
  /**
   * 見つけた資源ノードの記憶（**発見順**。`nodeIds[k]` と他の 3 本が同じ添字で対応）。
   *
   * ■ なぜ記憶が必要か
   * `AiView.seenResourceNodes` は**その瞬間に視界に入っているものだけ**。
   * 拠点の周りに見えるのは森と果樹だけで、石切場と金鉱は 8 マス先にあって
   * 視界の外にある。斥候が通り過ぎた瞬間だけ見えても、次の判断では消えるので
   * 「あそこに金鉱がある」と言えない。実測で**石材と金の採集量が 30 分間 0** だった。
   *
   * 人間は一度見た資源の場所を覚えているので、これは透視ではない
   * （`view.ts` が地形を記憶扱いにしているのと同じ理由）。
   */
  readonly nodeIds: number[];
  /** その資源の種類（`RESOURCE_IDS` の添字）。 */
  readonly nodeResource: number[];
  /** 座標（Fx）。 */
  readonly nodeX: number[];
  readonly nodeY: number[];
  /** 斥候を次に向かわせる方角の番号（要素 1 個。乱数を使わずに一周させる）。 */
  readonly scoutStep: number[];
  /**
   * 資源（`RESOURCE_IDS` の添字）ごとに、これまで何人を就かせたか。
   * 「新しく必要になった資源に誰も就いていない」を判定するのに使う。
   */
  readonly assignedByResource: number[];
  /**
   * 最初の 1 隊を作り終えたか（要素 1 個。0 = まだ / 1 = 済み）。
   *
   * 「兵が 1 隊に届くまでは取り置きを無視して作る」という例外を、
   * **一度だけ**にするために持つ。兵が死んで数が減るたびに例外が復活すると、
   * 取り置きが永久に効かず世が上がらない（実測で食料が 318 で止まった）。
   */
  readonly firstSquadDone: number[];
  /** 遊休村人を戻すときの通し番号（要素 1 個。就かせる資源を順番に回すのに使う）。 */
  readonly idleAssignSeq: number[];
  /** その index の兵を送り出したときの EntityId。0 = 未派遣。 */
  readonly dispatched: number[];
  /**
   * 送り出した兵を令の管理下に戻した（`releaseManual` を出した）ときの EntityId。
   * これを持たないと「解放 → 未派遣に見える → また手動で送る」を毎回繰り返し、
   * 兵が延々と歩かされて戦域に編入されない（実測で 443 回の再派遣が起きた）。
   */
  readonly released: number[];
  /** 送り出した先（Fx）。`dispatched` と同じ添字。 */
  readonly dispatchX: number[];
  readonly dispatchY: number[];
  /** 囮として送り出した兵の EntityId（`dispatched` と同じ添字。0 = 本命）。 */
  readonly decoy: number[];
  /**
   * **その兵にいま攻めさせている建物の `EntityId`**（0 = 攻城していない）。
   *
   * これを持つ理由は 2 つあり、どちらも「同じ命令を出し直さない」ため:
   *  - `attackTarget` を毎判断ごとに出すと APM（`07§11` / `tests/balance/apm.test.ts`）を
   *    無駄に食う。**目標が変わったときと、新しい兵が加わったときだけ**出したい。
   *  - `pushDispatch` の「着いたら `releaseManual`」が攻城中の兵にも掛かると、
   *    `manual` が下りて目標を忘れ、建物を殴るのをやめてしまう。
   *    攻城中の兵はここを見て**派遣の対象から外す**。
   *
   * 値に `EntityId` を入れるのは他の記憶と同じ理由（目標が死んで index が
   * 再利用されても `EntityId` が変わるので「別物」と分かる）。
   */
  readonly siegeTarget: number[];
  /**
   * **その建物に最後に生産を命じた tick**（建物の index を添字に。0 = まだ）。
   *
   * ■ なぜ必要か（実測。段階 5 が段階 4 より弱かった原因）
   * `produce` は判断ごとに 1 件出していた。ところが村人は 20 秒（500 tick）かかるので、
   * その間の判断すべてが**同じ 1 体のために積み増し**になる:
   * 段階 4（2 秒間隔）なら 10 件、段階 5（1 秒間隔）なら 20 件が待ち行列に入る。
   * 実測では `villagerTarget` が 22（段階 4）/ 26（段階 5）なのに
   * **どちらも村人 33〜36 体**になり、超過ぶん（1 体 50 食料）が食料を食べていた。
   * 段階 5 のほうが積み増しが 2 倍なので内政が細り、
   * **30 分で黎明の世のまま**の席まで出た（鉄器到達が 4/8 席 ＜ 段階 4 の 7/8 席）。
   *
   * 「判断が速い」は**盤面を見直す回数**であって、同じ物を二重に注文することではない
   * （人間も待ち行列を見て「もう頼んである」と分かる）。
   * だから**その 1 体ができあがるまで次を頼まない**。
   * `AiView` に待ち行列が入っていないので、自分が命じた記録で代わりにする
   * ―― 盤面ではなく自分の操作の記憶なのでズルにならない。
   */
  readonly produceTick: number[];
  /**
   * **その建物に最後に「兵」の生産を命じた tick**（`produceTick` の兵版）。
   *
   * 村人と別に持つ理由: 黎明の世は町の中心が村人と兵の両方を出すので、
   * 1 つの記録を共有すると**村人の注文が兵に順番を取られる**。
   * 実測（段階 4）で村人の立ち上がりが遅れ、鉄器到達が 7/8 席 → 4/8 席に落ちた。
   * 人間も「村人を 1 体頼んだ」と「兵を 1 体頼んだ」は別に覚えている。
   */
  readonly armyProduceTick: number[];
  /**
   * **軍が次に建てたい建物 1 棟ぶんの費用**（資源 index 順の Fx。0 = 何も待っていない）。
   *
   * ■ なぜ内政と共有するのか（実測。攻城工房が建たない最後の原因）
   * 軍事側（`militaryGoals`）は「攻城工房を建てたい、でも木材が足りない」と分かっていて
   * 兵の生産をその 1 棟ぶんだけ我慢できる。ところが**内政側はそれを知らない**ので、
   * 「木材は足りている」と判断して余りを農地（1 面 60）に流していた。
   * 実測（段階 5・30 分）で農地 19 面（木材 1,140）を建てながら木材の手持ちは 16〜61、
   * 攻城工房（木材 200）は**着工試行にすら一度も出てこなかった**。
   *
   * 軍が待っている 1 棟を内政も勘定に入れれば、農地が止まって木材が貯まる
   * （農地は「木材の不足が 0 のとき」だけ建てる作りになっている）。
   * 内政 → 軍事の順に判断するので、内政が見るのは 1 判断前の記録になる（1〜2 秒）。
   */
  readonly wantBuildCost: number[];
  /**
   * **見たことのある敵の建物の `EntityId`**（発見順。並べ替えない）。
   *
   * ■ なぜ覚えるのか（実測。攻城工房が建たない本当の理由）
   * `readEnemy` は `AiView.seenEnemies`（**その瞬間に視界に入っているもの**）だけを見る。
   * 敵の建物が映るのは斥候や攻め込んだ兵が近くにいる数十秒だけなので、
   * `building` の重みがほとんどの時間 0 になり、攻城の需要が立たなかった:
   * ```
   * 25分 構成比 槍9 剣9 弓11 騎13 攻城11 → 欲しい建物は barracks（工房は選ばれない）
   * 30分 構成比 槍9 剣9 弓11 騎13 攻城11 → 30 分間ずっと工房 0 棟・攻城兵器 0 体
   * ```
   * 人間は一度見た敵の拠点を覚えていて「あれを壊すには攻城が要る」と考える。
   * 資源ノードを覚えているのと同じ扱い（`nodeIds` の注記）で透視ではない
   * ―― 覚えるのは**視界の判定を通ったものだけ**。
   */
  readonly enemyBuildingIds: number[];
  /** 直近に囮を仕込んだ tick（-1 = まだ）。テストと連打防止に使う。 */
  decoyTick: number;
  /** 直近に建設を命じた tick（-1 = まだ）。 */
  buildTick: number;
}

/** `AiMemory.villagerRole` の値: 採集に就いている村人（触らない）。 */
export const VILLAGER_GATHERER = 1;
/** `AiMemory.villagerRole` の値: 建設係（手空きなので建設に回せる）。 */
export const VILLAGER_BUILDER = 2;

function createMemory(): AiMemory {
  return {
    villagerKnownId: [],
    villagerRole: [],
    villagerBusyUntil: [],
    villagerResource: [],
    villagerMoveTick: [],
    gatherAssignSeq: [],
    nodeIds: [],
    nodeResource: [],
    nodeX: [],
    nodeY: [],
    scoutStep: [],
    assignedByResource: [],
    firstSquadDone: [],
    idleAssignSeq: [],
    dispatched: [],
    released: [],
    dispatchX: [],
    dispatchY: [],
    decoy: [],
    siegeTarget: [],
    produceTick: [],
    armyProduceTick: [],
    wantBuildCost: [],
    enemyBuildingIds: [],
    decoyTick: -1,
    buildTick: -1,
  };
}

/** 記憶の読み書き（配列を伸ばしながら扱うための小道具）。 */
export function memGet(arr: number[], index: number): number {
  const v = arr[index];
  return v === undefined ? 0 : v;
}

export function memSet(arr: number[], index: number, value: number): void {
  while (arr.length <= index) arr.push(0);
  arr[index] = value;
}

// ---------------------------------------------------------------- 判断の材料

/**
 * 1 回の判断で使う材料。**`World` を含まない**ので、
 * `econGoals` / `militaryGoals` / `frontPolicy` は構造的に盤面を覗けない。
 */
export interface AiContext {
  readonly playerId: PlayerId;
  readonly view: AiView;
  readonly cfg: AiLevelConfig;
  /** AI 専用の乱数（`world.rngAi`）。ここ以外の乱数は使わない。 */
  readonly rng: Rng;
  readonly memory: AiMemory;
  /** 自軍 index → EntityId。視界に無い index は `-1`（= 無効な EntityId）。 */
  idOf(index: number): EntityId;
}

// ---------------------------------------------------------------- 本体

/**
 * 1 人ぶんの AI。
 *
 * 使い方（呼び出し側の責務）:
 * ```ts
 * const ai = new AiPlayer(playerId, level);
 * for (;;) {
 *   const cmds = ai.think(world);          // 判断間隔の tick 以外は []
 *   stepWorld(world, [...others, ...cmds]); // 並びは playerId 昇順（手順書 §6.11）
 * }
 * ```
 */
export class AiPlayer {
  readonly playerId: PlayerId;
  readonly cfg: AiLevelConfig;
  private readonly memory: AiMemory = createMemory();
  /** index → EntityId の翻訳表（判断ごとに作り直す。判断間隔の外では作らない）。 */
  private readonly idTable: number[] = [];
  /** 直近に判断した tick（-1 = まだ）。テストと監査のために公開する。 */
  private lastThinkTick = -1;

  constructor(playerId: PlayerId, level: number) {
    this.playerId = playerId;
    this.cfg = aiLevelConfig(level);
  }

  /** 段階（1..5）。 */
  get level(): number {
    return this.cfg.level;
  }

  /** 直近に判断した tick。 */
  get lastDecisionTick(): number {
    return this.lastThinkTick;
  }

  /** この tick に判断するか。**乱数を使わない**（`07§11` / 手順書 §0.3）。 */
  isDecisionTick(tick: number): boolean {
    const n = this.cfg.intervalTicks;
    // プレイヤーごとに位相をずらす（8 人ぶんの判断が同じ tick に固まらないように）。
    return (tick + this.playerId) % n === 0;
  }

  /**
   * 判断間隔ごとに呼ばれ、この tick に出す `Command` を返す。
   *
   * **`w` から読むのは `rngAi` と（index → EntityId の翻訳のための）
   * 自軍の generation だけ**。盤面は `createAiView` の戻り値から読む。
   */
  think(w: World): Command[] {
    if (!this.isDecisionTick(w.tick)) return NO_COMMANDS;
    this.lastThinkTick = w.tick;

    const view = createAiView(w, this.playerId);
    this.buildOwnIdTable(w, view);

    const ctx: AiContext = {
      playerId: this.playerId,
      view,
      cfg: this.cfg,
      rng: w.rngAi,
      memory: this.memory,
      idOf: (index: number) => (memGet(this.idTable, index) as EntityId) || (-1 as EntityId),
    };

    // 順序は「内政 → 軍事 → 戦域」。同じ資源を取り合うので、
    // **内政（村人・家・進化）が先**（`07§2` の試合テンポ: 立ち上げが最優先）。
    // Command の並びは 1 人の中では発行順（手順書 §6.11）。
    const cmds: Command[] = [];
    pushAll(cmds, planEconomy(ctx));
    // 探索（`scoutGoals`）。**内政の後・軍事の前**。
    // 見つけていない資源があるあいだ斥候を歩かせる。これが無いと
    // 拠点の周りの森と果樹しか見えず、石材と金を一度も採れない（実測）。
    pushAll(cmds, planScouting(ctx));
    pushAll(cmds, planMilitary(ctx));
    pushAll(cmds, planFronts(ctx));
    return cmds;
  }

  /**
   * 自軍 index → EntityId の翻訳表を作る（**この 1 箇所だけが `w.entities` に触る**）。
   *
   * 読むのは `generation[index]` のみ。`index` は視界（`view.ownEntities`）に
   * 入っている自軍のものだけなので、視界の外の情報は 1 件も増えない。
   * 詳しい理由はファイル冒頭の「唯一の例外」を参照。
   */
  private buildOwnIdTable(w: World, view: AiView): void {
    for (let k = 0; k < this.idTable.length; k++) this.idTable[k] = 0;
    const gen = w.entities.generation;
    for (let k = 0; k < view.ownEntities.length; k++) {
      const i = view.ownEntities[k]!.index;
      memSet(this.idTable, i, makeEntityId(i, gen[i]!));
    }
  }
}

/**
 * 判断間隔の外で返す共有の空配列（毎 tick の確保を避ける）。
 * 呼び出し側が誤って push しないよう凍結してある。
 */
const NO_COMMANDS: Command[] = Object.freeze([] as Command[]) as Command[];

function pushAll(dst: Command[], src: readonly Command[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]!);
}
