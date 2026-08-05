import { findItem } from '../../shared/items.js';
import type { RoomLayout } from '../../shared/types.js';
import {
  SPOTS,
  WORLD_SCREENS,
  ZONE_RANGES,
  zoneRange,
  type Spot,
  type SpotArt,
} from '../../shared/world.js';
import { itemImage, roomImage } from './assets.js';
import { fillStroke, roundRect } from './shapes.js';

/**
 * 広いマップの描画。
 *
 * 世界は横長で、カメラ（camX）が切り取った一部だけを毎フレーム描く。
 * 画面外のゾーンとスポットは早めに捨てるので、幅を広げても描画量は増えない。
 *
 * PNG（img-gen-gpt で生成した素材）があれば壁・床・家具はそれに差し替わり、
 * 無ければ手続き描画で同じ構図を描く（アセットが無い環境でも遊べる）。
 */

const OUTLINE = '#3d3230';

/** リビングだけは飼い主が壁紙と床を選べる（おへやエディタ）。 */
const WALL_COLORS: Record<string, [string, string]> = {
  cream: ['#fdf3df', '#f6e6c5'],
  mint: ['#e2f4ea', '#c9e9d6'],
  sky: ['#e4f1fb', '#c9e2f5'],
  rose: ['#fbe9ee', '#f5d2dc'],
};

const FLOOR_COLORS: Record<string, [string, string]> = {
  wood: ['#e0bd90', '#c99b6a'],
  tatami: ['#dfe3ba', '#c3cb94'],
  tile: ['#e8e8ee', '#d0d0dc'],
  grass: ['#cbe8a8', '#a9d47c'],
};

export interface WorldMetrics {
  /** 表示領域（CSS px）。 */
  viewW: number;
  viewH: number;
  /** 世界全体の幅（px）。 */
  worldW: number;
  /** 地平線。ここより上が壁／空、下が床／地面。 */
  floorY: number;
  floorDepth: number;
  /** カメラの左端（世界 px）。 */
  camX: number;
  /** 夜かどうか。空と照明が変わる。 */
  night: boolean;
}

export function worldMetrics(
  viewW: number,
  viewH: number,
  camX: number,
  night: boolean,
): WorldMetrics {
  const floorY = viewH * 0.46;
  return {
    viewW,
    viewH,
    worldW: viewW * WORLD_SCREENS,
    floorY,
    floorDepth: viewH - floorY,
    camX,
    night,
  };
}

/** 世界座標（0〜1）→ 画面 x。 */
export function screenX(m: WorldMetrics, worldX: number): number {
  return worldX * m.worldW - m.camX;
}

/** 奥行き（0〜1）→ 画面 y（足元）。 */
export function depthY(m: WorldMetrics, depth: number): number {
  return m.floorY + m.floorDepth * (0.18 + depth * 0.7);
}

/** 奥にいるものは小さく見せる（擬似的な奥行き）。 */
export function depthScale(depth: number): number {
  return 0.84 + depth * 0.26;
}

/** カメラを世界の中に収める。 */
export function clampCam(m: { viewW: number; worldW: number }, camX: number): number {
  return Math.max(0, Math.min(m.worldW - m.viewW, camX));
}

// --- 背景 ------------------------------------------------------------------

function gradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y0: number,
  y1: number,
  colors: [string, string],
): CanvasGradient {
  const g = ctx.createLinearGradient(x, y0, x, y1);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  return g;
}

