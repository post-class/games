import type { Faction } from '../content/ships';
import type { FactionStance } from '../content/factions';
import type { LandmarkDef } from '../render/Landmarks';
import type { SkyboxOptions } from '../render/Starfield';
import type { AceState } from '../content/aces';
import type { SubsystemId } from '../sim/subsystems';

export type Tone = 'friendly' | 'enemy' | 'command';

export interface RadioLineDef {
  speaker: string;
  text: string;
  tone?: Tone;
  /** 直前の台詞からの遅延 (秒) */
  after?: number;
  /**
   * 過去章の選択と一致するときだけ流す台詞 (第9章 T6-9)。
   *
   * 第9章の門は「過去の無線を別の意味で再生する」ので、
   * どの台詞が返ってくるかは**実際に下した判断**で決まる。
   * 照合は `MissionRunner` が `Loadout.choices`（章id → 選択id）に対して行う。
   * 記録が無い場合は流さない（代わりに `whenChoiceMissing` の台詞が出る）。
   */
  whenChoice?: { chapterId: string; choiceId: string };
  /**
   * その章の選択記録が無いときだけ流す台詞 (第9章)。
   * 章を飛ばして出撃した場合・単体テスト・訓練出撃の既定台詞に使う。
   */
  whenChoiceMissing?: string;
}

/** 目標の判定内容 */
export type ObjectiveSpec =
  | { kind: 'destroyAll' }
  | { kind: 'destroyTag'; tag: string }
  | { kind: 'protect'; tag: string }
  | { kind: 'reachNav'; navIndex: number }
  | { kind: 'survive'; seconds: number }
  /**
   * タグの付いた対象すべてに接近して回収する (捜索救助)。
   *
   * `disabledOnly` を立てると、**戦闘不能になった対象だけ**が回収できる (第5章)。
   * 決闘中のラギティカにすれ違っただけで「回収」されてしまわないようにするための
   * 追加条件で、既定 (省略時) は従来どおり全対象が回収対象になる。
   */
  | { kind: 'rescue'; tag: string; radius?: number; disabledOnly?: boolean }
  /**
   * 偵察。対象を照準に収めたまま近距離を保つ。
   * 「撮影」なので撃つ必要はないが、逃げられると撮り直しになる。
   */
  | { kind: 'recon'; tag: string; seconds?: number; range?: number; coneDeg?: number }
  /** 制限時間。超過すると失敗する (時間制限つき防衛や強襲に使う) */
  | { kind: 'timeLimit'; seconds: number }
  /**
   * 誤射禁止。自機の射撃が味方・非敵対勢力に命中した回数が 0 であること (第2章)。
   * 1発でも当てた時点で失敗する。
   */
  | { kind: 'noFriendlyFire' }
  /**
   * 発砲禁止。自機が主砲・ミサイルを1発も発射していないこと (第3章・第7章)。
   * 当たったかではなく「引き金を引いたか」で判定する。
   */
  | { kind: 'weaponsSafe' }
  /**
   * タグ対象のうち `min` 以上が生存していること (第3章の避難船18隻)。
   * `protect` と違い、全滅ではなく「N隻を下回った時点」で失敗する。
   */
  | { kind: 'protectCount'; tag: string; min: number }
  /**
   * タグ対象を `min` (既定1) 以上維持したまま `seconds` 経過で達成 (第8章の灯台60秒)。
   * 途中で `min` を下回ったら失敗する。
   */
  | { kind: 'holdTag'; tag: string; seconds: number; min?: number }
  /**
   * 護衛対象を指定 Nav へ「乗せる」(T1-①)。
   *
   * `protect` が「沈められない」という**制約**であるのに対し、これは
   * **達成する目標**である（`MissionRunner` の `CONSTRAINT_KINDS` には入れない）。
   * これにより「守る対象が死ななければ、守らなくても勝ち」を防ぐ。
   *
   * - 達成: タグ対象のうち `min` (省略時は出現した全数) 以上が
   *   `navs[navIndex]` の到達半径に入った。一度入れば以後も達成のまま。
   * - 失敗: 到達済みと生存中を合わせても `min` に届かなくなった（＝到達不能が確定）。
   *
   * 到達半径は Nav 実体（`spawnNav` が `NavDef.arriveRadius` から作る）を読むので、
   * 自機の Nav 到達判定（`src/sim/nav.ts`）と同じ値になる。
   */
  | { kind: 'escortArrive'; tag: string; navIndex: number; min?: number };

