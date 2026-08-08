/**
 * 記念撮影（G-3）
 *
 * 宣伝資料 `docs/01_ゲーム宣伝用資料/index.html` の
 * 「おでかけ：友だちの区画へ遊びに行き、記念撮影」のうち、**記念撮影だけ**を実装する。
 * 「友だちの区画」は設計に無い概念（プレイヤーごとの土地という考えが無い）なので作らない。
 *
 * ## 設計の判断
 *
 * - 撮る対象は Pixi の canvas。`renderer.extract.canvas()` で取り出す。
 *   **HUDはDOMなので写らない**が、これは好都合（宣伝資料の画面イメージにも操作UIは写っていない）
 * - ⚠️ そのまま保存すると「ただのスクリーンショット」で記念写真にならないので、
 *   canvas 2d で**枠とキャプションを焼き込む**（`composePhoto`）。
 *   焼き込む材料（島日・季節・時間帯・ペットの名前）は `deps.caption()` から受け取る
 * - `main.ts` は配線の集約点で衝突しやすいので、**依存は注入**にした（`SnapshotDeps`）。
 *   `capture` の中身（`renderer` をどう触るか）は呼び出し側の責任
 * - 撮影用のライブラリは足さない。初回ロード5MB以内という完了条件があるため、
 *   PNG化はブラウザの `canvas.toBlob()` だけで済ませている
 * - 文字の組み立て・折返し・ファイル名は**純粋関数**に切り出してテストしている
 *   （描画そのものは Node の vitest（environment: 'node'）では検証できないため）
 *
 * ## 落とし穴
 *
 * - **`.hud` に `pointer-events: none` が掛かっている**（AI_CODING §7）。
 *   親に `#hud` を渡されてもクリックが canvas に取られないよう、ボタン側で `auto` を明示する
 * - `URL.createObjectURL` は**必ず revoke** する。ただしクリック直後に revoke すると
 *   ブラウザによってダウンロードが始まる前に無効化されるので、少し遅らせて解放し、
 *   `destroy()` でも取りこぼしを解放する
 * - 置き場所は**左の中ほど**。右下は設置ボタン（`touchPad`）と丸ボタン（`actionButtons`）、
 *   左下はチャット欄、上中央は `buildPanel`／案内バナーで埋まっている（CSSは `style.css`）
 *
 * 制約: parameter property 禁止 / enum 禁止 / 相対import は `.ts` 込み
 */

/** 島の名前。焼き込むキャプションの主題 */
export const ISLAND_NAME = 'ぽこもふ島';

/** 焼き込む文字の材料 */
export interface CaptionInfo {
  islandDay: number;
  /** `Season`（'spring' など）。未知の値はそのまま出す */
  season: string;
  /** `TimeOfDay`（'morning' など）。未知の値はそのまま出す */
  timeOfDay: string;
  petName: string;
}

export interface SnapshotDeps {
  /** Pixi の canvas を PNG の元になる canvas にする。main.ts が renderer を渡す */
  capture: () => Promise<HTMLCanvasElement | null>;
  /** 焼き込む文字の材料 */
  caption: () => CaptionInfo;
  onSaved?: (fileName: string) => void;
  /** 失敗を伝える（通知欄に出す用）。既定は console だけ */
  onError?: (err: unknown) => void;
  /** テスト用の時計。既定は `new Date()` */
  now?: () => Date;
}

// ---------- 純粋関数（テスト対象） ----------

const SEASON_JA: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const TOD_JA: Record<string, string> = { morning: '朝', day: '昼', evening: '夕方', night: '夜' };

/** 季節の日本語。HUDの表記（`main.ts` の `SEASON_LABEL`）と同じ字を使う */
export function seasonLabel(season: string): string {
  return SEASON_JA[season] ?? season;
}

/**
 * 時間帯の日本語。
 * HUDは1文字（朝/昼/夕/夜）だが、写真は「夏の夕方」と読ませたいので「夕方」にしている。
 */
export function timeOfDayLabel(timeOfDay: string): string {
  return TOD_JA[timeOfDay] ?? timeOfDay;
}

/** 2桁ゼロ埋め（時刻用） */
function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

