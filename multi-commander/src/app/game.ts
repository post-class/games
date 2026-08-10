import { Quaternion, Vector3 } from 'three';
import { audio } from '../audio/AudioManager';
import { CombatAudio } from '../audio/CombatAudio';
import { bus } from '../core/events';
import { forwardOf } from '../core/math';
import { FIXED_DT, Loop } from '../core/loop';
import {
  aceDuelAcceptLine,
  aceDuelDeclineLine,
  aceGreetingLine,
  aceNameReplyLine,
  aceSurrenderReplyLine,
  allyRescueAckLine,
  controlEscortLostLine,
  controlPlayerDownLine,
  controlWingmanLostLine,
  enemyTauntReply,
  escortDamageLine,
  playerAceHailLine,
  playerTaunt,
  wingmanAck,
} from '../content/dialogue';
import {
  aceDef,
  aceFleetMemory,
  aceIdForPilot,
  aceState,
  evaluateDuelRequest,
  recordAceDuel,
  recordAceNameExchange,
  recordAcePodExecuted,
  recordAcePodSpared,
  recordAceSurrenderOffer,
  type AceState,
} from '../content/aces';
import type { ShipDef } from '../content/ships';
import {
  mournLine,
  wingmanArmorLine,
  wingmanCriticalLine,
  wingmanShieldDownLine,
} from '../content/pilotDialogue';
import { PILOTS, type PersonalityId } from '../content/pilots';
import { HudView } from '../hud/HudView';
import type { ObjectiveView } from '../hud/objectiveLines';
import { damageStage, stageWorsened, type DamageStage } from '../hud/damageStage';
import { healthRatios } from '../sim/damage';
import { AIM_PITCH_OFFSET } from '../core/aim';
import {
  displayNameOf,
  MISSION_GRADE_LABEL,
  MissionRunner,
  type MissionGrade,
} from '../mission/MissionRunner';
import type { Loadout, MissionDef } from '../mission/types';
import { CameraRig } from '../render/CameraRig';
import { CombatVfx } from '../render/CombatVfx';
import { RenderSync } from '../render/RenderSync';
import { Landmarks } from '../render/Landmarks';
import { SceneSetup } from '../render/SceneSetup';
import { configureDuel, newAi, setWingmanOrder } from '../sim/ai';
import { setCombatOptions } from '../sim/combat';
import { ACE_POD_TAG_PREFIX, canEject, eject } from '../sim/eject';
import { commsAvailable, hasDamage } from '../sim/subsystems';
import { canAutopilot, nextNav, updateAutopilot } from '../sim/nav';
import { simulateStep, snapshotForRender } from '../sim/step';
import { targetFront, targetNearest, targetNext } from '../sim/targeting';
import { cycleMissile, dropFlare, fireMissile } from '../sim/weapons';
import type { Entity, WingmanOrder } from '../world/entity';
import { spawnShip, World } from '../world/world';
import { DeckSequence } from './DeckSequence';
import { CommsMenu, type AceCommsKind, type CommsAction } from '../ui/CommsMenu';
import { loadSave } from './save';
import { Tutorial, type TutorialMode } from '../ui/Tutorial';
import { InputManager } from './input';
import { aimAssistStrength, difficulty, settings } from './settings';
import { ReplayBuffer } from './replay';
import { PlaytestLog, type PlaytestRecorder } from './playtest';

/**
 * 自機が撃墜されてから画面を切り替えるまでの「間」(秒)。
 *
 * 即暗転すると死んだことに気付けないので、爆発を見せ、カメラを寄せ、
 * 無線が1本入るまで待つ。この間はプレイヤー入力を一切受け付けない。
 */
export const PLAYER_DEATH_HOLD = 4.2;

/**
 * 任務失敗を読むための最低の余韻 (秒)。
 *
 * 失敗の見出し (部分達成/任務失敗) が出た瞬間に画面が切り替わると、
 * 何が起きて負けたのかを読めない。達成で終わるときのテンポは変えない。
 */
export const LOSS_READ_DELAY = 3.6;

/**
 * 任務終了からデブリーフへ移るまでの待ち時間を決める。
 *
 * Game の外に出してあるのは、**「失敗が読める時間が必ず確保される」ことを
 * 単体テストできる**ようにするため。
 *
 * @param outcome 勝敗
 * @param opts landing: 着艦演出を挟むか / deathRemaining: 撃墜演出の残り (撃墜されていなければ undefined)
 */
export function endDelayFor(
  outcome: 'win' | 'loss',
  opts: { landing: boolean; deathRemaining?: number },
): number {
  if (outcome === 'win' && opts.landing) return 4.2;
  // 撃墜されたときは爆発と無線を見せ終わるまで待つ
  if (opts.deathRemaining !== undefined) return Math.max(LOSS_READ_DELAY, opts.deathRemaining + 0.4);
  return LOSS_READ_DELAY;
}

/**
 * HUD へ渡す目標表示 (T2-⑧)。
 *
 * かつてはここで「必須か加点か」を加点表記の区切り記号から、
 * 「残り秒」を `残り 42s` の正規表現から**逆算していた**。
 * 表示文を1文字変えると判定が黙って壊れる経路だったので、
 * `MissionRunner.objectiveViews()` が `required` と `timeLeftSec` を
 * 構造として返すようにし、ここは素通しにした。
 * HUD 側はこの構造を見て3行に絞る (`hud/objectiveLines.ts`)。
 */
export function hudObjectiveViews(views: readonly ObjectiveView[]): ObjectiveView[] {
  return views.map((v) => ({ ...v }));
}

/*
 * エースの脱出ポッドの tag 接頭辞。
 *
 * 定義は `sim/eject.ts`（ポッドを作る側）に置き、ここは再輸出だけにする。
 * 同じ文字列を2箇所に書くと、`MissionRunner` の誤射・民間損害の除外判定
 * （`isAcePodTag`）と、ここのポッド生成がずれても気付けない。
 */
export { ACE_POD_TAG_PREFIX } from '../sim/eject';

/** 脱出ポッドの tag からエースidを取り出す（ポッドでなければ undefined）。 */
export function aceIdFromPodTag(tag: string | undefined): string | undefined {
  if (!tag || !tag.startsWith(ACE_POD_TAG_PREFIX)) return undefined;
  return tag.slice(ACE_POD_TAG_PREFIX.length) || undefined;
}

/**
 * 撃墜したエースの脱出ポッドを置く（T4-⑯）。
 *
 * ■ なぜ「撃てるもの」として出すのか
 * 「撃たない」を選択にするには、撃てる的が実際に空域に残っていなければならない。
 * そこで機体と同じ `ship` エンティティとして出し、`sim/eject.ts` の
 * プレイヤー用ポッドと同じ扱い（中立・武装なし・機動なし・小さい）に落とす。
 * - 中立なので **敵は撃たない**
 * - `ship.ejected = true` にしてあるので、`sim/ai.ts` の規則で **味方の AI も撃たない**
 * - `sim/targeting.ts` は敵対勢力しか選ばないので **ロックもできない**
 *   （撃つには手動で狙う必要がある = 事故で撃つことがない）
 *
 * つまり「撃つ」は必ずプレイヤーの意思になる。
 */
export function spawnAcePod(
  world: World,
  o: { aceId: string; pilot: string; def: ShipDef; pos: Vector3; quat: Quaternion; vel: Vector3 },
): Entity {
  const e = spawnShip(world, {
    def: o.def,
    faction: 'neutral',
    pos: o.pos,
    quat: o.quat,
    speed: 0,
    label: `脱出ポッド (${o.pilot})`,
    tag: `${ACE_POD_TAG_PREFIX}${o.aceId}`,
    pilot: o.pilot,
    // 推力を入れない。`cruiseTo` を現在地にしておくと `doCruise` が
    // 「到着済み」と判断してスロットルを 0 にするので、ポッドは漂うだけになる。
    ai: newAi(0, { passive: true, mode: 'idle', cruiseTo: o.pos.clone() }),
  });
  const ship = e.ship!;
  ship.ejected = true;
  ship.missiles = [];
  ship.flares = 0;
  ship.energy = 0;
  ship.shield = { front: 0, rear: 0 };
  ship.armor = { front: 0, rear: 0, left: 0, right: 0 };
  ship.hull = 24;
  ship.subsystems = undefined;
  e.radius = Math.max(3, o.def.radius * 0.25);
  // 撃墜された機体の勢いを少しだけ引き継いで漂う
  e.vel.copy(o.vel).multiplyScalar(0.3);
  return e;
}

