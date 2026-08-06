/**
 * `?mock=1` 用のローカル島（サーバなしで描画を単体検証するため）。
 *
 * サーバ側（packages/server/src/sim/worldgen.ts）は別作業者の担当なので、
 * ここは **描画の検証専用の簡易生成**。本番のアルゴリズムとは一致しない。
 * サーバが出来たらこのモジュールは使わなくなる（`?mock=1` 以外では読み込まれない）。
 *
 * - Math.random() は使わない（shared の Rng）。同じseedなら常に同じ島になる
 * - 出力の形は本物のプロトコル（chunk / snapshot / delta）に揃える
 */
import {
  CHUNK,
  CHUNKS_X,
  CHUNKS_Y,
  MAP_H,
  MAP_W,
  Rng,
  TERRAINS,
  TICKS_PER_ISLAND_DAY,
  encodeAnim,
  encodeFacing,
  q2,
  rleEncode,
  type ActorDelta,
  type ActorWire,
  type ClockWire,
  type Facing,
  type Vec2,
} from '@ai-pet/shared';
import { CRITTER_SPECIES } from '../state/species.ts';

const T_GRASS = TERRAINS.indexOf('grass');
const T_DIRT = TERRAINS.indexOf('dirt');
const T_SAND = TERRAINS.indexOf('sand');
const T_WATER = TERRAINS.indexOf('water');
const T_FOREST = TERRAINS.indexOf('forest');
const T_PLAZA = TERRAINS.indexOf('plaza');

const PET_LIST: readonly string[] = ['mofi', 'mizune', 'hakka', 'momona', 'hoshira'];
const MOCK_CRITTERS = 34;

/** 格子上の乱数値を双線形補間する value noise */
function makeNoise(rng: Rng, cell: number): (x: number, y: number) => number {
  const gw = Math.ceil(MAP_W / cell) + 2;
  const gh = Math.ceil(MAP_H / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const at = (gx: number, gy: number): number => {
    const cx = Math.max(0, Math.min(gw - 1, gx));
    const cy = Math.max(0, Math.min(gh - 1, gy));
    return grid[cy * gw + cx] as number;
  };
  return (x: number, y: number): number => {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    // smoothstep で格子の継ぎ目を目立たなくする
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

export function generateMockTerrain(seed: string): Int8Array {
  const rng = new Rng(`mock:${seed}`);
  const base = makeNoise(rng, 18);
  const detail = makeNoise(rng, 7);
  const trees = makeNoise(rng, 5);
  const out = new Int8Array(MAP_W * MAP_H);
  const cx = MAP_W / 2;
  const cy = MAP_H / 2;
  const maxR = Math.min(MAP_W, MAP_H) / 2;

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      // 中心から外へ向かって落ちる高さ＋ノイズ＝丸い島
      const d = Math.hypot(x - cx, y - cy) / maxR;
      const falloff = 1 - d * d * 1.25;
      const h = base(x, y) * 0.62 + detail(x, y) * 0.24 + falloff * 0.62;
      let t: number;
      if (h < 0.42) t = T_WATER;
      else if (h < 0.48) t = T_SAND;
      else if (trees(x, y) > 0.62 && h > 0.55) t = T_FOREST;
      else t = T_GRASS;
      out[y * MAP_W + x] = t;
    }
  }

  // 中央の広場（半径7）と、そこから東西南北へ伸びる土の道
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= 7) out[y * MAP_W + x] = T_PLAZA;
      else if (d <= 8.6) {
        if (out[y * MAP_W + x] !== T_WATER) out[y * MAP_W + x] = T_DIRT;
      }
    }
  }
  for (let i = 8; i < 34; i++) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      for (let w = -1; w <= 1; w++) {
        const x = Math.round(cx + dx * i + (dx === 0 ? w : 0));
        const y = Math.round(cy + dy * i + (dy === 0 ? w : 0));
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        if (out[y * MAP_W + x] === T_WATER) continue;
        out[y * MAP_W + x] = T_DIRT;
      }
    }
  }
  return out;
}

