/**
 * T4-⑯ 追補: 撃墜したエースの脱出ポッド。
 *
 * 「撃たない」を選択にするには、撃てる的が実際に空域に残っていて、
 * かつ**プレイヤーの意思でしか撃たれない**必要がある。
 * ここではその成立条件（中立・無武装・ロック不可・AI が狙わない）を固定する。
 */
import { Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { aceIdFromPodTag, readAceOath, spawnAcePod } from '../../src/app/game';
import { aceDef } from '../../src/content/aces';
import { shipDef } from '../../src/content/ships';
import { newAi, resetDuel, updateAi } from '../../src/sim/ai';
import { targetNearest, targetNext } from '../../src/sim/targeting';
import { spawnShip, World } from '../../src/world/world';
import { reseed } from '../../src/core/rng';

const DT = 1 / 60;

function buildPod() {
  const world = new World();
  const player = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(0, 0, 0),
    speed: 0,
  });
  world.playerId = player.id;
  const def = aceDef('ragitika')!;
  const pod = spawnAcePod(world, {
    aceId: def.id,
    pilot: def.pilot,
    def: shipDef(def.shipId),
    pos: new Vector3(0, 0, -400),
    quat: new Quaternion(),
    vel: new Vector3(0, 0, -200),
  });
  return { world, player, pod, def };
}

describe('エースの脱出ポッド', () => {
  beforeEach(() => {
    reseed(0x51ed5eed);
    resetDuel();
  });

  it('中立・無武装・脱出済みとして出る', () => {
    const { pod, def } = buildPod();
    expect(pod.faction).toBe('neutral');
    expect(pod.ship!.ejected).toBe(true);
    expect(pod.ship!.missiles).toEqual([]);
    expect(pod.ship!.flares).toBe(0);
    expect(pod.ship!.energy).toBe(0);
    expect(pod.ship!.hull).toBeGreaterThan(0);
    expect(pod.ship!.hull).toBeLessThan(shipDef(def.shipId).hull);
    expect(pod.radius).toBeLessThan(shipDef(def.shipId).radius);
    expect(pod.label).toContain('脱出ポッド');
  });

  it('tag からエースidを引ける', () => {
    const { pod, def } = buildPod();
    expect(aceIdFromPodTag(pod.tag)).toBe(def.id);
    expect(aceIdFromPodTag(undefined)).toBeUndefined();
    expect(aceIdFromPodTag('escort-1')).toBeUndefined();
  });

  it('ターゲット選択の候補に入らない — 撃つには手動で狙う必要がある', () => {
    const { world, player, pod } = buildPod();
    expect(targetNearest(world, player)).toBeUndefined();
    expect(targetNext(world, player)).toBeUndefined();
    expect(player.ship!.targetId).not.toBe(pod.id);
  });

  it('僚機も敵も座席を撃たない', () => {
    const { world, player, pod } = buildPod();
    const wingman = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(150, 0, 60),
      speed: 0,
      ai: newAi(0.7, { leaderId: player.id, order: 'break-and-attack' }),
    });
    const enemy = spawnShip(world, {
      def: shipDef('kf03-greyhaul'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -900),
      speed: 0,
      ai: newAi(0.7),
    });
    for (let i = 0; i < 180; i++) updateAi(world, DT, { maxAttackersOnPlayer: 4 });
    expect(wingman.ai!.targetId).not.toBe(pod.id);
    expect(enemy.ai!.targetId).not.toBe(pod.id);
    expect(pod.alive).toBe(true);
  });

  it('ポッド自身は撃たず、機動もしない', () => {
    const { world, pod } = buildPod();
    for (let i = 0; i < 120; i++) updateAi(world, DT);
    expect(pod.input!.firePrimary).toBe(false);
    expect(pod.input!.throttle).toBe(0);
  });

  it('保存データが無い環境では誓約値は中庸の 50 になる', () => {
    expect(readAceOath()).toBe(50);
  });
});
