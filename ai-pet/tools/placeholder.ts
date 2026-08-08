/**
 * プレースホルダアセット生成（`node tools/placeholder.ts`）
 *
 * 本番アセット（生成AI製の透過PNG / docs 08章）が揃うまで開発を止めないための仮素材を作る。
 *
 * === 形式の選択理由 ===
 * SVGではなく **PNGを自力でエンコード** する方式を選んだ。
 *  - Pixi の Assets.load は PNG が最も確実（SVGはラスタライズ解像度が環境依存で、
 *    ドット絵前提の nearest スケーリングと相性が悪い）
 *  - 本番アセットも透過PNGなので、差し替え時にコード側の変更が要らない
 *  - PNGエンコード自体は「フィルタ0の生スキャンライン + node:zlib の deflate」で数十行に収まる
 *
 * 依存パッケージは追加していない（node:zlib / node:fs のみ）。
 * 出力は決定論的（乱数を使わず、座標ハッシュだけで模様を作る）。
 *
 * 出力: packages/client/public/assets/placeholder/
 *   tile_{terrain}.png                  32x32 ×6
 *   tile_{terrain}_{0..3}.png           32x32 ×24（B-1 バリエーション）
 *   edge_{from}_{to}_{1..15}.png        32x32 ×60（B-2 遷移タイル / 4境界×15）
 *   player_{a..d}_{n|e|s|w}.png         48x48 ×4色（D-5）
 *   pet_{species}_{dir}.png             48x48 ×5種
 *   critter_{species}_{dir}.png         48x48 ×6種
 *   {pet|critter}_{species}_sleep.png   48x48 ×11（D-3 睡眠ポーズ / 方向なし）
 *   manifest.json                       生成物の一覧（デバッグ用）
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ==================== PNGエンコード ====================

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** RGBA8のピクセル配列をPNG（真彩色+アルファ / フィルタ0）にする */
function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const src = y * w * 4;
    const dst = y * (1 + w * 4);
    raw[dst] = 0; // filter type 0 = None
    raw.set(rgba.subarray(src, src + w * 4), dst + 1);
  }
  const ihdr = concat([
    u32(w),
    u32(h),
    new Uint8Array([8, 6, 0, 0, 0]), // bitDepth=8, colorType=6(RGBA), deflate, filter0, no interlace
  ]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// ==================== 描画ユーティリティ ====================

type RGB = readonly [number, number, number];

function hex(s: string): RGB {
  const v = Number.parseInt(s.replace('#', ''), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round((a[0] as number) + ((b[0] as number) - (a[0] as number)) * t),
    Math.round((a[1] as number) + ((b[1] as number) - (a[1] as number)) * t),
    Math.round((a[2] as number) + ((b[2] as number) - (a[2] as number)) * t),
  ];
}

const INK = hex('#4a3b2a');
const CREAM = hex('#fffdf3');

/** 座標から決定論的に0..1を作る（Math.random は使わない） */
function hash01(x: number, y: number, salt: number): number {
  let n = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x1f83, 0xc2b2ae35) ^ Math.imul(salt + 1, 0x27d4eb2f);
  n = Math.imul(n ^ (n >>> 15), 0x2545f491);
  return ((n ^ (n >>> 13)) >>> 0) / 0x100000000;
}

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }

  /** source-over 合成。coverage は 0..1 */
  blend(x: number, y: number, c: RGB, coverage: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const a = Math.max(0, Math.min(1, coverage));
    if (a <= 0) return;
    const i = (y * this.w + x) * 4;
    const da = (this.data[i + 3] as number) / 255;
    const outA = a + da * (1 - a);
    if (outA <= 0) return;
    for (let k = 0; k < 3; k++) {
      const src = c[k] as number;
      const dst = this.data[i + k] as number;
      this.data[i + k] = Math.round((src * a + dst * da * (1 - a)) / outA);
    }
    this.data[i + 3] = Math.round(outA * 255);
  }

  fill(c: RGB, alpha = 1): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.blend(x, y, c, alpha);
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGB, alpha = 1): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.blend(x, y, c, alpha);
  }

  /** 楕円（1pxのフェザー付き） */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 1): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        // 境界の1px相当をフェザーにする
        const feather = 1 / Math.min(rx, ry);
        const cov = Math.max(0, Math.min(1, (1 - d) / feather + 0.5));
        if (cov > 0) this.blend(x, y, c, cov * alpha);
      }
    }
  }

  disc(cx: number, cy: number, r: number, c: RGB, alpha = 1): void {
    this.ellipse(cx, cy, r, r, c, alpha);
  }

  /** 三角形（2x2スーパーサンプル） */
  triangle(p: readonly [number, number][], c: RGB, alpha = 1): void {
    const a = p[0] as [number, number];
    const b = p[1] as [number, number];
    const d = p[2] as [number, number];
    const minX = Math.floor(Math.min(a[0], b[0], d[0]));
    const maxX = Math.ceil(Math.max(a[0], b[0], d[0]));
    const minY = Math.floor(Math.min(a[1], b[1], d[1]));
    const maxY = Math.ceil(Math.max(a[1], b[1], d[1]));
    const sign = (px: number, py: number, q: [number, number], r: [number, number]): number =>
      (px - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (py - r[1]);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let hit = 0;
        for (const [ox, oy] of [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ] as const) {
          const px = x + ox;
          const py = y + oy;
          const s1 = sign(px, py, a, b);
          const s2 = sign(px, py, b, d);
          const s3 = sign(px, py, d, a);
          const neg = s1 < 0 || s2 < 0 || s3 < 0;
          const pos = s1 > 0 || s2 > 0 || s3 > 0;
          if (!(neg && pos)) hit++;
        }
        if (hit > 0) this.blend(x, y, c, (hit / 4) * alpha);
      }
    }
  }

  toPng(): Uint8Array {
    return encodePng(this.w, this.h, this.data);
  }
}

