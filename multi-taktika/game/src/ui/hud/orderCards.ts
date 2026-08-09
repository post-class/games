/**
 * ui/hud/orderCards.ts — 令カードパネル（T-M12-04。`05§8` の 8 項目 / `05§10` / `06§4`）
 *
 * ■ 資料が要求していること
 *  - 「戦域を選ぶと開くパネル」。基本 6 枚（突撃/包囲/死守/略奪/建設/後退）+ 文明固有 1 枚。
 *    **キーボード 1〜6 に対応**（`05§8`。実際の打鍵は `Shift`+`1`〜`6` / `Shift`+`7`）
 *  - 「選択中のカード — **光って前に出ます**。切り替えは即時ではなく、
 *    本陣からの距離ぶんの遅延があります」（`05§8-7`）
 *  - 「名前プレート — 文明固有の令はここに**金の縁**が付きます」（`05§8-8`）
 *  - 「早馬: カード切り替え時の**砂時計が短くなる**」「二重旗: スロットが**上下 2 段に割れる**」
 *    （`05§10` の学舎の表）
 *  - 「マウスでカードをクリックしても同じ」「キーボードを一切使わずに 6 戦線を運用できる
 *    ことを設計要件にしています」（`06§4` / `06§12`）
 *
 * ■ 絶対に守ること（手順書 §16-4）
 *  **令の遅延を UI で隠したり先行反映したりしてはいけない。**
 *  ここがやるのは `{ t:'setOrder', ... }` を 1 本投げることだけ。
 *  カードの「選択中」表示は `Front.order` / `Front.orderLower`（= **発効済み**の令）を見る。
 *  伝達中の令は「選択中」ではなく**砂時計 + 伝達中**として別に描く。
 *  こうしておくと「押したのに動かない」が UI 上でも正しく見える（`06§4`「連打しないでください」）。
 *
 * ■ テスト方針
 *  判定を DOM の外（`buildOrderCards` / `canSetOrder` / `hourglassState` /
 *  `setOrderCommand`）に出し、`tests/unit/ui.orderCards.test.ts` が World だけ組んで検算する。
 */

import { ORDER_IDS, type CivId, type OrderId, type PlayerId, type Tier } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE, cfgInt, cfgNum } from '@/sim/core/config';
import { ORDER_DEFS, type OrderDef } from '@/sim/core/defs';
import { getPlayerModifiers, orderStackSlots, orderSwitchIntervalMul } from '@/sim/core/effects';
import { FX_ONE, idiv } from '@/sim/core/fx';
import { getFront, type Front, type World } from '@/sim/core/world';
import { getPlayer } from '@/sim/core/world';
import { GOLD, frontColor, frontShape } from '@/render/palette';

// ---------------------------------------------------------------- 定数

/** 令の切り替え間隔の基準 tick 数（`config.order.switchIntervalSec` = 6 秒）。 */
const SWITCH_BASE_TICKS = Math.round(cfgNum('order.switchIntervalSec') * TICK_RATE);

/** 二重旗で重ねられる枚数（上段 1 + 下段 1 = 2）。`command.ts` と同じ引き方。 */
const DOUBLE_FLAG_SLOTS =
  cfgInt('order.doubleFlagUpperCount') + cfgInt('order.doubleFlagLowerCount');

/** 段の表示名（二重旗で上下 2 段に割れたときのラベル）。 */
export const TIER_LABEL: Readonly<Record<Tier, string>> = { upper: '上段', lower: '下段' };

/** 砂時計の絵文字を使わない記号（`AI_CODING.md`: 絵文字を避ける）。 */
export const HOURGLASS_MARK = '⧗';

/**
 * カードの一行説明（`05§8` の各カードの本文。「〜とき」の部分）。
 * `orders.json` の `note` は数値の根拠まで含む開発者向けの長文なので、
 * 画面に出す短文はここに持つ（表示文言は UI の責務）。
 */
