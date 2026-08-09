/**
 * ui/screens/Settings.ts — 設定画面（T-M12-14。`06§12` の 6 項目 / 手順書 §9.2）
 *
 * **アクセシビリティは実装要件であって任意ではない**（手順書 §9.2）。6 項目:
 *   1 キーの再割り当て（**全キー変更可**）。プリセット 4 種:
 *     標準 / WASD 移動 / 左手だけ / 他社 RTS 互換。
 *     **設定は URL に紐づかず端末に保存**（`localStorage`）
 *   2 長押しを使わない設定: `Tab` の「のぞき見」と `Alt` の情報表示をトグルに変更できる
 *   3 片手・マウスのみ（**キーボードを一切使わずに 6 戦線を運用できることが設計要件**）
 *   4 色以外の手がかり（戦域 = 色 + **旗の形と番号** / 警告 = 点滅 + 音 + 縁のバッジ）
 *   5 速度 0.5〜1.5 倍（**遅くしても難易度は上がらない = AI も同じ速度**）
 *   6 操作量の目安（1 試合 約 30 分で**毎分 20〜40 操作**。他の RTS の 1/3 程度）
 *
 * ■ 保存の形（申し送りの要点）
 *   `localStorage` に **プリセット名 + 既定との差分だけ**を入れる。
 *   全 60 キーを丸ごと保存すると、あとでプリセットの既定を直したときに
 *   「昔の既定が焼き付いた設定」が残る。差分保存なら既定の変更が自動で流れる。
 *
 * ■ この画面は sim を触らない。速度もここでは値を持つだけで、
 *   実際の適用は `matchOptions.gameSpeed`（`07§14`。**tick レートは変えない**）。
 */

import '@/styles/result.css';

import { FRONT_COLORS, FRONT_SHAPES } from '@/render/palette';
import { el, button, type Screen, type ScreenNav, type ScreenParams } from './router';

// ---------------------------------------------------------------------------
// 1. キー割り当て
// ---------------------------------------------------------------------------

/** キー割り当てのプリセット（`06§12` の 4 種）。 */
export type PresetId = 'standard' | 'wasd' | 'oneHand' | 'rtsCompat';

/** プリセットの並びと表示名。 */
export const PRESETS: readonly { readonly id: PresetId; readonly name: string }[] = [
  { id: 'standard', name: '標準' },
  { id: 'wasd', name: 'WASD 移動' },
  { id: 'oneHand', name: '左手だけ' },
  { id: 'rtsCompat', name: '他社 RTS 互換' },
];

export const PRESET_IDS: readonly PresetId[] = PRESETS.map((p) => p.id);

/** 操作の分類（`06§14` の「分類」列）。 */
export type ActionCategory = '戦域' | '令' | 'コマンド' | '選択' | '視点' | '情報' | 'パネル' | 'システム';

/** 再割り当てできる操作 1 件。 */
export interface KeyAction {
  readonly id: string;
  readonly category: ActionCategory;
  readonly label: string;
  /** 標準プリセットの割り当て（`Modifier+Code` 形式）。 */
  readonly standard: string;
  /**
   * 修飾キーを足した派生（`06§14`「`Ctrl`+同キーで記憶」など）。
   * **基のキーに追従する**ので、再割り当てすると派生も一緒に動く。
   */
  readonly derived?: readonly { readonly mods: string; readonly label: string }[];
}

/** コマンドグリッドの 12 キー（`05§9`。**並びが一対一**なので順序を崩さない）。 */
const GRID_CODES: readonly string[] = [
  'KeyQ',
  'KeyW',
  'KeyE',
  'KeyR',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
];

/** 全操作（`06§14` の全キー一覧）。**ここが「全キー変更可」の定義**。 */
export const KEY_ACTIONS: readonly KeyAction[] = buildKeyActions();

