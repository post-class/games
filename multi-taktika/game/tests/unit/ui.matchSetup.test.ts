/**
 * tests/unit/ui.matchSetup.test.ts — 対戦設定画面の純関数（T-M12-10 / `05§3`, `07§11`, `07§13`, `07§14`）
 *
 * DOM を触らない部分（スロットの検証・試合設定・URL 共有・マップ preview の生成）だけを試す。
 * preview は**実際に `generateMap` を呼ぶ**ので、「preview と試合の地形が一致する」ことも
 * ここで確かめられる（決定論のテスト）。
 */

import { describe, expect, it } from 'vitest';

import { MAP_TYPE_IDS } from '@/shared/types';
import { createMatch } from '@/sim';
import { RANDOM_CIV, type CivSlotId } from '@/ui/screens/CivSelect';
import {
  SLOT_COUNT,
  activePlayerCount,
  aiLevelLabel,
  aiLevelList,
  allReady,
  buildShareUrl,
  canStart,
  defaultSetup,
  gameSpeedRange,
  generatePreview,
  mapTypeList,
  navalValueLabel,
  parseShareParams,
  popCapOptions,
  roomIdFromSeed,
  startAgeList,
  startNeighbors,
  startResourcePresets,
  startResourceText,
  toMatchParams,
  validateSetup,
  type SetupState,
  type SlotState,
} from '@/ui/screens/MatchSetup';

/** スロットを 1 つ差し替える。 */
function patch(s: SetupState, i: number, p: Partial<SlotState>): SetupState {
  return { ...s, slots: s.slots.map((slot, k) => (k === i ? { ...slot, ...p } : slot)) };
}

/** 全スロットを埋めた 8 人の設定を作る（文明は指定した 1 種で埋める）。 */
function fullSetup(civ: CivSlotId): SetupState {
  let s = defaultSetup(4242);
  for (let i = 0; i < SLOT_COUNT; i++) {
    s = patch(s, i, {
      kind: i === 0 ? 'human' : 'ai',
      name: `P${i + 1}`,
      civ,
      team: i < 4 ? 1 : 2,
      aiLevel: i === 0 ? null : (aiLevelList()[2]?.id ?? null),
      ready: true,
    });
  }
  return s;
}

describe('defaultSetup — 既定値', () => {
  it('スロットは常に 8 要素で、人間 1 + AI 1 + 空き 6', () => {
    const s = defaultSetup(1);
    expect(s.slots).toHaveLength(SLOT_COUNT);
    expect(s.slots.filter((x) => x.kind === 'human')).toHaveLength(1);
    expect(s.slots.filter((x) => x.kind === 'ai')).toHaveLength(1);
    expect(s.slots.filter((x) => x.kind === 'empty')).toHaveLength(6);
    expect(activePlayerCount(s)).toBe(2);
  });

  it('試合設定の既定値は config.json の matchOptions と一致する', () => {
    const s = defaultSetup(1);
    expect(startAgeList().some((a) => a.id === s.startAge)).toBe(true);
    expect(startResourcePresets()).toContain(s.startResources);
    expect(s.gameSpeed).toBe(gameSpeedRange().def);
    expect(popCapOptions()).toContain(s.popCap);
    expect(validateSetup(s).ok).toBe(true);
  });
});

