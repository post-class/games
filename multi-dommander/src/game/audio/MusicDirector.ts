/**
 * 動的BGM指揮者: 脅威度(0..1)に応じてレイヤー(ステム)をクロスフェードする。
 * 全レイヤーを常時再生し、GainNodeの値のみを調整することで位相ズレを完全回避。
 */

/** 脅威度推定用の入力値(将来拡張用)。現在は未使用。 */
export interface ThreatInputs {
  attackingEnemies: number;
  lockedOnPlayer: number;
  nearbyHostiles: number;
  playerShieldRatio: number;
}

/** ゲームフェーズ。BGMの挙動を切り替える。 */
export type MusicPhase = "menu" | "briefing" | "playing" | "debrief";

/**
 * 脅威度を音楽レイヤーへの入力として滑らかに追従させるための指数移動平均フィルタ。
 * 急激な変化をスムージングして自然なクロスフェードを実現する。
 */
class ThreatFilter {
  private current = 0;

  update(target: number, dt: number, timeConstant = 2.0): number {
    // 指数移動平均: current += (target - current) * dt / timeConstant
    const alpha = Math.min(1, dt / timeConstant);
    this.current += (target - this.current) * alpha;
    return this.current;
  }

  reset(value = 0): void {
    this.current = value;
  }
}

/**
 * MusicDirector: 動的BGMの管理。
 * 平時レイヤー(静かなパッド/ドローン)と戦闘レイヤー(緊張感)を常時ループ再生し、
 * 脅威度(直近数秒の戦闘イベントレートから推定)に応じてGainをクロスフェードする。
 * ロード不要の合成音でプレースホルダ実装し、将来的に音源ファイルに差し替え可能。
 */
export class MusicDirector {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;

  // 合成レイヤー: 平時と戦闘の2系統
  private ambientGain: GainNode | null = null;
  private combatGain: GainNode | null = null;
  private ambientOsc: OscillatorNode | null = null;
  private combatOsc: OscillatorNode | null = null;

  // 脅威度のスムージング
  private threatFilter = new ThreatFilter();
  private currentPhase: MusicPhase = "menu";

  /** 直近数秒の戦闘イベント頻度から推定した脅威度の生値。外部(イベント購読)から更新される。 */
  private rawThreat = 0;
  /** 戦闘イベント頻度の指数移動平均(秒あたりイベント数)。 */
  private eventRate = 0;
  private lastEventTime = 0;

  /**
   * @param ctx AudioContext
   * @param bus 出力先(musicBus)
   */
  constructor(ctx: AudioContext, bus: GainNode) {
    this.ctx = ctx;
    this.bus = bus;
    this.initLayers();
  }

  /**
   * 合成レイヤーの初期化。
   * 平時: 低周波パッド(サイン波2和音)
   * 戦闘: 速いパルス(矩形波+フィルタ)
   * いずれもうるさすぎない音量に抑える。
   */
  private initLayers(): void {
    if (!this.ctx || !this.bus) return;

    // 平時レイヤー: C2(65.4Hz)とG2(98Hz)のサイン波和音(低いドローン)
    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0; // 初期は無音
    this.ambientGain.connect(this.bus);

    const osc1 = this.ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 65.4;
    const g1 = this.ctx.createGain();
    g1.gain.value = 0.08;
    osc1.connect(g1).connect(this.ambientGain);
    osc1.start();

    const osc2 = this.ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 98;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.06;
    osc2.connect(g2).connect(this.ambientGain);
    osc2.start();

    this.ambientOsc = osc1; // 代表として保持(stop用)

    // 戦闘レイヤー: 矩形波パルス(A2, 110Hz)+ フィルタで緊張感を演出
    this.combatGain = this.ctx.createGain();
    this.combatGain.gain.value = 0;
    this.combatGain.connect(this.bus);

    const oscCombat = this.ctx.createOscillator();
    oscCombat.type = "square";
    oscCombat.frequency.value = 110;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 800;
    filter.Q.value = 2;

    const gCombat = this.ctx.createGain();
    gCombat.gain.value = 0.10;

    oscCombat.connect(filter).connect(gCombat).connect(this.combatGain);
    oscCombat.start();

    this.combatOsc = oscCombat;
  }

