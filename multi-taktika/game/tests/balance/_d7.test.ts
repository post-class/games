import { it } from 'vitest';
import { createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import { isAliveIndex } from '@/sim/core/entity';
import { buildingDef, unitDef } from '@/sim/core/defs';
import type { Command } from '@/sim/command';
import { createAiView } from '@/ai/view';
import { desiredRoleMix, roleShare } from '@/ai/militaryGoals';

const PAIRS: [string, string][] = [['viking','yamato'],['roma','yamato'],['mongol','azteca'],['persia','tou']];
for (const level of [4, 5]) {
  it(`段階${level}の30分`, () => {
    let decided = 0, iron = 0, seats = 0, ws = 0, sg = 0;
    for (const [c0, c1] of PAIRS) {
      const { world: w } = createMatch({ seed: 20260810, playerCount: 2, civs: [c0, c1] as never });
      const ais = [new AiPlayer(0 as never, level), new AiPlayer(1 as never, level)];
      const e = w.entities;
      let dt = -1;
      const placed = new Map<string, number>();
      const line = (t: number) => {
        const army = [0,0], siege = [0,0], tcHp = [0,0], shop = [0,0], vill = [0,0], prod = [0,0];
        for (let i = 0; i < e.highWater; i++) {
          if (!isAliveIndex(e, i)) continue;
          const o = e.owner[i]!; if (o > 1) continue;
          if (e.kind[i] === EntityKind.Unit) {
            const d = unitDef(e.typeId[i]!);
            if (d.role !== 'villager') { army[o]!++; if (d.role === 'siege') siege[o]!++; } else vill[o]!++;
          } else if (e.kind[i] === EntityKind.Building) {
            const d = buildingDef(e.typeId[i]!);
            if (d.id === 'town_center') tcHp[o] = (tcHp[o]! + e.hp[i]!/256)|0;
            if (d.id === 'siege_workshop') shop[o]!++;
            if (['barracks','archery_range','stable','siege_workshop','castle','great_tent','academy','shrine','kanrin'].includes(d.id)) prod[o]!++;
          }
        }
        const mix = desiredRoleMix(createAiView(w, 0 as never), 3);
        const mixTxt = ['spear','sword','ranged','cavalry','siege'].map((r) => r.slice(0,2) + Math.round(roleShare(mix, r) * 100 / 256)).join(' ');
        return `${String(Math.round(t/25/60)).padStart(2)}分 時代${w.players[0]!.age}/${w.players[1]!.age} 兵${army[0]}/${army[1]} 攻城${siege[0]}/${siege[1]} 工房${shop[0]}/${shop[1]} 生産元${prod[0]}/${prod[1]} 村${vill[0]}/${vill[1]} 町中心HP${tcHp[0]}/${tcHp[1]} 資源P0[${RESOURCE_IDS.map((r,k)=>r[0]+Math.round(w.players[0]!.resources[k]!/256)).join(' ')}] 構成比P0[${mixTxt}]`;
      };
      const rows: string[] = [];
      for (let t = 0; t < 45000; t++) {
        const cmds: Command[] = [];
        for (let p = 0; p < 2; p++) {
          const cc = ais[p]!.think(w);
          for (const c of cc) if (c.t === 'placeBuilding') placed.set(`${p}:${c.type}`, (placed.get(`${p}:${c.type}`) ?? 0) + 1);
          cmds.push(...cc);
        }
        stepWorld(w, cmds);
        if (w.tick % 7500 === 0) rows.push(line(w.tick));
        if (w.gameOver) { dt = w.tick; break; }
      }
      rows.push(line(w.tick));
      rows.push('着工試行: ' + [...placed].sort().map(([k, v]) => k + '=' + v).join(' '));
      if (dt > 0) decided++;
      for (const p of [0,1]) {
        seats++;
        if (w.players[p]!.age >= 2) iron++;
      }
      for (let i = 0; i < e.highWater; i++) {
        if (!isAliveIndex(e, i) || (e.owner[i]! > 1)) continue;
        if (e.kind[i] === EntityKind.Building && buildingDef(e.typeId[i]!).id === 'siege_workshop') ws++;
        if (e.kind[i] === EntityKind.Unit && unitDef(e.typeId[i]!).role === 'siege') sg++;
      }
      console.log(`[L${level}] === ${c0} 対 ${c1} ${dt > 0 ? `**決着 ${Math.round(dt/25/60)}分**` : '時間切れ'}\n  ` + rows.join('\n  '));
    }
    console.log(`【段階${level}まとめ】決着 ${decided}/${PAIRS.length} 組 / 鉄器以上 ${iron}/${seats} 席 / 工房 ${ws} 棟 / 攻城兵器 ${sg} 体`);
  }, 1800000);
}
