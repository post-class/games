import type { Emotion, PetAction } from '../../shared/actions.js';
import { findSpecies, type GrowthStage, type SpeciesId } from '../../shared/types.js';
import { petImage, poseFor } from './assets.js';

/**
 * ペットの描画。
 * PNG があればそれを、無ければ手続き描画で同じシルエットを描く。
 *
 * 見た目の方針は調査で確認した Finch のスタイル:
 * ベタ塗り・太い輪郭・丸いシルエット・パステル。Canvas でも破綻しない。
 */

export interface DrawState {
  species: SpeciesId;
  stage: GrowthStage;
  emotion: Emotion;
  action: PetAction;
  /** 経過時間（ms）。アニメの位相に使う。 */
  time: number;
  /** 画面上の位置（中心・足元）。 */
  x: number;
  y: number;
  /** 体の高さ（px）。 */
  height: number;
  /** 向き。1 = 右、-1 = 左。 */
  facing: 1 | -1;
}

const OUTLINE = '#3d3230';

/** 行動ごとの上下・傾きの揺れ。生き物らしさは動きで出る。 */
function motionOf(action: PetAction, time: number): { bob: number; tilt: number; squash: number } {
  const t = time / 1000;
  switch (action) {
    case 'jump_joy':
      return { bob: -Math.abs(Math.sin(t * 6)) * 0.35, tilt: 0, squash: 1 + Math.sin(t * 12) * 0.06 };
    case 'walk':
      return { bob: -Math.abs(Math.sin(t * 4)) * 0.06, tilt: Math.sin(t * 4) * 0.05, squash: 1 };
    case 'play':
      return { bob: -Math.abs(Math.sin(t * 5)) * 0.18, tilt: Math.sin(t * 5) * 0.12, squash: 1 };
    case 'eat':
      return { bob: 0, tilt: 0, squash: 1 + Math.sin(t * 10) * 0.05 };
    case 'nap':
      return { bob: 0.08, tilt: 0.08, squash: 1 + Math.sin(t * 1.2) * 0.03 };
    case 'sulk_corner':
      return { bob: 0.04, tilt: -0.1, squash: 1 };
    case 'nuzzle':
      return { bob: 0, tilt: Math.sin(t * 3) * 0.14, squash: 1 };
    case 'wash':
      return { bob: 0, tilt: Math.sin(t * 7) * 0.1, squash: 1 };
    case 'daydream':
      return { bob: Math.sin(t * 1.5) * 0.04, tilt: 0.05, squash: 1 };
    // --- 広いマップのスポット行動 ---
    case 'dig':
    case 'bury_treasure':
      // 前あしで掘るので、前傾して小刻みに上下する。
      return { bob: Math.abs(Math.sin(t * 9)) * 0.05, tilt: 0.16, squash: 1 + Math.sin(t * 9) * 0.05 };
    case 'sniff_flower':
      return { bob: 0.03, tilt: 0.2, squash: 1 + Math.sin(t * 6) * 0.03 };
    case 'splash_puddle':
      return { bob: -Math.abs(Math.sin(t * 7)) * 0.22, tilt: Math.sin(t * 7) * 0.1, squash: 1 };
    case 'chase_butterfly':
      return { bob: -Math.abs(Math.sin(t * 5.5)) * 0.2, tilt: Math.sin(t * 3) * 0.16, squash: 1 };
    case 'climb_tree':
      // よじ登っている最中は縦に伸びる。
      return { bob: -0.12 + Math.sin(t * 3) * 0.05, tilt: -0.1, squash: 0.92 };
    case 'stargaze':
      return { bob: 0, tilt: -0.22, squash: 1 };
    case 'sunbathe':
      return { bob: 0.06, tilt: 0.1, squash: 1 + Math.sin(t * 1) * 0.03 };
    case 'chat_bird':
      return { bob: -Math.abs(Math.sin(t * 4)) * 0.06, tilt: -0.12, squash: 1 };
    case 'check_mail':
      return { bob: -0.05, tilt: -0.16, squash: 0.96 };
    case 'dance':
      return { bob: -Math.abs(Math.sin(t * 6)) * 0.14, tilt: Math.sin(t * 3) * 0.28, squash: 1 };
    case 'sing':
      return { bob: Math.sin(t * 3) * 0.05, tilt: -0.08, squash: 1 + Math.sin(t * 6) * 0.04 };
    case 'roll_around':
      return { bob: 0.05, tilt: Math.sin(t * 2.2) * 0.5, squash: 1 + Math.sin(t * 4) * 0.06 };
    case 'stretch':
      return { bob: -0.04, tilt: 0.1, squash: 0.9 + Math.sin(t * 2) * 0.06 };
    default:
      return { bob: Math.sin(t * 1.8) * 0.03, tilt: 0, squash: 1 + Math.sin(t * 1.8) * 0.02 };
  }
}

function roundedBlob(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  species: SpeciesId,
): void {
  // 下がふくらんだ卵型。ベジェで丸みを作る。
  const halfWidth = width / 2;
  ctx.beginPath();
  ctx.moveTo(0, -height / 2);
  ctx.bezierCurveTo(halfWidth * 1.05, -height / 2, halfWidth * 1.15, height * 0.18, halfWidth * 0.92, height * 0.4);
  ctx.bezierCurveTo(halfWidth * 0.6, height / 2, -halfWidth * 0.6, height / 2, -halfWidth * 0.92, height * 0.4);
  ctx.bezierCurveTo(-halfWidth * 1.15, height * 0.18, -halfWidth * 1.05, -height / 2, 0, -height / 2);
  ctx.closePath();
  void species;
}

