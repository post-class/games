import { rng } from '../core/rng';
import type { WingmanOrder } from '../world/entity';
import type {
  AceDefinition,
  AceFleetMemory,
  AceStance,
  AceState,
  DuelRefusal,
} from './aces';
import { aceAttitude, ACES } from './aces';
import { VEIL_PEOPLE } from './veil/people';

/**
 * 無線台詞。
 *
 * ■ 物語の三原則（ストーリー_十章作戦記録 §04 / 世界観_歴史仕様 §06）
 * 1. 敵にも帰還先がある — キルラシー帝国を単純な侵略者にしない。名・誓約・救難信号を
 *    戦闘中にも見せ、撃墜が唯一の解にならない状況を作る。
 * 2. 戦果には補給と時間の代償を置く。
 * 3. 異星文明を単純な怪物にしない — 敵にも協定派（誓約を守る側）と強硬派がいる。
 *
 * したがって敵側の台詞は種族的な罵倒を持たず、`oath`（誓約派）と `radical`（急進派）の
 * 2系統に分ける。`radical` も「怪物の唸り」ではなく、家門の成果を急ぐ人物の言葉として書く。
 */

/** 敵側の台詞系統。エース側の `AceStance` と同じ区分を使う（定義を二重に持たない）。 */
export type EnemyStance = AceStance;

/** 僚機がオーダーに応答する台詞 */
const WINGMAN_ACK: Record<WingmanOrder, string[]> = {
  form: ['了解、翼に付く。', 'フォーメーションに戻る。', '編隊、リード了解。'],
  'attack-my-target': [
    'その目標を狙う。',
    '了解、お前の獲物を叩く。',
    'ロックした。仕留めるぞ。',
  ],
  'break-and-attack': [
    'ブレイク！各自交戦する。',
    '散開する。好きに暴れさせてもらう。',
    '了解、自由射撃だ。',
  ],
  'help-me': ['そっちへ向かう、こらえろ！', '引き剥がす、10秒待て。'],
};

const WINGMAN_KILL = [
  '撃墜確認、いい腕だ。',
  'ナイスショット。',
  'よし、1機減った。',
];

const WINGMAN_TROUBLE = [
  'こいつを引き剥がせない、助けてくれ！',
  '被弾した！背後を取られている！',
  'シールドが持たない、支援を頼む！',
];

/**
 * 敵の挑発。
 * - `oath`: 名を名乗り、誓約に言及し、決闘を申し込む。相手の技量を認め、侮辱はしない。
 * - `radical`: 協定を蔑ろにし、成果を急ぐ。味方の誓約すら邪魔だと言う。
 */
export const ENEMY_TAUNT: Record<EnemyStance, string[]> = {
  oath: [
    '名を名乗れ。記録に残す。',
    '誓約により我が艦隊の砲は止めた。あなたも一機で来い。',
    '腕は認める。だから誓約で戦う。',
    '逃げる者は追わない。それが我々の約束だ。',
    'あなたは門を盗む者か、帰す者か。',
    '一対一で受ける。第三者には撃たせない。',
  ],
  radical: [
    '誓約など古い。成果だけが家を残す。',
    '停戦の書式に付き合う暇はない。',
    '味方の砲門が邪魔だ。退かせろ。',
    '門は待たない。私が先に取る。',
    '記録より結果だ。うちの誓約者も後で分かる。',
  ],
};

/** プレイヤーの挑発。相手を種族で貶めず、名と条件を突きつける。 */
export const PLAYER_TAUNT = [
  'こちらの名を送る。応答しろ。',
  '誓約で戦うなら、こちらも一機で出る。',
  'その腕なら、話は通じるはずだ。',
  '引くなら追わない。決めろ。',
  '帝国の書式に合わせる。始めよう。',
];

/** 挑発への敵の応答。 */
export const ENEMY_ACK_TAUNT: Record<EnemyStance, string[]> = {
  oath: [
    '受けた。名を記憶する。',
    'いい返答だ。では誓約どおりに。',
    '応じる。こちらの僚機は手を出さない。',
  ],
  radical: [
    '無駄口だ。時間がない。',
    '記録などいらん。落とすだけだ。',
    '誓約者どもと一緒にするな。',
  ],
};

