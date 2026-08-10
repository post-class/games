import { describe, expect, it } from 'vitest';
import { PLAYABLE_SHIPS, shipDef } from '../../src/content/ships';

/**
 * T3-⑬-2 機体の性格の一言。
 *
 * ここで守りたいのは「文と数値が矛盾しないこと」。文だけ差し替えて実挙動が
 * 変わらない状態（`AI_CODING.md`）を作らないよう、文中の主張を実際の
 * `maxSpeed` / `turn` / `armor` / `hull` / `missiles` と機械的に突き合わせる。
 */

const ships = PLAYABLE_SHIPS.map((id) => shipDef(id));
const maxOf = (f: (s: (typeof ships)[number]) => number) => Math.max(...ships.map(f));
const minOf = (f: (s: (typeof ships)[number]) => number) => Math.min(...ships.map(f));
const avgOf = (f: (s: (typeof ships)[number]) => number) => ships.reduce((a, s) => a + f(s), 0) / ships.length;

const speed = (s: (typeof ships)[number]) => s.maxSpeed;
const pitch = (s: (typeof ships)[number]) => s.turn[0];
const armor = (s: (typeof ships)[number]) => s.armor.front;
const hull = (s: (typeof ships)[number]) => s.hull;
const missileKinds = (s: (typeof ships)[number]) => new Set(s.missiles.map((m) => m.missileId)).size;

describe('T3-⑬ 機体の性格の一言', () => {
  it('選べる4機すべてに character がある', () => {
    expect(PLAYABLE_SHIPS).toEqual(['hornet', 'scimitar', 'raptor', 'rapier']);
    for (const ship of ships) {
      expect(ship.character, ship.id).toBeTruthy();
      // 数値表の隣に置く1行なので、長すぎる文にしない
      expect(ship.character!.length, ship.id).toBeGreaterThanOrEqual(20);
      expect(ship.character!.length, ship.id).toBeLessThanOrEqual(40);
    }
  });

  it('4機の文がすべて違う（使い回しで差が消えていない）', () => {
    expect(new Set(ships.map((s) => s.character)).size).toBe(4);
  });

  it('ホーネット「最もよく曲がる／装甲も船体も最も薄い」は数値と一致する', () => {
    const s = shipDef('hornet');
    expect(s.character).toContain('最もよく曲がる');
    expect(pitch(s)).toBe(maxOf(pitch));
    expect(s.character).toContain('装甲も船体も最も薄い');
    expect(armor(s)).toBe(minOf(armor));
    expect(hull(s)).toBe(minOf(hull));
  });

  it('スミター「速さも旋回も装甲も中位」は、どの指標でも最大・最小でない', () => {
    const s = shipDef('scimitar');
    expect(s.character).toContain('中位');
    for (const f of [speed, pitch, armor, hull]) {
      expect(f(s)).not.toBe(maxOf(f));
      expect(f(s)).not.toBe(minOf(f));
    }
  });

  it('ラプター「最も遅く、最も曲がらない／装甲と船体は最厚」は数値と一致する', () => {
    const s = shipDef('raptor');
    expect(s.character).toContain('最も遅く、最も曲がらない');
    expect(speed(s)).toBe(minOf(speed));
    expect(pitch(s)).toBe(minOf(pitch));
    expect(s.character).toContain('装甲と船体は最厚');
    expect(armor(s)).toBe(maxOf(armor));
    expect(hull(s)).toBe(maxOf(hull));
  });

  it('ラピアーII「最も速く、ミサイルは3種／装甲は平均以下」は数値と一致する', () => {
    const s = shipDef('rapier');
    expect(s.character).toContain('最も速く');
    expect(speed(s)).toBe(maxOf(speed));
    expect(s.character).toContain('ミサイルは3種');
    expect(missileKinds(s)).toBe(3);
    expect(missileKinds(s)).toBe(maxOf(missileKinds));
    expect(s.character).toContain('装甲は平均以下');
    expect(armor(s)).toBeLessThan(avgOf(armor));
  });

  it('「最も〜」と書いた機体は1機ずつしかない（同じ主張が重複していない）', () => {
    const claims = [
      { text: '最もよく曲がる', id: 'hornet' },
      { text: '最も遅く', id: 'raptor' },
      { text: '最も速く', id: 'rapier' },
    ];
    for (const claim of claims) {
      const owners = ships.filter((s) => s.character?.includes(claim.text)).map((s) => s.id);
      expect(owners).toEqual([claim.id]);
    }
  });
});