export interface ObjectiveDef {
  id: string;
  text: string;
  /** 失敗するとミッション失敗になるか */
  required: boolean;
  spec: ObjectiveSpec;
  /**
   * 任意目標を達成すると得られるもの (T1-①)。例 `'＋帰還者3'`。
   *
   * `required: false` の目標に付けると、HUD とデブリーフで
   * `(任意)` の代わりにこの文字列を前置する（「加点」として読める表記にする）。
   * 未指定の任意目標は従来どおり `(任意)` を前置する。
   * `required: true` の目標では無視する。
   */
  reward?: string;
}

/**
 * 決闘規約 (第5章 T6-5)。エース1機に付ける宣言。
 *
 * 誓約の内容そのものは `src/content/aces.ts` の `AceOathRules` が持つ。
 * ここにはシミュレーションへ渡す数値だけを書く。
 * **難易度パラメータ (HP・攻撃力・弾速・命中補正・出現数) は含めない。**
 */
export interface DuelDef {
  /** 相手のハル率がこれ以下になったら引き金を引かない (撃墜を狙わない) */
  spareHullRatio?: number;
  /** 相手の癖を測るために保つ距離 (m) */
  measureRange?: number;
  /**
   * 誓約が破られてから片翼を失うまでの秒数。
   * 片翼喪失後は機動と武装を失って漂い、**脱出信号を出さない**
   * (信号が急進派に位置を教えるため)。救うにはこちらが接近するしかない。
   */
  crippleAfter?: number;
  /** 片翼喪失時に残るハル率 */
  crippledHullRatio?: number;
  /** 片翼喪失を知らせる無線の発信元 (省略時は当人) */
  speaker?: string;
}

export interface SpawnGroupDef {
  shipId: string;
  count: number;
  faction: Faction;
  /** この Nav に到達したら出現 (省略時は開始時) */
  atNav?: number;
  /** 出現条件を満たしてからの遅延 (秒) */
  delay?: number;
  /** Nav 位置からのオフセット */
  offset?: [number, number, number];
  /** 機体をばらけさせる幅 */
  spread?: number;
  /** 技量 (省略時は難易度から) */
  skill?: number;
  /** エース機として1機だけ強化する */
  ace?: { pilot: string; skillBonus?: number; shipId?: string; duel?: DuelDef };
  /** ミッション目標から参照するタグ */
  tag?: string;
  /**
   * この群の固有名 (T1-①)。護衛対象の艦名のように、機体名では足りない呼称を宣言する。
   *
   * ここが**名前の唯一の出所**。宣言すると `spawnShip` の `label` になるので、
   * HUD のターゲット名・無線の発信元・戦闘中の警告がすべて同じ名前を読む
   * （表示ごとに別の推定をしない）。人物名簿から採る名前は
   * `speakerName()` を通した文字列を渡すこと。
   * 省略した群は従来どおり機体名 (`ShipDef.name`) が表示名になる。
   */
  displayName?: string;
  /**
   * この群の出現で決闘の誓約が破れる (第5章の急進派)。
   * 出現した瞬間に決闘モードが解除され、決闘の当事者は
   * **同じ陣営であっても**この群へ機首を向ける。
   */
  breaksOath?: boolean;
  /** 味方機を編隊で飛ばすときのリーダー (player なら自機) */
  followPlayer?: boolean;
  /** 出現時の無線 */
  radio?: RadioLineDef[];
  /** 初速 */
  speed?: number;
  /** 護衛対象など、指定 Nav 方向へ巡航させる */
  cruiseToNav?: number;
  /**
   * 反射経路を N 回踏んだら出現する (第9章 T6-9)。
   *
   * 「楽な道へ進むほど僚機の声は増える」を出現条件に載せたもの。
   * `atNav` と併用しない（踏んだ回数だけが条件）。省略時は従来どおり。
   */
  afterReflections?: number;
}

/**
 * 戦域に置く障害物のかたまり。
 * 「何も無い宇宙」を避け、Nav ごとに場所の性格を持たせるために使う。
 */