// ==================== 地形タイル ====================

const TILE_PX = 32;
/** 1地形あたりのバリエーション枚数（`render/tilemap.ts` の TILE_VARIANTS と同値） */
const TILE_VARIANTS = 4;

interface TerrainStyle {
  base: string;
  speck: string;
  accent: string;
  /** 'blade' 草の筋 / 'wave' 波 / 'blob' 茂み / 'grout' 石畳の目地 / 'none' */
  pattern: 'blade' | 'wave' | 'blob' | 'grout' | 'none';
}

const TERRAIN_STYLES: Record<string, TerrainStyle> = {
  grass: { base: '#d9ee94', speck: '#cbe783', accent: '#bfe06a', pattern: 'blade' },
  dirt: { base: '#cdae82', speck: '#c0a074', accent: '#b3906a', pattern: 'none' },
  sand: { base: '#f4e5b6', speck: '#ecd9a2', accent: '#e0c98a', pattern: 'none' },
  water: { base: '#9fd8ee', speck: '#8ccde8', accent: '#c9ecf8', pattern: 'wave' },
  forest: { base: '#a9d97e', speck: '#8cc45f', accent: '#6da84a', pattern: 'blob' },
  plaza: { base: '#efe1c2', speck: '#e7d6b2', accent: '#d3bd96', pattern: 'grout' },
};

/**
 * 地形タイルは「chunk焼成でタイル同士が隣り合う」前提なので、四辺に線を入れない。
 *
 * variant は B-1 のバリエーション番号。`-1` は従来の `tile_<terrain>.png`（後方互換）で、
 * そのときの模様は以前と同じになるよう salt を変えていない。
 */
