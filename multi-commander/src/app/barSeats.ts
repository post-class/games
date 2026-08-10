import { bondBetween, bondKey, PILOT_BONDS, type BarSeatKind, type PilotBond } from '../content/pilotBonds';
import { relationBetween, type PilotState, type RosterState } from './roster';

/**
 * 酒場の席割り（T8-①）。
 *
 * ■ なぜ席が必要か
 * 以前の酒場は隊員の**一次元のリスト**だった。全員が等距離に並んでいて、
 * 誰が誰と一緒にいるのかが表現できなかった。『Wing Commander: Prophecy』の
 * Rec Room がやっていたのは逆で、部屋に入ると**すでに固まっている連中がいる**。
 * 誰の隣に誰が座っているかそのものが、隊の状態の説明になっていた。
 *
 * このモジュールは、その「入った瞬間の光景」を組み立てる。
 * 相関（`src/content/pilotBonds.ts`）を持つ二人を同席させ、余った者を一人席へ置く。
 *
 * ■ 決定論
 * **乱数を使わない。** 同じ名簿・同じ関係値なら必ず同じ席割りになる。
 * 画面を開き直すたびに席が入れ替わると、「さっき二人で話していた奴らが消えた」
 * ように見えてしまう（`barTalk.ts` が rng を避けているのと同じ理由）。
 * 揺らぎが要るところだけ、呼び出し側が渡す `seed` で決める。
 */

/**
 * 席の並び順と見え方。順番はそのまま画面の左から右になる。
 *
 * `note` は**1行で収まる長さに保つ**こと。4席を横一列に並べているので、
 * ここが2行になると 4 席ぶん背が伸びて、噂の節までパネル内スクロールが出る。
 */
export const BAR_SEAT_SLOTS = [
  { id: 'counter', kind: 'counter' as BarSeatKind, label: 'カウンター', note: '酒保の正面。' },
  { id: 'table-1', kind: 'table' as BarSeatKind, label: '窓際のテーブル', note: '舷窓に〈ヴェイル〉。' },
  { id: 'table-2', kind: 'table' as BarSeatKind, label: '奥のテーブル', note: '照明が一段落ちている。' },
  { id: 'pool', kind: 'pool' as BarSeatKind, label: 'ビリヤード台', note: '球は磁石で止まる。' },
] as const;

export type BarSeatId = (typeof BAR_SEAT_SLOTS)[number]['id'];

export interface BarSeat {
  id: BarSeatId;
  kind: BarSeatKind;
  label: string;
  note: string;
  /** そこにいる隊員（1名なら一人席、2名なら同席） */
  occupants: PilotState[];
  /** 同席の理由になっている固定相関（一人席なら undefined） */
  bond?: PilotBond;
  /** 二人の現在の仲 -1..+1（`bond` があるときだけ） */
  relation?: number;
}

/** 席割りの結果。席に着けなかった者は `standing`（立ち飲み）へ回る。 */
export interface BarSeatPlan {
  seats: BarSeat[];
  standing: PilotState[];
}

/**
 * 同席ペアの優先順位。
 *
 * **仲が良い順ではなく、「いま話が起きている順」で並べる。**
 * 険悪な二人が同じ台にいる方が、噛み合っている二人より場に緊張がある。
 * だから `|relation|`（仲の振れ幅）が大きい方を優先し、次に直前の出撃に
 * 関わった側、最後に定義順で決める（同点でも順序がぶれないように）。
 */
function pairPriority(
  bond: PilotBond,
  relation: number,
  index: number,
  wingmanId: string | undefined,
): number {
  const drama = Math.abs(relation) * 100;
  const involved = wingmanId && (bond.a === wingmanId || bond.b === wingmanId) ? 60 : 0;
  // index は小さいほど先。定義順を最後の決定要素にする。
  return drama + involved - index * 0.01;
}

/**
 * 酒場の席割りを作る。
 *
 * @param roster    名簿
 * @param options   `wingmanId` は直前の出撃で一緒に飛んだ僚機（同席の優先度が上がる）。
 *                  `seed` は一人席の割り当ての揺らぎ（同じ帰艦の間は変わらない値を渡す）。
 */
