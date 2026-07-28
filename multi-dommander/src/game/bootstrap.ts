import type { Game } from "./Game";
import { createGameState } from "./GameState";
import { Comp, Faction } from "./components";
import type { ShipInfo, Transform } from "./components";
import { spawnDecoy } from "./weapons/projectileFactory";
import { InputManager } from "./input/InputManager";
import { AudioManager } from "./AudioManager";
import { MissionManager } from "./mission/MissionManager";
import { MissionScreens } from "./ui/MissionScreens";
import { GameController } from "./GameController";
import { SettingsStore } from "./Settings";

// systems
import { InputSystem } from "./systems/InputSystem";
import { AISystem } from "./systems/AISystem";
import { WeaponSystem } from "./systems/WeaponSystem";
import { FlightModelSystem } from "./systems/FlightModelSystem";
import { ProjectileSystem } from "./systems/ProjectileSystem";
import { MissileSystem } from "./systems/MissileSystem";
import { CollisionSystem } from "./systems/CollisionSystem";
import { DamageSystem } from "./systems/DamageSystem";
import { TargetingSystem } from "./systems/TargetingSystem";
import { MissionSystem } from "./systems/MissionSystem";
import { SyncTransformSystem } from "./systems/SyncTransformSystem";
import { HudSystem } from "./systems/HudSystem";
import { AudioSystem } from "./systems/AudioSystem";
import { ExplosionSystem } from "./systems/ExplosionSystem";
import { MuzzleFlashSystem } from "./systems/MuzzleFlashSystem";
import { TrailSystem } from "./systems/TrailSystem";
import { EnginePlumeSystem } from "./systems/EnginePlumeSystem";
import { CameraRig } from "../render/CameraRig";
import { HudView } from "../hud/HudView";
import { VfxManager } from "../render/VfxManager";
import { registerCombatVfx } from "../render/vfx/CombatVfx";
import { PerfOverlay } from "../render/PerfOverlay";

/** ゲームのエンティティ・システム・HUD を初期化して配線する。 */
export function bootstrap(game: Game, container: HTMLElement): void {
  const { world, scheduler, render, events } = game;
  const state = createGameState();
  const simTime = () => game.simTime;

  // Playing 中のみ物理シミュレーションを進める (ブリーフィング/デブリーフ中は凍結)。
  game.shouldRunFixed = () => state.phase === "Playing";

  // --- ミッション ---
  const mission = new MissionManager(world, render.scene);
  const getPlayer = () => mission.getPlayer();

  // --- 入力・サウンド ---
  const input = new InputManager(container);
  const audio = new AudioManager(events);
  window.addEventListener("keydown", () => audio.enable(), { once: true });

  // --- VFX (プール付き視覚効果マネージャ) ---
  const vfx = new VfxManager(render.scene);
  registerCombatVfx(vfx); // 爆発/マズル/トレイル等のプールを登録。

  // --- UI・進行管理 ---
  const screens = new MissionScreens(container);
  const explosions = new ExplosionSystem(events, vfx);
  const settings = { difficulty: SettingsStore.load() };
  const controller = new GameController(game, state, mission, screens, explosions, settings);

  // --- 固定ステップ系 (順序が重要) ---
  scheduler
    .addFixed(
      new InputSystem(
        input,
        (text) => mission.announce(text, game.simTime),
        () => {
          // フレア射出: 自機位置にデコイを生成 (敵ミサイルを引き剥がす)。
          const player = getPlayer();
          if (player !== null && world.has(player, Comp.Transform)) {
            const t = world.getOrThrow<Transform>(player, Comp.Transform);
            spawnDecoy(world, render.scene, t.position, Faction.Player);
          }
        },
      ),
    )
    .addFixed(new AISystem())
    .addFixed(new WeaponSystem(render.scene, events))
    .addFixed(new FlightModelSystem())
    .addFixed(new ProjectileSystem())
    .addFixed(new MissileSystem())
    .addFixed(new CollisionSystem(events, simTime))
    .addFixed(new DamageSystem(events, simTime))
    .addFixed(new TargetingSystem())
    .addFixed(new MissionSystem(mission, state, events, simTime, (r) => controller.onMissionEnd(r)));

  // --- 可変ステップ系 (描画同期・カメラ・VFX・HUD) ---
  const hudView = new HudView(container);
  // 命中/撃墜/被弾の即時フィードバック (ヒットマーカー/キルフィード/被弾ビネット)。
  hudView.subscribeFeedback(
    events,
    (id) => id === getPlayer(),
    (id) => {
      const info = world.get<ShipInfo>(id, Comp.ShipInfo);
      if (!info) return "敵機";
      return info.isAce ? `★ ${info.displayName}` : info.displayName;
    },
  );
  const cameraRig = new CameraRig(render.camera, getPlayer);
  const perf = new PerfOverlay(container, render.renderer, () => vfx.activeCount());

  // カメラ演出・ヒットストップのイベント配線 (自機が関与する時のみ発火)。
  events.on("cameraShake", (e) => cameraRig.addShake(e.intensity));
  events.on("hit", (e) => {
    if (e.target === getPlayer()) {
      cameraRig.addShake(0.3);
      cameraRig.kickFov(3);
    }
  });
  events.on("destroyed", (e) => {
    const player = getPlayer();
    if (e.entity === player) {
      // 自機撃墜: 強いシェイク + FOV + ヒットストップ。
      cameraRig.addShake(0.8);
      cameraRig.kickFov(12);
      game.triggerHitStop(140);
    } else if (e.source === player) {
      // 自分の撃墜: とどめの手応え。
      cameraRig.addShake(0.35);
      cameraRig.kickFov(9);
      game.triggerHitStop(60);
    }
  });

  scheduler
    .addVariable(new SyncTransformSystem())
    .addVariable(cameraRig)
    .addVariable(new MuzzleFlashSystem(events, vfx))
    .addVariable(new TrailSystem(vfx))
    .addVariable(new EnginePlumeSystem(vfx))
    .addVariable(explosions)
    .addVariable(vfx)
    .addVariable(new AudioSystem(audio, render.camera, getPlayer, () => state.phase))
    .addVariable(new HudSystem(hudView, render.camera, mission, state, simTime))
    .addVariable(perf);

  // タイトル画面から開始。
  controller.start();
}