function drawTile(name: string, st: TerrainStyle, variant = -1): Canvas {
  const cv = new Canvas(TILE_PX, TILE_PX);
  cv.fill(hex(st.base));
  // バリエーションごとに模様の種を変える（0 は基本タイルと同じ密度から始める）
  const vs = (variant + 1) * 17;
  const speckLimit = variant < 0 ? 0.86 : 0.86 - variant * 0.02;

  // まばらな斑点（タイルの繰り返し感を薄める）
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const r = hash01(x, y, name.length * 7 + 1 + vs);
      if (r > speckLimit) cv.blend(x, y, hex(st.speck), 0.55);
    }
  }

  if (st.pattern === 'blade') {
    for (let i = 0; i < 6 + Math.max(0, variant); i++) {
      const bx = Math.floor(hash01(i, 0, 11 + vs) * (TILE_PX - 4)) + 2;
      const by = Math.floor(hash01(i, 1, 12 + vs) * (TILE_PX - 6)) + 3;
      cv.rect(bx, by, 1, 3, hex(st.accent), 0.8);
      cv.rect(bx + 1, by + 1, 1, 2, hex(st.accent), 0.6);
    }
  } else if (st.pattern === 'wave') {
    for (let i = 0; i < 3; i++) {
      const wy = 5 + i * 10 + Math.floor(hash01(i, 3, 21 + vs) * 3);
      const wx = Math.floor(hash01(i, 4, 22 + vs) * 12) + 3;
      for (let k = 0; k < 12; k++) {
        cv.blend(wx + k, wy + (k % 4 === 2 ? 1 : 0), hex(st.accent), 0.9);
      }
    }
  } else if (st.pattern === 'blob') {
    for (let i = 0; i < 3; i++) {
      const bx = 6 + Math.floor(hash01(i, 5, 31 + vs) * 20);
      const by = 6 + Math.floor(hash01(i, 6, 32 + vs) * 20);
      const r = 4 + hash01(i, 7, 33 + vs) * 3;
      cv.disc(bx, by, r, hex(st.accent), 0.85);
      cv.disc(bx - 1, by - 1, r * 0.55, hex(st.speck), 0.5);
    }
  } else if (st.pattern === 'grout') {
    // 16pxの石畳。目地は右辺と下辺のみ（隣タイルと繋がる）。
    // 目地の位置はバリエーションでもずらさない（ずらすと石畳の格子が隣タイルで折れる）
    for (let y = 0; y < TILE_PX; y++) {
      cv.blend(15, y, hex(st.accent), 0.7);
      cv.blend(31, y, hex(st.accent), 0.7);
    }
    for (let x = 0; x < TILE_PX; x++) {
      cv.blend(x, 15, hex(st.accent), 0.7);
      cv.blend(x, 31, hex(st.accent), 0.7);
    }
  }
  return cv;
}

// ==================== 遷移タイル（B-2） ====================

/**
 * 遷移を入れる境界。`render/tilemap.ts` の `EDGE_PAIRS` と**同じ順・同じ向き**にすること。
 * このツールは pixi を読み込まないため（node直実行を軽く保つ）定義を二重に持っている。
 */
const EDGE_PAIRS: readonly (readonly [string, string])[] = [
  ['grass', 'sand'],
  ['sand', 'water'],
  ['grass', 'forest'],
  ['plaza', 'grass'],
  ['grass', 'dirt'],
  ['plaza', 'dirt'],
];

/** mask のビット（tilemap.ts の EDGE_N/E/S/W と同じ） */
const EDGE_BITS: readonly (readonly ['n' | 'e' | 's' | 'w', number])[] = [
  ['n', 1],
  ['e', 2],
  ['s', 4],
  ['w', 8],
];

/**
 * `edge_<from>_<to>_<mask>.png`。**from のタイルに重ねる透過素材**で、
 * mask で立っている辺から `to` 側の色が侵食してくる絵にする。
 *
 * 直線で切ると45度の階段が見えてしまうので、辺に沿って侵食の深さを揺らす
 * （揺らぎは座標ハッシュなので、何度生成しても同じ絵になる）。
 */
