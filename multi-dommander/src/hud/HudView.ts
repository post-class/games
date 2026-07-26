import "./hud.css";
import type { GamePhase, MissionResult } from "../game/GameState";

export interface RadarContact {
  x: number;
  y: number;
  z: number;
  hostile: boolean;
  friendly: boolean;
  isTarget: boolean;
}

export interface HudTargetData {
  name: string;
  distance: number;
  shieldPct: number;
  hullPct: number;
  lockProgress: number;
  box: { x: number; y: number; onScreen: boolean };
  lead: { x: number; y: number; onScreen: boolean };
  arrow: { x: number; y: number; angleRad: number; onScreen: boolean };
}

export interface HudObjective {
  label: string;
  status: "active" | "complete" | "failed";
  optional: boolean;
}

export interface HudNav {
  x: number;
  y: number;
  angleRad: number;
  onScreen: boolean;
  distance: number;
  label: string;
}

export interface HudData {
  speed: number;
  maxSpeed: number;
  throttlePct: number;
  flightAssist: boolean;
  afterburner: boolean;
  shieldPct: number;
  armorPct: number;
  hullPct: number;
  energyPct: number;
  missiles: number;
  kills: number;
  enemiesLeft: number;
  missionName: string;
  target: HudTargetData | null;
  radar: RadarContact[];
  objectives: HudObjective[];
  messages: string[];
  nav: HudNav | null;
  phase: GamePhase;
  result: MissionResult;
  resultText: string;
}

const RADAR_SIZE = 150;

/** DOM/CSS ベースの HUD。3D空間の座標計算は呼び出し側 (HudSystem) が行う。 */
export class HudView {
  private readonly root: HTMLDivElement;
  private readonly speedEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly weaponEl: HTMLDivElement;
  private readonly objectiveEl: HTMLDivElement;
  private readonly reticle: HTMLDivElement;
  private readonly lead: HTMLDivElement;
  private readonly targetBox: HTMLDivElement;
  private readonly lockRing: HTMLDivElement;
  private readonly arrow: HTMLDivElement;
  private readonly navArrow: HTMLDivElement;
  private readonly navLabel: HTMLDivElement;
  private readonly targetInfo: HTMLDivElement;
  private readonly messagesEl: HTMLDivElement;
  private readonly radarCanvas: HTMLCanvasElement;
  private readonly radarCtx: CanvasRenderingContext2D;
  private readonly centerMsg: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root = el("div", "hud");

    this.speedEl = el("div", "hud-corner hud-bottom-left");
    this.statusEl = el("div", "hud-corner hud-top-left");
    this.weaponEl = el("div", "hud-corner hud-bottom-right");
    this.objectiveEl = el("div", "hud-corner hud-top-right");

    this.reticle = el("div", "hud-reticle");
    this.lead = el("div", "hud-lead");
    this.targetBox = el("div", "hud-targetbox");
    this.lockRing = el("div", "lock");
    this.targetBox.appendChild(this.lockRing);
    this.arrow = el("div", "hud-arrow");
    this.navArrow = el("div", "hud-arrow hud-navarrow");
    this.navLabel = el("div", "hud-navlabel");
    this.targetInfo = el("div", "hud-targetinfo");
    this.messagesEl = el("div", "hud-messages");

    this.radarCanvas = document.createElement("canvas");
    this.radarCanvas.className = "hud-radar";
    this.radarCanvas.width = RADAR_SIZE;
    this.radarCanvas.height = RADAR_SIZE;
    this.radarCtx = this.radarCanvas.getContext("2d")!;

    this.centerMsg = el("div", "hud-center-msg");
    this.centerMsg.innerHTML = "<h1></h1><p></p>";

    this.reticle.style.left = "50%";
    this.reticle.style.top = "50%";