/**
 * 「敵エースの誓約」を保存データから読む。
 *
 * `Loadout` にも `narrative.ts` にも手を入れずに値を得るための経路。
 * 読めないとき（訓練出撃・保存なし・テスト環境）は中庸の 50 を返すので、
 * 誓約値が理由で決闘を断られることはない。
 */
export function readAceOath(): number {
  try {
    const oath = loadSave()?.narrative?.aceOath;
    return typeof oath === 'number' && Number.isFinite(oath) ? oath : 50;
  } catch {
    return 50;
  }
}

/**
 * プレイヤーが申し込んで成立した決闘の規約 (T4-⑯)。
 *
 * ミッション宣言の決闘（`MissionRunner`）とは**別物**で、こちらは
 * **相手の陣営全体を退かせる**（一対一を成立させるのが交渉の目的なので）。
 * 数値をここに集めてあるのは、テストが同じ値を写さずに済むようにするため。
 *
 * 変えるのは「狙い方」だけで、技量・攻撃力・弾速・出現数には触れない。
 * - `spareHullRatio` ハルがこの割合を下回った相手には引き金を引かない
 * - `measureRange` この距離を保って機動に追随する（癖を測る）
 * - `standDownFaction` この陣営の**当事者以外**は自機を狙わず撃たない
 */
export function playerDuelRules(o: {
  duellistId: number;
  opponentId: number;
  faction: Entity['faction'];
}): {
  duellistId: number;
  opponentId: number;
  spareHullRatio: number;
  measureRange: number;
  standDownFaction: Entity['faction'];
} {
  return {
    duellistId: o.duellistId,
    opponentId: o.opponentId,
    spareHullRatio: 0.12,
    measureRange: 700,
    standDownFaction: o.faction,
  };
}

/** 画面中央に出す告知の種類。 */
export type CasualtyKind = 'wingman' | 'escort' | 'player';

/**
 * 画面中央の告知文。
 *
 * 僚機の戦死・護衛対象の喪失・自機の撃墜は**別の語**で書く。
 * 同じ枠に同じ文言で出すと、何を失ったのか区別できない。
 */
export function casualtyBanner(
  kind: CasualtyKind,
  name = '',
): { title: string; note: string; durationMs: number } {
  if (kind === 'wingman') return { title: `${name} 戦死`, note: '編隊から1機失った', durationMs: 2600 };
  if (kind === 'escort') return { title: `${name} 喪失`, note: '護衛対象が撃沈された', durationMs: 2800 };
  return { title: '撃墜された', note: '機体喪失 — 記録に残る', durationMs: PLAYER_DEATH_HOLD * 1000 };
}

/**
 * 自機撃墜からの「間」を持つ小さな状態機械。
 *
 * Game から切り出してあるのは、**入力を止めている条件を単体テストできる**ようにするため。
 * 「間の最中か (`locked`)」と「撃墜されたか (`down`)」を分けて持つ。
 * 間が明けた後も `down` は真のままで、終了処理は撃墜として扱える。
 */
export class DeathHold {
  private left = 0;
  private started = false;

  /** 演出を始める。すでに始まっていれば false を返し、二重に始めない。 */
  begin(seconds: number = PLAYER_DEATH_HOLD): boolean {
    if (this.started) return false;
    this.started = true;
    this.left = seconds;
    return true;
  }

  tick(dt: number): void {
    if (this.left > 0) this.left = Math.max(0, this.left - dt);
  }

  /** 入力を捨てている間か。 */
  get locked(): boolean {
    return this.left > 0;
  }

  /** 撃墜されたか (間が明けた後も真)。 */
  get down(): boolean {
    return this.started;
  }

  get remaining(): number {
    return this.left;
  }

  reset(): void {
    this.left = 0;
    this.started = false;
  }
}

/**
 * 戦闘部分の本体。固定 dt でシミュレーションを進め、可変 dt で描画する。
 * 画面遷移 (タイトル/ブリーフィング等) は App が受け持ち、
 * Game は「いま飛んでいるミッション」だけを見る。
 */
export class Game {
  readonly world = new World();
  readonly scene: SceneSetup;
  private landmarks: Landmarks;
  readonly rig: CameraRig;
  readonly sync: RenderSync;
  readonly vfx: CombatVfx;
  readonly hud: HudView;
  readonly comms: CommsMenu;
  readonly tutorial: Tutorial;
  readonly sound = new CombatAudio();
  /** 発艦・着艦の演出 */
  readonly deck = new DeckSequence();
  readonly input: InputManager;
  readonly replay = new ReplayBuffer();
  /** 人間の通しプレイを任務単位で記録し、デブリーフから書き出せるログ。 */
  readonly playtestLog = new PlaytestLog();
  readonly loop: Loop;

  /** 実行中のミッション。メニュー中は undefined */
  runner?: MissionRunner;
  /** ミッション終了時に App へ通知する */
  onMissionEnd?: (outcome: 'win' | 'loss') => void;
  /** Esc が押されたことを App に伝える (ポーズ画面は App が出す) */
  onPauseRequested?: () => void;

  /** 戦闘中か (false ならメニュー表示中) */
  active = false;
  /** ポーズ中はシミュレーションを止めるが描画は続ける */
  paused = false;
  /** オートパイロット作動中 */
  autopilot = false;
  /** チュートリアル中は操作確認を優先し、敵弾で中断されないようにする */
  private tutorialSafe = false;
  /** オートパイロットの目的地 (作動開始時に固定する) */
  private autopilotNavId?: number;
  /** 戦域離脱としてのオートパイロット (敵がいても継続する) */
  private autopilotEscaping = false;
  /** ジャンプ演出の現在値 (0..1) */
  private warpLevel = 0;
  /** 撃墜演出の残り秒数 (スローモーション) */
  private killCamLeft = 0;