interface MockActor {
  id: number;
  k: 0 | 1 | 2;
  species: string;
  name: string;
  pos: Vec2;
  target: Vec2;
  facing: Facing;
  anim: 'idle' | 'walk';
  speed: number;
  owner?: string;
}

/** ローカル島。main.ts から4Hzで step() を回す */
export class MockIsland {
  readonly terrain: Int8Array;
  readonly spawn: Vec2;
  readonly selfId = 1;
  readonly ownerId = 'mock-player';
  private readonly rng: Rng;
  private readonly actors: MockActor[] = [];
  private tick = 0;
  private nextId = 2;

  constructor(seed = 'pokomofu') {
    this.terrain = generateMockTerrain(seed);
    this.rng = new Rng(`mock-actors:${seed}`);
    this.spawn = { x: MAP_W / 2, y: MAP_H / 2 };

    this.actors.push({
      id: this.selfId,
      k: 2,
      species: 'a',
      name: 'あなた',
      pos: { ...this.spawn },
      target: { ...this.spawn },
      facing: 's',
      anim: 'idle',
      speed: 0,
    });

    // ペット5種を広場のまわりに
    for (let i = 0; i < PET_LIST.length; i++) {
      const ang = (i / PET_LIST.length) * Math.PI * 2;
      const p = this.nearestWalkable({
        x: this.spawn.x + Math.cos(ang) * 5,
        y: this.spawn.y + Math.sin(ang) * 5,
      });
      this.actors.push({
        id: this.nextId++,
        k: 1,
        species: PET_LIST[i] as string,
        name: `ぽこ${i + 1}`,
        pos: p,
        target: this.wanderTarget(p, 8),
        facing: 's',
        anim: 'walk',
        speed: 1.4 + this.rng.next() * 0.8,
        owner: i === 0 ? this.ownerId : `other-${i}`,
      });
    }

    // 動物住民
    for (let i = 0; i < MOCK_CRITTERS; i++) {
      const p = this.randomWalkable();
      this.actors.push({
        id: this.nextId++,
        k: 0,
        species: this.rng.pick(CRITTER_SPECIES),
        name: `どうぶつ${i}`,
        pos: p,
        target: this.wanderTarget(p, 12),
        facing: 's',
        anim: 'walk',
        speed: 0.9 + this.rng.next() * 0.9,
      });
    }
  }

  // ---------- 地形 ----------

  terrainAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return T_WATER;
    return this.terrain[y * MAP_W + x] as number;
  }

  isWalkable(p: Vec2): boolean {
    return this.terrainAt(Math.floor(p.x), Math.floor(p.y)) !== T_WATER;
  }

  chunkRle(cx: number, cy: number): number[] {
    const values: number[] = [];
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        values.push(this.terrainAt(cx * CHUNK + tx, cy * CHUNK + ty));
      }
    }
    return rleEncode(values);
  }

  /** 全チャンクを列挙（mockでは要求に応じて返す） */
  get chunkCount(): number {
    return CHUNKS_X * CHUNKS_Y;
  }

  private randomWalkable(): Vec2 {
    for (let i = 0; i < 400; i++) {
      const ang = this.rng.next() * Math.PI * 2;
      const r = this.rng.next() * 44;
      const p = { x: MAP_W / 2 + Math.cos(ang) * r, y: MAP_H / 2 + Math.sin(ang) * r };
      if (this.isWalkable(p)) return p;
    }
    return { ...this.spawn };
  }

  private nearestWalkable(p: Vec2): Vec2 {
    if (this.isWalkable(p)) return p;
    for (let r = 1; r < 20; r++) {
      for (const [dx, dy] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ] as const) {
        const q = { x: p.x + dx, y: p.y + dy };
        if (this.isWalkable(q)) return q;
      }
    }
    return { ...this.spawn };
  }

  private wanderTarget(from: Vec2, radius: number): Vec2 {
    for (let i = 0; i < 40; i++) {
      const ang = this.rng.next() * Math.PI * 2;
      const r = 2 + this.rng.next() * radius;
      const p = { x: from.x + Math.cos(ang) * r, y: from.y + Math.sin(ang) * r };
      if (this.isWalkable(p)) return p;
    }
    return { ...from };
  }

  // ---------- 時計 ----------

  clock(): ClockWire {
    const progress = (this.tick % TICKS_PER_ISLAND_DAY) / TICKS_PER_ISLAND_DAY;
    const tod = progress < 0.25 ? 'morning' : progress < 0.55 ? 'day' : progress < 0.75 ? 'evening' : 'night';
    return {
      tick: this.tick,
      islandDay: Math.floor(this.tick / TICKS_PER_ISLAND_DAY) + 1,
      dayProgress: progress,
      timeOfDay: tod,
      season: 'spring',
      weather: 'clear',
    };
  }

  // ---------- ワイヤ ----------

  private wire(a: MockActor): ActorWire {
    const w: ActorWire = {
      i: a.id,
      k: a.k,
      s: a.species,
      n: a.name,
      x: q2(a.pos.x),
      y: q2(a.pos.y),
      f: encodeFacing(a.facing),
      a: encodeAnim(a.anim),
    };
    if (a.owner !== undefined) w.o = a.owner;
    return w;
  }

  snapshot(): { tick: number; clock: ClockWire; actors: ActorWire[]; resources: []; placeables: [] } {
    return {
      tick: this.tick,
      clock: this.clock(),
      actors: this.actors.map((a) => this.wire(a)),
      resources: [],
      placeables: [],
    };
  }

  /** サーバのtick相当。dtSec ぶん動かして delta を返す */
  step(dtSec: number): { tick: number; upd: ActorDelta[]; clock: ClockWire } {
    this.tick += Math.max(1, Math.round(dtSec * 4));
    const upd: ActorDelta[] = [];
    for (const a of this.actors) {
      // 自アバターは speed 0（クライアント予測で動かし、setSelfPos で反映される）。
      // ここで upd に載せておかないと「サーバ値とズレた」と判定されて引き戻されてしまう。
      if (a.speed <= 0) {
        upd.push({ i: a.id, x: q2(a.pos.x), y: q2(a.pos.y), f: encodeFacing(a.facing), a: encodeAnim(a.anim) });
        continue;
      }
      const dx = a.target.x - a.pos.x;
      const dy = a.target.y - a.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.35) {
        // 目的地に着いたら少し休んで次の目的地へ
        a.anim = 'idle';
        if (this.rng.chance(0.35)) {
          a.target = this.wanderTarget(a.pos, a.k === 1 ? 10 : 14);
          a.anim = 'walk';
        }
      } else {
        const step = Math.min(dist, a.speed * dtSec);
        const nx = a.pos.x + (dx / dist) * step;
        const ny = a.pos.y + (dy / dist) * step;
        if (this.isWalkable({ x: nx, y: a.pos.y })) a.pos.x = nx;
        if (this.isWalkable({ x: a.pos.x, y: ny })) a.pos.y = ny;
        a.anim = 'walk';
        a.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
        // 進めなかったら目的地を変える（壁にはまり続けない）
        if (Math.hypot(a.pos.x - nx, a.pos.y - ny) > step * 0.9) a.target = this.wanderTarget(a.pos, 8);
      }
      upd.push({ i: a.id, x: q2(a.pos.x), y: q2(a.pos.y), f: encodeFacing(a.facing), a: encodeAnim(a.anim) });
    }
    return { tick: this.tick, upd, clock: this.clock() };
  }

  /** 自アバターの位置をクライアント予測の値で上書きする（mockはサーバ判定がないので信じる） */
  setSelfPos(p: Vec2): void {
    const self = this.actors[0];
    if (!self) return;
    if (this.isWalkable(p)) {
      self.pos.x = p.x;
      self.pos.y = p.y;
    }
  }

  selfWire(): ActorWire {
    const self = this.actors[0];
    if (!self) throw new Error('mock: self actor がない');
    return this.wire(self);
  }
}