/**
 * 被弾した敵機の救難信号（第5章・第8章のギミック）。
 * 脱出信号を出せない事情まで含めて、撃墜以外の選択肢を提示する。
 */
export const ENEMY_DISTRESS = [
  '被弾した。脱出信号は出せない、急進派に位置が漏れる。',
  'こちら被弾機。誓約に基づき、救援を請う。',
  '片翼を失った。回収できる者はいるか。',
  '救難信号だ。撃つな。帰る先がある。',
];

/** 名を交換する儀礼（第5章の決闘、第8章の共同作戦）。 */
export const ENEMY_NAME_EXCHANGE = [
  'まず名を。撃墜した相手の名は忘れない。',
  '名を受け取った。誓約文に書く。',
  '交換の儀礼は成立した。では、始めよう。',
  'あなたの名は勝敗の後も記録に残る。',
];

/** 降伏・離脱の申し出。 */
export const ENEMY_DISENGAGE = [
  '離脱する。追わないでくれ。誓約だ。',
  'これ以上は無為だ。空域を出る。',
  '砲を下げる。今日はここまでだ。',
  '帰投線に入る。追撃はしないと信じる。',
];

/**
 * 僚機が戦死したときの管制の反応（T1-②）。
 *
 * 名前を口に出す。撃墜ログが流れて消えても「誰が落ちたか」が耳に残るようにする。
 * 文中の `{name}` は戦死した僚機の呼び名で置き換える。
 */
export const CONTROL_WINGMAN_LOST = [
  '{name} の信号が消えた。……記録する。',
  '管制より全機。{name} 機、喪失。周囲を警戒しろ。',
  '{name}、応答なし。脱出信号も無い。',
  '{name} の機体が消えた。手を止めるな、生き延びろ。',
];

/**
 * 護衛対象（輸送船・避難船・灯台など）の被弾段階（T1-②）。
 *
 * 話し手は護衛対象そのもの。撃墜されると必ず任務失敗になる相手なので、
 * 「削られている」ことが戦闘中に聞こえるようにする。
 */
export const ESCORT_SHIELD_DOWN = [
  'シールドが落ちた。次は船体に来る。',
  'こちら被弾中。防御幕が保たない。',
  'シールド喪失。近くに付いてくれ。',
];

export const ESCORT_ARMOR_HIT = [
  '装甲に通った。曳いている、剥がしてくれ！',
  '外板を破られた。応急班を回している。',
  '被弾が装甲に届いた。掩護を頼む。',
];

export const ESCORT_CRITICAL = [
  '船体が抜けた。もう保たない、頼む！',
  '機関室に届いた。沈む前に引き剥がしてくれ！',
  'これ以上は無理だ。……こちらには帰りを待つ者がいる。',
];

/** 護衛対象を失ったときの管制の反応（T1-②）。`{name}` は艦名で置き換える。 */
export const CONTROL_ESCORT_LOST = [
  '{name} の信号が消えた。……任務は失敗だ。',
  '管制より。{name}、沈んだ。守る対象を失った。',
  '{name} が消えた。乗員の記録を取る。',
];

/** 自機が撃墜されたときの管制の呼びかけ（T1-②）。 */
export const CONTROL_PLAYER_DOWN = [
  '……信号が消えた。誰か、応答しろ。',
  '管制より。機体が消えた。救助艇を出す。',
  'こちら管制。応答しろ。……応答しろ！',
];

// ───────── エースへの通信（T4-⑯） ─────────

/**
 * エース宛の通信の種類。
 *
 * ■ 既存の「挑発」（`PLAYER_TAUNT` / `ENEMY_ACK_TAUNT`）との役割分担
 * 挑発は**名前を持たない敵**に向けた圧力で、内容は誰に言っても同じ・返事も定型。
 * こちらは**名前を持つ相手**との交渉で、返事は人物データ（`AceVoice`）から引き、
 * 結果が `AceState` に積まれる。したがって二つは並べず、
 * 通信メニューでは「ターゲットがエースなら挑発の枠がエース通信に切り替わる」形で
 * 排他にする（同じ操作に、意味の違う二つを並べない）。
 */
