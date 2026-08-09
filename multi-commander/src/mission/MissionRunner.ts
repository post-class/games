import { Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { forwardOf } from '../core/math';
import { Rng, rng } from '../core/rng';
import { kilrathiName } from '../content/dialogue';
import {
  aceState,
  recordAceEncounter,
  recordAceEscape,
  recordAceKill,
} from '../content/aces';
import { isHostile, resetFactionStances, setFactionStance } from '../content/factions';
import { shipDef, type Faction } from '../content/ships';
import type { DifficultyProfile } from '../app/settings';
import type { PlaytestObjective, PlaytestRecorder } from '../app/playtest';
import type { ObjectiveView } from '../hud/HudView';
import {
  breakDuel,
  configureDuel,
  configureSwarmLearning,
  newAi,
  recordSwarmLoss,
  resetDuel,
  resetSwarmLearning,
} from '../sim/ai';
import {
  commsDelaySeconds,
  configureCommsDelay,
  recordCommsPositions,
  resetCommsDelay,
} from '../sim/comms';
import { checkNavArrival } from '../sim/nav';
import { stateOf } from '../sim/subsystems';
import type { Entity } from '../world/entity';
import {
  addGravityWell,
  configureMineSensors,
  gravityWellCycle,
  gravityWellPulse,
  resetGravityWells,
  resetMineSensors,
  setMineSuppression,
  tickGravityWells,
} from '../sim/obstacles';
import { spawnMine, spawnNav, spawnRock, spawnShip, World } from '../world/world';
import type {
  DuelDef,
  HazardDef,
  Loadout,
  CapitalStageDef,
  MissionDef,
  ObjectiveDef,
  ObjectiveSpec,
  RadioLineDef,
  SpawnGroupDef,
} from './types';

export type MissionState = 'running' | 'win' | 'loss';

/** 逃走した敵がこの距離まで離れたら「撃退した」として戦域から外す */
const FLED_DISTANCE = 14000;
/** 味方の大型艦に近づきすぎたと判断する中心間距離 */
const FRIENDLY_LARGE_SHIP_WARNING_DISTANCE = 900;
/** 一度離れたあと、再接近時にもう一度警告できるようにする距離 */
const FRIENDLY_LARGE_SHIP_WARNING_RESET_DISTANCE = 1200;

const _awayCheck = new Vector3();
const _reconFwd = new Vector3();
const _reconTo = new Vector3();
const _navCheck = new Vector3();
/** 反射 Nav の近接判定用 (第9章。毎フレーム回るので確保しない) */
const _reflectionCheck = new Vector3();

interface PendingSpawn {
  group: SpawnGroupDef;
  /** 出現までの残り秒。undefined ならまだ条件を満たしていない */
  timer?: number;
  released: boolean;
}

/**
 * 「達成する目標」ではなく「守るべき制約」である目標種別。
 *
 * 制約は成立している間ずっと `active` のままなので、勝利条件の
 * 「残っている必須目標」に数えてはいけない (数えると永久に勝てない)。
 * 破られたときに `failed` になり、`required` なら敗北させる形で効く。
 */
const CONSTRAINT_KINDS: ReadonlySet<ObjectiveSpec['kind']> = new Set([
  'protect',
  'timeLimit',
  // 追加した3種も同じ扱い。holdTag は「秒数を稼いで達成する目標」なので含めない。
  'noFriendlyFire',
  'weaponsSafe',
  'protectCount',
] as const);

interface ObjectiveRuntime {
  def: ObjectiveDef;
  state: 'active' | 'done' | 'failed';
  /** protect 用: 生成した護衛対象の id */
  watchIds: number[];
  /** rescue 用: 回収済みの対象 id */
  collected?: Set<number>;
  /** recon / holdTag 用: 条件を継続できている秒数 */
  progress?: number;
  /** HUD に出す進捗ラベル (例 "2/3") */
  note?: string;
}

/**
 * ミッションの実行時状態。
 * ワールドの構築、ウェーブ投入、目標評価、勝敗判定を受け持つ。
 */
export class MissionRunner {
  state: MissionState = 'running';
  elapsed = 0;
  /** 直近の固定ステップ長 (目標の進捗計算に使う) */
  private lastDt = 1 / 60;
  /** プレイヤーの撃墜数 (このミッション分) */
  kills = 0;
  /** 撃退した (逃げ切られた) 敵の数 */
  routed = 0;
  /** 僚機の entity id (出撃時に決まる) */
  private wingmanEntityId?: number;
  /** 僚機が撃墜されたか */
  private wingmanLost = false;
  /** 僚機の撃墜数 */
  private wingmanKills = 0;
  /** 僚機の残ハル率 (撃墜時は 0) */
  private wingmanHullRatio = 1;
  /** 僚機が助けを求めたか / それに応えたか */
  private wingmanCalledForHelp = false;
  private wingmanRescued = false;
  /** 護衛対象を失ったか */
  private escortLost = false;
  /** プレイヤーが倒したエースの数 */
  private acesKilled = 0;
  /** 統計画面用。発射と命中をミッション単位で集計する。 */
  private shotsFired = 0;
  private hits = 0;
  /**
   * 物語用の集計 (T4-2)。4状態 (帰還者・航路信頼・軍令信用・敵エースの誓約) の
   * 更新に必要な値だけを持つ。加算の重み付けは App 側の担当。
   */
  /** 自機の射撃が味方・非敵対勢力に命中した回数 */
  private friendlyFireHits = 0;
  /** 失った中立・非敵対勢力の艦船数 (民間損害) */
  private civilianLosses = 0;
  /** rescue 目標で回収した対象の総数 */
  private rescuedCount = 0;
  /** そのうち敵陣営だった数 (脱出ポッド・被弾艦の救難) */
  private enemyRescued = 0;
  private objectives: ObjectiveRuntime[] = [];
  private pending: PendingSpawn[] = [];
  private radioQueue: Array<{ line: RadioLineDef; at: number }> = [];
  private unsubs: Array<() => void> = [];
  private tagIndex = new Map<string, number[]>();
  private capitalStage = 0;
  private capitalTorpedoFired = false;
  /** 接近警告を最後に出した味方大型艦。離れるまで再通知しない */
  private friendlyProximityWarningShipId?: number;
  /** 帰投可能になったことを知らせたか */
  private returnInstructionSent = false;
  /**
   * 共鳴パルスの安全窓 (第3章 T6-3)。
   * `hazards[].resonance` の宣言から作る。宣言が無いミッションでは undefined のまま。
   */
  private resonance?: {
    cycle: number;
    window: number;
    speaker?: string;
    /** 直前フレームで窓が開いていたか (開閉を1回だけ知らせるため) */
    open: boolean;
    /** 自機が発砲して歌が止まったか (以後この作戦では窓が開かない) */
    stopped: boolean;
  };
  /**
   * 重力井戸 (第4章 T6-4)。`hazards[].kind === 'gravity-well'` の宣言から作る。
   * 宣言が無いミッションでは undefined のまま = 飛行モデルは従来どおり。
   */
  private gravity?: {
    cycle: number;
    speaker?: string;
    /** 直前フレームで「重い」側だったか (切り替わりを1回だけ知らせるため) */
    heavy: boolean;
    /** 無線で知らせた回数 (毎周期は喋らせない) */
    radioed: number;
  };
  /**
   * 決闘規約 (第5章 T6-5)。`spawns[].ace.duel` の宣言から作る。
   * 判定はシミュレーション側 (`src/sim/ai.ts`) が持ち、ここは
   * 「いつ誓約が破れたか」「いつ片翼を失うか」という進行だけを見る。
   */
  private duel?: {
    entityId: number;
    def: DuelDef;
    /** 誓約が破られた時刻 (秒)。破られていなければ undefined */
    brokenAt?: number;
    /** 片翼を失ったか */
    crippled: boolean;
  };
  /**
   * 戦闘不能になった機体 (第5章の片翼喪失)。
   * `rescue` 目標の `disabledOnly` がここを見る。
   */
  private disabledShipIds = new Set<number>();
  /**
   * 帰投窓へのペナルティ秒 (第9章 T6-9 の反射経路)。
   *
   * ■ なぜ `elapsed` を進めないのか
   * `elapsed` は無線キューの発火時刻・`survive`・`recon`・`holdTag` の進捗、
   * 共鳴パルスの位相まで動かす「作戦の時計」なので、ここを進めると
   * 反射を踏むたびに台詞や周期がまとめてずれてしまう。
   * そのため既存の `timeLimit` 判定式は変えず、**timeLimit だけが読む
   * ペナルティ**として別に持つ（`missionClock = elapsed + timePenalty`）。
   * 宣言が無いミッションでは常に 0 なので、判定は完全に従来どおり。
   */
  private timePenalty = 0;
  /** 踏んでしまった反射 Nav の index (第9章)。幻影の僚機の出現条件に使う */
  private reflectionsHit = new Set<number>();
  /**
   * 章ごとの選択記録 (第9章の無線差し替え)。
   * `Loadout.choices` を最優先で使い、無ければ保存データから読む。
   */
  private choices: Record<string, string> = {};

  constructor(
    readonly world: World,
    readonly def: MissionDef,
    private loadout: Loadout,
    private difficulty: DifficultyProfile,
    private playtest?: PlaytestRecorder,
  ) {}

  /** ワールドを構築して開始する */
  build(): void {
    const world = this.world;
    world.reset();
    this.state = 'running';
    this.elapsed = 0;
    this.kills = 0;
    this.routed = 0;
    this.wingmanEntityId = undefined;
    this.wingmanLost = false;
    this.wingmanKills = 0;
    this.wingmanHullRatio = 1;
    this.wingmanCalledForHelp = false;
    this.wingmanRescued = false;
    this.escortLost = false;
    this.acesKilled = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.friendlyFireHits = 0;
    this.civilianLosses = 0;
    this.rescuedCount = 0;
    this.enemyRescued = 0;
    // 決闘規約は出撃ごとに必ず捨てる (宣言のあるミッションだけが作り直す)。
    // 重力井戸は spawnHazards() が同じ流儀で捨てる。
    resetDuel();
    this.duel = undefined;
    this.disabledShipIds.clear();
    // 通信妨害と群体の学習も出撃ごとに必ず既定へ戻す (T6-6)。
    // 宣言のないミッションでは HUD も AI も一切変わらない。
    resetCommsDelay();
    resetSwarmLearning();
    // 帰投窓のペナルティと反射経路の記録 (T6-9)
    this.timePenalty = 0;
    this.reflectionsHit.clear();
    this.choices = this.resolveChoices();
    this.objectives = this.def.objectives.map((d) => ({
      def: d,
      state: 'active',
      watchIds: [],
      collected: d.spec.kind === 'rescue' ? new Set<number>() : undefined,
      progress: d.spec.kind === 'recon' || d.spec.kind === 'holdTag' ? 0 : undefined,
    }));
    this.playtest?.recordObjectives(this.playtestObjectiveStates(), 0);
    this.pending = this.def.spawns.map((g) => ({
      group: g,
      // 開始時グループは即時、Nav 紐付けグループは到達時、
      // 反射経路の回数で出る群 (第9章) は踏んだときに武装する
      timer:
        g.atNav === undefined && g.afterReflections === undefined
          ? (g.delay ?? 0) + this.waveBonus(g)
          : undefined,
      released: false,
    }));
    this.radioQueue = [];
    this.tagIndex.clear();
    this.capitalStage = 0;
    this.capitalTorpedoFired = false;
    this.friendlyProximityWarningShipId = undefined;
    this.returnInstructionSent = false;

    // Nav ポイント
    this.def.navs.forEach((n, i) => {
      const nav = spawnNav(world, {
        index: i,
        name: n.name,
        pos: new Vector3(...n.pos),
        arriveRadius: n.arriveRadius ?? 900,
      });
      // 反射経路 (第9章) は必須の航路チェーンから外す。
      // `nextNav` は index 最小の未到達 Nav しか見ないので、到達済みとして置かないと
      // 実経路の Nav に到達判定が降りない (= 反射を必ず踏まされる)。
      // 踏んだかどうかは updateReflections() が自前で見る。
      if (n.reflection && nav.nav) nav.nav.reached = true;
    });

    this.spawnHazards();

    // 自機。最初の Nav の方向を向いて出撃する
    const firstNav = this.def.navs[0];
    const facing = new Quaternion();
    if (firstNav) {
      facing.setFromUnitVectors(
        new Vector3(0, 0, -1),
        new Vector3(...firstNav.pos).normalize(),
      );
    }
    const player = spawnShip(world, {
      def: shipDef(this.loadout.shipId),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      quat: facing,
      speed: this.difficulty.id === 'easy' ? shipDef(this.loadout.shipId).maxSpeed * 0.5 : 0,
      label: '自機',
      pilot: 'あなた',
      gunOverride: this.loadout.gunId,
      missileOverride: this.loadout.missiles,
      flareOverride: this.loadout.flares,
      fuelScale: this.difficulty.fuelScale,
    });
    world.playerId = player.id;

    // 僚機。ロードアウト (格納庫での選択) が最優先。
    // 無ければミッション定義の既定を使う (テストや単体起動のため)。
    const wing =
      this.loadout.wingman ??
      (this.def.wingman
        ? {
            pilotId: this.def.wingman.pilot,
            callsign: this.def.wingman.pilot,
            shipId: this.def.wingman.shipId,
            skill: this.def.wingman.skill,
            personality: undefined,
          }
        : undefined);
    if (wing) {
      const e = spawnShip(world, {
        def: shipDef(wing.shipId),
        faction: 'confed',
        pos: new Vector3(((this.loadout.wingmanSlot ?? 2) - 2.5) * 180, -20, 150).applyQuaternion(facing),
        quat: facing,
        speed: 120,
        label: wing.callsign,
        pilot: wing.callsign,
        ai: newAi(wing.skill, {
          leaderId: player.id,
          order: 'form',
          personality: wing.personality,
        }),
      });
      this.wingmanEntityId = e.id;
    }

    // 遅延 0 の開始時グループを即座に投入する
    for (const p of this.pending) {
      if (!p.released && p.timer !== undefined && p.timer <= 0) {
        this.spawnGroup(p.group);
        p.released = true;
      }
    }

    if (this.def.openingRadio) this.queueRadio(this.def.openingRadio, 1.2);

    this.subscribe();
    // 関係の組み替えは subscribe() の後で行う。subscribe() は内部で dispose() を
    // 呼ぶ (= 既定へ戻す) ため、先に適用すると打ち消されてしまう。
    this.applyFactionStances();
    // 通信妨害と群体の学習も同じ理由で subscribe() の後に適用する
    // (dispose() が既定へ戻すため、先に宣言すると打ち消される)。
    if (this.def.commsDelay) {
      configureCommsDelay({ friendlySeconds: this.def.commsDelay.friendlySeconds });
    }
    if (this.def.swarmLearning) {
      configureSwarmLearning({
        faction: this.def.swarmLearning.faction,
        lossesPerLevel: this.def.swarmLearning.lossesPerLevel,
      });
    }
    bus.emit('objectivesChanged', {});
  }

  private subscribe(): void {
    this.dispose();
    this.unsubs.push(
      bus.on('weaponFired', (p) => {
        if (p.isPlayer) this.shotsFired += 1;
        // 共鳴パルスは「周囲に稼働中の火器管制が無いこと」で成立する。
        // 自機が一度でも引き金を引けば歌は止まり、窓は二度と開かない (第3章)。
        if (p.isPlayer && this.resonance && !this.resonance.stopped) {
          this.resonance.stopped = true;
          this.updateResonanceWindow();
        }
        const stage = this.activeCapitalStages[this.capitalStage];
        if (
          p.isPlayer &&
          p.weaponKind === 'missile' &&
          p.weaponId === stage?.weapon &&
          this.tagAlive(stage.tag).alive > 0 &&
          // 魚雷段階は「何かに撃った」だけでなく、旗艦をロックして
          // 発射したときだけ進める。無駄撃ちを意味のある判断にする。
          (stage.weapon !== 'torpedo' ||
            (this.world.player?.ship?.lockedId !== undefined &&
              (this.tagIndex.get(stage.tag) ?? []).includes(this.world.player.ship.lockedId)))
        ) {
          this.capitalTorpedoFired = true;
        }
      }),
      /**
       * 誤射の検出。
       *
       * `shieldHit` / `armorHit` は「シールド→アーマー→ハル」と層ごとに複数回
       * 飛び、しかも `isPlayer` は「撃たれたのが自機か」を意味するため、
       * 「自機が誰に当てたか」を1発単位で数えられない。`resolveProjectileHits`
       * の戻り値も無い (副作用だけ)。そのため命中1件につき1回だけ流れる
       * `weaponHit` を使う。弾・ミサイルの `fromPlayer` は発射時に
       * `world.playerId` から決まるので、自機の射撃を取りこぼさない。
       */
      bus.on('weaponHit', (p) => {
        if (!p.fromPlayer) return;
        if (p.target.kind !== 'ship') return;
        if (p.target.id === this.world.playerId) return;
        if (isHostile(this.playerFaction, p.target.faction)) return;
        this.friendlyFireHits += 1;
      }),
      bus.on('shieldHit', (p) => {
        if (p.isPlayer) this.hits += 1;
      }),
      bus.on('armorHit', (p) => {
        if (p.isPlayer) this.hits += 1;
      }),
      bus.on('destroyed', (p) => {
        if (p.target.id === this.world.playerId) {
          const source = p.source?.ship?.pilot ?? p.source?.label ?? p.source?.kind;
          this.playtest?.recordDeath(p.reason ?? 'unknown', this.world.time, source);
        }
        const sourceShip = p.source?.kind === 'ship'
          ? p.source
          : p.source?.projectile
            ? this.world.byId(p.source.projectile.ownerId)
            : p.source?.missile
              ? this.world.byId(p.source.missile.ownerId)
              : undefined;
        if (sourceShip?.ship?.ace && p.target.id === this.wingmanEntityId && p.target.ship?.pilot) {
          const victim = sourceShip.ship.pilot ? aceState(this.loadout.aceStates ?? [], sourceShip.ship.pilot) : undefined;
          if (victim) victim.lastVictim = p.target.ship.pilot;
        }
        if (p.target.ship?.ace) {
          const state = p.target.ship.pilot ? aceState(this.loadout.aceStates ?? [], p.target.ship.pilot) : undefined;
          if (state) recordAceKill(state);
        }
        if (p.killedByPlayer) {
          this.kills++;
          if (p.target.ship?.ace) this.acesKilled++;
        }
        // 僚機の戦死は取り返しがつかないので、ここで確定させる
        if (this.wingmanEntityId !== undefined && p.target.id === this.wingmanEntityId) {
          this.wingmanLost = true;
          this.wingmanHullRatio = 0;
        }
        // 護衛対象の喪失を記録する
        if (p.target.tag && this.protectTags.has(p.target.tag)) this.escortLost = true;
        // 学習する群体 (第6章)。宣言された陣営の個体だけを数える。
        // 誰が落としたかは問わない (群体は「失われた」ことだけを共有する)。
        if (p.target.kind === 'ship') recordSwarmLoss(p.target.faction);
        // 民間損害。自陣営でも敵でもない艦 (中立・セレシオン・オルドなど) の喪失を数える。
        // 自陣営の損失は僚機・護衛の集計で別に扱う。
        if (
          p.target.kind === 'ship' &&
          p.target.faction !== this.playerFaction &&
          !isHostile(this.playerFaction, p.target.faction)
        ) {
          this.civilianLosses += 1;
        }
      }),
      bus.on('wingmanInTrouble', (p) => {
        if (this.wingmanEntityId !== undefined && p.entity.id === this.wingmanEntityId) {
          this.wingmanCalledForHelp = true;
        }
      }),
    );
  }

  /** 敵対判定の基準になる自機の陣営 (自機を失った後も既定値で判定を続ける) */
  private get playerFaction(): Faction {
    return this.world.player?.faction ?? 'confed';
  }

  /** protect 目標で参照されているタグ */
  private get protectTags(): Set<string> {
    const set = new Set<string>();
    for (const o of this.def.objectives) {
      if (o.spec.kind === 'protect') set.add(o.spec.tag);
    }
    return set;
  }

  /**
   * ミッション定義が宣言した勢力関係を適用する (第8章の停戦・第10章の共同作戦)。
   *
   * 関係テーブルはモジュール単位のグローバルなので、**適用したら必ず戻す**必要がある。
   * 戻す責任は `dispose()` が一手に持つ (`Game.startMission` / `Game.endMission` の
   * どちらも `dispose()` を通るため、次の出撃へ関係が漏れない)。
   */
  private applyFactionStances(): void {
    const list = this.def.factionStances;
    if (!list?.length) return;
    for (const s of list) setFactionStance(s.a, s.b, s.stance);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    // 出撃ごとの関係の組み替えを必ず既定へ戻す。
    // 宣言の有無に関わらず戻すので、リセット漏れが起きない。
    resetFactionStances();
    // 通信妨害と群体の学習も、宣言の有無に関わらず既定へ戻す (T6-6)。
    resetCommsDelay();
    resetSwarmLearning();
  }

  // ───────── 更新 ─────────

  update(dt: number): void {
    if (this.state !== 'running') return;
    this.elapsed += dt;
    this.lastDt = dt;

    this.flushRadio();
    // 味方位置の履歴を刻む (第6章 T6-6)。宣言が無ければ何もしない。
    // 時計は作戦の経過時間なので、描画フレームレートに依らず同じ遅延量になる。
    recordCommsPositions(this.world, this.elapsed);
    this.updateResonanceWindow();
    this.updateGravityWells(dt);
    this.updateDuel();
    this.updateReflections();
    this.tickSpawns(dt);
    this.removeRoutedEnemies();
    this.updateFriendlyShipProximity();

    const arrived = checkNavArrival(this.world);
    if (arrived?.nav) {
      bus.emit('navReached', { index: arrived.nav.index, name: arrived.nav.name });
      this.playtest?.recordNavReached(arrived.nav.index, arrived.nav.name, this.world.time);
      const navDef = this.def.navs[arrived.nav.index];
      if (navDef?.onArrive) this.queueRadio(navDef.onArrive, 0.6);
      // この Nav で出現するグループを解放
      for (const p of this.pending) {
        if (!p.released && p.group.atNav === arrived.nav.index && p.timer === undefined) {
          p.timer = (p.group.delay ?? 0) + this.waveBonus(p.group);
        }
      }
      bus.emit('objectivesChanged', {});
    }

    this.trackWingman();
    this.evaluateObjectives();
    this.announceReturnInstruction();
  }

  /**
   * 味方の輸送艦・戦艦への接近を監視する。
   * 大型艦はパイロット名を持たないことがあるため、その場合は艦名を発信元にする。
   */
  private updateFriendlyShipProximity(): void {
    const player = this.world.player;
    if (!player || player.ship?.ejected) return;

    let nearest: Entity | undefined;
    let nearestDistance = Infinity;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
      if (e.id === player.id || isHostile(player.faction, e.faction)) continue;
      if (e.ship.def.role !== 'transport' && e.ship.def.role !== 'capital') continue;

      const distance = player.pos.distanceTo(e.pos);
      if (distance < nearestDistance) {
        nearest = e;
        nearestDistance = distance;
      }
    }

    if (!nearest || nearestDistance > FRIENDLY_LARGE_SHIP_WARNING_RESET_DISTANCE) {
      this.friendlyProximityWarningShipId = undefined;
      return;
    }
    if (
      nearestDistance > FRIENDLY_LARGE_SHIP_WARNING_DISTANCE ||
      this.friendlyProximityWarningShipId === nearest.id
    ) {
      return;
    }

    const ship = nearest.ship;
    if (!ship) return;
    this.friendlyProximityWarningShipId = nearest.id;
    bus.emit('radio', {
      speaker: ship.pilot ?? nearest.label ?? ship.def.name,
      text: '近づきすぎだ。距離を取れ。',
      tone: 'friendly',
    });
  }

  /**
   * 共鳴パルスの安全窓を開閉する (第3章)。
   *
   * `cycle` 秒周期の先頭 `window` 秒だけ機雷の熱紋判定が鈍る。
   * 窓の状態は HUD を触らずに伝える必要があるため、
   * (1) 開閉のたびに無線と `announce` を出し、
   * (2) `weaponsSafe` 目標の note に残り秒数を載せる、の二経路で見せる。
   */
  private updateResonanceWindow(): void {
    const r = this.resonance;
    if (!r) return;
    const open = !r.stopped && this.elapsed % r.cycle < r.window;
    if (open === r.open) return;
    r.open = open;
    setMineSuppression(open);
    const speaker = r.speaker ?? '管制';
    if (open) {
      bus.emit('announce', {
        text: `共鳴パルス — 安全窓 ${Math.round(r.window)}秒`,
        kind: 'good',
        durationMs: 2200,
      });
      bus.emit('radio', {
        speaker,
        text: `共鳴パルス。いま ${Math.round(r.window)} 秒だけ機雷が鈍る。`,
        tone: 'friendly',
      });
      return;
    }
    bus.emit('announce', {
      text: r.stopped ? '共鳴パルス停止 — 機雷が起きている' : '安全窓が閉じた',
      kind: 'bad',
      durationMs: 2200,
    });
    bus.emit('radio', {
      speaker,
      text: r.stopped
        ? '発砲を検知した。歌は止まった。窓はもう開かない。'
        : '窓が閉じた。機雷が熱紋を拾い始める。',
      tone: 'friendly',
    });
  }

  /** 共鳴パルスの窓の状態を目標の note に足す一文 (宣言が無ければ空文字) */
  private resonanceNote(): string {
    const r = this.resonance;
    if (!r) return '';
    if (r.stopped) return ' / 共鳴パルス停止';
    const phase = this.elapsed % r.cycle;
    return r.open
      ? ` / 安全窓 残り ${Math.max(0, Math.ceil(r.window - phase))}s`
      : ` / 安全窓まで ${Math.max(0, Math.ceil(r.cycle - phase))}s`;
  }

  /**
   * 重力井戸を1ステップ進める (第4章)。
   *
   * `sim/step.ts` は岩と機雷を更新しないので、井戸の時計とミサイルの曲げは
   * 毎フレーム必ず通るここから回す。宣言が無ければ何もしない。
   *
   * 「重力が動いた瞬間」は HUD を触らずに伝える必要があるため、T6-3 と同じ二経路:
   * (1) 重い/軽いが入れ替わるたびに `announce`（無線は最初の2回だけ。毎周期は喋らせない）
   * (2) `timeLimit` 目標の note に、いまの重力と次に切り替わるまでの秒数を載せる
   */
  private updateGravityWells(dt: number): void {
    const g = this.gravity;
    if (!g) return;
    tickGravityWells(this.world, dt);
    const heavy = gravityWellPulse() >= 0;
    if (heavy === g.heavy) return;
    g.heavy = heavy;
    bus.emit('announce', {
      text: heavy ? '局所重力 — 機体が重い' : '局所重力 — 機体が軽い',
      kind: 'warn',
      durationMs: 1600,
    });
    if (g.radioed >= 2) return;
    g.radioed += 1;
    bus.emit('radio', {
      speaker: g.speaker ?? '管制',
      text: heavy
        ? '重力を寄せた。いまお前の機体は重い。舵を早く入れろ。'
        : '重力を抜いた。いまお前の機体は軽い。当て舵を忘れるな。',
      tone: 'command',
    });
  }

  /** 重力井戸の状態を目標の note に足す一文 (宣言が無ければ空文字) */
  private gravityNote(): string {
    const g = this.gravity;
    if (!g) return '';
    const cycle = gravityWellCycle();
    if (cycle <= 0) return '';
    // 位相の半周ごとに重い/軽いが入れ替わる
    const half = cycle * 0.5;
    const left = Math.max(0, Math.ceil(half - (this.elapsed % half)));
    return ` / 重力 ${g.heavy ? '重' : '軽'} (${left}s で反転)`;
  }

  // ───────── 位相迷路の反射経路 (第9章 T6-9) ─────────

  /**
   * 反射経路を踏んだかを見る。
   *
   * 反射 Nav は航路チェーンから外してある（`build()` で到達済みにしている）ので、
   * 到達判定は `checkNavArrival` ではなくここで行う。踏むと
   * (1) 帰投窓が `penaltySeconds` だけ縮み、
   * (2) `onArrive` の無線と `announce` で「航法ログと一致しない」ことを告げ、
   * (3) 踏んだ回数が幻影の僚機（`spawns[].afterReflections`）の出現条件になる。
   */
  private updateReflections(): void {
    const player = this.world.player;
    if (!player) return;
    this.def.navs.forEach((n, i) => {
      const reflection = n.reflection;
      if (!reflection || this.reflectionsHit.has(i)) return;
      const radius = n.arriveRadius ?? 900;
      _reflectionCheck.set(...n.pos);
      if (player.pos.distanceToSquared(_reflectionCheck) > radius * radius) return;
      this.reflectionsHit.add(i);
      this.timePenalty += Math.max(0, reflection.penaltySeconds);
      bus.emit('announce', {
        text: `反射経路 — 帰投窓 −${Math.round(reflection.penaltySeconds)}秒`,
        kind: 'bad',
        durationMs: 2600,
      });
      if (n.onArrive) this.queueRadio(n.onArrive, 0.4);
      bus.emit('objectivesChanged', {});
    });
  }

  /**
   * `timeLimit` が読む時計。経過時間に反射経路のペナルティを足したもの。
   * ペナルティが無い（宣言の無い）ミッションでは `elapsed` と完全に同じ値。
   */
  private get missionClock(): number {
    return this.elapsed + this.timePenalty;
  }

  /** 帰投窓から差し引かれた秒数 (テストと表示用) */
  get returnWindowPenalty(): number {
    return this.timePenalty;
  }

  /** 踏んでしまった反射経路の数 (テストと表示用) */
  get reflectionsStepped(): number {
    return this.reflectionsHit.size;
  }

  /**
   * 通信遅延を目標の note に載せる一文 (宣言が無ければ空文字)。
   *
   * 第6章の遅延は HUD の表示だけでも判るが、T6-3 の流儀に合わせて
   * 「無線」と「目標の note」の二経路で必ず伝える。
   */
  private commsDelayNote(): string {
    const seconds = commsDelaySeconds();
    if (seconds <= 0) return '';
    return `味方位置 ${seconds.toFixed(0)}秒遅延`;
  }

  /** この作戦で味方位置が遅れて届くか (テストと表示用) */
  get commsDelayActive(): boolean {
    return commsDelaySeconds() > 0;
  }

  /** 反射経路の状態を目標の note に足す一文 (踏んでいなければ空文字) */
  private reflectionNote(): string {
    if (this.reflectionsHit.size === 0) return '';
    return ` / 反射 ${this.reflectionsHit.size} 回 (−${Math.round(this.timePenalty)}s)`;
  }

  /**
   * 章ごとの選択記録を決める (第9章の無線差し替え)。
   *
   * 出所は `Loadout.choices` だけにする。`App.loadoutFor()` が
   * `this.save.narrative.choices` を渡すので、ランナーが保存データを直接読む
   * 必要はない（訓練出撃やテストでは未指定＝条件なしの台詞だけが流れる）。
   */
  private resolveChoices(): Record<string, string> {
    return this.loadout.choices ?? {};
  }

  /**
   * 選択記録と照合して、この台詞を流すかを決める。
   * 条件を書いていない台詞は常に流す（既存ミッションはすべてこちら）。
   */
  private radioLineAllowed(line: RadioLineDef): boolean {
    if (line.whenChoice) {
      return this.choices[line.whenChoice.chapterId] === line.whenChoice.choiceId;
    }
    if (line.whenChoiceMissing) {
      return this.choices[line.whenChoiceMissing] === undefined;
    }
    return true;
  }

  /**
   * 決闘の進行 (第5章)。
   *
   * 誓約が破られてから `crippleAfter` 秒で、決闘の相手は片翼を失う。
   * **脱出信号は出さない**ので、救うにはこちらが接近するしかない。
   */
  private updateDuel(): void {
    const d = this.duel;
    if (!d || d.crippled || d.brokenAt === undefined) return;
    const after = d.def.crippleAfter;
    if (after === undefined) return;
    if (this.elapsed < d.brokenAt + after) return;
    const e = this.world.byId(d.entityId);
    if (!e?.ship || !e.ai) {
      // すでに撃墜されていれば、片翼喪失は起きない
      d.crippled = true;
      return;
    }
    d.crippled = true;
    this.crippleDuellist(e, d.def);
  }

  /**
   * 片翼喪失。機動と武装を失って漂う状態にする。
   *
   * **脱出の抑止のしかた**: `src/sim/eject.ts` の `eject()` は
   * 陣営を中立にしてラベルを「脱出ポッド」に変え、機体を捨てる処理なので、
   * これを呼ぶと「信号を出して位置を教える」ことになってしまう。
   * したがって**呼ばない**（脱出ポッドも生成しない）。
   * 代わりに本人を戦闘不能のまま戦域へ残し、`rescue` の `disabledOnly` で
   * 「接近して回収する」経路だけを開く。撃墜すれば名前は失われる。
   */
  private crippleDuellist(e: Entity, def: DuelDef): void {
    const ship = e.ship!;
    const ai = e.ai!;
    ship.hull = Math.max(1, ship.def.hull * (def.crippledHullRatio ?? 0.25));
    ship.shield.front = 0;
    ship.shield.rear = 0;
    // 片翼と一緒に副兵装架を失う
    ship.missiles = [];
    // 片翼なので加速も最高速も出ない (難易度倍率ではなく損傷状態としての速度低下)
    ship.speedScale = Math.max(0.05, ship.speedScale * 0.45);
    if (ship.subsystems) {
      ship.subsystems.thrusters = 'dead';
      ship.subsystems.engine = 'damaged';
    }
    // 機動と射撃をやめて漂う (passive = 撃たずに巡航するだけの扱い)
    ai.passive = true;
    ai.cruiseTo = undefined;
    ai.mode = 'idle';
    ship.targetId = undefined;
    ship.lockedId = undefined;
    this.disabledShipIds.add(e.id);

    bus.emit('announce', {
      text: `${ship.pilot ?? e.label ?? '敵機'} 片翼喪失 — 脱出信号なし`,
      kind: 'warn',
      durationMs: 2600,
    });
    bus.emit('radio', {
      speaker: def.speaker ?? ship.pilot ?? '管制',
      text: '片翼をやられた。脱出信号は出さない。あれは位置を教える。',
      tone: 'enemy',
    });
  }

  /** 共鳴パルスの安全窓が開いているか (テストと表示用) */
  get resonanceWindowOpen(): boolean {
    return this.resonance?.open ?? false;
  }

  /** 自機の発砲で共鳴パルスが止まったか (テストと表示用) */
  get resonanceStopped(): boolean {
    return this.resonance?.stopped ?? false;
  }

  /** いま局所重力が重い側か (テストと表示用。井戸が無ければ false) */
  get gravityHeavy(): boolean {
    return this.gravity?.heavy ?? false;
  }

  /** 決闘の誓約が破られたか (テストと表示用。決闘が無ければ false) */
  get oathBroken(): boolean {
    return this.duel?.brokenAt !== undefined;
  }

  /** 決闘の相手が片翼を失ったか (テストと表示用) */
  get duellistCrippled(): boolean {
    return this.duel?.crippled ?? false;
  }

  /** 戦闘不能になった機体の id (テストと表示用) */
  get disabledShips(): ReadonlySet<number> {
    return this.disabledShipIds;
  }

  /** 戦闘目標が片付いたら、帰投操作を一度だけ管制から知らせる */
  private announceReturnInstruction(): void {
    if (this.returnInstructionSent || !this.canDisengage) return;
    this.returnInstructionSent = true;
    bus.emit('radio', {
      speaker: '管制',
      text: '戦闘目標を達成。帰還してください。Aキーでオートパイロットを作動させ、帰投せよ。',
      tone: 'command',
    });
  }

  /**
   * 僚機の状態を追う。
   * 撃墜数・残ハル・救援要請の有無を集め、デブリーフと名簿に渡す。
   */
  private trackWingman(): void {
    if (this.wingmanEntityId === undefined || this.wingmanLost) return;
    const w = this.world.byId(this.wingmanEntityId);
    if (!w?.ship) return;
    this.wingmanKills = w.ship.kills;
    this.wingmanHullRatio = w.ship.hull / Math.max(1, w.ship.def.hull);
    // 助けを求めた後に生き延びていれば「救援された」とみなす
    if (this.wingmanCalledForHelp && this.wingmanHullRatio > 0.2) {
      const threat = this.world.entities.some(
        (e) =>
          e.alive &&
          e.kind === 'ship' &&
          isHostile(w.faction, e.faction) &&
          e.ship?.targetId === w.id &&
          e.pos.distanceToSquared(w.pos) < 900 * 900,
      );
      if (!threat) {
        this.wingmanRescued = true;
        this.wingmanCalledForHelp = false;
      }
    }
  }

  /**
   * 難易度による増援の遅延ボーナス。
   * 「時間差で来る敵の増援」だけを遅らせる。
   * 護衛対象や攻撃目標のように到達と同時に配置されるものには効かせない。
   */
  private waveBonus(g: SpawnGroupDef): number {
    if (g.faction !== 'kilrathi') return 0;
    if (!g.delay) return 0;
    return this.difficulty.waveDelayBonus;
  }

  private tickSpawns(dt: number): void {
    let released = false;
    for (const p of this.pending) {
      // 反射経路を踏んだ回数で出現する群 (第9章の幻影の僚機)。
      // 「楽な道へ進むほど僚機の声は増える」を出現条件として持つ。
      const after = p.group.afterReflections;
      if (!p.released && p.timer === undefined && after !== undefined) {
        if (this.reflectionsHit.size >= after) {
          p.timer = (p.group.delay ?? 0) + this.waveBonus(p.group);
        }
      }
      if (p.released || p.timer === undefined) continue;
      p.timer -= dt;
      if (p.timer <= 0) {
        this.spawnGroup(p.group);
        p.released = true;
        released = true;
      }
    }
    if (released) bus.emit('objectivesChanged', {});
  }

  /**
   * 小惑星帯・機雷原を配置する。
   * ミッション id を種にした固定乱数なので、同じミッションでは毎回同じ地形になる。
   */
  private spawnHazards(): void {
    // 機雷センサの規則は出撃ごとに必ず既定へ戻す。
    // 既存ミッション (m3-strike など) の機雷は陣営判定だけで動き続ける。
    resetMineSensors();
    // 重力井戸の宣言も出撃ごとに必ず捨てる。
    // これが無いと、宣言の無いミッションの飛行モデルに前の作戦の重力が残る。
    resetGravityWells();
    this.resonance = undefined;
    this.gravity = undefined;
    const list = this.def.hazards;
    if (!list?.length) return;
    // 熱紋機雷と共鳴パルスの宣言を取り込む (第3章)。
    // 回廊全体にかかる規則なので、最初に宣言した機雷帯の設定を作戦全体に適用する。
    for (const h of list) {
      if (h.kind !== 'minefield') continue;
      if (h.thermalOnly) configureMineSensors({ thermalOnly: true });
      if (h.resonance && !this.resonance) {
        this.resonance = {
          cycle: h.resonance.cycle,
          window: h.resonance.window,
          speaker: h.resonance.speaker,
          open: false,
          stopped: false,
        };
      }
    }
    let seed = 0;
    for (let i = 0; i < this.def.id.length; i++) seed = (seed * 31 + this.def.id.charCodeAt(i)) >>> 0;
    const r = new Rng(seed || 1);
    for (const h of list) this.spawnHazard(h, r);
  }

  private spawnHazard(h: HazardDef, r: Rng): void {
    const center = new Vector3();
    const along = new Vector3();
    if (h.betweenNavs) {
      const a = this.def.navs[h.betweenNavs[0]];
      const b = this.def.navs[h.betweenNavs[1]];
      if (a && b) {
        const pa = new Vector3(...a.pos);
        const pb = new Vector3(...b.pos);
        center.copy(pa).add(pb).multiplyScalar(0.5);
        along.copy(pb).sub(pa);
      }
    } else if (h.atNav !== undefined && this.def.navs[h.atNav]) {
      center.set(...this.def.navs[h.atNav].pos);
    }
    if (h.offset) center.add(new Vector3(...h.offset));

    const half = along.length() * 0.5;
    if (half > 1) along.normalize();

    // 重力井戸は機体も岩も置かない「空域の規則」なので、ここで宣言だけして戻る。
    // Nav 周りの空白 (pushOutOfClearZones) も適用しない。
    // 井戸が Nav を覆っていること自体がこの章の趣旨 (拘束点が井戸の中にある)。
    if (h.kind === 'gravity-well') {
      const g = h.gravity;
      this.registerGravityWell(center, h.spread, g);
      return;
    }

    // 帯ごと流す速度 (第4章)。宣言が無ければ 0 = 従来どおりの静的な帯。
    const drift = new Vector3();
    if (h.drift) {
      if (h.drift.dir) drift.set(...h.drift.dir);
      else if (half > 1) drift.copy(along);
      else drift.set(1, 0, 0);
      if (drift.lengthSq() < 1e-6) drift.set(1, 0, 0);
      drift.normalize().multiplyScalar(h.drift.speed);
    }

    for (let i = 0; i < h.count; i++) {
      const pos = center.clone();
      // 航路指定があれば線に沿って伸ばす (帯・封鎖線)
      if (half > 1) pos.addScaledVector(along, r.range(-half * 0.8, half * 0.8));
      pos.x += r.range(-h.spread, h.spread);
      pos.y += r.range(-h.spread * 0.45, h.spread * 0.45);
      pos.z += r.range(-h.spread, h.spread);
      this.pushOutOfClearZones(pos, r);

      if (h.kind === 'asteroids') {
        const [lo, hi] = h.rockRadius ?? [14, 70];
        spawnRock(this.world, {
          pos,
          radius: r.range(lo, hi),
          // 個々の漂流 (従来どおり) に、帯全体の流れを足す。
          // drift の宣言が無ければ加算はゼロなので、既存ミッションの岩は変わらない。
          vel: new Vector3(r.range(-8, 8), r.range(-4, 4), r.range(-8, 8)).add(drift),
          variant: Math.floor(r.range(0, 4)),
          seed: r.range(0, 100),
        });
      } else {
        spawnMine(this.world, { pos, ownerFaction: h.faction ?? 'kilrathi' });
      }
    }
  }

  /**
   * 重力井戸を1つ登録する (第4章)。
   *
   * 井戸は entity を持たない。**アンカー機を撃っても重力は消えない**
   * (アンカーは兵器ではなく境界標であり、撃つかどうかは別の選択なので、
   * 重力を機体の生死に結び付けない)。表示用の状態はここで持ち、
   * 物理そのものは `src/sim/obstacles.ts` が受け持つ。
   */
  private registerGravityWell(
    center: Vector3,
    radius: number,
    g: HazardDef['gravity'],
  ): void {
    const cycle = g?.cycle ?? 8;
    addGravityWell({
      pos: center,
      radius,
      cycle,
      swing: g?.swing,
      pull: g?.pull,
      // 井戸が複数あるときは山と谷をずらす (どこでも同時に重くならない)
      phase: this.gravity ? Math.PI * 0.5 : 0,
    });
    // 表示と無線は最初の井戸 (= アンカー) の周期に合わせる
    this.gravity ??= { cycle, speaker: g?.speaker, heavy: true, radioed: 0 };
  }

  /**
   * Nav 到達点と出撃地点の周りに空白を作る。
   *
   * オートパイロットは Nav へ一気に飛ぶので、そこに岩があると到達した瞬間に死ぬ。
   * 引き直しではなく外へ押し出すことで、Nav 中心に置いた field でも
   * 「Nav の周囲をドーナツ状に取り巻く岩」として成立する。
   */
  private pushOutOfClearZones(pos: Vector3, r: Rng): void {
    const zones: Array<{ c: Vector3; radius: number }> = [
      { c: new Vector3(), radius: 2000 },
      ...this.def.navs.map((n) => ({
        c: new Vector3(...n.pos),
        radius: (n.arriveRadius ?? 900) * 1.3 + 700,
      })),
    ];
    for (const z of zones) {
      _navCheck.copy(pos).sub(z.c);
      const d = _navCheck.length();
      if (d >= z.radius) continue;
      if (d < 1e-3) {
        // 完全に重なったときは適当な方向へ逃がす
        _navCheck.set(r.range(-1, 1), r.range(-0.4, 0.4), r.range(-1, 1));
        if (_navCheck.lengthSq() < 1e-6) _navCheck.set(1, 0, 0);
        _navCheck.normalize();
      } else {
        _navCheck.divideScalar(d);
      }
      pos.copy(z.c).addScaledVector(_navCheck, z.radius + r.range(0, 400));
    }
  }

  private spawnGroup(g: SpawnGroupDef): void {
    const world = this.world;
    const base = new Vector3();
    if (g.atNav !== undefined && this.def.navs[g.atNav]) {
      base.set(...this.def.navs[g.atNav].pos);
    }
    if (g.offset) base.add(new Vector3(...g.offset));

    const spread = g.spread ?? 260;
    const cruise = g.cruiseToNav !== undefined && this.def.navs[g.cruiseToNav]
      ? new Vector3(...this.def.navs[g.cruiseToNav].pos)
      : undefined;

    const player = world.player;
    const skill = g.skill ?? this.difficulty.enemySkill;
    /** この群で実際に出た機体 (誓約を破る側の登録に使う) */
    const spawnedIds: number[] = [];

    for (let i = 0; i < g.count; i++) {
      const isAce = !!g.ace && i === 0;
      const ace = isAce ? aceState(this.loadout.aceStates ?? [], g.ace!.pilot) : undefined;
      // 一度撃墜した宿敵は、別ミッションの同じ無線だけを残して再出現させない。
      // destroyTag が空になるケースは evaluateObjectives 側で達成扱いにする。
      if (isAce && ace?.status === 'killed') continue;
      if (isAce && ace) recordAceEncounter(ace, this.def.id);
      const id = isAce && g.ace?.shipId ? g.ace.shipId : g.shipId;
      const def = shipDef(id);
      const pos = base
        .clone()
        .add(
          new Vector3(
            rng.signed(spread) + (i - (g.count - 1) / 2) * spread * 0.9,
            rng.signed(spread * 0.4),
            rng.signed(spread),
          ),
        );
      // 自機の方を向いて出現させる (すぐ背後を取られないように)
      const quat = new Quaternion();
      const look = cruise ?? player?.pos ?? new Vector3();
      const dir = look.clone().sub(pos);
      if (dir.lengthSq() > 1e-6) {
        quat.setFromUnitVectors(new Vector3(0, 0, -1), dir.normalize());
      }

      const passive = def.role === 'transport' || def.role === 'capital';
      const aceSkill = ace?.skill ?? skill;
      const ai = newAi(isAce ? Math.min(1, Math.max(skill, aceSkill) + (g.ace?.skillBonus ?? 0.3)) : skill, {
        passive: passive || undefined,
        cruiseTo: cruise,
        leaderId: g.followPlayer ? player?.id : undefined,
        order: g.followPlayer ? 'form' : undefined,
      });

      const pilot = isAce
        ? g.ace!.pilot
        : g.faction === 'kilrathi'
          ? kilrathiName(i + Math.floor(this.elapsed))
          : undefined;

      const e = spawnShip(world, {
        def,
        faction: g.faction,
        pos,
        quat,
        speed: g.speed ?? def.maxSpeed * 0.6,
        speedScale: isHostile(g.faction, 'confed') && this.difficulty.id === 'easy' ? 0.5 : 1,
        tag: g.tag,
        pilot,
        ace: isAce,
        ai,
      });
      if (g.tag) {
        const list = this.tagIndex.get(g.tag) ?? [];
        list.push(e.id);
        this.tagIndex.set(g.tag, list);
      }
      spawnedIds.push(e.id);
      // 決闘規約 (第5章)。宣言のあるエースだけが「測る側」になる。
      if (isAce && g.ace?.duel && player) {
        const d = g.ace.duel;
        configureDuel({
          duellistId: e.id,
          opponentId: player.id,
          spareHullRatio: d.spareHullRatio,
          measureRange: d.measureRange,
        });
        this.duel = { entityId: e.id, def: d, crippled: false };
      }
      if (isAce && ace && ace.escaped > 0) {
        this.queueRadio(
          [{ speaker: g.ace!.pilot, text: ace.lastVictim ? `${ace.lastVictim} の名を覚えている。次は貴様の番だ。` : 'また会ったな。前回は貴様が生き延びただけだ。', tone: 'enemy' }],
          0.8,
        );
      }
    }

    // 誓約が破れる (第5章の急進派)。
    // 同じ陣営の中に「保護対象」と「撃破対象」が同時に存在する状態を、
    // 陣営関係ではなく決闘規約の側で表す。
    if (g.breaksOath && this.duel && spawnedIds.length > 0) {
      breakDuel(spawnedIds);
      if (this.duel.brokenAt === undefined) {
        this.duel.brokenAt = this.elapsed;
        bus.emit('announce', {
          text: '誓約が破られた — 決闘は終わった',
          kind: 'bad',
          durationMs: 2600,
        });
      }
    }

    if (g.radio) this.queueRadio(g.radio, 0.4);
  }

  /**
   * 戦域を離れていく敵を「撃退した」として外す。
   * これが無いと、逃げた敵を追えないまま destroyAll が永久に成立しない。
   * 「遠い」だけでは消さず、自機から離れる方向へ飛んでいることを条件にする
   * (プレイヤーが逃げた場合に、追ってきている敵を消してしまわないため)。
   */
  private removeRoutedEnemies(): void {
    const player = this.world.player;
    if (!player) return;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ai) continue;
      if (!isHostile(player.faction, e.faction)) continue;
      const away = _awayCheck.copy(e.pos).sub(player.pos);
      const d = away.length();
      if (d < FLED_DISTANCE) continue;
      if (d > 1e-4 && away.divideScalar(d).dot(e.vel) <= 0) continue; // まだ向かってくる
      this.world.kill(e);
      this.routed++;
      const ship = e.ship;
      if (ship?.ace && ship.pilot) {
        const state = aceState(this.loadout.aceStates ?? [], ship.pilot);
        if (state) recordAceEscape(state);
      }
      bus.emit('radio', {
        speaker: '管制',
        text: `${e.ship?.pilot ?? e.label ?? '敵機'} が戦域を離脱した。`,
        tone: 'command',
      });
    }
  }

  // ───────── 無線 ─────────

  private queueRadio(lines: RadioLineDef[], startDelay: number): void {
    let t = this.elapsed + startDelay;
    for (const line of lines) {
      // 選択記録と一致しない台詞は積まない (第9章)。
      // 条件を書いていない台詞は常に通るので、既存ミッションの無線は変わらない。
      if (!this.radioLineAllowed(line)) continue;
      t += line.after ?? 2.4;
      this.radioQueue.push({ line, at: t });
    }
  }

  private flushRadio(): void {
    while (this.radioQueue.length && this.radioQueue[0].at <= this.elapsed) {
      const { line } = this.radioQueue.shift()!;
      bus.emit('radio', { speaker: line.speaker, text: line.text, tone: line.tone });
    }
  }

  // ───────── 目標評価 ─────────

  private hostileShipsAlive(): number {
    const player = this.world.player;
    const faction = player?.faction ?? 'confed';
    let n = 0;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
      if (isHostile(faction, e.faction)) n++;
    }
    return n;
  }

  private allSpawnsReleased(): boolean {
    return this.pending.every((p) => p.released);
  }

  private tagAlive(tag: string): { total: number; alive: number } {
    const ids = this.tagIndex.get(tag) ?? [];
    let alive = 0;
    for (const id of ids) if (this.world.byId(id)) alive++;
    return { total: ids.length, alive };
  }

  /**
   * 救助。対象に接近すれば回収したものとして扱う。
   * 撃たれて失われた分は数に入らないので、放置すると達成できなくなる。
   */
  private evaluateRescue(
    o: ObjectiveRuntime,
    spec: { tag: string; radius?: number; disabledOnly?: boolean },
  ): void {
    const tag = spec.tag;
    const radius = spec.radius ?? 260;
    const ids = this.tagIndex.get(tag) ?? [];
    const player = this.world.player;
    const set = (o.collected ??= new Set<number>());
    if (player) {
      for (const id of ids) {
        if (set.has(id)) continue;
        // 戦闘不能の対象だけを拾う指定 (第5章)。
        // 宣言が無ければ従来どおり全対象が拾える。
        if (spec.disabledOnly && !this.disabledShipIds.has(id)) continue;
        const t = this.world.byId(id);
        if (!t) continue;
        if (t.pos.distanceTo(player.pos) - t.radius > radius) continue;
        set.add(id);
        this.rescuedCount += 1;
        // 敵陣営の脱出ポッド・被弾艦を拾った場合は別に数える (敵エースの誓約に効く)
        if (isHostile(this.playerFaction, t.faction)) this.enemyRescued += 1;
        bus.emit('announce', { text: `${t.label ?? '対象'} を回収`, kind: 'good', durationMs: 1800 });
        bus.emit('radio', {
          speaker: t.label ?? '救助信号',
          text: '……感謝する。母艦まで誘導を頼む。',
          tone: 'friendly',
        });
        // 回収したら戦域から外す (以後は守る必要がない)
        this.world.kill(t);
      }
    }
    // 生存しているうちに回収できなかった対象は失われた。rescue は
    // 「対象すべて」を回収する目標なので、1つでも失えば任務失敗にする。
    let lost = 0;
    for (const id of ids) {
      if (!set.has(id) && !this.world.byId(id)) lost++;
    }
    o.note = `${set.size}/${ids.length}${lost ? ` (喪失 ${lost})` : ''}`;
    if (ids.length > 0 && set.size + lost >= ids.length) {
      o.state = lost === 0 && set.size === ids.length ? 'done' : 'failed';
    }
  }

  /**
   * 偵察 (写真撮影)。対象を正面の狭い角度に一定距離まで収め続ける。
   * 撃つ必要はないが、逃げられたり追い散らされたりすると継続が途切れる。
   */
  private evaluateRecon(
    o: ObjectiveRuntime,
    spec: { tag: string; seconds?: number; range?: number; coneDeg?: number },
  ): void {
    const need = spec.seconds ?? 4;
    const range = spec.range ?? 1200;
    const cos = Math.cos(((spec.coneDeg ?? 18) * Math.PI) / 180);
    const player = this.world.player;
    const ids = this.tagIndex.get(spec.tag) ?? [];
    o.progress ??= 0;

    let holding = false;
    if (player) {
      forwardOf(player.quat, _reconFwd);
      for (const id of ids) {
        const t = this.world.byId(id);
        if (!t) continue;
        _reconTo.copy(t.pos).sub(player.pos);
        const d = _reconTo.length();
        if (d > range || d < 1e-3) continue;
        if (_reconTo.divideScalar(d).dot(_reconFwd) < cos) continue;
        holding = true;
        break;
      }
    }
    // 途切れたら少しだけ巻き戻す (完全リセットは厳しすぎる)
    o.progress = holding
      ? Math.min(need, o.progress + this.lastDt)
      : Math.max(0, o.progress - this.lastDt * 0.6);
    o.note = `${Math.floor((o.progress / need) * 100)}%`;
    if (o.progress >= need) o.state = 'done';
    else if (ids.length > 0 && ids.every((id) => !this.world.byId(id))) o.state = 'failed';
  }

  private evaluateObjectives(): void {
    const before = this.objectives.map((o) => o.state).join(',');
    this.evaluateCapitalStages();

    for (const o of this.objectives) {
      if (o.state === 'failed') continue;
      switch (o.def.spec.kind) {
        case 'destroyAll': {
          const done = this.allSpawnsReleased() && this.hostileShipsAlive() === 0;
          o.state = done ? 'done' : 'active';
          break;
        }
        case 'destroyTag': {
          const t = this.tagAlive(o.def.spec.tag);
          const stages = this.activeCapitalStages;
          const capitalTarget = stages[stages.length - 1]?.tag;
          const waitingForStage = capitalTarget === o.def.spec.tag && this.capitalStage < stages.length;
          o.state = !waitingForStage && ((t.total === 0 && this.allSpawnsReleased()) || (t.total > 0 && t.alive === 0))
            ? 'done'
            : 'active';
          break;
        }
        case 'protect': {
          const t = this.tagAlive(o.def.spec.tag);
          if (t.total > 0 && t.alive === 0) o.state = 'failed';
          else o.state = 'active';
          break;
        }
        case 'reachNav': {
          const idx = o.def.spec.navIndex;
          const nav = this.world.entities.find((e) => e.kind === 'nav' && e.nav?.index === idx);
          o.state = nav?.nav?.reached ? 'done' : 'active';
          // 通信妨害がある作戦 (第6章) では、味方位置が何秒古いかを同じ行に載せる。
          // T6-3 と同じ二経路 (無線 + 目標の note) でプレイヤーに伝えるため。
          o.note = this.commsDelayNote() || undefined;
          break;
        }
        case 'survive': {
          o.state = this.elapsed >= o.def.spec.seconds ? 'done' : 'active';
          o.note = `残り ${Math.max(0, Math.ceil(o.def.spec.seconds - this.elapsed))}s`;
          break;
        }
        case 'rescue': {
          this.evaluateRescue(o, o.def.spec);
          break;
        }
        case 'recon': {
          this.evaluateRecon(o, o.def.spec);
          break;
        }
        case 'timeLimit': {
          // 反射経路のペナルティ（第9章）は missionClock に入っている。
          // ペナルティが無ければ missionClock === elapsed なので判定式は従来と同値。
          const left = o.def.spec.seconds - this.missionClock;
          o.note = `残り ${Math.max(0, Math.ceil(left))}s`;
          // 重力井戸がある作戦 (第4章) では、いまの重力を同じ行に載せる。
          // HUD を触らずに「機動の前提がいつ崩れるか」を読めるようにするため。
          o.note += this.gravityNote();
          // 反射経路を踏んだ作戦 (第9章) では、縮んだ理由を同じ行に載せる。
          o.note += this.reflectionNote();
          if (left <= 0) o.state = 'failed';
          break;
        }
        case 'noFriendlyFire': {
          // 誤射は取り消せないので、1発当てた時点で確定して失敗させる
          o.note = this.friendlyFireHits > 0 ? `誤射 ${this.friendlyFireHits}` : '誤射 0';
          if (this.friendlyFireHits > 0) o.state = 'failed';
          break;
        }
        case 'weaponsSafe': {
          // 当たったかではなく「引き金を引いたか」で判定する
          o.note = this.shotsFired > 0 ? `発砲 ${this.shotsFired}` : '発砲なし';
          // 共鳴パルスがある作戦 (第3章) では、窓の状態を同じ行に載せる。
          // HUD 側に手を入れずに「いま撃っていいのか」を読めるようにするため。
          o.note += this.resonanceNote();
          if (this.shotsFired > 0) o.state = 'failed';
          break;
        }
        case 'protectCount': {
          const t = this.tagAlive(o.def.spec.tag);
          o.note = `${t.alive}/${t.total} 生存`;
          // まだ出現していない (total 0) 段階では判定しない
          if (t.total > 0 && t.alive < o.def.spec.min) o.state = 'failed';
          break;
        }
        case 'holdTag': {
          const min = o.def.spec.min ?? 1;
          const need = o.def.spec.seconds;
          const t = this.tagAlive(o.def.spec.tag);
          o.progress ??= 0;
          if (t.total === 0) {
            // 対象がまだ出ていない間は計測を始めない
            o.note = `残り ${Math.ceil(need)}s`;
            break;
          }
          if (t.alive < min) {
            o.note = `${t.alive}/${min} 維持`;
            o.state = 'failed';
            break;
          }
          o.progress = Math.min(need, o.progress + this.lastDt);
          o.note = `残り ${Math.max(0, Math.ceil(need - o.progress))}s`;
          if (o.progress >= need) o.state = 'done';
          break;
        }
      }
    }

    const after = this.objectives.map((o) => o.state).join(',');
    if (before !== after) {
      bus.emit('objectivesChanged', {});
      this.playtest?.recordObjectives(this.playtestObjectiveStates(), this.world.time);
    }

    // 勝敗判定
    const player = this.world.player;
    if (!player) {
      this.finish('loss');
      return;
    }
    // 脱出は「生き延びたが機体を失った」= 任務失敗
    if (player.ship?.ejected) {
      this.finish('loss');
      return;
    }
    const requiredFailed = this.objectives.some((o) => o.def.required && o.state === 'failed');
    if (requiredFailed) {
      this.finish('loss');
      return;
    }
    const requiredRemaining = this.objectives.some(
      (o) =>
        o.def.required &&
        // protect / timeLimit / noFriendlyFire / weaponsSafe / protectCount は
        // 「達成する目標」ではなく制約なので、完了条件に数えない (CONSTRAINT_KINDS)
        !CONSTRAINT_KINDS.has(o.def.spec.kind) &&
        o.state !== 'done',
    );
    if (!requiredRemaining) this.finish('win');
  }

  private evaluateCapitalStages(): void {
    const stages = this.activeCapitalStages;
    if (!stages.length) return;
    while (this.capitalStage < stages.length) {
      const stage = stages[this.capitalStage];
      const tag = this.tagAlive(stage.tag);
      // まだその段階のウェーブが出ていないなら、撃破扱いにはしない。
      const hasPending = this.pending.some((p) => !p.released && p.group.tag === stage.tag);
      if (hasPending || (tag.total === 0 && !this.allSpawnsReleased())) return;

      // 段階を待っている間に対象そのものが撃沈された場合は、
      // 「先に落とせてしまった」結果を詰みにしない。最終目標はすでに
      // 達成されているので、残り段階も完了扱いにする。
      if (tag.total > 0 && tag.alive === 0) {
        this.capitalStage = stages.length;
        return;
      }

      const subsystem = stage.subsystem;
      if (subsystem) {
        const targets = (this.tagIndex.get(stage.tag) ?? [])
          .map((id) => this.world.byId(id))
          .filter((e): e is Entity => !!e?.ship);
        if (targets.length === 0 || !targets.every((e) => stateOf(e.ship, subsystem) === 'dead')) return;
      } else if (stage.weapon) {
        if (tag.alive === 0 || !this.capitalTorpedoFired) return;
      } else if (tag.total > 0 && tag.alive > 0) {
        return;
      }

      this.capitalStage += 1;
      this.capitalTorpedoFired = false;
      bus.emit('announce', { text: `段階完了: ${stage.text}`, kind: 'good', durationMs: 2200 });
      if (stage.radio) this.queueRadio(stage.radio, 0.4);
    }
  }

  private get activeCapitalStages(): CapitalStageDef[] {
    return this.def.capitalSequence ?? this.def.capitalStages ?? [];
  }

  /** 艦艇強襲の進行段階。テスト・HUD 拡張用の読み取り専用値。 */
  get capitalStageIndex(): number {
    return this.capitalStage;
  }

  private finish(outcome: MissionState): void {
    if (this.state !== 'running') return;
    // 生存している宿敵は今回も離脱した。撃墜済みの state は変更しない。
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship?.ace || !e.ship.pilot) continue;
      const state = aceState(this.loadout.aceStates ?? [], e.ship.pilot);
      if (state) recordAceEscape(state);
    }
    this.playtest?.recordObjectives(this.playtestObjectiveStates(), this.world.time);
    this.playtest?.finish(outcome === 'win' ? 'win' : 'loss', this.world.time);
    this.state = outcome;
    bus.emit('missionEnded', { outcome: outcome === 'win' ? 'win' : 'loss' });
  }

  private playtestObjectiveStates(): PlaytestObjective[] {
    return this.objectives.map((o) => ({
      id: o.def.id,
      text: o.def.text,
      state: o.state,
    }));
  }

  /** HUD 表示用の目標一覧 */
  objectiveViews(): ObjectiveView[] {
    return this.objectives.map((o) => {
      const base = o.def.required ? o.def.text : `(任意) ${o.def.text}`;
      return {
        text: o.note && o.state === 'active' ? `${base} — ${o.note}` : base,
        state: o.state,
      };
    });
  }

  /** デブリーフ用の集計 */
  summary(): {
    kills: number;
    routed: number;
    objectives: ObjectiveView[];
    seconds: number;
    playerHullRatio: number;
    wingmanLost: boolean;
    wingmanKills: number;
    wingmanHullRatio: number;
    wingmanRescued: boolean;
    wingmanAbandoned: boolean;
    escortLost: boolean;
    acesKilled: number;
    shotsFired: number;
    hits: number;
    shipId: string;
    navsReached: number;
    escortSuccess: boolean;
    // ── 物語用の集計 (T4-2)。既存フィールドの意味は変えず、追加だけ行う ──
    /** rescue 目標で回収した対象の総数 */
    rescued: number;
    /** 失った中立・非敵対勢力の艦船数 (民間損害) */
    civilianLosses: number;
    /** 自機の射撃が味方・非敵対に命中した回数 */
    friendlyFireHits: number;
    /** 敵陣営の脱出ポッド・被弾艦を回収した数 */
    enemyRescued: number;
    /** 生還した僚機の数 */
    wingmenSurvived: number;
    /** 失った僚機の数 */
    wingmenLost: number;
    /** 未達成に終わった目標の id */
    objectivesFailed: string[];
    /**
     * タグごとの生存数 (T6-8)。第8章の通信灯台の残存本数のように、
     * 「何本残ったか」が次章の景色を決める場面で使う。
     *
     * 集計対象は出現済みのタグ付きグループすべて。目標種別に依存しないので、
     * `holdTag` / `protect` / `protectCount` のどれで守っていても同じ形で読める。
     */
    tagSurvivors: Record<string, { alive: number; total: number }>;
  } {
    const player = this.world.player;
    return {
      kills: this.kills,
      routed: this.routed,
      objectives: this.objectives.map((o) => ({ text: o.def.text, state: o.state })),
      seconds: this.elapsed,
      playerHullRatio: player?.ship
        ? player.ship.hull / Math.max(1, player.ship.def.hull)
        : 0,
      wingmanLost: this.wingmanLost,
      wingmanKills: this.wingmanKills,
      wingmanHullRatio: this.wingmanHullRatio,
      wingmanRescued: this.wingmanRescued,
      // 助けを求めたまま応えられずに終わった (死んだ or 要請が残ったまま)
      wingmanAbandoned: this.wingmanCalledForHelp || (this.wingmanLost && !this.wingmanRescued),
      escortLost: this.escortLost,
      acesKilled: this.acesKilled,
      shotsFired: this.shotsFired,
      hits: this.hits,
      shipId: player?.ship?.def.id ?? this.loadout.shipId,
      // 反射 Nav (第9章) は最初から「到達済み」で置いてある見せかけの記録なので、
      // 航路点の到達数には数えない。宣言の無いミッションでは従来と同じ値になる。
      navsReached: this.world.entities.filter(
        (e) =>
          e.kind === 'nav' &&
          e.nav?.reached &&
          !this.def.navs[e.nav.index]?.reflection,
      ).length,
      escortSuccess: !this.escortLost,
      rescued: this.rescuedCount,
      civilianLosses: this.civilianLosses,
      friendlyFireHits: this.friendlyFireHits,
      enemyRescued: this.enemyRescued,
      // 僚機は現状1機編成。人数で持たせておき、複数編成になっても呼び出し側を変えない
      wingmenSurvived: this.wingmanEntityId !== undefined && !this.wingmanLost ? 1 : 0,
      wingmenLost: this.wingmanLost ? 1 : 0,
      objectivesFailed: this.unmetObjectiveIds(),
      tagSurvivors: this.tagSurvivors(),
    };
  }

  /** タグごとの生存数。出現していないタグは含めない (総数が判らないため)。 */
  private tagSurvivors(): Record<string, { alive: number; total: number }> {
    const out: Record<string, { alive: number; total: number }> = {};
    for (const tag of this.tagIndex.keys()) out[tag] = this.tagAlive(tag);
    return out;
  }

  /**
   * 未達成に終わった目標の id。
   *
   * 「破られた制約 (failed)」と「達成できなかった勝利条件」の両方を残す。
   * 成立し続けている制約 (protect などが active のまま) は達成扱いなので含めない。
   */
  private unmetObjectiveIds(): string[] {
    return this.objectives
      .filter(
        (o) =>
          o.state === 'failed' ||
          (o.state !== 'done' && !CONSTRAINT_KINDS.has(o.def.spec.kind)),
      )
      .map((o) => o.def.id);
  }

  /**
   * 戦域を離脱してよいか。
   *
   * 戦闘系の必須目標をすべて片付け、あとは帰投するだけの状態なら true。
   * このとき敵が残っていてもオートパイロットを許可する
   * (でないと「目標達成したのに帰れない」状態で詰む)。
   */
  get canDisengage(): boolean {
    let hasReturnNav = false;
    for (const o of this.objectives) {
      if (!o.def.required) continue;
      if (o.def.spec.kind === 'reachNav') {
        if (o.state !== 'done') hasReturnNav = true;
        continue;
      }
      // 制約 (protect / 誤射禁止 / 発砲禁止 / N隻生存) は達成待ちにならない。
      // 破られていなければ帰投を妨げない。timeLimit は既存挙動のまま残す。
      if (o.def.spec.kind !== 'timeLimit' && CONSTRAINT_KINDS.has(o.def.spec.kind)) {
        if (o.state === 'failed') return false;
        continue;
      }
      if (o.state !== 'done') return false;
    }
    return hasReturnNav;
  }

  /** 護衛対象など、いま向かうべき Nav */
  get currentNav(): Entity | undefined {
    let best: Entity | undefined;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'nav' || !e.nav || e.nav.reached) continue;
      if (!best || e.nav.index < best.nav!.index) best = e;
    }
    return best;
  }
}