function buildKeyActions(): KeyAction[] {
  const a: KeyAction[] = [];

  // ---- 戦域 ----
  a.push({ id: 'overview', category: '戦域', label: '戦域指令ビューの開閉', standard: 'Tab' });
  for (let i = 1; i <= 6; i++) {
    a.push({
      id: `front${i}`,
      category: '戦域',
      label: `戦域 ${i} を選択して視点移動`,
      standard: `Digit${i}`,
      derived: [{ mods: 'Alt', label: '視点を動かさず選択' }],
    });
  }
  a.push({ id: 'nextWarning', category: '戦域', label: '次の警告へジャンプ', standard: 'Space' });

  // ---- 令 ----
  const ORDER_LABELS = ['突撃', '包囲', '死守', '略奪', '建設', '後退'];
  for (let i = 1; i <= 6; i++) {
    a.push({
      id: `order${i}`,
      category: '令',
      label: `令をセット（${ORDER_LABELS[i - 1]}）`,
      standard: `Shift+Digit${i}`,
    });
  }
  a.push({ id: 'orderUnique', category: '令', label: '文明固有の令', standard: 'Shift+Digit7' });
  a.push({
    id: 'escape',
    category: '令',
    label: 'パネルを閉じる / 手動を令に戻す / 選択解除',
    standard: 'Escape',
  });

  // ---- コマンド ----
  for (let i = 0; i < GRID_CODES.length; i++) {
    a.push({
      id: `grid${i + 1}`,
      category: 'コマンド',
      label: `コマンドグリッド ${i + 1}`,
      standard: GRID_CODES[i]!,
    });
  }
  a.push({ id: 'buildMenu', category: 'コマンド', label: '建設メニュー', standard: 'KeyB' });

  // ---- 選択 ----
  a.push({
    id: 'selectAllCombat',
    category: '選択',
    label: '戦域外の全戦闘ユニット',
    standard: 'Ctrl+KeyA',
    derived: [{ mods: 'Ctrl+Shift', label: '戦域の兵も含める' }],
  });
  const GROUP_CODES = ['Digit7', 'Digit8', 'Digit9', 'Digit0'];
  for (let i = 0; i < GROUP_CODES.length; i++) {
    a.push({
      id: `group${i + 1}`,
      category: '選択',
      label: `部隊グループ ${i + 1} の呼び出し`,
      standard: GROUP_CODES[i]!,
      derived: [
        { mods: 'Ctrl', label: '登録' },
        { mods: 'Ctrl+Shift', label: '追加' },
      ],
    });
  }
  a.push({ id: 'idleNext', category: '選択', label: '遊休の村人へ次', standard: 'Period' });
  a.push({ id: 'idlePrev', category: '選択', label: '遊休の村人へ前', standard: 'Comma' });

  // ---- 視点 ----
  a.push({ id: 'home', category: '視点', label: '町の中心へ', standard: 'KeyH' });
  a.push({ id: 'minimap', category: '視点', label: 'ミニマップの拡大', standard: 'KeyM' });
  for (let i = 1; i <= 4; i++) {
    a.push({
      id: `view${i}`,
      category: '視点',
      label: `視点 ${i} の呼び出し`,
      standard: `F${i}`,
      derived: [{ mods: 'Ctrl', label: '記憶' }],
    });
  }
  a.push({ id: 'lastView', category: '視点', label: '直前の視点へ', standard: 'Backspace' });
  a.push({ id: 'scrollUp', category: '視点', label: 'スクロール（上）', standard: 'ArrowUp' });
  a.push({ id: 'scrollDown', category: '視点', label: 'スクロール（下）', standard: 'ArrowDown' });
  a.push({ id: 'scrollLeft', category: '視点', label: 'スクロール（左）', standard: 'ArrowLeft' });
  a.push({ id: 'scrollRight', category: '視点', label: 'スクロール（右）', standard: 'ArrowRight' });

  // ---- 情報 ----
  a.push({
    id: 'allInfo',
    category: '情報',
    label: '全ユニットの体力バーと戦域色（長押し）',
    standard: 'Alt',
  });
  a.push({ id: 'score', category: '情報', label: '戦績パネル', standard: 'KeyL' });
  a.push({ id: 'remaining', category: '情報', label: '資源の残量', standard: 'KeyG' });
  a.push({ id: 'ageCond', category: '情報', label: '時代進化の条件', standard: 'KeyN' });
  a.push({ id: 'orderHistory', category: '情報', label: '令の履歴', standard: 'KeyY' });

  // ---- パネル ----
  a.push({ id: 'techTree', category: 'パネル', label: '学舎（研究）', standard: 'KeyK' });
  a.push({ id: 'market', category: 'パネル', label: '市場（資源交換・交易）', standard: 'KeyT' });

  // ---- システム ----
  a.push({ id: 'menu', category: 'システム', label: 'メニュー', standard: 'F10' });
  a.push({ id: 'fullscreen', category: 'システム', label: '全画面', standard: 'F11' });
  a.push({ id: 'screenshot', category: 'システム', label: 'スクリーンショット', standard: 'F12' });
  a.push({ id: 'chatAll', category: 'システム', label: '全体チャット', standard: 'Enter' });
  a.push({ id: 'chatTeam', category: 'システム', label: '味方チャット', standard: 'Shift+Enter' });
  a.push({ id: 'pause', category: 'システム', label: '一時停止（オンラインを除く）', standard: 'Pause' });

  return a;
}

