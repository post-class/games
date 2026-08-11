/**
 * ui/screens/Title.ts — タイトル画面（`T-M12-09` / `05§2`）
 *
 * `05§2` の 4 項目:
 *  1. ロゴ — **紋章は前回選んだ文明のもの**に変わる（セーブデータが無ければ無地）
 *  2. 碑と環海 — 背景は静止画ではなく**時刻とともに空の色が変わる**（`02` の世界観）
 *  3. メニュー — キャンペーン / スカーミッシュ / オンライン / リプレイ。
 *     **続きがあれば最上段が「つづきから」に変わる**
 *  4. 補助ボタン — 設定とクレジット。**アカウント登録は不要なのでログイン項目はない**
 *
 * ■ 未実装画面の扱い
 *   未実装の画面は**暗くして理由を出す**（押しても何も起きないのは
 *   「壊れている」と見分けが付かない）。M14〜M16 が入ったので今は全段押せる。
 *   押しても何も起きないのは「壊れている」と見分けが付かないので、
 *   **暗くして理由を出す**（`buildTitleMenu` が `enabled` と `reason` を返す）。
 *   画面が登録されたら（`router.has`）自動で押せるようになる。
 *
 * ■ 背景（アセットは M17）
 *   `02_世界観.html` の「一つの海を、八つの文明が囲んでいる」＝ 環海と、
 *   中央の島に立つ碑。画像は使わず CSS のグラデーションと図形だけで描いてある。
 *   `skyPalette(hour)` が時刻から色を決め、1 秒ごとに反映する。
 *   M17 で背景画を入れる場合は `.mt-title-bg` に画像を重ねればよい（**差し替え口**）。
 */

import '@/styles/screens.css';

import type { CivId } from '@/shared/types';
import { CIV_IDS } from '@/shared/types';
import { el, button, type Screen, type ScreenId } from './router';
import { LAST_CIV_KEY, civLabel, emblemEl } from './CivSelect';

// ---------------------------------------------------------------- セーブの読み取り

/** 「続き」の保存キー（キャンペーンの進行 = M16 / 中断した試合 = M15 がここに書く）。 */
export const CONTINUE_KEY = 'mt.continue';

/**
 * `localStorage` の最小インタフェース。
 * **テストを DOM 無しで回すため**に、実物ではなくこの形を受け取る。
 */
export interface ReadOnlyStore {
  getItem(key: string): string | null;
}

/** タイトルが必要とするセーブ情報。 */
export interface TitleSaveInfo {
  /** 前回選んだ文明（`05§2-1`。無ければ null = 無地の紋章）。 */
  readonly lastCiv: CivId | null;
  /** 続きがあるか（`05§2-3`）。 */
  readonly hasContinue: boolean;
  /** 続きの表示名（章名など。無ければ null）。 */
  readonly continueLabel: string | null;
}

/**
 * セーブを読む（壊れていても例外を出さない。タイトルが出ないのが最悪なので）。
 *
 * `mt.continue` の形は `{"label":"第 2 章 青銅の世","screen":"campaign"}` を想定。
 * M15 / M16 がここに書く。**申し送り**: 中断した試合を復帰させる場合は
 * `screen` に `'match'` を入れ、必要な params も同じ JSON に足す。
 */
export function readTitleSave(store: ReadOnlyStore): TitleSaveInfo {
  let lastCiv: CivId | null = null;
  let hasContinue = false;
  let continueLabel: string | null = null;
  try {
    const civ = store.getItem(LAST_CIV_KEY);
    if (civ !== null && (CIV_IDS as readonly string[]).includes(civ)) lastCiv = civ as CivId;
  } catch {
    lastCiv = null;
  }
  try {
    const raw = store.getItem(CONTINUE_KEY);
    if (raw !== null && raw !== '') {
      hasContinue = true;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'label' in parsed) {
        const label = (parsed as Record<string, unknown>)['label'];
        if (typeof label === 'string' && label !== '') continueLabel = label;
      }
    }
  } catch {
    // JSON が壊れていても「続きはある」扱いにする（続きを消すより出す方が害が小さい）
    continueLabel = null;
  }
  return { lastCiv, hasContinue, continueLabel };
}

// ---------------------------------------------------------------- メニュー（純関数）

/** メニュー項目の識別子。 */
export type TitleMenuId = 'continue' | 'campaign' | 'skirmish' | 'online' | 'replay';