describe('AI 5 段階（05§3-4 / 07§11）', () => {
  it('5 段階が level 昇順で並ぶ', () => {
    const list = aiLevelList();
    expect(list).toHaveLength(5);
    expect(list.map((x) => x.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('段階 2 以上は戦域指令で戦う（戦域を 1 つ以上使う）', () => {
    for (const a of aiLevelList()) {
      if (a.level >= 2) expect(a.maxFronts).toBeGreaterThanOrEqual(1);
      else expect(a.maxFronts).toBe(0);
    }
  });

  it('最上位だけが固有令と二重旗を使う', () => {
    const top = aiLevelList()[4]!;
    expect(top.allowUniqueOrders).toBe(true);
    expect(top.allowDoubleFlag).toBe(true);
    for (const a of aiLevelList().slice(0, 4)) {
      expect(a.allowUniqueOrders).toBe(false);
      expect(a.allowDoubleFlag).toBe(false);
    }
  });

  it('段階のラベルに段階番号と名前が入る', () => {
    expect(aiLevelLabel(aiLevelList()[0]!.id)).toBe('段階1 素人');
    expect(aiLevelLabel(null)).toBe('');
  });
});

describe('validateSetup — 開始前に弾く条件', () => {
  it('参加者 1 人では開始できない', () => {
    const s = patch(defaultSetup(1), 1, { kind: 'empty', aiLevel: null, ready: false });
    expect(validateSetup(s).ok).toBe(false);
    expect(validateSetup(s).errors.join()).toContain('2 人以上');
  });

  it('AI の段階が空なら弾く', () => {
    const s = patch(defaultSetup(1), 1, { aiLevel: null });
    expect(validateSetup(s).errors.join()).toContain('AI の段階');
  });

  it('全員同じチームなら弾く（決着が付かない）', () => {
    const s = patch(defaultSetup(1), 1, { team: 1 });
    expect(validateSetup(s).errors.join()).toContain('同じチーム');
  });

  it('名前が空なら弾く', () => {
    expect(validateSetup(patch(defaultSetup(1), 0, { name: '  ' })).errors.join()).toContain('名前');
  });

  it('文明は重複してよい（8 人全員同じでも通る。05§3-3）', () => {
    const s = fullSetup('yamato');
    expect(activePlayerCount(s)).toBe(8);
    expect(validateSetup(s).ok).toBe(true);
  });

  it('範囲外のゲーム速度・不正なマップ型を弾く', () => {
    const s = defaultSetup(1);
    expect(validateSetup({ ...s, gameSpeed: 3 }).ok).toBe(false);
    expect(validateSetup({ ...s, mapType: 'atlantis' as never }).ok).toBe(false);
    expect(validateSetup({ ...s, startAge: 'chusei' as never }).ok).toBe(false);
    expect(validateSetup({ ...s, startResources: 'infinite' }).ok).toBe(false);
  });
});

describe('準備完了（05§3-7）', () => {
  it('人間が押していなければ開始できない', () => {
    const s = defaultSetup(1);
    expect(allReady(s)).toBe(false);
    expect(canStart(s)).toBe(false);
    const ready = patch(s, 0, { ready: true });
    expect(allReady(ready)).toBe(true);
    expect(canStart(ready)).toBe(true);
  });

  it('人間が 0 人なら開始できない（観戦は M15）', () => {
    const s = patch(defaultSetup(1), 0, { kind: 'ai', aiLevel: aiLevelList()[0]!.id, ready: true });
    expect(allReady(s)).toBe(false);
  });
});

describe('toMatchParams — 対戦画面へ渡す引数', () => {
  it('参加中のスロットだけを playerId 昇順で渡す', () => {
    const s = fullSetup('mali');
    const p = toMatchParams(s);
    expect(p.playerCount).toBe(8);
    expect(p.civs).toHaveLength(8);
    expect(p.teams).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(p.mapType).toBe(s.mapType);
    expect(p.seed).toBe(s.seed);
  });

  it('ランダム枠は seed から決定論的に解決される', () => {
    const s = fullSetup(RANDOM_CIV);
    const a = toMatchParams(s);
    const b = toMatchParams(s);
    expect(a.civs).toEqual(b.civs);
    expect(a.civs.some((c) => c === RANDOM_CIV as never)).toBe(false);
  });

  it('生成した引数で createMatch が通る（画面 → シムの結線）', () => {
    const s = patch(defaultSetup(777), 0, { ready: true });
    const p = toMatchParams(s);
    const { world } = createMatch({
      seed: p.seed,
      playerCount: p.playerCount,
      civs: [...p.civs],
      mapType: p.mapType,
    });
    expect(world.players).toHaveLength(2);
  });
});

describe('URL 共有（05§3。通信は M14）', () => {
  it('作った URL を読み戻すと同じ設定になる', () => {
    const s = fullSetup('viking');
    const url = buildShareUrl('https://example.com/game/', s);
    const query = url.slice(url.indexOf('?'));
    const back = parseShareParams(query)!;
    expect(back).not.toBeNull();
    expect(back.roomId).toBe(s.roomId);
    expect(back.seed).toBe(s.seed);
    expect(back.mapType).toBe(s.mapType);
    expect(back.startAge).toBe(s.startAge);
    expect(back.startResources).toBe(s.startResources);
    expect(back.gameSpeed).toBe(s.gameSpeed);
    expect(back.popCap).toBe(s.popCap);
    expect(back.slots.map((x) => x.kind)).toEqual(s.slots.map((x) => x.kind));
    expect(back.slots.map((x) => x.civ)).toEqual(s.slots.map((x) => x.civ));
    expect(back.slots.map((x) => x.team)).toEqual(s.slots.map((x) => x.team));
  });

  it('room が無いクエリは共有 URL ではない', () => {
    expect(parseShareParams('?seed=1')).toBeNull();
    expect(parseShareParams('')).toBeNull();
  });

  it('壊れたクエリでも既定値に落ちて例外を出さない', () => {
    const back = parseShareParams('?room=abc&seed=xx&map=atlantis&slots=zzz,,,')!;
    expect(back.slots).toHaveLength(SLOT_COUNT);
    expect(MAP_TYPE_IDS).toContain(back.mapType);
  });

  it('URL は既存のクエリを引き継がない（?を 1 つだけにする）', () => {
    const url = buildShareUrl('https://example.com/?dev=match', defaultSetup(5));
    expect(url.split('?')).toHaveLength(2);
    expect(url).toContain('room=');
  });

  it('部屋 ID は seed から決まる', () => {
    expect(roomIdFromSeed(20260809)).toBe(roomIdFromSeed(20260809));
    expect(roomIdFromSeed(1)).not.toBe(roomIdFromSeed(2));
  });
});

describe('試合設定の選択肢（07§14）', () => {
  it('開始時代 4 つに戦域スロット数が付く', () => {
    const ages = startAgeList();
    expect(ages).toHaveLength(4);
    expect(ages.map((a) => a.slots)).toEqual([1, 2, 3, 4]);
  });

  it('開始資源プリセットの中身が 1 行になる', () => {
    for (const p of startResourcePresets()) {
      expect(startResourceText(p)).toContain('食料');
    }
  });

  it('人口上限の選択肢に既定の 200 が入る', () => {
    expect(popCapOptions()).toContain(200);
  });
});

describe('マップ preview（05§3-1, 05§3-2）', () => {
  it('8 型すべてを生成でき、開始位置が人数ぶん出る', () => {
    for (const m of MAP_TYPE_IDS) {
      const p = generatePreview(m, 4, 99);
      expect(p.size).toBeGreaterThan(0);
      expect(p.tiles).toHaveLength(p.size * p.size);
      expect(p.starts).toHaveLength(4);
      expect(p.waterRatio).toBeGreaterThanOrEqual(0);
      expect(p.waterRatio).toBeLessThanOrEqual(1);
    }
  });

  it('preview の地形は試合の地形と同じ（同じ seed・型・人数なら一致）', () => {
    const p = generatePreview('river', 2, 31337);
    const { world } = createMatch({ seed: 31337, playerCount: 2, mapType: 'river' });
    expect(world.map.widthTiles).toBe(p.size);
    // 開始位置（マス）が一致する
    for (const st of p.starts) {
      const fx = world.map.starts[st.playerId * 2]!;
      const fy = world.map.starts[st.playerId * 2 + 1]!;
      expect(Math.floor(fx / 256)).toBe(st.tx);
      expect(Math.floor(fy / 256)).toBe(st.ty);
    }
    // 地形もタイル単位で一致する
    let same = true;
    for (let i = 0; i < p.tiles.length; i++) {
      if (p.tiles[i] !== world.map.tiles[i]) {
        same = false;
        break;
      }
    }
    expect(same).toBe(true);
  });

  it('水域の多い型ほど水域比が大きい（列島 > 平野・草原）', () => {
    const archi = generatePreview('archipelago', 2, 7).waterRatio;
    const plain = generatePreview('plain', 2, 7).waterRatio;
    const steppe = generatePreview('steppe', 2, 7).waterRatio;
    expect(archi).toBeGreaterThan(plain);
    expect(archi).toBeGreaterThan(steppe);
  });

  it('水域比の言い回しが段階的に変わる（港と船の価値）', () => {
    expect(navalValueLabel(0.0)).toContain('不要');
    expect(navalValueLabel(0.5)).toContain('前提');
    expect(new Set([0, 0.1, 0.3, 0.6].map(navalValueLabel)).size).toBe(4);
  });

  it('マップ型 8 種の一覧が maps.json から引ける', () => {
    const list = mapTypeList();
    expect(list).toHaveLength(8);
    for (const m of list) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.frontsMax).toBeGreaterThanOrEqual(m.frontsMin);
    }
  });

  it('startNeighbors は近い順・同距離は playerId 昇順で返す', () => {
    const starts = [
      { playerId: 0, tx: 0, ty: 0 },
      { playerId: 1, tx: 10, ty: 0 },
      { playerId: 2, tx: 0, ty: 10 },
      { playerId: 3, tx: 40, ty: 40 },
    ];
    expect(startNeighbors(starts, 0)).toEqual([1, 2]);
    expect(startNeighbors(starts, 3, 1)).toEqual([1]);
    expect(startNeighbors(starts, 9)).toEqual([]);
  });

  it('実際の開始位置でも隣が 2 人返る', () => {
    const p = generatePreview('plain', 4, 555);
    expect(startNeighbors(p.starts, 0)).toHaveLength(2);
  });
});
