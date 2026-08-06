/**
 * 長時間シミュレーション（バランス調整用）。
 * docs 09章 M3 の完了条件「7島日連続で回して破綻しない」「冬にケンカが増える」を確認する。
 *
 * 実行: node tools/sim-long.ts [島日数=7] [seed=long-run]
 * 出力: 1島日ごとの表 ＋ CSV（.tmp/sim-long.csv）
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INITIAL_CRITTERS, TICKS_PER_ISLAND_DAY, TICKS_PER_ISLAND_HOUR } from '@ai-pet/shared';
import { IslandSim } from '../packages/server/src/sim/island.ts';
import { spawnInitialCritters } from '../packages/server/src/sim/spawn.ts';

const days = Number(process.argv[2] ?? 7);
const seed = process.argv[3] ?? 'long-run';
const critterCount = Number(process.argv[4] ?? INITIAL_CRITTERS);

const sim = new IslandSim({ islandId: 'main', seed });
spawnInitialCritters(sim.world, critterCount);

interface DayRow {
  day: number;
  season: string;
  critters: number;
  births: number;
  deaths: number;
  quarrels: number;
  friends: number;
  resource: number;
  decayed: string;
  nightSleep: string;
  daySleep: string;
  p95ms: number;
}

const rows: DayRow[] = [];
const csv: string[] = ['tick,islandDay,season,weather,critters,resource,decayedRatio,sleepingRatio,isNight'];

let prev = { births: 0, deaths: 0, quarrels: 0 };
let nightSum = 0;
let nightN = 0;
let daySum = 0;
let dayN = 0;
let maxTickMs = 0;

console.log(`seed=${seed} 動物${critterCount}体で${days}島日ぶん回します（${days * TICKS_PER_ISLAND_DAY}tick）…`);

for (let day = 0; day < days; day++) {
  nightSum = 0;
  nightN = 0;
  daySum = 0;
  dayN = 0;

  for (let i = 0; i < TICKS_PER_ISLAND_DAY; i++) {
    const t0 = performance.now();
    sim.step();
    const dt = performance.now() - t0;
    if (dt > maxTickMs) maxTickMs = dt;

    if (sim.tick % (TICKS_PER_ISLAND_HOUR / 2) !== 0) continue;

    const eco = sim.ecologyMetrics() as Record<string, number | string>;
    const isNight = sim.clock.isNight(sim.tick);
    const ratio = Number(eco['sleepingRatio']);
    if (isNight) {
      nightSum += ratio;
      nightN++;
    } else {
      daySum += ratio;
      dayN++;
    }
    csv.push(
      [
        sim.tick,
        eco['islandDay'],
        eco['season'],
        eco['weather'],
        eco['critters'],
        eco['resourceTotal'],
        eco['decayedTileRatio'],
        ratio,
        isNight ? 1 : 0,
      ].join(','),
    );
  }

  const rel = sim.relations.stats();
  rows.push({
    day: sim.clock.islandDay,
    season: sim.clock.season,
    critters: sim.world.countActors('critter'),
    births: rel.births - prev.births,
    deaths: rel.deaths - prev.deaths,
    quarrels: rel.quarrels - prev.quarrels,
    friends: rel.friends,
    resource: Math.round(sim.world.totalResourceAmount()),
    decayed: (sim.world.decayedTileRatio() * 100).toFixed(1) + '%',
    nightSleep: nightN ? (nightSum / nightN).toFixed(2) : '-',
    daySleep: dayN ? (daySum / dayN).toFixed(2) : '-',
    p95ms: sim.metrics().tickMsP95,
  });
  prev = { births: rel.births, deaths: rel.deaths, quarrels: rel.quarrels };
  process.stdout.write(`  ${sim.clock.islandDay}日目(${sim.clock.season}) 完了\r`);
}

console.log('\n');
console.table(rows);

const out = resolve(import.meta.dirname, '../.tmp/sim-long.csv');
writeFileSync(out, csv.join('\n'));

const eco = sim.ecologyMetrics() as Record<string, unknown>;
console.log('最終状態:', JSON.stringify({ ...eco, actions: undefined, critterAI: undefined }, null, 1));
console.log('行動の内訳:', JSON.stringify(eco['actions']));
console.log('経路探索:', JSON.stringify(eco['critterAI']));
console.log(`tick最悪値: ${maxTickMs.toFixed(2)}ms / p95: ${sim.metrics().tickMsP95}ms / overrun: ${sim.metrics().tickOverrun}`);
console.log(`CSV: ${out}`);

// 季節ごとのケンカ件数（冬に増えるか）
const bySeason = new Map<string, { quarrels: number; days: number }>();
for (const r of rows) {
  const e = bySeason.get(r.season) ?? { quarrels: 0, days: 0 };
  e.quarrels += r.quarrels;
  e.days++;
  bySeason.set(r.season, e);
}
console.log('\n季節ごとの1島日あたりケンカ件数:');
for (const [season, e] of bySeason) {
  console.log(`  ${season}: ${(e.quarrels / e.days).toFixed(1)} 件/日（${e.days}日ぶん）`);
}