function drawEdgeTile(to: string, mask: number, st: TerrainStyle): Canvas {
  const cv = new Canvas(TILE_PX, TILE_PX);
  const cov = new Float64Array(TILE_PX * TILE_PX);

  for (const [dir, bit] of EDGE_BITS) {
    if ((mask & bit) === 0) continue;
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        // 辺に沿った座標（along）と、辺からの深さ（depth）
        const along = dir === 'n' || dir === 's' ? x : y;
        const depth = dir === 'n' ? y : dir === 's' ? TILE_PX - 1 - y : dir === 'w' ? x : TILE_PX - 1 - x;
        // 侵食の深さは 7..12px で揺れる。along だけで決めるので隣タイルとも繋がる
        const limit = 7 + hash01(along, bit, to.length * 3 + 1) * 5;
        if (depth >= limit) continue;
        const c = Math.min(1, limit - depth);
        const i = y * TILE_PX + x;
        if (c > (cov[i] as number)) cov[i] = c;
      }
    }
  }

  // 本体（to の地色）→ 内側の縁に accent を薄く載せて境目を見せる
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const c = cov[y * TILE_PX + x] as number;
      if (c <= 0) continue;
      cv.blend(x, y, hex(st.base), c);
      if (c < 0.75) cv.blend(x, y, hex(st.accent), (0.75 - c) * 0.7);
    }
  }
  return cv;
}

// ==================== キャラクター ====================

const CHAR_PX = 48;
type Dir = 'n' | 'e' | 's' | 'w';
const DIRS: readonly Dir[] = ['n', 'e', 's', 'w'];
const DIR_VEC: Record<Dir, readonly [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};

interface CharSpec {
  /** ファイル名の prefix（category_name） */
  key: string;
  color: string;
  /** 体の半径 */
  radius: number;
  /** 耳を描くか */
  ears: boolean;
}

const CHARS: readonly CharSpec[] = [
  // プレイヤー4色（D-5）。本番アセット `player_{a..d}_*.png` の服の色に合わせて
  // a=紫 / b=緑 / c=桃 / d=黄（是正プラン D-5 の「紫・緑・桃・黄」の順）
  { key: 'player_a', color: '#a892e0', radius: 15, ears: false },
  { key: 'player_b', color: '#a8e0b4', radius: 15, ears: false },
  { key: 'player_c', color: '#ffb9a3', radius: 15, ears: false },
  { key: 'player_d', color: '#ffcf7a', radius: 15, ears: false },
  // ペット5種（宣伝資料 images/pets.png のトーンに寄せた配色）
  { key: 'pet_mofi', color: '#ffeeba', radius: 13, ears: true },
  { key: 'pet_mizune', color: '#9fd8ee', radius: 13, ears: true },
  { key: 'pet_hakka', color: '#a8e0b4', radius: 13, ears: true },
  { key: 'pet_momona', color: '#ffb9a3', radius: 13, ears: true },
  { key: 'pet_hoshira', color: '#a892e0', radius: 13, ears: true },
  // 動物住民6種
  { key: 'critter_rabbit', color: '#fffdf3', radius: 10, ears: true },
  { key: 'critter_cat', color: '#f6c98a', radius: 10, ears: true },
  { key: 'critter_bird', color: '#9fc6ee', radius: 9, ears: false },
  { key: 'critter_frog', color: '#8fd48a', radius: 9, ears: false },
  { key: 'critter_squirrel', color: '#d79a63', radius: 10, ears: true },
  { key: 'critter_boar', color: '#b09a8a', radius: 11, ears: true },
];

