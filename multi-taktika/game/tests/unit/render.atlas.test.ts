/**
 * アトラス描画の検証（T-M17-01）。
 *
 * ■ ここで守りたいこと
 *  1. **アセットが 1 枚も無くてもゲームが動く**。アトラスは「あれば綺麗になる」だけの
 *     追加物で、無いときに例外が飛んだり画面が真っ黒になってはいけない。
 *  2. **manifest が壊れていたら黙って絵無しにせず、理由付きで落ちる**。
 *     「絵が出ないけど原因が分からない」を作らない。
 *  3. 引き当てに失敗したキーが分かる（アセット追加の抜けを見つけられる）。
 *
 * 実ブラウザの `Image` / `fetch` は使わないので、描画は偽の ctx で受ける。
 */

import { describe, expect, it } from 'vitest';
import {
  AtlasSpriteProvider,
  buildingKeyOf,
  parseManifest,
  resourceKeyOf,
  spriteKeyOf,
  type AtlasImage,
  type AtlasManifest,
} from '@/render/atlas';
import { FallbackSpriteProvider, PlaceholderSpriteProvider } from '@/render/placeholder';
import { unitDefById, buildingDefById } from '@/sim/core/defs';

/** 呼ばれた命令を記録するだけの ctx。描画結果ではなく**手数**を見る。 */
function fakeCtx() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: () => calls.push('beginPath'),
    arc: () => calls.push('arc'),
    ellipse: () => calls.push('ellipse'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    closePath: () => calls.push('closePath'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    fillText: () => calls.push('fillText'),
    drawImage: () => calls.push('drawImage'),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: () => calls.push('translate'),
    scale: () => calls.push('scale'),
  };
  return { ctx: ctx as unknown as Parameters<AtlasSpriteProvider['drawUnit']>[0], calls };
}

const FAKE_IMAGE = { width: 64, height: 64 } as unknown as AtlasImage;

function manifestWith(keys: readonly string[]): AtlasManifest {
  const frames: Record<string, { x: number; y: number; w: number; h: number }> = {};
  keys.forEach((k, i) => {
    frames[k] = { x: i * 16, y: 0, w: 16, h: 16 };
  });
  return { version: 1, image: 'atlas.webp', size: { w: 256, h: 16 }, frames };
}

const villager = unitDefById('villager');
const townCenter = buildingDefById('town_center');