export type AceHailKind = 'name' | 'surrender' | 'duel';

/** こちらから送る文面。相手を種族で貶めず、名と条件だけを言う。 */
export const PLAYER_ACE_HAIL: Record<AceHailKind, readonly string[]> = {
  name: [
    'こちらの識別と名を送る。受け取れ。',
    '名を名乗る。記録に残してくれ。',
    '書式に合わせる。こちらの名を送信した。',
  ],
  surrender: [
    '砲を下げろ。帰投線は空けておく。',
    '降伏を勧める。座席は撃たない、約束する。',
    'ここで終わりにしないか。帰る先があるだろう。',
  ],
  duel: [
    '決闘を申し込む。こちらは一機で出る。',
    '一対一で受けてもらいたい。誓約の書式で。',
    '他は手を出さない。あなたと私だけで決めよう。',
  ],
};

/** 決闘を断られた理由の一句。エースの口調のあとに足す。 */
const DUEL_REFUSAL_CLAUSE: Record<DuelRefusal, string> = {
  'no-challenge-rule': '我が家の誓約に決闘の項目は無い。',
  'name-first': 'まず名だ。書式を飛ばす相手とは組まない。',
  'too-many-wingmen': '一対一と言うなら、僚機を退かせてから言え。',
  'low-oath': 'あなたの誓約は軽い。信用が足りない。',
  'executed-pods': '座席を撃つ者と誓約は結べない。',
};

/** これまでのやりとりを1句で思い出す（積み上がりを声に出すため）。 */
export function aceMemoryClause(state: AceState): string | undefined {
  if ((state.duelsAccepted ?? 0) > 0) return '前の決闘は書式どおりだった。';
  if ((state.duelsDeclined ?? 0) > 0) return '前は断った。今日はどうかな。';
  if ((state.namesExchanged ?? 0) > 0) return 'あなたの名は記録にある。';
  return undefined;
}

/** こちらからエースへ送る文面。 */
export function playerAceHailLine(kind: AceHailKind): string {
  return rng.pick(PLAYER_ACE_HAIL[kind]);
}

/** 名乗りへの返答。 */
export function aceNameReplyLine(def: AceDefinition): string {
  return def.voice.name;
}

/** 降伏勧告への返答。 */
export function aceSurrenderReplyLine(def: AceDefinition): string {
  return def.voice.surrender;
}

/** 決闘を受けたときの返答。 */
export function aceDuelAcceptLine(def: AceDefinition): string {
  return def.voice.duelAccept;
}

/** 決闘を断るときの返答。口調（人物）＋理由（共通の一句）で組む。 */
export function aceDuelDeclineLine(def: AceDefinition, reason: DuelRefusal): string {
  return `${def.voice.duelDecline} ${DUEL_REFUSAL_CLAUSE[reason]}`;
}

/**
 * 再会時の第一声。
 * 態度（`aceAttitude`）で本文を選び、積み上がったやりとりがあれば一句足す。
 */
export function aceGreetingLine(
  def: AceDefinition,
  state: AceState,
  fleet: AceFleetMemory,
): string {
  const attitude = aceAttitude(state, fleet);
  const voice = def.voice;
  const base =
    attitude === 'unmet'
      ? voice.greetFirst
      : attitude === 'debt'
        ? voice.greetDebt
        : attitude === 'grudge'
          ? voice.greetGrudge
          : attitude === 'wary'
            ? voice.greetWary
            : voice.greetKnown;
  const clause = attitude === 'unmet' ? undefined : aceMemoryClause(state);
  return clause ? `${base} ${clause}` : base;
}

/** 味方が敵を救ったときの反応。 */
export const ALLY_RESCUE_ACK = [
  '敵機の回収を確認。記録に残る。',
  '拾ったな。……悪くない判断だ。',
  '帝国側が砲を下げた。効いている。',
  '救難完了。名前が一つ、消えずに残った。',
];

export function wingmanAck(order: WingmanOrder): string {
  return rng.pick(WINGMAN_ACK[order]);
}