const ORDER_NOTE: Readonly<Record<string, string>> = {
  charge: '最も近い敵に向かって前進し続ける。数で押し切れると読んだとき',
  siege: '攻城兵器を前に出し、歩兵で護衛する。城・塔を落としたいとき',
  hold: '指定地点から離れず迎撃に専念する。時間を稼いで進化を通したいとき',
  raid: '敵の村人と資源施設を優先して狙う。内政を折る、または囮に',
  build: '村人が防壁・塔を前線に建て進める。戦線を押し上げて固定したいとき',
  retreat: '損害を避けつつ最寄りの拠点まで下がる。捨てる戦域を決めたとき',
};

// ---------------------------------------------------------------- 不許可の理由

/** カードが暗くなる理由（`05§15`「暗いボタン・錠」の 3 種 + 令に固有のもの）。 */
export const CardReason = {
  Ok: 'ok',
  /** 戦域が立っていない（`05§7-7`「枠が余っていても戦域が立っていなければ使えません」）。 */
  NoFront: 'noFront',
  /** そのスロットがまだ解禁されていない（時代・城・旗竿）。 */
  SlotLocked: 'slotLocked',
  /** 文明が持てない令（`05§15` の「その文明が持てない」）。 */
  CivRestricted: 'civRestricted',
  /** 下段の令は研究「二重旗」が要る（`sim/command.ts` の判定に合わせる）。 */
  NeedDoubleFlag: 'needDoubleFlag',
  /** 令が伝達中（`06§4`「連打しないでください」）。 */
  Delivering: 'delivering',
  /** 切り替え間隔の待ち（6 秒 / 早馬 4.2 秒）。 */
  SwitchCooldown: 'switchCooldown',
  /** 戦域が離反している（令を聞かない。`07§10`）。 */
  Defected: 'defected',
} as const;
export type CardReasonId = (typeof CardReason)[keyof typeof CardReason];

/** 理由 → 画面に出す文（カーソルを乗せると出る。`05§15`）。 */
export const CARD_REASON_TEXT: Readonly<Record<CardReasonId, string>> = {
  [CardReason.Ok]: '',
  [CardReason.NoFront]: '戦域が立っていません',
  [CardReason.SlotLocked]: '未解禁のスロット（時代・城・研究「旗竿」で増えます）',
  [CardReason.CivRestricted]: '文明制限（他の文明の固有令）',
  [CardReason.NeedDoubleFlag]: '研究「二重旗」が必要（下段の令）',
  [CardReason.Delivering]: '令が伝達中（届くまで次を出せません）',
  [CardReason.SwitchCooldown]: '切り替え待ち（6 秒 / 研究「早馬」で 4.2 秒）',
  [CardReason.Defected]: 'この戦域は離反しています（令を聞きません）',
};

// ---------------------------------------------------------------- 純関数

/** 基本 6 枚（`ORDER_IDS` の先頭 6 件 = キー 1〜6 の並び）。 */
export function basicOrderDefs(): OrderDef[] {
  const out: OrderDef[] = [];
  for (const id of ORDER_IDS.slice(0, 6)) {
    const d = ORDER_DEFS.find((x) => x.id === id);
    if (d !== undefined) out.push(d);
  }
  return out.sort((a, b) => a.key - b.key);
}

/** その文明の固有令（`key` は全文明とも 7）。持たない文明は null。 */
export function civOrderDef(civ: CivId): OrderDef | null {
  return ORDER_DEFS.find((d) => d.civ === civ) ?? null;
}

/** その戦域に今から令を出せるまでの切り替え間隔（tick）。早馬で短くなる。 */
export function switchIntervalTicks(w: World, p: PlayerId): number {
  const m = getPlayerModifiers(w, p);
  // `command.ts` と**同じ丸め方**（四捨五入）。ここがずれると UI の待ち表示が 1 tick 狂う。
  return idiv(SWITCH_BASE_TICKS * orderSwitchIntervalMul(m) + (FX_ONE >> 1), FX_ONE);
}

/** 1 戦域に重ねられる令の枚数（1 = 単旗、2 = 二重旗）。 */
export function stackSlotsOf(w: World, p: PlayerId): number {
  return orderStackSlots(getPlayerModifiers(w, p));
}

/** 二重旗（スロットが上下 2 段に割れる。`05§10`）を取っているか。 */
export function hasDoubleFlag(w: World, p: PlayerId): boolean {
  return stackSlotsOf(w, p) >= DOUBLE_FLAG_SLOTS;
}