  /** 撃墜時などに一瞬だけ時間を止める残り時間 (秒) */
  private hitStopLeft = 0;
  private damageSlowLeft = 0;
  /** 脱出の確認が有効な残り時間 (秒) */
  private ejectArmed = 0;
  /** 損傷時の無線を間隔を空けて流すためのタイマー */
  private damagedChatter = 0;
  /** 障害物警告の再通知までの残り秒数 */
  private hazardWarn = 0;
  private readonly tmpFwd = new Vector3();
  private readonly tmpTo = new Vector3();
  /** 自機の被弾段階。段階が進んだ瞬間だけ警告する */
  private playerStage: DamageStage = 'shield-ok';
  /** 僚機ごとの被弾段階。同じ段階で何度も喋らせない */
  private wingmanStages = new Map<number, DamageStage>();
  /** 護衛対象ごとの被弾段階 (対象の列挙と名前は MissionRunner が唯一の出所) */
  private escortStages = new Map<number, DamageStage>();
  /**
   * 出撃中のロードアウト。`aceStates`（章をまたぐ宿敵の記録）を読み書きするために保持する。
   * `MissionRunner` が持つものと**同じ配列の参照**なので、両方の記録が同じ状態へ入る。
   */
  private loadout?: Loadout;
  /**
   * 「敵エースの誓約」0..100。決闘の申し込みを受けてもらえるかの判定に使う。
   *
   * `narrative.ts` / `App.ts` は別担当のため、`Loadout` に足さず
   * 保存データから直接読む（`MissionRunner` が `choices` で使っているのと同じ方法）。
   */
  aceOath = 50;
  /** この出撃で名を交換したエースid。決闘の書式（名の交換）の判定に使う */
  private acesNamed = new Set<string>();
  /** この出撃で第一声を流したエースid。再会の挨拶は1回だけ */
  private acesGreeted = new Set<string>();
  /** 空域に残っているエースの脱出ポッド (entity id → エースid) */
  private acePods = new Map<number, string>();
  /** 次の固定ステップで出すポッド（`destroyed` の最中に entity を増やさない） */
  private pendingAcePods: Array<{
    aceId: string;
    pilot: string;
    def: ShipDef;
    pos: Vector3;
    quat: Quaternion;
    vel: Vector3;
  }> = [];
  /**
   * 成立している決闘の相手（エースid）。無ければ undefined。
   * HUD へ「決闘中」を出したい場合はこの値を読めばよい（HUD 側は別担当のため触っていない）。
   */
  duelAceId?: string;
  /** 自機撃墜の余韻。`locked` の間は入力を受け付けない */
  private readonly death = new DeathHold();
  /** 撃墜された自機。カメラを爆発へ向けるために参照を保つ */
  private deathEntity?: Entity;
  /** ミッション終了後、デブリーフへ移るまでの余韻 */
  private endDelay = 0;
  private endedOutcome?: 'win' | 'loss';
  private unsubs: Array<() => void> = [];
  private activePlaytest?: PlaytestRecorder;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.scene = new SceneSetup(canvas);
    this.rig = new CameraRig(this.scene.camera);
    this.sync = new RenderSync(this.scene.scene);
    this.landmarks = new Landmarks(this.scene.scene);
    this.vfx = new CombatVfx(this.scene.scene, this.rig, (ms) => this.triggerHitStop(ms));
    this.hud = new HudView(overlay);
    this.comms = new CommsMenu(overlay, (a) => this.onComms(a));
    this.tutorial = new Tutorial(overlay);
    // HUD オーバーレイは pointer-events: none なので、ホイールは canvas で受ける。
    this.input = new InputManager(canvas);
    this.sound.setCamera(this.scene.camera);
    // 自動再生制限があるので、最初の操作で音を起こす
    const wake = () => {
      audio.resume();
      this.sound.music.start();
    };
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
    this.loop = new Loop({
      fixed: (dt) => this.fixedStep(dt),
      render: (dtReal, alpha) => this.renderStep(dtReal, alpha),
    });

    this.applySettings();
    window.addEventListener('resize', () => this.scene.resize());