/** 割り当て表（actionId → `Modifier+Code`）。 */
export type Bindings = Readonly<Record<string, string>>;

/** 標準プリセット。 */
function standardBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of KEY_ACTIONS) out[a.id] = a.standard;
  return out;
}

/**
 * WASD 移動プリセット。
 * スクロールを `WASD` に移し、**ぶつかるコマンドグリッドをテンキーへ**動かす
 * （グリッドは 3 段 12 個の並びが意味を持つので、`05§9` の形を保てるテンキーに置く）。
 */
function wasdOverrides(): Record<string, string> {
  const grid = [
    'Numpad7',
    'Numpad8',
    'Numpad9',
    'NumpadDivide',
    'Numpad4',
    'Numpad5',
    'Numpad6',
    'NumpadMultiply',
    'Numpad1',
    'Numpad2',
    'Numpad3',
    'NumpadSubtract',
  ];
  const out: Record<string, string> = {
    scrollUp: 'KeyW',
    scrollLeft: 'KeyA',
    scrollDown: 'KeyS',
    scrollRight: 'KeyD',
  };
  for (let i = 0; i < grid.length; i++) out[`grid${i + 1}`] = grid[i]!;
  return out;
}

/**
 * 「左手だけ」プリセットで使える割り当ての候補（**左手の届く範囲だけ**）。
 * 修飾キーの層を重ねて数を稼ぐ。並びは固定（生成結果が毎回同じになるため）。
 */
const LEFT_HAND_POOL: readonly string[] = buildLeftHandPool();

function buildLeftHandPool(): string[] {
  const base = [
    'KeyQ',
    'KeyW',
    'KeyE',
    'KeyR',
    'KeyT',
    'KeyA',
    'KeyS',
    'KeyD',
    'KeyF',
    'KeyG',
    'KeyZ',
    'KeyX',
    'KeyC',
    'KeyV',
    'KeyB',
  ];
  // 数字キーは入れない。`Alt`+`1`〜`6` は「視点を動かさず戦域を選択」の派生に予約されている
  // （`06§14`）ので、ここに割り当てると派生と衝突する。
  const out: string[] = [];
  for (const mods of ['Alt', 'Ctrl', 'Ctrl+Alt', 'Ctrl+Shift']) {
    for (const b of base) out.push(`${mods}+${b}`);
  }
  return out;
}

/** 右手側のキー（左手だけプリセットで置き換える対象）。 */
function isRightHandCombo(combo: string): boolean {
  const code = combo.split('+').pop() ?? '';
  if (code.startsWith('Arrow')) return true;
  if (code.startsWith('Numpad')) return true;
  if (/^F\d+$/.test(code)) return true;
  if (['Backspace', 'Enter', 'Pause', 'Period', 'Comma', 'Semicolon', 'Slash'].includes(code)) {
    return true;
  }
  if (['Digit7', 'Digit8', 'Digit9', 'Digit0'].includes(code)) return true;
  // 右手側の文字キー（左手は Q W E R T / A S D F G / Z X C V B）
  if (/^Key[H-P]$/.test(code)) return true;
  if (code === 'KeyU' || code === 'KeyY') return true;
  return false;
}

/**
 * 「左手だけ」プリセット。
 *
 * 標準から出発し、**右手側のキーに載っている操作だけ**を左手の候補へ順に移す。
 * 生成にするのは、手で 60 行書くと必ず衝突が混じるから
 * （衝突しないことをテストで保証したいので、構造的に衝突しない作り方を選んだ）。
 */
function oneHandOverrides(): Record<string, string> {
  const out: Record<string, string> = {
    // スクロールは真っ先に固定する（毎試合いちばん使うので、位置が変わると困る）。
    scrollUp: 'Alt+KeyW',
    scrollLeft: 'Alt+KeyA',
    scrollDown: 'Alt+KeyS',
    scrollRight: 'Alt+KeyD',
  };
  const used = new Set<string>();
  for (const a of KEY_ACTIONS) {
    const combo = out[a.id] ?? a.standard;
    if (!isRightHandCombo(combo)) used.add(combo);
  }
  for (const v of Object.values(out)) used.add(v);

  let cursor = 0;
  for (const a of KEY_ACTIONS) {
    if (out[a.id] !== undefined) continue;
    if (!isRightHandCombo(a.standard)) continue;
    while (cursor < LEFT_HAND_POOL.length && used.has(LEFT_HAND_POOL[cursor]!)) cursor++;
    const pick = LEFT_HAND_POOL[cursor];
    if (pick === undefined) break; // 候補が尽きたら標準のまま（衝突は作らない）
    out[a.id] = pick;
    used.add(pick);
    cursor++;
  }
  return out;
}

