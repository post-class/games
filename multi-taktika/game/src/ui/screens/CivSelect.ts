/**
 * ui/screens/CivSelect.ts — 文明選択画面（`T-M12-11` / `05§4`）
 *
 * `05§4` の 6 項目:
 *  1. 紋章グリッド 9 枠（8 文明 + 末尾にランダム枠）。並びは資料どおり
 *     ヤマト／唐／ローマ／ヴァイキング／マリ／アステカ／ペルシア／モンゴル
 *  2. 選択中の紋章は金枠で光る（`05§15` の「金の縁 = 今これが選ばれている」）
 *  3. ランダム枠（相手に読ませないための枠）
 *  4. 総大将（見た目の確認用。アセットは M17 なのでプレースホルダ）
 *  5. 主力兵サムネイル（近接・遠隔・騎兵の代表）。**枠が暗いものはその文明が持たない役割**
 *  6. ボーナスと固有令（内政ボーナス 1 行 + 固有令 1 枚）
 *
 * ■ 設計の要点
 *  - **文明の中身をこのファイルに書き写さない**。持たない役割・内政ボーナス・固有令は
 *    すべて `sim/core/defs`（= `src/data/*.json`）から引く。JSON を直せば画面が追従する。
 *  - sim は**読むだけ**（手順書 §3.1）。試合を作るのは `MatchSetup` の役目。
 *  - 判定と文言の組み立ては DOM を触らない純関数に分けてある（jsdom の無い環境で
 *    テストできるようにするため。テストは `tests/unit/ui.civSelect.test.ts`）。
 *  - **アセットの差し替え口は `CIV_ASSETS`**（このファイルが所有）。M17 で
 *    `CIV_ASSETS.emblem = (civ) => \`/assets/emblem/${civ}.png\`` のように差し替えるだけで
 *    3 画面すべての紋章・立ち絵・兵サムネが画像に変わる。
 *    タイトルと対戦設定もここを import している（**紋章の見た目を 1 か所に集めるため**。
 *    このファイルは他の画面を import しないので import の輪はできない）。
 */

import '@/styles/screens.css';

import { CIV_IDS, type CivId } from '@/shared/types';
import { buildingDefById, civDefById, orderDefById, unitDefById } from '@/sim/core/defs';
import { loadGameData } from '@/data/load';
import { el, button, type Screen, type ScreenParams } from './router';

// ---------------------------------------------------------------- 枠と ID

/** ランダム枠の識別子（9 枠目）。 */
export const RANDOM_CIV = 'random' as const;

/** 紋章 1 枠が表す値。文明 8 種 + ランダム枠。 */
export type CivSlotId = CivId | typeof RANDOM_CIV;

/**
 * 紋章グリッドの並び（`05§4-1`。**左上から**）。
 * `CIV_IDS`（データ順）とは並びが違うので、ここは画面の並びとしてだけ持つ。
 * 「8 文明すべてが 1 回ずつ出ること」はテストで担保する。
 */
export const CIV_GRID: readonly CivSlotId[] = [
  'yamato',
  'tou',
  'roma',
  'viking',
  'mali',
  'azteca',
  'persia',
  'mongol',
  RANDOM_CIV,
];

/** 主力兵サムネイルに出す 3 役割（`05§4-5`）。 */
export const THUMB_LINES: readonly ['melee', 'ranged', 'cavalry'] = ['melee', 'ranged', 'cavalry'];

/** 役割 → 画面の呼び名（表示文字。バランス値ではない）。 */
const LINE_LABELS: Readonly<Record<string, string>> = {
  melee: '近接',
  ranged: '遠隔',
  cavalry: '騎兵',
  beast: '獣兵',
  siege: '攻城',
  ship: '船',
  elite: 'エリート',
};

/** 系統 ID → 表示名（未知の系統は ID をそのまま出す）。 */
export function lineLabel(line: string): string {
  return LINE_LABELS[line] ?? line;
}

// ---------------------------------------------------------------- アセット差し替え口

