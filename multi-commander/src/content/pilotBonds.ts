/**
 * 隊員同士の相関（T8-①）。
 *
 * ■ なぜ必要か
 * これまで飛行隊の8名は、**全員がプレイヤーとだけ**関わっていた。
 * `RosterState.relations`（隊員同士の関係値）は `applySortie` で増減していたのに、
 * 画面のどこにも出ず、会話にも効かなかった。つまり「隣に座っている二人が
 * 互いをどう思っているか」がゲーム内に存在しなかった。
 *
 * このファイルは、その**固定の下敷き**を与える。誰と誰が師弟で、誰と誰が
 * 反りが合わないのかを先に決めておき、酒場の同席（`src/app/barSeats.ts`）と
 * 掛け合い（`src/content/barBanter.ts`）がそれを引く。
 *
 * ■ 固定値と変動値の分担
 * - **固定**（このファイル）: 関係の種類・二人の間にある出来事・呼び方。
 *   キャンペーンを通じて変わらない。人物設定そのものなので `content/` に置く。
 * - **変動**（`RosterState.relations`）: いま二人の仲がどうなっているか（-1..+1）。
 *   出撃結果と酒場での介入で動く。保存データ側なので `app/roster.ts` が持つ。
 *
 * ■ 難易度には一切効かせない
 * `AI_CODING.md` の「4状態は難易度を動かさない」と同じ扱いにする。相関が変わっても
 * 敵のHP・攻撃力・出現数は変えない。変えるのは**酒場の会話・名簿の表示・無線の口調**だけ。
 */

import { PILOTS } from './pilots';

/** 相関の種類。 */
export type PilotBondKind =
  /** 師弟。片方が教える側。 */
  | 'mentor'
  /** 好敵手。撃墜数と流儀を競っている。 */
  | 'rival'
  /** 相棒。役割が噛み合っていて、実務で信頼している。 */
  | 'pair'
  /** 不和。飛び方の前提が食い違い、互いの計画を壊してきた。 */
  | 'friction'
  /** 喪失の共有。同じ人を見送った二人。 */
  | 'loss'
  /** 旧同僚。昔は同じ隊にいた。 */
  | 'past';

export interface PilotBondKindInfo {
  label: string;
  /** 名簿・酒場に出す短い説明。 */
  desc: string;
  /**
   * 掛け合いへ割り込んだときの効果の重み。
   *
   * `side` は「片方に味方する」、`defuse` は「二人をなだめる」。
   * 種類ごとに、どちらの介入が響くかを変える（不和は仲裁が効き、
   * 好敵手はどちらかに肩入れした方が響く）。
   */
  weight: { side: number; defuse: number };
}

export const PILOT_BOND_KINDS: Record<PilotBondKind, PilotBondKindInfo> = {
  mentor: { label: '師弟', desc: '片方が教え、片方が追いかけている。', weight: { side: 0.9, defuse: 1.2 } },
  rival: { label: '好敵手', desc: '流儀が違うまま、数を競っている。', weight: { side: 1.3, defuse: 0.8 } },
  pair: { label: '相棒', desc: '役割が噛み合っている。言葉が少なくて済む。', weight: { side: 0.8, defuse: 1.3 } },
  friction: { label: '不和', desc: '互いの計画を壊してきた。同席すると声が硬い。', weight: { side: 1.2, defuse: 1.5 } },
  loss: { label: '喪失の共有', desc: '同じ人を見送った。その名前を口に出せる相手が互いしかいない。', weight: { side: 0.7, defuse: 1.4 } },
  past: { label: '旧同僚', desc: '昔は同じ隊にいた。別れた理由を、まだ話していない。', weight: { side: 1.0, defuse: 1.1 } },
};

/** 座る場所。酒場の席割り（`src/app/barSeats.ts`）が使う。 */
export type BarSeatKind = 'counter' | 'table' | 'pool';

export interface PilotBond {
  /** 二人の id。`a` が話し始める側（師弟なら教える側）。 */
  a: string;
  b: string;
  kind: PilotBondKind;
  /** 二人の関係を一行で。名簿と酒場の見出しに出す。 */
  title: string;
  /** 何があったのか。名簿の詳細に出す。 */
  history: string;
  /** 同席しているときに好む場所。 */
  seat: BarSeatKind;
}

/**
 * 飛行隊の相関（10本）。
 *
 * 8名それぞれが**最低2本**持つようにしてある。誰を僚機に選んでも、
 * 酒場に戻ったときに「その人と繋がっている別の誰か」が反応する。
 *
 * 並びは意味を持たない（`bondBetween` は順序を問わない）。
 */
