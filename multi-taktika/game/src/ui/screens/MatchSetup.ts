/**
 * ui/screens/MatchSetup.ts — 対戦設定画面（`T-M12-10` / `05§3`）
 *
 * スカーミッシュとオンラインで共通の画面。`05§3` の 7 項目:
 *  1. マップ preview（地形の縮図。水域が広いほど港と船の価値が上がる）
 *  2. 開始位置（色付きの点。隣が誰かで序盤に立つ戦域の場所が決まる）
 *  3. 参加者スロット（名前・チーム色・紋章。**文明は重複可**）
 *  4. 種別アイコン（人型 = 人間 / 兜 = AI。AI は 5 段階）
 *  5. 空きスロット（「＋」で AI 追加、または参加待ち）
 *  6. 試合設定（開始時代・開始資源・ゲーム速度・人口上限）
 *  7. 準備完了（全員が押すと開始。押した人のスロットが金色）
 *
 * ■ マップ preview の作り方（**実際に `generateMap` を呼ぶ**）
 *   マップ生成は決定論（同じシード・同じ型・同じ人数なら同じ地形）なので、
 *   preview で出した地形と試合で出る地形が**同一である**ことを保証できる。
 *   模式図では「preview と実際の地形が違う」という最悪の嘘が入る。
 *   実測は 200×200 で 6〜18ms、400×400 で 22〜38ms（`tests/unit/ui.matchSetup.test.ts`
 *   と同条件で計測）。**設定を変えた瞬間だけ**生成し、結果をキャッシュするので
 *   毎フレームの負荷はゼロ。
 *
 * ■ URL 共有（通信は M14 = `T-M14-*`）
 *   `buildShareUrl` / `parseShareParams` で**URL の形だけ**用意した。
 *   M14 で `roomId` をリレーサーバの部屋 ID として使い、スロットの更新を
 *   ロックステップの前段（部屋の状態同期）で流せば結線できる。**申し送り参照**。
 *
 * ■ 層（手順書 §3.1）
 *   sim は読むだけ。試合の開始は `nav.go('match', toMatchParams(setup))` の 1 行だけ。
 *   判定・変換は DOM を触らない純関数に分けてテストする。
 */

import '@/styles/screens.css';

import { MAP_TYPE_IDS, type Age, type CivId, type MapTypeId } from '@/shared/types';
import { MAX_PLAYERS, createWorld } from '@/sim/core/world';
import { Tile } from '@/sim/core/terrain';
import { generateMap, mapSizeForPlayers } from '@/sim/systems/mapgen';
import { loadGameData } from '@/data/load';
import { TILE_COLORS, playerColor } from '@/render/palette';
import { el, button, type Screen, type ScreenParams } from './router';
import {
  CIV_GRID,
  RANDOM_CIV,
  civLabel,
  emblemEl,
  resolveCivSlot,
  type CivSlotId,
} from './CivSelect';

// ---------------------------------------------------------------- 状態

/** スロットの種別（`05§3-4`, `05§3-5`）。 */
export type SlotKind = 'human' | 'ai' | 'empty';

/** 参加者スロット 1 つ。 */
export interface SlotState {
  readonly kind: SlotKind;
  readonly name: string;
  /** 文明（重複可。ランダム枠のまま持ち回せる）。 */
  readonly civ: CivSlotId;
  /** チーム番号 1..8（同じ番号どうしが味方）。 */
  readonly team: number;
  /** AI の段階 ID（`ai.json` のキー）。人間・空きは null。 */
  readonly aiLevel: string | null;
  /** 準備完了（`05§3-7`。押した人のスロットが金色）。 */
  readonly ready: boolean;
}

/** 対戦設定の全体。**スロットは常に 8 要素**（空きも 1 要素として持つ）。 */
export interface SetupState {
  readonly seed: number;
  readonly mapType: MapTypeId;
  readonly slots: readonly SlotState[];
  readonly startAge: Age;
  readonly startResources: string;
  readonly gameSpeed: number;
  readonly popCap: number;
  /** URL 共有の部屋 ID（M14 で使う）。 */
  readonly roomId: string;
}

/** スロット数の上限（`sim` の `MAX_PLAYERS` と同じ 8）。 */
export const SLOT_COUNT = MAX_PLAYERS;

/** 設定の保存キー（`back()` が params を捨てるので、下書きはここに置く）。 */
export const SETUP_KEY = 'mt.matchSetup';

// ---------------------------------------------------------------- データ参照（JSON から引く）

/** `config.json` を素の記録として読む（`cfg*` は数値専用なので構造ごと欲しいときはこちら）。 */
function configRecord(path: readonly string[]): Record<string, unknown> {
  let cur: unknown = loadGameData().config;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return {};
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>) : {};
}

function numOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** AI 段階 1 つ（`ai.json`。`07§11` の 5 段階）。 */
export interface AiLevelInfo {
  readonly id: string;
  readonly level: number;
  readonly name: string;
  /** 対戦相手としての一言（`ai.json` の `opponentNote`）。 */
  readonly note: string;
  readonly maxFronts: number;
  readonly allowUniqueOrders: boolean;
  readonly allowDoubleFlag: boolean;
}