/**
 * 画像アセットの差し替え口（**M17 `T-M17-*` 用**）。
 *
 * 既定は全部 `null` = プレースホルダ（文字と図形）で描く。
 * M17 で以下のように差し替えるだけで画面側の変更は不要。
 * ```ts
 * import { CIV_ASSETS } from '@/ui/screens/CivSelect';
 * CIV_ASSETS.emblem = (civ) => `/assets/emblem/${civ}.png`;
 * CIV_ASSETS.portrait = (civ) => `/assets/general/${civ}.png`;
 * CIV_ASSETS.unit = (unitId) => `/assets/unit/${unitId}.png`;
 * ```
 */
export const CIV_ASSETS: {
  /** 文明の紋章。ランダム枠は `null` 固定（呼ばれない）。 */
  emblem: (civ: CivId) => string | null;
  /** 総大将の立ち絵。 */
  portrait: (civ: CivId) => string | null;
  /** ユニットのサムネイル。 */
  unit: (unitId: string) => string | null;
} = {
  emblem: () => null,
  portrait: () => null,
  unit: () => null,
};

/** 紋章プレースホルダに出す文字（文明名の 1 文字目。ランダム枠は「？」）。 */
export function civInitial(slot: CivSlotId): string {
  if (slot === RANDOM_CIV) return '？';
  return civDefById(slot).name.slice(0, 1);
}

/** 文明の表示名（ランダム枠は「ランダム」）。 */
export function civLabel(slot: CivSlotId): string {
  return slot === RANDOM_CIV ? 'ランダム' : civDefById(slot).name;
}

/**
 * 紋章 1 個の要素を作る。画像アセットが入っていればそれを、無ければ
 * 文字（`civInitial`）+ 陣営色の枠で描く。
 */
export function emblemEl(slot: CivSlotId, sizePx = 44, teamColor?: string): HTMLElement {
  const box = el('span', 'mt-emblem');
  box.style.width = `${sizePx}px`;
  box.style.height = `${sizePx}px`;
  box.style.fontSize = `${Math.round(sizePx * 0.5)}px`;
  if (teamColor !== undefined) box.style.borderColor = teamColor;
  const src = slot === RANDOM_CIV ? null : CIV_ASSETS.emblem(slot);
  if (src !== null) {
    const img = el('img', 'mt-emblem-img');
    img.src = src;
    img.alt = civLabel(slot);
    box.appendChild(img);
  } else {
    box.appendChild(el('span', 'mt-emblem-text', civInitial(slot)));
    if (slot === RANDOM_CIV) box.classList.add('mt-emblem-random');
  }
  box.title = civLabel(slot);
  return box;
}

// ---------------------------------------------------------------- 純関数（テスト対象）

/** 主力兵サムネイル 1 枠。 */
export interface RoleThumb {
  /** 系統（近接・遠隔・騎兵）。 */
  readonly line: string;
  /** その文明がこの役割を持つか。**false なら枠を暗くする**（`05§4-5`）。 */
  readonly has: boolean;
  /** 代表ユニット ID（最上段。持たない役割は null）。 */
  readonly unitId: string | null;
  /** 表示名（持たない役割は「騎兵を持たない」）。 */
  readonly label: string;
}

/** `unitTree` の 1 段を ID に落とす（複数併記は先頭を代表にする）。 */
function tierUnitId(v: string | readonly string[] | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v as string;
}

/**
 * 主力兵サムネイル 3 枠（`05§4-5`）。
 *
 * 代表は**その系統の最上段**（帝国の世で行き着く兵）。全段 null の系統は
 * 「その文明が持たない役割」なので `has=false`（例: ヴァイキング・アステカの騎兵）。
 * 判定は `CIV_DEFS.unitTree`（= `civs.json`）だけを見る。
 */
export function mainRoleThumbs(civ: CivId): RoleThumb[] {
  const def = civDefById(civ);
  const out: RoleThumb[] = [];
  for (const line of THUMB_LINES) {
    const tiers = def.unitTree[line] ?? [];
    let unitId: string | null = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      const hit = tierUnitId(tiers[i]);
      if (hit !== null) {
        unitId = hit;
        break;
      }
    }
    if (unitId === null) {
      out.push({ line, has: false, unitId: null, label: `${lineLabel(line)}を持たない` });
    } else {
      out.push({ line, has: true, unitId, label: unitDefById(unitId).name });
    }
  }
  return out;
}