export interface HazardDef {
  /**
   * `gravity-well` は機体を1つも置かない「空域の規則」
   * (第4章のオルドの重力アンカー)。中心は他の hazard と同じ
   * `atNav` / `betweenNavs` / `offset` で決め、`spread` を影響半径として読む
   * (`count` は使わない)。実装は `src/sim/obstacles.ts` の重力井戸。
   */
  kind: 'asteroids' | 'minefield' | 'gravity-well';
  /** 中心となる Nav (省略時は原点)。betweenNavs があればそちらが優先 */
  atNav?: number;
  /** 2つの Nav を結ぶ航路上にばらまく (帯・封鎖線を作る) */
  betweenNavs?: [number, number];
  /** 中心からのオフセット */
  offset?: [number, number, number];
  /** 個数 */
  count: number;
  /** ばらまく半径 */
  spread: number;
  /** 岩の半径の範囲 (asteroids のみ) */
  rockRadius?: [number, number];
  /**
   * 帯ごと流す (第4章の「移動する残骸帯」。asteroids のみ)。
   *
   * 岩は元から個別に微速で漂っているが、この宣言があると帯の全体が
   * 同じ方向へ `speed` (m/s) で動く。**指定しなければ従来どおり静的な帯**なので、
   * 既存11ミッションの小惑星帯の挙動は変わらない。
   * `dir` を省略すると `betweenNavs` の航路方向 (無ければ +X) へ流れる。
   */
  drift?: { speed: number; dir?: [number, number, number] };
  /**
   * 重力井戸の強さ (第4章。`kind: 'gravity-well'` のときだけ読む)。
   * 自機の実効質量が `cycle` 秒周期で ±`swing` 倍に振れ、
   * ミサイルは `pull` (m/s^2) で井戸の中心へ引かれて弧を描く。
   * `speaker` は重力が動いた瞬間を知らせる無線の発信元。
   */
  gravity?: { cycle: number; swing: number; pull: number; speaker?: string };
  /** 機雷の所属 (この陣営は起爆させない。minefield のみ、既定 kilrathi) */
  faction?: Faction;
  /**
   * 熱紋機雷 (第3章)。軍用推進器 (戦闘機・爆撃機) の熱紋にのみ反応し、
   * 避難船や救難艇のような非武装船 (`role: 'transport'`) には反応しない。
   * 既定 false なので、既存ミッションの機雷は陣営判定だけで動く。
   */
  thermalOnly?: boolean;
  /**
   * 共鳴パルスの安全窓 (第3章)。`cycle` 秒周期のうち先頭 `window` 秒だけ
   * 熱紋判定が鈍り、機雷が起爆シーケンスに入らなくなる。
   * **自機が発砲するとその作戦の間は二度と開かない** (歌が止まる)。
   * 窓の状態は無線と目標の note でプレイヤーに知らせる。
   */
  resonance?: {
    /** 周期 (秒) */
    cycle: number;
    /** 窓が開いている長さ (秒) */
    window: number;
    /** 窓の開閉を伝える無線の発信元 (省略時は管制) */
    speaker?: string;
  };
}

export interface NavDef {
  name: string;
  pos: [number, number, number];
  /** 到達判定半径 */
  arriveRadius?: number;
  /** 到達時の無線 */
  onArrive?: RadioLineDef[];
  /**
   * 反射経路 (第9章 T6-9)。「選ばなかった方の未来」の記録で、踏むと帰投窓が縮む。
   *
   * ■ 航路チェーンから外す理由
   * `src/sim/nav.ts` の `nextNav` / `checkNavArrival` は
   * **index が最小の未到達 Nav だけ**を到達判定の対象にする。反射 Nav を
   * 通常の Nav として置くと、実経路の Nav へ着いても判定が降りない
   * （＝反射を必ず踏まされる）ので、選べる分岐にならない。
   * そこで `MissionRunner.build()` は反射 Nav を最初から「到達済み」として置き、
   * 必須の航路チェーン（`nextNav`）から外す。踏んだかどうかは
   * `MissionRunner` が自前の近接走査（`updateReflections`）で判定する。
   * 反射 Nav は必須目標に使わないこと。
   */
  reflection?: {
    /** 踏んだときに帰投窓から差し引く秒数 */
    penaltySeconds: number;
  };
}

export interface CapitalStageDef {
  id: string;
  text: string;
  /** このタグの敵を全滅させるまで次段階へ進めない */
  tag: string;
  /** 対象艦の指定部位を完全損失させる段階 */
  subsystem?: SubsystemId;
  /** 指定兵装を発射して初めて完了する段階 */
  weapon?: 'torpedo';
  radio?: RadioLineDef[];
}

/**
 * この出撃だけ有効な勢力関係の組み替え（第8章の停戦・第10章の共同作戦）。
 *
 * 既定の敵対関係（`src/content/factions.ts` の `DEFAULT_HOSTILE_PAIRS`）は
 * 世界観仕様そのものなので書き換えず、「この章では誰と誰が非敵対か」だけを
 * ミッションのデータとして宣言する。適用は `MissionRunner.build()`、
 * 既定への復帰は `MissionRunner.dispose()` が受け持つ（`MissionDef` は宣言だけを持つ）。
 */
export interface FactionStanceDef {
  a: Faction;
  b: Faction;
  stance: FactionStance;
}

