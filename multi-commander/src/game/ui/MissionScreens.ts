import "./screens.css";
import type { MissionDefinition } from "../mission/MissionDefinition";
import type { ObjectiveState } from "../mission/MissionManager";
import type { GameSettingsV2 } from "../Settings";
import { createLoadoutController, type LoadoutChoice } from "./LoadoutScreen";
import { createSettingsController } from "./SettingsScreen";

type Handlers = Record<string, () => void>;

/** 矢印キーで選択できるメニューの状態。 */
interface MenuState {
  index: number;
  count: number;
  /** 選択移動時に呼ぶ (再描画・副作用)。 */
  onMove: (i: number) => void;
  /** Enter/Space で確定。 */
  onConfirm: (i: number) => void;
  /** Esc/Backspace で戻る (任意)。 */
  onBack?: () => void;
  /** true のとき数字キーで即確定、false のとき数字キーは選択移動のみ。 */
  numberSelects: boolean;
}

/**
 * タイトル / メニュー / 設定 / ブリーフィング / デブリーフの全画面オーバーレイ (DOM)。
 * キーボードのみで進行。
 * - 1回押しで進む画面 (ブリーフィング等): 「キーコード -> ハンドラ」を登録。
 * - 選択式メニュー (メニュー/設定): 矢印キーで選択・Enterで確定する MenuState を使う。
 */
