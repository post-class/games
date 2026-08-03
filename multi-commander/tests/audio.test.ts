import { Scene, Vector3, type BufferGeometry, type LineSegments } from 'three';
import { describe, expect, it } from 'vitest';
import { midiToHz, TRACKS, type TrackId } from '../src/audio/score';
import { SpaceDust } from '../src/render/SpaceDust';
import { shipDef } from '../src/content/ships';
import { spawnShip, World } from '../src/world/world';

const IDS: TrackId[] = ['theme', 'combat', 'victory', 'requiem'];

describe('BGM の譜面', () => {
  it('4系統すべてが定義されている', () => {
    for (const id of IDS) {
      expect(TRACKS[id]).toBeTruthy();
      expect(TRACKS[id].id).toBe(id);
      expect(TRACKS[id].layers.length).toBeGreaterThan(0);
    }
  });

  it('音符の長さは正で、音程は可聴域に収まる', () => {
    for (const id of IDS) {
      for (const layer of TRACKS[id].layers) {
        expect(layer.notes.length).toBeGreaterThan(0);
        for (const n of layer.notes) {
          expect(n.d).toBeGreaterThan(0);
          if (n.n === null) continue;
          const hz = midiToHz(n.n + (layer.octave ?? 0) * 12);
          expect(hz).toBeGreaterThan(30);
          expect(hz).toBeLessThan(5000);
        }
      }
    }
  });

  it('各層の長さは小節 (4拍) の倍数なので、ループしても縦がずれない', () => {
    for (const id of IDS) {
      for (const layer of TRACKS[id].layers) {
        const beats = layer.notes.reduce((a, n) => a + n.d, 0);
        // 浮動小数の誤差を許容して 4 拍の倍数かを見る
        expect(Math.abs((beats / 4) % 1)).toBeLessThan(1e-6);
      }
    }
  });

  it('テンポは戦闘曲が最も速く、追悼が最も遅い', () => {
    expect(TRACKS.combat.bpm).toBeGreaterThan(TRACKS.theme.bpm);
    expect(TRACKS.requiem.bpm).toBeLessThan(TRACKS.theme.bpm);
    // 戦闘曲だけ緊張度でテンポが上がる
    expect(TRACKS.combat.bpmBoost ?? 0).toBeGreaterThan(0);
  });

  it('戦闘曲は緊張度で層が増える (静かなときは低音だけ)', () => {
    const gates = TRACKS.combat.layers.map((l) => l.fromIntensity ?? 0);
    expect(gates.filter((g) => g === 0).length).toBe(1);
    expect(Math.max(...gates)).toBeGreaterThan(0.7);
  });

  it('A4 は 440Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
  });
});

describe('ジャンプ演出 (宇宙塵の筋)', () => {
  /** 線分の長さの平均を測る */
  function meanTail(scene: Scene): number {
    const mesh = scene.children[0] as LineSegments;
    const pos = (mesh.geometry as BufferGeometry).attributes.position;
    let sum = 0;
    const count = pos.count / 2;
    for (let i = 0; i < count; i++) {
      const dx = pos.getX(i * 2 + 1) - pos.getX(i * 2);
      const dy = pos.getY(i * 2 + 1) - pos.getY(i * 2);
      const dz = pos.getZ(i * 2 + 1) - pos.getZ(i * 2);
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return sum / count;
  }

  it('warp を上げると塵が長い筋に伸びる', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });
    player.vel.set(0, 0, -200);

    const scene = new Scene();
    const dust = new SpaceDust(scene);
    dust.update(player);
    const normal = meanTail(scene);

    dust.setWarp(1);
    dust.update(player);
    const warped = meanTail(scene);

    expect(normal).toBeGreaterThan(0);
    // 明確に「流れている」と分かる差が必要
    expect(warped).toBeGreaterThan(normal * 10);

    // 戻せば元の長さに戻る
    dust.setWarp(0);
    dust.update(player);
    expect(meanTail(scene)).toBeCloseTo(normal, 3);
  });
});