/** 色違いの丸＋向きを示す三角。太い茶色の輪郭で宣伝資料のトーンに寄せる */
function drawChar(spec: CharSpec, dir: Dir): Canvas {
  const cv = new Canvas(CHAR_PX, CHAR_PX);
  const body = hex(spec.color);
  const outline = mix(INK, body, 0.15);
  const r = spec.radius;
  const cx = CHAR_PX / 2;
  // 足元をタイル下端に合わせる（アンカーは (0.5, 1.0) を想定）
  const cy = CHAR_PX - 8 - r;
  const [dx, dy] = DIR_VEC[dir];

  // 影
  cv.ellipse(cx, CHAR_PX - 5, r * 0.95, r * 0.34, INK, 0.18);

  // 耳（輪郭込み）
  if (spec.ears) {
    for (const sx of [-1, 1] as const) {
      const ex = cx + sx * r * 0.62;
      const ey = cy - r * 0.88;
      cv.disc(ex, ey, r * 0.36 + 2, outline);
      cv.disc(ex, ey, r * 0.36, body);
    }
  }

  // 体（輪郭 → 本体 → お腹のハイライト）
  cv.disc(cx, cy, r + 2, outline);
  cv.disc(cx, cy, r, body);
  cv.ellipse(cx, cy + r * 0.35, r * 0.62, r * 0.44, mix(body, CREAM, 0.55), 0.75);

  // 向きを示す三角（体の外側に飛び出す）
  const tipX = cx + dx * (r + 6);
  const tipY = cy + dy * (r + 6);
  const px = -dy;
  const py = dx;
  const baseX = cx + dx * (r - 1);
  const baseY = cy + dy * (r - 1);
  cv.triangle(
    [
      [tipX, tipY],
      [baseX + px * 5, baseY + py * 5],
      [baseX - px * 5, baseY - py * 5],
    ],
    outline,
  );
  cv.triangle(
    [
      [tipX - dx * 1.4, tipY - dy * 1.4],
      [baseX + px * 3.2 + dx, baseY + py * 3.2 + dy],
      [baseX - px * 3.2 + dx, baseY - py * 3.2 + dy],
    ],
    CREAM,
  );

  // 目（背中向き=nは描かない）
  if (dir !== 'n') {
    const shift = dir === 'e' ? r * 0.28 : dir === 'w' ? -r * 0.28 : 0;
    for (const sx of [-1, 1] as const) {
      cv.disc(cx + shift + sx * r * 0.34, cy - r * 0.12, Math.max(1.4, r * 0.14), INK);
    }
  }
  return cv;
}

/**
 * 睡眠ポーズ（D-3）。`<kind>_<species>_sleep.png` の仮素材。
 *
 * 宣伝資料 `images/screen-ecosystem.png` の夜側は「横に丸まって目を閉じた塊」なので、
 * **立ち絵より低く・横に広い**シルエットにする（立ち絵と一目で違いが分かることが仮素材の役目）。
 * 向きは持たない（丸まっているのでどの向きでも同じ）。
 */
function drawCharSleep(spec: CharSpec): Canvas {
  const cv = new Canvas(CHAR_PX, CHAR_PX);
  const body = hex(spec.color);
  const outline = mix(INK, body, 0.15);
  const r = spec.radius;
  const cx = CHAR_PX / 2;
  // 丸まると背が低くなるので、体の中心を立ち絵より下（足元 y=43 の近く）へ置く
  const cy = CHAR_PX - 6 - r * 0.62;

  // 接地影（立ち絵と同じ薄さ。潰れて寝ているので横に広い）
  cv.ellipse(cx, CHAR_PX - 4, r * 1.15, r * 0.3, INK, 0.18);

  // 体：横に広い楕円（輪郭 → 本体 → お腹のハイライト）
  cv.ellipse(cx, cy, r * 1.25 + 2, r * 0.72 + 2, outline);
  cv.ellipse(cx, cy, r * 1.25, r * 0.72, body);
  cv.ellipse(cx, cy + r * 0.28, r * 0.8, r * 0.3, mix(body, CREAM, 0.55), 0.7);

  // 頭は左に寄せて丸め込む（尻尾を右に置くので左右で読み分けられる）
  const hx = cx - r * 0.8;
  const hy = cy - r * 0.18;
  if (spec.ears) {
    // 耳は寝ているので後ろへ倒す
    for (const sx of [-0.45, 0.25] as const) {
      cv.disc(hx + sx * r, hy - r * 0.62, r * 0.3 + 2, outline);
      cv.disc(hx + sx * r, hy - r * 0.62, r * 0.3, body);
    }
  }
  cv.disc(hx, hy, r * 0.62 + 2, outline);
  cv.disc(hx, hy, r * 0.62, body);

  // 閉じた目（横線1本）。点で描くと起きているように見える
  cv.rect(Math.round(hx - r * 0.36), Math.round(hy - r * 0.06), Math.max(2, Math.round(r * 0.42)), 1, INK, 0.9);

  // 尻尾（右側に小さく添える）
  cv.ellipse(cx + r * 1.18, cy + r * 0.18, r * 0.36 + 2, r * 0.26 + 2, outline);
  cv.ellipse(cx + r * 1.18, cy + r * 0.18, r * 0.36, r * 0.26, body);
  return cv;
}