/**
 * 他社 RTS 互換プリセット。
 * 「数字キーは部隊グループ」という他社 RTS の常識に合わせ、
 * **戦域と令をテンキー側へ**移す（このゲームの中核は戦域なので、
 * 慣れたキーに部隊グループを置いた方が乗り換えが楽という判断）。
 */
function rtsCompatOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= 4; i++) out[`group${i}`] = `Digit${i}`;
  for (let i = 1; i <= 6; i++) out[`front${i}`] = `Numpad${i}`;
  for (let i = 1; i <= 6; i++) out[`order${i}`] = `Shift+Numpad${i}`;
  out['orderUnique'] = 'Shift+Numpad7';
  return out;
}

/** プリセットの割り当て（完全な表）。 */
export function presetBindings(preset: PresetId): Bindings {
  const base = standardBindings();
  const over =
    preset === 'wasd'
      ? wasdOverrides()
      : preset === 'oneHand'
        ? oneHandOverrides()
        : preset === 'rtsCompat'
          ? rtsCompatOverrides()
          : {};
  return { ...base, ...over };
}

/** 割り当ての衝突 1 件。 */
export interface BindingConflict {
  readonly combo: string;
  /** 同じキーに割り当てられている操作 ID（**入力順ではなく `KEY_ACTIONS` 順**）。 */
  readonly actions: readonly string[];
}

/**
 * 同じキーに 2 つ以上の操作が載っていないか調べる。
 *
 * 修飾キーが違えば別のキー扱い（`KeyA` と `Ctrl+KeyA` は衝突しない）。
 * これは `06§14` の並び（`Ctrl`+`A` と `A` が別の意味を持つ）と一致する。
 */
export function findConflicts(bindings: Bindings): BindingConflict[] {
  const byCombo: { combo: string; actions: string[] }[] = [];
  for (const a of KEY_ACTIONS) {
    const combo = bindings[a.id];
    if (combo === undefined || combo === '') continue;
    const hit = byCombo.find((x) => x.combo === combo);
    if (hit === undefined) byCombo.push({ combo, actions: [a.id] });
    else hit.actions.push(a.id);
  }
  return byCombo.filter((x) => x.actions.length > 1);
}

/** 表示用のキー名（`Shift+Digit1` → `Shift+1`）。 */
export function comboLabel(combo: string): string {
  if (combo === '') return '未割り当て';
  const parts = combo.split('+');
  const code = parts.pop() ?? '';
  const mods = parts.join('+');
  const name = codeLabel(code);
  return mods === '' ? name : `${mods}+${name}`;
}

function codeLabel(code: string): string {
  const digit = /^Digit(\d)$/.exec(code);
  if (digit !== null) return digit[1]!;
  const key = /^Key([A-Z])$/.exec(code);
  if (key !== null) return key[1]!;
  const npd = /^Numpad(\d)$/.exec(code);
  if (npd !== null) return `テンキー${npd[1]!}`;
  switch (code) {
    case 'Space':
      return 'Space';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Period':
      return '.';
    case 'Comma':
      return ',';
    case 'NumpadDivide':
      return 'テンキー/';
    case 'NumpadMultiply':
      return 'テンキー*';
    case 'NumpadSubtract':
      return 'テンキー-';
    default:
      return code;
  }
}

/** キー入力の記述（`KeyboardEvent` の必要な部分だけ）。 */
export interface KeyEventLike {
  readonly code: string;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * キー入力 → `Modifier+Code`。再割り当ての「キーを押して登録」で使う。
 * 修飾キー単独（`Alt` だけ）も割り当てられる（`Alt` の情報表示があるため）。
 */
export function comboFromEvent(ev: KeyEventLike): string {
  const code = ev.code;
  if (code === 'AltLeft' || code === 'AltRight' || ev.key === 'Alt') return 'Alt';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'ControlLeft' || code === 'ControlRight' || code === 'MetaLeft' || code === 'MetaRight') {
    return 'Ctrl';
  }
  const mods: string[] = [];
  if (ev.ctrlKey || ev.metaKey) mods.push('Ctrl');
  if (ev.shiftKey) mods.push('Shift');
  if (ev.altKey) mods.push('Alt');
  return [...mods, code].join('+');
}

// ---------------------------------------------------------------------------
// 設定の値と保存
// ---------------------------------------------------------------------------

/** `localStorage` のキー。**URL には載せない**（`06§12`「端末に保存」）。 */
export const SETTINGS_STORAGE_KEY = 'multi-taktika.settings.v1';

/** 保存形式のバージョン（形を変えたら上げる）。 */
export const SETTINGS_VERSION = 1;