/** AI 段階の一覧（`level` 昇順）。`ai.json` を書き換えれば画面も追従する。 */
export function aiLevelList(): AiLevelInfo[] {
  const src = loadGameData().ai;
  const out: AiLevelInfo[] = [];
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    const rec = src[id];
    if (rec === null || typeof rec !== 'object') continue;
    const r = rec as Record<string, unknown>;
    out.push({
      id,
      level: numOf(r['level'], 0),
      name: String(r['name'] ?? id),
      note: String(r['opponentNote'] ?? ''),
      maxFronts: numOf(r['maxFronts'], 0),
      allowUniqueOrders: r['allowUniqueOrders'] === true,
      allowDoubleFlag: r['allowDoubleFlag'] === true,
    });
  }
  out.sort((a, b) => a.level - b.level || (a.id < b.id ? -1 : 1));
  return out;
}

/** AI 段階 ID → 表示名（段階つき）。未知の ID は ID をそのまま。 */
export function aiLevelLabel(id: string | null): string {
  if (id === null) return '';
  const hit = aiLevelList().find((a) => a.id === id);
  return hit === undefined ? id : `段階${hit.level} ${hit.name}`;
}

/** マップ型 1 つ（`maps.json`。`07§13` の 8 型）。 */
export interface MapTypeInfo {
  readonly id: MapTypeId;
  readonly name: string;
  /** 生成パラメータ上の水域比（実際の比は preview で数える）。 */
  readonly waterRatio: number;
  readonly frontsMin: number;
  readonly frontsMax: number;
  readonly note: string;
}

/** マップ型の一覧（`MAP_TYPE_IDS` の固定順）。 */
export function mapTypeList(): MapTypeInfo[] {
  const src = loadGameData().maps;
  const out: MapTypeInfo[] = [];
  for (const id of MAP_TYPE_IDS) {
    const rec = src[id];
    const r = rec !== null && typeof rec === 'object' ? (rec as Record<string, unknown>) : {};
    out.push({
      id,
      name: String(r['name'] ?? id),
      waterRatio: numOf(r['waterRatio'], 0),
      frontsMin: numOf(r['expectedFrontsMin'], 0),
      frontsMax: numOf(r['expectedFrontsMax'], 0),
      note: String(r['note'] ?? ''),
    });
  }
  return out;
}

/** 開始時代 1 つ（`config.ages` + `matchOptions.startAge.allowed`）。 */
export interface StartAgeInfo {
  readonly id: Age;
  readonly name: string;
  /** その時代の戦域スロット数（`config.ages[].slots`）。 */
  readonly slots: number;
}

/** 選べる開始時代（`07§14`。上げると内政フェーズを飛ばして令の練習ができる）。 */
export function startAgeList(): StartAgeInfo[] {
  const allowedRaw = configRecord(['matchOptions', 'startAge'])['allowed'];
  const allowed = Array.isArray(allowedRaw) ? (allowedRaw as string[]) : [];
  const agesRaw = loadGameData().config['ages'];
  const ages = Array.isArray(agesRaw) ? (agesRaw as Record<string, unknown>[]) : [];
  const out: StartAgeInfo[] = [];
  for (const a of ages) {
    const id = String(a['id']);
    if (allowed.length > 0 && !allowed.includes(id)) continue;
    out.push({ id: id as Age, name: String(a['name'] ?? id), slots: numOf(a['slots'], 1) });
  }
  return out;
}

/** 開始資源プリセット名の一覧（`matchOptions.startResources.presets`）。 */
export function startResourcePresets(): string[] {
  return Object.keys(configRecord(['matchOptions', 'startResources', 'presets']));
}

/** 開始資源プリセットの中身を「食料 200 / 木材 200 …」の 1 行にする。 */
export function startResourceText(preset: string): string {
  const rec = configRecord(['matchOptions', 'startResources', 'presets'])[preset];
  if (rec === null || typeof rec !== 'object') return preset;
  const res = loadGameData().resources;
  const parts: string[] = [];
  for (const [key, v] of Object.entries(rec as Record<string, unknown>)) {
    const nameRec = res[key];
    const name =
      nameRec !== null && typeof nameRec === 'object' && 'name' in nameRec
        ? String((nameRec as Record<string, unknown>)['name'])
        : key;
    parts.push(`${name} ${numOf(v, 0)}`);
  }
  return parts.join(' / ');
}

/** ゲーム速度の範囲（`matchOptions.gameSpeed`）。 */
export function gameSpeedRange(): { min: number; max: number; step: number; def: number } {
  const r = configRecord(['matchOptions', 'gameSpeed']);
  return {
    min: numOf(r['min'], 0.5),
    max: numOf(r['max'], 1.5),
    step: numOf(r['step'], 0.1),
    def: numOf(r['default'], 1),
  };
}

/**
 * 人口上限の選択肢。基準は `config.population.defaultCap`（既定 200。`05§6-2`）。
 * 倍率 0.25/0.5/1/1.5/2 は**画面の刻み**（バランス値ではないので JSON には無い）。
 */
