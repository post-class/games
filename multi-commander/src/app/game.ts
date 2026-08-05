import { Vector3 } from 'three';
import { audio } from '../audio/AudioManager';
import { CombatAudio } from '../audio/CombatAudio';
import { bus } from '../core/events';
import { forwardOf } from '../core/math';
import { FIXED_DT, Loop } from '../core/loop';
import { enemyTauntReply, playerTaunt, wingmanAck } from '../content/dialogue';
import { HudView } from '../hud/HudView';
import { AIM_PITCH_OFFSET } from '../core/aim';
import { MissionRunner } from '../mission/MissionRunner';
import type { Loadout, MissionDef } from '../mission/types';
import { CameraRig } from '../render/CameraRig';
import { CombatVfx } from '../render/CombatVfx';
import { RenderSync } from '../render/RenderSync';
import { Landmarks } from '../render/Landmarks';
import { SceneSetup } from '../render/SceneSetup';
import { setWingmanOrder } from '../sim/ai';
import { setCombatOptions } from '../sim/combat';
import { canEject, eject } from '../sim/eject';
import { commsAvailable, hasDamage } from '../sim/subsystems';
import { canAutopilot, nextNav, updateAutopilot } from '../sim/nav';
import { simulateStep, snapshotForRender } from '../sim/step';
import { targetFront, targetNearest, targetNext } from '../sim/targeting';
import { cycleMissile, dropFlare, fireMissile } from '../sim/weapons';
import type { Entity, WingmanOrder } from '../world/entity';
import { World } from '../world/world';
import { DeckSequence } from './DeckSequence';
import { CommsMenu, type CommsAction } from '../ui/CommsMenu';
import { Tutorial } from '../ui/Tutorial';
import { InputManager } from './input';
import { difficulty, settings } from './settings';
import { ReplayBuffer } from './replay';
import { PlaytestLog, type PlaytestRecorder } from './playtest';

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
    this.input = new InputManager(overlay);
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
      bus.on('missionEnded', (p) => {
        if (this.activePlaytest) {
          this.playtestLog.complete(this.activePlaytest);
          this.activePlaytest = undefined;
        }
        if (this.endedOutcome) return;
        this.endedOutcome = p.outcome;
        // 勝ったときは着艦の演出を挟んでから画面を切り替える
        const player = this.world.player;
        if (p.outcome === 'win' && player && !player.ship?.ejected) {
          this.deck.startLanding(this.world, player);
          this.endDelay = 4.2;
        } else {
          this.endDelay = 3.2;
        }
        bus.emit('announce', {
          text: p.outcome === 'win' ? '任務達成' : '任務失敗',
          kind: p.outcome === 'win' ? 'good' : 'bad',
          durationMs: 3000,
        });
      }),
    );
  }

  applySettings(): void {
    const d = difficulty();
    setCombatOptions({
      playerDamageTaken: d.playerDamageTaken,
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

  triggerHitStop(ms: number): void {
    this.hitStopLeft = Math.max(this.hitStopLeft, ms / 1000);
  }

  // ───────── ミッションの開始と終了 ─────────

  startMission(def: MissionDef, loadout: Loadout, withTutorial = false): void {
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
    this.runner.build();

    this.endedOutcome = undefined;
    this.endDelay = 0;
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
    this.input.disarmMouse();
    this.comms.setOpen(false);
    // 出撃直後は静止から。やさしい難易度では初速が入る
    this.input.throttle = this.world.player ? this.world.player.input!.throttle : 0;
    this.rig.mode = 'cockpit';
    if (withTutorial) this.tutorial.start();
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
  }

  endMission(): void {
    this.deck.reset();
    this.tutorial.finish(false);
    audio.stopEngine();
    this.runner?.dispose();
    this.runner = undefined;
    this.world.reset();
    this.sync.clear();
    this.vfx.vfx.clear();
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

    // ミッション終了後の余韻。演出だけ進めて入力は受け付けない
    if (this.endedOutcome) {
      this.endDelay -= dt;
      snapshotForRender(this.world);
      this.deck.update(this.world, dt);
      simulateStep(this.world, dt, {
        flightMode: settings.flightMode,
        ai: this.aiOptions(),
        playerGunAimPitchOffset: AIM_PITCH_OFFSET,
      });
      if (this.endDelay <= 0) {
        const outcome = this.endedOutcome;
        this.endedOutcome = undefined;
        this.active = false;
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
    });
    this.runner?.update(dt);
    this.replay.record(this.world, this.input, dt);
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
    if (!settings.aimAssist) return 0;
    return difficulty().strongAimHelp ? 1 : 0.45;
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
    if (this.active) this.handleActions();
    else this.input.consumeActions();

    const player = this.world.player;
    const frozen = this.paused || !this.active;
    this.sync.hidePlayer = this.rig.mode === 'cockpit';
    this.scene.cockpit.setVisible(this.active && this.rig.mode === 'cockpit' && settings.cockpitDecorations);
    this.hud.setCockpitDecorations(settings.cockpitDecorations);
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
    this.rig.update(player, dtReal, abActive || this.autopilot);
    this.scene.render();
    this.sound.update(this.world, dtReal, this.active && !this.paused);
    if (this.active && !this.paused) {
      this.tutorial.update(
        { world: this.world, input: this.input, autopilot: this.autopilot },
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
        mouseFlight: this.input.mouseStickEnabled && !this.autopilot,
        mouseArmPending:
          this.input.mouseFlight && !this.input.gamepadConnected && !this.input.mouseArmed,
        stick: { x: this.input.mousePx, y: this.input.mousePy },
        objectives: this.runner?.objectiveViews(),
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
    for (const a of actions) {
      switch (a) {
        case 'pause':
          this.onPauseRequested?.();
          break;
        case 'viewToggle':
          this.rig.toggle();
          break;
        case 'damageDisplay':
          this.hud.damageMode = !this.hud.damageMode;
          break;
        case 'navMap':
          this.hud.navMap.toggle();
          break;
        case 'comms':
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
          this.input.mouseFlight = !this.input.mouseFlight;
          bus.emit('announce', {
            text: `マウス操縦: ${this.input.mouseFlight ? 'ON' : 'OFF'}`,
          });
          break;
        case 'autopilot':
          this.toggleAutopilot();
          break;
        case 'targetNext':
          if (player) targetNext(this.world, player);
          break;
        case 'targetNearest':
          if (player) targetNearest(this.world, player);
          break;
        case 'targetFront':
          if (player) targetFront(this.world, player);
          break;
        case 'nextSecondary':
          if (player) cycleMissile(player);
          break;
        case 'fireMissile':
          if (player && !this.autopilot) {
            const r = fireMissile(this.world, player);
            if (!r.fired) {
              bus.emit('announce', {
                text: r.reason === 'no-lock' ? 'ロックしていない' : 'ミサイル切れ',
                kind: 'warn',
              });
            }
          }
          break;
        case 'flare':
          if (player && !dropFlare(this.world, player)) {
            bus.emit('announce', { text: 'フレアなし', kind: 'warn' });
          }
          break;
        case 'eject':
          this.tryEject();
          break;
        case 'flightModeToggle':
          if (settings.advanced) {
            settings.flightMode = settings.flightMode === 'wc' ? 'newton' : 'wc';
            bus.emit('announce', { text: `飛行モード: ${settings.flightMode.toUpperCase()}` });
          }
          break;
        default:
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
