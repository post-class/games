import { pilotFaceId, type PortraitSpec } from '../content/pilots';

/**
 * SVG によるパイロットの顔。
 *
 * 写実性は狙わず、「誰が喋っているか」が一目で分かることだけを目的にする。
 * 表情差分を持たせて、無線の内容と顔が連動するようにしてある。
 */

export type Expression = 'neutral' | 'talk' | 'strain' | 'grin' | 'grim';

export interface PortraitOptions {
  /** 表示サイズ (px) */
  size?: number;
  expression?: Expression;
  /** 戦死者は灰色にする */
  dead?: boolean;
  /** 枠の色 */
  frame?: string;
  /** 喋っている間は口を動かす */
  speaking?: boolean;
}

/** 顔だけの SVG 文字列を返す (通信 VDU と名簿で共用) */
export function portraitSvg(spec: PortraitSpec, o: PortraitOptions = {}): string {
  const size = o.size ?? 64;
  const exp = o.expression ?? 'neutral';
  const dead = !!o.dead;
  const skin = dead ? '#6a6a6a' : spec.skin;
  const hair = dead ? '#3a3a3a' : spec.hair;
  const frame = o.frame ?? 'rgba(127,227,176,0.45)';

  const parts: string[] = [];

  // 背景 (通信画面のブラウン管風)
  parts.push(
    `<rect x="0" y="0" width="64" height="64" fill="rgba(6,18,20,0.92)"/>`,
    `<rect x="0" y="0" width="64" height="64" fill="url(#pg)" opacity="0.5"/>`,
  );

  // 首と肩 (飛行服)
  parts.push(
    `<path d="M 20 56 Q 32 44 44 56 L 44 64 L 20 64 Z" fill="${dead ? '#2a2a2a' : '#2d3a34'}"/>`,
    `<rect x="28" y="44" width="8" height="8" fill="${skin}"/>`,
  );

  // 頭
  parts.push(`<ellipse cx="32" cy="30" rx="13" ry="15" fill="${skin}"/>`);

  // 髪
  switch (spec.hairStyle) {
    case 'buzz':
      parts.push(`<path d="M 19 26 Q 32 12 45 26 Q 32 20 19 26 Z" fill="${hair}"/>`);
      break;
    case 'bald':
      break;
    case 'long':
      parts.push(
        `<path d="M 18 28 Q 32 10 46 28 L 46 46 Q 40 34 32 34 Q 24 34 18 46 Z" fill="${hair}"/>`,
      );
      break;
    case 'tied':
      parts.push(
        `<path d="M 19 26 Q 32 11 45 26 Q 38 19 32 19 Q 26 19 19 26 Z" fill="${hair}"/>`,
        `<circle cx="46" cy="32" r="4" fill="${hair}"/>`,
      );
      break;
    default: // short
      parts.push(`<path d="M 19 27 Q 32 11 45 27 Q 40 18 32 18 Q 24 18 19 27 Z" fill="${hair}"/>`);
      break;
  }

  // 目
  const eyeY = exp === 'strain' ? 31 : 30;
  const lid = spec.eyes === 'tired' || exp === 'strain' ? 1.4 : spec.eyes === 'sharp' ? 1.1 : 1.8;
  const eyeW = spec.eyes === 'wide' ? 2.6 : 2.2;
  if (spec.marks?.includes('visor')) {
    parts.push(
      `<rect x="19" y="26" width="26" height="7" rx="2" fill="#0d2a33" stroke="#6fd8c0" stroke-width="0.6"/>`,
      `<rect x="21" y="27.5" width="9" height="2" fill="#6fd8c0" opacity="0.5"/>`,
    );
  } else {
    parts.push(
      `<ellipse cx="26" cy="${eyeY}" rx="${eyeW}" ry="${lid}" fill="#1b1b1b"/>`,
      `<ellipse cx="38" cy="${eyeY}" rx="${eyeW}" ry="${lid}" fill="#1b1b1b"/>`,
    );
    // 眉 (表情)
    const browL = exp === 'strain' ? 'M 22 24 L 30 26' : exp === 'grim' ? 'M 22 25 L 30 24' : 'M 22 25 L 30 25';
    const browR = exp === 'strain' ? 'M 42 24 L 34 26' : exp === 'grim' ? 'M 42 25 L 34 24' : 'M 42 25 L 34 25';
    parts.push(
      `<path d="${browL}" stroke="${hair}" stroke-width="1.4" fill="none"/>`,
      `<path d="${browR}" stroke="${hair}" stroke-width="1.4" fill="none"/>`,
    );
  }

  // 口 (表情差分)
  switch (exp) {
    case 'talk':
      parts.push(`<ellipse cx="32" cy="39" rx="3.4" ry="2.4" fill="#5a2a2a"/>`);
      break;
    case 'grin':
      parts.push(`<path d="M 27 38 Q 32 43 37 38" stroke="#5a2a2a" stroke-width="1.6" fill="none"/>`);
      break;
    case 'strain':
      parts.push(`<path d="M 27 40 Q 32 37 37 40" stroke="#5a2a2a" stroke-width="1.6" fill="none"/>`);
      break;
    case 'grim':
      parts.push(`<path d="M 27 40 L 37 40" stroke="#5a2a2a" stroke-width="1.5" fill="none"/>`);
      break;
    default:
      parts.push(`<path d="M 28 39 L 36 39" stroke="#5a2a2a" stroke-width="1.4" fill="none"/>`);
      break;
  }

  // 喋っている口。閉じ/開きを CSS で交互に見せる (声の代替なので口だけ動かす)
  if (o.speaking) {
    parts.push(
      `<path class="mc-mouth-a" d="M 28 39 L 36 39" stroke="#5a2a2a" stroke-width="1.6" fill="none"/>`,
      `<ellipse class="mc-mouth-b" cx="32" cy="40" rx="4" ry="2.6" fill="#4a1f1f"/>`,
    );
  }

  // 特徴
  if (spec.marks?.includes('scar')) {
    parts.push(`<path d="M 41 22 L 44 33" stroke="#a86a5a" stroke-width="1.1" fill="none"/>`);
  }
  if (spec.marks?.includes('stubble')) {
    parts.push(
      `<path d="M 23 36 Q 32 47 41 36 Q 32 42 23 36 Z" fill="#2a2a2a" opacity="0.35"/>`,
    );
  }
  if (spec.marks?.includes('bandana')) {
    parts.push(
      `<path d="M 19 24 Q 32 18 45 24 L 45 27 Q 32 21 19 27 Z" fill="#a8412c"/>`,
    );
  }

  // 戦死者には斜線を引く
  if (dead) {
    parts.push(`<path d="M 6 58 L 58 6" stroke="rgba(255,93,93,0.7)" stroke-width="2"/>`);
  }

  // 走査線
  parts.push(`<rect x="0" y="0" width="64" height="64" fill="url(#pl)" opacity="0.35"/>`);

  return (
    `<svg class="mc-portrait${o.speaking ? ' speaking' : ''}" viewBox="0 0 64 64" width="${size}" height="${size}" ` +
    `style="border:1px solid ${frame}">` +
    `<defs>` +
    `<radialGradient id="pg" cx="50%" cy="35%" r="70%">` +
    `<stop offset="0%" stop-color="#123" stop-opacity="0.1"/>` +
    `<stop offset="100%" stop-color="#000" stop-opacity="0.8"/>` +
    `</radialGradient>` +
    `<pattern id="pl" width="4" height="3" patternUnits="userSpaceOnUse">` +
    `<rect width="4" height="1" fill="rgba(160,220,200,0.25)"/>` +
    `</pattern>` +
    `</defs>` +
    parts.join('') +
    `</svg>`
  );
}