/** メニュー項目 1 つ。 */
export interface TitleMenuItem {
  readonly id: TitleMenuId;
  readonly label: string;
  /** 遷移先の画面。 */
  readonly target: ScreenId;
  /** 押せるか。false なら暗くして `reason` を出す。 */
  readonly enabled: boolean;
  /** 押せない理由（`05§15`「暗いボタンは理由が出る」）。押せるときは null。 */
  readonly reason: string | null;
  /** 補足（続きの章名など）。 */
  readonly note: string | null;
}

/**
 * オンラインは画面（対戦設定）はあるが、通信は別の層（`net`）なので
 * 画面の登録有無だけでは判定できない。ここだけ明示的に持っている。
 *
 * M14（ロックステップのクライアント結線）が入ったので **false**。
 * 中継サーバを起動していないときは、接続中の帯にその旨が出る
 * （押せないより「押したら理由が分かる」ほうがよい）。
 */
export const ONLINE_PENDING = false;

/** 未実装の理由文（画面ごと）。 */
const PENDING_REASON: Readonly<Record<TitleMenuId, string>> = {
  continue: '続きのデータがありません',
  campaign: 'キャンペーンは未実装です（M16）',
  skirmish: '対戦設定が未登録です',
  online: 'オンライン対戦は未実装です（M14。通信の結線待ち）',
  replay: 'リプレイは未実装です（M15）',
};

/**
 * メニュー 4 項目を組み立てる（`05§2-3`）。
 *
 * **続きがある場合は最上段が「つづきから」に変わる**（キャンペーンと入れ替わるのではなく、
 * 最上段の項目がそれになる ＝ 4 項目のまま）。
 *
 * @param save セーブ情報
 * @param isRegistered `router.has` を渡す（未登録の画面は押せない）
 */
export function buildTitleMenu(
  save: TitleSaveInfo,
  isRegistered: (id: ScreenId) => boolean,
): TitleMenuItem[] {
  const items: TitleMenuItem[] = [];

  // 1 段目: 続きがあれば「つづきから」、無ければ「キャンペーン」
  if (save.hasContinue) {
    const ok = isRegistered('campaign');
    items.push({
      id: 'continue',
      label: 'つづきから',
      target: 'campaign',
      enabled: ok,
      reason: ok ? null : PENDING_REASON.campaign,
      note: save.continueLabel,
    });
  } else {
    const ok = isRegistered('campaign');
    items.push({
      id: 'campaign',
      label: 'キャンペーン',
      target: 'campaign',
      enabled: ok,
      reason: ok ? null : PENDING_REASON.campaign,
      note: '全 4 章・各 5 ミッション',
    });
  }

  // 2 段目: スカーミッシュ（対戦設定へ）
  const setupOk = isRegistered('matchSetup');
  items.push({
    id: 'skirmish',
    label: 'スカーミッシュ',
    target: 'matchSetup',
    enabled: setupOk,
    reason: setupOk ? null : PENDING_REASON.skirmish,
    note: '1 人で AI と。最大 8 人',
  });

  // 3 段目: オンライン（画面は同じ対戦設定。通信は M14）
  const onlineOk = setupOk && !ONLINE_PENDING;
  items.push({
    id: 'online',
    label: 'オンライン',
    target: 'matchSetup',
    enabled: onlineOk,
    reason: onlineOk ? null : PENDING_REASON.online,
    note: 'URL を共有して集まる（登録不要）',
  });

  // 4 段目: リプレイ
  const replayOk = isRegistered('replay');
  items.push({
    id: 'replay',
    label: 'リプレイ',
    target: 'replay',
    enabled: replayOk,
    reason: replayOk ? null : PENDING_REASON.replay,
    note: '戦域レーンで振り返る',
  });

  return items;
}

/** 補助ボタン 1 つ（`05§2-4`。**ログイン項目は無い**）。 */
export interface TitleSubButton {
  readonly id: 'settings' | 'credits';
  readonly label: string;
  readonly target: ScreenId | null;
  readonly enabled: boolean;
  readonly reason: string | null;
}

/** 補助ボタン（設定・クレジット）。 */
export function buildSubButtons(isRegistered: (id: ScreenId) => boolean): TitleSubButton[] {
  const settingsOk = isRegistered('settings');
  return [
    {
      id: 'settings',
      label: '設定',
      target: 'settings',
      enabled: settingsOk,
      reason: settingsOk ? null : '設定画面は未実装です（T-M12-14）',
    },
    // クレジットは 1 画面を割く内容ではないのでタイトル内のパネルで出す（画面 ID を持たない）
    { id: 'credits', label: 'クレジット', target: null, enabled: true, reason: null },
  ];
}

