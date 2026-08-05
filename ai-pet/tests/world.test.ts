import { describe, expect, it } from 'vitest';
import { ACTION_DURATION_MS, ACTION_LABELS, isPetAction, PET_ACTIONS } from '../shared/actions.js';
import {
  isNight,
  placeLabel,
  SPOTS,
  spotAppeal,
  ZONE_RANGES,
  ZONES,
  zoneAt,
  zonePoint,
} from '../shared/world.js';
import { clampPersonality, type Personality } from '../shared/personality.js';
import type { Needs } from '../shared/types.js';

/** 広いマップの定義が壊れていないことを固定する（座標のずれは画面では気づきにくい）。 */

const NEEDS: Needs = { hunger: 70, fun: 70, clean: 70, energy: 70, mood: 70 };

const personality = (patch: Partial<Personality> = {}): Personality =>
  clampPersonality({
    energy: 50,
    clingy: 50,
    willful: 50,
    clever: 50,
    social: 50,
    gluttony: 50,
    timid: 50,
    mischief: 50,
    ...patch,
  } as Personality);

describe('ゾーン', () => {
  it('世界を隙間なく 0〜1 で覆う', () => {
    expect(ZONE_RANGES[0].from).toBe(0);
    expect(ZONE_RANGES[ZONE_RANGES.length - 1].to).toBe(1);
    for (let i = 1; i < ZONE_RANGES.length; i += 1) {
      expect(ZONE_RANGES[i].from).toBeCloseTo(ZONE_RANGES[i - 1].to, 10);
    }
  });

  it('どの座標でもゾーンが決まる', () => {
    for (const x of [0, 0.01, 0.5, 0.999, 1]) {
      expect(ZONES.map((zone) => zone.id)).toContain(zoneAt(x).id);
    }
  });

  it('zonePoint はそのゾーンの中を指す', () => {
    for (const zone of ZONES) {
      const range = ZONE_RANGES.find((entry) => entry.zone.id === zone.id)!;
      const middle = zonePoint(zone.id, 0.5);
      expect(middle).toBeGreaterThanOrEqual(range.from);
      expect(middle).toBeLessThanOrEqual(range.to);
    }
  });
});

describe('スポット', () => {
  it('ID が重複しない', () => {
    expect(new Set(SPOTS.map((spot) => spot.id)).size).toBe(SPOTS.length);
  });

  it('行動はすべてホワイトリストに入っている', () => {
    for (const spot of SPOTS) {
      expect(spot.actions.length).toBeGreaterThan(0);
      for (const action of spot.actions) {
        expect(isPetAction(action)).toBe(true);
      }
    }
  });

  it('宣言したゾーンの中に置かれている', () => {
    for (const spot of SPOTS) {
      expect(zoneAt(spot.x).id).toBe(spot.zone);
    }
  });

  it('どのゾーンにも 1 つ以上ある（行っても何もない部屋を作らない）', () => {
    for (const zone of ZONES) {
      expect(SPOTS.filter((spot) => spot.zone === zone.id).length).toBeGreaterThan(0);
    }
  });

  /**
   * 行動ラベルは「みずたまりで はねている」のように場所を含む言葉なので、
   * 対応するスポット以外に置くと日本語として噛み合わなくなる。
   * E2E で「だいどころの れいぞうこで おはなの においを かいでいる」が出たため、
   * 場所限定の行動がどこに置けるかを固定する。
   */
  it('場所を名前に含む行動は、その場所にしか置かれていない', () => {
    const onlyAt: Record<string, string[]> = {
      sniff_flower: ['flowerbed'],
      splash_puddle: ['puddle'],
      chase_butterfly: ['butterfly'],
      climb_tree: ['tree'],
      stargaze: ['starspot'],
      chat_bird: ['birdnest'],
      check_mail: ['mailbox'],
      peek_window: ['window'],
      dig: ['dirt'],
      bury_treasure: ['dirt'],
      tidy_room: ['rug'],
      eat: ['bowl'],
      sulk_corner: ['frontdoor'],
    };
    for (const spot of SPOTS) {
      for (const action of spot.actions) {
        const allowed = onlyAt[action];
        if (!allowed) continue;
        expect(allowed, `${action} が ${spot.id} に置かれている`).toContain(spot.id);
      }
    }
  });

  it('屋外でしか成立しない行動は屋内に置かれていない', () => {
    const outdoorOnly = ['dig', 'bury_treasure', 'splash_puddle', 'chase_butterfly', 'climb_tree', 'stargaze', 'sunbathe', 'chat_bird', 'sniff_flower', 'check_mail'];
    for (const spot of SPOTS) {
      if (zoneAt(spot.x).indoor) {
        for (const action of spot.actions) {
          expect(outdoorOnly, `屋内の ${spot.id} に ${action}`).not.toContain(action);
        }
      }
    }
  });

  it('奥行きは 0〜1 の範囲', () => {
    for (const spot of SPOTS) {
      expect(spot.depth).toBeGreaterThanOrEqual(0);
      expect(spot.depth).toBeLessThanOrEqual(1);
    }
  });
});

describe('行動テーブル', () => {
  it('すべての行動にラベルと長さがある', () => {
    for (const action of PET_ACTIONS) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(ACTION_DURATION_MS[action]).toBeGreaterThan(0);
    }
  });
});

describe('spotAppeal', () => {
  it('ニーズが低いと、それを満たす場所の魅力が上がる', () => {
    const bowl = SPOTS.find((spot) => spot.id === 'bowl')!;
    const hungry = spotAppeal(bowl, { ...NEEDS, hunger: 5 }, personality());
    const full = spotAppeal(bowl, { ...NEEDS, hunger: 100 }, personality());
    expect(hungry).toBeGreaterThan(full);
  });

  it('性格が場所の好みに出る（食いしん坊はおさら、社交的はポスト）', () => {
    const bowl = SPOTS.find((spot) => spot.id === 'bowl')!;
    const mailbox = SPOTS.find((spot) => spot.id === 'mailbox')!;
    expect(spotAppeal(bowl, NEEDS, personality({ gluttony: 100 }))).toBeGreaterThan(
      spotAppeal(bowl, NEEDS, personality({ gluttony: 0 })),
    );
    expect(spotAppeal(mailbox, NEEDS, personality({ social: 100 }))).toBeGreaterThan(
      spotAppeal(mailbox, NEEDS, personality({ social: 0 })),
    );
  });

  it('満たされていても 0 にはならない（動かなくなると退屈になるため）', () => {
    const full: Needs = { hunger: 100, fun: 100, clean: 100, energy: 100, mood: 100 };
    for (const spot of SPOTS) {
      expect(spotAppeal(spot, full, personality())).toBeGreaterThan(0);
    }
  });
});

describe('isNight / placeLabel', () => {
  it('22時〜6時が夜', () => {
    expect(isNight(23)).toBe(true);
    expect(isNight(3)).toBe(true);
    expect(isNight(12)).toBe(false);
    expect(isNight(21)).toBe(false);
  });

  it('場所は「ゾーン の スポット」で言う', () => {
    expect(placeLabel('puddle')).toBe('にわの みずたまり');
  });

  it('知らないスポットでも文になる', () => {
    expect(placeLabel('nope')).toBeTruthy();
  });
});