    this.unsubs.push(
      bus.on('destroyed', (p) => this.onDestroyedCinematic(p.target, p.killedByPlayer)),
      bus.on('shieldHit', (p) => { if (p.isPlayer) this.input.rumble(0.22, 65); }),
      bus.on('armorHit', (p) => { if (p.isPlayer) this.input.rumble(p.layer === 'hull' ? 0.6 : 0.35, 110); }),
      bus.on('armorHit', (p) => { if (p.isPlayer && settings.timeSlowAssist) this.damageSlowLeft = 0.28; }),
      bus.on('destroyed', (p) => {
        if (p.target.kind === 'ship') this.replay.mark(`${p.target.ship?.pilot ?? p.target.label ?? '機体'} 撃墜`);
      }),
      bus.on('destroyed', (p) => this.onCasualty(p.target)),
      // 宿敵の脱出ポッド (T4-⑯)。撃墜されたエースの座席を出し、撃たれたかを記録する
      bus.on('destroyed', (p) => this.onAceDestroyed(p.target)),
      bus.on('destroyed', (p) => this.onAcePodDestroyed(p.target, p.killedByPlayer)),
      // 空域に残ったポッドは「撃たなかった」として確定させる
      bus.on('missionEnded', () => this.settleAcePods()),
      bus.on('missionEnded', (p) => {
        if (this.activePlaytest) {
          this.playtestLog.complete(this.activePlaytest);
          this.activePlaytest = undefined;
        }
        if (this.endedOutcome) return;
        this.endedOutcome = p.outcome;
        // 勝ったときは着艦の演出を挟んでから画面を切り替える
        const player = this.world.player;
        const landing = p.outcome === 'win' && !!player && !player.ship?.ejected;
        if (landing && player) this.deck.startLanding(this.world, player);
        this.endDelay = endDelayFor(p.outcome, {
          landing,
          deathRemaining: this.death.down ? this.death.remaining : undefined,
        });
        // 達成度は3段階 (T1-①)。見出しの語は MISSION_GRADE_LABEL を唯一の出所にして、
        // デブリーフ (App 側) と飛行中のアナウンスで違う言い方にならないようにする。
        const grade: MissionGrade = this.runner?.grade ?? (p.outcome === 'win' ? 'complete' : 'failed');
        bus.emit('announce', {
          text: MISSION_GRADE_LABEL[grade],
          kind: grade === 'complete' ? 'good' : grade === 'partial' ? 'warn' : 'bad',
          durationMs: 3000,
        });
      }),
    );
  }

  applySettings(): void {
    const d = difficulty();
    setCombatOptions({
      playerDamageTaken: this.tutorialSafe ? 0 : d.playerDamageTaken,
      playerDamageDealt: d.playerDamageDealt,
      playerSubsystemRate: d.playerSubsystemRate,
    });
    this.input.mouseFlight = settings.mouseFlight;
    this.scene.setBloom(settings.bloom);
  }

  applyDifficulty(): void {
    // 難易度変更を呼ぶ既存箇所との互換用。描画・入力設定も同時に反映する。
    this.applySettings();
  }

  /**
   * 山場の撃墜だけカメラを寄せてスローにする。
   *
   * 全部の撃墜でこれをやると忙しくて読めないので、
   * 「エースを自分で落としたとき」と「艦艇が沈むとき」に限る。
   */
  private onDestroyedCinematic(target: Entity, killedByPlayer: boolean): void {
    if (!this.active || target.kind !== 'ship' || !target.ship) return;
    const isAce = !!target.ship.ace;
    const isCapital = target.ship.def.role === 'capital';
    if (!(isAce && killedByPlayer) && !isCapital) return;
    // 演出が重なると止まりっぱなしになる
    if (this.killCamLeft > 0) return;

    this.killCamLeft = isCapital ? 2.6 : 1.8;
    this.rig.focusOn(target.pos, this.killCamLeft);
    if (isAce) {
      bus.emit('announce', {
        text: `★ ${target.ship.pilot ?? target.label ?? 'エース'} 撃墜`,
        kind: 'good',
        durationMs: 2600,
      });
    }
  }

  /** 自機の僚機か (編隊長が自機の戦闘機)。 */
  private isWingman(e: Entity, playerId: number): boolean {
    return (
      e.kind === 'ship' &&
      !!e.ship &&
      e.id !== playerId &&
      e.ai?.leaderId === playerId &&
      // 輸送艦・艦艇は編隊に付いていても僚機として扱わない (護衛対象は別の扱い)
      (e.ship.def.role === 'fighter' || e.ship.def.role === 'bomber')
    );
  }

  /**
   * 守る対象か。判定と名前は `MissionRunner` が唯一の出所 (T1-①)。
   * ここで章ごとの推測をしない。
   */
  private isEscortTarget(e: Entity): boolean {
    return e.kind === 'ship' && !!e.ship && !!this.runner?.isEscortTarget(e);
  }

  /** 無線の話者名。名簿由来の呼び名 (`ship.pilot`) をそのまま使う。 */
  private speakerOf(e: Entity): string {
    return e.ship?.pilot ?? e.label ?? '僚機';
  }

  /** 性格。名簿に載っていない僚機は既定の「堅実」として扱う。 */
  private personalityOf(e: Entity): PersonalityId {
    const callsign = e.ship?.pilot;
    return PILOTS.find((p) => p.callsign === callsign)?.personality ?? 'steady';
  }

  /**
   * 戦死を「事件」にする (T1-②)。
   *
   * 右上の撃墜ログだけでは見落とすので、
   * 僚機の戦死は画面中央に名前を出し、他の僚機か管制が1本反応する。
   * 自機の撃墜は専用の演出へ回す。
   */
  private onCasualty(target: Entity): void {
    if (!this.active || target.kind !== 'ship' || !target.ship) return;
    const playerId = this.world.playerId;
    if (target.id === playerId) {
      this.onPlayerDown(target);
      return;
    }
    // 護衛対象の喪失。僚機の戦死と混ざらないよう「喪失」の語と別の説明にする。
    if (this.isEscortTarget(target)) {
      const shipName = displayNameOf(target);
      this.escortStages.delete(target.id);
      const banner = casualtyBanner('escort', shipName);
      this.hud.showCasualty(banner.title, banner.note, banner.durationMs);
      bus.emit('radio', {
        speaker: '管制',
        text: controlEscortLostLine(shipName),
        tone: 'command',
      });
      return;
    }
    if (!this.isWingman(target, playerId)) return;

    const name = this.speakerOf(target);
    this.wingmanStages.delete(target.id);
    const banner = casualtyBanner('wingman', name);
    this.hud.showCasualty(banner.title, banner.note, banner.durationMs);
    // 反応は1本だけ。他の僚機が生きていればその僚機、いなければ管制。
    const other = this.world.entities.find(
      (e) => e.alive && e.id !== target.id && this.isWingman(e, playerId),
    );
    if (other) {
      bus.emit('radio', {
        speaker: this.speakerOf(other),
        text: mournLine(this.personalityOf(other)),
        tone: 'friendly',
      });
    } else {
      bus.emit('radio', {
        speaker: '管制',
        text: controlWingmanLostLine(name),
        tone: 'command',
      });
    }
  }

  /**
   * 自機撃墜。即暗転せず、爆発を見せてから画面を切り替える。
   *
   * - カメラを機外へ出して爆発の方へ寄せる
   * - 画面中央に「撃墜された」を出す
   * - 管制の無線を1本入れる
   * - 間 (`DeathHold`) の最中はプレイヤー入力を受け付けない
   */
  private onPlayerDown(target: Entity): void {
    if (!this.death.begin(PLAYER_DEATH_HOLD)) return;
    this.deathEntity = target;
    // 機外から爆発を見せる。視点設定は次の出撃で cockpit に戻る。
    this.rig.mode = 'chase';
    this.rig.focusOn(target.pos, PLAYER_DEATH_HOLD);
    this.rig.addShake(0.9);
    const banner = casualtyBanner('player');
    this.hud.showCasualty(banner.title, banner.note, banner.durationMs);
    audio.damageStageCue('hull-critical');
    bus.emit('radio', { speaker: '管制', text: controlPlayerDownLine(), tone: 'command' });
  }

  /** 自機撃墜の余韻の最中か。true の間はプレイヤー入力を捨てる。 */
  get inputLocked(): boolean {
    return this.death.locked;
  }

  // ───────── 宿敵との関係 (T4-⑯) ─────────

  /** 章をまたぐ宿敵の記録。訓練出撃では空配列。 */
  private get aceStates(): AceState[] {
    return this.loadout?.aceStates ?? [];
  }

  /** その機体がエースなら、記録と定義をまとめて返す。 */
  private aceOf(e: Entity | undefined) {
    if (!e?.ship?.ace || !e.ship.pilot) return undefined;
    const id = aceIdForPilot(e.ship.pilot);
    const def = id ? aceDef(id) : undefined;
    if (!def) return undefined;
    return { def, state: aceState(this.aceStates, def.id) };
  }

  /** 生存している自機の僚機の数（決闘が一対一かの判定に使う）。 */
  private wingmanCount(): number {
    const playerId = this.world.playerId;
    return this.world.entities.filter((e) => e.alive && this.isWingman(e, playerId)).length;
  }

  /**
   * 再会の第一声（T4-⑯ ④）。
   *
   * 交戦距離に入ったところで1回だけ流す。文面は
   * 「初対面 / 逃げられた / 座席を残した / 誰かの座席を撃った」で変わる。
   * ここでは記録を**書き換えない**（遭遇の記録は `MissionRunner` が唯一の出所）。
   */
  private updateAceGreetings(): void {
    const player = this.world.player;
    if (!player) return;
    const states = this.aceStates;
    if (states.length === 0) return;
    const fleet = aceFleetMemory(states);
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship?.ace || e.ship.ejected) continue;
      const ace = this.aceOf(e);
      if (!ace?.state || this.acesGreeted.has(ace.def.id)) continue;
      if (e.pos.distanceToSquared(player.pos) > 7000 * 7000) continue;
      this.acesGreeted.add(ace.def.id);
      bus.emit('radio', {
        speaker: e.ship.pilot ?? ace.def.pilot,
        text: aceGreetingLine(ace.def, ace.state, fleet),
        tone: 'enemy',
      });
    }
  }

  /** エースが落ちたら、次のステップで脱出ポッドを出す。 */
  private onAceDestroyed(target: Entity): void {
    if (!this.active || target.kind !== 'ship' || !target.ship) return;
    // 座席が無い機体（輸送艦・艦艇）からは出ない
    if (target.ship.def.role !== 'fighter' && target.ship.def.role !== 'bomber') return;
    if (target.ship.ejected) return;
    const ace = this.aceOf(target);
    if (!ace?.state) return;
    this.pendingAcePods.push({
      aceId: ace.def.id,
      pilot: target.ship.pilot ?? ace.def.pilot,
      def: target.ship.def,
      pos: target.pos.clone(),
      quat: target.quat.clone(),
      vel: target.vel.clone(),
    });
  }

  /** 溜めておいたポッドを空域へ出す（entity 配列を走査中に増やさないため遅延させている）。 */
  private flushAcePods(): void {
    if (this.pendingAcePods.length === 0) return;
    const pending = this.pendingAcePods;
    this.pendingAcePods = [];
    for (const p of pending) {
      const pod = spawnAcePod(this.world, p);
      this.acePods.set(pod.id, p.aceId);
      bus.emit('announce', {
        text: `${p.pilot} 脱出 — 座席は撃たなくてよい`,
        kind: 'info',
        durationMs: 3200,
      });
      bus.emit('radio', {
        speaker: '管制',
        text: '脱出ポッドを確認。撃つ必要はない。判断は任せる。',
        tone: 'command',
      });
    }
  }

  /** ポッドが撃たれた。プレイヤーが撃ったときだけ「撃った」として記録する。 */
  private onAcePodDestroyed(target: Entity, killedByPlayer: boolean): void {
    const aceId = this.acePods.get(target.id);
    if (aceId === undefined) return;
    this.acePods.delete(target.id);
    if (!killedByPlayer) return;
    const state = aceState(this.aceStates, aceId);
    if (!state) return;
    recordAcePodExecuted(state, this.runner?.def?.id);
    bus.emit('announce', { text: '脱出ポッドを撃墜 — 記録に残る', kind: 'bad', durationMs: 3200 });
  }

  /**
   * 出撃終了時に、残っているポッドを「撃たなかった」として確定させる。
   * 見逃した相手は回収されて、次の章でまた出てくる（`recordAcePodSpared`）。
   */
  private settleAcePods(): void {
    if (this.acePods.size === 0) return;
    const missionId = this.runner?.def?.id;
    let spared = 0;
    for (const [entityId, aceId] of this.acePods) {
      const pod = this.world.entities.find((e) => e.id === entityId);
      if (!pod?.alive) continue;
      const state = aceState(this.aceStates, aceId);
      if (!state) continue;
      recordAcePodSpared(state, missionId);
      spared++;
    }
    this.acePods.clear();
    if (spared > 0) {
      bus.emit('radio', { speaker: '管制', text: allyRescueAckLine(), tone: 'command' });
    }
  }

  /** エース宛の通信（名乗る／降伏を勧める／決闘を申し込む）。 */
  private sendAceComms(kind: AceCommsKind): void {
    const player = this.world.player;
    if (!player) return;
    const target = this.world.byId(player.ship?.targetId);
    const ace = this.aceOf(target);
    if (!target || !ace) {
      bus.emit('announce', { text: 'エースを選択していない', kind: 'warn' });
      return;
    }
    const speaker = target.ship?.pilot ?? ace.def.pilot;
    const missionId = this.runner?.def?.id;
    bus.emit('radio', { speaker: '自機', text: playerAceHailLine(kind), tone: 'friendly' });

    if (kind === 'name') {
      this.acesNamed.add(ace.def.id);
      if (ace.state) recordAceNameExchange(ace.state, missionId);
      bus.emit('radio', { speaker, text: aceNameReplyLine(ace.def), tone: 'enemy' });
      return;
    }
    if (kind === 'surrender') {
      if (ace.state) recordAceSurrenderOffer(ace.state, missionId);
      bus.emit('radio', { speaker, text: aceSurrenderReplyLine(ace.def), tone: 'enemy' });
      // 降伏を勧められた側は、士気が折れかけていれば離脱へ寄る（撃墜以外の道を残す）
      if (target.ai && target.ai.morale < 0.5) {
        target.ai.morale = Math.max(0, target.ai.morale - 0.25);
      }
      return;
    }

    // 決闘の申し込み
    const verdict = evaluateDuelRequest({
      def: ace.def,
      state: ace.state,
      oath: this.aceOath,
      wingmen: this.wingmanCount(),
      namedThisSortie: this.acesNamed.has(ace.def.id),
      fleet: aceFleetMemory(this.aceStates),
    });
    if (ace.state) recordAceDuel(ace.state, verdict.accepted, missionId);
    if (!verdict.accepted) {
      bus.emit('radio', {
        speaker,
        text: aceDuelDeclineLine(ace.def, verdict.reason!),
        tone: 'enemy',
      });
      bus.emit('announce', { text: '決闘は成立しなかった', kind: 'warn', durationMs: 2600 });
      return;
    }
    this.duelAceId = ace.def.id;
    // AI の狙い方を差し替える。技量・攻撃力・出現数は変えない。
    configureDuel(
      playerDuelRules({ duellistId: target.id, opponentId: player.id, faction: target.faction }),
    );
    if (target.ai) {
      target.ai.targetId = player.id;
      target.ai.order = undefined;
    }
    if (target.ship) target.ship.targetId = player.id;
    bus.emit('radio', { speaker, text: aceDuelAcceptLine(ace.def), tone: 'enemy' });
    bus.emit('announce', {
      text: `決闘成立 — ${speaker} と一対一`,
      kind: 'good',
      durationMs: 3200,
    });
  }

  /** 通信メニューに「エース宛」を出すかどうかを毎フレーム更新する。 */
  private updateAceCommsTarget(): void {
    const player = this.world.player;
    const target = this.world.byId(player?.ship?.targetId);
    const ace = this.aceOf(target);
    this.comms.setAceTarget(ace ? target!.ship!.pilot ?? ace.def.pilot : undefined);
  }

  /**
   * 被弾を段階で伝える (T1-②)。
   *
   * 段階が**進んだ瞬間だけ**警告する。同じ段階に留まっている間は
   * 連続警報 (CombatAudio) が受け持つので、ここでは何もしない。
   */
  private updateDamageStages(): void {
    const player = this.world.player;
    if (player?.ship && !player.ship.ejected) {
      const stage = damageStage(healthRatios(player));
      if (stageWorsened(this.playerStage, stage)) {
        this.hud.showDamageStage(stage);
        audio.damageStageCue(stage);
        if (stage === 'hull-critical') {
          bus.emit('radio', {
            speaker: '管制',
            text: '船体が保たない。Alt+E で脱出できる。判断は任せろ。',
            tone: 'command',
          });
        }
      }
      this.playerStage = stage;
    }

    // 護衛対象。沈むと必ず任務失敗になるので、僚機と同じ段階で伝える。
    // 対象の列挙と表示名は MissionRunner の公開 API から取る (推測しない)。
    for (const t of this.runner?.escortTargets() ?? []) {
      const e = this.world.byId(t.id);
      if (!e?.ship) continue;
      const stage = damageStage(healthRatios(e));
      const prev = this.escortStages.get(t.id) ?? 'shield-ok';
      this.escortStages.set(t.id, stage);
      if (!stageWorsened(prev, stage)) continue;
      if (stage !== 'shield-down' && stage !== 'armor-hit' && stage !== 'hull-critical') continue;
      bus.emit('radio', { speaker: t.name, text: escortDamageLine(stage), tone: 'friendly' });
      // ハル危険域だけは、見落とさないよう画面上部にも段階を出す
      if (stage === 'hull-critical') {
        bus.emit('announce', {
          text: `${t.name} 危険域 — 護衛対象を守れ`,
          kind: 'bad',
          durationMs: 2600,
        });
      }
    }

    const playerId = this.world.playerId;
    for (const e of this.world.entities) {
      if (!e.alive || !this.isWingman(e, playerId) || !e.ship) continue;
      const stage = damageStage(healthRatios(e));
      const prev = this.wingmanStages.get(e.id) ?? 'shield-ok';
      this.wingmanStages.set(e.id, stage);
      if (!stageWorsened(prev, stage)) continue;
      const personality = this.personalityOf(e);
      // ハル被弾 (hull-hit) は無線にしない。喋る回数を3段階に抑える。
      const text =
        stage === 'shield-down'
          ? wingmanShieldDownLine(personality)
          : stage === 'armor-hit'
            ? wingmanArmorLine(personality)
            : stage === 'hull-critical'
              ? wingmanCriticalLine(personality)
              : undefined;
      if (!text) continue;
      bus.emit('radio', { speaker: this.speakerOf(e), text, tone: 'friendly' });
    }
  }

  triggerHitStop(ms: number): void {
    this.hitStopLeft = Math.max(this.hitStopLeft, ms / 1000);
  }

  // ───────── ミッションの開始と終了 ─────────

  startMission(def: MissionDef, loadout: Loadout, withTutorial: boolean | TutorialMode = false): void {
    this.tutorialSafe = def.id.startsWith('tutorial-');
    this.runner?.dispose();
    this.vfx.vfx.clear();
    this.sync.clear();
    this.hud.resetTransientState();
    this.hud.damageMode = false;
    if (def.skybox) this.scene.setSkybox(def.skybox);
    this.landmarks.set(def.landmarks);

    this.applySettings();
    this.input.drainPlaytestLatency();
    this.activePlaytest = this.playtestLog.begin({
      missionId: def.id,
      missionTitle: def.title,
      shipId: loadout.shipId,
      difficultyId: difficulty().id,
    });
    this.runner = new MissionRunner(this.world, def, loadout, difficulty(), this.activePlaytest);
    this.replay.reset();
    // 宿敵との関係 (T4-⑯)。記録は Loadout と同じ配列を共有する
    this.loadout = loadout;
    this.acesNamed.clear();
    this.acesGreeted.clear();
    this.acePods.clear();
    this.pendingAcePods.length = 0;
    this.duelAceId = undefined;
    this.aceOath = readAceOath();
    this.runner.build();

    this.endedOutcome = undefined;
    this.endDelay = 0;
    this.playerStage = 'shield-ok';
    this.wingmanStages.clear();
    this.escortStages.clear();
    this.death.reset();
    this.deathEntity = undefined;
    this.ejectArmed = 0;
    this.damagedChatter = 0;
    this.hazardWarn = 0;
    this.warpLevel = 0;
    this.killCamLeft = 0;
    this.autopilot = false;
    this.autopilotNavId = undefined;
    this.autopilotEscaping = false;
    this.paused = false;
    this.active = true;
    this.input.uiMode = false;
    this.input.commsMode = false;
    this.input.resetTutorialInputFlags();
    this.input.disarmMouse();
    this.comms.setOpen(false);
    // 出撃直後は静止から。やさしい難易度では初速が入る
    this.input.throttle = this.world.player ? this.world.player.input!.throttle : 0;
    this.rig.mode = 'cockpit';
    if (withTutorial) this.tutorial.start(withTutorial === true ? 'simple' : withTutorial);
    else this.tutorial.finish(false);

    // 発艦シーケンス。母艦から撃ち出されるところから始める
    this.deck.reset();
    const player = this.world.player;
    if (player) this.deck.startLaunch(this.world, player);
  }

  /** メニューへ戻る (シミュレーションを止める) */
  suspend(): void {
    this.active = false;
    this.input.uiMode = true;
    this.comms.setOpen(false);
    // 訓練の帯は HUD の一部ではないので、飛行が終わったら明示的に消す (T2-⑭)。
    this.tutorial.finish(false);
  }

  endMission(): void {
    // ワールドを捨てる前に、残っているポッドを「撃たなかった」として確定させる
    this.settleAcePods();
    this.pendingAcePods.length = 0;
    this.acesNamed.clear();
    this.acesGreeted.clear();
    this.duelAceId = undefined;
    this.loadout = undefined;
    this.comms.setAceTarget(undefined);
    this.death.reset();
    this.deathEntity = undefined;
    this.wingmanStages.clear();
    this.escortStages.clear();
    this.playerStage = 'shield-ok';
    this.deck.reset();
    this.tutorial.finish(false);
    audio.stopEngine();
    this.runner?.dispose();
    this.runner = undefined;
    this.world.reset();
    this.sync.clear();
    this.vfx.vfx.clear();
    this.tutorialSafe = false;
    this.applySettings();
    this.suspend();
  }

  start(): void {
    this.loop.start();
  }

  // ───────── シミュレーション ─────────

  private fixedStep(dt: number): void {
    if (!this.active || this.paused) return;

    // パッドのサンプリングを固定ステップ側で行う。描画側で読むと、入力を読んだ
    // フレームの後にシミュレーションが終わってしまい、最大 1 フレーム遅れる。
    this.input.update(dt);
    this.activePlaytest?.recordInputLatency(this.input.drainPlaytestLatency());
    // 撃墜の余韻。終了処理より先に減らすので、終了待ちの間も間が保たれる
    this.death.tick(dt);

    /*
     * 収容 (T4-⑮) を止めてよい状況を Runner へ伝える。
     *
     * 収容は「低速でポッドに近づいたら自動的に始まる」設計なのでキー入力を持たない。
     * そのぶん、機体を操れない間に勝手に拾ってしまわないよう、
     * 演出中（発艦・着艦）と撃墜の余韻、任務終了後はここで抑止する。
     * この3つは Game しか知らないので、判定を Runner に持たせず外から渡す。
     */
    if (this.runner) {
      this.runner.recoverySuspended = this.deck.active || this.inputLocked || !!this.endedOutcome;
    }

    // ミッション終了後の余韻。演出だけ進めて入力は受け付けない
    if (this.endedOutcome) {
      this.endDelay -= dt;
      snapshotForRender(this.world);
      this.deck.update(this.world, dt);
      simulateStep(this.world, dt, {
        flightMode: settings.flightMode,
        ai: this.aiOptions(),
        playerGunAimPitchOffset: AIM_PITCH_OFFSET,
        playerWeaponModifiers: difficulty(),
      });
      if (this.endDelay <= 0) {
        const outcome = this.endedOutcome;
        this.endedOutcome = undefined;
        this.active = false;
        // 出撃が終わったら訓練の表示を消す (T2-⑭)。
        // `endMission()` はデブリーフの後まで呼ばれないので、ここで畳まないと
        // 艦内ハブ画面にまで訓練の帯が残る。
        this.tutorial.finish(false);
        this.onMissionEnd?.(outcome);
      }
      return;
    }

    if (this.ejectArmed > 0) this.ejectArmed -= dt;
    if (this.hitStopLeft > 0) {
      this.hitStopLeft -= dt;
      return;
    }
    this.damageSlowLeft = Math.max(0, this.damageSlowLeft - dt);

    snapshotForRender(this.world);

    // 発艦・着艦の演出中は台本が機体を動かす
    if (this.deck.update(this.world, dt)) {
      simulateStep(this.world, dt, {
        flightMode: settings.flightMode,
        ai: this.aiOptions(),
        playerGunAimPitchOffset: AIM_PITCH_OFFSET,
        playerWeaponModifiers: difficulty(),
      });
      this.runner?.update(dt);
      return;
    }

    if (this.autopilot) {
      const r = updateAutopilot(
        this.world,
        dt,
        this.autopilotNavId,
        this.autopilotEscaping,
      );
      if (!r.active) {
        this.autopilot = false;
        this.autopilotNavId = undefined;
        this.autopilotEscaping = false;
        audio.warpTone(false);
        bus.emit('autopilot', { active: false, reason: r.reason });
        if (r.reason) bus.emit('announce', { text: r.reason, kind: 'warn' });
        else if (r.arrived) bus.emit('announce', { text: 'ナビポイント到達', kind: 'good' });
      }
      // オートパイロット中も敵味方は動く (弾は飛んでこない距離のはず)
      const p = this.world.player;
      if (p?.input) {
        p.input.firePrimary = false;
        p.input.afterburner = false;
      }
    } else {
      this.applyPlayerInput();
    }

    simulateStep(this.world, dt, {
      flightMode: settings.flightMode,
      ai: this.aiOptions(),
      aimAssist: this.aimAssistStrength(),
      playerGunAimPitchOffset: AIM_PITCH_OFFSET,
      playerWeaponModifiers: difficulty(),
    });
    this.runner?.update(dt);
    this.replay.record(this.world, this.input, dt);
    // 宿敵の脱出ポッドは、撃墜処理が終わったここで空域へ出す
    this.flushAcePods();
    this.updateAceGreetings();
    this.updateDamageStages();
    this.updateDamagedReturn(dt);
    this.updateHazardWarning(dt);
  }

  /**
   * 進路上の障害物を警告する。
   *
   * 岩は暗くて速度が乗っていると気付くのが遅れる。
   * 「見えなかったのに死んだ」を避けるため、衝突までの時間で警告を出す。
   */
  private updateHazardWarning(dt: number): void {
    if (this.hazardWarn > 0) this.hazardWarn -= dt;
    const player = this.world.player;
    if (!player?.ship || this.hazardWarn > 0) return;
    const speed = player.vel.length();
    if (speed < 60) return;
    forwardOf(player.quat, this.tmpFwd);

    for (const e of this.world.entities) {
      if (!e.alive || (e.kind !== 'rock' && e.kind !== 'mine')) continue;
      this.tmpTo.copy(e.pos).sub(player.pos);
      const d = this.tmpTo.length();
      // 3秒先までに、進路の細い筒の中にあるものだけを見る
      if (d > speed * 3 + e.radius) continue;
      if (d < 1e-3) continue;
      const along = this.tmpTo.dot(this.tmpFwd);
      if (along <= 0) continue;
      const lateral = Math.sqrt(Math.max(0, d * d - along * along));
      if (lateral > e.radius + player.radius * 3 + 40) continue;
      this.hazardWarn = 2.6;
      bus.emit('announce', {
        text: e.kind === 'mine' ? '機雷 — 進路上' : '衝突警報 — 進路上に岩',
        kind: 'bad',
        durationMs: 1500,
      });
      return;
    }
  }

  /** 撃墜演出とポーズを合わせて時間の進み方を決める */
  private applyTimeScale(): void {
    if (this.paused || !this.active) {
      this.loop.timeScale = this.paused ? 0 : 1;
      return;
    }
    // 終わりかけで元に戻すと唐突なので、残り時間で補間する
    const t = this.killCamLeft > 0 ? Math.min(1, this.killCamLeft / 0.6) : 0;
    const damageAssist = settings.timeSlowAssist && this.damageSlowLeft > 0 ? 0.72 : 1;
    this.loop.timeScale = (1 - 0.62 * t) * damageAssist;
  }

  /**
   * 照準アシストの強さ。
   * 設定の ON/OFF と、難易度の strongAimHelp (やさしいのみ) を掛け合わせる。
   */
  private aimAssistStrength(): number {
    return aimAssistStrength(settings.aimAssist, difficulty().strongAimHelp);
  }

  /**
   * 損傷を抱えたまま帰投しているときの演出。
   *
   * 「深追いするか、壊れた機体で帰るか」の判断に温度を付けるため、
   * 損傷が深い状態で母艦へ向かっていると整備班と管制が反応する。
   */
  private updateDamagedReturn(dt: number): void {
    const player = this.world.player;
    if (!player?.ship || player.ship.ejected) return;
    const hullRatio = player.ship.hull / player.ship.def.hull;
    const hurt = hullRatio < 0.45 || hasDamage(player.ship);
    if (!hurt) {
      this.damagedChatter = 0;
      return;
    }
    this.damagedChatter += dt;
    if (this.damagedChatter < 22) return;
    this.damagedChatter = 0;
    if (hullRatio < 0.25) {
      bus.emit('radio', {
        speaker: '管制',
        text: 'そのままでは持たない。帰投を検討しろ。救助艇は出せる。',
        tone: 'command',
      });
    } else {
      bus.emit('radio', {
        speaker: '整備班',
        text: '機体の損傷を読んでいる。無理をするな、修理は俺たちの仕事だ。',
        tone: 'friendly',
      });
    }
  }

  private aiOptions() {
    const d = difficulty();
    return { maxAttackersOnPlayer: d.maxAttackers, enemyMissileRate: d.enemyMissileRate };
  }

  private applyPlayerInput(): void {
    const p = this.world.player;
    if (!p || !p.input) return;
    if (p.ship?.ejected) {
      // ポッドは操縦できない。漂うだけ
      p.input.throttle = 0;
      p.input.afterburner = false;
      p.input.firePrimary = false;
      p.input.pitch = 0;
      p.input.yaw = 0;
      p.input.roll = 0;
      return;
    }
    const im = this.input;
    const turn = settings.turnAssist ? this.turnAssist(p) : { pitch: 0, yaw: 0 };
    p.input.pitch = Math.max(-1, Math.min(1, im.pitch + turn.pitch));
    p.input.yaw = Math.max(-1, Math.min(1, im.yaw + turn.yaw));
    p.input.roll = settings.autoLevel && im.roll === 0 ? this.levelCorrection(p) : im.roll;
    p.input.throttle = im.throttle;
    p.input.afterburner = im.afterburner;
    p.input.firePrimary = im.firePrimary;
  }

  private turnAssist(player: Entity): { pitch: number; yaw: number } {
    const target = this.world.byId(player.ship?.targetId);
    if (!target) return { pitch: 0, yaw: 0 };
    this.tmpTo.copy(target.pos).sub(player.pos).normalize().applyQuaternion(player.quat.clone().invert());
    return { pitch: Math.max(-0.16, Math.min(0.16, -this.tmpTo.y * 0.16)), yaw: Math.max(-0.16, Math.min(0.16, this.tmpTo.x * 0.16)) };
  }

  private levelCorrection(player: Entity): number {
    this.tmpFwd.set(0, 1, 0).applyQuaternion(player.quat);
    return Math.max(-0.32, Math.min(0.32, -this.tmpFwd.x * 0.9));
  }

  // ───────── 描画 ─────────

  private renderStep(dtReal: number, alpha: number): void {
    // 通信メニューの項目は「いま何を狙っているか」で入れ替わる (T4-⑯)。
    // 入力を処理する前に更新しないと、開いた瞬間の 6 番が1フレーム古くなる。
    if (this.active) this.updateAceCommsTarget();
    if (this.active) this.handleActions();
    else this.input.consumeActions();

    const player = this.world.player;
    const frozen = this.paused || !this.active;
    this.sync.hidePlayer = this.rig.mode === 'cockpit';
    this.scene.cockpit.setVisible(this.active && this.rig.mode === 'cockpit' && settings.cockpitDecorations);
    // 機内灯をハル残量に追従させる (被弾が深いほど橙へ寄る)。点滅はしない。
    this.scene.cockpit.update(
      player?.ship ? player.ship.hull / Math.max(1, player.ship.def.hull) : 1,
    );
    this.hud.setCockpitDecorations(settings.cockpitDecorations);
    // 外部視点 (F) では DOM の計器盤を隠し、最小 HUD に置き換える。
    // 視点を切り替えたことが一目で分かるようにする。
    this.hud.setExternalView(this.rig.mode !== 'cockpit');
    this.scene.dust.setVisible(this.active);
    // ジャンプ演出は描画側の時間で滑らかに立ち上げる
    const warpTarget = this.autopilot ? 1 : 0;
    this.warpLevel += (warpTarget - this.warpLevel) * Math.min(1, dtReal * 4);
    this.scene.dust.setWarp(this.warpLevel);
    this.scene.setWarp(this.warpLevel);
    this.rig.setWarpFov(this.warpLevel * 16);
    if (this.active) this.scene.dust.update(player);
    this.sync.sync(this.world, frozen ? 1 : alpha, this.scene.camera.position, dtReal);
    if (!frozen) this.vfx.update(this.world, dtReal);
    // 撃墜演出中は時間を落とす。ポーズ中は進めない
    if (this.killCamLeft > 0 && !this.paused) {
      this.killCamLeft -= dtReal;
      if (this.killCamLeft <= 0) {
        this.killCamLeft = 0;
        this.rig.clearFocus();
      }
    }
    this.applyTimeScale();

    const abActive = !!player?.input?.afterburner && (player.ship?.fuel ?? 0) > 0;
    // 撃墜されて自機を失った後も、爆発の場所を見せるためにカメラだけは動かす
    const camTarget = player ?? (this.death.locked ? this.deathEntity : undefined);
    this.rig.update(camTarget, dtReal, abActive || this.autopilot);
    this.scene.render();
    this.sound.update(this.world, dtReal, this.active && !this.paused);
    if (this.active && !this.paused) {
      this.tutorial.update(
        {
          world: this.world,
          input: this.input,
          autopilot: this.autopilot,
          commsOpen: this.comms.open,
          navMapOpen: this.hud.navMap.open,
        },
        dtReal,
      );
    }

    this.hud.update(
      {
        world: this.world,
        camera: this.scene.camera,
        width: window.innerWidth,
        height: window.innerHeight,
        throttle: this.input.throttle,
        playerGunSpeedScale: difficulty().playerGunSpeedScale,
        mouseFlight: this.input.mouseStickEnabled && !this.autopilot,
        mouseArmPending:
          this.input.mouseFlight && !this.input.gamepadConnected && !this.input.mouseArmed,
        stick: { x: this.input.mousePx, y: this.input.mousePy },
        // 必須／加点と残り秒を足してから渡す (HUD が3行に絞る材料にする)
        objectives: this.runner ? hudObjectiveViews(this.runner.objectiveViews()) : undefined,
        nav: this.runner?.currentNav,
        autopilot: this.autopilot,
        visible: this.active,
      },
      dtReal,
    );
  }

  private handleActions(): void {
    const player = this.world.player;
    const actions = this.input.consumeActions();
    // ポーズ中の入力は ScreenHost 側が処理する
    if (this.paused) return;
    // 撃墜の余韻中は何も受け付けない。
    // 入力は上で捨てているので、間が明けた直後に溜まった操作が暴発しない。
    if (this.inputLocked) return;
    for (const a of actions) {
      switch (a) {
        case 'pause':
          this.tutorial.noteAction(a);
          this.onPauseRequested?.();
          break;
        case 'viewToggle':
          this.tutorial.noteAction(a);
          this.rig.toggle();
          break;
        case 'damageDisplay':
          this.tutorial.noteAction(a);
          this.hud.damageMode = !this.hud.damageMode;
          break;
        case 'hudPanelToggle':
          this.tutorial.noteAction(a);
          this.hud.toggleRightVduPage();
          break;
        case 'navMap':
          this.tutorial.noteAction(a);
          this.hud.navMap.toggle();
          break;
        case 'comms':
          this.tutorial.noteAction(a);
          if (!commsAvailable(player?.ship)) {
            bus.emit('announce', { text: '通信機が故障している', kind: 'bad' });
            break;
          }
          this.comms.toggle();
          this.input.commsMode = this.comms.open;
          break;
        case 'comms1':
        case 'comms2':
        case 'comms3':
        case 'comms4':
        case 'comms5':
        case 'comms6':
          this.comms.pickIndex(Number(a.slice(5)) - 1);
          this.input.commsMode = this.comms.open;
          break;
        case 'mouseToggle':
          this.tutorial.noteAction(a);
          this.input.mouseFlight = !this.input.mouseFlight;
          bus.emit('announce', {
            text: `マウス操縦: ${this.input.mouseFlight ? 'ON' : 'OFF'}`,
          });
          break;
        case 'autopilot':
          this.tutorial.noteAction(a);
          this.toggleAutopilot();
          break;
        case 'targetNext':
          if (player && !targetNext(this.world, player)) {
            bus.emit('announce', { text: 'ターゲット可能な敵影なし', kind: 'info', durationMs: 1200 });
          }
          break;
        case 'targetNearest':
          if (player && !targetNearest(this.world, player)) {
            bus.emit('announce', { text: 'ターゲット可能な敵影なし', kind: 'info', durationMs: 1200 });
          }
          break;
        case 'targetFront':
          if (player && !targetFront(this.world, player)) {
            bus.emit('announce', { text: '正面にターゲット可能な敵影なし', kind: 'info', durationMs: 1200 });
          }
          break;
        case 'nextSecondary':
          this.tutorial.noteAction(a);
          if (player) cycleMissile(player);
          break;
        case 'fireMissile':
          this.tutorial.noteAction(a);
          if (player && !this.autopilot) {
            const r = fireMissile(this.world, player, difficulty());
            if (!r.fired) {
              bus.emit('announce', {
                text:
                  r.reason === 'no-lock'
                    ? 'ロックしていない'
                    : r.reason === 'invalid-target'
                      ? '対艦魚雷は大型目標を選択してください'
                      : 'ミサイル切れ',
                kind: 'warn',
              });
            }
          }
          break;
        case 'flare':
          this.tutorial.noteAction(a);
          if (player && !dropFlare(this.world, player)) {
            bus.emit('announce', { text: 'フレアなし', kind: 'warn' });
          }
          break;
        case 'eject':
          this.tryEject();
          break;
        case 'flightModeToggle':
          this.tutorial.noteAction(a);
          if (settings.advanced) {
            settings.flightMode = settings.flightMode === 'wc' ? 'newton' : 'wc';
            bus.emit('announce', { text: `飛行モード: ${settings.flightMode.toUpperCase()}` });
          }
          break;
        default:
          this.tutorial.noteAction(a);
          break;
      }
    }
  }

  /**
   * 脱出。取り返しがつかないので、1回目は確認、2回目で実行する。
   */
  private tryEject(): void {
    const player = this.world.player;
    if (!player) return;
    const check = canEject(player);
    if (!check.ok) {
      bus.emit('announce', { text: check.reason ?? '脱出できない', kind: 'warn' });
      return;
    }
    if (this.ejectArmed <= 0) {
      this.ejectArmed = 3;
      bus.emit('announce', {
        text: 'もう一度 Alt+E で脱出する',
        kind: 'bad',
        durationMs: 3000,
      });
      return;
    }
    this.ejectArmed = 0;
    eject(this.world, player);
  }

  private toggleAutopilot(): void {
    const player = this.world.player;
    if (!player) return;
    if (this.autopilot) {
      this.autopilot = false;
      this.autopilotNavId = undefined;
      this.autopilotEscaping = false;
      audio.warpTone(false);
      bus.emit('autopilot', { active: false });
      bus.emit('announce', { text: 'オートパイロット解除' });
      return;
    }
    // 戦闘目標を片付けていれば、敵がいても離脱できる
    const escaping = this.runner?.canDisengage ?? false;
    const check = canAutopilot(this.world, player, escaping);
    if (!check.ok) {
      bus.emit('announce', { text: check.reason ?? 'オートパイロット不可', kind: 'warn' });
      return;
    }
    this.autopilot = true;
    this.autopilotEscaping = escaping;
    this.autopilotNavId = nextNav(this.world)?.id;
    bus.emit('autopilot', { active: true });
    audio.warpTone(true);
    bus.emit('announce', {
      text: escaping ? '戦域離脱 — オートパイロット' : 'オートパイロット作動',
      kind: 'good',
    });
  }

  private onComms(a: CommsAction): void {
    this.input.commsMode = false;
    const player = this.world.player;
    if (!player) return;
    if (!commsAvailable(player.ship)) {
      bus.emit('announce', { text: '通信機が故障している', kind: 'bad' });
      return;
    }
    if (a.kind === 'order') {
      const changed = setWingmanOrder(this.world, a.order as WingmanOrder, player.id);
      if (changed.length === 0) {
        bus.emit('announce', { text: '応答する僚機がいない', kind: 'warn' });
        return;
      }
      const w = changed[0];
      bus.emit('radio', {
        speaker: w.ship?.pilot ?? w.label ?? '僚機',
        text: wingmanAck(a.order),
        tone: 'friendly',
      });
      return;
    }
    if (a.kind === 'ace') {
      this.sendAceComms(a.ace);
      return;
    }
    if (a.kind === 'taunt') {
      bus.emit('radio', { speaker: '自機', text: playerTaunt(), tone: 'friendly' });
      const target = this.world.byId(player.ship?.targetId);
      if (target && target.faction !== player.faction) {
        bus.emit('radio', {
          speaker: target.ship?.pilot ?? target.label ?? '敵機',
          text: enemyTauntReply(),
          tone: 'enemy',
        });
        // 挑発された敵はこちらに向かってくる
        if (target.ai) {
          target.ai.targetId = player.id;
          target.ai.morale = Math.min(1, target.ai.morale + 0.3);
        }
      }
      return;
    }
    if (a.kind === 'report') {
      const wingmen = this.world.entities.filter(
        (e) => e.alive && e.kind === 'ship' && e.faction === player.faction && e.id !== player.id && e.ai?.leaderId === player.id,
      );
      if (wingmen.length === 0) {
        bus.emit('radio', { speaker: '自機', text: '僚機は応答圏外だ。', tone: 'command' });
        return;
      }
      for (const wingman of wingmen) {
        const ship = wingman.ship;
        const ratio = ship ? Math.round((ship.hull / Math.max(1, ship.def.hull)) * 100) : 0;
        bus.emit('radio', {
          speaker: ship?.pilot ?? wingman.label ?? '僚機',
          text: `機体状況 ${ratio}%、命令 ${wingman.ai?.order ?? '編隊'}。`,
          tone: 'friendly',
        });
      }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.runner?.dispose();
    this.tutorial.dispose();
    this.sound.dispose();
    this.loop.stop();
  }

  /** 完了済み任務のプレイテスト記録を JSON として書き出す。 */
  exportPlaytestLog(): string {
    return this.playtestLog.exportJson();
  }

  get fixedDt(): number {
    return FIXED_DT;
  }
}