export function wingmanKillLine(): string {
  return rng.pick(WINGMAN_KILL);
}

export function wingmanTroubleLine(): string {
  return rng.pick(WINGMAN_TROUBLE);
}

/**
 * 敵の挑発。
 * 系統を省略した場合は帝国の標準である `oath`（誓約派）を使う。
 * 既存の呼び出し（引数なし）をそのまま動かすための既定値。
 */
export function enemyTaunt(stance: EnemyStance = 'oath'): string {
  return rng.pick(ENEMY_TAUNT[stance] ?? ENEMY_TAUNT.oath);
}

export function playerTaunt(): string {
  return rng.pick(PLAYER_TAUNT);
}

export function enemyTauntReply(stance: EnemyStance = 'oath'): string {
  return rng.pick(ENEMY_ACK_TAUNT[stance] ?? ENEMY_ACK_TAUNT.oath);
}

/** 被弾した敵機の救難信号。 */
export function enemyDistressLine(): string {
  return rng.pick(ENEMY_DISTRESS);
}

/** 名を交換する儀礼の台詞。 */
export function enemyNameExchangeLine(): string {
  return rng.pick(ENEMY_NAME_EXCHANGE);
}

/** 敵からの離脱・降伏の申し出。 */
export function enemyDisengageLine(): string {
  return rng.pick(ENEMY_DISENGAGE);
}

/** 敵を救ったときの味方の反応。 */
export function allyRescueAckLine(): string {
  return rng.pick(ALLY_RESCUE_ACK);
}

/** 僚機の戦死に管制が反応する台詞。名前を必ず含める。 */
export function controlWingmanLostLine(name: string): string {
  return rng.pick(CONTROL_WINGMAN_LOST).replace('{name}', name);
}

/** 護衛対象の被弾段階の台詞。段階名は `damageStage()` の値をそのまま使う。 */
export function escortDamageLine(
  stage: 'shield-down' | 'armor-hit' | 'hull-critical',
): string {
  if (stage === 'shield-down') return rng.pick(ESCORT_SHIELD_DOWN);
  if (stage === 'armor-hit') return rng.pick(ESCORT_ARMOR_HIT);
  return rng.pick(ESCORT_CRITICAL);
}

/** 護衛対象の喪失に管制が反応する台詞。艦名を必ず含める。 */
export function controlEscortLostLine(name: string): string {
  return rng.pick(CONTROL_ESCORT_LOST).replace('{name}', name);
}

/** 自機撃墜に管制が反応する台詞。 */
export function controlPlayerDownLine(): string {
  return rng.pick(CONTROL_PLAYER_DOWN);
}

/**
 * キルラシー帝国パイロット名（エース以外の雑多な敵に付ける）。
 *
 * 名前の文字列は `src/content/veil/people.ts` の `kilrashi-01`〜`-10` を唯一の出所とし、
 * ここでは二重定義しない。そこから次の2種類を除外する。
 * - 最高権力者（`isLeader` = ヴァルカーン）: 大牙王が雑魚機に乗ることはない。
 * - `ACES` に登録済みの人物（ラギティカ／カクシ／ダカス／セイラク／フェン）:
 *   宿敵としての遭遇・撃墜・離脱記録を持つため、名無しの敵と名前が衝突すると
 *   「同じ名前が量産される」ことになり、名を記憶する誓約の設定が崩れる。
 *
 * 結果として残るのは オル／ヴァーク／カリ／ドゥル の4名。数は少ないが、
 * 名前を勝手に増やすより名簿との一致を優先する。
 */
const ACE_PERSON_IDS = new Set(
  ACES.filter((ace) => ace.faction === 'kilrathi').map((ace) => ace.personId),
);

export const KILRATHI_NAMES: readonly string[] = VEIL_PEOPLE.filter(
  (person) =>
    person.faction === 'kilrashi' && person.isLeader !== true && !ACE_PERSON_IDS.has(person.id),
).map((person) => person.name);

export function kilrathiName(i: number): string {
  return KILRATHI_NAMES[i % KILRATHI_NAMES.length];
}
