import { roundRect } from './shapes.js';
import { wrapText } from './textWrap.js';

/** 吹き出しとエフェクト（ハート・音符・きらきら）。 */

export interface Particle {
  kind: 'heart' | 'note' | 'sparkle' | 'crumb' | 'zzz';
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export function spawnParticles(
  kind: Particle['kind'],
  x: number,
  y: number,
  count: number,
  rand: () => number = Math.random,
): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    const life = 900 + rand() * 700;
    out.push({
      kind,
      x: x + (rand() - 0.5) * 30,
      y: y + (rand() - 0.5) * 16,
      vx: (rand() - 0.5) * 0.03,
      vy: -0.04 - rand() * 0.03,
      life,
      maxLife: life,
    });
  }
  return out;
}

export function updateParticles(particles: Particle[], deltaMs: number): Particle[] {
  const out: Particle[] = [];
  for (const particle of particles) {
    const life = particle.life - deltaMs;
    if (life <= 0) continue;
    out.push({
      ...particle,
      life,
      x: particle.x + particle.vx * deltaMs,
      y: particle.y + particle.vy * deltaMs,
    });
  }
  return out;
}

const GLYPH: Record<Particle['kind'], string> = {
  heart: '♥',
  note: '♪',
  sparkle: '✦',
  crumb: '・',
  zzz: 'z',
};

const COLOR: Record<Particle['kind'], string> = {
  heart: '#f07a90',
  note: '#6fa8dc',
  sparkle: '#f2c14e',
  crumb: '#b08968',
  zzz: '#8fa6c4',
};

/**
 * パーティクルの座標は「世界」の px で持つ。
 * 画面座標で持つとカメラがスクロールしたときに置いていかれて、
 * 出た場所とは違う所で消えてしまう（広いマップにして初めて出た問題）。
 */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  cameraX = 0,
): void {
  for (const particle of particles) {
    const screenXPos = particle.x - cameraX;
    if (screenXPos < -30 || screenXPos > ctx.canvas.clientWidth + 30) continue;
    const progress = particle.life / particle.maxLife;
    ctx.save();
    ctx.globalAlpha = Math.min(1, progress * 1.6);
    ctx.fillStyle = COLOR[particle.kind];
    ctx.font = `${14 + (1 - progress) * 8}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(GLYPH[particle.kind], screenXPos, particle.y);
    ctx.restore();
  }
}

export interface Bubble {
  text: string;
  /** 表示が消える時刻（performance.now 基準）。 */
  until: number;
  /** LLM の返事待ちで「…」を出している状態。 */
  pending: boolean;
}

/** 吹き出し。文字数に応じて折り返し、上端がはみ出さないよう位置を調整する。 */
export function drawBubble(
  ctx: CanvasRenderingContext2D,
  bubble: Bubble,
  anchorX: number,
  anchorY: number,
  maxWidth: number,
): void {
  const fontSize = 15;
  ctx.save();
  ctx.font = `${fontSize}px "Hiragino Maru Gothic ProN", system-ui, sans-serif`;

  const text = bubble.pending ? '…' : bubble.text;
  const lines = wrap(ctx, text, maxWidth - 28);
  const lineHeight = fontSize * 1.5;
  const boxWidth = Math.min(
    maxWidth,
    Math.max(56, ...lines.map((line) => ctx.measureText(line).width)) + 28,
  );
  const boxHeight = lines.length * lineHeight + 18;

  let x = anchorX - boxWidth / 2;
  x = Math.max(8, Math.min(x, ctx.canvas.clientWidth - boxWidth - 8));
  const y = Math.max(8, anchorY - boxHeight - 14);

  ctx.shadowColor = 'rgba(61,50,48,0.18)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3d3230';
  ctx.lineWidth = 2.5;
  roundRect(ctx, x, y, boxWidth, boxHeight, 14);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.stroke();

  // しっぽ
  ctx.beginPath();
  const tailX = Math.max(x + 18, Math.min(anchorX, x + boxWidth - 18));
  ctx.moveTo(tailX - 8, y + boxHeight - 1);
  ctx.lineTo(tailX, y + boxHeight + 12);
  ctx.lineTo(tailX + 8, y + boxHeight - 1);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#3d3230';
  ctx.beginPath();
  ctx.moveTo(tailX - 8, y + boxHeight - 1);
  ctx.lineTo(tailX, y + boxHeight + 12);
  ctx.lineTo(tailX + 8, y + boxHeight - 1);
  ctx.stroke();

  ctx.fillStyle = '#3d3230';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, index) => {
    ctx.fillText(line, x + 14, y + 9 + index * lineHeight);
  });
  ctx.restore();
}

/** 折り返しのロジックは Canvas 非依存の textWrap に置いてある。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  return wrapText(text, maxWidth, (value) => ctx.measureText(value).width);
}