/** 倍率 → 「+15%」「-15%」。 */
function pctText(mul: number): string {
  const d = Math.round((mul - 1) * 100);
  return d >= 0 ? `+${d}%` : `${d}%`;
}

/** 資源 ID → 表示名（`resources.json`）。 */
function resourceName(id: string): string {
  const rec = loadGameData().resources[id];
  if (rec !== null && typeof rec === 'object' && 'name' in rec) {
    return String((rec as Record<string, unknown>)['name']);
  }
  return id;
}

/** 建物 ID → 表示名（建物でなければ ID をそのまま返す。森・鉱脈などの採集元）。 */
function placeName(id: string): string {
  try {
    return buildingDefById(id).name;
  } catch {
    return id;
  }
}

/** `econBonus` の 1 件を日本語 1 句にする。未知の type は type 名をそのまま出す。 */
function bonusPhrase(b: Record<string, unknown>): string {
  const type = String(b['type']);
  const mul = typeof b['mul'] === 'number' ? b['mul'] : 1;
  const lines = Array.isArray(b['lines']) ? (b['lines'] as string[]).map(lineLabel).join('・') : '';
  switch (type) {
    case 'gatherRateMul': {
      const from = typeof b['from'] === 'string' ? `（${placeName(b['from'])}）` : '';
      return `${resourceName(String(b['resource']))}の採集 ${pctText(mul)}${from}`;
    }
    case 'buildCostMul':
      return `${placeName(String(b['building']))}の建設費 ${pctText(mul)}`;
    case 'buildSpeedMul':
      return `建設速度 ${pctText(mul)}`;
    case 'unitCostMul':
      return `${lines}の生産費 ${pctText(mul)}`;
    case 'produceSpeedMul':
      return `${lines}の生産速度 ${pctText(mul)}`;
    case 'startResourceAdd': {
      const parts: string[] = [];
      for (const key of ['food', 'wood', 'stone', 'gold']) {
        const v = b[key];
        if (typeof v === 'number' && v !== 0) parts.push(`${resourceName(key)} +${v}`);
      }
      return `開始資源 ${parts.join(' / ')}`;
    }
    default:
      return type;
  }
}

/**
 * 内政ボーナス 1 行（`05§4-6`）。
 * `econBonus` が空（唐）の場合は「内政ボーナスなし」と明示する
 * （空欄だと「読み込み失敗」と見分けが付かない）。
 */
export function civEconBonusText(civ: CivId): string {
  const list = civDefById(civ).econBonus;
  if (list.length === 0) return '内政ボーナスなし';
  return list.map((b) => bonusPhrase(b)).join(' / ');
}

/** 固有令 1 枚の表示情報（`05§4-6`。中身は `orders.json`）。 */
export interface UniqueOrderInfo {
  readonly id: string;
  readonly name: string;
  /** 上段（配置の方針）/ 下段（攻撃目標の方針）。`07§4`。 */
  readonly tierLabel: string;
  /** 隊形。 */
  readonly formation: string;
  /** キー（`Shift`+7）。 */
  readonly key: number;
}

/** 文明の固有令。 */
export function civUniqueOrder(civ: CivId): UniqueOrderInfo {
  const def = orderDefById(civDefById(civ).uniqueOrder);
  return {
    id: def.id,
    name: def.name,
    tierLabel: def.tier === 'upper' ? '上段' : '下段',
    formation: def.formation,
    key: def.key,
  };
}

/** 文明のエリートユニット名（総大将パネルの補足）。 */
export function civEliteName(civ: CivId): string {
  return unitDefById(civDefById(civ).eliteUnit).name;
}

/**
 * ランダム枠を実際の文明に決める（`05§4-3`）。
 *
 * **決定論**: 同じ `seed` からは必ず同じ文明。試合開始時に seed から解決すれば
 * リプレイでも同じ組み合わせが再現できる（`sim` の Rng は試合開始後の乱数なので、
 * ここは試合前の設定値として seed から素直に導く）。
 */
