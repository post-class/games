/**
 * T-M12-03: 戦域指令ビューの判定部分（`05§7` の 8 項目 / `07§7` / 手順書 §16-5）
 *
 * jsdom を入れていない（`vitest.config.ts` の `environment: 'node'`）ので、
 * **DOM を触らない純関数だけ**を検算する。canvas と DOM の見た目は目視確認（`V`）。
 *
 * ここで守りたい性質:
 *  1. 輪の太さが優勢・劣勢を表す（`05§7-1`）
 *  2. 同時に最大 6 つ（`05§7-2`）
 *  3. 伝達線が「点線が流れる → 届いた瞬間に実線」（`05§7-5`）。**先に実線にしない**
 *  4. 敵の戦域は中心・半径・番号・持ち主しか渡せない（`07§7` の囮が壊れない）
 *  5. マップ全体が縦横比を保って収まり、クリックで戦域を選べる（マウスのみ運用）
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { cfgNum } from '@/sim/core/config';
import { unitDefById } from '@/sim/core/defs';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { visibleEnemyFronts } from '@/sim/core/front';
import { createWorld, getFront, MAX_FRONTS, type Front, type World } from '@/sim/core/world';
import {
  DASH_LEN_PX,
  HIT_PAD_PX,
  RING_MAX_PX,
  RING_MIN_PX,
  collectOrderSources,
  dashOffsetPx,
  deliveryLineState,
  enemyRingPoints,
  fitMapBox,
  frontRingPoints,
  hitTestFronts,
  nearestPoint,
  projectRadius,
  projectTile,
  ringLineWidth,
} from '@/ui/hud/frontCommandView';

const MAP = 200;

function makeWorld(): World {
  const w = createWorld({
    seed: 12,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
  w.map.starts[0] = fxFromInt(20);
  w.map.starts[1] = fxFromInt(20);
  w.map.starts[2] = fxFromInt(180);
  w.map.starts[3] = fxFromInt(180);
  for (const pl of w.players) pl.frontSlots = MAX_FRONTS;
  return w;
}

function makeFront(w: World, owner: number, slot: number, tx: number, ty: number): Front {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(tx);
  f.y = fxFromInt(ty);
  f.radius = fx(cfgNum('front.spawnRadiusTiles'));
  return f;
}

// ---------------------------------------------------------------------------
// 配置（俯瞰図に「全戦線を一枚に」収める）
// ---------------------------------------------------------------------------

describe('俯瞰図の配置', () => {
  it('マップ全体を縦横比を保って収め、左右の余白 20px を空ける', () => {
    // 横長の表示領域 + 正方形のマップ → 高さが決め手になり、左右が余る
    const box = fitMapBox(1000, 600, 200, 200, 20);
    expect(box.w).toBeCloseTo(box.h, 6); // 正方形のまま
    expect(box.h).toBeCloseTo(560, 6); // 600 - 20*2
    expect(box.x).toBeGreaterThanOrEqual(20);
    expect(box.x + box.w).toBeLessThanOrEqual(1000 - 20 + 1e-6);
  });

  it('幅を広げたら領域も広がる（固定幅にしない。手順書 §8.2）', () => {
    const narrow = fitMapBox(600, 2000, 200, 200, 20);
    const wide = fitMapBox(1200, 2000, 200, 200, 20);
    expect(wide.w).toBeGreaterThan(narrow.w);
  });

  it('マス座標 → px が端と中心で一致する', () => {
    const box = fitMapBox(1000, 1000, 200, 200, 20);
    const p0 = projectTile(box, 200, 200, 0, 0);
    const pc = projectTile(box, 200, 200, 100, 100);
    const p1 = projectTile(box, 200, 200, 200, 200);
    expect(p0.x).toBeCloseTo(box.x, 6);
    expect(pc.x).toBeCloseTo(box.x + box.w / 2, 6);
    expect(p1.y).toBeCloseTo(box.y + box.h, 6);
  });

  it('半径は縦横のスケールの小さい方に合わせる（円が楕円にならない）', () => {
    const box = fitMapBox(1000, 500, 200, 100, 20);
    const r = projectRadius(box, 200, 100, 10);
    expect(r).toBeCloseTo(10 * Math.min(box.w / 200, box.h / 100), 6);
  });

  it('マップの大きさが 0 でも落ちない（起動直後の地形未確保）', () => {
    const box = fitMapBox(800, 600, 0, 0, 20);
    expect(box.w).toBeGreaterThan(0);
    expect(projectTile(box, 0, 0, 5, 5)).toEqual({ x: box.x, y: box.y });
    expect(projectRadius(box, 0, 0, 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `05§7-1` 輪の太さ = 優勢・劣勢
// ---------------------------------------------------------------------------

describe('`05§7-1`: 輪の太さが優勢・劣勢を表す', () => {
  it('優勢 +1.0 が最太、劣勢 -1.0 が最細、0 はその中間', () => {
    expect(ringLineWidth(FX_ONE)).toBeCloseTo(RING_MAX_PX, 6);
    expect(ringLineWidth(-FX_ONE)).toBeCloseTo(RING_MIN_PX, 6);
    expect(ringLineWidth(0)).toBeCloseTo((RING_MIN_PX + RING_MAX_PX) / 2, 6);
  });

  it('優勢度が上がれば必ず太くなる（単調増加）', () => {
    let prev = -1;
    for (let a = -FX_ONE; a <= FX_ONE; a += FX_ONE / 8) {
      const px = ringLineWidth(a);
      expect(px).toBeGreaterThan(prev);
      prev = px;
    }
  });

  it('値域の外は丸める（優勢度が想定外に振れても線幅が壊れない）', () => {
    expect(ringLineWidth(FX_ONE * 5)).toBeCloseTo(RING_MAX_PX, 6);
    expect(ringLineWidth(-FX_ONE * 5)).toBeCloseTo(RING_MIN_PX, 6);
  });
});

// ---------------------------------------------------------------------------
// `05§7-5` 令の伝達線
// ---------------------------------------------------------------------------

describe('`05§7-5`: 伝達線は点線が流れ、届いた瞬間に実線になる', () => {
  it('令が 1 枚も無ければ線を引かない', () => {
    const st = deliveryLineState({
      hasPending: false,
      hasOrder: false,
      startTick: 0,
      deliverAtTick: 0,
      nowTick: 0,
    });
    expect(st.style).toBe('none');
  });

  it('伝達中は flowing。**進捗が 1 未満の間は絶対に solid にならない**（§16-4）', () => {
    // 100 tick 掛かる令。出した直後・途中・1 tick 前を見る
    for (const now of [100, 120, 199]) {
      const st = deliveryLineState({
        hasPending: true,
        hasOrder: false,
        startTick: 100,
        deliverAtTick: 200,
        nowTick: now,
      });
      expect(st.style).toBe('flowing');
      expect(st.progress).toBeLessThan(1);
      expect(st.remainTicks).toBe(200 - now);
    }
    // ちょうど半分で 0.5
    expect(
      deliveryLineState({
        hasPending: true,
        hasOrder: false,
        startTick: 100,
        deliverAtTick: 200,
        nowTick: 150,
      }).progress,
    ).toBeCloseTo(0.5, 6);
  });

  it('届いた（pendingOrder が消えて order が立った）瞬間に solid になる', () => {
    const st = deliveryLineState({
      hasPending: false,
      hasOrder: true,
      startTick: 100,
      deliverAtTick: 200,
      nowTick: 200,
    });
    expect(st.style).toBe('solid');
    expect(st.progress).toBe(1);
    expect(st.remainTicks).toBe(0);
  });

  it('開始 tick が不明（deliverAtTick と同値）でも 0 除算しない', () => {
    const st = deliveryLineState({
      hasPending: true,
      hasOrder: false,
      startTick: 200,
      deliverAtTick: 200,
      nowTick: 200,
    });
    expect(st.style).toBe('flowing');
    expect(Number.isFinite(st.progress)).toBe(true);
  });

  it('点線のオフセットは 1 周期に収まり、本陣 → 戦域の向き（負方向）に流れる', () => {
    for (const ms of [0, 1, 137, 999, 60_000]) {
      const off = dashOffsetPx(ms);
      expect(off).toBeLessThanOrEqual(0);
      expect(off).toBeGreaterThan(-DASH_LEN_PX);
    }
    // 時間が進めば流れる（同じ値のまま止まらない）
    expect(dashOffsetPx(0)).not.toBeCloseTo(dashOffsetPx(100), 6);
  });
});

// ---------------------------------------------------------------------------
// `05§7-2` 最大 6 つ / クリックで選択
// ---------------------------------------------------------------------------

describe('`05§7-2`: 同時に最大 6 つ / クリックで戦域を選ぶ', () => {
  it('6 つ立てても輪は 6 個で、スロット番号が 1..6 に一致する', () => {
    const w = makeWorld();
    const fronts: Front[] = [];
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      fronts.push(makeFront(w, 0, slot, 20 + slot * 20, 100));
    }
    const box = fitMapBox(1000, 1000, MAP, MAP, 20);
    const pts = frontRingPoints(fronts, box, MAP, MAP);
    expect(pts).toHaveLength(MAX_FRONTS);
    expect(pts.map((p) => p.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    // 中心の px が左から順（マス座標の順）に並ぶ
    for (let k = 1; k < pts.length; k++) {
      expect(pts[k]!.x).toBeGreaterThan(pts[k - 1]!.x);
    }
  });

  it('輪の中心をクリックするとその戦域が選ばれ、外なら 0（= 無反応）', () => {
    const pts = [
      { slot: 1, x: 100, y: 100, r: 20 },
      { slot: 2, x: 300, y: 100, r: 20 },
    ];
    expect(hitTestFronts(pts, 100, 100)).toBe(1);
    expect(hitTestFronts(pts, 300, 105)).toBe(2);
    expect(hitTestFronts(pts, 200, 100)).toBe(0);
  });

  it('小さい輪でも押せる余白がある（`HIT_PAD_PX`）', () => {
    const pts = [{ slot: 3, x: 50, y: 50, r: 2 }];
    expect(hitTestFronts(pts, 50 + 2 + HIT_PAD_PX - 1, 50)).toBe(3);
    expect(hitTestFronts(pts, 50 + 2 + HIT_PAD_PX + 2, 50)).toBe(0);
  });

  it('輪が重なっているときは中心が近い方を選ぶ（大きい輪の中の小さい輪を押せる）', () => {
    const pts = [
      { slot: 1, x: 100, y: 100, r: 80 },
      { slot: 2, x: 130, y: 100, r: 10 },
    ];
    expect(hitTestFronts(pts, 130, 100)).toBe(2);
    expect(hitTestFronts(pts, 60, 100)).toBe(1);
  });

  it('敵の輪（slot 0）はクリック対象にしない', () => {
    const pts = [{ slot: 0, x: 100, y: 100, r: 30 }];
    expect(hitTestFronts(pts, 100, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `07§7` / 手順書 §16-5 敵の情報を漏らさない
// ---------------------------------------------------------------------------

describe('`07§7`: 敵の戦域は中心と半径だけ（囮が成立する根拠）', () => {
  it('enemyRingPoints が受け取れるのは owner/slot/x/y/radius だけ', () => {
    const w = makeWorld();
    const enemy = makeFront(w, 1, 2, 150, 150);
    enemy.order = 'charge';
    enemy.orderLower = 'raid';
    enemy.advantage = FX_ONE;
    enemy.memberCount = 40;

    const rings = visibleEnemyFronts(w, 0);
    expect(rings).toHaveLength(1);
    // `FrontRing` に兵種・数・令・優勢度が**入っていない**ことを実データで確認する
    expect(Object.keys(rings[0]!).sort()).toEqual(['owner', 'radius', 'slot', 'x', 'y']);

    const box = fitMapBox(1000, 1000, MAP, MAP, 20);
    const pts = enemyRingPoints(rings, box, MAP, MAP);
    expect(pts).toHaveLength(1);
    expect(Object.keys(pts[0]!).sort()).toEqual(['owner', 'r', 'slot', 'x', 'y']);
    // 中身が透けないこと（オブジェクトを JSON にしても令が出てこない）
    expect(JSON.stringify(pts)).not.toContain('charge');
    expect(JSON.stringify(pts)).not.toContain('raid');
  });

  it('敵の輪も中心・半径は正しく写る（位置と大きさは隠さない）', () => {
    const w = makeWorld();
    makeFront(w, 1, 1, 150, 50);
    const box = fitMapBox(1000, 1000, MAP, MAP, 20);
    const pts = enemyRingPoints(visibleEnemyFronts(w, 0), box, MAP, MAP);
    const expected = projectTile(box, MAP, MAP, 150, 50);
    expect(pts[0]!.x).toBeCloseTo(expected.x, 6);
    expect(pts[0]!.y).toBeCloseTo(expected.y, 6);
    expect(pts[0]!.r).toBeCloseTo(
      projectRadius(box, MAP, MAP, cfgNum('front.spawnRadiusTiles')),
      6,
    );
  });

  it('同盟の戦域は敵として出さない', () => {
    const w = makeWorld();
    w.players[0]!.frontSlots = MAX_FRONTS;
    // team を揃えると味方になる（`areAllies`）
    w.teams[0] = 1;
    w.teams[1] = 1;
    makeFront(w, 1, 1, 150, 50);
    expect(visibleEnemyFronts(w, 0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// `05§7-4` 本陣と発信点
// ---------------------------------------------------------------------------

describe('`05§7-4`: 本陣は動かない / 遠い戦域は令が届くのに時間がかかる', () => {
  it('発信点の先頭は必ず本陣（map.starts）', () => {
    const w = makeWorld();
    const sources = collectOrderSources(w, 0);
    expect(sources[0]).toEqual({ x: 20, y: 20 });
  });

  it('城を建てるとそこも発信点になり、伝達線の始点が近い方に移る（`07§4`）', () => {
    const w = makeWorld();
    // 城（発信点）を戦域寄りに置く
    const d = unitDefById('y-nagae'); // ダミー: ユニットは発信点にならない
    entityIndex(
      spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner: 0,
        typeId: d.index,
        x: fxFromInt(150),
        y: fxFromInt(150),
        hpMax: d.hp,
      }),
    );
    // ユニットしか置いていない時点では発信点は本陣だけ
    expect(collectOrderSources(w, 0)).toHaveLength(1);

    const nearest = nearestPoint(
      [
        { x: 20, y: 20 },
        { x: 150, y: 150 },
      ],
      160,
      160,
    );
    expect(nearest).toEqual({ x: 150, y: 150 });
  });

  it('発信点が空なら null（呼び出し側が本陣にフォールバックできる）', () => {
    expect(nearestPoint([], 0, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 表示に使う戦域が「自軍のもの」だけであること
// ---------------------------------------------------------------------------

describe('自軍の輪と敵の輪を混ぜない', () => {
  it('frontRingPoints は渡された自軍の戦域だけを写す（敵は別経路）', () => {
    const w = makeWorld();
    const mine = makeFront(w, 0, 3, 60, 60);
    makeFront(w, 1, 3, 60, 60); // 同じ場所に敵の戦域
    const box = fitMapBox(800, 800, MAP, MAP, 20);
    const pts = frontRingPoints([mine], box, MAP, MAP);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.slot).toBe(3);
  });

  it('EntityKind.Unit は発信点に数えない（城・大天幕・本陣だけ）', () => {
    const w = makeWorld();
    const d = unitDefById('villager');
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: d.index,
      x: fxFromInt(30),
      y: fxFromInt(30),
      hpMax: d.hp,
    });
    expect(collectOrderSources(w, 0)).toHaveLength(1);
  });
});