    this.root.append(
      this.speedEl,
      this.statusEl,
      this.weaponEl,
      this.objectiveEl,
      this.reticle,
      this.lead,
      this.targetBox,
      this.arrow,
      this.navArrow,
      this.navLabel,
      this.targetInfo,
      this.messagesEl,
      this.radarCanvas,
      this.centerMsg,
    );
    container.appendChild(this.root);
  }

  update(d: HudData): void {
    const playing = d.phase === "Playing";
    // プレイ中以外は飛行系HUDを隠す。
    this.setFlightHudVisible(playing);

    if (playing) {
      const abTag = d.afterburner ? ' <span class="hud-warn">A/B</span>' : "";
      const faTag = d.flightAssist ? "MODE:WC" : '<span class="hud-warn">MODE:NEWTON</span>';
      this.speedEl.innerHTML =
        `SPD <b>${d.speed.toFixed(0)}</b> / ${d.maxSpeed.toFixed(0)}${abTag}<br>` +
        `THR ${(d.throttlePct * 100).toFixed(0)}%<br>${faTag}`;

      this.statusEl.innerHTML =
        bar("SHLD", "bar-shield", d.shieldPct) +
        bar("ARMR", "bar-armor", d.armorPct) +
        bar("HULL", "bar-hull", d.hullPct);

      this.weaponEl.innerHTML =
        bar("ENGY", "bar-energy", d.energyPct) + `MSL <b>${d.missiles}</b>`;

      this.objectiveEl.innerHTML = this.renderObjectives(d);
      this.updateTarget(d);
      this.updateNav(d.nav);
      this.drawRadar(d.radar);
      this.renderMessages(d.messages);
    } else {
      this.messagesEl.textContent = "";
    }

    this.updateCenterMsg(d);
  }

  private setFlightHudVisible(v: boolean): void {
    const disp = v ? "" : "none";
    for (const e of [
      this.speedEl,
      this.statusEl,
      this.weaponEl,
      this.objectiveEl,
      this.reticle,
      this.radarCanvas,
    ]) {
      e.style.display = disp;
    }
    if (!v) {
      this.targetBox.style.display = "none";
      this.lead.style.display = "none";
      this.arrow.style.display = "none";
      this.navArrow.style.display = "none";
      this.navLabel.style.display = "none";
      this.targetInfo.textContent = "";
    }
  }

  private renderObjectives(d: HudData): string {
    const head = `<div class="hud-mission">${d.missionName}</div>KILLS <b>${d.kills}</b>  ENEMIES <b>${d.enemiesLeft}</b>`;
    const items = d.objectives
      .map((o) => {
        const mark = o.status === "complete" ? "✓" : o.status === "failed" ? "✗" : "•";
        const cls =
          o.status === "complete" ? "obj-done" : o.status === "failed" ? "obj-fail" : "obj-active";
        const opt = o.optional ? " (任意)" : "";
        return `<div class="hud-obj ${cls}">${mark} ${o.label}${opt}</div>`;
      })
      .join("");
    return `${head}<div class="hud-objlist">${items}</div>`;
  }

  private renderMessages(messages: string[]): void {
    this.messagesEl.innerHTML = messages.map((m) => `<div>${m}</div>`).join("");
  }

  private updateTarget(d: HudData): void {
    const t = d.target;
    if (!t) {
      this.targetBox.style.display = "none";
      this.lead.style.display = "none";
      this.arrow.style.display = "none";
      this.targetInfo.textContent = "";
      return;
    }
    this.targetInfo.innerHTML =
      `${t.name}  ${t.distance.toFixed(0)}m<br>` +
      `SHLD ${(t.shieldPct * 100).toFixed(0)}%  HULL ${(t.hullPct * 100).toFixed(0)}%` +
      (t.lockProgress >= 1
        ? '  <span class="hud-warn">LOCK</span>'
        : t.lockProgress > 0
          ? `  LOCK ${(t.lockProgress * 100).toFixed(0)}%`
          : "");

    if (t.box.onScreen) {
      this.targetBox.style.display = "block";
      this.targetBox.style.left = `${t.box.x}px`;
      this.targetBox.style.top = `${t.box.y}px`;
      this.lockRing.style.opacity = String(t.lockProgress);
    } else {
      this.targetBox.style.display = "none";
    }

    if (t.lead.onScreen) {
      this.lead.style.display = "block";
      this.lead.style.left = `${t.lead.x}px`;
      this.lead.style.top = `${t.lead.y}px`;
    } else {
      this.lead.style.display = "none";
    }

    if (!t.arrow.onScreen) {
      this.arrow.style.display = "block";
      this.arrow.style.left = `${t.arrow.x}px`;
      this.arrow.style.top = `${t.arrow.y}px`;
      this.arrow.style.transform = `rotate(${t.arrow.angleRad + Math.PI / 2}rad)`;
    } else {
      this.arrow.style.display = "none";
    }
  }

  private updateNav(nav: HudNav | null): void {
    if (!nav) {
      this.navArrow.style.display = "none";
      this.navLabel.style.display = "none";
      return;
    }
    this.navLabel.style.display = "block";
    this.navLabel.textContent = `${nav.label}  ${nav.distance.toFixed(0)}m`;
    if (!nav.onScreen) {
      this.navArrow.style.display = "block";
      this.navArrow.style.left = `${nav.x}px`;
      this.navArrow.style.top = `${nav.y}px`;
      this.navArrow.style.transform = `rotate(${nav.angleRad + Math.PI / 2}rad)`;
    } else {
      this.navArrow.style.display = "none";
    }
  }

  private drawRadar(contacts: RadarContact[]): void {
    const ctx = this.radarCtx;
    const s = RADAR_SIZE;
    const c = s / 2;
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = "rgba(127,255,212,0.4)";
    ctx.fillStyle = "rgba(0,40,40,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c, 4);
    ctx.lineTo(c, s - 4);
    ctx.moveTo(4, c);
    ctx.lineTo(s - 4, c);
    ctx.stroke();
    ctx.fillStyle = "#7fffd4";
    ctx.beginPath();
    ctx.moveTo(c, c - 5);
    ctx.lineTo(c - 4, c + 4);
    ctx.lineTo(c + 4, c + 4);
    ctx.closePath();
    ctx.fill();

    const maxR = c - 8;
    for (const k of contacts) {
      const dist = Math.hypot(k.x, k.y, k.z);
      const norm = Math.min(1, Math.log10(1 + dist / 50) / Math.log10(1 + 3000 / 50));
      const horiz = Math.hypot(k.x, k.z);
      if (horiz < 1e-3) continue;
      const px = c + (k.x / horiz) * norm * maxR;
      const py = c - (k.z / horiz) * norm * maxR;
      ctx.fillStyle = k.isTarget
        ? "#ffe14d"
        : k.hostile
          ? "#ff5b5b"
          : k.friendly
            ? "#5bff8f"
            : "#3fd0ff";
      const size = k.isTarget ? 4 : 3;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    }
  }

  private updateCenterMsg(_d: HudData): void {
    // デブリーフ表示は MissionScreens が担うため、HUD 中央メッセージは常に非表示。
    this.centerMsg.style.display = "none";
  }

  dispose(): void {
    this.root.remove();
  }
}

function el(tag: string, className: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = className;
  return e;
}

function bar(label: string, cls: string, pct: number): string {
  const p = Math.max(0, Math.min(1, pct)) * 100;
  return `${label} <span class="hud-bar ${cls}"><i style="width:${p}%"></i></span><br>`;
}
