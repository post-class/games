import { findItem } from '../../shared/items.js';
import type { RoomLayout } from '../../shared/types.js';
import { itemImage, roomImage } from './assets.js';

/** 部屋（壁・床・家具）の描画。PNG があれば差し替わる。 */

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

export interface RoomMetrics {
  width: number;
  height: number;
  /** 床の上端 y。ペットはこの下に立つ。 */
  floorY: number;
  /** 家具グリッド 1マスの大きさ。 */
  cell: number;
}

export function roomMetrics(width: number, height: number): RoomMetrics {
  const floorY = height * 0.62;
  return { width, height, floorY, cell: width / 16 };
}

export function drawRoom(
  ctx: CanvasRenderingContext2D,
  layout: RoomLayout,
  metrics: RoomMetrics,
): void {
  const { width, height, floorY } = metrics;

  // 壁
  const wallImg = roomImage('wall', layout.wall);
  if (wallImg) {
    ctx.drawImage(wallImg, 0, 0, width, floorY);
  } else {
    const [top, bottom] = WALL_COLORS[layout.wall] ?? WALL_COLORS.cream;
    const gradient = ctx.createLinearGradient(0, 0, 0, floorY);
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, floorY);
  }

  // 床
  const floorImg = roomImage('floor', layout.floor);
  if (floorImg) {
    ctx.drawImage(floorImg, 0, floorY, width, height - floorY);
  } else {
    const [near, far] = FLOOR_COLORS[layout.floor] ?? FLOOR_COLORS.wood;
    const gradient = ctx.createLinearGradient(0, floorY, 0, height);
    gradient.addColorStop(0, far);
    gradient.addColorStop(1, near);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, floorY, width, height - floorY);
    // 床板の線
    ctx.strokeStyle = 'rgba(90,60,35,0.12)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 6; i += 1) {
      const y = floorY + ((height - floorY) * i) / 6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  // 壁と床の境目
  ctx.strokeStyle = 'rgba(61,50,48,0.25)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(width, floorY);
  ctx.stroke();
}

/** 家具。奥（y が小さい）から手前へ描くので重なりが自然になる。 */
export function drawFurniture(
  ctx: CanvasRenderingContext2D,
  layout: RoomLayout,
  metrics: RoomMetrics,
): void {
  const sorted = [...layout.furniture].sort((a, b) => a.y - b.y);
  for (const entry of sorted) {
    const item = findItem(entry.itemId);
    if (!item) continue;
    const [cellsWide, cellsHigh] = item.size ?? [2, 2];
    const width = cellsWide * metrics.cell;
    const height = cellsHigh * metrics.cell;
    const x = entry.x * metrics.cell;
    const y = metrics.floorY + entry.y * (metrics.cell * 0.55);

    const img = itemImage(entry.itemId);
    if (img) {
      ctx.drawImage(img, x, y - height, width, height);
      continue;
    }

    // 手続き描画のフォールバック（角丸の箱＋名前）。
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.strokeStyle = '#3d3230';
    ctx.lineWidth = 2;
    roundRect(ctx, x, y - height, width, height, Math.min(width, height) * 0.25);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#6b5b52';
    ctx.font = `${Math.max(9, metrics.cell * 0.32)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(item.name.slice(0, 5), x + width / 2, y - height / 2);
    ctx.restore();
  }
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