// ==================== 出力 ====================

// ==================== 設置物・資源 ====================

/**
 * 設置物のプレースホルダ。
 *
 * 本番アセット（`/assets/game/obj_*.png`）は M8 で生成済みだが、
 * **プレースホルダ側には obj_* が1枚も無かった**。そのため新しい種別を足すと
 * `ObjectTextureSet` が `Texture.EMPTY` に落ち、**何も描かれないまま気づけない**。
 * 「絵は雑でも必ず何か出る」状態にしておくために足した。
 *
 * 形は「胴体＋屋根/天面」の2要素だけで作る。細部は本番アセットの仕事。
 */
interface ObjectSpec {
  key: string;
  /** 胴体の色 */
  body: string;
  /** 上に載せるものの色（屋根・水面・葉など） */
  top: string;
  /** 上に載せるものの形 */
  topShape: 'roof' | 'disc' | 'none';
  /** 48px枠に対する胴体の幅・高さの割合 */
  bodyW: number;
  bodyH: number;
}

const OBJECTS: readonly ObjectSpec[] = [
  { key: 'berry_tree', body: '#a8825c', top: '#bfe06a', topShape: 'disc', bodyW: 0.16, bodyH: 0.34 },
  { key: 'field', body: '#a8825c', top: '#bfe06a', topShape: 'none', bodyW: 0.78, bodyH: 0.3 },
  { key: 'bench', body: '#c39a6b', top: '#a8825c', topShape: 'none', bodyW: 0.7, bodyH: 0.26 },
  { key: 'flowerbed', body: '#c39a6b', top: '#ffb9a3', topShape: 'disc', bodyW: 0.6, bodyH: 0.22 },
  { key: 'lantern', body: '#a8825c', top: '#ffcf7a', topShape: 'disc', bodyW: 0.12, bodyH: 0.44 },
  { key: 'signboard', body: '#a8825c', top: '#fffdf3', topShape: 'roof', bodyW: 0.12, bodyH: 0.4 },
  { key: 'well', body: '#b9b3c9', top: '#9fd8ee', topShape: 'disc', bodyW: 0.52, bodyH: 0.34 },
  { key: 'bridge', body: '#c39a6b', top: '#a8825c', topShape: 'none', bodyW: 0.94, bodyH: 0.24 },
  // 共同建設（G-1 / G-2）
  { key: 'observatory', body: '#cfc6dd', top: '#9fd8ee', topShape: 'roof', bodyW: 0.5, bodyH: 0.6 },
  { key: 'scaffold', body: '#d8c49a', top: '#a8825c', topShape: 'none', bodyW: 0.66, bodyH: 0.52 },
  // 暮らしの痕跡（C-1 / C-2）。屋根の色だけを変えて3軒を見分ける
  { key: 'house_a', body: '#d8c49a', top: '#a892e0', topShape: 'roof', bodyW: 0.62, bodyH: 0.42 },
  { key: 'house_b', body: '#d8c49a', top: '#ffb9a3', topShape: 'roof', bodyW: 0.62, bodyH: 0.42 },
  { key: 'house_c', body: '#e8dcb8', top: '#a8e0b4', topShape: 'roof', bodyW: 0.62, bodyH: 0.42 },
  { key: 'windmill', body: '#e8dcb8', top: '#c39a6b', topShape: 'roof', bodyW: 0.42, bodyH: 0.66 },
  { key: 'fountain', body: '#b9b3c9', top: '#9fd8ee', topShape: 'disc', bodyW: 0.6, bodyH: 0.26 },
  // 柵は1タイル=1枚。横向きは板が横に長く、縦向きは杭が縦に並ぶ
  { key: 'fence_h', body: '#c39a6b', top: '#a8825c', topShape: 'none', bodyW: 0.94, bodyH: 0.2 },
  { key: 'fence_v', body: '#c39a6b', top: '#a8825c', topShape: 'none', bodyW: 0.2, bodyH: 0.6 },
  // 動物が作る巣（C-3）。枯草を丸く積んだ低い寝床なので、
  // 平たい胴体（幅0.62 / 高さ0.16）＋草色の天面 disc で「窪み」に見せる
  { key: 'nest', body: '#c39a6b', top: '#a8825c', topShape: 'disc', bodyW: 0.62, bodyH: 0.16 },
];

