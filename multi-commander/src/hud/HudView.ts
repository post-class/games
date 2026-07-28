import "./hud.css";
import type { GamePhase, MissionResult } from "../game/GameState";
import type { EventBus } from "../util/EventBus";
import type { EntityId } from "../ecs/Entity";

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
  flares: number;
  secondaryName: string;
  secondaryAmmo: number;
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

interface KillFeedEntry {
  text: string;
  timestamp: number;
}

/** DOM/CSS ベースの HUD。3D空間の座標計算は呼び出し側 (HudSystem) が行う。 */
export class HudView {
  private readonly root: HTMLDivElement;
  private readonly speedEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly weaponEl: HTMLDivElement;
  private readonly secondaryEl: HTMLDivElement;
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
  private readonly hitMarker: HTMLDivElement;
  private readonly killfeedEl: HTMLDivElement;
  private readonly damageVignette: HTMLDivElement;
  private readonly missileWarnEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly tutorialEl: HTMLDivElement;
  private readonly statusInfoEl: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private killFeed: KillFeedEntry[] = [];

  constructor(container: HTMLElement) {
    this.root = el("div", "hud");

    this.speedEl = el("div", "hud-corner hud-bottom-left");
    this.statusEl = el("div", "hud-corner hud-top-left");
    this.weaponEl = el("div", "hud-corner hud-bottom-right");
    this.secondaryEl = el("div", "hud-secondary");
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

    this.hitMarker = el("div", "hud-hitmarker");
    this.killfeedEl = el("div", "hud-killfeed");
    this.damageVignette = el("div", "hud-damage-vignette");
    this.missileWarnEl = el("div", "hud-missile-warning");
    this.missileWarnEl.textContent = "⚠ MISSILE";
    this.toastEl = el("div", "hud-toast");
    this.tutorialEl = el("div", "hud-tutorial");
    this.statusInfoEl = el("div", "hud-corner hud-statusinfo");

    this.reticle.style.left = "50%";
    this.reticle.style.top = "50%";

    this.root.append(
      this.speedEl,
      this.statusEl,
      this.weaponEl,
      this.secondaryEl,
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
      this.hitMarker,
      this.killfeedEl,
      this.damageVignette,
      this.missileWarnEl,
      this.toastEl,
      this.tutorialEl,
      this.statusInfoEl,
    );
    container.appendChild(this.root);
  }

