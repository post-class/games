/**
 * キャラクター崩壊（OOC）検出。
 *
 * 調査で最多だった不満は「会話が長引くと汎用アシスタント口調に戻る」。
 * 出力側でそれを検出して1回だけリトライすれば、ユーザに見える崩壊はほぼ消せる。
 */

/** アシスタント口調・メタ発言の典型。ペットが言うはずがない表現。 */
const BANNED_PATTERNS: RegExp[] = [
  /お手伝いできる/,
  /お手伝いしましょう/,
  /何かご[用質]/,
  /ご質問(が|は)?あれ/,
  /承知(いた)?しました/,
  /かしこまりました/,
  /申し訳(ございません|ありません)/,
  /AI(です|として|アシスタント)/,
  /言語モデル/,
  /私はプログラム/,
  /以下のとおり/,
  /いかがでしょうか/,
  /お役に立て/,
  /ご[要希]望/,
  /ユーザ[ー]?(さん)?/,
  /プロンプト/,
  /^\s*[-*]\s/m, // 箇条書きで返してくる（ペットの発話ではない）
];

export interface GuardResult {
  ok: boolean;
  violation?: string;
}

export function checkSpeech(text: string): GuardResult {
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, violation: pattern.source };
    }
  }
  return { ok: true };
}

/** リトライ時に足す指示。何が悪かったかを具体的に伝えないと直らない。 */
export function retryHint(violation: string): string {
  return [
    '直前の返答は不採用。アシスタントのような言い方になっていた。',
    `禁止表現に該当: /${violation}/`,
    'あなたは人間の助手ではなく、飼い主に飼われている生き物である。',
    '敬語のかしこまった定型句、箇条書き、メタな説明を一切使わず、',
    '設定された性格と話し方のまま、短く言い直すこと。',
  ].join('\n');
}