export function pickRandomCiv(seed: number): CivId {
  // 32bit 整数へ潰してから剰余（負数・小数でも安定させる）
  const n = Math.abs(Math.trunc(seed)) % CIV_IDS.length;
  return CIV_IDS[n]!;
}

/** 紋章枠 → 実際の文明（ランダム枠だけ `pickRandomCiv`）。 */
export function resolveCivSlot(slot: CivSlotId, seed: number): CivId {
  return slot === RANDOM_CIV ? pickRandomCiv(seed) : slot;
}

/** 文明選択の結果を保存するキー（タイトルのロゴ紋章もこれを読む）。 */
export const LAST_CIV_KEY = 'mt.lastCiv';

// ---------------------------------------------------------------- 画面

/** `params` の読み取り（文字列 / 数値だけ）。 */
function paramStr(params: ScreenParams, key: string): string | null {
  const v = params[key];
  return typeof v === 'string' ? v : null;
}
function paramNum(params: ScreenParams, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 文明選択画面。`{ slot?: number, civ?: CivSlotId }` を受ける。 */
export const civSelectScreen: Screen = {
  mount(root, nav, params) {
    const slotIndex = Math.max(0, Math.trunc(paramNum(params, 'slot', 0)));
    const initial = paramStr(params, 'civ');
    let current: CivSlotId = CIV_GRID.includes(initial as CivSlotId)
      ? (initial as CivSlotId)
      : 'yamato';

    const scr = el('div', 'mt-scr mt-scr-civ');

    // ---- ヘッダ（規約: 最小限。1 行だけ）----
    const head = el('header', 'mt-scr-head');
    head.appendChild(el('h1', 'mt-scr-title', '文明選択'));
    head.appendChild(
      el('p', 'mt-scr-sub', `参加者スロット ${slotIndex + 1} ― 固有ユニット・内政ボーナス・固有令の 3 点セット`),
    );
    scr.appendChild(head);

    const body = el('div', 'mt-scr-body mt-civ-body');
    scr.appendChild(body);

    // ---- 1,2,3 紋章グリッド 9 枠 ----
    const grid = el('div', 'mt-civ-grid');
    const cells = new Map<CivSlotId, HTMLButtonElement>();
    for (const slot of CIV_GRID) {
      const cell = button('mt-civ-cell', '', () => {
        current = slot;
        sync();
      });
      cell.textContent = '';
      cell.appendChild(emblemEl(slot, 52));
      cell.appendChild(el('span', 'mt-civ-cell-name', civLabel(slot)));
      cells.set(slot, cell);
      grid.appendChild(cell);
    }
    body.appendChild(grid);

    // ---- 4,5,6 右側（選択に追従して差し替わる）----
    const detail = el('div', 'mt-civ-detail');
    body.appendChild(detail);

    // ---- 下端の操作 ----
    const foot = el('footer', 'mt-scr-foot');
    foot.appendChild(
      button('mt-btn', '戻る', () => {
        nav.go('matchSetup', { slot: slotIndex });
      }),
    );
    const decide = button('mt-btn mt-btn-primary', '決定', () => {
      // 決めた文明はここで保存する（タイトルのロゴ紋章が次回これを読む。`05§2-1`）
      const resolved = resolveCivSlot(current, paramNum(params, 'seed', 0) + slotIndex);
      try {
        localStorage.setItem(LAST_CIV_KEY, resolved);
      } catch {
        // プライベートモード等で保存できなくても画面は続行する
      }
      nav.go('matchSetup', { slot: slotIndex, pickedCiv: current });
    });
    foot.appendChild(decide);
    scr.appendChild(foot);

    /** 選択状態を DOM に反映する。 */
    function sync(): void {
      for (const [slot, cell] of cells) {
        // 選択中は金枠で光る（`05§4-2` / `05§15`「金の縁」）
        cell.classList.toggle('is-selected', slot === current);
        cell.setAttribute('aria-pressed', slot === current ? 'true' : 'false');
      }
      detail.textContent = '';
      detail.appendChild(buildDetail(current));
    }

    sync();
    root.appendChild(scr);
  },
};

/** 右側（総大将 + 主力兵 + ボーナスと固有令）。 */
function buildDetail(slot: CivSlotId): HTMLElement {
  const wrap = el('div', 'mt-civ-detail-inner');

  if (slot === RANDOM_CIV) {
    // ランダム枠は中身を見せない（`05§4-3` 相手に読ませないための枠）
    const box = el('div', 'mt-civ-random');
    box.appendChild(el('div', 'mt-civ-random-mark', '？'));
    box.appendChild(
      el('p', 'mt-civ-random-note', '試合開始時に無作為で決まります。相手に読ませないための枠です。'),
    );
    wrap.appendChild(box);
    return wrap;
  }

  const civ = slot;

  // ---- 4 総大将（アセットは M17。今は紋章色の枠 + 名前）----
  const general = el('div', 'mt-civ-general');
  const portraitSrc = CIV_ASSETS.portrait(civ);
  const stage = el('div', 'mt-portrait');
  if (portraitSrc !== null) {
    const img = el('img', 'mt-portrait-img');
    img.src = portraitSrc;
    img.alt = `${civLabel(civ)}の総大将`;
    stage.appendChild(img);
  } else {
    stage.appendChild(el('div', 'mt-portrait-ph', civInitial(civ)));
    stage.appendChild(el('div', 'mt-portrait-ph-note', '立ち絵は M17'));
  }
  general.appendChild(stage);
  const gname = el('div', 'mt-civ-general-name');
  gname.appendChild(emblemEl(civ, 34));
  gname.appendChild(el('span', '', `${civLabel(civ)}の総大将`));
  general.appendChild(gname);
  general.appendChild(el('p', 'mt-civ-elite', `城のエリート: ${civEliteName(civ)}`));
  wrap.appendChild(general);

  const info = el('div', 'mt-civ-info');

  // ---- 5 主力兵サムネイル（持たない役割は暗い枠）----
  const thumbs = el('div', 'mt-civ-thumbs');
  for (const t of mainRoleThumbs(civ)) {
    const cell = el('div', `mt-civ-thumb${t.has ? '' : ' is-off'}`);
    const pic = el('div', 'mt-civ-thumb-pic');
    const src = t.unitId === null ? null : CIV_ASSETS.unit(t.unitId);
    if (src !== null) {
      const img = el('img', 'mt-civ-thumb-img');
      img.src = src;
      img.alt = t.label;
      pic.appendChild(img);
    } else {
      pic.appendChild(el('span', 'mt-civ-thumb-ph', t.has ? lineLabel(t.line) : '✕'));
    }
    cell.appendChild(pic);
    cell.appendChild(el('span', 'mt-civ-thumb-role', lineLabel(t.line)));
    cell.appendChild(el('span', 'mt-civ-thumb-name', t.label));
    if (!t.has) cell.title = `${civLabel(civ)}は${lineLabel(t.line)}を持ちません（この枠は永久に暗い）`;
    thumbs.appendChild(cell);
  }
  info.appendChild(thumbs);

  // ---- 6 ボーナスと固有令 ----
  const bonus = el('div', 'mt-civ-bonus');
  bonus.appendChild(el('h2', 'mt-civ-h', '内政ボーナス'));
  bonus.appendChild(el('p', 'mt-civ-bonus-text', civEconBonusText(civ)));
  info.appendChild(bonus);

  const order = civUniqueOrder(civ);
  const card = el('div', 'mt-order-card');
  card.appendChild(el('span', 'mt-order-card-key', `Shift+${order.key}`));
  card.appendChild(el('span', 'mt-order-card-name', order.name));
  card.appendChild(el('span', 'mt-order-card-meta', `固有令 / ${order.tierLabel} / 隊形 ${order.formation}`));
  const orderBox = el('div', 'mt-civ-order');
  orderBox.appendChild(el('h2', 'mt-civ-h', '固有令'));
  orderBox.appendChild(card);
  info.appendChild(orderBox);

  wrap.appendChild(info);
  return wrap;
}
