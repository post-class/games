/**
 * render/ctx.ts — 描画先の最小インターフェース
 *
 * `CanvasRenderingContext2D` をそのまま引数の型にすると、
 * DOM の無い環境（Vitest の node 環境）で描画層の単体テストが書けない。
 * ここで**実際に使うメソッドだけ**を宣言しておくと、
 *  - 本番: `canvas.getContext('2d')` がそのまま構造的に適合する
 *  - テスト: 呼び出し回数を数える偽の ctx を渡せる
 * の両方が型安全に成立する（手順書 T-M5-02 の計測を DOM 無しで行うため）。
 *
 * **メソッドを増やすときは必ずこの表に足す**（テストの偽 ctx が落ちて気付ける）。
 */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  /**
   * 拡大時に補間するか。
   * 霧（`fogLayer`）は「1 マス = 1 px の小さな画像」を拡大して重ねるので、
   * これを true にするとぼかし（手順書 §7.2「ぼかしたマスク」）も同時に得られる。
   * 地形キャッシュの貼り付けは false（1:1 コピーなので補間は不要・にじむだけ）。
   */
  imageSmoothingEnabled: boolean;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  /** 現在の変換に掛ける（霧の菱形変換に使う。`save`/`restore` で挟む）。 */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  /** 変換を置き換える（オフスクリーン面の初期化に使う）。 */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;

  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;

  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;

  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/** オフスクリーンのコピー元にできるもの（地形キャッシュ）。 */
export interface BlitTarget extends Ctx2D {
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
}