/**
 * 保存するファイル名。
 * 「あとから見て何の写真か分かる」ことを優先し、島日と撮った時刻（実時間）を入れる。
 * 同じ島日に何枚撮っても分の単位で分かれる。
 */
export function snapshotFileName(islandDay: number, at: Date): string {
  // 壊れた値（NaN や負）でもファイル名が崩れないように丸める
  const day = Number.isFinite(islandDay) ? Math.max(0, Math.floor(islandDay)) : 0;
  return `pokomofu-${day}日目-${pad2(at.getHours())}${pad2(at.getMinutes())}.png`;
}

/**
 * 写真の下に出す説明文。
 * 「いつ・誰と」が1行で読めるように詰めている（島の名前は上の行に大きく出すので入れない）。
 */
export function captionSubtitle(info: CaptionInfo): string {
  const day = Number.isFinite(info.islandDay) ? Math.max(0, Math.floor(info.islandDay)) : 0;
  const when = `${seasonLabel(info.season)}の${timeOfDayLabel(info.timeOfDay)}`;
  const name = info.petName.trim() === '' ? 'ペット' : info.petName;
  return `${day}日目 ・ ${when} ・ ${name}といっしょ`;
}

/**
 * 説明文を枠幅で折返す。
 *
 * 日本語は単語の区切りが無いので**1文字ずつ**詰める。
 * `measure` を引数にしたのは、実描画では `ctx.measureText` を使いつつ
 * テストでは固定幅の関数を渡せるようにするため（Node には canvas が無い）。
 * 入り切らないときは最終行を三点リーダで切る（枠からはみ出すより読めなくても短いほうがよい）。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines = 2,
): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of [...text]) {
    const next = cur + ch;
    // 1文字も置けない幅でも無限に行が増えないよう、空行のときは必ず1文字入れる
    if (cur !== '' && measure(next) > maxWidth) {
      if (lines.length >= maxLines - 1) {
        let trimmed = [...cur];
        while (trimmed.length > 1 && measure(`${trimmed.join('')}…`) > maxWidth) trimmed.pop();
        lines.push(`${trimmed.join('')}…`);
        return lines;
      }
      lines.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
  }
  lines.push(cur);
  return lines;
}

/** 写真の余白・帯・文字サイズ（すべてピクセル） */
export interface PhotoLayout {
  /** 写真のまわりの余白（下だけ帯のぶん広い） */
  pad: number;
  /** 外枠の線の太さ */
  border: number;
  /** 外枠の角丸 */
  radius: number;
  titleSize: number;
  subSize: number;
}

/**
 * 撮った大きさから枠の寸法を決める。
 *
 * スマホ（390px幅）とPC（1280px幅）で同じ絶対値を使うと、
 * スマホでは枠が太すぎ、PCでは文字が小さすぎる。**短辺に比例**させて両方で同じ見え方にする。
 * 上限を付けているのは、大きな画面で枠だけが太くなるのを防ぐため。
 */
export function photoLayout(width: number, height: number): PhotoLayout {
  const short = Math.max(1, Math.min(width, height));
  const clamp = (v: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, v)));
  return {
    pad: clamp(short * 0.032, 10, 26),
    border: clamp(short * 0.012, 4, 10),
    radius: clamp(short * 0.05, 14, 34),
    titleSize: clamp(short * 0.055, 16, 34),
    subSize: clamp(short * 0.034, 11, 20),
  };
}

/** 帯（説明文）の高さ。行数で変わるので分けている */
export function captionBandHeight(layout: PhotoLayout, subLineCount: number): number {
  return Math.round(layout.titleSize * 1.34 + subLineCount * layout.subSize * 1.45 + layout.pad * 0.5);
}

// ---------- 描画（ブラウザのみ） ----------

// 04_スタイルガイド.md のパレット。CSS変数はcanvasから読めないので値を持つ
const C_CREAM = '#fffdf3';
const C_INK = '#4a3b2a';
const C_INK_SOFT = '#6f5c44';
const C_PURPLE = '#a892e0';
/** CSS（style.css）と同じ字面にする。丸ゴシックが無い環境ではsans-serifに落ちる */
const FONT_STACK =
  '"Hiragino Maru Gothic ProN", "ヒラギノ丸ゴ ProN", "Zen Maru Gothic", "Hiragino Sans", "Yu Gothic", sans-serif';

