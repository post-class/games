import { describe, expect, it } from 'vitest';
import { SHIPS, SHIP_ID_ALIASES, shipDef, type Faction } from '../../src/content/ships';

/**
 * 機体データと機体名鑑（機体_機体名鑑.html）の一致を固定値で検証する。
 *
 * 名鑑は実装値の転記が原則なので、名鑑の数値をここへ直接書き、
 * 実装が黙って動かないようにする。HUD・格納庫・ブリーフィングの表示は
 * すべて同じ `ShipDef` から生成されるため、この検証が表示値の検証にもなる。
 */
describe('連邦6機の性能値が機体名鑑どおり', () => {
  it('F-54 ホーネット: 最高速400 / AB800 / 船体100 / 全周装甲25 / シールド42・毎秒7', () => {
    const d = shipDef('hornet');
    expect(d.name).toBe('F-54 ホーネット');
    expect(d.maxSpeed).toBe(400);
    expect(d.abSpeed).toBe(800);
    expect(d.hull).toBe(100);
    expect(d.armor).toEqual({ front: 25, rear: 25, left: 25, right: 25 });
    expect(d.shield).toEqual({ front: 42, rear: 42, regen: 7 });
    expect(d.guns.map((g) => g.gunId)).toEqual(['laser', 'laser']);
    expect(d.missiles).toEqual([{ missileId: 'dumbfire', count: 2 }]);
  });

  it('F-38 スミター: 船体180 / 前45・後左右40 / シールド68・毎秒6', () => {
    const d = shipDef('scimitar');
    expect(d.hull).toBe(180);
    expect(d.armor).toEqual({ front: 45, rear: 40, left: 40, right: 40 });
    expect(d.shield).toEqual({ front: 68, rear: 68, regen: 6 });
    expect(d.guns.map((g) => g.gunId)).toEqual(['mass-driver', 'mass-driver']);
    expect(d.missiles).toEqual([
      { missileId: 'dumbfire', count: 2 },
      { missileId: 'heat-seeker', count: 1 },
    ]);
  });

  it('F-44 ラプター: 船体300 / 前80・後左右70 / シールド100・毎秒6.5', () => {
    const d = shipDef('raptor');
    expect(d.hull).toBe(300);
    expect(d.armor).toEqual({ front: 80, rear: 70, left: 70, right: 70 });
    expect(d.shield).toEqual({ front: 100, rear: 100, regen: 6.5 });
    expect(d.guns.map((g) => g.gunId)).toEqual([
      'laser', 'laser', 'neutron-gun', 'neutron-gun',
    ]);
    expect(d.missiles).toEqual([
      { missileId: 'dumbfire', count: 3 },
      { missileId: 'heat-seeker', count: 3 },
    ]);
  });

  it('F-44A ラピアーII: 最高速450 / AB900 / 船体160 / 前40・後左右35 / シールド82・毎秒7', () => {
    const d = shipDef('rapier');
    expect(d.maxSpeed).toBe(450);
    expect(d.abSpeed).toBe(900);
    expect(d.hull).toBe(160);
    expect(d.armor).toEqual({ front: 40, rear: 35, left: 35, right: 35 });
    expect(d.shield).toEqual({ front: 82, rear: 82, regen: 7 });
    expect(d.guns.map((g) => g.gunId)).toEqual([
      'laser', 'laser', 'mass-driver', 'mass-driver',
    ]);
    expect(d.missiles).toEqual([
      { missileId: 'dumbfire', count: 2 },
      { missileId: 'heat-seeker', count: 2 },
      { missileId: 'image-rec', count: 1 },
    ]);
  });

  it('ドレイマン級輸送艦: 船体620 / 全周110 / シールド150・毎秒4 / 上部レーザー砲塔', () => {
    const d = shipDef('drayman');
    expect(d.role).toBe('transport');
    expect(d.hull).toBe(620);
    expect(d.armor).toEqual({ front: 110, rear: 110, left: 110, right: 110 });
    expect(d.shield).toEqual({ front: 150, rear: 150, regen: 4 });
    expect(d.guns).toHaveLength(1);
    expect(d.guns[0].gunId).toBe('laser');
    // 「上部」砲塔なので砲口は機体上方（Y > 0）にある。
    expect(d.guns[0].offset[1]).toBeGreaterThan(0);
    expect(d.missiles).toEqual([]);
  });

  it('TCS タイガーズ・クロー: 船体6000 / 全周800 / シールド700・毎秒10 / ニュートロン砲×3', () => {
    const d = shipDef('tigers-claw');
    expect(d.role).toBe('capital');
    expect(d.hull).toBe(6000);
    expect(d.armor).toEqual({ front: 800, rear: 800, left: 800, right: 800 });
    expect(d.shield).toEqual({ front: 700, rear: 700, regen: 10 });
    expect(d.guns.map((g) => g.gunId)).toEqual(['neutron-gun', 'neutron-gun', 'neutron-gun']);
    expect(d.missiles).toEqual([]);
  });

  it('連邦6機の faction は confed', () => {
    for (const id of ['hornet', 'scimitar', 'raptor', 'rapier', 'drayman', 'tigers-claw']) {
      expect(shipDef(id).faction, id).toBe('confed');
    }
  });
});

