/**
 * ui/hud/desync.ts — デシンク検出の表示（T-M14-06。`07§12` / 手順書 §4.5）
 *
 * ■ 資料が要求していること
 *  - 250 tick（10 秒）ごとに状態ハッシュを突き合わせ、
 *    **不一致なら即座に「デシンク検出」を UI に出して試合を停止する**（手順書 §4.5）
 *  - **「どちらが正しいか」は決めない。** 中継サーバはゲームロジックを持たないので
 *    判定できない（`07§12` / `server/relay.ts` 冒頭）。だから画面に出すのは
 *      「どの tick で / 誰と誰が / どんな値が違ったか」
 *    の 3 点だけで、「あなたが正しい」も「相手が正しい」も**書かない**。
 *
 * ■ なぜ止めるのか
 * ずれたまま続けると、以降の画面は「自分にだけ見える幻の試合」になる。
 * 勝敗も戦域も相手と食い違うので、続けるより止めた方が損害が小さい。
 *
 * ■ テスト方針（`tests/unit/net.desync.test.ts`）
 * vitest の environment は `node`（DOM なし）なので、**判定と文面は純関数**
 * （`describeDesync`）に出し、DOM を触るのは `DesyncOverlay` だけにしてある。
 */

import { formatHash } from '@/sim';

/** サーバから来たデシンク通知（`net` の `DesyncInfo` と同じ形。net を import しないため再定義）。 */
export interface DesyncNotice {
  readonly tick: number;
  /** playerId → 状態ハッシュ（32bit）。 */
  readonly hashes: Readonly<Record<number, number>>;
}

/** 1 人ぶんの表示行。 */
export interface DesyncRow {
  readonly playerId: number;
  readonly name: string;
  /** 16 進 8 桁（`formatHash`）。 */
  readonly hash: string;
  /** 自分か（「あなた」と添えるだけ。**正しい側という意味ではない**）。 */
  readonly isLocal: boolean;
}

/** 画面に出す内容。 */
export interface DesyncView {
  readonly title: string;
  /** 「どの tick で」。 */
  readonly tick: number;
  /** 何秒目か（tick / 25。表示だけに使う）。 */
  readonly atSeconds: number;
  /** 「誰と誰が / どんな値が違ったか」。playerId 昇順。 */
  readonly rows: readonly DesyncRow[];
  /** ハッシュの値ごとに分かれた陣営（**多数派を正解にしない**ための情報）。 */
  readonly groups: readonly { readonly hash: string; readonly playerIds: readonly number[] }[];
  /** 本文（「どちらが正しいかは分かりません」を必ず含む）。 */
  readonly lines: readonly string[];
}

/** 1 秒あたりの tick 数（表示のためだけに使う。`sim` の TICK_RATE と同値）。 */
const TICKS_PER_SEC = 25;

/**
 * 通知を画面の文面に直す（純関数）。
 *
 * **「正しい側」を返さない**のが仕様。多数派・少数派も並べるだけで、
 * どちらかを勝ちにする情報は 1 つも作らない。
 */