/**
 * 令をセットできるか。**`sim/command.ts` の `setOrder` の拒否条件をそのまま写す**。
 *
 * ここが sim と食い違うと「押せるのに何も起きない」（または逆）になる。
 * 遅延・間隔を UI で縮めることはしない（§16-4）。
 */
export function canSetOrder(
  w: World,
  viewer: PlayerId,
  slot: number,
  def: OrderDef,
): CardReasonId {
  const pl = getPlayer(w, viewer);
  if (pl === undefined) return CardReason.NoFront;
  if (def.civ !== null && def.civ !== pl.civ) return CardReason.CivRestricted;
  if (def.tier === 'lower' && stackSlotsOf(w, viewer) < DOUBLE_FLAG_SLOTS) {
    return CardReason.NeedDoubleFlag;
  }
  if (slot < 1 || slot > pl.frontSlots) return CardReason.SlotLocked;
  const f = getFront(w, viewer, slot);
  if (f === undefined || !f.active) return CardReason.NoFront;
  if (f.defected) return CardReason.Defected;
  if (f.pendingOrder !== null) return CardReason.Delivering;
  // 「切り替え」に掛かる間隔なので、1 枚も立っていない戦域への最初の令は待たされない。
  if (f.order !== null || f.orderLower !== null) {
    if (w.tick - f.lastSwitchTick < switchIntervalTicks(w, viewer)) {
      return CardReason.SwitchCooldown;
    }
  }
  return CardReason.Ok;
}

/** 1 枚のカードの状態。 */
export interface OrderCard {
  readonly order: OrderId;
  readonly name: string;
  /** キーボードの番号（基本 6 = 1〜6、文明固有 = 7）。 */
  readonly key: number;
  readonly tier: Tier;
  /** 文明固有 = 名前プレートに金の縁（`05§8-8`）。 */
  readonly civUnique: boolean;
  /** **発効済み**の令（光って前に出る。`05§8-7`）。 */
  readonly selected: boolean;
  /** 今この令が伝達中（砂時計を出す。選択中とは別扱い）。 */
  readonly pending: boolean;
  readonly enabled: boolean;
  readonly reason: CardReasonId;
  readonly note: string;
}

/**
 * パネルに並べる 7 枚（基本 6 + 文明固有 1）を組む。
 * `slot` が 0（戦域未選択）でも**カードは並べる**。押せないだけ（理由が出る）。
 */
export function buildOrderCards(w: World, viewer: PlayerId, slot: number): OrderCard[] {
  const pl = getPlayer(w, viewer);
  const defs = basicOrderDefs();
  if (pl !== undefined) {
    const own = civOrderDef(pl.civ);
    if (own !== null) defs.push(own);
  }
  const f = slot >= 1 ? getFront(w, viewer, slot) : undefined;
  const active = f !== undefined && f.active ? f : null;
  const out: OrderCard[] = [];
  for (const d of defs) {
    const reason = canSetOrder(w, viewer, slot, d);
    out.push({
      order: d.id,
      name: d.name,
      key: d.key,
      tier: d.tier,
      civUnique: d.civ !== null,
      selected:
        active !== null && (active.order === d.id || active.orderLower === d.id),
      pending: active !== null && active.pendingOrder !== null && active.pendingOrder.id === d.id,
      enabled: reason === CardReason.Ok,
      reason,
      note: ORDER_NOTE[d.id] ?? '',
    });
  }
  return out;
}

/**
 * 令をセットする Command。押せないときは null（**先行反映は絶対にしない**）。
 * `tier` は令の定義から取る（`command.ts` が定義と一致しない tier を捨てるため）。
 */
export function setOrderCommand(
  w: World,
  viewer: PlayerId,
  slot: number,
  order: OrderId,
): Command | null {
  const def = ORDER_DEFS.find((d) => d.id === order);
  if (def === undefined) return null;
  if (canSetOrder(w, viewer, slot, def) !== CardReason.Ok) return null;
  return { t: 'setOrder', p: viewer, front: slot, order, tier: def.tier };
}

// ---------------------------------------------------------------- 砂時計