export class MissionScreens {
  private readonly root: HTMLDivElement;
  private handlers: Handlers = {};
  private menu: MenuState | null = null;
  private loadoutCleanup: (() => void) | null = null;
  private settingsCleanup: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "screen";
    container.appendChild(this.root);
    window.addEventListener("keydown", this.onKey);
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("mouseover", this.onMouseOver);
  }

  private onClick = (e: MouseEvent): void => {
    const target = (e.target as HTMLElement).closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    const idxAttr = target.getAttribute("data-index");
    const index = idxAttr !== null ? Number(idxAttr) : null;
    if (action === "select") {
      if (this.menu && index !== null && !Number.isNaN(index)) {
        this.menu.index = index;
        this.menu.onMove(index);
      }
      return;
    }
    if (action === "confirm") {
      if (this.menu) {
        const i = index !== null && !Number.isNaN(index) ? index : this.menu.index;
        this.menu.index = i;
        const confirm = this.menu.onConfirm;
        this.menu = null;
        confirm(i);
      } else {
        const h = this.handlers.Enter;
        if (h) {
          this.handlers = {};
          h();
        }
      }
      return;
    }
    if (action === "key") {
      const key = target.getAttribute("data-key");
      const h = key ? this.handlers[key] : undefined;
      if (h) {
        this.handlers = {};
        h();
      }
    }
  };

  private onMouseOver = (e: MouseEvent): void => {
    const target = (e.target as HTMLElement).closest("[data-action]");
    if (!target || !this.menu) return;
    const idxAttr = target.getAttribute("data-index");
    if (idxAttr === null) return;
    const index = Number(idxAttr);
    if (!Number.isNaN(index) && index !== this.menu.index) {
      this.menu.index = index;
      this.menu.onMove(index);
    }
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.menu) {
      this.onMenuKey(e, this.menu);
      return;
    }
    const h = this.handlers[e.code];
    if (!h) return;
    e.preventDefault();
    this.handlers = {}; // 二重発火防止。
    h();
  };

  private onMenuKey(e: KeyboardEvent, m: MenuState): void {
    const code = e.code;
    if (code === "ArrowUp" || code === "ArrowLeft") {
      e.preventDefault();
      m.index = (m.index - 1 + m.count) % m.count;
      m.onMove(m.index);
    } else if (code === "ArrowDown" || code === "ArrowRight") {
      e.preventDefault();
      m.index = (m.index + 1) % m.count;
      m.onMove(m.index);
    } else if (code === "Enter" || code === "Space") {
      e.preventDefault();
      const i = m.index;
      this.menu = null; // 確定前にクリア (二重発火防止)。
      m.onConfirm(i);
    } else if ((code === "Escape" || code === "Backspace") && m.onBack) {
      e.preventDefault();
      const back = m.onBack;
      this.menu = null;
      back();
    } else if (/^Digit[1-9]$/.test(code)) {
      const n = Number(code.slice(5)) - 1;
      if (n < m.count) {
        e.preventDefault();
        m.index = n;
        if (m.numberSelects) {
          this.menu = null;
          m.onConfirm(n);
        } else {
          m.onMove(n);
        }
      }
    }
  }

  /** トップメニュー: 開始 / 設定。 */
  showMainMenu(difficultyLabel: string, onStart: () => void, onSettings: () => void): void {
    const items = ["▶ 開始", "⚙ 設定"];
    const paint = (idx: number): void => {
      const menu = items
        .map(
          (label, i) =>
            `<div class="item${i === idx ? " sel" : ""}" data-action="confirm" data-index="${i}" role="button" tabindex="0" aria-selected="${i === idx}">${label}</div>`,
        )
        .join("");
      this.root.innerHTML = `
        <div class="screen-title">MULTI-COMMANDER</div>
        <div class="screen-body">
          Terran Confederation 所属パイロットとして Kilrathi との戦いに挑め。
        </div>
        <div class="screen-menu">${menu}</div>
        <div class="screen-sub">難易度: ${difficultyLabel}</div>
        <div class="screen-prompt">▲▼ で選択 / ENTER で決定</div>`;
    };
    paint(0);
    this.showMenu({
      index: 0,
      count: items.length,
      onMove: paint,
      onConfirm: (i) => (i === 0 ? onStart() : onSettings()),
      numberSelects: true,
    });
  }

  /**
   * 設定画面 (ゲーム/操作/オーディオの3タブ)。
   * タブ切替は◀▶/クリック、項目移動は▲▼、トグル/サイクルはENTER・SPACE・クリック、
   * スライダーは◀▶または直接クリックで操作。変更は即時に onChange で通知される。
   */
  showSettings(
    current: GameSettingsV2,
    onChange: (s: GameSettingsV2) => void,
    onReset: () => void,
    onBack: () => void,
  ): void {
    this.cleanupSubControllers();
    this.handlers = {};
    this.menu = null;
    this.root.classList.add("show");
    this.settingsCleanup = createSettingsController(
      this.root,
      current,
      onChange,
      onReset,
      () => {
        this.settingsCleanup = null;
        onBack();
      },
    );
  }

  /**
   * タイトル画面。
   * - hasSave=true: 「続きから / 最初から」の分岐 (onContinue=続きから, onNew=最初から)。
   * - hasSave=false: 初回プレイ向けの訓練案内 (onContinue=訓練を開始, onNew=スキップ)。
   */
  showTitle(hasSave: boolean, onContinue: () => void, onNew: () => void): void {
    const prompt = hasSave
      ? `<div class="screen-prompt">▶ ENTER / 1: 続きから　　2: 最初から</div>
         <div class="screen-menu">
           <div class="item" data-action="key" data-key="Enter" role="button" tabindex="0">続きから</div>
           <div class="item" data-action="key" data-key="Digit2" role="button" tabindex="0">最初から</div>
         </div>`
      : `<div class="screen-prompt">▶ ENTER: 訓練を開始　　2: スキップ</div>
         <div class="screen-menu">
           <div class="item" data-action="key" data-key="Enter" role="button" tabindex="0">訓練を開始</div>
           <div class="item" data-action="key" data-key="Digit2" role="button" tabindex="0">スキップ</div>
         </div>`;
    this.root.innerHTML = `
      <div class="screen-title">MULTI-COMMANDER</div>
      <div class="screen-body">
        Terran Confederation 所属パイロットとして Kilrathi との戦いに挑め。<br>
        3つのミッションから成るキャンペーンだ。
      </div>
      ${prompt}`;
    this.show({ Enter: onContinue, Space: onContinue, Digit1: onContinue, Digit2: onNew });
  }

  showLoadout(initial: LoadoutChoice, onConfirm: (choice: LoadoutChoice) => void): void {
    this.cleanupSubControllers();
    this.handlers = {};
    this.menu = null;
    this.root.classList.add("show");
    this.loadoutCleanup = createLoadoutController(this.root, initial, (choice) => {
      this.loadoutCleanup = null;
      onConfirm(choice);
    });
  }

  /** 一時停止メニュー: 再開 / 設定 / ミッション再開 / タイトルへ。既定選択は「再開」。 */
  showPause(
    onResume: () => void,
    onSettings: () => void,
    onRestart: () => void,
    onTitle: () => void,
  ): void {
    const items = ["▶ 再開", "⚙ 設定", "↺ ミッション再開", "■ タイトルへ"];
    const paint = (idx: number): void => {
      const menu = items
        .map(
          (label, i) =>
            `<div class="item${i === idx ? " sel" : ""}" data-action="confirm" data-index="${i}" role="button" tabindex="0" aria-selected="${i === idx}">${label}</div>`,
        )
        .join("");
      this.root.innerHTML = `
        <div class="screen-title">PAUSED</div>
        <div class="screen-menu">${menu}</div>
        <div class="screen-prompt">▲▼ で選択 / ENTER で決定 / Esc で再開</div>`;
    };
    const actions = [onResume, onSettings, onRestart, onTitle];
    paint(0);
    this.showMenu({
      index: 0,
      count: items.length,
      onMove: paint,
      onConfirm: (i) => actions[i](),
      onBack: onResume,
      numberSelects: true,
    });
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
      <div class="screen-prompt">▶ ENTER で出撃</div>
      <div class="screen-menu">
        <div class="item" data-action="key" data-key="Enter" role="button" tabindex="0">▶ 出撃</div>
      </div>`;
    this.show({ Enter: onLaunch, Space: onLaunch });
  }

  showDebrief(
    result: "success" | "failure",
    resultText: string,
    kills: number,
    objectives: ObjectiveState[],
    onProceed: () => void,
    proceedLabel: string,
    hint?: string,
    suggestEasyAssist?: boolean,
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
    const hintHtml = hint ? `<div class="screen-stat">ヒント: ${hint}</div>` : "";
    const suggestHtml = suggestEasyAssist
      ? `<div class="screen-stat">連続で失敗しています。設定で難易度「やさしい」や照準アシストを強めるのも検討してみましょう。</div>`
      : "";
    this.root.innerHTML = `
      <div class="screen-hero ${heroCls}">${hero}</div>
      <div class="screen-stat">${resultText}</div>
      <div class="screen-stat">撃墜数: <b>${kills}</b></div>
      <div class="screen-list">${objs}</div>
      ${hintHtml}
      ${suggestHtml}
      <div class="screen-prompt">▶ ENTER で${proceedLabel}</div>
      <div class="screen-menu">
        <div class="item" data-action="key" data-key="Enter" role="button" tabindex="0">▶ ${proceedLabel}</div>
      </div>`;
    this.show({ Enter: onProceed, Space: onProceed });
  }

  showCampaignComplete(totalKills: number, onRestart: () => void): void {
    this.root.innerHTML = `
      <div class="screen-hero ok">CAMPAIGN CLEAR</div>
      <div class="screen-body">全ミッションを完遂した。おめでとう、エース。</div>
      <div class="screen-stat">総撃墜数: <b>${totalKills}</b></div>
      <div class="screen-prompt">▶ ENTER でメニューへ</div>
      <div class="screen-menu">
        <div class="item" data-action="key" data-key="Enter" role="button" tabindex="0">▶ メニューへ</div>
      </div>`;
    this.show({ Enter: onRestart, Space: onRestart });
  }

  /** 前画面がロードアウト/設定 (独自DOM制御) の場合は後始末してから切り替える。 */
  private cleanupSubControllers(): void {
    if (this.loadoutCleanup) {
      this.loadoutCleanup();
      this.loadoutCleanup = null;
    }
    if (this.settingsCleanup) {
      this.settingsCleanup();
      this.settingsCleanup = null;
    }
  }

  private show(handlers: Handlers): void {
    this.cleanupSubControllers();
    this.menu = null;
    this.handlers = handlers;
    this.root.classList.add("show");
  }

  private showMenu(menu: MenuState): void {
    this.cleanupSubControllers();
    this.handlers = {};
    this.menu = menu;
    this.root.classList.add("show");
  }

  hide(): void {
    this.handlers = {};
    this.menu = null;
    this.cleanupSubControllers();
    this.root.classList.remove("show");
  }
}