// ───────── 生成画像の顔 ─────────

/**
 * パイロットの顔（生成画像）。
 *
 * 表情5種を1人ずつ用意し、喋っている間は
 * 「その表情」と「口を開けた talk」を交互に出して口の動きを作る
 * （2枚を重ねて CSS アニメーションで opacity を入れ替える）。
 * SVG 版 (`portraitSvg`) は画像が無いときのフォールバックとして残している。
 */

/**
 * 人物名簿 (`content/veil/people.ts`) と同じ規則で連番 id を並べる。
 * 名簿側も `<勢力>-<2桁連番>` で id を作っているので、こちらもその規則に合わせる。
 */
function personFaceIds(faction: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${faction}-${String(i + 1).padStart(2, '0')}`);
}

/**
 * 用意してある顔画像の id (`public/art/tex/face-<id>-<表情>.jpg`)。
 * パイロット id とは別物で、`pilotFaceId()` で変換してから引く。
 * ブリーフィングの話者 (`briefingSpeakerId`) はここの id をそのまま指す。
 *
 * T2-6 第1段階で、人物名簿の全76名ぶんを取り込んだ。
 * TODO(T2-6b): 現状は1人1枚の肖像を5表情すべてに複製しているだけで、表情差分は作り分けていない。
 * 表情ごとの絵を用意したら、同名ファイルを差し替える（id 集合とテストはそのまま使える）。
 */
export const FACE_ART_IDS: ReadonlySet<string> = new Set([
  // ── 旧キャンペーン (既存11ミッション) が参照している暫定 id。
  // 艦長 (ブリーフィング官)。飛ばないが顔画像は同じ形式で持つ
  'halcyon',
  'spirit',
  'maniac',
  'angel',
  'tinman',
  'cricket',
  'padre',
  'slate',
  'nomad',
  // ── THE VEIL FRONT 人物名簿の76名。
  ...personFaceIds('confed', 36),
  ...personFaceIds('kilrashi', 10),
  ...personFaceIds('serecion', 10),
  ...personFaceIds('ordo', 10),
  ...personFaceIds('neurowm', 10),
]);

export function hasPortraitArt(pilotId: string): boolean {
  return FACE_ART_IDS.has(pilotFaceId(pilotId));
}

function faceUrl(pilotId: string, exp: Expression): string {
  return `${import.meta.env.BASE_URL}art/tex/face-${pilotFaceId(pilotId)}-${exp}.jpg`;
}

export interface FaceOptions extends PortraitOptions {
  /** 通信 VDU 風の走査線を乗せるか */
  scanlines?: boolean;
}

/**
 * 生成画像の顔を返す。画像が無ければ SVG にフォールバックする。
 * spec は フォールバック用に受け取る。
 */
export function portraitFace(
  pilotId: string,
  spec: PortraitSpec,
  o: FaceOptions = {},
): string {
  if (!hasPortraitArt(pilotId)) return portraitSvg(spec, o);
  const size = o.size ?? 64;
  const exp = o.expression ?? 'neutral';
  const cls = [
    'mc-face',
    o.speaking ? 'speaking' : '',
    o.dead ? 'dead' : '',
    o.scanlines === false ? '' : 'scan',
  ]
    .filter(Boolean)
    .join(' ');

  // 喋る場合は「表情」と「口を開けた顔」を重ねる
  const layers = o.speaking
    ? `<img class="a" src="${faceUrl(pilotId, exp === 'talk' ? 'neutral' : exp)}" alt="">` +
      `<img class="b" src="${faceUrl(pilotId, 'talk')}" alt="">`
    : `<img class="a" src="${faceUrl(pilotId, exp)}" alt="">`;

  return (
    `<span class="${cls}" style="width:${size}px;height:${size}px">${layers}</span>`
  );
}

// ───────── 立ち絵（酒場の場面用） ─────────

/**
 * 上半身の立ち絵（`public/art/tex/bust-<人物id>.webp`）を持っている人物。
 *
 * 顔画像（`face-<id>-<表情>.jpg`）と同じ人物から起こしてあるので、
 * 立ち絵と会話ボックスの顔は必ず同じ顔になる。
 * 用意してあるのは酒場に出る面々（飛行隊8名と酒保）だけで、
 * 無い人物は `BarScene` 側が顔画像で代替する。
 */
export const BUST_ART_IDS: ReadonlySet<string> = new Set([
  'confed-15', // Vesper / 柊 奏
  'confed-17', // Sable / 桐谷 綾
  'confed-18', // Aster / 黒瀬 日和
  'confed-20', // Nova / 東雲 澪
  'confed-21', // 酒保 / 七瀬 結衣
  'confed-23', // Orion / 橘 蒼真
  'confed-25', // Tempest / 榊 恒一
  'confed-26', // Raven / 藤堂 悠真
  'confed-28', // Solace / 久世 朔
]);

/** 立ち絵がある人物か。引数は人物名簿の id（パイロット id ではない） */
export function hasBustArt(personId: string): boolean {
  return BUST_ART_IDS.has(personId);
}

export function bustUrl(personId: string): string {
  return `${import.meta.env.BASE_URL}art/tex/bust-${personId}.webp`;
}

/** 無線の内容から表情を推定する */
export function expressionFor(text: string, tone?: string): Expression {
  if (tone === 'enemy') return 'grim';
  if (/助け|支援|まずい|痛い|駄目|後ろ|被弾/.test(text)) return 'strain';
  if (/見たか|やった|はは|よし|撃墜|当たっ/.test(text)) return 'grin';
  if (/……|終わり|名前|祈/.test(text)) return 'grim';
  return 'talk';
}
