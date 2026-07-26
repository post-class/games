import { Vector3, Quaternion } from "three";
import type { Game } from "./Game";
import type { EntityId } from "../ecs/Entity";
import { Comp, Faction } from "./components";
import type { Targeting } from "./components";
import type { AIController } from "./components/AIController";
import { SHIP_DEFS } from "./ships/shipDefinitions";
import { spawnShip } from "./ships/ShipFactory";
import { InputManager } from "./input/InputManager";
import { createGameState } from "./GameState";
import { AudioManager } from "./AudioManager";

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
import { GameRuleSystem } from "./systems/GameRuleSystem";
import { SyncTransformSystem } from "./systems/SyncTransformSystem";
import { HudSystem } from "./systems/HudSystem";
import { ExplosionSystem } from "./systems/ExplosionSystem";
import { CameraRig } from "../render/CameraRig";
import { HudView } from "../hud/HudView";

/** ゲームのエンティティ・システム・HUD を初期化して配線する。 */
export function bootstrap(game: Game, container: HTMLElement): void {
  const { world, scheduler, render, events } = game;
  const state = createGameState();

  // --- プレイヤー機 ---
  const player = spawnShip(world, render.scene, SHIP_DEFS.rapier, {
    position: new Vector3(0, 0, 0),
    faction: Faction.Player,
  });
  world.add(player, Comp.PlayerControlled, true);
  world.add<Targeting>(player, Comp.Targeting, { target: null, lockProgress: 0, lockTime: 0 });

  // プレイヤー参照 (撃墜されると world から消えるため getter で毎回確認)。
  const getPlayer = (): EntityId | null => (world.isAlive(player) ? player : null);

  // --- 敵編隊 ---
  spawnWave(game);

  // --- 入力・サウンド ---
  const input = new InputManager(container);
  const audio = new AudioManager(events);
  // 最初のキー操作で AudioContext を有効化 (自動再生制限対策)。
  window.addEventListener("keydown", () => audio.enable(), { once: true });
  const simTime = () => game.simTime;

  // --- 固定ステップ系 (順序が重要) ---
  scheduler
    .addFixed(new InputSystem(input))
    .addFixed(new AISystem())
    .addFixed(new WeaponSystem(render.scene, events))
    .addFixed(new FlightModelSystem())
    .addFixed(new ProjectileSystem())
    .addFixed(new MissileSystem())
    .addFixed(new CollisionSystem(events, simTime))
    .addFixed(new DamageSystem(events, simTime))
    .addFixed(new TargetingSystem())
    .addFixed(new GameRuleSystem(state, getPlayer, events, onGameEnd));

  // --- 可変ステップ系 (描画同期・カメラ・HUD) ---
  const hudView = new HudView(container);
  scheduler
    .addVariable(new SyncTransformSystem())
    .addVariable(new CameraRig(render.camera, getPlayer))
    .addVariable(new ExplosionSystem(render.scene, events))
    .addVariable(new HudSystem(hudView, render.camera, getPlayer, state));

  // 終了時: R キーでリスタート (ページ再読み込みで確実に初期化)。
  function onGameEnd(_phase: "Victory" | "GameOver"): void {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyR") {
        window.removeEventListener("keydown", onKey);
        window.location.reload();
      }
    };
    window.addEventListener("keydown", onKey);
  }
}

/** 敵編隊をプレイヤー前方に配置する。 */
function spawnWave(game: Game): void {
  const { world, render } = game;
  const formation: Array<{ def: keyof typeof SHIP_DEFS; pos: [number, number, number] }> = [
    { def: "dralthi", pos: [-120, 30, 700] },
    { def: "dralthi", pos: [120, -20, 780] },
    { def: "dralthi", pos: [0, 60, 900] },
    { def: "gratha", pos: [-200, -40, 1000] },
    { def: "gratha", pos: [220, 20, 1050] },
  ];

  // プレイヤー方向 (-z) を向かせる。
  const facePlayer = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

  for (const f of formation) {
    const def = SHIP_DEFS[f.def];
    const entity = spawnShip(world, render.scene, def, {
      position: new Vector3(...f.pos),
      quaternion: facePlayer,
      faction: Faction.Enemy,
    });
    const ai: AIController = {
      state: "Idle",
      target: null,
      stateTimer: 0,
      aggression: 0.4 + Math.random() * 0.5,
      evadeDir: null,
      detectRange: 3000,
      attackRange: def.weapon.gunRange,
    };
    world.add(entity, Comp.AIController, ai);
  }
}