/** 砂時計の種類。 */
export type HourglassKind =
  /** 出さない。 */
  | 'none'
  /** 令が本陣から流れている（遅延。`07§4`）。 */
  | 'delay'
  /** 次の令を出せるまでの間隔（6 秒 / 早馬 4.2 秒）。 */
  | 'interval';

/** 砂時計の計算に必要な値だけを取り出した入力（World を組まずに検算できるように）。 */
export interface HourglassInput {
  readonly hasPending: boolean;
  /** 伝達が始まった tick（観測できていなければ `deliverAtTick` と同値でよい）。 */
  readonly pendingStartTick: number;
  readonly deliverAtTick: number;
  readonly hasOrder: boolean;
  readonly lastSwitchTick: number;
  readonly switchIntervalTicks: number;
  readonly nowTick: number;
}

/** 砂時計の状態。 */
export interface HourglassState {
  readonly kind: HourglassKind;
  /** 残り tick。 */
  readonly remainTicks: number;
  /** 全体の tick 数（0 なら進捗を出さない）。 */
  readonly totalTicks: number;
  /** 0（始め）..1（終わり）。 */
  readonly progress: number;
  /** 残り時間（ms）。画面には秒で出す。 */
  readonly remainMs: number;
}

const NO_HOURGLASS: HourglassState = {
  kind: 'none',
  remainTicks: 0,
  totalTicks: 0,
  progress: 1,
  remainMs: 0,
};

/**
 * 砂時計（`05§10`「カード切り替え時の砂時計」）。
 *
 * 優先は **遅延 > 間隔**。伝達中は「まだ届いていない」ことが最も大事な情報なので、
 * 切り替え待ちより先に出す。
 */
export function hourglassState(inp: HourglassInput): HourglassState {
  if (inp.hasPending) {
    const total = Math.max(1, inp.deliverAtTick - inp.pendingStartTick);
    const remain = Math.max(0, inp.deliverAtTick - inp.nowTick);
    return {
      kind: 'delay',
      remainTicks: remain,
      totalTicks: total,
      progress: clamp01(1 - remain / total),
      remainMs: Math.round((remain * 1000) / TICK_RATE),
    };
  }
  if (inp.hasOrder && inp.switchIntervalTicks > 0) {
    const remain = inp.lastSwitchTick + inp.switchIntervalTicks - inp.nowTick;
    if (remain > 0) {
      return {
        kind: 'interval',
        remainTicks: remain,
        totalTicks: inp.switchIntervalTicks,
        progress: clamp01(1 - remain / inp.switchIntervalTicks),
        remainMs: Math.round((remain * 1000) / TICK_RATE),
      };
    }
  }
  return NO_HOURGLASS;
}