export function popCapOptions(): number[] {
  const base = numOf(configRecord(['population'])['defaultCap'], 200);
  return [0.25, 0.5, 1, 1.5, 2].map((m) => Math.round(base * m));
}

// ---------------------------------------------------------------- 既定値と検証（純関数）

/** 既定の対戦設定（人間 1 + AI 1 + 空き 6）。 */
export function defaultSetup(seed: number): SetupState {
  const ai = aiLevelList();
  // 既定は「標準」= 中央の段階（`ai.json` の並びの真ん中）。5 段階なら段階 3。
  const mid = ai[Math.floor(ai.length / 2)];
  const slots: SlotState[] = [
    { kind: 'human', name: 'あなた', civ: 'yamato', team: 1, aiLevel: null, ready: false },
    {
      kind: 'ai',
      name: 'AI 1',
      civ: 'mongol',
      team: 2,
      aiLevel: mid === undefined ? null : mid.id,
      ready: true,
    },
  ];
  for (let i = slots.length; i < SLOT_COUNT; i++) {
    slots.push({ kind: 'empty', name: '', civ: RANDOM_CIV, team: i + 1, aiLevel: null, ready: false });
  }
  const speed = gameSpeedRange();
  const ages = startAgeList();
  const presets = startResourcePresets();
  const defAge = String(configRecord(['matchOptions', 'startAge'])['default'] ?? 'reimei') as Age;
  const defRes = String(configRecord(['matchOptions', 'startResources'])['default'] ?? 'standard');
  return {
    seed,
    mapType: 'plain',
    slots,
    startAge: ages.some((a) => a.id === defAge) ? defAge : (ages[0]?.id ?? 'reimei'),
    startResources: presets.includes(defRes) ? defRes : (presets[0] ?? 'standard'),
    gameSpeed: speed.def,
    popCap: numOf(configRecord(['population'])['defaultCap'], 200),
    roomId: roomIdFromSeed(seed),
  };
}

/** 部屋 ID（URL 共有用。seed から作るので同じ設定を再現できる）。 */
export function roomIdFromSeed(seed: number): string {
  return Math.abs(Math.trunc(seed)).toString(36).padStart(6, '0').slice(-6);
}

/** 参加中（人間 + AI）のスロットだけを playerId 昇順で返す。 */
export function activeSlots(s: SetupState): SlotState[] {
  return s.slots.filter((x) => x.kind !== 'empty');
}

/** 参加人数。 */
export function activePlayerCount(s: SetupState): number {
  return activeSlots(s).length;
}

