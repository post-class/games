import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { gltfUrlFor } from '../src/render/MeshFactory';
import { ShipVisualLifecycle } from '../src/render/ShipVisualLifecycle';

describe('ship visual replacement', () => {
  it('未指定・空文字・危険なURLはGLTF指定として扱わない', () => {
    expect(gltfUrlFor(undefined)).toBeUndefined();
    expect(gltfUrlFor('  ')).toBeUndefined();
    expect(gltfUrlFor('javascript:alert(1)')).toBeUndefined();
    expect(gltfUrlFor('data:model/gltf+json;base64,abc')).toBeUndefined();
    expect(gltfUrlFor('/art/ships/hornet.glb')).toBe('/art/ships/hornet.glb');
  });

  it('ロード成功時だけGLTFを適用し、ロード中は手続き生成状態を保つ', async () => {
    let resolve!: (visual: Group) => void;
    const load = new Promise<Group>((r) => { resolve = r; });
    const apply = vi.fn();
    const lifecycle = new ShipVisualLifecycle(apply);
    lifecycle.start(() => load);

    expect(lifecycle.state).toBe('loading');
    resolve(new Group());
    await load;
    await Promise.resolve();

    expect(lifecycle.state).toBe('gltf');
    expect(apply).toHaveBeenCalledOnce();
  });

  it('ロード失敗時は手続き生成フォールバック状態になり、適用しない', async () => {
    const apply = vi.fn();
    const onFailure = vi.fn();
    const lifecycle = new ShipVisualLifecycle(apply, onFailure);
    lifecycle.start(() => Promise.reject(new Error('missing asset')));
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.state).toBe('fallback');
    expect(apply).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('ローダーの同期例外もフォールバックへ戻す', () => {
    const onFailure = vi.fn();
    const lifecycle = new ShipVisualLifecycle(vi.fn(), onFailure);
    lifecycle.start(() => { throw new Error('loader unavailable'); });

    expect(lifecycle.state).toBe('fallback');
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('エンティティ消滅後に完了したロードは表示へ適用しない', async () => {
    let resolve!: (visual: Group) => void;
    const load = new Promise<Group>((r) => { resolve = r; });
    const apply = vi.fn();
    const lifecycle = new ShipVisualLifecycle(apply);
    lifecycle.start(() => load);
    lifecycle.cancel();
    resolve(new Group());
    await load;
    await Promise.resolve();

    expect(lifecycle.state).toBe('cancelled');
    expect(apply).not.toHaveBeenCalled();
  });
});