/** `World` から砂時計の入力を組む。`pendingStartTick` は観測値（不明なら null）。 */
export function hourglassInputFor(
  w: World,
  viewer: PlayerId,
  f: Front,
  pendingStartTick: number | null,
): HourglassInput {
  const pending = f.pendingOrder;
  return {
    hasPending: pending !== null,
    pendingStartTick: pending === null ? 0 : (pendingStartTick ?? pending.deliverAtTick),
    deliverAtTick: pending?.deliverAtTick ?? 0,
    hasOrder: f.order !== null || f.orderLower !== null,
    lastSwitchTick: f.lastSwitchTick,
    switchIntervalTicks: switchIntervalTicks(w, viewer),
    nowTick: w.tick,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------- 伝達の観測

/**
 * 「いつ令が流れ始めたか」を覚える箱。
 *
 * `Front.pendingOrder` は `deliverAtTick` しか持たない（sim にとっては
 * それだけで足りる）。UI は**線が流れる割合**と**砂時計の進み**を出すために
 * 開始 tick が要るので、端末ローカルに観測しておく。
 * これは表示のためだけの値で、sim には一切戻さない（決定論に影響しない）。
 */
export class OrderPendingTracker {
  /** `owner*8+slot` ではなくスロット番号だけで足りる（viewer 固定なので）。 */
  private readonly startTick = new Map<number, number>();
  private readonly seen = new Map<number, number>();

  /** 毎フレーム（または update ごと）に呼ぶ。 */
  observe(w: World, fronts: readonly Front[]): void {
    for (const f of fronts) {
      const pending = f.pendingOrder;
      if (pending === null) {
        this.startTick.delete(f.slot);
        this.seen.delete(f.slot);
        continue;
      }
      const prev = this.seen.get(f.slot);
      if (prev !== pending.deliverAtTick) {
        // 新しい令が流れ始めた。**今**を開始 tick として覚える。
        this.seen.set(f.slot, pending.deliverAtTick);
        this.startTick.set(f.slot, w.tick);
      }
    }
  }

  /** 開始 tick（観測していなければ null）。 */
  startOf(slot: number): number | null {
    return this.startTick.get(slot) ?? null;
  }

  clear(): void {
    this.startTick.clear();
    this.seen.clear();
  }
}

// ---------------------------------------------------------------- DOM

/** 令カードパネルが外に触るための窓口。 */
export interface OrderCardsContext {
  world(): World;
  readonly viewer: PlayerId;
  emit(cmd: Command): void;
  /** 今選ばれている戦域スロット（0 = 未選択）。`input/keys.ts` の `selectedFront`。 */
  selectedFront(): number;
  /** カードパネル側から戦域を選び直したいとき（任意）。 */
  selectFront?(slot: number): void;
}

/** テキストを塗り直す間隔（ms）。砂時計だけは毎フレーム動かす。 */
const TEXT_INTERVAL_MS = 100;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 令カードパネル（基本 6 + 固有 1）。
 *
 * 位置は固定（`05§1`）。右端の戦域スロット列（幅 190px + 余白 20px）の**左隣**、
 * 下端のコマンド列の**上**。開いても試合は止まらない（オーバーレイ）。
 */
export class OrderCards {
  private readonly ctx: OrderCardsContext;
  private readonly root: HTMLElement;
  private readonly titleFlag: HTMLElement;
  private readonly titleText: HTMLElement;
  private readonly tiers: HTMLElement;
  private readonly tierRows: Record<Tier, HTMLElement>;
  private readonly hourglass: HTMLElement;
  private readonly hourglassBar: HTMLElement;
  private readonly hourglassText: HTMLElement;
  private readonly cardWrap: HTMLElement;
  private readonly cardNodes = new Map<OrderId, CardNode>();
  private readonly tracker = new OrderPendingTracker();

  private open_ = false;
  private slot = 0;
  private current: OrderCard[] = [];
  private lastTextMs = -1e9;

  constructor(overlay: HTMLElement, ctx: OrderCardsContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-cards');
    this.root.hidden = true;

    // ---- ヘッダは最小限（手順書 §8.2）: 旗 + 戦域名 + 閉じる ----
    const head = el('div', 'mt-cards-head');
    this.titleFlag = el('span', 'mt-cards-flag', '');
    this.titleText = el('span', 'mt-cards-title', '令');
    const close = el('button', 'mt-cards-close', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(this.titleFlag, this.titleText, close);
    this.root.appendChild(head);

    // ---- 令スロット（二重旗で上下 2 段に割れる。`05§10`） ----
    this.tiers = el('div', 'mt-cards-tiers');
    this.tierRows = {
      upper: el('div', 'mt-cards-tier'),
      lower: el('div', 'mt-cards-tier'),
    };
    this.tiers.append(this.tierRows.upper, this.tierRows.lower);
    this.root.appendChild(this.tiers);

    // ---- 砂時計（`05§10`「カード切り替え時の砂時計」） ----
    this.hourglass = el('div', 'mt-cards-hourglass');
    const mark = el('span', 'mt-cards-hourglass-mark', HOURGLASS_MARK);
    this.hourglassText = el('span', 'mt-cards-hourglass-text', '');
    const barWrap = el('div', 'mt-cards-hourglass-bar');
    this.hourglassBar = el('div', 'mt-cards-hourglass-fill');
    barWrap.appendChild(this.hourglassBar);
    this.hourglass.append(mark, this.hourglassText, barWrap);
    this.root.appendChild(this.hourglass);

    // ---- カード 7 枚 ----
    this.cardWrap = el('div', 'mt-cards-grid');
    this.root.appendChild(this.cardWrap);

    overlay.appendChild(this.root);
  }

  /** 開いているか。 */
  isOpen(): boolean {
    return this.open_;
  }

  /** 今のカード一覧（親の結線・目視確認用）。 */
  cards(): readonly OrderCard[] {
    return this.current;
  }

  /** 対象の戦域スロット（0 = 未選択）。 */
  targetSlot(): number {
    return this.slot;
  }

  /** 開く（`slot` 省略時は `ctx.selectedFront()`）。「戦域を選ぶと開く」（`05§8`）。 */
  open(slot?: number): void {
    const s = slot ?? this.ctx.selectedFront();
    this.slot = s;
    this.open_ = true;
    this.root.hidden = false;
    this.lastTextMs = -1e9;
  }

  /** 閉じる（`Esc` の 1 段目「パネルを閉じる」に使える）。 */
  close(): void {
    this.open_ = false;
    this.root.hidden = true;
  }

  /** 開閉。 */
  toggle(slot?: number): boolean {
    if (this.open_ && (slot === undefined || slot === this.slot)) {
      this.close();
      return false;
    }
    this.open(slot);
    return true;
  }

  /**
   * キーボードの番号（1〜6 = 基本、7 = 文明固有）で令をセットする。
   * `Shift`+`1`〜`6` / `Shift`+`7` の結線先。**パネルが閉じていても効く**
   * （`06§1` の最小操作セットは俯瞰を開かなくても回る）。
   */
  pressKey(n: number): boolean {
    const cards = this.current.length > 0 ? this.current : this.rebuild();
    const card = cards.find((c) => c.key === n);
    if (card === undefined) return false;
    return this.pick(card.order);
  }

  /** カードを 1 枚選ぶ（クリックと同じ）。Command を出せたら true。 */
  pick(order: OrderId): boolean {
    const cmd = setOrderCommand(this.ctx.world(), this.ctx.viewer, this.slot, order);
    if (cmd === null) return false;
    this.ctx.emit(cmd);
    // **ここで表示を先に変えない**。次の update で `pendingOrder` を読んで
    // 砂時計が出る（届くまで「選択中」にはならない。§16-4）。
    return true;
  }

  /** 毎フレーム呼ぶ。 */
  update(nowMs: number): void {
    const w = this.ctx.world();
    // 選択中の戦域が変わったら追従する（`Alt`+`1`〜`6` で俯瞰のまま配るとき）
    const sel = this.ctx.selectedFront();
    if (sel !== 0 && sel !== this.slot) {
      this.slot = sel;
      this.lastTextMs = -1e9;
    }
    const f = this.slot >= 1 ? getFront(w, this.ctx.viewer, this.slot) : undefined;
    if (f !== undefined) this.tracker.observe(w, [f]);
    if (!this.open_) return;

    // 砂時計は毎フレーム（残り秒が滑らかに減る）
    this.updateHourglass(w, f ?? null);
    if (nowMs - this.lastTextMs < TEXT_INTERVAL_MS) return;
    this.lastTextMs = nowMs;
    this.rebuild();
    this.updateHeader(w, f ?? null);
  }

  destroy(): void {
    this.root.remove();
    this.cardNodes.clear();
    this.tracker.clear();
  }

  // ------------------------------------------------------------ 内部

  private rebuild(): OrderCard[] {
    const cards = buildOrderCards(this.ctx.world(), this.ctx.viewer, this.slot);
    this.current = cards;
    for (const c of cards) this.renderCard(c);
    // 並びをキー番号順に揃える（`QWER` 同様、**キーと並びが一対一**）
    for (const c of cards) {
      const node = this.cardNodes.get(c.order);
      if (node !== undefined) this.cardWrap.appendChild(node.root);
    }
    // 消えたカード（文明を変えたときなど）を畳む
    for (const [id, node] of [...this.cardNodes]) {
      if (cards.some((c) => c.order === id)) continue;
      node.root.remove();
      this.cardNodes.delete(id);
    }
    return cards;
  }

  private renderCard(c: OrderCard): void {
    let node = this.cardNodes.get(c.order);
    if (node === undefined) {
      const root = el('button', 'mt-card');
      root.type = 'button';
      const plate = el('div', 'mt-card-plate');
      const key = el('span', 'mt-card-key', String(c.key));
      const name = el('span', 'mt-card-name', c.name);
      plate.append(key, name);
      // 令のアイコン（M17）。**文字は焼き込んでいない**ので、名前は上の name が出す。
      // アセットが無い環境では `onerror` で自分を消すだけ（枠が空くより消えたほうがよい）。
      const icon = el('img', 'mt-card-icon') as HTMLImageElement;
      icon.alt = '';
      icon.addEventListener('error', () => icon.remove());
      icon.src = `assets/ui/order_${c.order}.webp`;
      const tier = el('div', 'mt-card-tier', TIER_LABEL[c.tier]);
      const note = el('div', 'mt-card-note', c.note);
      const state = el('div', 'mt-card-state', '');
      root.append(icon, plate, tier, note, state);
      root.addEventListener('click', () => this.pick(c.order));
      node = { root, plate, name, state };
      this.cardNodes.set(c.order, node);
      this.cardWrap.appendChild(root);
    }
    node.name.textContent = c.name;
    // 文明固有 = 名前プレートに金の縁（`05§8-8`）
    node.plate.style.borderColor = c.civUnique ? GOLD : 'transparent';
    node.root.classList.toggle('mt-card-unique', c.civUnique);
    // 選択中 = 光って前に出る（`05§8-7`）。**発効済みの令だけ**
    node.root.classList.toggle('mt-card-selected', c.selected);
    node.root.classList.toggle('mt-card-pending', c.pending);
    node.root.classList.toggle('mt-card-disabled', !c.enabled);
    node.root.disabled = !c.enabled;
    node.state.textContent = c.pending
      ? `${HOURGLASS_MARK} 伝達中`
      : c.selected
        ? 'セット済み'
        : '';
    node.root.title = c.enabled
      ? `${c.name}（${TIER_LABEL[c.tier]}） — ${c.note}`
      : `${c.name} — ${CARD_REASON_TEXT[c.reason]}`;
  }

  private updateHeader(w: World, f: Front | null): void {
    const slot = this.slot;
    this.titleFlag.textContent = slot >= 1 ? `${frontShape(slot)}${slot}` : '—';
    this.titleFlag.style.color = slot >= 1 ? frontColor(slot) : 'inherit';
    this.titleText.textContent =
      f === null ? '戦域を選んでください' : `戦域 ${slot} に令を渡す`;

    // 令スロット: 二重旗なら上下 2 段、そうでなければ上段のみ（`05§10`）
    const dual = hasDoubleFlag(w, this.ctx.viewer);
    this.tiers.classList.toggle('mt-cards-dual', dual);
    this.tierRows.lower.hidden = !dual;
    this.renderTierRow('upper', f?.order ?? null);
    if (dual) this.renderTierRow('lower', f?.orderLower ?? null);
  }

  private renderTierRow(tier: Tier, order: OrderId | null): void {
    const row = this.tierRows[tier];
    const name = order === null ? '（空き）' : (ORDER_DEFS.find((d) => d.id === order)?.name ?? '');
    row.textContent = `${TIER_LABEL[tier]}: ${name}`;
    row.classList.toggle('mt-cards-tier-empty', order === null);
  }

  private updateHourglass(w: World, f: Front | null): void {
    if (f === null || !f.active) {
      this.hourglass.hidden = true;
      return;
    }
    const st = hourglassState(
      hourglassInputFor(w, this.ctx.viewer, f, this.tracker.startOf(f.slot)),
    );
    if (st.kind === 'none') {
      this.hourglass.hidden = true;
      return;
    }
    this.hourglass.hidden = false;
    const sec = (st.remainMs / 1000).toFixed(1);
    this.hourglassText.textContent =
      st.kind === 'delay' ? `令が流れています 残り ${sec} 秒` : `次の令まで ${sec} 秒`;
    this.hourglassBar.style.width = `${Math.round(st.progress * 100)}%`;
    this.hourglass.classList.toggle('mt-cards-hourglass-delay', st.kind === 'delay');
  }
}

interface CardNode {
  readonly root: HTMLButtonElement;
  readonly plate: HTMLElement;
  readonly name: HTMLElement;
  readonly state: HTMLElement;
}
