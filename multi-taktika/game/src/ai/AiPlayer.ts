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
      allowDecoy: a['allowDecoy'] === true,
      allowAdvanceAge: a['allowAdvanceAge'] === true,
      villagerBuilderCount: int(a['villagerBuilderCount'], 2),
      villagerTarget: int(a['villagerTarget'], 18),
      villagerBankFrom: int(a['villagerBankFrom'], 12),
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
   * 採集先を 4 資源に順番で割り当てるための通し番号（要素 1 個の配列）。
   *
   * 乱数を使わずに散らすための「何人目か」。`memGet`/`memSet` で持つのは
   * 他の記憶と同じ寿命（AI の生存期間）にしたいだけで、意味は単なる整数。
   */
  readonly gatherAssignSeq: number[];
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
    gatherAssignSeq: [],
    dispatched: [],
    released: [],
    dispatchX: [],
    dispatchY: [],
    decoy: [],
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