function drawEars(
  ctx: CanvasRenderingContext2D,
  species: SpeciesId,
  width: number,
  height: number,
  body: string,
  accent: string,
): void {
  const halfWidth = width / 2;
  if (species === 'mocha') {
    // たれ耳
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * halfWidth * 0.72, -height * 0.18, width * 0.17, height * 0.26, side * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.stroke();
    }
  } else if (species === 'pome') {
    // 立ち耳
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * halfWidth * 0.5, -height * 0.4);
      ctx.lineTo(side * halfWidth * 0.85, -height * 0.78);
      ctx.lineTo(side * halfWidth * 0.92, -height * 0.34);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.stroke();
    }
  } else {
    // ニンバスは耳の代わりに小さな雲のふくらみ
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * halfWidth * 0.66, -height * 0.36, width * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.stroke();
    }
  }
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  emotion: Emotion,
  width: number,
  height: number,
  accent: string,
  time: number,
): void {
  const eyeX = width * 0.19;
  const eyeY = -height * 0.06;
  const blink = Math.sin(time / 1400) > 0.985;
  ctx.fillStyle = OUTLINE;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(2, width * 0.035);

  const closed = emotion === 'sleepy' || blink;
  if (closed) {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * eyeX, eyeY, width * 0.09, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  } else if (emotion === 'sulky' || emotion === 'angry') {
    for (const side of [-1, 1]) {
      // への字目
      ctx.beginPath();
      ctx.moveTo(side * eyeX - width * 0.07, eyeY - height * 0.02);
      ctx.lineTo(side * eyeX + width * 0.07, eyeY + height * 0.01);
      ctx.stroke();
    }
  } else {
    const eyeR = emotion === 'excited' ? width * 0.085 : width * 0.07;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * eyeX, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fill();
      // ハイライト
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(side * eyeX + eyeR * 0.35, eyeY - eyeR * 0.35, eyeR * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = OUTLINE;
    }
  }

  // 口
  ctx.beginPath();
  const mouthY = height * 0.1;
  if (emotion === 'happy' || emotion === 'excited') {
    ctx.arc(0, mouthY - height * 0.02, width * 0.1, Math.PI * 0.15, Math.PI * 0.85);
  } else if (emotion === 'sad' || emotion === 'sulky') {
    ctx.arc(0, mouthY + height * 0.06, width * 0.1, Math.PI * 1.2, Math.PI * 1.8);
  } else {
    ctx.moveTo(-width * 0.05, mouthY);
    ctx.lineTo(width * 0.05, mouthY);
  }
  ctx.stroke();

  // ほお
  if (emotion === 'happy' || emotion === 'excited') {
    ctx.fillStyle = 'rgba(240,140,150,0.5)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * width * 0.33, height * 0.03, width * 0.08, height * 0.045, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  void accent;
}

function drawEgg(ctx: CanvasRenderingContext2D, state: DrawState): void {
  const species = findSpecies(state.species);
  const height = state.height;
  const width = height * 0.78;
  const wobble = Math.sin(state.time / 260) * 0.05;

  ctx.save();
  ctx.translate(state.x, state.y - height / 2);
  ctx.rotate(wobble);
  ctx.lineWidth = Math.max(2.5, width * 0.045);
  ctx.strokeStyle = OUTLINE;

  ctx.beginPath();
  ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#fdf6e8';
  ctx.fill();
  ctx.stroke();

  // 種族の色のまだら模様
  ctx.fillStyle = species?.accentColor ?? '#c9a06a';
  for (const [dx, dy, r] of [
    [-0.18, 0.1, 0.1],
    [0.2, -0.05, 0.08],
    [0.02, 0.28, 0.07],
  ] as const) {
    ctx.beginPath();
    ctx.arc(dx * width, dy * height, r * width, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** ペット1体を描く。PNG があれば PNG、無ければ手続き描画。 */
export function drawPet(ctx: CanvasRenderingContext2D, state: DrawState): void {
  const pose = poseFor(state.emotion);
  const img = petImage(state.species, state.stage, pose);
  const motion = motionOf(state.action, state.time);
  const height = state.height;

  if (img) {
    const width = (img.width / img.height) * height;
    ctx.save();
    ctx.translate(state.x, state.y + motion.bob * height);
    ctx.rotate(motion.tilt);
    ctx.scale(state.facing, 1);
    ctx.drawImage(img, -width / 2, -height * motion.squash, width, height * motion.squash);
    ctx.restore();
    return;
  }

  if (state.stage === 'egg') {
    drawEgg(ctx, { ...state, height });
    return;
  }

  const species = findSpecies(state.species);
  const body = species?.bodyColor ?? '#e8b98c';
  const accent = species?.accentColor ?? '#8a5a3b';
  const width = height * 0.86;

  ctx.save();
  ctx.translate(state.x, state.y - (height / 2) * motion.squash + motion.bob * height);
  ctx.rotate(motion.tilt);
  ctx.scale(state.facing, motion.squash);
  ctx.lineWidth = Math.max(2.5, width * 0.04);
  ctx.strokeStyle = OUTLINE;
  ctx.lineJoin = 'round';

  drawEars(ctx, state.species, width, height, body, accent);

  roundedBlob(ctx, width, height, state.species);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // おなかの明るい面
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.ellipse(0, height * 0.18, width * 0.3, height * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  // しっぽ／足
  ctx.beginPath();
  ctx.ellipse(-width * 0.52, height * 0.34, width * 0.12, height * 0.08, 0.4, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.stroke();

  drawFace(ctx, state.emotion, width, height, accent, state.time);
  ctx.restore();
}

/** 足元の影。地面に接している感じを出す。 */
export function drawShadow(ctx: CanvasRenderingContext2D, x: number, y: number, width: number): void {
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#3d3230';
  ctx.beginPath();
  ctx.ellipse(x, y, width * 0.42, width * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