function drawObject(spec: ObjectSpec): Canvas {
  const c = new Canvas(CHAR_PX, CHAR_PX);
  const body = hex(spec.body);
  const top = hex(spec.top);
  // 足元は他のアセットと同じ y=43 に合わせる（install-assets.py の規則）
  const baseY = 43;
  const bw = CHAR_PX * spec.bodyW;
  const bh = CHAR_PX * spec.bodyH;
  const x0 = Math.round((CHAR_PX - bw) / 2);
  const y0 = Math.round(baseY - bh);

  // 輪郭（1px外側に濃い茶）→ 胴体
  c.rect(x0 - 1, y0 - 1, Math.round(bw) + 2, Math.round(bh) + 2, INK, 1);
  c.rect(x0, y0, Math.round(bw), Math.round(bh), body, 1);

  if (spec.topShape === 'disc') {
    const r = CHAR_PX * 0.2;
    c.disc(CHAR_PX / 2, y0 - r * 0.35, r + 1, INK, 1);
    c.disc(CHAR_PX / 2, y0 - r * 0.35, r, top, 1);
  } else if (spec.topShape === 'roof') {
    const rw = bw * 1.5;
    c.triangle(
      [
        [CHAR_PX / 2, y0 - CHAR_PX * 0.2],
        [CHAR_PX / 2 - rw / 2, y0 + 1],
        [CHAR_PX / 2 + rw / 2, y0 + 1],
      ],
      INK,
      1,
    );
    c.triangle(
      [
        [CHAR_PX / 2, y0 - CHAR_PX * 0.2 + 2],
        [CHAR_PX / 2 - rw / 2 + 2, y0],
        [CHAR_PX / 2 + rw / 2 - 2, y0],
      ],
      top,
      1,
    );
  }

  // 足場（scaffold）だけは「まだ出来ていない」と分かるよう横木を渡す
  if (spec.key === 'scaffold') {
    for (let i = 1; i <= 2; i++) {
      const y = Math.round(y0 + (bh * i) / 3);
      c.rect(x0 - 2, y, Math.round(bw) + 4, 2, INK, 1);
    }
  }
  return c;
}

// ==================== 装飾デカール ====================

/**
 * 地面の装飾（B-3）。`render/tilemap.ts` の `DECAL_SETS` に出てくる名前と一致させること。
 *
 * 32px枠の中に小さく描く。実表示は 16px（`DECAL_PX = TILE_PX * 0.5`）なので、
 * ここでは中央に寄せて余白を残す。
 */
interface DecalSpec {
  key: string;
  /** 主色 */
  color: string;
  /** 形 */
  shape: 'tuft' | 'flower' | 'pebble' | 'leaf' | 'mushroom' | 'shell';
}

const DECALS: readonly DecalSpec[] = [
  { key: 'grass_tuft', color: '#a8c25a', shape: 'tuft' },
  { key: 'flower_white', color: '#fffdf3', shape: 'flower' },
  { key: 'flower_yellow', color: '#ffe878', shape: 'flower' },
  { key: 'flower_pink', color: '#ffb9a3', shape: 'flower' },
  { key: 'pebble', color: '#b9b3a6', shape: 'pebble' },
  { key: 'leaf', color: '#c9a05c', shape: 'leaf' },
  { key: 'mushroom', color: '#e39a8c', shape: 'mushroom' },
  { key: 'shell', color: '#f3e2cd', shape: 'shell' },
];