describe('帝国機の新名鑑への差し替えと旧idの後方互換', () => {
  /** 旧id → 新id・新表示名（P0-4 の決定どおりの差し替え結果）。 */
  const LEGACY: readonly (readonly [string, string, string])[] = [
    ['dralthi', 'kf03-greyhaul', 'KF03 グレイハウル'],
    ['salthi', 'ke04-mirage', 'KE04 ミラージュ'],
    ['krant', 'kf01-leonfang', 'KF01 レオンファング'],
    ['gratha', 'kb02-bastion', 'KB02 バスティオン'],
    ['jalthi', 'kf06-talon', 'KF06 タロン'],
    ['dorkir', 'kb05-boarbreaker', 'KB05 ボアブレイカー'],
    ['ralatha', 'kilrashi-destroyer', '帝国駆逐艦'],
  ];

  it.each(LEGACY)('旧id %s が新id %s へ解決される', (oldId, newId, name) => {
    const d = shipDef(oldId);
    expect(d.id).toBe(newId);
    expect(d.name).toBe(name);
    // 旧idと新idはまったく同じ定義オブジェクトを指す（表示だけの差し替えではない）。
    expect(d).toBe(shipDef(newId));
  });

  it('エイリアス表の網羅と、旧idが SHIPS 本体に残っていないこと', () => {
    expect(Object.keys(SHIP_ID_ALIASES).sort()).toEqual(LEGACY.map(([o]) => o).sort());
    for (const [oldId] of LEGACY) expect(SHIPS[oldId]).toBeUndefined();
  });

  it('差し替え後も帝国機の性能値（バランス検証済みの値）が維持されている', () => {
    // 差し替えは id と表示名だけ。数値が変わっていないことを代表機で固定する。
    expect(shipDef('kf03-greyhaul').hull).toBe(130);
    expect(shipDef('ke04-mirage').maxSpeed).toBe(420);
    expect(shipDef('kf01-leonfang').hull).toBe(175);
    expect(shipDef('kb02-bastion').hull).toBe(280);
    expect(shipDef('kf06-talon').guns).toHaveLength(6);
    expect(shipDef('kb05-boarbreaker').hull).toBe(430);
    expect(shipDef('kilrashi-destroyer').hull).toBe(2000);
  });

  it('帝国機の faction は kilrathi で、造形の癖も kilrathi のまま', () => {
    for (const [, newId] of LEGACY) {
      expect(shipDef(newId).faction, newId).toBe('kilrathi');
      expect(shipDef(newId).visual.style, newId).toBe('kilrathi');
    }
  });

  it('未知の機体idは例外になる（エイリアスが誤爆しない）', () => {
    expect(() => shipDef('no-such-ship')).toThrow(/unknown ship/);
  });
});

