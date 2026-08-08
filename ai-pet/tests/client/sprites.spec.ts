/**
 * D-3（睡眠ポーズ）/ D-5（プレイヤー4色）/ D-6（いのししのスケールハック）の描画側。
 *
 * Pixi の Sprite を作らずに済む範囲だけを見る（`ActorLayer.sync` は Container と camera が要るため、
 * 分岐は `charLook` / `CharTextureSet` に切り出してテスト対象にしている）。
 */
import { describe, expect, it } from 'vitest';
import type { Texture } from 'pixi.js';
import {
  BOAR_SCALE,
  CharTextureSet,
  SLEEP_ALPHA,
  SPECIES_SCALE,
  charLook,
} from '../../packages/client/src/render/sprites.ts';
import { sleepNames } from '../../packages/client/src/render/assets.ts';
import {
  DEFAULT_PLAYER_SPECIES,
  PLAYER_SPECIES,
  charPrefixes,
  normalizePlayerSpecies,
  sleepPrefixes,
} from '../../packages/client/src/state/species.ts';

/** テクスチャの中身は使わないので、識別できる目印だけ持たせた偽物を入れる */
function fakeTex(label: string): Texture {
  return { label } as unknown as Texture;
}

function setOf(keys: readonly string[]): CharTextureSet {
  return new CharTextureSet(
    keys.map((k) => [k, fakeTex(k)] as const),
    fakeTex('fallback'),
  );
}

describe('D-5 プレイヤー4色', () => {
  it('prefixOf が4色それぞれの名前を返す', () => {
    expect(CharTextureSet.prefixOf('player', 'a')).toBe('player_a');
    expect(CharTextureSet.prefixOf('player', 'b')).toBe('player_b');
    expect(CharTextureSet.prefixOf('player', 'c')).toBe('player_c');
    expect(CharTextureSet.prefixOf('player', 'd')).toBe('player_d');
  });

  it('空文字・未知の species は a に落ちる（4色化より前のプレイヤーを壊さない）', () => {
    expect(CharTextureSet.prefixOf('player', '')).toBe('player_a');
    expect(CharTextureSet.prefixOf('player', 'z')).toBe('player_a');
    expect(CharTextureSet.prefixOf('player', 'mofi')).toBe('player_a');
    expect(normalizePlayerSpecies(undefined)).toBe(DEFAULT_PLAYER_SPECIES);
    expect(normalizePlayerSpecies(null)).toBe('a');
  });

  it('ペットと動物の prefix は従来どおり（4色化の影響を受けない）', () => {
    expect(CharTextureSet.prefixOf('pet', 'mofi')).toBe('pet_mofi');
    expect(CharTextureSet.prefixOf('critter', 'boar')).toBe('critter_boar');
  });

  it('未知の species でも player_a のテクスチャが引ける', () => {
    const set = setOf(['player_a_n', 'player_a_e', 'player_a_s', 'player_a_w', 'player_b_s']);
    expect(set.get('player', 'zzz', 'e').label).toBe('player_a_e');
    // 方向が無いときは _s に落ちる（既存の挙動）
    expect(set.get('player', 'b', 'n').label).toBe('player_b_s');
  });

  it('charPrefixes が4色ぶんの player を含む（読み込む枚数は 4色×4方向）', () => {
    const prefixes = charPrefixes();
    for (const s of PLAYER_SPECIES) expect(prefixes).toContain(`player_${s}`);
    expect(prefixes.filter((p) => p.startsWith('player_'))).toHaveLength(4);
  });
});

describe('D-3 睡眠ポーズ', () => {
  it('睡眠テクスチャがあれば方向なしの _sleep に差し替え、半透明にしない', () => {
    const look = charLook('critter', 'rabbit', 'e', 'sleep', true);
    expect(look.texKey).toBe('critter_rabbit_sleep');
    expect(look.sleepPose).toBe(true);
    expect(look.alpha).toBe(1);
  });

  it('睡眠テクスチャが無いときは従来の見た目（立ち絵＋alpha 0.75）に落ちる', () => {
    const look = charLook('critter', 'rabbit', 'e', 'sleep', false);
    expect(look.texKey).toBe('critter_rabbit_e');
    expect(look.sleepPose).toBe(false);
    expect(look.alpha).toBeCloseTo(0.75);
    expect(SLEEP_ALPHA).toBeCloseTo(0.75);
  });

  it('起きているときは睡眠テクスチャがあっても立ち絵のまま', () => {
    for (const anim of ['idle', 'walk'] as const) {
      const look = charLook('pet', 'mofi', 'n', anim, true);
      expect(look.texKey).toBe('pet_mofi_n');
      expect(look.alpha).toBe(1);
      expect(look.sleepPose).toBe(false);
    }
  });

  it('hasSleep / getSleep が種ごとに独立している（1種だけ絵が入っても動く）', () => {
    const set = setOf(['critter_rabbit_s', 'critter_rabbit_sleep', 'critter_cat_s']);
    expect(set.hasSleep('critter', 'rabbit')).toBe(true);
    expect(set.getSleep('critter', 'rabbit')?.label).toBe('critter_rabbit_sleep');
    expect(set.hasSleep('critter', 'cat')).toBe(false);
    expect(set.getSleep('critter', 'cat')).toBeNull();
  });

  it('睡眠アセットは動物6種＋ペット5種の11枚で、プレイヤーは含まない', () => {
    const prefixes = sleepPrefixes();
    expect(prefixes).toHaveLength(11);
    expect(prefixes.some((p) => p.startsWith('player_'))).toBe(false);
    expect(prefixes).toContain('critter_boar');
    expect(prefixes).toContain('pet_hoshira');
  });

  it('読み込むファイル名は <kind>_<species>_sleep.png（方向を付けない）', () => {
    const names = sleepNames();
    expect(names).toHaveLength(11);
    expect(names).toContain('critter_rabbit_sleep.png');
    expect(names.every((n) => /^(pet|critter)_[a-z]+_sleep\.png$/.test(n))).toBe(true);
  });
});

describe('D-6 いのししのスケールハック', () => {
  it('ハックが掛かっているのは boar だけ（絵を差し替えたら BOAR_SCALE を 1.0 にする）', () => {
    expect(Object.keys(SPECIES_SCALE)).toEqual(['boar']);
    expect(SPECIES_SCALE['boar']).toBe(BOAR_SCALE);
    // 1.0 未満にすると接地影（shadows.ts）まで小さくなるので、下限だけ縛る
    expect(BOAR_SCALE).toBeGreaterThanOrEqual(1);
  });
});
