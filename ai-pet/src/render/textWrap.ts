/**
 * 吹き出しの折り返し。
 *
 * 文字幅の測り方を関数で受け取ることで Canvas に依存しない。
 * こうしておくと、折り返しと禁則処理だけを単体テストできる。
 */

/**
 * 行頭に来てはいけない文字（禁則処理）。
 * これを入れないと「おなかぺこぺこで／、さみしかった」のように
 * 句読点が行頭に落ちて、日本語として不自然に見える。
 */
const NO_LINE_START = '、。，．」』）〕｝】〉》！？ー…・';

export type MeasureText = (text: string) => number;

/** 日本語は単語境界がないので1文字ずつ測って折り返す。 */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    if (char === '\n') {
      lines.push(current);
      current = '';
      continue;
    }
    const candidate = current + char;
    const overflows = measure(candidate) > maxWidth && current.length > 0;
    // あふれても、行頭に置けない文字なら現在行にぶら下げる。
    if (overflows && !NO_LINE_START.includes(char)) {
      lines.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}