/** 角丸の矩形パス（`roundRect` が無い環境でも動くように自前で引く） */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 撮った canvas に枠と説明を焼き込んで「記念写真」にする。
 *
 * 見た目（宣伝資料のトーン: `--cream` の紙に `--ink` の太い角丸枠）:
 * ```
 * ┌───────────────────────┐
 * │  ┌─────────────────┐  │  ← cream の余白 + ink の太い角丸枠
 * │  │   撮った画面      │  │
 * │  └─────────────────┘  │
 * │  ぽこもふ島            │  ← 太字・ink
 * │  3日目 ・ 夏の夕方 ・ もふといっしょ │  ← ink-soft（入り切らなければ2行で折返し）
 * └───────────────────────┘
 * ```
 */
export function composePhoto(src: HTMLCanvasElement, info: CaptionInfo): HTMLCanvasElement | null {
  const w = src.width;
  const h = src.height;
  if (w <= 0 || h <= 0) return null;

  const out = document.createElement('canvas');
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  const L = photoLayout(w, h);
  const innerW = w; // 写真はそのままの大きさで置く（縮めると字が読めなくなる）

  // 帯の高さを決めるために先に折返しを確定させる。
  // 幅0のcanvasでも measureText は使えるので、サイズを決める前に測ってよい
  ctx.font = `${L.subSize}px ${FONT_STACK}`;
  const subLines = wrapText(captionSubtitle(info), innerW, (s) => ctx.measureText(s).width, 2);
  const band = captionBandHeight(L, subLines.length);

  out.width = w + L.pad * 2;
  out.height = h + L.pad + band;

  // ⚠️ canvas のサイズを変えると 2d コンテキストの状態（font 等）は初期化される。
  // ここから設定し直す
  ctx.fillStyle = C_CREAM;
  ctx.fillRect(0, 0, out.width, out.height);

  // 写真本体
  ctx.drawImage(src, L.pad, L.pad, innerW, h);

  // 写真の縁（細い線）。地面の色と紙の色が近いと境目が消えるので必ず引く
  ctx.strokeStyle = C_INK;
  ctx.lineWidth = Math.max(2, Math.round(L.border * 0.5));
  ctx.strokeRect(
    L.pad - ctx.lineWidth / 2,
    L.pad - ctx.lineWidth / 2,
    innerW + ctx.lineWidth,
    h + ctx.lineWidth,
  );

  // 外枠（太い角丸）
  ctx.strokeStyle = C_INK;
  ctx.lineWidth = L.border;
  roundRectPath(ctx, L.border / 2, L.border / 2, out.width - L.border, out.height - L.border, L.radius);
  ctx.stroke();

  // 説明文
  const textX = L.pad;
  let y = h + L.pad + Math.round(L.titleSize * 0.98);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_INK;
  ctx.font = `700 ${L.titleSize}px ${FONT_STACK}`;
  ctx.fillText(ISLAND_NAME, textX, y);

  // 島の名前の右に小さな紫の丸を添える（宣伝資料のアクセント色。無いと帳票のように見える）
  const dotR = Math.max(3, Math.round(L.titleSize * 0.14));
  ctx.fillStyle = C_PURPLE;
  ctx.beginPath();
  ctx.arc(textX + ctx.measureText(ISLAND_NAME).width + dotR * 2.2, y - L.titleSize * 0.3, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = C_INK_SOFT;
  ctx.font = `${L.subSize}px ${FONT_STACK}`;
  for (const line of subLines) {
    y += Math.round(L.subSize * 1.45);
    ctx.fillText(line, textX, y);
  }

  return out;
}

/** canvas を PNG の Blob にする。`toBlob` は非同期なので Promise で包む */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

// ---------- アイコン ----------
// 絵文字は端末ごとに形が変わるのでSVGで描く（actionButtons.ts / petGauge.ts と同じ方針）

const ICON_CAMERA =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<g stroke="#4a3b2a" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">' +
  '<path d="M3.2 8.4h3.1l1.5-2.2h8.4l1.5 2.2h3.1v10.4H3.2z" fill="#a892e0"/>' +
  '<circle cx="12" cy="13.4" r="3.6" fill="#fffdf3"/>' +
  '<circle cx="12" cy="13.4" r="1.5" fill="#9fd8ee"/>' +
  '<circle cx="18.6" cy="10.6" r="0.9" fill="#ffb9a3" stroke="none"/>' +
  '</g></svg>';

// ---------- 本体 ----------

export class SnapshotButton {
  private deps: SnapshotDeps;
  private root: HTMLElement;
  private btn: HTMLButtonElement;
  private now: () => Date;
  /** 撮影中の二度押しを防ぐ（extract と toBlob で数フレームかかる） */
  private busy = false;
  /** まだ revoke していない ObjectURL と、その解放タイマー */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  /**
   * @param parent 既定は `body`。`#hud` を渡してもよいが、
   *   `.hud` は `pointer-events: none` なのでボタン側で `auto` を明示している
   */
  constructor(deps: SnapshotDeps, parent?: HTMLElement | null) {
    this.deps = deps;
    this.now = deps.now ?? ((): Date => new Date());

    this.root = document.createElement('div');
    this.root.className = 'snapshot';
    this.root.dataset['testid'] = 'snapshot';
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'snap-btn';
    this.btn.dataset['testid'] = 'snap-btn';
    this.btn.title = '記念さつえい（いまの画面を保存）';
    this.btn.setAttribute('aria-label', '記念さつえい');
    this.btn.innerHTML = ICON_CAMERA;
    this.root.appendChild(this.btn);
    (parent ?? document.body).appendChild(this.root);

    this.btn.addEventListener('click', () => {
      void this.shoot();
    });
  }

  /**
   * いまの画面を1枚のPNGとして保存する。
   * 成功したらファイル名を返す（失敗・撮影中は null）。
   */
  async shoot(): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    this.btn.disabled = true;
    try {
      const src = await this.deps.capture();
      if (!src) return null;
      const info = this.deps.caption();
      const photo = composePhoto(src, info);
      if (!photo) return null;
      const blob = await canvasToPngBlob(photo);
      if (!blob) return null;

      const fileName = snapshotFileName(info.islandDay, this.now());
      this.download(blob, fileName);
      this.flash();
      this.deps.onSaved?.(fileName);
      return fileName;
    } catch (err) {
      // 撮影の失敗でゲームを止めない（WebGLの文脈喪失などで extract が投げ得る）
      console.warn('[snapshot] 撮影に失敗しました', err);
      this.deps.onError?.(err);
      return null;
    } finally {
      this.busy = false;
      this.btn.disabled = false;
    }
  }

  /** ペットが居ないとき（タマゴ選択中）は隠す */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  destroy(): void {
    // 取りこぼした ObjectURL をここで必ず解放する
    for (const [url, timer] of this.pending) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    this.pending.clear();
    this.root.remove();
  }

  /**
   * `<a download>` で保存する。
   * ⚠️ クリック直後に revoke するとブラウザによってはダウンロードが始まる前に無効化されるため、
   * 少し待ってから解放する（`destroy()` でも取りこぼしを解放する）。
   */
  private download(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    const timer = setTimeout(() => {
      this.pending.delete(url);
      URL.revokeObjectURL(url);
    }, 10_000);
    this.pending.set(url, timer);
  }

  /**
   * 「撮れた」ことを分かるようにする一瞬の白い閃光。
   * ダウンロードはブラウザのUIに出るだけで画面上は無反応に見えるため、手応えを足している。
   * 動きを嫌う設定（`prefers-reduced-motion`）ではCSS側でアニメーションを止めている。
   */
  private flash(): void {
    const el = document.createElement('div');
    el.className = 'snap-flash';
    document.body.appendChild(el);
    const kill = (): void => el.remove();
    el.addEventListener('animationend', kill);
    // アニメーションが走らない環境（reduced-motion）でも残らないように保険を掛ける
    setTimeout(kill, 700);
  }
}
