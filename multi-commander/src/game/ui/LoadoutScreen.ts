import { WEAPON_DEFS } from "../weapons/WeaponDefs";
import { SHIP_DEFS } from "../ships/shipDefinitions";

export interface LoadoutChoice {
  shipId: string;
  gunId: string;
  secondaries: string[];
}

const AVAILABLE_SHIPS: string[] = ["rapier", "scimitar"];
const AVAILABLE_GUNS: string[] = ["laser", "mass-driver", "neutron-gun", "particle-cannon"];
const AVAILABLE_MISSILES: string[] = ["heat-seeker", "dumbfire", "image-rec", "friend-or-foe"];

interface LoadoutState {
  shipIndex: number;
  gunIndex: number;
  missileIndex: number;
  row: 0 | 1 | 2 | 3;
}

export function buildLoadoutHtml(state: LoadoutState): string {
  const shipRows = AVAILABLE_SHIPS.map((id, i) => {
    const d = SHIP_DEFS[id];
    const sel = i === state.shipIndex ? " sel" : "";
    const active = state.row === 0 ? " active-row" : "";
    const hp = d.health.shieldMax + d.health.armorMax + d.health.hullMax;
    return `<div class="loadout-item${sel}${active}" data-idx="${i}">${d.displayName}<span class="stat">SPD ${d.flight.maxLinearSpeed} | HP ${hp} | DMG ${d.weapon.gunDamage}</span></div>`;
  }).join("");

  const gunRows = AVAILABLE_GUNS.map((id, i) => {
    const d = WEAPON_DEFS[id];
    const sel = i === state.gunIndex ? " sel" : "";
    const active = state.row === 1 ? " active-row" : "";
    return `<div class="loadout-item${sel}${active}" data-idx="${i}">${d.displayName}<span class="stat">DMG ${d.damage} | RNG ${d.range} | SPD ${d.projectileSpeed}</span></div>`;
  }).join("");

  const missileRows = AVAILABLE_MISSILES.map((id, i) => {
    const d = WEAPON_DEFS[id];
    const sel = i === state.missileIndex ? " sel" : "";
    const active = state.row === 2 ? " active-row" : "";
    const seeker = d.seeker === "none" ? "無誘導" : d.seeker === "heat" ? "赤外線" : "画像認識";
    return `<div class="loadout-item${sel}${active}" data-idx="${i}">${d.displayName}<span class="stat">${seeker} | DMG ${d.damage} | ×${d.ammoMax ?? 0}</span></div>`;
  }).join("");

  const launchSel = state.row === 3 ? " sel" : "";

  return `
    <div class="screen-title">LOADOUT</div>
    <div class="loadout-section">
      <div class="loadout-label">SHIP</div>
      ${shipRows}
    </div>
    <div class="loadout-section">
      <div class="loadout-label">PRIMARY GUN</div>
      ${gunRows}
    </div>
    <div class="loadout-section">
      <div class="loadout-label">SECONDARY</div>
      ${missileRows}
    </div>
    <div class="loadout-launch${launchSel}">▶ 出撃</div>
    <div class="screen-prompt">▲▼ 選択 / ◀▶ 項目切替 / ENTER 確定</div>`;
}

export function createLoadoutController(
  root: HTMLElement,
  initial: LoadoutChoice,
  onConfirm: (choice: LoadoutChoice) => void,
): () => void {
  const state: LoadoutState = {
    shipIndex: Math.max(0, AVAILABLE_SHIPS.indexOf(initial.shipId)),
    gunIndex: Math.max(0, AVAILABLE_GUNS.indexOf(initial.gunId)),
    missileIndex: Math.max(0, AVAILABLE_MISSILES.indexOf(initial.secondaries[0] ?? "heat-seeker")),
    row: 0,
  };

  const render = (): void => {
    root.innerHTML = buildLoadoutHtml(state);
  };
  render();

  const rowCounts = [AVAILABLE_SHIPS.length, AVAILABLE_GUNS.length, AVAILABLE_MISSILES.length, 1];

  const handler = (e: KeyboardEvent): void => {
    const code = e.code;
    if (code === "ArrowLeft" || code === "ArrowUp") {
      e.preventDefault();
      if (state.row === 0) state.shipIndex = (state.shipIndex - 1 + rowCounts[0]) % rowCounts[0];
      else if (state.row === 1) state.gunIndex = (state.gunIndex - 1 + rowCounts[1]) % rowCounts[1];
      else if (state.row === 2) state.missileIndex = (state.missileIndex - 1 + rowCounts[2]) % rowCounts[2];
      else state.row = 2;
      render();
    } else if (code === "ArrowRight" || code === "ArrowDown") {
      e.preventDefault();
      if (state.row === 0) state.shipIndex = (state.shipIndex + 1) % rowCounts[0];
      else if (state.row === 1) state.gunIndex = (state.gunIndex + 1) % rowCounts[1];
      else if (state.row === 2) state.missileIndex = (state.missileIndex + 1) % rowCounts[2];
      render();
    } else if (code === "Tab" || code === "KeyW" || code === "KeyS") {
      e.preventDefault();
      if (code === "Tab" || code === "KeyS") {
        state.row = Math.min(3, state.row + 1) as 0 | 1 | 2 | 3;
      } else {
        state.row = Math.max(0, state.row - 1) as 0 | 1 | 2 | 3;
      }
      render();
    } else if (code === "Enter" || code === "Space") {
      e.preventDefault();
      if (state.row === 3) {
        cleanup();
        onConfirm({
          shipId: AVAILABLE_SHIPS[state.shipIndex],
          gunId: AVAILABLE_GUNS[state.gunIndex],
          secondaries: [AVAILABLE_MISSILES[state.missileIndex]],
        });
      } else {
        state.row = Math.min(3, state.row + 1) as 0 | 1 | 2 | 3;
        render();
      }
    }
  };

  window.addEventListener("keydown", handler);
  const cleanup = (): void => {
    window.removeEventListener("keydown", handler);
  };
  return cleanup;
}