export interface MissionDef {
  id: string;
  title: string;
  /** 星系名 (ブリーフィングに出す) */
  system: string;
  /** ブリーフィングの本文 (段落ごと) */
  briefing: string[];
  /** ブリーフィングを読み上げる人物 */
  briefingSpeaker: string;
  /**
   * その人物の顔画像 id (`public/art/tex/face-<id>-<表情>.jpg`)。
   * 省略時は艦長 (halcyon) の顔を使う。
   */
  briefingSpeakerId?: string;
  /** 名札の2行目に出す役職。省略時は艦長の肩書 */
  briefingSpeakerRole?: string;
  navs: NavDef[];
  spawns: SpawnGroupDef[];
  /**
   * この出撃の間だけ有効な勢力関係の上書き。
   * ミッション終了時（`dispose`）に必ず既定へ戻るので、他ミッションへは漏れない。
   */
  factionStances?: FactionStanceDef[];
  /**
   * 通信妨害 (第6章 T6-6)。味方の位置報告が遅れて届く。
   *
   * 遅らせるのは**自機と同じ陣営の他機だけ**（妨害されているのは味方同士の通信）。
   * HUD の位置・距離・レーダー・航法マップと ITTS の照準支援が
   * すべて同じ「報告位置」を使うので、表示だけが遅れることはない
   * （実装は `src/sim/comms.ts`）。宣言が無ければ完全に従来どおり。
   */
  commsDelay?: {
    /** 味方位置が遅れて届く秒数 */
    friendlySeconds: number;
  };
  /**
   * 学習する群体 (第6章 T6-6)。撃墜された数に応じて隊形・攻め方が変わる。
   *
   * **難易度パラメータ（HP・攻撃力・弾速・命中補正）は変えない。**
   * 変わるのは隊形・同時に張り付く数・回避の入れ方だけで、
   * 段階には上限がある（`src/sim/ai.ts` の `MAX_SWARM_LEVEL`）。
   */
  swarmLearning?: {
    /** 学習する陣営 */
    faction: Faction;
    /** 1段階の学習に必要な撃墜数 (省略時は ai.ts の既定) */
    lossesPerLevel?: number;
  };
  /** 小惑星帯・機雷原など */
  hazards?: HazardDef[];
  /** 巨大構造物 (描画のみ。当たり判定は持たない) */
  landmarks?: LandmarkDef[];
  objectives: ObjectiveDef[];
  /** 旗艦／拠点攻撃の段階。護衛→本体→帰投をデータとして表す。 */
  capitalStages?: CapitalStageDef[];
  /** 互換用の段階表とは別に、部位攻撃の実行順を定義する。 */
  capitalSequence?: CapitalStageDef[];
  /** 既定の搭乗機 */
  playerShipId: string;
  /** 機体の既定副兵装を上書きする (魚雷を積ませる等) */
  playerMissiles?: Array<{ missileId: string; count: number }>;
  wingman?: { shipId: string; pilot: string; skill: number };
  skybox?: SkyboxOptions;
  /** 開始時の無線 */
  openingRadio?: RadioLineDef[];
  debriefWin: string[];
  debriefLoss: string[];
}

/** ロードアウト (格納庫の選択画面から渡す) */
export interface Loadout {
  shipId: string;
  gunId?: string;
  missiles?: Array<{ missileId: string; count: number }>;
  /** 搭載するフレア数 (有限補給から割り当てる) */
  flares?: number;
  /** キャンペーンをまたぐ宿敵の状態。訓練出撃では省略する。 */
  aceStates?: AceState[];
  /** 僚機を何番機として飛ばすか。編隊位置と無線の呼称に使う。 */
  wingmanSlot?: number;
  /**
   * 章ごとの選択記録 (章id → 選択id)。`NarrativeState.choices` をそのまま渡す。
   *
   * 第9章（T6-9）の門は、過去に下した判断を別の意味で再生する
   * （救難を選んだ無線は告発として、追撃を選んだ無線は謝罪として返る）。
   * ミッション定義は静的データなので、選択に応じた差し替えは
   * `RadioLineDef.whenChoice` と、この記録の照合で行う。
   *
   * 未指定のときは `MissionRunner` が保存データ（`loadSave()`）から読む。
   * `App.loadoutFor()` が `choices: this.save.narrative.choices` を渡せば
   * その保険は不要になる（App 側は本タスクの変更対象外のため保険を残している）。
   */
  choices?: Record<string, string>;
  /**
   * 同行する僚機。
   * 名簿から選ばれた人物の情報をそのまま渡す (未指定なら単独出撃)。
   */
  wingman?: {
    pilotId: string;
    callsign: string;
    shipId: string;
    skill: number;
    personality: { obedience: number; aggression: number; caution: number; grit: number };
  };
}