/** 検証結果。 */
export interface SetupIssues {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * 設定の検証（`createMatch` に渡す前に弾く）。
 * ここで拾えなかった不正はシムの例外になり、原因が分かりにくくなる。
 */
export function validateSetup(s: SetupState): SetupIssues {
  const errors: string[] = [];
  const active = activeSlots(s);
  if (active.length < 2) errors.push('参加者が 2 人以上必要です（空きスロットに AI を追加してください）');
  if (active.length > SLOT_COUNT) errors.push(`参加者は最大 ${SLOT_COUNT} 人です`);
  const aiIds = new Set(aiLevelList().map((a) => a.id));
  for (let i = 0; i < s.slots.length; i++) {
    const slot = s.slots[i]!;
    if (slot.kind === 'ai' && (slot.aiLevel === null || !aiIds.has(slot.aiLevel))) {
      errors.push(`スロット ${i + 1}: AI の段階が選ばれていません`);
    }
    if (slot.kind !== 'empty' && slot.name.trim() === '') {
      errors.push(`スロット ${i + 1}: 名前が空です`);
    }
    if (!CIV_GRID.includes(slot.civ)) errors.push(`スロット ${i + 1}: 文明が不正です`);
  }
  const teams = new Set(active.map((x) => x.team));
  if (active.length >= 2 && teams.size < 2) {
    errors.push('全員が同じチームでは決着が付きません（チーム色を分けてください）');
  }
  const speed = gameSpeedRange();
  if (s.gameSpeed < speed.min || s.gameSpeed > speed.max) {
    errors.push(`ゲーム速度は ${speed.min}〜${speed.max} の範囲です`);
  }
  if (!popCapOptions().includes(s.popCap) && s.popCap <= 0) errors.push('人口上限が不正です');
  if (!startAgeList().some((a) => a.id === s.startAge)) errors.push('開始時代が不正です');
  if (!startResourcePresets().includes(s.startResources)) errors.push('開始資源が不正です');
  if (!MAP_TYPE_IDS.includes(s.mapType)) errors.push('マップ型が不正です');
  return { ok: errors.length === 0, errors };
}

/**
 * 全員が準備完了か（`05§3-7`）。
 * AI は常に準備完了扱い。**人間が 0 人**の場合は開始できない（観戦は M15）。
 */
export function allReady(s: SetupState): boolean {
  const humans = s.slots.filter((x) => x.kind === 'human');
  if (humans.length === 0) return false;
  return humans.every((x) => x.ready);
}

/** 開始できるか（検証 + 準備完了）。 */
export function canStart(s: SetupState): boolean {
  return validateSetup(s).ok && allReady(s);
}

/** `router.go('match', ...)` に渡す引数（`main.ts` が読む形）。 */
export interface MatchParams extends ScreenParams {
  readonly seed: number;
  readonly playerCount: number;
  readonly civs: readonly CivId[];
  readonly mapType: MapTypeId;
  /** 以下は `main.ts` が未対応（M12 の申し送り。読み飛ばされる）。 */
  readonly teams: readonly number[];
  readonly startAge: Age;
  readonly startResources: string;
  readonly gameSpeed: number;
  readonly popCap: number;
}

/**
 * 対戦画面へ渡す引数に変換する。
 * ランダム枠は `seed + playerId` から決定論的に解決する（リプレイでも同じ組み合わせ）。
 */
export function toMatchParams(s: SetupState): MatchParams {
  const active = activeSlots(s);
  return {
    seed: s.seed,
    playerCount: active.length,
    civs: active.map((slot, i) => resolveCivSlot(slot.civ, s.seed + i)),
    mapType: s.mapType,
    teams: active.map((slot) => slot.team),
    startAge: s.startAge,
    startResources: s.startResources,
    gameSpeed: s.gameSpeed,
    popCap: s.popCap,
  };
}

// ---------------------------------------------------------------- URL 共有（M14 への申し送り）

/** スロット 1 つを URL の 1 トークンにする（`h:1:yamato` / `a:2:mongol:shokou` / `e`）。 */
function slotToken(slot: SlotState): string {
  if (slot.kind === 'empty') return 'e';
  const head = slot.kind === 'human' ? 'h' : 'a';
  const base = `${head}:${slot.team}:${slot.civ}`;
  return slot.kind === 'ai' && slot.aiLevel !== null ? `${base}:${slot.aiLevel}` : base;
}

/** URL の 1 トークンをスロットに戻す。壊れていたら空きスロットにする。 */
function tokenToSlot(token: string, index: number): SlotState {
  const parts = token.split(':');
  const head = parts[0];
  if (head !== 'h' && head !== 'a') {
    return { kind: 'empty', name: '', civ: RANDOM_CIV, team: index + 1, aiLevel: null, ready: false };
  }
  const team = Number.parseInt(parts[1] ?? '', 10);
  const civRaw = parts[2] ?? RANDOM_CIV;
  const civ: CivSlotId = CIV_GRID.includes(civRaw as CivSlotId) ? (civRaw as CivSlotId) : RANDOM_CIV;
  const kind: SlotKind = head === 'h' ? 'human' : 'ai';
  return {
    kind,
    name: kind === 'human' ? `参加者 ${index + 1}` : `AI ${index + 1}`,
    civ,
    team: Number.isFinite(team) && team >= 1 ? team : index + 1,
    aiLevel: kind === 'ai' ? (parts[3] ?? null) : null,
    ready: kind === 'ai',
  };
}

/**
 * 共有 URL を作る（`05§3`「URL を共有するだけで他の人が入ってくる」）。
 *
 * **通信は M14**。今はこの形の URL を出すところまで。M14 では
 * `room` をリレーの部屋 ID に使い、入室時に他の項目で画面を復元する。
 */
export function buildShareUrl(base: string, s: SetupState): string {
  const q = new URLSearchParams();
  q.set('room', s.roomId);
  q.set('seed', String(s.seed));
  q.set('map', s.mapType);
  q.set('age', s.startAge);
  q.set('res', s.startResources);
  q.set('speed', String(s.gameSpeed));
  q.set('pop', String(s.popCap));
  q.set('slots', s.slots.map(slotToken).join(','));
  const cut = base.split('?')[0] ?? base;
  return `${cut}?${q.toString()}`;
}

/** 共有 URL のクエリを設定に戻す（`room` が無ければ null = 共有 URL ではない）。 */
export function parseShareParams(search: string): SetupState | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const room = q.get('room');
  if (room === null) return null;
  const seed = Number.parseInt(q.get('seed') ?? '', 10);
  const base = defaultSetup(Number.isFinite(seed) ? seed : 0);
  const mapRaw = q.get('map');
  const ageRaw = q.get('age');
  const resRaw = q.get('res');
  const speed = Number.parseFloat(q.get('speed') ?? '');
  const pop = Number.parseInt(q.get('pop') ?? '', 10);
  const slotsRaw = q.get('slots');
  const slots =
    slotsRaw === null
      ? base.slots
      : slotsRaw
          .split(',')
          .slice(0, SLOT_COUNT)
          .map((t, i) => tokenToSlot(t, i));
  const filled = [...slots];
  for (let i = filled.length; i < SLOT_COUNT; i++) {
    filled.push({ kind: 'empty', name: '', civ: RANDOM_CIV, team: i + 1, aiLevel: null, ready: false });
  }
  return {
    ...base,
    roomId: room,
    mapType: MAP_TYPE_IDS.includes(mapRaw as MapTypeId) ? (mapRaw as MapTypeId) : base.mapType,
    startAge: startAgeList().some((a) => a.id === ageRaw) ? (ageRaw as Age) : base.startAge,
    startResources: startResourcePresets().includes(resRaw ?? '') ? resRaw! : base.startResources,
    gameSpeed: Number.isFinite(speed) ? speed : base.gameSpeed,
    popCap: Number.isFinite(pop) && pop > 0 ? pop : base.popCap,
    slots: filled,
  };
}

