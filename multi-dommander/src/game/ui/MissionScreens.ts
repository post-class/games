import "./screens.css";
import type { MissionDefinition } from "../mission/MissionDefinition";
import type { ObjectiveState } from "../mission/MissionManager";

type Handlers = Record<string, () => void>;

/**
 * タイトル / ブリーフィング / デブリーフの全画面オーバーレイ (DOM)。
 * キーボードのみで進行。各画面ごとに「キーコード -> ハンドラ」を登録する。
 */
export class MissionScreens {
  private readonly root: HTMLDivElement;
  private handlers: Handlers = {};

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "screen";
    container.appendChild(this.root);
    window.addEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    const h = this.handlers[e.code];
    if (!h) return;
    e.preventDefault();
    this.handlers = {}; // 二重発火防止。
    h();
  };

  showTitle(hasSave: boolean, onContinue: () => void, onNew: () => void): void {
    const prompt = hasSave
      ? '<div class="screen-prompt">▶ ENTER / 1: 続きから　　2: 最初から</div>'
      : '<div class="screen-prompt">▶ ENTER で作戦開始</div>';
    this.root.innerHTML = `
      <div class="screen-title">MULTI-DOMMANDER</div>
      <div class="screen-body">
        Terran Confederation 所属パイロットとして Kilrathi との戦いに挑め。<br>
        3つのミッションから成るキャンペーンだ。
      </div>
      ${prompt}`;
    if (hasSave) {
      this.show({ Enter: onContinue, Space: onContinue, Digit1: onContinue, Digit2: onNew });
    } else {
      this.show({ Enter: onNew, Space: onNew });
    }
  }

  showBriefing(def: MissionDefinition, index: number, total: number, onLaunch: () => void): void {
    const brief = def.briefing.join("<br>");
    const objs = def.objectives
      .map((o) => `<div class="obj">・${o.label}${o.optional ? " (任意)" : ""}</div>`)
      .join("");
    this.root.innerHTML = `
      <div class="screen-title">ミッション ${index + 1}/${total}</div>
      <div class="screen-title" style="font-size:22px;color:#cfe">${def.name}</div>
      <div class="screen-body">
        ${brief}
        <div class="screen-list">${objs}</div>
      </div>
      <div class="screen-prompt">▶ ENTER で出撃</div>`;
    this.show({ Enter: onLaunch, Space: onLaunch });
  }

  showDebrief(
    result: "success" | "failure",
    resultText: string,
    kills: number,
    objectives: ObjectiveState[],
    onProceed: () => void,
    proceedLabel: string,
  ): void {
    const heroCls = result === "success" ? "ok" : "ng";
    const hero = result === "success" ? "MISSION COMPLETE" : "MISSION FAILED";
    const objs = objectives
      .map((o) => {
        const cls = o.status === "complete" ? "done" : o.status === "failed" ? "fail" : "";
        const mark = o.status === "complete" ? "✓" : o.status === "failed" ? "✗" : "•";
        return `<div class="${cls}">${mark} ${o.label}</div>`;
      })
      .join("");
    this.root.innerHTML = `
      <div class="screen-hero ${heroCls}">${hero}</div>
      <div class="screen-stat">${resultText}</div>
      <div class="screen-stat">撃墜数: <b>${kills}</b></div>
      <div class="screen-list">${objs}</div>
      <div class="screen-prompt">▶ ENTER で${proceedLabel}</div>`;
    this.show({ Enter: onProceed, Space: onProceed });
  }

  showCampaignComplete(totalKills: number, onRestart: () => void): void {
    this.root.innerHTML = `
      <div class="screen-hero ok">CAMPAIGN CLEAR</div>
      <div class="screen-body">全ミッションを完遂した。おめでとう、エース。</div>
      <div class="screen-stat">総撃墜数: <b>${totalKills}</b></div>
      <div class="screen-prompt">▶ ENTER で最初から</div>`;
    this.show({ Enter: onRestart, Space: onRestart });
  }

  private show(handlers: Handlers): void {
    this.handlers = handlers;
    this.root.classList.add("show");
  }

  hide(): void {
    this.handlers = {};
    this.root.classList.remove("show");
  }
}
