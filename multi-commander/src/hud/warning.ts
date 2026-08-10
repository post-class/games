/**
 * 警告を「何が起きたか」＋「どうするか」の2行にする (T2-⑧)。
 *
 * `hud/damageStage.ts` の `damageStageLabel()` / `damageStageAdvice()` と同じ流儀。
 * 段階名だけを出して「で、何をすればいいのか」を書かない警告をなくすため、
 * **文言の対応表をここ一箇所**に置く。
 */

/** 2行に分けた警告文。`how` が空なら1行で出す。 */
export interface WarningText {
  /** 何が起きたか */
  what: string;
  /** どうするか (指示) */
  how: string;
}

/**
 * 「何が起きたか」→「どうするか」の対応表。
 *
 * 鍵は `bus.emit('announce', ...)` が出す文そのまま。
 * 出所 (MissionRunner / Game) の文言を書き換えずに、指示だけを足せるようにしている。
 */
const ADVICE: ReadonlyArray<[string, string]> = [
  ['安全窓が閉じた', '発砲すると共鳴パルスが止まる'],
  ['共鳴パルス停止 — 機雷が起きている', '機雷から離れ、発砲をやめて窓の再開を待つ'],
  ['衝突警報 — 進路上に岩', '進路を変えるか減速する'],
  ['機雷 — 進路上', '進路を変えて機雷から離れる'],
  ['誓約が破られた — 決闘は終わった', 'エースは容赦しない — 単騎の追撃をやめる'],
  ['局所重力 — 機体が重い', '早めに舵を入れる — 曲がりきれない'],
  ['局所重力 — 機体が軽い', '当て舵を早めに — 流されやすい'],
  ['通信機が故障している', '僚機への指示は出せない — 単独で判断する'],
  ['オートパイロット不可', '敵を片付けるか、戦域から離れる'],
];

/** 発射できない理由を、原因の分かる言い方へ寄せる (既存の言い換え表)。 */
export function readableAnnouncement(text: string): string {
  if (text === 'ロックしていない') return '発射不可 — ロック未完了';
  if (text === 'ミサイル切れ') return '発射不可 — 弾切れ';
  if (text === '対艦魚雷は大型目標を選択してください') return '発射不可 — 魚雷は大型目標のみ';
  return text;
}

/** 警告の区切り。`—` の後ろを「どうするか」として読ませる。 */
const SEPARATOR = ' — ';

/**
 * 警告文を2行に分ける。
 *
 * 1. 対応表にあれば、その指示を2行目にする
 * 2. 無ければ `—` で切って前半／後半に分ける (`発射不可 — ロック未完了` など)
 * 3. どちらでもなければ1行のまま (`how` は空)
 */
export function warningText(raw: string): WarningText {
  const text = readableAnnouncement(raw);
  const hit = ADVICE.find(([what]) => what === text);
  if (hit) return { what: hit[0], how: hit[1] };
  const at = text.indexOf(SEPARATOR);
  if (at > 0) {
    return { what: text.slice(0, at), how: text.slice(at + SEPARATOR.length) };
  }
  return { what: text, how: '' };
}