function drawDecal(spec: DecalSpec): Canvas {
  const c = new Canvas(TILE_PX, TILE_PX);
  const col = hex(spec.color);
  const cx = TILE_PX / 2;
  const cy = TILE_PX / 2;

  if (spec.shape === 'tuft') {
    // 3本の草。輪郭は付けない（小さすぎて潰れる）
    for (const [dx, h] of [
      [-4, 8],
      [0, 11],
      [4, 7],
    ] as const) {
      c.triangle(
        [
          [cx + dx, cy - h],
          [cx + dx - 2, cy + 2],
          [cx + dx + 2, cy + 2],
        ],
        col,
        1,
      );
    }
    return c;
  }
  if (spec.shape === 'flower') {
    // 花びら4枚＋芯
    for (const [dx, dy] of [
      [0, -3],
      [3, 0],
      [0, 3],
      [-3, 0],
    ] as const) {
      c.disc(cx + dx, cy + dy, 2.6, col, 1);
    }
    c.disc(cx, cy, 1.6, hex('#ffe878'), 1);
    return c;
  }
  if (spec.shape === 'pebble') {
    c.ellipse(cx, cy, 4.5, 3.2, INK, 1);
    c.ellipse(cx, cy, 3.6, 2.4, col, 1);
    return c;
  }
  if (spec.shape === 'leaf') {
    c.ellipse(cx, cy, 5, 2.6, col, 1);
    return c;
  }
  if (spec.shape === 'mushroom') {
    c.rect(cx - 1, cy, 3, 5, CREAM, 1);
    c.ellipse(cx + 0.5, cy, 4.4, 3.2, col, 1);
    return c;
  }
  // shell
  c.ellipse(cx, cy, 4.2, 4.2, col, 1);
  c.rect(cx - 1, cy - 4, 2, 8, INK, 0.35);
  return c;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'packages', 'client', 'public', 'assets', 'placeholder');
mkdirSync(outDir, { recursive: true });

const written: string[] = [];

function emit(file: string, png: Uint8Array): void {
  writeFileSync(join(outDir, file), png);
  written.push(file);
}

// 地形（TERRAINS の順序と揃える）
for (const name of ['grass', 'dirt', 'sand', 'water', 'forest', 'plaza']) {
  const st = TERRAIN_STYLES[name];
  if (!st) continue;
  emit(`tile_${name}.png`, drawTile(name, st).toPng());
  // B-1 バリエーション（4枚）。本番アセットが揃うまでの繰り返し感の緩和
  for (let v = 0; v < TILE_VARIANTS; v++) {
    emit(`tile_${name}_${v}.png`, drawTile(name, st, v).toPng());
  }
}

// B-2 遷移タイル（mask=0 は描くものが無いので作らない）
for (const [from, to] of EDGE_PAIRS) {
  const st = TERRAIN_STYLES[to];
  if (!st) continue;
  for (let mask = 1; mask <= 15; mask++) {
    emit(`edge_${from}_${to}_${mask}.png`, drawEdgeTile(to, mask, st).toPng());
  }
}

// キャラ
for (const spec of CHARS) {
  for (const dir of DIRS) {
    emit(`${spec.key}_${dir}.png`, drawChar(spec, dir).toPng());
  }
  // 睡眠ポーズ（D-3）。プレイヤーには作らない（操作中のアバターに sleep は来ない）
  if (!spec.key.startsWith('player_')) {
    emit(`${spec.key}_sleep.png`, drawCharSleep(spec).toPng());
  }
}

// 設置物・資源
for (const spec of OBJECTS) {
  emit(`obj_${spec.key}.png`, drawObject(spec).toPng());
}

// 装飾デカール
for (const spec of DECALS) {
  emit(`decal_${spec.key}.png`, drawDecal(spec).toPng());
}

written.sort();
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ tilePx: TILE_PX, charPx: CHAR_PX, files: written }, null, 2) + '\n',
);

console.log(`[placeholder] ${written.length} files -> ${outDir}`);
