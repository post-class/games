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
 *   player_a_{n|e|s|w}.png              48x48
 *   pet_{species}_{dir}.png             48x48 ×5種
 *   critter_{species}_{dir}.png         48x48 ×6種
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
  // プレイヤー
  { key: 'player_a', color: '#ffb9a3', radius: 15, ears: false },
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

// ==================== 出力 ====================

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
}

written.sort();
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ tilePx: TILE_PX, charPx: CHAR_PX, files: written }, null, 2) + '\n',
);

console.log(`[placeholder] ${written.length} files -> ${outDir}`);