// ---------------------------------------------------------------- 空の色（純関数）

/** 空・海・島の色（`05§2-2` の「時刻とともに空の色が変わる」）。 */
export interface SkyPalette {
  /** 天頂の色。 */
  readonly top: string;
  /** 地平の色。 */
  readonly bottom: string;
  /** 太陽・月の色。 */
  readonly sun: string;
  /** 環海の色。 */
  readonly sea: string;
  /** 島と碑の影の色。 */
  readonly silhouette: string;
  /** 時間帯の名前（画面右下に小さく出す。世界観の導入）。 */
  readonly label: string;
}

/** 時間帯の定義（0 時から昇順。`hour` はその時間帯の中心）。 */
const SKY_STOPS: readonly (SkyPalette & { hour: number })[] = [
  {
    hour: 0,
    top: '#070b18',
    bottom: '#101a2c',
    sun: '#cdd6e8',
    sea: '#0b1524',
    silhouette: '#03060c',
    label: '夜半',
  },
  {
    hour: 5,
    top: '#1c2547',
    bottom: '#7a5a68',
    sun: '#ffd9a0',
    sea: '#26354c',
    silhouette: '#0a0c16',
    label: '暁',
  },
  {
    hour: 8,
    top: '#3d6ea8',
    bottom: '#c3ab86',
    sun: '#fff2cf',
    sea: '#2f628a',
    silhouette: '#1a1a18',
    label: '朝',
  },
  {
    hour: 12,
    top: '#4f8fc4',
    bottom: '#cfd8c8',
    sun: '#ffffff',
    sea: '#357fa8',
    silhouette: '#23261f',
    label: '日中',
  },
  {
    hour: 17,
    top: '#5a6ea0',
    bottom: '#e0a05a',
    sun: '#ffdc9a',
    sea: '#4a6c86',
    silhouette: '#1d1a16',
    label: '夕',
  },
  {
    hour: 20,
    top: '#1b2140',
    bottom: '#6b4054',
    sun: '#ffcf9a',
    sea: '#1d2a3e',
    silhouette: '#0a0a10',
    label: '宵',
  },
];