/** ゲーム速度の範囲（`07§14` / `config.matchOptions.gameSpeed`）。 */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;
export const SPEED_STEP = 0.1;

/** 端末に保存する設定。 */
export interface GameSettings {
  readonly version: number;
  readonly preset: PresetId;
  /** **既定との差分だけ**（actionId → combo）。 */
  readonly keys: Readonly<Record<string, string>>;
  /** `Tab` の「のぞき見」をトグルにする。 */
  readonly peekToggle: boolean;
  /** `Alt` の情報表示をトグルにする。 */
  readonly altInfoToggle: boolean;
  /** ゲーム速度（0.5〜1.5。**AI も同じ速度**なので難易度は変わらない）。 */
  readonly gameSpeed: number;
  /** 色以外の手がかりを強める（旗の形と番号を常に出す）。 */
  readonly shapeCues: boolean;
  /** 警告音を鳴らす（警告は点滅 + 音 + 縁のバッジの 3 重）。 */
  readonly warningSound: boolean;
  /** 画面端スクロール（マウスのみ運用のときに要る）。 */
  readonly edgeScroll: boolean;
}

/** 既定の設定。 */
export function defaultSettings(): GameSettings {
  return {
    version: SETTINGS_VERSION,
    preset: 'standard',
    keys: {},
    peekToggle: false,
    altInfoToggle: false,
    gameSpeed: 1.0,
    shapeCues: true,
    warningSound: true,
    edgeScroll: true,
  };
}

/** 速度を範囲に丸め、刻み幅に合わせる。 */
export function clampGameSpeed(v: number): number {
  if (!Number.isFinite(v)) return 1.0;
  const stepped = Math.round(v / SPEED_STEP) * SPEED_STEP;
  const clamped = stepped < SPEED_MIN ? SPEED_MIN : stepped > SPEED_MAX ? SPEED_MAX : stepped;
  // 0.1 刻みの浮動小数誤差を落とす（表示が 0.7000000000000001 にならないように）。
  return Math.round(clamped * 10) / 10;
}

/**
 * 保存されていた値を今の形に直す。
 *
 * **知らない値は捨てて既定に戻す**（壊れた設定で操作不能になるより、
 * 既定に戻って遊べる方がよい）。バージョンが違うときはキー割り当てだけ捨てる。
 */
export function normalizeSettings(raw: unknown): GameSettings {
  const d = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return d;
  const o = raw as Record<string, unknown>;
  const preset = PRESET_IDS.includes(o['preset'] as PresetId) ? (o['preset'] as PresetId) : d.preset;
  const versionOk = o['version'] === SETTINGS_VERSION;

  const keys: Record<string, string> = {};
  if (versionOk && typeof o['keys'] === 'object' && o['keys'] !== null) {
    const src = o['keys'] as Record<string, unknown>;
    // 知っている操作 ID だけ拾う（消えた操作の割り当てを持ち越さない）。
    for (const a of KEY_ACTIONS) {
      const v = src[a.id];
      if (typeof v === 'string' && v !== '') keys[a.id] = v;
    }
  }

  const bool = (k: string, def: boolean): boolean =>
    typeof o[k] === 'boolean' ? (o[k] as boolean) : def;

  return {
    version: SETTINGS_VERSION,
    preset,
    keys,
    peekToggle: bool('peekToggle', d.peekToggle),
    altInfoToggle: bool('altInfoToggle', d.altInfoToggle),
    gameSpeed: clampGameSpeed(typeof o['gameSpeed'] === 'number' ? o['gameSpeed'] : d.gameSpeed),
    shapeCues: bool('shapeCues', d.shapeCues),
    warningSound: bool('warningSound', d.warningSound),
    edgeScroll: bool('edgeScroll', d.edgeScroll),
  };
}

/** 実効の割り当て（プリセット + 差分）。 */
export function resolveBindings(s: GameSettings): Bindings {
  return { ...presetBindings(s.preset), ...s.keys };
}

/**
 * 差分に 1 件足す。**プリセットの既定と同じ値なら差分から消す**
 * （差分が既定で埋まると、プリセットを直したときに古い値が残る）。
 */
export function withBinding(s: GameSettings, actionId: string, combo: string): GameSettings {
  const base = presetBindings(s.preset);
  const keys: Record<string, string> = { ...s.keys };
  if (base[actionId] === combo) delete keys[actionId];
  else keys[actionId] = combo;
  return { ...s, keys };
}

/** `localStorage` 互換の最小インタフェース（テストから差し替えられるように）。 */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): SettingsStorage | null {
  try {
    const g = globalThis as { localStorage?: SettingsStorage };
    return g.localStorage ?? null;
  } catch {
    // プライベートモードなどで例外になる環境がある。設定が保存できないだけで遊べる。
    return null;
  }
}

