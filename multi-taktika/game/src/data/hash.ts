/**
 * data/hash.ts — マスターデータの指紋（リプレイの互換判定に使う）
 *
 * 手順書 §12: リプレイは「入力の記録」なので、**マスターデータが変わると
 * 同じ入力でも別の試合になる**。それを検出せずに再生すると
 * 「黙って別の試合を見せる」ことになるので、記録時のデータの指紋を持たせ、
 * 合わなければ再生を拒否する。
 *
 * ■ 何を指紋に含めるか
 * **試合結果に影響するファイルだけ**。`README.md` のような説明は含めない。
 * `_meta` や `~Note` のような注釈キーも**含める**: 注釈だけを直したときに
 * リプレイが読めなくなるのは煩わしいが、「含めない」を選ぶと
 * 「注釈のつもりで数値を直した」を取り逃がす。**安全側に倒す。**
 *
 * ■ なぜ 32bit ではなく 64bit 相当にするのか
 * 32bit だと 2^16 種類ほどのデータ変更で衝突が起きうる（誕生日問題）。
 * リプレイの互換判定を取り違えると「別の試合を再生する」という
 * いちばん嫌な失敗になるので、32bit を 2 本（別の初期値）で取って連結する。
 */

import configJson from './config.json' with { type: 'json' };
import resourcesJson from './resources.json' with { type: 'json' };
import unitsJson from './units.json' with { type: 'json' };
import buildingsJson from './buildings.json' with { type: 'json' };
import techsJson from './techs.json' with { type: 'json' };
import ordersJson from './orders.json' with { type: 'json' };
import civsJson from './civs.json' with { type: 'json' };
import mapsJson from './maps.json' with { type: 'json' };
import aiJson from './ai.json' with { type: 'json' };

const FNV_PRIME = 0x01000193;

/** FNV-1a。初期値を変えて 2 本取る。 */
function fnv1a(text: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // UTF-16 の下位・上位バイトを別々に混ぜる（日本語の注釈も指紋に効く）
    h = Math.imul(h ^ (c & 0xff), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((c >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * ファイルの並び順を固定する。
 * **順序を変えると指紋が変わる**ので、ファイルを足すときは末尾に足すこと
 * （途中に挿れると過去のリプレイが全部読めなくなる）。
 */
const FILES: readonly [string, unknown][] = [
  ['config.json', configJson],
  ['resources.json', resourcesJson],
  ['units.json', unitsJson],
  ['buildings.json', buildingsJson],
  ['techs.json', techsJson],
  ['orders.json', ordersJson],
  ['civs.json', civsJson],
  ['maps.json', mapsJson],
  ['ai.json', aiJson],
];

let cached: string | null = null;

/**
 * 今のマスターデータの指紋（16 進 16 桁）。
 *
 * `JSON.stringify` を使うので、**キーの並び順が変われば指紋も変わる**。
 * JSON ファイルのキー順は書いたとおりに保たれるため、これは意図どおり
 * （並べ替えただけでも「データが変わった」と判定される。安全側）。
 */
export function dataHash(): string {
  if (cached !== null) return cached;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const [name, json] of FILES) {
    const text = `${name}:${JSON.stringify(json)}`;
    a = fnv1a(text, a);
    b = fnv1a(text, b);
  }
  cached = (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  return cached;
}

/** テスト用。キャッシュを捨てる。 */
export function resetDataHashCache(): void {
  cached = null;
}
