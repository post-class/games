import "./hud.css";

export interface RadarContact {
  /** プレイヤーローカル座標での方向 (正規化不要、描画側で距離圧縮)。 */
  x: number;
  y: number;
  z: number;
  hostile: boolean;
  isTarget: boolean;
}

export interface HudTargetData {
  name: string;
  distance: number;
  shieldPct: number;
  hullPct: number;
  lockProgress: number;
  /** ターゲット枠のスクリーン座標。 */
  box: { x: number; y: number; onScreen: boolean };
  /** リード(命中予測)のスクリーン座標。 */
  lead: { x: number; y: number; onScreen: boolean };
  /** 画面外方向矢印。 */
  arrow: { x: number; y: number; angleRad: number; onScreen: boolean };
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
  target: HudTargetData | null;
  radar: RadarContact[];
  phase: "Playing" | "Victory" | "GameOver";
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
  private readonly targetInfo: HTMLDivElement;
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
    this.targetInfo = el("div", "hud-targetinfo");

    this.radarCanvas = document.createElement("canvas");
    this.radarCanvas.className = "hud-radar";
    this.radarCanvas.width = RADAR_SIZE;
    this.radarCanvas.height = RADAR_SIZE;
    this.radarCtx = this.radarCanvas.getContext("2d")!;

    this.centerMsg = el("div", "hud-center-msg");
    this.centerMsg.innerHTML = "<h1></h1><p></p>";

    // 画面中央のクロスヘアを固定表示。
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
      this.targetInfo,
      this.radarCanvas,
      this.centerMsg,
    );
    container.appendChild(this.root);
  }

  update(d: HudData): void {
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
      bar("ENGY", "bar-energy", d.energyPct) +
      `MSL <b>${d.missiles}</b>`;

    this.objectiveEl.innerHTML =
      `KILLS <b>${d.kills}</b><br>ENEMIES <b>${d.enemiesLeft}</b>`;

    this.updateTarget(d);
    this.drawRadar(d.radar);
    this.updateCenterMsg(d);
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

    // ターゲット情報テキスト。
    this.targetInfo.innerHTML =
      `${t.name}  ${t.distance.toFixed(0)}m<br>` +
      `SHLD ${(t.shieldPct * 100).toFixed(0)}%  HULL ${(t.hullPct * 100).toFixed(0)}%` +
      (t.lockProgress >= 1 ? '  <span class="hud-warn">LOCK</span>' : t.lockProgress > 0 ? `  LOCK ${(t.lockProgress * 100).toFixed(0)}%` : "");

    // ターゲット枠。
    if (t.box.onScreen) {
      this.targetBox.style.display = "block";
      this.targetBox.style.left = `${t.box.x}px`;
      this.targetBox.style.top = `${t.box.y}px`;
      this.lockRing.style.opacity = String(t.lockProgress);
    } else {
      this.targetBox.style.display = "none";
    }

    // リードインジケータ。
    if (t.lead.onScreen) {
      this.lead.style.display = "block";
      this.lead.style.left = `${t.lead.x}px`;
      this.lead.style.top = `${t.lead.y}px`;
    } else {
      this.lead.style.display = "none";
    }

    // 画面外矢印。
    if (!t.arrow.onScreen) {
      this.arrow.style.display = "block";
      this.arrow.style.left = `${t.arrow.x}px`;
      this.arrow.style.top = `${t.arrow.y}px`;
      // 矢印は上向き(border-bottom)なので +90度補正。
      this.arrow.style.transform = `rotate(${t.arrow.angleRad + Math.PI / 2}rad)`;
    } else {
      this.arrow.style.display = "none";
    }
  }

  private drawRadar(contacts: RadarContact[]): void {
    const ctx = this.radarCtx;
    const s = RADAR_SIZE;
    const c = s / 2;
    ctx.clearRect(0, 0, s, s);
    // 背景円。
    ctx.strokeStyle = "rgba(127,255,212,0.4)";
    ctx.fillStyle = "rgba(0,40,40,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 十字線と前方インジケータ。
    ctx.beginPath();
    ctx.moveTo(c, 4); ctx.lineTo(c, s - 4);
    ctx.moveTo(4, c); ctx.lineTo(s - 4, c);
    ctx.stroke();
    // 自機 (中央、上が前方)。
    ctx.fillStyle = "#7fffd4";
    ctx.beginPath();
    ctx.moveTo(c, c - 5); ctx.lineTo(c - 4, c + 4); ctx.lineTo(c + 4, c + 4);
    ctx.closePath();
    ctx.fill();

    // コンタクト。ローカル座標を上面図(z=前=上, x=右)に投影し、距離を対数圧縮。
    const maxR = c - 8;
    for (const k of contacts) {
      const dist = Math.hypot(k.x, k.y, k.z);
      const norm = Math.min(1, Math.log10(1 + dist / 50) / Math.log10(1 + 3000 / 50));
      const horiz = Math.hypot(k.x, k.z);
      if (horiz < 1e-3) continue;
      const px = c + (k.x / horiz) * norm * maxR;
      const py = c - (k.z / horiz) * norm * maxR;
      ctx.fillStyle = k.isTarget ? "#ffe14d" : k.hostile ? "#ff5b5b" : "#3fd0ff";
      const size = k.isTarget ? 4 : 3;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      // 上下(y)の高低を色濃度で示すのは省略。
    }
  }

  private updateCenterMsg(d: HudData): void {
    if (d.phase === "Playing") {
      this.centerMsg.style.display = "none";
      return;
    }
    this.centerMsg.style.display = "flex";
    this.centerMsg.className =
      "hud-center-msg " + (d.phase === "Victory" ? "victory" : "gameover");
    const h1 = this.centerMsg.querySelector("h1")!;
    const p = this.centerMsg.querySelector("p")!;
    h1.textContent = d.phase === "Victory" ? "MISSION COMPLETE" : "SHIP DESTROYED";
    p.textContent = `撃墜数: ${d.kills}   —   R キーでリスタート`;
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