/** 端末から読む（無ければ既定）。 */
export function loadSettings(storage: SettingsStorage | null = defaultStorage()): GameSettings {
  if (storage === null) return defaultSettings();
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return defaultSettings();
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

/** 端末へ書く（保存できなくても例外を投げない）。 */
export function saveSettings(
  s: GameSettings,
  storage: SettingsStorage | null = defaultStorage(),
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. 片手・マウスのみ / 4. 色以外の手がかり / 6. 操作量の目安
// ---------------------------------------------------------------------------

/**
 * 「マウスのみで完結する」ことの確認手段（`06§12`-3 / `05§8.1`）。
 *
 * **キーボードを一切使わずに 6 戦線を運用できることが設計要件**なので、
 * 設定画面で「どこを押せば代わりになるか」を並べて自分で確かめられるようにする。
 */
export const MOUSE_ONLY_CHECKS: readonly { readonly key: string; readonly mouse: string }[] = [
  { key: '1〜6（戦域を選ぶ）', mouse: '右端の戦域スロットをクリック' },
  { key: 'Shift+1〜6（令をセット）', mouse: '令カードをクリック' },
  { key: 'Tab（俯瞰）', mouse: '戦域スロット列の一番上の俯瞰ボタン' },
  { key: 'Space（次の警告へ）', mouse: '画面の縁の赤いバッジをクリック' },
  { key: 'Esc（パネルを閉じる）', mouse: 'パネルの外側をクリック' },
  { key: 'QWER/ASDF/ZXCV', mouse: '下端のコマンドグリッドをクリック' },
  { key: 'H（町の中心へ）', mouse: 'ミニマップの自分の拠点をクリック' },
  { key: '矢印キー（スクロール）', mouse: '画面端スクロール / ミニマップのドラッグ' },
];

/** 色以外の手がかり（`06§12`-4）。 */
export const COLOR_FREE_CUES: readonly string[] = [
  '戦域は 色 + 旗の形 + 番号 の 3 つで示す（色だけに頼らない）',
  '警告は 点滅 + 音 + 画面の縁のバッジ の 3 重',
  '暗いボタンは 理由の文字（時代不足 / 資源不足 / その文明が持てない）も出る',
  '令が届いていないことは 点線 → 実線 の形の変化で示す',
];

/** 操作量の目安（`06§12`-6）。 */
export const APM_GUIDE = {
  matchMinutes: 30,
  minApm: 20,
  maxApm: 40,
  note: '他の RTS の 1/3 程度で成立するよう調整しています。',
} as const;

/** 速度の説明（**遅くしても難易度は上がらない**ことを必ず書く）。 */
export const SPEED_NOTE = '遅くしても難易度は上がりません（AI も同じ速度になります）。';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/** 分類の並び（表示順）。 */
const CATEGORY_ORDER: readonly ActionCategory[] = [
  '戦域',
  '令',
  'コマンド',
  '選択',
  '視点',
  '情報',
  'パネル',
  'システム',
];

export const settingsScreen: Screen = {
  mount(root: HTMLElement, nav: ScreenNav, _params: ScreenParams): void {
    let settings = loadSettings();
    /** 今キー入力を待っている操作 ID（null = 待っていない）。 */
    let capturing: string | null = null;
    const keyButtons = new Map<string, HTMLButtonElement>();

    const screen = el('div', 'mt-screen');

    const head = el('div', 'mt-screen-head');
    head.appendChild(el('span', 'mt-screen-title', '設定'));
    head.appendChild(el('span', 'mt-screen-sub', '端末に保存されます（URL には含まれません）'));
    screen.appendChild(head);

    const body = el('div', 'mt-screen-body');
    screen.appendChild(body);

    const cols = el('div', 'mt-settings-cols');
    body.appendChild(cols);

    // ---------------- 1. キーの再割り当て ----------------
    const keyCard = el('div', 'mt-card');
    keyCard.appendChild(el('div', 'mt-card-title', 'キーの再割り当て（全キー変更可）'));

    const presetRow = el('div', 'mt-preset-row');
    const presetButtons = new Map<PresetId, HTMLButtonElement>();
    for (const p of PRESETS) {
      const b = button('mt-btn', p.name, () => {
        settings = { ...settings, preset: p.id, keys: {} };
        saveSettings(settings);
        refreshKeys();
      });
      presetButtons.set(p.id, b);
      presetRow.appendChild(b);
    }
    keyCard.appendChild(presetRow);

    const conflictLine = el('div', 'mt-dim');
    keyCard.appendChild(conflictLine);

    for (const cat of CATEGORY_ORDER) {
      const actions = KEY_ACTIONS.filter((a) => a.category === cat);
      if (actions.length === 0) continue;
      keyCard.appendChild(el('div', 'mt-info-title', cat));
      const grid = el('div', 'mt-keys');
      for (const a of actions) {
        const label = el('span', 'mt-key-label', a.label);
        if (a.derived !== undefined) {
          const extra = a.derived.map((d) => `${d.mods}+ = ${d.label}`).join(' / ');
          label.title = extra;
          label.appendChild(el('span', 'mt-dim', `（${extra}）`));
        }
        grid.appendChild(label);
        const b = el('button', 'mt-key-btn');
        b.type = 'button';
        b.addEventListener('click', () => {
          capturing = capturing === a.id ? null : a.id;
          refreshKeys();
        });
        keyButtons.set(a.id, b);
        grid.appendChild(b);
      }
      keyCard.appendChild(grid);
    }
    cols.appendChild(keyCard);

    // ---------------- 右列 ----------------
    const right = el('div');
    right.style.display = 'flex';
    right.style.flexDirection = 'column';
    right.style.gap = '16px';
    cols.appendChild(right);

    // 2. 長押しを使わない設定
    const holdCard = el('div', 'mt-card');
    holdCard.appendChild(el('div', 'mt-card-title', '長押しを使わない設定'));
    right.appendChild(holdCard);
    const addToggle = (
      parent: HTMLElement,
      labelText: string,
      note: string,
      get: () => boolean,
      set: (v: boolean) => void,
    ): void => {
      const row = el('label', 'mt-toggle-row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = get();
      box.addEventListener('change', () => {
        set(box.checked);
        saveSettings(settings);
      });
      row.appendChild(box);
      const text = el('span');
      text.appendChild(el('div', undefined, labelText));
      text.appendChild(el('div', 'mt-toggle-note', note));
      row.appendChild(text);
      parent.appendChild(row);
    };
    addToggle(
      holdCard,
      'Tab の「のぞき見」をトグルにする',
      '押している間だけ俯瞰する代わりに、押すたび開閉に変わります。',
      () => settings.peekToggle,
      (v) => {
        settings = { ...settings, peekToggle: v };
      },
    );
    addToggle(
      holdCard,
      'Alt の情報表示をトグルにする',
      'Alt を押し続けなくてよくなります。修飾キーとの兼任も無くなります。',
      () => settings.altInfoToggle,
      (v) => {
        settings = { ...settings, altInfoToggle: v };
      },
    );

    // 5. 速度
    const speedCard = el('div', 'mt-card');
    speedCard.appendChild(el('div', 'mt-card-title', 'ゲーム速度'));
    const speedRow = el('div', 'mt-speed-row');
    const range = el('input');
    range.type = 'range';
    range.min = String(SPEED_MIN);
    range.max = String(SPEED_MAX);
    range.step = String(SPEED_STEP);
    range.value = String(settings.gameSpeed);
    const speedValue = el('span', 'mt-num', `${settings.gameSpeed.toFixed(1)} 倍`);
    range.addEventListener('input', () => {
      settings = { ...settings, gameSpeed: clampGameSpeed(Number(range.value)) };
      speedValue.textContent = `${settings.gameSpeed.toFixed(1)} 倍`;
      saveSettings(settings);
    });
    speedRow.appendChild(range);
    speedRow.appendChild(speedValue);
    speedCard.appendChild(speedRow);
    speedCard.appendChild(el('div', 'mt-toggle-note', SPEED_NOTE));
    right.appendChild(speedCard);

    // 3. 片手・マウスのみ
    const mouseCard = el('div', 'mt-card');
    mouseCard.appendChild(el('div', 'mt-card-title', '片手・マウスのみで遊ぶ'));
    mouseCard.appendChild(
      el(
        'div',
        'mt-toggle-note',
        'キーボードを一切使わずに 6 戦線を運用できることが設計要件です。下の対応で確認できます。',
      ),
    );
    for (const c of MOUSE_ONLY_CHECKS) {
      const row = el('div', 'mt-info-row');
      row.appendChild(el('span', undefined, c.key));
      row.appendChild(el('span', 'mt-dim', c.mouse));
      mouseCard.appendChild(row);
    }
    addToggle(
      mouseCard,
      '画面端スクロールを使う',
      'マウスのみで遊ぶときは有効を推奨。無効にするとミニマップのドラッグで動かします。',
      () => settings.edgeScroll,
      (v) => {
        settings = { ...settings, edgeScroll: v };
      },
    );
    right.appendChild(mouseCard);

    // 4. 色以外の手がかり
    const cueCard = el('div', 'mt-card');
    cueCard.appendChild(el('div', 'mt-card-title', '色以外の手がかり'));
    const cueList = el('ul', 'mt-cue-list');
    for (const c of COLOR_FREE_CUES) cueList.appendChild(el('li', undefined, c));
    cueCard.appendChild(cueList);
    // 戦域 1〜6 の「色 + 形 + 番号」を実物で並べる（設定で確かめられるように）
    const flags = el('div', 'mt-flagset');
    for (let slot = 1; slot <= FRONT_SHAPES.length; slot++) {
      const f = el('span', 'mt-flag');
      const shape = el('span', undefined, FRONT_SHAPES[slot - 1] ?? '?');
      shape.style.color = FRONT_COLORS[slot - 1] ?? '#fff';
      f.appendChild(shape);
      f.appendChild(el('span', undefined, `戦域 ${slot}`));
      flags.appendChild(f);
    }
    cueCard.appendChild(flags);
    addToggle(
      cueCard,
      '旗の形と番号を常に表示する',
      '色の区別が付きにくいときに有効にします。',
      () => settings.shapeCues,
      (v) => {
        settings = { ...settings, shapeCues: v };
      },
    );
    addToggle(
      cueCard,
      '警告音を鳴らす',
      '警告は 点滅 + 音 + 縁のバッジ の 3 重で通知します。',
      () => settings.warningSound,
      (v) => {
        settings = { ...settings, warningSound: v };
      },
    );
    right.appendChild(cueCard);

    // 6. 操作量の目安
    const apmCard = el('div', 'mt-card');
    apmCard.appendChild(el('div', 'mt-card-title', '操作量の目安'));
    apmCard.appendChild(
      el(
        'div',
        undefined,
        `1 試合（約 ${APM_GUIDE.matchMinutes} 分）の想定操作量は 毎分 ${APM_GUIDE.minApm}〜${APM_GUIDE.maxApm} 操作。`,
      ),
    );
    apmCard.appendChild(el('div', 'mt-toggle-note', APM_GUIDE.note));
    right.appendChild(apmCard);

    // ---------------- 足元 ----------------
    const foot = el('div', 'mt-screen-foot');
    foot.appendChild(
      button('mt-btn', '標準に戻す', () => {
        settings = defaultSettings();
        saveSettings(settings);
        range.value = String(settings.gameSpeed);
        speedValue.textContent = `${settings.gameSpeed.toFixed(1)} 倍`;
        refreshKeys();
      }),
    );
    foot.appendChild(button('mt-btn is-primary', '戻る', () => nav.back()));
    screen.appendChild(foot);

    // ---------------- 更新 ----------------
    function refreshKeys(): void {
      const bindings = resolveBindings(settings);
      const conflicts = findConflicts(bindings);
      const conflicting = new Set<string>();
      for (const c of conflicts) for (const id of c.actions) conflicting.add(id);

      for (const [id, b] of keyButtons) {
        const combo = bindings[id] ?? '';
        b.textContent = capturing === id ? 'キーを押す…' : comboLabel(combo);
        const cls = ['mt-key-btn'];
        if (capturing === id) cls.push('is-capturing');
        if (conflicting.has(id)) cls.push('is-conflict');
        b.className = cls.join(' ');
        if (conflicting.has(id)) {
          // 色以外の手がかり（`06§12`）: 記号でも衝突を示す
          b.textContent = `⚠ ${b.textContent ?? ''}`;
        }
      }
      for (const [id, b] of presetButtons) {
        b.className = id === settings.preset ? 'mt-btn is-primary' : 'mt-btn';
      }
      conflictLine.textContent =
        conflicts.length === 0
          ? '衝突はありません。'
          : `⚠ ${conflicts.length} 件のキーが重複しています（⚠ 付きのボタン）。`;
    }

    // キー入力の取り込み（再割り当ての「キーを押して登録」）
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (capturing === null) return;
      ev.preventDefault();
      if (ev.key === 'Escape') {
        capturing = null;
        refreshKeys();
        return;
      }
      settings = withBinding(settings, capturing, comboFromEvent(ev));
      saveSettings(settings);
      capturing = null;
      refreshKeys();
    };
    window.addEventListener('keydown', onKeyDown);
    detach = (): void => window.removeEventListener('keydown', onKeyDown);

    refreshKeys();
    root.appendChild(screen);
  },

  unmount(): void {
    detach?.();
    detach = null;
  },
};

/** `mount` で張ったキーイベントを外す関数（`unmount` 用）。 */
let detach: (() => void) | null = null;