describe('非人類三勢力の追加機体', () => {
  /** 十章に登場する機体（P0-2 = A案の範囲）。 */
  const ALIEN: readonly (readonly [string, Faction, string])[] = [
    ['sc03-arc', 'serecion', 'SC03 アーク'],
    ['sh06-halcyon', 'serecion', 'SH06 ハルシオン'],
    ['sm04-miststep', 'serecion', 'SM04 ミストステップ'],
    ['oe06-ironroot', 'ordo', 'OE06 アイアンルート'],
    ['of02-spar', 'ordo', 'OF02 スパー'],
    ['nc01-protocol', 'neurowm', 'NC01 プロトコル'],
    ['nn04-sky', 'neurowm', 'NN04 スカイ'],
    ['nr03-mandible', 'neurowm', 'NR03 マンディブル'],
    ['nm02-mercy', 'neurowm', 'NM02 マーシー'],
  ];

  it.each(ALIEN)('%s は %s 所属で、装甲・シールド・速度が正の値', (id, faction, name) => {
    const d = shipDef(id);
    expect(d.id).toBe(id);
    expect(d.name).toBe(name);
    expect(d.faction).toBe(faction);

    for (const q of ['front', 'rear', 'left', 'right'] as const) {
      expect(d.armor[q], `armor.${q}`).toBeGreaterThan(0);
    }
    expect(d.hull).toBeGreaterThan(0);
    expect(d.shield.front).toBeGreaterThan(0);
    expect(d.shield.rear).toBeGreaterThan(0);
    expect(d.shield.regen).toBeGreaterThan(0);
    expect(d.maxSpeed).toBeGreaterThan(0);
    expect(d.abSpeed).toBeGreaterThanOrEqual(d.maxSpeed);
    expect(d.radius).toBeGreaterThan(0);
    expect(d.guns.length).toBeGreaterThan(0);
  });

  it('9機すべてが登録されている', () => {
    for (const [id] of ALIEN) expect(SHIPS[id], id).toBeDefined();
  });

  it('数値が既存の連邦・帝国機のレンジに収まっている', () => {
    const humanFighters = ['hornet', 'scimitar', 'raptor', 'rapier'].map((id) => shipDef(id));
    const maxFighterSpeed = Math.max(...humanFighters.map((d) => d.maxSpeed));
    const capitalHullMax = shipDef('tigers-claw').hull;

    for (const [id] of ALIEN) {
      const d = shipDef(id);
      // 戦闘機は人類最速機（ラピアー450）を超えない。
      if (d.role === 'fighter') expect(d.maxSpeed, id).toBeLessThanOrEqual(maxFighterSpeed);
      // どの艦も母艦タイガーズ・クロー（6000）より硬くはしない。
      expect(d.hull, id).toBeLessThanOrEqual(capitalHullMax);
    }
  });

  it('救難・護衛機のシールド再生は追撃・偵察機より高い（バリア秒数の写像）', () => {
    // 名鑑のスピードバリア秒数を再生速度へ写像した設計意図を固定する。
    expect(shipDef('sh06-halcyon').shield.regen).toBeGreaterThan(shipDef('sm04-miststep').shield.regen);
    expect(shipDef('sc03-arc').shield.regen).toBeGreaterThan(shipDef('nr03-mandible').shield.regen);
    expect(shipDef('nm02-mercy').shield.regen).toBeGreaterThan(shipDef('nr03-mandible').shield.regen);
  });
});

describe('機体データ全体の整合', () => {
  it('全機体の id が重複していない（登録キーと定義の id も一致する）', () => {
    const ids = Object.values(SHIPS).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [key, def] of Object.entries(SHIPS)) expect(def.id, key).toBe(key);
  });

  it('エイリアスの旧idが新idと衝突しない', () => {
    for (const [oldId, newId] of Object.entries(SHIP_ID_ALIASES)) {
      expect(SHIPS[oldId], oldId).toBeUndefined();
      expect(SHIPS[newId], newId).toBeDefined();
    }
  });

  it('全機体に faction が設定されている', () => {
    const allowed: readonly Faction[] = ['confed', 'kilrathi', 'serecion', 'ordo', 'neurowm', 'neutral'];
    for (const def of Object.values(SHIPS)) expect(allowed, def.id).toContain(def.faction);
  });
});
