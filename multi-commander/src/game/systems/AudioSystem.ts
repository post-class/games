import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { AudioManager } from "../AudioManager";
import type { PerspectiveCamera } from "three";
import type { EntityId } from "../../ecs/Entity";
import type { GamePhase } from "../GameState";
import { Comp, type RigidBody, type FlightModel, type ThrusterInput, type Health, type Missile } from "../components";
import { Vector3, Quaternion } from "three";

/** GamePhase → AudioManager の BGMフェーズ名。 */
const MUSIC_PHASE: Record<GamePhase, "menu" | "briefing" | "playing" | "debrief"> = {
  Menu: "menu",
  Briefing: "briefing",
  Playing: "playing",
  Paused: "playing",
  Debrief: "debrief",
};

/**
 * AudioSystem: 毎フレーム自機状態を読み取り、AudioManager に反映する可変レートSystem。
 * - カメラの姿勢 → リスナー位置/向き
 * - 自機の速度/スロットル → エンジン音
 * - 自機のシールド残量 → 低シールド警報
 * - AudioManager.update(dt) を呼び、警報/BGMの時刻ベース更新を駆動する。
 */
export class AudioSystem implements System {
  readonly name = "AudioSystem";

  // 一時オブジェクト(GC削減)
  private tmpPos = new Vector3();
  private tmpForward = new Vector3();
  private tmpUp = new Vector3();
  private tmpQuat = new Quaternion();

  private lastPhase: GamePhase | null = null;

  constructor(
    private audio: AudioManager,
    private camera: PerspectiveCamera,
    private getPlayer: () => EntityId | null,
    private getPhase: () => GamePhase,
  ) {}

  update(world: World, dt: number, _alpha: number): void {
    if (!this.audio.enabled) return;

    // (0) ゲームフェーズに応じて BGM を切り替える (変化時のみ)。
    const phase = this.getPhase();
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.audio.setMusicPhase(MUSIC_PHASE[phase]);
    }

    // (1) カメラのワールド位置/向きをリスナーに反映
    this.updateListener();

    // (2) 自機の状態からエンジン音・警報を更新
    const player = this.getPlayer();
    if (player !== null && world.isAlive(player)) {
      this.updatePlayerAudio(world, player);
    } else {
      // 自機不在時はエンジン/警報をOFF
      this.audio.setEnginePower(0, false);
      this.audio.setLowShieldAlarm(false);
    }

    // (2b) 被ロック警報: 自機を誘導対象とするミサイルが飛来していれば警報。
    this.audio.setMissileWarning(player !== null && this.incomingMissile(world, player));

    // (3) AudioManager の時刻ベース更新(BGM/警報のスケジューリング)
    this.audio.update(dt);
  }

  /** 自機を誘導対象とする誘導ミサイルが存在するか (被ロック警報用)。 */
  private incomingMissile(world: World, player: EntityId): boolean {
    for (const mis of world.query(Comp.Missile)) {
      const m = world.get<Missile>(mis, Comp.Missile);
      if (m && m.target === player) return true;
    }
    return false;
  }

  private updateListener(): void {
    // カメラのワールド変換を取得
    this.camera.getWorldPosition(this.tmpPos);
    this.camera.getWorldQuaternion(this.tmpQuat);

    // 前方向と上方向を計算
    this.tmpForward.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    this.tmpUp.set(0, 1, 0).applyQuaternion(this.tmpQuat);

    this.audio.setListener(this.tmpPos, this.tmpForward, this.tmpUp);
  }

  private updatePlayerAudio(world: World, player: EntityId): void {
    // エンジン音: RigidBody.velocity と FlightModel.maxLinearSpeed からスロットルを推定
    const rb = world.get<RigidBody>(player, Comp.RigidBody);
    const fm = world.get<FlightModel>(player, Comp.FlightModel);
    const input = world.get<ThrusterInput>(player, Comp.ThrusterInput);

    let throttle = 0;
    let afterburner = false;

    if (rb && fm) {
      const speed = rb.velocity.length();
      // スロットル推定: 速度を最大速度で正規化(0..1)
      throttle = Math.min(1, speed / (fm.maxLinearSpeed || 1));
    }

    if (input) {
      // アフターバーナー状態を読む
      afterburner = input.afterburner;
      // inputからスロットル(linear.z)を直接使う方が正確(速度は慣性で遅延するため)
      // linear.z は -1..1 なので 0..1 に正規化
      const inputThrottle = Math.max(0, input.linear.z);
      throttle = Math.max(throttle, inputThrottle); // どちらか大きい方を採用
    }

    this.audio.setEnginePower(throttle, afterburner);

    // 低シールド警報: シールドが25%未満で警報
    const health = world.get<Health>(player, Comp.Health);
    if (health) {
      const shieldRatio = health.shieldMax > 0 ? health.shield / health.shieldMax : 1;
      const lowShield = shieldRatio < 0.25;
      this.audio.setLowShieldAlarm(lowShield);
    } else {
      this.audio.setLowShieldAlarm(false);
    }
  }
}
