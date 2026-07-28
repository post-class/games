import { DIFFICULTIES, DIFFICULTY_ORDER, type AimAssist, type GameSettingsV2 } from "../Settings";
import { buildControlRows, renderControlRowsHtml } from "../../config/bindingDisplay";

type TabId = "game" | "controls" | "audio";
const TABS: TabId[] = ["game", "controls", "audio"];
const TAB_LABELS: Record<TabId, string> = { game: "ゲーム", controls: "操作", audio: "オーディオ" };

const AIM_ASSIST_ORDER: AimAssist[] = ["strong", "light", "off"];
const AIM_ASSIST_LABELS: Record<AimAssist, string> = { strong: "強", light: "弱", off: "なし" };

type ItemKind = "toggle" | "cycle" | "slider" | "action";

interface SettingsItem {
  kind: ItemKind;
  label: string;
  display: string;
  /** トグル切替/サイクル送り/ボタン実行 (Enter・Space・クリック)。 */
  onActivate?: () => void;
  /** サイクル戻し/スライダー減 (◀)。 */
  onDec?: () => void;
  /** サイクル送り/スライダー増 (▶)。 */
  onInc?: () => void;
  /** スライダーのトラッククリック位置 (0..1) を直接反映。 */
  onSetRatio?: (ratio: number) => void;
  /** スライダー描画用の現在値 (0..1)。 */
  ratio?: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
function roundStep(v: number, step: number): number {
  return Math.round(v / step) * step;
}
function cycle<T>(order: T[], current: T, dir: 1 | -1): T {
  const i = order.indexOf(current);
  const n = order.length;
  return order[(i + dir + n) % n];
}

/** 現在の設定スナップショットから、タブ内の項目一覧を構築する (末尾に「初期設定に戻す」)。 */
function buildItems(tab: TabId, s: GameSettingsV2, commit: () => void, onReset: () => void): SettingsItem[] {
  const items: SettingsItem[] = [];
  if (tab === "game") {
    items.push({
      kind: "cycle",
      label: "難易度",
      display: DIFFICULTIES[s.difficulty].label,
      onActivate: () => {
        s.difficulty = cycle(DIFFICULTY_ORDER, s.difficulty, 1);
        commit();
      },
      onDec: () => {
        s.difficulty = cycle(DIFFICULTY_ORDER, s.difficulty, -1);
        commit();
      },
      onInc: () => {
        s.difficulty = cycle(DIFFICULTY_ORDER, s.difficulty, 1);
        commit();
      },
    });
    items.push({
      kind: "cycle",
      label: "照準アシスト",
      display: AIM_ASSIST_LABELS[s.assists.aimAssist],
      onActivate: () => {
        s.assists.aimAssist = cycle(AIM_ASSIST_ORDER, s.assists.aimAssist, 1);
        commit();
      },
      onDec: () => {
        s.assists.aimAssist = cycle(AIM_ASSIST_ORDER, s.assists.aimAssist, -1);
        commit();
      },
      onInc: () => {
        s.assists.aimAssist = cycle(AIM_ASSIST_ORDER, s.assists.aimAssist, 1);
        commit();
      },
    });
    items.push({
      kind: "toggle",
      label: "自動ターゲット",
      display: s.assists.autoTarget ? "ON" : "OFF",
      onActivate: () => {
        s.assists.autoTarget = !s.assists.autoTarget;
        commit();
      },
    });
    items.push({
      kind: "toggle",
      label: "状況ヒント",
      display: s.assists.contextualHints ? "ON" : "OFF",
      onActivate: () => {
        s.assists.contextualHints = !s.assists.contextualHints;
        commit();
      },
    });
  } else if (tab === "controls") {
    items.push({
      kind: "toggle",
      label: "マウス操縦 (M)",
      display: s.controls.mouseEnabled ? "ON" : "OFF",
      onActivate: () => {
        s.controls.mouseEnabled = !s.controls.mouseEnabled;
        commit();
      },
    });
    items.push({
      kind: "slider",
      label: "マウス感度",
      display: s.controls.mouseSensitivity.toFixed(1),
      ratio: (s.controls.mouseSensitivity - 0.5) / (2.0 - 0.5),
      onDec: () => {
        s.controls.mouseSensitivity = clamp(roundStep(s.controls.mouseSensitivity - 0.1, 0.1), 0.5, 2.0);
        commit();
      },
      onInc: () => {
        s.controls.mouseSensitivity = clamp(roundStep(s.controls.mouseSensitivity + 0.1, 0.1), 0.5, 2.0);
        commit();
      },
      onSetRatio: (r) => {
        s.controls.mouseSensitivity = clamp(roundStep(0.5 + r * (2.0 - 0.5), 0.1), 0.5, 2.0);
        commit();
      },
    });
    items.push({
      kind: "toggle",
      label: "Y軸反転",
      display: s.controls.invertMouseY ? "ON" : "OFF",
      onActivate: () => {
        s.controls.invertMouseY = !s.controls.invertMouseY;
        commit();
      },
    });
    items.push({
      kind: "toggle",
      label: "高度な飛行 (Newton切替)",
      display: s.controls.advancedFlight ? "ON" : "OFF",
      onActivate: () => {
        s.controls.advancedFlight = !s.controls.advancedFlight;
        commit();
      },
    });
  } else {
    items.push({
      kind: "slider",
      label: "マスター",
      display: Math.round(s.audio.master * 100) + "%",
      ratio: s.audio.master,
      onDec: () => {
        s.audio.master = clamp(roundStep(s.audio.master - 0.05, 0.05), 0, 1);
        commit();
      },
      onInc: () => {
        s.audio.master = clamp(roundStep(s.audio.master + 0.05, 0.05), 0, 1);
        commit();
      },
      onSetRatio: (r) => {
        s.audio.master = clamp(roundStep(r, 0.05), 0, 1);
        commit();
      },
    });
    items.push({
      kind: "slider",
      label: "BGM",
      display: Math.round(s.audio.music * 100) + "%",
      ratio: s.audio.music,
      onDec: () => {
        s.audio.music = clamp(roundStep(s.audio.music - 0.05, 0.05), 0, 1);
        commit();
      },
      onInc: () => {
        s.audio.music = clamp(roundStep(s.audio.music + 0.05, 0.05), 0, 1);
        commit();
      },
      onSetRatio: (r) => {
        s.audio.music = clamp(roundStep(r, 0.05), 0, 1);
        commit();
      },
    });
    items.push({
      kind: "slider",
      label: "SE",
      display: Math.round(s.audio.sfx * 100) + "%",
      ratio: s.audio.sfx,
      onDec: () => {
        s.audio.sfx = clamp(roundStep(s.audio.sfx - 0.05, 0.05), 0, 1);
        commit();
      },
      onInc: () => {
        s.audio.sfx = clamp(roundStep(s.audio.sfx + 0.05, 0.05), 0, 1);
        commit();
      },
      onSetRatio: (r) => {
        s.audio.sfx = clamp(roundStep(r, 0.05), 0, 1);
        commit();
      },
    });
  }
  items.push({
    kind: "action",
    label: "初期設定に戻す",
    display: "",
    onActivate: onReset,
  });
  return items;
}

function renderItemHtml(item: SettingsItem, idx: number, selIdx: number): string {
  const sel = idx === selIdx ? " sel" : "";
  if (item.kind === "action") {
    return `<div class="setting-item action${sel}" data-idx="${idx}" role="button" tabindex="0">▼ ${item.label}</div>`;
  }
  if (item.kind === "slider") {
    const pct = clamp((item.ratio ?? 0) * 100, 0, 100);
    return `
      <div class="setting-item slider${sel}" data-idx="${idx}" role="button" tabindex="0">
        <span class="label">${item.label}</span>
        <div class="slider-track" data-idx="${idx}">
          <div class="slider-fill" style="width:${pct}%"></div>
        </div>
        <span class="value">${item.display}</span>
      </div>`;
  }
  return `
    <div class="setting-item${sel}" data-idx="${idx}" role="button" tabindex="0">
      <span class="label">${item.label}</span>
      <span class="value">${item.display}</span>
    </div>`;
}

function buildHtml(tabIdx: number, items: SettingsItem[], selIdx: number, controlsHtml: string, tab: TabId): string {
  const tabsHtml = TABS.map(
    (t, i) => `<div class="settings-tab${i === tabIdx ? " sel" : ""}" data-tab-idx="${i}">${TAB_LABELS[t]}</div>`,
  ).join("");
  const itemsHtml = items.map((it, i) => renderItemHtml(it, i, selIdx)).join("");
  const controlsBlock =
    tab === "controls"
      ? `<div class="screen-sub" style="margin-top:16px">操作一覧</div><div class="controls">${controlsHtml}</div>`
      : "";
  return `
    <div class="screen-title">設定</div>
    <div class="settings-tabs">${tabsHtml}</div>
    <div class="settings-items">${itemsHtml}</div>
    ${controlsBlock}
    <div class="screen-prompt">◀▶ タブ切替・値変更 / ▲▼ 項目移動 / ENTER・SPACE 決定 / ESC 戻る</div>`;
}

/**
 * 設定画面 (タブ+項目の2次元ナビゲーション) の DOM/キーボード/クリック制御。
 * 変更は即時に onChange(setting) を呼び出す (呼び出し側で保存・InputManager/AudioManager反映)。
 */
export function createSettingsController(
  root: HTMLElement,
  initial: GameSettingsV2,
  onChange: (s: GameSettingsV2) => void,
  onReset: () => void,
  onBack: () => void,
): () => void {
  // ローカルの作業コピー (逐次ミューテートし、変更ごとに commit で通知)。
  const s: GameSettingsV2 = JSON.parse(JSON.stringify(initial));
  let tabIdx = 0;
  let itemIdx = 0;

  const commit = (): void => {
    onChange(JSON.parse(JSON.stringify(s)));
    render();
  };

  const currentTab = (): TabId => TABS[tabIdx];
  const currentItems = (): SettingsItem[] => buildItems(currentTab(), s, commit, () => onReset());

  const render = (): void => {
    const items = currentItems();
    itemIdx = clamp(itemIdx, 0, items.length - 1);
    const controlsHtml = renderControlRowsHtml(buildControlRows(s.controls.advancedFlight));
    root.innerHTML = buildHtml(tabIdx, items, itemIdx, controlsHtml, currentTab());
  };
  render();

  const switchTab = (dir: 1 | -1): void => {
    tabIdx = (tabIdx + dir + TABS.length) % TABS.length;
    itemIdx = 0;
    render();
  };

  const handler = (e: KeyboardEvent): void => {
    const code = e.code;
    const items = currentItems();
    const item = items[itemIdx];
    if (code === "ArrowUp") {
      e.preventDefault();
      itemIdx = (itemIdx - 1 + items.length) % items.length;
      render();
    } else if (code === "ArrowDown") {
      e.preventDefault();
      itemIdx = (itemIdx + 1) % items.length;
      render();
    } else if (code === "ArrowLeft") {
      e.preventDefault();
      if (item && item.onDec) item.onDec();
      else switchTab(-1);
    } else if (code === "ArrowRight") {
      e.preventDefault();
      if (item && item.onInc) item.onInc();
      else switchTab(1);
    } else if (code === "Enter" || code === "Space") {
      e.preventDefault();
      if (item && item.onActivate) item.onActivate();
    } else if (code === "Escape" || code === "Backspace") {
      e.preventDefault();
      cleanup();
      onBack();
    }
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const tabEl = target.closest("[data-tab-idx]") as HTMLElement | null;
    if (tabEl) {
      const i = Number(tabEl.getAttribute("data-tab-idx"));
      if (!Number.isNaN(i) && i !== tabIdx) {
        tabIdx = i;
        itemIdx = 0;
        render();
      }
      return;
    }
    const sliderEl = target.closest(".slider-track") as HTMLElement | null;
    if (sliderEl) {
      const i = Number(sliderEl.getAttribute("data-idx"));
      const items = currentItems();
      const item = items[i];
      if (item && item.onSetRatio) {
        const rect = sliderEl.getBoundingClientRect();
        const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        itemIdx = i;
        item.onSetRatio(ratio);
      }
      return;
    }
    const itemEl = target.closest("[data-idx]") as HTMLElement | null;
    if (itemEl) {
      const i = Number(itemEl.getAttribute("data-idx"));
      if (Number.isNaN(i)) return;
      itemIdx = i;
      const items = currentItems();
      const item = items[i];
      if (item && item.onActivate) item.onActivate();
      else render();
    }
  };

  window.addEventListener("keydown", handler);
  root.addEventListener("click", onClick);
  const cleanup = (): void => {
    window.removeEventListener("keydown", handler);
    root.removeEventListener("click", onClick);
  };
  return cleanup;
}
