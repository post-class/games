/**
 * 生成した透過 PNG のアセット。
 *
 * 機体や戦域の 3D は手続き生成のままで、ここで扱うのは UI の紋章類だけ。
 * 実体は `public/art/` にあり、`.tmp/prep_art.py` で
 * 「透明ノイズの除去 → 外接矩形で切り抜き → 表示サイズへ縮小」を通してある。
 */

export type ArtId =
  | 'title-crest'
  | 'emblem-confed'
  | 'emblem-kilrathi'
  | 'emblem-carrier'
  | 'patch-squadron'
  | 'icon-briefing'
  | 'icon-hangar'
  | 'icon-bar'
  | 'icon-barracks'
  | 'icon-killboard'
  | 'icon-launch'
  | 'radar-bezel'
  | 'panel-corner'
  | 'dash-trim';

/** アセットの URL。base が './' なので相対で解決させる */
export function artUrl(id: ArtId | string, ext: 'png' | 'jpg' | 'webp' = 'png'): string {
  return `${import.meta.env.BASE_URL}art/${id}.${ext}`;
}

/** 勲章の絵。id は MEDALS の id と一対一 */
export function medalArt(medalId: string): string {
  return artUrl(`medal-${medalId}`);
}

/** 階級章の絵。id は RANKS の id と一対一 */
export function rankArt(rankId: string): string {
  return artUrl(`rank-${rankId}`);
}

/** `<img>` を1つ返す。装飾なので読み込み失敗しても画面は壊さない */
export function artImg(
  src: string,
  o: { alt?: string; className?: string; height?: number; width?: number } = {},
): string {
  const cls = o.className ? ` class="${o.className}"` : '';
  const h = o.height ? ` height="${o.height}"` : '';
  const w = o.width ? ` width="${o.width}"` : '';
  // 生成物が欠けていても崩れないよう、失敗したら自分を隠す
  return (
    `<img src="${src}" alt="${o.alt ?? ''}"${cls}${h}${w} loading="lazy" ` +
    `onerror="this.style.display='none'">`
  );
}