describe('AtlasSpriteProvider — アセットが無くても動く', () => {
  it('読み込み前は ready() が false（呼び出し側がプレースホルダに落とせる）', () => {
    const p = new AtlasSpriteProvider();
    expect(p.ready()).toBe(false);
  });

  it('FallbackSpriteProvider は ready() が false のあいだ図形で描く', () => {
    const atlas = new AtlasSpriteProvider();
    const fb = new FallbackSpriteProvider(atlas);
    const { ctx, calls } = fakeCtx();
    fb.drawUnit(ctx, 10, 10, {
      typeId: villager.index,
      owner: 0,
      color: '#f00',
      radiusPx: 6,
      glyph: '民',
      dir: 0,
      frame: 0,
    });
    // 図形（arc）で描かれ、画像は使われていない
    expect(calls).toContain('arc');
    expect(calls).not.toContain('drawImage');
    // 落ちる先はプレースホルダと同じ手数になる
    const ph = fakeCtx();
    new PlaceholderSpriteProvider().drawUnit(ph.ctx, 10, 10, {
      typeId: villager.index,
      owner: 0,
      color: '#f00',
      radiusPx: 6,
      glyph: '民',
      dir: 0,
      frame: 0,
    });
    expect(calls).toEqual(ph.calls);
  });

  it('読み込み後は drawImage を使う', () => {
    const key = spriteKeyOf(villager.sprite);
    expect(key).not.toBeNull();
    const p = new AtlasSpriteProvider(FAKE_IMAGE, manifestWith([key!]));
    expect(p.ready()).toBe(true);
    const { ctx, calls } = fakeCtx();
    p.drawUnit(ctx, 10, 10, {
      typeId: villager.index,
      owner: 0,
      color: '#f00',
      radiusPx: 6,
      glyph: '民',
      dir: 0,
      frame: 0,
    });
    expect(calls).toContain('drawImage');
  });

  it('絵が無いユニットはそのユニットだけ図形になる（画面全体が壊れない）', () => {
    // アトラスには町の中心しか入っていない状態で村人を描く
    const p = new AtlasSpriteProvider(FAKE_IMAGE, manifestWith([buildingKeyOf(townCenter.id)]));
    const { ctx, calls } = fakeCtx();
    p.drawUnit(ctx, 10, 10, {
      typeId: villager.index,
      owner: 0,
      color: '#f00',
      radiusPx: 6,
      glyph: '民',
      dir: 0,
      frame: 0,
    });
    expect(calls).not.toContain('drawImage');
    expect(calls).toContain('arc');
    // 建物のほうは画像で描ける
    const b = fakeCtx();
    p.drawBuilding(b.ctx, 10, 10, {
      typeId: townCenter.index,
      owner: 0,
      color: '#f00',
      wPx: 40,
      hPx: 40,
      glyph: '城',
      buildRatio: 1,
    });
    expect(b.calls).toContain('drawImage');
  });

  it('引き当てに失敗したキーを列挙できる（アセット追加の抜けを見つけられる）', () => {
    const p = new AtlasSpriteProvider(FAKE_IMAGE, manifestWith([]));
    const { ctx } = fakeCtx();
    p.drawUnit(ctx, 0, 0, {
      typeId: villager.index,
      owner: 0,
      color: '#f00',
      radiusPx: 6,
      glyph: '民',
      dir: 0,
      frame: 0,
    });
    p.drawBuilding(ctx, 0, 0, {
      typeId: townCenter.index,
      owner: 0,
      color: '#f00',
      wPx: 40,
      hPx: 40,
      glyph: '城',
      buildRatio: 1,
    });
    expect(p.missingKeys()).toEqual([buildingKeyOf('town_center'), 'units/villager']);
  });

  it('建設中は暗幕を足す（絵が完成形しか無くても進捗が見える）', () => {
    const p = new AtlasSpriteProvider(FAKE_IMAGE, manifestWith([buildingKeyOf(townCenter.id)]));
    const done = fakeCtx();
    p.drawBuilding(done.ctx, 0, 0, {
      typeId: townCenter.index, owner: 0, color: '#f00', wPx: 40, hPx: 40, glyph: '城', buildRatio: 1,
    });
    const half = fakeCtx();
    p.drawBuilding(half.ctx, 0, 0, {
      typeId: townCenter.index, owner: 0, color: '#f00', wPx: 40, hPx: 40, glyph: '城', buildRatio: 0.5,
    });
    expect(half.calls.filter((c) => c === 'fillRect').length).toBeGreaterThan(
      done.calls.filter((c) => c === 'fillRect').length,
    );
  });
});

describe('manifest の検証 — 壊れていたら理由付きで落ちる', () => {
  it('正しい manifest は通る', () => {
    const m = parseManifest(JSON.parse(JSON.stringify(manifestWith(['units/villager']))));
    expect(m.frames['units/villager']).toEqual({ x: 0, y: 0, w: 16, h: 16 });
  });

  it.each([
    ['object でない', 42, 'object'],
    ['version が違う', { version: 99 }, 'version'],
    ['image が無い', { version: 1 }, 'image'],
    ['size が無い', { version: 1, image: 'a.webp' }, 'size'],
    ['frames が無い', { version: 1, image: 'a.webp', size: { w: 1, h: 1 } }, 'frames'],
    [
      'frame の座標が数値でない',
      { version: 1, image: 'a.webp', size: { w: 1, h: 1 }, frames: { a: { x: 'z', y: 0, w: 1, h: 1 } } },
      'x',
    ],
  ])('%s → 例外（黙って絵無しにしない）', (_name, raw, needle) => {
    expect(() => parseManifest(raw)).toThrow(new RegExp(needle as string));
  });
});

describe('引き当てキー', () => {
  it('sprite の拡張子を落としたものがキー', () => {
    expect(spriteKeyOf('units/villager.webp')).toBe('units/villager');
    expect(spriteKeyOf('units/no_ext')).toBe('units/no_ext');
  });

  it('sprite が空なら null（プレースホルダに落ちる）', () => {
    expect(spriteKeyOf('')).toBeNull();
  });

  it('建物と資源は id から組む', () => {
    expect(buildingKeyOf('town_center')).toBe('buildings/town_center');
    expect(resourceKeyOf('forest')).toBe('resources/forest');
  });
});
