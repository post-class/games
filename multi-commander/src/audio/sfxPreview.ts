import type { SfxCategory } from '../app/settings';
import { audio } from './AudioManager';

/**
 * 効果音カテゴリの試聴 (W5-B)。
 *
 * 設定画面の [試聴] から呼ぶ。**本番と同じ `AudioManager` のメソッドを叩く**ので、
 * 「試聴では鳴るのに実戦では違う音」という状態を作らない。
 * 代表音は「設定を変えた効果がいちばん分かるもの」を選んでいる
 * (主砲はレーザー = 実音声と合成音の差が大きい、被弾は船体 = いちばん重い、など)。
 *
 * 注意: `AudioManager` は同じ音の連打を `throttled()` で間引くので、
 * 連打すると鳴らないことがある (警報 0.85 秒 / モチーフ 1.2 秒)。
 * エンジン音は鳴り続ける設計なので、試聴では短く鳴らして止める。
 */
export function previewSfx(category: SfxCategory): void {
  switch (category) {
    case 'gun':
      audio.gun('laser', 200, 0);
      break;
    case 'missile':
      audio.missileLaunch('torpedo', 200, 0);
      break;
    case 'impact':
      audio.armorHit(150, 0, 'hull');
      break;
    case 'explosion':
      audio.explosion(200, 0, 'large');
      break;
    case 'warning':
      audio.warning('missile');
      break;
    case 'lock':
      audio.lockTone(true, 'heat-seeker');
      break;
    case 'ui':
      audio.motif('carrier');
      break;
    case 'voice':
      audio.radioVoice('こちらセイバー、後方に付く。', 'friendly', 'Sable');
      break;
    case 'engine':
      audio.updateEngine(1, true, true);
      window.setTimeout(() => audio.stopEngine(), ENGINE_PREVIEW_MS);
      break;
  }
}

/** エンジン音の試聴時間 (ms)。鳴らしっぱなしにしないための上限。 */
const ENGINE_PREVIEW_MS = 900;
