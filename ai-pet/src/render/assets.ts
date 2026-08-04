import type { Emotion } from '../../shared/actions.js';
import type { GrowthStage, SpeciesId } from '../../shared/types.js';

/**
 * 画像の読み込み。
 *
 * アセット（img-gen-gpt で生成した透過PNG）が無い環境でも動くよう、
 * 読み込みに失敗したら手続き描画にフォールバックする。
 * これにより「アセット生成前でも遊べる／生成後は自動でリッチになる」。
 */

export type PetPose = 'idle' | 'happy' | 'sad' | 'sleepy' | 'excited' | 'sulky';

const POSE_BY_EMOTION: Record<Emotion, PetPose> = {
  happy: 'happy',
  excited: 'excited',
  sad: 'sad',
  angry: 'sulky',
  sulky: 'sulky',
  sleepy: 'sleepy',
  curious: 'idle',
};

export function poseFor(emotion: Emotion): PetPose {
  return POSE_BY_EMOTION[emotion] ?? 'idle';
}

const cache = new Map<string, HTMLImageElement | null>();
const pending = new Map<string, Promise<HTMLImageElement | null>>();

/** 読み込み済みなら画像、失敗済みなら null、未読なら読み込みを始めて null を返す。 */
export function image(path: string): HTMLImageElement | null {
  if (cache.has(path)) return cache.get(path) ?? null;
  if (!pending.has(path)) {
    pending.set(
      path,
      new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          cache.set(path, img);
          resolve(img);
        };
        img.onerror = () => {
          cache.set(path, null);
          resolve(null);
        };
        img.src = path;
      }),
    );
  }
  return null;
}

/**
 * 表情ごとの PNG が無い場合は idle にフォールバックする。
 * アセットを少しずつ増やしていけるようにするため（一部だけ手続き描画に戻ると
 * 絵柄が混ざって不自然になる）。
 */
export function petImage(
  species: SpeciesId,
  stage: GrowthStage,
  pose: PetPose,
): HTMLImageElement | null {
  if (stage === 'egg') return image(`/assets/pets/egg_${species}.png`);
  const exact = image(`/assets/pets/${species}_${stage}_${pose}.png`);
  if (exact) return exact;
  return pose === 'idle' ? null : image(`/assets/pets/${species}_${stage}_idle.png`);
}

export function itemImage(itemId: string): HTMLImageElement | null {
  return image(`/assets/items/${itemId}.png`);
}

export function roomImage(kind: 'wall' | 'floor', variant: string): HTMLImageElement | null {
  return image(`/assets/room/${kind}_${variant}.png`);
}

/** 事前読み込み（初回のちらつきを減らす）。 */
export function preloadFor(species: SpeciesId, stage: GrowthStage): void {
  const poses: PetPose[] = ['idle', 'happy', 'sad', 'sleepy', 'excited', 'sulky'];
  if (stage === 'egg') {
    petImage(species, 'egg', 'idle');
    return;
  }
  for (const pose of poses) petImage(species, stage, pose);
}