/** '#rrggbb' → [r,g,b]。 */
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** [r,g,b] → '#rrggbb'。 */
function rgbToHex(c: readonly [number, number, number]): string {
  const to = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

/** 2 色を t（0..1）で混ぜる。 */
function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/**
 * 時刻（0..24 の実数）から空の色を作る。
 *
 * 時間帯の間は線形補間するので、**1 分ごとに少しずつ色が動く**（静止画にしない）。
 * 24 時をまたぐところも輪として繋がる。
 */
export function skyPalette(hour: number): SkyPalette {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  for (let k = 0; k < SKY_STOPS.length; k++) {
    if (SKY_STOPS[k]!.hour <= h) i = k;
  }
  const a = SKY_STOPS[i]!;
  const b = SKY_STOPS[(i + 1) % SKY_STOPS.length]!;
  const span = (b.hour - a.hour + 24) % 24 || 24;
  const t = Math.min(1, Math.max(0, ((h - a.hour + 24) % 24) / span));
  return {
    top: mixHex(a.top, b.top, t),
    bottom: mixHex(a.bottom, b.bottom, t),
    sun: mixHex(a.sun, b.sun, t),
    sea: mixHex(a.sea, b.sea, t),
    silhouette: mixHex(a.silhouette, b.silhouette, t),
    // 名前は補間できないので近い方を採る（境界で切り替わる）
    label: t < 0.5 ? a.label : b.label,
  };
}

/** 太陽・月の高さ（0 = 地平、1 = 天頂）と、月かどうか。 */
export function sunPosition(hour: number): { x: number; y: number; isMoon: boolean } {
  const h = ((hour % 24) + 24) % 24;
  const day = h >= 6 && h < 18;
  // 昼は 6→18 時で東から西へ、夜は 18→6 時で同じ弧を描く
  const p = day ? (h - 6) / 12 : ((h + 6) % 24) / 12;
  return { x: p, y: Math.sin(p * Math.PI), isMoon: !day };
}

// ---------------------------------------------------------------- 画面

/**
 * 島と碑の絵（`tools/assets` の `scenes` カテゴリが作る）。
 * `CivSelect.ts` の `CIV_ASSETS` と同じ流儀の相対パス（`vite` の base に追従させるため）。
 */
const TITLE_ISLAND_SRC = 'assets/ui/title_island.webp';

/** タイトル画面。 */
export const titleScreen: Screen = {
  mount(root, nav) {
    const save = readTitleSave(safeStore());

    const scr = el('div', 'mt-scr mt-scr-title');

    // ---- 2 背景（環海と碑。時刻で色が変わる）----
    const bg = el('div', 'mt-title-bg');
    const sun = el('div', 'mt-title-sun');
    const sea = el('div', 'mt-title-sea');
    // 島と碑（`02` の環海の中心）。
    //
    // **絵は透過 PNG で、空と海は CSS のまま**にしてある。理由は
    // `05§2` の「時刻とともに空の色が変わる」演出（`skyPalette`）で、
    // 空を含む 1 枚絵を敷くとこの仕掛けが死ぬ。だから絵は島だけを切り抜いて重ねる。
    //
    // **絵が無くても成立させる。** アセットは後から差し替わる前提なので
    // （`tools/assets` で作る）、読み込みに失敗したら CSS 図形の島に戻す。
    // 画像がないと真っ白な画面になる作りにはしない。
    const isle = el('div', 'mt-title-isle');
    const stone = el('div', 'mt-title-stone');
    isle.appendChild(stone);
    const isleImg = document.createElement('img');
    isleImg.className = 'mt-title-isle-img';
    isleImg.src = TITLE_ISLAND_SRC;
    isleImg.alt = '';
    isleImg.decoding = 'async';
    // 読めたら CSS 図形を隠す（読めなければ図形のまま）。
    isleImg.addEventListener('load', () => {
      isleImg.classList.add('is-ready');
      isle.classList.add('is-hidden');
    });
    bg.appendChild(sun);
    bg.appendChild(sea);
    // 水平線をなじませる帯（`sea` の上辺に空の色を重ねる）。`sea` の後・島の前に置く。
    const haze = el('div', 'mt-title-haze');
    bg.appendChild(haze);
    bg.appendChild(isle);
    bg.appendChild(isleImg);
    scr.appendChild(bg);
    const clock = el('p', 'mt-title-clock');
    scr.appendChild(clock);

    // ---- 1 ロゴ（紋章は前回選んだ文明）----
    const logo = el('div', 'mt-title-logo');
    if (save.lastCiv !== null) {
      logo.appendChild(emblemEl(save.lastCiv, 64));
    } else {
      // セーブデータが無ければ無地（`05§2-1`）
      const blank = el('span', 'mt-emblem mt-emblem-blank');
      blank.title = '前回選んだ文明の紋章がここに出ます';
      logo.appendChild(blank);
    }
    const words = el('div', 'mt-title-words');
    words.appendChild(el('h1', 'mt-title-name', 'MULTI-TAKTIKA'));
    words.appendChild(
      el(
        'p',
        'mt-title-tag',
        save.lastCiv === null
          ? '一つの海を、八つの文明が囲んでいる'
          : `前回の旗: ${civLabel(save.lastCiv)}`,
      ),
    );
    logo.appendChild(words);
    scr.appendChild(logo);

    // ---- 3 メニュー 4 項目 ----
    const menu = el('nav', 'mt-title-menu');
    const items = buildTitleMenu(save, (id) => hasScreen(nav, id));
    let first = true;
    for (const item of items) {
      const row = el('div', `mt-menu-row${item.enabled ? '' : ' is-off'}`);
      const b = button(`mt-menu-btn${first && item.enabled ? ' is-first' : ''}`, item.label, () => {
        if (!item.enabled) return;
        nav.go(item.target, { seed: seedForNewMatch() });
      });
      b.disabled = !item.enabled;
      if (!item.enabled && item.reason !== null) b.title = item.reason;
      row.appendChild(b);
      const note = item.enabled ? item.note : item.reason;
      if (note !== null) row.appendChild(el('span', 'mt-menu-note', note));
      menu.appendChild(row);
      first = false;
    }
    scr.appendChild(menu);

    // ---- 4 補助ボタン（ログイン項目は無い）----
    const sub = el('div', 'mt-title-sub');
    for (const s of buildSubButtons((id) => hasScreen(nav, id))) {
      const b = button(`mt-btn${s.enabled ? '' : ' is-off'}`, s.label, () => {
        if (!s.enabled) return;
        if (s.id === 'credits') {
          credits.classList.toggle('is-shown');
          return;
        }
        if (s.target !== null) nav.go(s.target);
      });
      b.disabled = !s.enabled;
      if (!s.enabled && s.reason !== null) b.title = s.reason;
      sub.appendChild(b);
    }
    sub.appendChild(el('span', 'mt-title-sub-note', 'アカウント登録は不要（ログイン項目はありません）'));
    scr.appendChild(sub);

    const credits = el('div', 'mt-credits');
    credits.appendChild(el('h2', 'mt-scr-h', 'クレジット'));
    credits.appendChild(
      el('p', '', 'Multi-Taktika — ブラウザだけで動く歴史 RTS。8 文明・4 時代・最大 8 人対戦。'),
    );
    credits.appendChild(el('p', '', '設計資料: 世界観 / 文明と進化 / 操作方法 / ゲームシステム / 画面説明'));
    credits.appendChild(el('p', 'mt-credits-note', 'アセット（紋章・立ち絵・効果音）は M17 で差し替えます。'));
    scr.appendChild(credits);

    root.appendChild(scr);

    /** 空の色を反映する（`frame` から 1 秒に 1 回）。 */
    applySky = (hour: number): void => {
      const p = skyPalette(hour);
      bg.style.background = `linear-gradient(180deg, ${p.top} 0%, ${p.bottom} 62%, ${p.sea} 62%, ${p.sea} 100%)`;
      sea.style.background = `linear-gradient(180deg, ${p.sea} 0%, ${mixHex(p.sea, '#000000', 0.35)} 100%)`;
      // 水平線の霞。**空の地平の色**を海の上辺に薄く落として境目を消す
      // （単色の矩形どうしが接すると定規で引いた線になり、島の絵が紙細工に見える）。
      haze.style.setProperty('--mt-sky-bottom', p.bottom);
      isle.style.background = p.silhouette;
      stone.style.background = mixHex(p.silhouette, p.sun, 0.25);
      stone.style.boxShadow = `0 0 18px ${p.sun}`;
      const sp = sunPosition(hour);
      sun.style.background = p.sun;
      sun.style.boxShadow = `0 0 40px 12px ${p.sun}`;
      sun.style.left = `${8 + sp.x * 84}%`;
      sun.style.bottom = `${38 + sp.y * 46}%`;
      sun.style.opacity = sp.isMoon ? '0.75' : '1';
      const hh = Math.floor(((hour % 24) + 24) % 24);
      const mm = Math.floor((hour - Math.floor(hour)) * 60);
      clock.textContent = `環海 ― ${p.label}（${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}）`;
    };
    applySky(currentHour());
    lastSkyMs = 0;
  },

  unmount() {
    applySky = null;
  },

  frame(nowMs) {
    // 空の色は 1 秒に 1 回だけ更新する（毎フレームやる意味がない）
    if (applySky === null) return;
    if (nowMs - lastSkyMs < 1000) return;
    lastSkyMs = nowMs;
    applySky(currentHour());
  },
};

/** 空の色を反映する関数（mount 中だけ有効）。 */
let applySky: ((hour: number) => void) | null = null;
let lastSkyMs = 0;

/** 端末の現在時刻（時 + 分/60）。**時刻で空が変わる**ための唯一の時刻参照。 */
function currentHour(): number {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** 新しい試合のシード（時刻由来。同じ URL でも毎回違う地形になる）。 */
function seedForNewMatch(): number {
  return Math.floor(Date.now() % 100000000);
}

/** `localStorage` が使えない環境でも落ちないようにする。 */
function safeStore(): ReadOnlyStore {
  return {
    getItem(key: string): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
  };
}

/**
 * 画面が登録されているか。`ScreenNav` には `has` が無いので、
 * ルータ本体を知らないまま判定するための逃げ道をここに閉じ込める。
 * （`ScreenNav` に `has` が増えたらこの関数を消してそちらを使う。**申し送り**）
 */
function hasScreen(nav: unknown, id: ScreenId): boolean {
  const fn = (nav as { has?: (x: ScreenId) => boolean }).has;
  return typeof fn === 'function' ? fn.call(nav, id) : false;
}