  /** 短時間表示のトースト通知 (例: マウス操縦ON/OFF)。 */
  showToast(text: string, durationMs = 1500): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.remove("show");
      this.toastTimer = null;
    }, durationMs);
  }

  /** 訓練中の現在指示テキスト。null なら非表示 (訓練モード以外)。 */
  setTutorialInstruction(text: string | null): void {
    if (text === null) {
      this.tutorialEl.classList.remove("show");
      return;
    }
    this.tutorialEl.textContent = text;
    this.tutorialEl.classList.add("show");
  }

  /** 画面右下の状態表示 (マウス操縦/操作モード/照準アシスト)。 */
  setStatusInfo(info: { mouseFlight: boolean; flightMode: string; aimAssist: string }): void {
    this.statusInfoEl.innerHTML =
      `MOUSE ${info.mouseFlight ? "ON" : "OFF"}<br>` +
      `MODE ${info.flightMode}<br>` +
      `AIM ${info.aimAssist}`;
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
        bar("ENGY", "bar-energy", d.energyPct) +
        `MSL <b>${d.missiles}</b>  FLR <b>${d.flares}</b>`;

      if (d.secondaryName) {
        this.secondaryEl.style.display = "block";
        this.secondaryEl.textContent = `▸ ${d.secondaryName} [${d.secondaryAmmo}]`;
      } else {
        this.secondaryEl.style.display = "none";
        this.secondaryEl.textContent = "";
      }

      this.objectiveEl.innerHTML = this.renderObjectives(d);
      this.updateTarget(d);
      this.updateNav(d.nav);
      this.drawRadar(d.radar);
      this.renderMessages(d.messages);
      this.updateKillFeed();
    } else {
      this.messagesEl.textContent = "";
      this.killFeed = [];
      this.killfeedEl.innerHTML = "";
    }

    this.updateCenterMsg(d);
  }

  /** 被ロック(誘導ミサイル飛来)警告の表示切替。プレイ中のみ表示。 */
  setMissileWarning(on: boolean): void {
    this.missileWarnEl.classList.toggle("active", on);
  }

  private setFlightHudVisible(v: boolean): void {
    const disp = v ? "" : "none";
    for (const e of [
      this.speedEl,
      this.statusEl,
      this.weaponEl,
      this.secondaryEl,
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
      this.tutorialEl.classList.remove("show");
      this.statusInfoEl.innerHTML = "";
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

  /**
   * HUD演出フィードバックの購読。bootstrap から呼ぶ想定。
   * @param events - EventBus インスタンス
   * @param isPlayer - エンティティがプレイヤーか判定する関数
   * @param resolveName - エンティティ名を解決する関数(optional)
   */
  subscribeFeedback(
    events: EventBus,
    isPlayer: (id: EntityId) => boolean,
    resolveName?: (id: EntityId) => string,
  ): void {
    events.on("hit", (e) => {
      // プレイヤーが命中させた→ヒットマーカー表示
      if (isPlayer(e.source)) {
        this.flashHitMarker();
      }
      // プレイヤーが被弾→ダメージビネット(赤)
      if (isPlayer(e.target)) {
        this.flashDamageVignette(0.4, "damage");
      }
    });

    events.on("destroyed", (e) => {
      // プレイヤーが撃墜した→キルフィード追加
      if (e.source && isPlayer(e.source)) {
        const text = this.buildKillFeedText(e.entity, e.faction, resolveName);
        this.addKillFeed(text);
      }
    });

    events.on("shieldHit", (e) => {
      // プレイヤーのシールド被弾→ビネット(青系で差別化)
      if (isPlayer(e.entity)) {
        this.flashDamageVignette(0.3, "shield");
      }
    });
  }

  private buildKillFeedText(
    entity: EntityId,
    faction: number,
    resolveName?: (id: EntityId) => string,
  ): string {
    if (resolveName) {
      const name = resolveName(entity);
      return `撃墜: ${name}`;
    }
    // Faction: Player=0, Ally=1, Enemy=2, Neutral=3
    switch (faction) {
      case 2:
        return "敵機撃墜";
      case 1:
        return "友軍機撃墜"; // 本来起きないが念のため
      case 3:
        return "中立機撃墜";
      default:
        return "撃墜";
    }
  }

  private flashHitMarker(): void {
    this.hitMarker.classList.remove("flash");
    void this.hitMarker.offsetWidth; // reflow
    this.hitMarker.classList.add("flash");
  }

  private flashDamageVignette(intensity: number, kind: "damage" | "shield"): void {
    this.damageVignette.classList.remove("flash", "flash-damage", "flash-shield");
    this.damageVignette.style.setProperty("--intensity", String(intensity));
    void this.damageVignette.offsetWidth;
    this.damageVignette.classList.add("flash", kind === "shield" ? "flash-shield" : "flash-damage");
  }

  private addKillFeed(text: string): void {
    const now = performance.now();
    this.killFeed.push({ text, timestamp: now });
    // 最大5件に制限
    if (this.killFeed.length > 5) {
      this.killFeed.shift();
    }
  }

  private updateKillFeed(): void {
    const now = performance.now();
    const MAX_AGE = 5000; // 5秒でフェードアウト
    // 寿命切れを除去
    this.killFeed = this.killFeed.filter((e) => now - e.timestamp < MAX_AGE);
    // 再描画
    this.killfeedEl.innerHTML = this.killFeed
      .map((e) => {
        const age = now - e.timestamp;
        const opacity = Math.max(0, 1 - age / MAX_AGE);
        const cls = e.text.startsWith("撃墜: ★") ? "hud-killfeed-entry ace" : "hud-killfeed-entry";
        return `<div class="${cls}" style="opacity:${opacity.toFixed(2)}">${e.text}</div>`;
      })
      .join("");
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