  /**
   * 戦闘イベント(weaponFired/hit/destroyed)発生時に呼ばれる。
   * 直近数秒のレートを指数移動平均で追跡し、脅威度を推定する。
   */
  recordEvent(): void {
    const now = performance.now() / 1000;
    if (this.lastEventTime > 0) {
      const dt = now - this.lastEventTime;
      // 秒あたりイベント頻度を指数移動平均で更新(減衰時定数1秒)
      const instantRate = dt > 0 ? 1 / dt : 0;
      const alpha = Math.min(1, dt / 1.0);
      this.eventRate = this.eventRate * (1 - alpha) + instantRate * alpha;
    }
    this.lastEventTime = now;

    // 脅威度: イベントレート(秒あたり3回を上限)を0..1に正規化
    this.rawThreat = Math.min(1, this.eventRate / 3);
  }

  /**
   * 毎フレーム(または低頻度, 10Hz程度)呼ばれる。
   * フェーズと脅威度からレイヤーゲインを計算し、滑らかに追従させる。
   * @param dt 前回からの経過秒
   */
  update(dt: number): void {
    if (!this.ctx || !this.ambientGain || !this.combatGain) return;

    // フェーズが戦闘外(menu/briefing/debrief)なら脅威度を無視してambientのみ
    let effectiveThreat = this.currentPhase === "playing" ? this.rawThreat : 0;

    // 脅威度をスムージング(時定数2秒)
    const smoothThreat = this.threatFilter.update(effectiveThreat, dt);

    // レイヤーゲインの計算: smoothstep関数で滑らかに遷移
    // ambient: 脅威度0で1.0、0.5で0.4程度に減衰
    const ambientTarget = 1 - smoothstep(0, 0.5, smoothThreat) * 0.6;
    // combat: 脅威度0.2から立ち上がり、0.8で最大
    const combatTarget = smoothstep(0.2, 0.8, smoothThreat);

    // setTargetAtTime で指数的に追従(時定数0.3秒)
    const t = this.ctx.currentTime;
    this.ambientGain.gain.setTargetAtTime(ambientTarget, t, 0.3);
    this.combatGain.gain.setTargetAtTime(combatTarget, t, 0.3);
  }

  /**
   * ゲームフェーズの変更。
   * @param phase menu: 無音, briefing: ambient小, playing: 脅威度追従, debrief: ambient小
   */
  setPhase(phase: MusicPhase): void {
    this.currentPhase = phase;
    this.threatFilter.reset(phase === "playing" ? this.rawThreat : 0);

    if (!this.ctx || !this.ambientGain || !this.combatGain) return;
    const t = this.ctx.currentTime;

    // フェーズ別の初期ゲイン設定
    if (phase === "menu") {
      // メニューは無音(enable前の可能性もあるため)
      this.ambientGain.gain.setTargetAtTime(0, t, 0.5);
      this.combatGain.gain.setTargetAtTime(0, t, 0.5);
    } else if (phase === "briefing" || phase === "debrief") {
      // ブリーフィング/デブリーフ: 静かなambientのみ
      this.ambientGain.gain.setTargetAtTime(0.6, t, 0.8);
      this.combatGain.gain.setTargetAtTime(0, t, 0.5);
    } else {
      // playing: 脅威度に応じて動的に変化(update()が制御)
      // ここでは初期値としてambientを設定
      this.ambientGain.gain.setTargetAtTime(1, t, 0.8);
      this.combatGain.gain.setTargetAtTime(0, t, 0.5);
    }
  }

  /**
   * 停止(将来の音源差し替え用。現在は合成なので不要だが互換性のためAPI提供)。
   */
  stop(): void {
    if (this.ambientOsc) {
      this.ambientOsc.stop();
      this.ambientOsc = null;
    }
    if (this.combatOsc) {
      this.combatOsc.stop();
      this.combatOsc = null;
    }
  }
}

/** smoothstep 補間関数。0..1の滑らかなカーブ。 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
