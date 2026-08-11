/**
 * 酒場のカメラ（本家 Wing Commander の「話しかけると寄る」二人芝居）の計算。
 *
 * DOM に触らない純関数だけを置く。カメラのバグはほぼ全部ここで捕まるので、
 * 単体テスト（`tests/ut/t10-bar-camera.test.ts`）はこのファイルを直接叩く。
 *
 * 座標系は「部屋（stage）の中の未変形座標」。`BarScene` の席テーブルと同じ
 * 「左端からの % / 下端からの % / 高さ %」で受け取り、`transform` に入れる
 * `scale` と `translate`（px）を返す。CSS 側は `transform-origin: 0 0` で使う。
 */

/** 席1つぶんの位置。`BarScene` の `SPOTS` と同じ形 */
export interface BarSpot {
  /** 立ち絵の中心の x（stage 幅に対する %） */
  x: number;
  /** 足元の y（stage 下端からの %） */
  bottom: number;
  /** 立ち絵の高さ（stage 高さに対する %） */
  height: number;
}

/** 覗き窓（stage）の実寸 */
export interface BarView {
  w: number;
  h: number;
}

export interface BarCameraTransform {
  scale: number;
  /** px。`transform: translate(tx, ty) scale(s)` の並びで使う */
  tx: number;
  ty: number;
}

/**
 * 寄れる上限。
 *
 * 立ち絵の原寸は高さ 900px。1280×720 で stage は約 385px なので、
 * いちばん大きい席（高さ 74%）でも 285px 表示 → 2.4 倍で 684px と原寸に収まる。
 * これを超えると拡大が粗として見えるので、ここで頭を打たせる。
 */
export const BAR_ZOOM_MAX = 2.4;

/**
 * 立ち絵のどの高さを「顔」として見るか（足元＋高さ×この値）。
 * 立ち絵は腰までなので、上寄りの 0.82 が顔の位置になる。
 */
const FACE_AT = 0.82;

/** 主役を画面のどこへ置くか（0..1）。左寄せにして聞き手を右に残す */
const DEFAULT_ANCHOR_X = 0.38;
const DEFAULT_ANCHOR_Y = 0.44;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * 注目点を画面の `anchor` に置く transform を返す。
 *
 * `scale` は `BAR_ZOOM_MAX` で頭打ちにし、`translate` は部屋の外側が
 * 見えないようにクランプする（縁に黒が出ない）。
 */
export function barCameraTransform(
  spot: BarSpot,
  view: BarView,
  o: { scale: number; anchorX?: number; anchorY?: number },
): BarCameraTransform {
  const scale = clamp(o.scale, 1, BAR_ZOOM_MAX);
  const anchorX = o.anchorX ?? DEFAULT_ANCHOR_X;
  const anchorY = o.anchorY ?? DEFAULT_ANCHOR_Y;

  // 注目点（未変形の px）
  const px = (view.w * spot.x) / 100;
  const py = (view.h * (100 - (spot.bottom + spot.height * FACE_AT))) / 100;

  // transform-origin: 0 0 なので、注目点を anchor へ運ぶ平行移動はこの式になる
  let tx = view.w * anchorX - scale * px;
  let ty = view.h * anchorY - scale * py;

  // 部屋の縁より外を見せない
  tx = clamp(tx, view.w - scale * view.w, 0);
  ty = clamp(ty, view.h - scale * view.h, 0);

  return { scale, tx, ty };
}

/** 引いた状態（部屋の全景）。 */
export function barCameraWide(): BarCameraTransform {
  return { scale: 1, tx: 0, ty: 0 };
}

/**
 * 2人を同時に収めるカメラ。
 *
 * 掛け合い（同席2名）では二人とも当事者なので、中点を見て倍率を1段落とす。
 */
export function barCameraPair(
  a: BarSpot,
  b: BarSpot,
  view: BarView,
  scale: number,
): BarCameraTransform {
  const mid: BarSpot = {
    x: (a.x + b.x) / 2,
    bottom: (a.bottom + b.bottom) / 2,
    height: (a.height + b.height) / 2,
  };
  return barCameraTransform(mid, view, { scale, anchorX: 0.5 });
}

/** `transform` の文字列。CSS の `transform-origin: 0 0` と対で使う */
export function barCameraCss(t: BarCameraTransform): string {
  return `translate(${t.tx.toFixed(1)}px, ${t.ty.toFixed(1)}px) scale(${t.scale.toFixed(3)})`;
}

/**
 * 見回す順番。**左にいる人から右へ**。
 *
 * 席の並びではなく画面上の x で並べるので、←→ の移動が見た目と一致する。
 * 同じ x（同席2名）は渡された順（左→右）を保つ。
 */
export function barFocusOrder(
  entries: ReadonlyArray<{ pilotId: string; x: number }>,
): string[] {
  return entries
    .map((e, i) => ({ ...e, i }))
    .sort((p, q) => p.x - q.x || p.i - q.i)
    .map((e) => e.pilotId);
}

/** 巡回して次の相手を選ぶ。端では反対側へ回る */
export function barNextFocus(
  order: readonly string[],
  current: string | undefined,
  dir: -1 | 1,
): string | undefined {
  if (order.length === 0) return undefined;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(at + dir + order.length) % order.length];
}
