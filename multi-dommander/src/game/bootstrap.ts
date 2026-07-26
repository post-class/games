import type { Game } from "./Game";
import { createGameState } from "./GameState";
import { InputManager } from "./input/InputManager";
import { AudioManager } from "./AudioManager";
import { MissionManager } from "./mission/MissionManager";
import { MissionScreens } from "./ui/MissionScreens";
import { GameController } from "./GameController";

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
import { ExplosionSystem } from "./systems/ExplosionSystem";
import { CameraRig } from "../render/CameraRig";
import { HudView } from "../hud/HudView";

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

  // --- UI・進行管理 ---
  const screens = new MissionScreens(container);
  const explosions = new ExplosionSystem(render.scene, events);
  const controller = new GameController(game, state, mission, screens, explosions);

  // --- 固定ステップ系 (順序が重要) ---
  scheduler
    .addFixed(new InputSystem(input, (text) => mission.announce(text, game.simTime)))
    .addFixed(new AISystem())
    .addFixed(new WeaponSystem(render.scene, events))
    .addFixed(new FlightModelSystem())
    .addFixed(new ProjectileSystem())
    .addFixed(new MissileSystem())
    .addFixed(new CollisionSystem(events, simTime))
    .addFixed(new DamageSystem(events, simTime))
    .addFixed(new TargetingSystem())
    .addFixed(new MissionSystem(mission, state, events, simTime, (r) => controller.onMissionEnd(r)));

  // --- 可変ステップ系 (描画同期・カメラ・HUD) ---
  const hudView = new HudView(container);
  scheduler
    .addVariable(new SyncTransformSystem())
    .addVariable(new CameraRig(render.camera, getPlayer))
    .addVariable(explosions)
    .addVariable(new HudSystem(hudView, render.camera, mission, state, simTime));

  // タイトル画面から開始。
  controller.start();
}