export const PILOT_BONDS: readonly PilotBond[] = [
  {
    a: 'sable',
    b: 'raven',
    kind: 'friction',
    title: '持ち場を離れない者と、囮に出る者',
    history:
      'Raven が独断で囮に出るたび、Sable の護衛線に穴が空く。三度目に護衛対象の輸送艇が被弾してから、二人は作戦前の打ち合わせをしなくなった。',
    seat: 'pool',
  },
  {
    a: 'aster',
    b: 'solace',
    kind: 'mentor',
    title: '解析官と、まだ数えるほどしか撃っていない救難艇乗り',
    history:
      'Aster は Solace の飛行記録を毎回勝手に読んで、赤で書き込んで返す。「機体は替えが効く。お前は効かない」は、この一人に向けて言い続けている言葉である。',
    seat: 'table',
  },
  {
    a: 'tempest',
    b: 'orion',
    kind: 'rival',
    title: '距離を詰める者と、詰めさせない者',
    history:
      '同じ日に着任し、同じ数だけ落としてきた。Tempest は「当てに行く」と言い、Orion は「当たる位置で待つ」と言う。撃墜数はいまも数機差で入れ替わり続けている。',
    seat: 'counter',
  },
  {
    a: 'vesper',
    b: 'sable',
    kind: 'loss',
    title: '名前を数える者と、席を片付けられない者',
    history:
      '前の配置で同じ僚機を失った。Vesper はその名を名簿に書き、Sable はその席をまだ空けたままにしている。二人はその名前を、互いの前でだけ声に出す。',
    seat: 'table',
  },
  {
    a: 'nova',
    b: 'tempest',
    kind: 'past',
    title: '突撃隊を降りた者と、まだ残っている者',
    history:
      'Nova はかつて Tempest の突撃艇隊にいた。ある封鎖線突破のあと偵察へ移り、理由をいまも説明していない。Tempest は聞かないし、Nova は言わない。',
    seat: 'counter',
  },
  {
    a: 'vesper',
    b: 'orion',
    kind: 'pair',
    title: '目を潰す者と、撃つ者',
    history:
      'Vesper が敵の索敵を落とし、Orion がその数秒で当てる。この連携で二人合わせて十七機。作戦中の無線は「入る」「見えた」の二語で済む。',
    seat: 'counter',
  },
  {
    a: 'raven',
    b: 'solace',
    kind: 'pair',
    title: '落ちる側と、拾う側',
    history:
      'Raven は二度撃墜され、二度とも Solace の救難艇に拾われた。Raven は礼を言わないが、出撃前に必ず Solace の機の外装を叩いていく。',
    seat: 'pool',
  },
  {
    a: 'aster',
    b: 'tempest',
    kind: 'friction',
    title: '記録する者と、記録される者',
    history:
      'Aster は Tempest の独断交戦を、艦の記録に一件ずつ残している。処分を求めたことは一度もない。「いつか要る」と言うだけで、Tempest はそれを脅しと受け取っている。',
    seat: 'table',
  },
  {
    a: 'nova',
    b: 'solace',
    kind: 'mentor',
    title: '一人で帰ってくる技術',
    history:
      'Nova が Solace に教えているのは撃ち方ではなく、単独で航路を割り出して戻る手順だ。「助ける側が帰れなかったら、助けた意味がない」が理由である。',
    seat: 'table',
  },
  {
    a: 'sable',
    b: 'orion',
    kind: 'pair',
    title: '守る位置と、撃つ位置',
    history:
      '護衛の Sable が動かないから、迎撃の Orion は射線を計算できる。二人は互いを名前で呼ばず、担当宙域の番号で呼ぶ。それで足りている。',
    seat: 'counter',
  },
];

/** `a`,`b` の順序を問わない鍵。`RosterState.relations` の鍵と同じ作り方。 */
export function bondKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

const BY_KEY = new Map<string, PilotBond>(PILOT_BONDS.map((b) => [bondKey(b.a, b.b), b]));

/** 二人の間の固定相関。無ければ `undefined`（相関を持たない組み合わせもある）。 */
export function bondBetween(a: string, b: string): PilotBond | undefined {
  return a === b ? undefined : BY_KEY.get(bondKey(a, b));
}

/** その人が持つ相関すべて。 */
export function bondsOf(id: string): PilotBond[] {
  return PILOT_BONDS.filter((b) => b.a === id || b.b === id);
}

/** 相関の相手の id。`bond` に含まれない id を渡したら `undefined`。 */
export function bondPartner(bond: PilotBond, id: string): string | undefined {
  return bond.a === id ? bond.b : bond.b === id ? bond.a : undefined;
}

/**
 * 相関の見出しを「Aコールサイン × Bコールサイン — 種類」の形で返す。
 *
 * コールサインの出所は `pilots.ts`（＝人物名簿）なので、ここでは複製しない。
 */
export function bondHeadline(bond: PilotBond): string {
  const call = (id: string) => PILOTS.find((p) => p.id === id)?.callsign ?? id;
  return `${call(bond.a)} × ${call(bond.b)} — ${PILOT_BOND_KINDS[bond.kind].label}`;
}

/**
 * 相関の現在値（`RosterState.relations` の -1..+1）を段階の言葉にする。
 *
 * `relationStage`（プレイヤーとの関係）とは別の尺度なので、語も分けてある
 * （プレイヤー相手は「不信/初対面/…」、隊員同士は「決裂/…/背中を預ける」）。
 */
export const BOND_LEVELS = ['決裂', '険悪', '平行線', '噛み合っている', '背中を預ける'] as const;

export interface BondLevel {
  label: string;
  step: number;
  max: number;
}

export function bondLevel(value: number): BondLevel {
  const max = BOND_LEVELS.length - 1;
  const v = Number.isFinite(value) ? value : 0;
  const step = v < -0.45 ? 0 : v < -0.12 ? 1 : v < 0.15 ? 2 : v < 0.5 ? 3 : 4;
  return { label: BOND_LEVELS[step], step, max };
}

/**
 * 開発時の整合性チェック。名簿に無い id や重複したペアを早期に落とす。
 * （テストから呼ぶ。実行時の経路では呼ばない。）
 */
export function validatePilotBonds(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const ids = new Set(PILOTS.map((p) => p.id));
  for (const bond of PILOT_BONDS) {
    if (!ids.has(bond.a)) errors.push(`unknown pilot in bond: ${bond.a}`);
    if (!ids.has(bond.b)) errors.push(`unknown pilot in bond: ${bond.b}`);
    if (bond.a === bond.b) errors.push(`bond with self: ${bond.a}`);
    const key = bondKey(bond.a, bond.b);
    if (seen.has(key)) errors.push(`duplicated bond: ${key}`);
    seen.add(key);
  }
  for (const p of PILOTS) {
    if (bondsOf(p.id).length < 2) errors.push(`pilot has fewer than 2 bonds: ${p.id}`);
  }
  return errors;
}