// ---------------------------------------------------------------- マップ preview（純関数）

/** preview 1 枚ぶんのデータ。 */
export interface PreviewData {
  readonly mapType: MapTypeId;
  readonly size: number;
  /** タイル種別（長さ = size * size）。 */
  readonly tiles: Uint8Array;
  /** 開始位置（マス座標。添字 = playerId）。 */
  readonly starts: readonly { readonly playerId: number; readonly tx: number; readonly ty: number }[];
  /** 実際に数えた水域比（深水 + 浅瀬）。 */
  readonly waterRatio: number;
}

/** 直近の preview を 1 枚だけ覚えておく（設定を変えた時だけ作り直す）。 */
let previewCache: { key: string; data: PreviewData } | null = null;

/**
 * preview を作る（**試合と同じ `generateMap` を呼ぶ**）。
 * 捨てる `World` を 1 つ作るだけで、シムは 1 tick も進めない（読み取り専用の原則を保つ）。
 */
export function generatePreview(mapType: MapTypeId, playerCount: number, seed: number): PreviewData {
  const key = `${mapType}|${playerCount}|${seed}`;
  if (previewCache !== null && previewCache.key === key) return previewCache.data;
  const size = mapSizeForPlayers(mapType, playerCount);
  const world = createWorld({
    seed,
    playerCount: Math.max(2, Math.min(SLOT_COUNT, playerCount)),
    mapWidthTiles: size,
    mapHeightTiles: size,
  });
  const gen = generateMap(world, { mapType });
  const tiles = new Uint8Array(world.map.tiles);
  let water = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    if (t === Tile.Water || t === Tile.Shallow) water++;
  }
  const data: PreviewData = {
    mapType,
    size,
    tiles,
    starts: gen.starts.map((st) => ({ playerId: st.playerId, tx: st.tx, ty: st.ty })),
    waterRatio: tiles.length === 0 ? 0 : water / tiles.length,
  };
  previewCache = { key, data };
  return data;
}

/**
 * 水域比 → 「港と船の価値」の一言（`05§3-1`）。
 * 閾値 0.08 / 0.2 / 0.45 は画面の言い回しの区切り（バランス値ではない）。
 */
export function navalValueLabel(waterRatio: number): string {
  if (waterRatio < 0.08) return '港と船はほぼ不要';
  if (waterRatio < 0.2) return '港が少し効く';
  if (waterRatio < 0.45) return '港と船が効く';
  return '輸送船と港が前提';
}

/**
 * 開始位置の「隣」を近い順に返す（`05§3-2`「隣が誰かで序盤に立つ戦域の場所が決まる」）。
 * 距離が同じときは playerId 昇順（表示が毎回変わらないように全順序にする）。
 */
export function startNeighbors(
  starts: readonly { readonly playerId: number; readonly tx: number; readonly ty: number }[],
  playerId: number,
  count = 2,
): number[] {
  const self = starts.find((s) => s.playerId === playerId);
  if (self === undefined) return [];
  return starts
    .filter((s) => s.playerId !== playerId)
    .map((s) => ({ id: s.playerId, d: (s.tx - self.tx) ** 2 + (s.ty - self.ty) ** 2 }))
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .slice(0, count)
    .map((x) => x.id);
}

// ---------------------------------------------------------------- 保存

/** 下書きを保存する（`router.back()` が params を捨てるため）。 */
export function saveSetup(s: SetupState): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても画面は動く
  }
}

/** 下書きを読む（壊れていたら既定値）。 */
export function loadSetup(seed: number): SetupState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETUP_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) return defaultSetup(seed);
  try {
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    const base = defaultSetup(seed);
    const merged: SetupState = {
      ...base,
      ...parsed,
      slots:
        Array.isArray(parsed.slots) && parsed.slots.length === SLOT_COUNT
          ? (parsed.slots as SlotState[])
          : base.slots,
      seed: typeof parsed.seed === 'number' ? parsed.seed : base.seed,
    };
    return validateSetup(merged).ok || activePlayerCount(merged) >= 1 ? merged : base;
  } catch {
    return defaultSetup(seed);
  }
}

// ---------------------------------------------------------------- 画面

/** `<select>` を 1 つ作る。 */
function select(
  options: readonly { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = el('select', 'mt-select');
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    onChange(sel.value);
  });
  return sel;
}

/** ラベル + 中身の 1 行。 */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('label', 'mt-field');
  row.appendChild(el('span', 'mt-field-label', label));
  row.appendChild(control);
  if (hint !== undefined) row.appendChild(el('span', 'mt-field-hint', hint));
  return row;
}

