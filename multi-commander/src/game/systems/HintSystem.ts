import { Vector3 } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp } from "../components";
import type { Transform, WeaponMount, Targeting, ThrusterInput, Missile } from "../components";
import type { MissionManager } from "../mission/MissionManager";
import type { HudView } from "../../hud/HudView";
import type { SettingsHolder } from "../GameController";
import { BINDINGS, type Action } from "../../config/inputBindings";

/** 照準できているとみなす最低 dot 値 (前方ベクトルと目標方向の内積)。 */
const AIM_DOT_THRESHOLD = 0.85;
/** 停止中とみなすスロットル閾値。 */
const STOPPED_THROTTLE = 0.05;

const forward = new Vector3();
const toTarget = new Vector3();

/** アクションに対応する表示ラベル (マウス併用があれば併記) を BINDINGS から解決する。 */
function bindingLabel(action: Action): string {
  const entry = BINDINGS.find((b) => b.action === action);
  if (!entry) return "";
  return entry.mouseLabel ? `${entry.mouseLabel} / ${entry.keyLabel}` : entry.keyLabel;
}

interface Hint {
  id: string;
  text: string;
}

/**
 * プレイヤーの状況に応じて最重要ヒント1件を HUD トースト表示する。
 * Easy + contextualHints=true のときのみ有効。1フレームに1回チェックするだけの軽量な System。
 */
export class HintSystem implements System {
  readonly name = "HintSystem";
  private readonly lastHintTime = new Map<string, number>();
  private readonly cooldown = 5;

  constructor(
    private readonly mission: MissionManager,
    private readonly hud: HudView,
    private readonly settings: SettingsHolder,
    private readonly getSimTime: () => number,
    /** 訓練中は専用の指示テキストを表示するため、通常ヒントは抑止する。 */
    private readonly isTutorialActive: () => boolean = () => false,
  ) {}

  update(world: World): void {
    if (this.isTutorialActive()) return;
    if (this.settings.difficulty !== "easy" || !this.settings.contextualHints) return;
    const player = this.mission.getPlayer();
    if (player === null) return;

    const hint = this.decideHint(world, player);
    if (!hint) return;

    const now = this.getSimTime();
    const last = this.lastHintTime.get(hint.id) ?? -Infinity;
    if (now - last < this.cooldown) return;
    this.lastHintTime.set(hint.id, now);
    this.hud.showToast(hint.text);
  }

  private decideHint(world: World, player: EntityId): Hint | null {
    if (this.missileIncoming(world, player)) {
      return { id: "flare", text: `フレア投下: ${bindingLabel("dropFlare")}` };
    }
    if (this.mission.escortInDanger(this.getSimTime())) {
      return { id: "escort", text: "護衛対象が攻撃されている" };
    }

    const thruster = world.get<ThrusterInput>(player, Comp.ThrusterInput);
    if (thruster && thruster.linear.z < STOPPED_THROTTLE) {
      return { id: "throttle", text: `加速: ${bindingLabel("throttleUp")}` };
    }

    const targeting = world.get<Targeting>(player, Comp.Targeting);
    if (!targeting || targeting.target === null || !world.isAlive(targeting.target)) {
      return {
        id: "target",
        text: `ターゲット選択: ${bindingLabel("cycleTargetNext")} / ${bindingLabel("cycleTargetNearest")}`,
      };
    }

    if (!this.canAim(world, player, targeting.target)) {
      return { id: "aim", text: "ターゲット方向へ旋回" };
    }

    const wm = world.get<WeaponMount>(player, Comp.WeaponMount);
    if (wm && wm.missiles > 0 && targeting.lockProgress < 1) {
      return { id: "lock", text: "ロック中... 維持" };
    }

    return null;
  }

  private missileIncoming(world: World, player: EntityId): boolean {
    for (const m of world.query(Comp.Missile)) {
      if (world.get<Missile>(m, Comp.Missile)?.target === player) return true;
    }
    return false;
  }

  private canAim(world: World, player: EntityId, target: EntityId): boolean {
    const pt = world.get<Transform>(player, Comp.Transform);
    const tt = world.get<Transform>(target, Comp.Transform);
    const wm = world.get<WeaponMount>(player, Comp.WeaponMount);
    if (!pt || !tt || !wm) return true;

    toTarget.copy(tt.position).sub(pt.position);
    const dist = toTarget.length();
    if (dist > wm.gunRange) return false;
    toTarget.normalize();
    forward.set(0, 0, 1).applyQuaternion(pt.quaternion);
    return forward.dot(toTarget) >= AIM_DOT_THRESHOLD;
  }
}