/** 夜の屋外の空。星と月を出す。 */
function drawNightSky(ctx: CanvasRenderingContext2D, m: WorldMetrics, x0: number, x1: number): void {
  ctx.fillStyle = gradient(ctx, x0, 0, m.floorY, ['#1f2a4a', '#3d4a76']);
  ctx.fillRect(x0, 0, x1 - x0, m.floorY);
  // 星は世界座標に固定したいので、camX からハッシュを作らず位置を決め打ちする。
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 90; i += 1) {
    const wx = (i * 137.5) % m.worldW;
    const sx = wx - m.camX;
    if (sx < x0 - 4 || sx > x1 + 4) continue;
    const sy = ((i * 71) % 100) / 100 * m.floorY * 0.8;
    const r = i % 7 === 0 ? 2.2 : 1.2;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawClouds(ctx: CanvasRenderingContext2D, m: WorldMetrics, x0: number, x1: number): void {
  // 遠景は視差でゆっくり動かす（camX の 0.35 倍）。
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 14; i += 1) {
    const wx = (i * 0.19 * m.worldW) % m.worldW;
    const sx = wx - m.camX * 0.35;
    if (sx < x0 - 120 || sx > x1 + 120) continue;
    const sy = m.floorY * (0.12 + ((i * 37) % 40) / 160);
    const r = m.viewH * (0.035 + ((i * 13) % 5) / 100);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.arc(sx + r * 0.9, sy + r * 0.15, r * 0.75, 0, Math.PI * 2);
    ctx.arc(sx - r * 0.85, sy + r * 0.2, r * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFarHills(ctx: CanvasRenderingContext2D, m: WorldMetrics, x0: number, x1: number): void {
  ctx.fillStyle = 'rgba(120,170,120,0.55)';
  const baseline = m.floorY + 2;
  for (let i = 0; i < 16; i += 1) {
    const wx = i * 0.085 * m.worldW;
    const sx = wx - m.camX * 0.55;
    if (sx < x0 - 200 || sx > x1 + 200) continue;
    const r = m.viewH * (0.16 + ((i * 29) % 7) / 60);
    ctx.beginPath();
    ctx.ellipse(sx, baseline, r * 1.6, r, 0, Math.PI, Math.PI * 2);
    ctx.fill();
  }
}

/** 屋内の壁の水玉。無地だと間延びする。 */
function drawWallPattern(
  ctx: CanvasRenderingContext2D,
  m: WorldMetrics,
  x0: number,
  x1: number,
  tint: string,
): void {
  ctx.fillStyle = tint;
  const step = m.viewW / 7;
  for (let row = 0; row * step * 0.8 < m.floorY; row += 1) {
    // 世界座標に対して並べるので、スクロールしても模様が滑らない。
    const startIndex = Math.floor((x0 + m.camX) / step) - 1;
    for (let col = startIndex; col * step - m.camX < x1 + step; col += 1) {
      const sx = col * step + (row % 2 === 0 ? 0 : step / 2) - m.camX;
      if (sx < x0 - step || sx > x1 + step) continue;
      const sy = row * step * 0.8 + step * 0.4;
      if (sy > m.floorY - 8) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, m.viewW * 0.007), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** ゾーンの名前を壁（または空）に小さく掲げる。いま何部屋にいるか分かるように。 */
function drawZonePlate(
  ctx: CanvasRenderingContext2D,
  m: WorldMetrics,
  x0: number,
  x1: number,
  name: string,
  indoor: boolean,
): void {
  const w = Math.max(74, name.length * 15 + 26);
  const h = Math.max(22, m.viewH * 0.055);
  const y = m.floorY * 0.12;
  // ゾーンの中央に置くと、端のゾーンでは札が画面外にはみ出して読めない。
  // 「そのゾーンの見えている範囲」の中央に寄せる。
  const left = Math.max(x0, 0);
  const right = Math.min(x1, m.viewW);
  const centerX = Math.max(left + w / 2, Math.min((left + right) / 2, right - w / 2));
  ctx.save();
  ctx.lineWidth = 2;
  roundRect(ctx, centerX - w / 2, y, w, h, h * 0.4);
  fillStroke(ctx, indoor ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.7)');
  ctx.fillStyle = '#6b5b52';
  ctx.font = `600 ${Math.max(11, h * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, centerX, y + h * 0.56);
  ctx.restore();
}

/** 屋内ゾーンの境目。柱とアーチの出入口を描くと「別の部屋」に見える。 */
function drawDoorway(ctx: CanvasRenderingContext2D, m: WorldMetrics, x: number): void {
  const w = Math.max(10, m.viewW * 0.02);
  ctx.save();
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.strokeStyle = 'rgba(61,50,48,0.35)';
  ctx.fillRect(x - w / 2, 0, w, m.floorY);
  ctx.strokeRect(x - w / 2, 0, w, m.floorY);
  // アーチ
  const arch = m.floorY * 0.34;
  ctx.beginPath();
  ctx.arc(x, m.floorY * 0.42, arch, Math.PI, Math.PI * 2);
  ctx.strokeStyle = 'rgba(61,50,48,0.22)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

/** 屋内と屋外の境目。ガラス戸と縁側の段差。 */
function drawExitDoor(ctx: CanvasRenderingContext2D, m: WorldMetrics, x: number): void {
  const w = Math.max(26, m.viewW * 0.055);
  const h = m.floorY * 0.62;
  const y = m.floorY - h;
  ctx.save();
  ctx.lineWidth = 2.5;
  roundRect(ctx, x - w / 2, y, w, h, 6);
  fillStroke(ctx, m.night ? 'rgba(120,150,200,0.55)' : 'rgba(210,238,250,0.85)');
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, m.floorY);
  ctx.strokeStyle = 'rgba(61,50,48,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 縁側の段
  ctx.lineWidth = 2;
  roundRect(ctx, x - w * 0.8, m.floorY - 4, w * 1.6, m.floorDepth * 0.14, 4);
  fillStroke(ctx, '#d8b98e');
  ctx.restore();
}

export function drawWorld(ctx: CanvasRenderingContext2D, m: WorldMetrics, layout: RoomLayout): void {
  ctx.clearRect(0, 0, m.viewW, m.viewH);

  for (const range of ZONE_RANGES) {
    const x0 = screenX(m, range.from);
    const x1 = screenX(m, range.to);
    if (x1 < -8 || x0 > m.viewW + 8) continue;
    const { zone } = range;

    const isLiving = zone.id === 'living';
    const back = isLiving ? WALL_COLORS[layout.wall] ?? zone.back : zone.back;
    const ground = isLiving ? FLOOR_COLORS[layout.floor] ?? zone.ground : zone.ground;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, m.viewH);
    ctx.clip();

    if (zone.indoor) {
      // リビングは飼い主が選んだ壁紙、ほかのゾーンはゾーン名の PNG を探す
      // （素材を後から足せるようにしておく。無ければ手続き描画のまま）。
      const wallImg = roomImage('wall', isLiving ? layout.wall : zone.id);
      if (wallImg) {
        ctx.drawImage(wallImg, x0, 0, x1 - x0, m.floorY);
      } else {
        ctx.fillStyle = gradient(ctx, x0, 0, m.floorY, back);
        ctx.fillRect(x0, 0, x1 - x0, m.floorY);
        drawWallPattern(ctx, m, x0, x1, 'rgba(150,120,90,0.13)');
      }
      const floorImg = roomImage('floor', isLiving ? layout.floor : zone.id);
      if (floorImg) {
        ctx.drawImage(floorImg, x0, m.floorY, x1 - x0, m.floorDepth);
      } else {
        ctx.fillStyle = gradient(ctx, x0, m.floorY, m.viewH, [ground[1], ground[0]]);
        ctx.fillRect(x0, m.floorY, x1 - x0, m.floorDepth);
        ctx.strokeStyle = 'rgba(90,60,35,0.1)';
        ctx.lineWidth = 2;
        for (let i = 1; i < 6; i += 1) {
          const y = m.floorY + (m.floorDepth * i) / 6;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
        }
      }
      // 幅木。これがあるだけで「部屋」に見える。
      const skirting = Math.max(6, m.viewH * 0.022);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x0, m.floorY - skirting, x1 - x0, skirting);
      ctx.strokeStyle = 'rgba(61,50,48,0.26)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, m.floorY - skirting);
      ctx.lineTo(x1, m.floorY - skirting);
      ctx.moveTo(x0, m.floorY);
      ctx.lineTo(x1, m.floorY);
      ctx.stroke();
    } else {
      if (m.night) {
        drawNightSky(ctx, m, x0, x1);
      } else {
        ctx.fillStyle = gradient(ctx, x0, 0, m.floorY, back);
        ctx.fillRect(x0, 0, x1 - x0, m.floorY);
        drawClouds(ctx, m, x0, x1);
      }
      drawFarHills(ctx, m, x0, x1);
      ctx.fillStyle = gradient(ctx, x0, m.floorY, m.viewH, [ground[1], ground[0]]);
      ctx.fillRect(x0, m.floorY, x1 - x0, m.floorDepth);
      // 草。世界座標に固定して並べる。
      ctx.strokeStyle = m.night ? 'rgba(40,70,50,0.5)' : 'rgba(70,120,60,0.45)';
      ctx.lineWidth = 2;
      const step = m.viewW / 26;
      const startIndex = Math.floor((x0 + m.camX) / step) - 1;
      for (let i = startIndex; i * step - m.camX < x1 + step; i += 1) {
        const sx = i * step - m.camX;
        if (sx < x0 - step || sx > x1 + step) continue;
        const sy = m.floorY + m.floorDepth * (0.1 + ((i * 53) % 90) / 100);
        const h = m.viewH * 0.02;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(sx + h * 0.4, sy - h * 0.7, sx + h * 0.1, sy - h);
        ctx.stroke();
      }
    }

    drawZonePlate(ctx, m, x0, x1, zone.name, zone.indoor);
    ctx.restore();
  }

  // 境目。屋内どうしはアーチ、屋内と屋外はガラス戸。
  for (let i = 0; i < ZONE_RANGES.length - 1; i += 1) {
    const left = ZONE_RANGES[i];
    const right = ZONE_RANGES[i + 1];
    const x = screenX(m, left.to);
    if (x < -60 || x > m.viewW + 60) continue;
    if (left.zone.indoor && right.zone.indoor) drawDoorway(ctx, m, x);
    else if (left.zone.indoor !== right.zone.indoor) drawExitDoor(ctx, m, x);
  }

  // 夜は屋内も少し暗くする（ランプのスポットが意味を持つように）。
  if (m.night) {
    ctx.fillStyle = 'rgba(30,40,80,0.16)';
    ctx.fillRect(0, 0, m.viewW, m.viewH);
  }
}

// --- 家具（おへやエディタで置いたもの。リビングに並ぶ） --------------------

/** 家具グリッドの段数（サーバ側の検証値と合わせる）。 */
const GRID_W = 16;
const GRID_DEPTH = 6;

export function drawFurniture(
  ctx: CanvasRenderingContext2D,
  m: WorldMetrics,
  layout: RoomLayout,
): void {
  const range = zoneRange('living');
  const zoneLeft = screenX(m, range.from);
  const zoneWidth = screenX(m, range.to) - zoneLeft;
  const cell = zoneWidth / GRID_W;

  const sorted = [...layout.furniture].sort((a, b) => a.y - b.y);
  for (const entry of sorted) {
    const item = findItem(entry.itemId);
    if (!item) continue;
    const [cellsWide, cellsHigh] = item.size ?? [2, 2];
    const scale = 1.5;
    const width = cellsWide * cell * scale;
    const height = cellsHigh * cell * scale;
    const x = zoneLeft + Math.min(entry.x * cell, zoneWidth - width);
    if (x + width < -20 || x > m.viewW + 20) continue;
    const depth = Math.min(1, entry.y / GRID_DEPTH);
    const y = depthY(m, depth * 0.5);

    const img = itemImage(entry.itemId);
    if (img) {
      ctx.drawImage(img, x, y - height, width, height);
      continue;
    }
    ctx.save();
    ctx.lineWidth = 2;
    roundRect(ctx, x, y - height, width, height, Math.min(width, height) * 0.25);
    fillStroke(ctx, 'rgba(255,255,255,0.75)');
    ctx.fillStyle = '#6b5b52';
    ctx.font = `${Math.max(9, cell * 0.4)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(item.name.slice(0, 5), x + width / 2, y - height / 2);
    ctx.restore();
  }
}

// --- スポット --------------------------------------------------------------

/**
 * スポットの絵。
 * 1つずつ手続きで描いてある。PNG（/assets/spots/<art>.png）があればそれを使う。
 */
function drawSpotArt(
  ctx: CanvasRenderingContext2D,
  art: SpotArt,
  x: number,
  y: number,
  unit: number,
  time: number,
  night: boolean,
): void {
  ctx.save();
  ctx.lineWidth = Math.max(1.8, unit * 0.05);
  ctx.strokeStyle = OUTLINE;
  const u = unit;

  switch (art) {
    case 'bed': {
      roundRect(ctx, x - u, y - u * 0.75, u * 2, u * 0.75, u * 0.18);
      fillStroke(ctx, '#f3d7e2');
      roundRect(ctx, x - u * 0.95, y - u * 1.05, u * 0.8, u * 0.4, u * 0.16);
      fillStroke(ctx, '#ffffff');
      break;
    }
    case 'cushion': {
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.18, u * 0.9, u * 0.32, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#e7cfa9');
      break;
    }
    case 'lamp': {
      ctx.beginPath();
      ctx.moveTo(x - u * 0.08, y);
      ctx.lineTo(x + u * 0.08, y);
      ctx.lineTo(x + u * 0.05, y - u * 0.9);
      ctx.lineTo(x - u * 0.05, y - u * 0.9);
      fillStroke(ctx, '#c8b49a');
      ctx.beginPath();
      ctx.moveTo(x - u * 0.42, y - u * 0.86);
      ctx.lineTo(x + u * 0.42, y - u * 0.86);
      ctx.lineTo(x + u * 0.3, y - u * 1.32);
      ctx.lineTo(x - u * 0.3, y - u * 1.32);
      ctx.closePath();
      fillStroke(ctx, night ? '#ffe9a8' : '#f4efe2');
      if (night) {
        ctx.fillStyle = 'rgba(255,225,150,0.28)';
        ctx.beginPath();
        ctx.arc(x, y - u * 0.9, u * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'bowl': {
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.16, u * 0.5, u * 0.2, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#f0a9a9');
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.2, u * 0.34, u * 0.12, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#c98a5a');
      break;
    }
    case 'fridge': {
      roundRect(ctx, x - u * 0.5, y - u * 1.7, u, u * 1.7, u * 0.14);
      fillStroke(ctx, '#eef2f5');
      ctx.beginPath();
      ctx.moveTo(x - u * 0.5, y - u * 1.1);
      ctx.lineTo(x + u * 0.5, y - u * 1.1);
      ctx.stroke();
      break;
    }
    case 'shelf': {
      roundRect(ctx, x - u * 0.7, y - u * 1.3, u * 1.4, u * 1.3, u * 0.1);
      fillStroke(ctx, '#dcb689');
      ctx.beginPath();
      for (const t of [0.45, 0.85]) {
        ctx.moveTo(x - u * 0.7, y - u * 1.3 + u * 1.3 * t);
        ctx.lineTo(x + u * 0.7, y - u * 1.3 + u * 1.3 * t);
      }
      ctx.stroke();
      break;
    }
    case 'toybox': {
      roundRect(ctx, x - u * 0.65, y - u * 0.8, u * 1.3, u * 0.8, u * 0.12);
      fillStroke(ctx, '#9ecbe8');
      ctx.beginPath();
      ctx.arc(x - u * 0.2, y - u * 0.9, u * 0.18, 0, Math.PI * 2);
      fillStroke(ctx, '#f2b8c6');
      ctx.beginPath();
      ctx.arc(x + u * 0.25, y - u * 0.95, u * 0.13, 0, Math.PI * 2);
      fillStroke(ctx, '#f6e08a');
      break;
    }
    case 'window': {
      const cy = y - u * 1.5;
      ctx.beginPath();
      ctx.arc(x, cy, u * 0.62, 0, Math.PI * 2);
      fillStroke(ctx, night ? '#31406b' : '#bfe4f6');
      ctx.beginPath();
      ctx.moveTo(x - u * 0.62, cy);
      ctx.lineTo(x + u * 0.62, cy);
      ctx.moveTo(x, cy - u * 0.62);
      ctx.lineTo(x, cy + u * 0.62);
      ctx.stroke();
      break;
    }
    case 'door': {
      roundRect(ctx, x - u * 0.5, y - u * 1.8, u, u * 1.8, u * 0.1);
      fillStroke(ctx, '#c98a5a');
      ctx.beginPath();
      ctx.arc(x + u * 0.3, y - u * 0.9, u * 0.08, 0, Math.PI * 2);
      fillStroke(ctx, '#f6e08a');
      break;
    }
    case 'tub': {
      roundRect(ctx, x - u * 0.7, y - u * 0.62, u * 1.4, u * 0.62, u * 0.2);
      fillStroke(ctx, '#e9f4f8');
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.55, u * 0.6, u * 0.16, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#a8d8ea');
      break;
    }
    case 'mirror': {
      // 鏡だけ描くと空中に浮いて見えたので、床まで届く支柱と台をつける。
      const cy = y - u * 1.35;
      ctx.beginPath();
      ctx.moveTo(x - u * 0.06, y);
      ctx.lineTo(x + u * 0.06, y);
      ctx.lineTo(x + u * 0.04, cy);
      ctx.lineTo(x - u * 0.04, cy);
      fillStroke(ctx, '#c8b49a');
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.04, u * 0.3, u * 0.1, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#c8b49a');
      ctx.beginPath();
      ctx.ellipse(x, cy, u * 0.42, u * 0.62, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#dff0f5');
      break;
    }
    case 'flowerbed': {
      roundRect(ctx, x - u * 0.9, y - u * 0.3, u * 1.8, u * 0.3, u * 0.1);
      fillStroke(ctx, '#a9754e');
      const colors = ['#f4a0b8', '#f6e08a', '#c9a8ee'];
      for (let i = 0; i < 3; i += 1) {
        const fx = x - u * 0.55 + i * u * 0.55;
        const sway = Math.sin(time / 900 + i) * u * 0.05;
        ctx.beginPath();
        ctx.moveTo(fx, y - u * 0.3);
        ctx.quadraticCurveTo(fx + sway, y - u * 0.6, fx + sway, y - u * 0.78);
        ctx.strokeStyle = '#5f9a52';
        ctx.stroke();
        ctx.strokeStyle = OUTLINE;
        for (let p = 0; p < 5; p += 1) {
          const angle = (p / 5) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(
            fx + sway + Math.cos(angle) * u * 0.12,
            y - u * 0.86 + Math.sin(angle) * u * 0.12,
            u * 0.1,
            u * 0.1,
            0,
            0,
            Math.PI * 2,
          );
          fillStroke(ctx, colors[i]);
        }
        ctx.beginPath();
        ctx.arc(fx + sway, y - u * 0.86, u * 0.07, 0, Math.PI * 2);
        fillStroke(ctx, '#fff6d8');
      }
      break;
    }
    case 'dirt': {
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.06, u * 0.75, u * 0.22, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#a9754e');
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.06, u * 0.42, u * 0.12, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#7d5334');
      break;
    }
    case 'puddle': {
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.05, u * 0.85, u * 0.24, 0, 0, Math.PI * 2);
      fillStroke(ctx, 'rgba(150,205,235,0.9)');
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      const r = u * (0.2 + ((time / 900) % 1) * 0.4);
      ctx.ellipse(x, y - u * 0.05, r, r * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'butterfly': {
      const fy = y - u * 1.2 + Math.sin(time / 420) * u * 0.35;
      const fx = x + Math.cos(time / 700) * u * 0.5;
      const flap = Math.abs(Math.sin(time / 130));
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(fx + side * u * 0.14, fy, u * 0.16 * (0.4 + flap * 0.6), u * 0.2, side * 0.4, 0, Math.PI * 2);
        fillStroke(ctx, '#f6d98a');
      }
      ctx.beginPath();
      ctx.ellipse(fx, fy, u * 0.05, u * 0.14, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#6b5b52');
      break;
    }
    case 'mailbox': {
      ctx.beginPath();
      ctx.moveTo(x - u * 0.07, y);
      ctx.lineTo(x + u * 0.07, y);
      ctx.lineTo(x + u * 0.07, y - u * 1.0);
      ctx.lineTo(x - u * 0.07, y - u * 1.0);
      fillStroke(ctx, '#9a8570');
      roundRect(ctx, x - u * 0.4, y - u * 1.5, u * 0.8, u * 0.55, u * 0.16);
      fillStroke(ctx, '#e88a7d');
      break;
    }
    case 'tree': {
      ctx.beginPath();
      ctx.moveTo(x - u * 0.18, y);
      ctx.lineTo(x + u * 0.18, y);
      ctx.lineTo(x + u * 0.12, y - u * 1.3);
      ctx.lineTo(x - u * 0.12, y - u * 1.3);
      fillStroke(ctx, '#a9754e');
      const sway = Math.sin(time / 1600) * u * 0.06;
      for (const [dx, dy, r] of [
        [-0.45, -1.5, 0.55],
        [0.45, -1.55, 0.5],
        [0, -1.9, 0.6],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x + u * dx + sway, y + u * dy, u * r, 0, Math.PI * 2);
        fillStroke(ctx, night ? '#4d7a4a' : '#7cb862');
      }
      break;
    }
    case 'bench': {
      roundRect(ctx, x - u * 0.85, y - u * 0.55, u * 1.7, u * 0.16, u * 0.06);
      fillStroke(ctx, '#d8a86c');
      roundRect(ctx, x - u * 0.85, y - u * 1.0, u * 1.7, u * 0.16, u * 0.06);
      fillStroke(ctx, '#d8a86c');
      ctx.beginPath();
      for (const side of [-1, 1]) {
        ctx.moveTo(x + side * u * 0.7, y - u * 0.55);
        ctx.lineTo(x + side * u * 0.7, y);
      }
      ctx.stroke();
      break;
    }
    case 'birdnest': {
      ctx.beginPath();
      ctx.moveTo(x - u * 0.1, y);
      ctx.lineTo(x + u * 0.1, y);
      ctx.lineTo(x + u * 0.06, y - u * 1.1);
      ctx.lineTo(x - u * 0.06, y - u * 1.1);
      fillStroke(ctx, '#a9754e');
      ctx.beginPath();
      ctx.ellipse(x, y - u * 1.2, u * 0.42, u * 0.24, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#c9a870');
      // ことり
      const hop = Math.abs(Math.sin(time / 700)) * u * 0.08;
      ctx.beginPath();
      ctx.ellipse(x + u * 0.1, y - u * 1.45 - hop, u * 0.16, u * 0.14, 0, 0, Math.PI * 2);
      fillStroke(ctx, '#8fc7ea');
      break;
    }
    case 'starspot': {
      ctx.beginPath();
      ctx.ellipse(x, y - u * 0.08, u * 0.8, u * 0.2, 0, 0, Math.PI * 2);
      fillStroke(ctx, night ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.35)');
      ctx.fillStyle = night ? '#fff3b0' : 'rgba(255,240,180,0.5)';
      for (let i = 0; i < 3; i += 1) {
        const sx = x - u * 0.4 + i * u * 0.4;
        const sy = y - u * (1.4 + i * 0.25) + Math.sin(time / 800 + i) * u * 0.08;
        ctx.beginPath();
        for (let p = 0; p < 10; p += 1) {
          const angle = (p / 10) * Math.PI * 2 - Math.PI / 2;
          const r = p % 2 === 0 ? u * 0.16 : u * 0.07;
          const px = sx + Math.cos(angle) * r;
          const py = sy + Math.sin(angle) * r;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

/** ペットが向かっている先／滞在中のスポットに小さな印を出す。 */
function drawSpotTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  unit: number,
  label: string,
): void {
  const h = Math.max(18, unit * 0.34);
  const w = label.length * h * 0.62 + h * 0.7;
  const top = y - unit * 2.1;
  ctx.save();
  ctx.lineWidth = 2;
  roundRect(ctx, x - w / 2, top, w, h, h * 0.45);
  fillStroke(ctx, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = '#6b5b52';
  ctx.font = `600 ${h * 0.58}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, top + h * 0.56);
  ctx.restore();
}

/**
 * スポットを奥から手前へ描く。
 * 手前のスポットはペットより後に描かないと、ペットが物の裏に回れない。
 * ここでは「ペットより奥のもの」だけを描き、手前のものは drawSpotsFront に回す。
 */
export function drawSpots(
  ctx: CanvasRenderingContext2D,
  m: WorldMetrics,
  time: number,
  options: { petDepth: number; activeSpotId: string | null; front: boolean },
): void {
  const list = [...SPOTS].sort((a, b) => a.depth - b.depth);
  for (const spot of list) {
    const isFront = spot.depth > options.petDepth;
    if (isFront !== options.front) continue;
    const x = screenX(m, spot.x);
    const unit = m.viewH * 0.17 * depthScale(spot.depth);
    if (x + unit * 2 < 0 || x - unit * 2 > m.viewW) continue;
    const y = depthY(m, spot.depth);
    drawSpotArt(ctx, spot.art, x, y, unit, time, m.night);
    if (spot.id === options.activeSpotId) {
      drawSpotTag(ctx, x, y, unit, spot.name);
    }
  }
}

// --- ミニマップ ------------------------------------------------------------

/**
 * 画面上部の帯。
 * 広い世界だとペットが画面外にいるとき「どこにいるのか」が分からなくなるので、
 * ゾーンの並びと現在位置を常に見せる（見失わせないため）。
 */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  m: WorldMetrics,
  petWorldX: number,
  caption: string,
): void {
  const margin = Math.max(8, m.viewW * 0.02);
  const barW = m.viewW - margin * 2;
  const barH = Math.max(10, m.viewH * 0.026);
  const y = m.viewH - barH - margin - Math.max(14, m.viewH * 0.036);

  ctx.save();
  ctx.lineWidth = 2;
  roundRect(ctx, margin, y, barW, barH, barH / 2);
  fillStroke(ctx, 'rgba(255,255,255,0.72)', 'rgba(61,50,48,0.4)');

  // ゾーンの区切り
  ctx.strokeStyle = 'rgba(61,50,48,0.25)';
  ctx.lineWidth = 1.5;
  for (const range of ZONE_RANGES.slice(0, -1)) {
    const x = margin + barW * range.to;
    ctx.beginPath();
    ctx.moveTo(x, y + 2);
    ctx.lineTo(x, y + barH - 2);
    ctx.stroke();
  }

  // いま見えている範囲
  ctx.fillStyle = 'rgba(120,170,220,0.3)';
  ctx.fillRect(margin + barW * (m.camX / m.worldW), y, barW * (m.viewW / m.worldW), barH);

  // ペットの位置
  ctx.beginPath();
  ctx.arc(margin + barW * petWorldX, y + barH / 2, barH * 0.55, 0, Math.PI * 2);
  fillStroke(ctx, '#f08a7d');

  ctx.fillStyle = 'rgba(61,50,48,0.85)';
  ctx.font = `600 ${Math.max(11, m.viewH * 0.03)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(caption, margin + 2, y + barH + 4);
  ctx.restore();
}

export type { Spot };