export function describeDesync(
  notice: DesyncNotice,
  opts?: { readonly localPlayerId?: number; readonly names?: Readonly<Record<number, string>> },
): DesyncView {
  const localId = opts?.localPlayerId ?? -1;
  const names = opts?.names ?? {};
  const ids = Object.keys(notice.hashes)
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);

  const rows: DesyncRow[] = ids.map((playerId) => ({
    playerId,
    name: names[playerId] ?? `P${playerId}`,
    hash: formatHash(notice.hashes[playerId] ?? 0),
    isLocal: playerId === localId,
  }));

  // ハッシュ値ごとにまとめる。並びは「16 進文字列の昇順」で全順序に固定する
  // （`Map` の挿入順に見せ方を預けない。§0.3）。
  const byHash = new Map<string, number[]>();
  for (const r of rows) {
    const list = byHash.get(r.hash);
    if (list === undefined) byHash.set(r.hash, [r.playerId]);
    else list.push(r.playerId);
  }
  const groups = [...byHash.entries()]
    .map(([hash, playerIds]) => ({ hash, playerIds: [...playerIds].sort((a, b) => a - b) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const lines = [
    `tick ${notice.tick}（約 ${Math.floor(notice.tick / TICKS_PER_SEC)} 秒）で状態が食い違いました。`,
    '同じ入力から違う結果が出ているため、ここで試合を止めます。',
    'どちらの端末が正しいかは分かりません（中継サーバは試合の計算をしていないので判定できません）。',
    'このまま続けると、あなたの画面と相手の画面は別の試合になります。',
  ];

  return {
    title: 'デシンク検出 — 試合を停止しました',
    tick: notice.tick,
    atSeconds: Math.floor(notice.tick / TICKS_PER_SEC),
    rows,
    groups,
    lines,
  };
}

/** 食い違っている陣営が 2 つ以上あるか（1 つなら通知が誤り）。 */
export function isRealDesync(notice: DesyncNotice): boolean {
  const values = Object.keys(notice.hashes).map((k) => notice.hashes[Number.parseInt(k, 10)] ?? 0);
  if (values.length < 2) return false;
  const first = values[0]!;
  return values.some((v) => v !== first);
}

// ---------------------------------------------------------------- DOM

/**
 * 画面に貼る停止パネル。
 *
 * **HUD の位置は動かさない**（`05§1`）ので、これは HUD の上に重なる
 * オーバーレイとして中央に出す。閉じる手段は出さない（止まったことが要点なので）。
 */
export class DesyncOverlay {
  private readonly root: HTMLElement;
  private readonly box: HTMLElement;
  private shownView: DesyncView | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'mt-desync';
    this.root.hidden = true;
    this.box = document.createElement('div');
    this.box.className = 'mt-desync-box';
    this.root.appendChild(this.box);
    parent.appendChild(this.root);
  }

  /** 表示中か。 */
  get visible(): boolean {
    return this.shownView !== null;
  }

  /** 表示中の内容（テストと親の目視確認用）。 */
  get view(): DesyncView | null {
    return this.shownView;
  }

  /** 通知を受けたら即座に出す（2 回目以降は無視。最初のずれが原因に最も近い）。 */
  show(
    notice: DesyncNotice,
    opts?: { readonly localPlayerId?: number; readonly names?: Readonly<Record<number, string>> },
  ): void {
    if (this.shownView !== null) return;
    const view = describeDesync(notice, opts);
    this.shownView = view;

    this.box.textContent = '';
    this.box.appendChild(text('h2', 'mt-desync-title', view.title));
    for (const line of view.lines) this.box.appendChild(text('p', 'mt-desync-line', line));

    const table = document.createElement('div');
    table.className = 'mt-desync-table';
    table.appendChild(text('div', 'mt-desync-head', `tick ${view.tick} の状態ハッシュ`));
    for (const r of view.rows) {
      const row = document.createElement('div');
      row.className = 'mt-desync-row';
      row.appendChild(text('span', 'mt-desync-name', r.isLocal ? `${r.name}（あなた）` : r.name));
      row.appendChild(text('span', 'mt-desync-hash', `0x${r.hash}`));
      table.appendChild(row);
    }
    this.box.appendChild(table);

    // 「誰と誰が」= 値ごとに分かれた陣営。順に並べるだけで、どれが正解とも書かない。
    const groupLine = view.groups
      .map((g) => `0x${g.hash}: ${g.playerIds.map((p) => `P${p}`).join(', ')}`)
      .join(' / ');
    this.box.appendChild(text('p', 'mt-desync-groups', `食い違い: ${groupLine}`));

    this.root.hidden = false;
  }

  destroy(): void {
    this.root.remove();
  }
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}
