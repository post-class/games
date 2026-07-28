import "./screens.css";
import type { MissionDefinition } from "../mission/MissionDefinition";
import type { ObjectiveState } from "../mission/MissionManager";
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from "../Settings";
import { createLoadoutController, type LoadoutChoice } from "./LoadoutScreen";

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

/** 操作説明に表示するキー割り当て (inputBindings.ts に対応)。 */
const CONTROL_ROWS: Array<[string, string]> = [
  ["↑ / ↓  (W / S)", "機首 上げ / 下げ"],
  ["← / →  (A / D)", "左右旋回 (ヨー)"],
  ["Q / E", "ロール"],
  ["[ / ]", "スロットル 減 / 増"],
  ["1〜9 / 0", "スロットル割合 / 停止"],
  ["Tab", "アフターバーナー (押し続け)"],
  ["Space", "エネルギー砲"],
  ["Enter", "ミサイル発射"],
  ["T / R / Y", "ターゲット 次 / 最至近 / 前方"],
  [", / . / /", "僚機 編隊 / 攻撃 / 交戦"],
  ["Z", "操作モード切替 (WC ⇄ 慣性)"],
];

/** 難易度ごとの短い説明。 */
const DIFF_DESC: Record<Difficulty, string> = {
  easy: "敵は脆く弾も痛くない。自機は頑丈。まず操作に慣れたい人向け。",
  normal: "標準的なバランス。",
  hard: "敵は硬く攻撃も苛烈。歯ごたえ重視の人向け。",
};

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

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "screen";
    container.appendChild(this.root);
    window.addEventListener("keydown", this.onKey);
  }

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
        .map((label, i) => `<div class="item${i === idx ? " sel" : ""}">${label}</div>`)
        .join("");
      this.root.innerHTML = `
        <div class="screen-title">MULTI-DOMMANDER</div>
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

  /** 設定: 難易度選択 + 操作説明。◀▶/数字で難易度変更、ENTER/ESC で戻る。 */
  showSettings(current: Difficulty, onChange: (d: Difficulty) => void, onBack: () => void): void {
    const order = DIFFICULTY_ORDER;
    const startIdx = Math.max(0, order.indexOf(current));
    const controls = CONTROL_ROWS.map(
      ([k, a]) => `<div class="row"><span class="k">${k}</span><span class="a">${a}</span></div>`,
    ).join("");
    const paint = (idx: number): void => {
      const opts = order
        .map((d, i) => `<div class="opt${i === idx ? " sel" : ""}">${DIFFICULTIES[d].label}</div>`)
        .join("");
      this.root.innerHTML = `
        <div class="screen-title">設定</div>
        <div class="screen-sub">難易度</div>
        <div class="diff-opts">${opts}</div>
        <div class="screen-sub">${DIFF_DESC[order[idx]]}</div>
        <div class="screen-sub" style="margin-top:20px">操作方法</div>
        <div class="controls">${controls}</div>
        <div class="screen-prompt">◀▶ で難易度変更 / ENTER・ESC で戻る</div>`;
    };
    paint(startIdx);
    this.showMenu({
      index: startIdx,
      count: order.length,
      onMove: (i) => {
        onChange(order[i]);
        paint(i);
      },
      onConfirm: () => onBack(),
      onBack: () => onBack(),
      numberSelects: false,
    });
  }

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

  showLoadout(initial: LoadoutChoice, onConfirm: (choice: LoadoutChoice) => void): void {
    this.handlers = {};
    this.menu = null;
    this.root.classList.add("show");
    this.loadoutCleanup = createLoadoutController(this.root, initial, (choice) => {
      this.loadoutCleanup = null;
      onConfirm(choice);
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
      <div class="screen-prompt">▶ ENTER でメニューへ</div>`;
    this.show({ Enter: onRestart, Space: onRestart });
  }

  private show(handlers: Handlers): void {
    this.menu = null;
    this.handlers = handlers;
    this.root.classList.add("show");
  }

  private showMenu(menu: MenuState): void {
    this.handlers = {};
    this.menu = menu;
    this.root.classList.add("show");
  }

  hide(): void {
    this.handlers = {};
    this.menu = null;
    if (this.loadoutCleanup) {
      this.loadoutCleanup();
      this.loadoutCleanup = null;
    }
    this.root.classList.remove("show");
  }
}