/** preview を canvas に描く（地形の縮図 + 開始位置の点）。 */
function drawPreview(canvas: HTMLCanvasElement, data: PreviewData, teamOf: (p: number) => number): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const px = canvas.width;
  const py = canvas.height;
  const img = ctx.createImageData(px, py);
  const rgb = TILE_COLORS.map((hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] as const;
  });
  for (let y = 0; y < py; y++) {
    const ty = Math.min(data.size - 1, Math.floor((y / py) * data.size));
    for (let x = 0; x < px; x++) {
      const tx = Math.min(data.size - 1, Math.floor((x / px) * data.size));
      // preview の tiles は 1 枚ぶんの平坦な配列（幅 = data.size）
      const t = data.tiles[ty * data.size + tx] ?? Tile.Grass;
      const c = rgb[t] ?? rgb[Tile.Grass]!;
      const o = (y * px + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // ---- 開始位置（`05§3-2`。色は陣営色 = 試合中と同じ）----
  for (const st of data.starts) {
    const cx = (st.tx / data.size) * px;
    const cy = (st.ty / data.size) * py;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = playerColor(st.playerId);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(20,16,12,0.9)';
    ctx.stroke();
    ctx.fillStyle = '#14100c';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(teamOf(st.playerId)), cx, cy + 0.5);
  }
}

/** 対戦設定画面。 */
export const matchSetupScreen: Screen = {
  mount(root, nav, params) {
    // 下書き（`localStorage`）があればそれを使う。無ければ `seed` から既定値を作る。
    // `router.back()` は params を捨てるので、画面をまたぐ状態は下書きで持ち回る。
    const seedParam = typeof params['seed'] === 'number' ? params['seed'] : DEFAULT_SETUP_SEED;
    let setup = loadSetup(seedParam);

    // 文明選択から戻ってきた（`{ slot, pickedCiv }`）
    const pickedCiv = typeof params['pickedCiv'] === 'string' ? params['pickedCiv'] : null;
    const pickedSlot = typeof params['slot'] === 'number' ? params['slot'] : null;
    if (pickedCiv !== null && pickedSlot !== null && CIV_GRID.includes(pickedCiv as CivSlotId)) {
      setup = patchSlot(setup, pickedSlot, { civ: pickedCiv as CivSlotId });
    }

    const scr = el('div', 'mt-scr mt-scr-setup');

    const head = el('header', 'mt-scr-head');
    head.appendChild(el('h1', 'mt-scr-title', '対戦設定'));
    head.appendChild(el('p', 'mt-scr-sub', '最大 8 人（1 対 1 〜 4 対 4）。URL を共有すると同じ設定で入れます'));
    scr.appendChild(head);

    const body = el('div', 'mt-scr-body mt-setup-body');
    scr.appendChild(body);

    // ---- 左: マップ preview + 試合設定 ----
    const left = el('section', 'mt-setup-left');
    const canvas = el('canvas', 'mt-preview');
    canvas.width = 320;
    canvas.height = 320;
    left.appendChild(canvas);
    const previewInfo = el('p', 'mt-preview-info');
    left.appendChild(previewInfo);
    const mapPicker = el('div', 'mt-map-picker');
    left.appendChild(mapPicker);
    const options = el('div', 'mt-options');
    left.appendChild(options);
    body.appendChild(left);

    // ---- 右: 参加者スロット ----
    const right = el('section', 'mt-setup-right');
    const slotList = el('div', 'mt-slots');
    right.appendChild(slotList);
    const issues = el('ul', 'mt-issues');
    right.appendChild(issues);
    body.appendChild(right);

    // ---- 下端 ----
    const foot = el('footer', 'mt-scr-foot');
    foot.appendChild(
      button('mt-btn', 'タイトルへ', () => {
        nav.go('title');
      }),
    );
    const shareBtn = button('mt-btn', 'URL を共有', () => {
      const url = buildShareUrl(location.href, setup);
      shareOut.textContent = url;
      shareOut.classList.add('is-shown');
    });
    foot.appendChild(shareBtn);
    const readyBtn = button('mt-btn mt-btn-ready', '準備完了', () => {
      const me = setup.slots.findIndex((s) => s.kind === 'human');
      if (me < 0) return;
      setup = patchSlot(setup, me, { ready: !setup.slots[me]!.ready });
      sync();
    });
    foot.appendChild(readyBtn);
    const startBtn = button('mt-btn mt-btn-primary', '試合開始', () => {
      if (!canStart(setup)) return;
      saveSetup(setup);
      nav.go('match', toMatchParams(setup));
    });
    foot.appendChild(startBtn);
    scr.appendChild(foot);
    const shareOut = el('p', 'mt-share-url');
    scr.appendChild(shareOut);

    /** スロット 1 つを差し替えた新しい設定を返す。 */
    function patchSlot(s: SetupState, index: number, patch: Partial<SlotState>): SetupState {
      const slots = s.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot));
      return { ...s, slots };
    }

    /** 画面全体を描き直す（設定はどれも他に波及するのでまとめて作り直す）。 */
    function sync(): void {
      saveSetup(setup);

      // ---- 1,2 マップ preview + 開始位置 ----
      const count = Math.max(2, activePlayerCount(setup));
      const data = generatePreview(setup.mapType, count, setup.seed);
      const teamOf = (p: number): number => activeSlots(setup)[p]?.team ?? p + 1;
      drawPreview(canvas, data, teamOf);
      const info = mapTypeList().find((m) => m.id === setup.mapType);
      previewInfo.textContent =
        `${info?.name ?? setup.mapType} ${data.size}×${data.size} マス / ` +
        `水域 ${(data.waterRatio * 100).toFixed(0)}% ― ${navalValueLabel(data.waterRatio)} / ` +
        `戦域の目安 ${info?.frontsMin ?? '?'}〜${info?.frontsMax ?? '?'} 本`;

      mapPicker.textContent = '';
      for (const m of mapTypeList()) {
        const b = button(`mt-map-btn${m.id === setup.mapType ? ' is-selected' : ''}`, m.name, () => {
          setup = { ...setup, mapType: m.id };
          sync();
        });
        b.title = m.note;
        mapPicker.appendChild(b);
      }

      // ---- 6 試合設定 ----
      options.textContent = '';
      options.appendChild(el('h2', 'mt-scr-h', '試合設定'));
      const ages = startAgeList();
      options.appendChild(
        field(
          '開始時代',
          select(
            ages.map((a) => ({ value: a.id, label: a.name })),
            setup.startAge,
            (v) => {
              setup = { ...setup, startAge: v as Age };
              sync();
            },
          ),
          `戦域スロット ${ages.find((a) => a.id === setup.startAge)?.slots ?? 1} 枠から始まる（上げると内政を飛ばして令の練習ができる）`,
        ),
      );
      options.appendChild(
        field(
          '開始資源',
          select(
            startResourcePresets().map((p) => ({ value: p, label: p })),
            setup.startResources,
            (v) => {
              setup = { ...setup, startResources: v };
              sync();
            },
          ),
          startResourceText(setup.startResources),
        ),
      );
      const sr = gameSpeedRange();
      const speedSel = select(
        speedSteps(sr).map((v) => ({ value: String(v), label: `×${v.toFixed(1)}` })),
        String(setup.gameSpeed),
        (v) => {
          setup = { ...setup, gameSpeed: Number.parseFloat(v) };
          sync();
        },
      );
      options.appendChild(field('ゲーム速度', speedSel, 'AI も同じ速度なので難易度は変わらない'));
      options.appendChild(
        field(
          '人口上限',
          select(
            popCapOptions().map((v) => ({ value: String(v), label: String(v) })),
            String(setup.popCap),
            (v) => {
              setup = { ...setup, popCap: Number.parseInt(v, 10) };
              sync();
            },
          ),
          '上限に当たると生産ボタンが赤くなる',
        ),
      );
      const seedField = el('input', 'mt-input');
      seedField.type = 'text';
      seedField.value = String(setup.seed);
      seedField.addEventListener('change', () => {
        const n = Number.parseInt(seedField.value, 10);
        if (Number.isFinite(n)) {
          setup = { ...setup, seed: n, roomId: roomIdFromSeed(n) };
          sync();
        }
      });
      options.appendChild(field('シード', seedField, '同じシードなら同じ地形になる'));

      // ---- 3,4,5 参加者スロット ----
      slotList.textContent = '';
      slotList.appendChild(el('h2', 'mt-scr-h', `参加者（${activePlayerCount(setup)} / ${SLOT_COUNT}）`));
      let playerIdx = 0;
      for (let i = 0; i < setup.slots.length; i++) {
        const slot = setup.slots[i]!;
        const pid = slot.kind === 'empty' ? -1 : playerIdx++;
        slotList.appendChild(buildSlotRow(i, slot, pid));
      }

      // ---- 7 準備完了 / 開始 ----
      const me = setup.slots.find((s) => s.kind === 'human');
      readyBtn.classList.toggle('is-ready', me?.ready === true);
      readyBtn.textContent = me?.ready === true ? '準備完了（解除）' : '準備完了';
      const v = validateSetup(setup);
      issues.textContent = '';
      for (const e of v.errors) issues.appendChild(el('li', 'mt-issue', e));
      if (v.ok && !allReady(setup)) {
        issues.appendChild(el('li', 'mt-issue mt-issue-wait', '準備完了を押すと開始できます'));
      }
      startBtn.disabled = !canStart(setup);
      startBtn.classList.toggle('is-off', !canStart(setup));
    }

    /** 参加者スロット 1 行（名前・チーム色・紋章・種別・準備）。 */
    function buildSlotRow(index: number, slot: SlotState, playerId: number): HTMLElement {
      const row = el('div', `mt-slot mt-slot-${slot.kind}${slot.ready ? ' is-ready' : ''}`);
      const color = playerId < 0 ? '#5b5347' : playerColor(playerId);
      row.style.setProperty('--slot-color', color);
      row.appendChild(el('span', 'mt-slot-no', String(index + 1)));

      if (slot.kind === 'empty') {
        // ---- 5 空きスロット ----
        row.appendChild(el('span', 'mt-slot-empty-text', '空き（参加待ち）'));
        row.appendChild(
          button('mt-btn mt-btn-add', '＋ AI を追加', () => {
            const ai = aiLevelList();
            const mid = ai[Math.floor(ai.length / 2)];
            setup = patchSlot(setup, index, {
              kind: 'ai',
              name: `AI ${index + 1}`,
              aiLevel: mid === undefined ? null : mid.id,
              ready: true,
              civ: RANDOM_CIV,
            });
            sync();
          }),
        );
        return row;
      }

      // ---- 4 種別アイコン（人型 = 人間 / 兜 = AI）----
      const kindBtn = button('mt-slot-kind', slot.kind === 'human' ? '人' : '兜', () => {
        setup = patchSlot(setup, index, {
          kind: slot.kind === 'human' ? 'ai' : 'human',
          aiLevel: slot.kind === 'human' ? (aiLevelList()[2]?.id ?? null) : null,
          ready: slot.kind === 'human',
          name: slot.kind === 'human' ? `AI ${index + 1}` : `参加者 ${index + 1}`,
        });
        sync();
      });
      kindBtn.title = slot.kind === 'human' ? '人間（クリックで AI に）' : 'AI（クリックで人間に）';
      row.appendChild(kindBtn);

      // ---- 3 紋章（クリックで文明選択へ）----
      const civBtn = button('mt-slot-civ', '', () => {
        saveSetup(setup);
        nav.go('civSelect', { slot: index, civ: slot.civ, seed: setup.seed });
      });
      civBtn.textContent = '';
      civBtn.appendChild(emblemEl(slot.civ, 34, color));
      civBtn.appendChild(el('span', 'mt-slot-civ-name', civLabel(slot.civ)));
      civBtn.title = '文明を選ぶ（重複可）';
      row.appendChild(civBtn);

      // 名前
      const name = el('input', 'mt-slot-name');
      name.type = 'text';
      name.value = slot.name;
      name.addEventListener('change', () => {
        setup = patchSlot(setup, index, { name: name.value });
        saveSetup(setup);
      });
      row.appendChild(name);

      // チーム色
      row.appendChild(
        select(
          Array.from({ length: SLOT_COUNT }, (_, i) => ({ value: String(i + 1), label: `T${i + 1}` })),
          String(slot.team),
          (v) => {
            setup = patchSlot(setup, index, { team: Number.parseInt(v, 10) });
            sync();
          },
        ),
      );

      // AI 段階（5 段階。段階 2 以上は戦域指令で戦い、最上位は固有令と二重旗まで使う）
      if (slot.kind === 'ai') {
        const ai = aiLevelList();
        const sel = select(
          ai.map((a) => ({ value: a.id, label: `段階${a.level} ${a.name}（${a.note}）` })),
          slot.aiLevel ?? '',
          (v) => {
            setup = patchSlot(setup, index, { aiLevel: v });
            sync();
          },
        );
        row.appendChild(sel);
        const cur = ai.find((a) => a.id === slot.aiLevel);
        if (cur !== undefined) {
          const marks: string[] = [`戦域 ${cur.maxFronts}`];
          if (cur.allowUniqueOrders) marks.push('固有令');
          if (cur.allowDoubleFlag) marks.push('二重旗');
          row.appendChild(el('span', 'mt-slot-ai-note', marks.join(' / ')));
        }
      } else {
        row.appendChild(el('span', 'mt-slot-ai-note', slot.ready ? '準備完了' : '準備中'));
      }

      // 空きに戻す
      row.appendChild(
        button('mt-slot-remove', '×', () => {
          setup = patchSlot(setup, index, {
            kind: 'empty',
            name: '',
            aiLevel: null,
            ready: false,
            civ: RANDOM_CIV,
          });
          sync();
        }),
      );

      // 開始位置の隣（`05§3-2`）
      if (playerId >= 0) {
        const data = generatePreview(
          setup.mapType,
          Math.max(2, activePlayerCount(setup)),
          setup.seed,
        );
        const near = startNeighbors(data.starts, playerId);
        if (near.length > 0) {
          const names = near.map((p) => activeSlots(setup)[p]?.name ?? `P${p + 1}`);
          row.appendChild(el('span', 'mt-slot-neighbor', `隣: ${names.join(' / ')}`));
        }
      }
      return row;
    }

    sync();
    root.appendChild(scr);
  },
};

/** ゲーム速度の選択肢（min..max を step 刻み）。 */
function speedSteps(r: { min: number; max: number; step: number }): number[] {
  const out: number[] = [];
  const n = Math.round((r.max - r.min) / r.step);
  for (let i = 0; i <= n; i++) out.push(Math.round((r.min + i * r.step) * 10) / 10);
  return out;
}

/** 下書きも `seed` パラメータも無いときのシード（`main.ts` の既定と同じ日付由来の値）。 */
const DEFAULT_SETUP_SEED = 20260809;