export function seatPlan(
  roster: RosterState,
  options: { wingmanId?: string; seed?: number } = {},
): BarSeatPlan {
  const present = roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded');
  const byId = new Map(present.map((p) => [p.id, p]));
  const seed = Math.trunc(options.seed ?? 0);

  // ① 両方が艦内にいる相関を拾い、優先順位で並べる
  const candidates = PILOT_BONDS.map((bond, index) => ({
    bond,
    index,
    relation: relationBetween(roster, bond.a, bond.b),
  }))
    .filter((c) => byId.has(c.bond.a) && byId.has(c.bond.b))
    .sort(
      (x, y) =>
        pairPriority(y.bond, y.relation, y.index, options.wingmanId) -
        pairPriority(x.bond, x.relation, x.index, options.wingmanId),
    );

  // ② 上から順に、一人1回だけ同席させる
  const used = new Set<string>();
  const pairs: Array<{ bond: PilotBond; relation: number }> = [];
  for (const c of candidates) {
    if (used.has(c.bond.a) || used.has(c.bond.b)) continue;
    used.add(c.bond.a);
    used.add(c.bond.b);
    pairs.push({ bond: c.bond, relation: c.relation });
  }

  // ③ ペアを席へ置く。まず相関が好む席（`bond.seat`）へ、埋まっていれば空いている席へ。
  const seats: BarSeat[] = BAR_SEAT_SLOTS.map((slot) => ({
    id: slot.id,
    kind: slot.kind,
    label: slot.label,
    note: slot.note,
    occupants: [],
  }));
  const seatOf = (id: BarSeatId) => seats.find((s) => s.id === id)!;
  const free = () => seats.filter((s) => s.occupants.length === 0);

  for (const pair of pairs) {
    const preferred = seats.find((s) => s.kind === pair.bond.seat && s.occupants.length === 0);
    const target = preferred ?? free()[0];
    if (!target) break; // 席が足りない分は立ち飲みへ
    target.occupants = [byId.get(pair.bond.a)!, byId.get(pair.bond.b)!];
    target.bond = pair.bond;
    target.relation = pair.relation;
  }

  // ④ 余った者を空席へ一人ずつ。seed で開始位置をずらすので、
  //    帰艦のたびに「今日はカウンターに一人で座っている」相手が変わる。
  const solo = present.filter((p) => !used.has(p.id));
  const empties = free();
  if (empties.length > 0) {
    const offset = ((seed % empties.length) + empties.length) % empties.length;
    solo.forEach((p, i) => {
      if (i >= empties.length) return;
      seatOf(empties[(offset + i) % empties.length].id).occupants = [p];
    });
  }

  const seated = new Set(seats.flatMap((s) => s.occupants.map((p) => p.id)));
  return { seats, standing: present.filter((p) => !seated.has(p.id)) };
}

/** 同席しているペア（掛け合いに割り込める席）だけを取り出す。 */
export function banterSeats(plan: BarSeatPlan): BarSeat[] {
  return plan.seats.filter((s) => s.occupants.length === 2 && s.bond);
}

/**
 * その席にいる二人の掛け合いを識別する鍵。`BanterState.bondKey` と揃える。
 * 席の id ではなく**二人の組み合わせ**で持つので、席が変わっても会話は続く。
 */
export function seatBondKey(seat: BarSeat): string | undefined {
  return seat.bond ? bondKey(seat.bond.a, seat.bond.b) : undefined;
}

/**
 * ある隊員が「いま誰と同席しているか」。
 * 名簿画面（自室）で、相関の相手が艦内にいるかを出すのに使う。
 */
export function seatmateOf(plan: BarSeatPlan, pilotId: string): PilotState | undefined {
  const seat = plan.seats.find((s) => s.occupants.some((p) => p.id === pilotId));
  if (!seat || seat.occupants.length < 2) return undefined;
  return seat.occupants.find((p) => p.id !== pilotId);
}

/**
 * 二人の間に固定相関があるかを、名簿の外から確認する薄い橋渡し。
 * UI 側が `pilotBonds.ts` を直接 import しなくても済むようにしてある。
 */
export { bondBetween };
