import { it } from 'vitest';
import { createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import { EntityKind } from '@/shared/types';
import { isAliveIndex } from '@/sim/core/entity';
import { buildingDef, unitDef } from '@/sim/core/defs';
import type { Command } from '@/sim/command';

const PAIRS: [string, string][] = [['viking','yamato'],['roma','yamato'],['mongol','azteca'],['persia','tou']];
it('段階5（総大将＝攻城まで使う）で決着するか', () => {
  let decided = 0, iron = 0, seats = 0;
  for (const [c0, c1] of PAIRS) {
    const { world: w } = createMatch({ seed: 20260810, playerCount: 2, civs: [c0, c1] as any });
    const ais = [new AiPlayer(0 as any, 5), new AiPlayer(1 as any, 5)];
    const e = w.entities;
    let dt = -1;
    const line = (t: number) => {
      const army = [0,0], siege = [0,0], tcHp = [0,0], ws = [0,0];
      for (let i = 0; i < e.highWater; i++) {
        if (!isAliveIndex(e, i)) continue;
        const o = e.owner[i]!; if (o > 1) continue;
        if (e.kind[i] === EntityKind.Unit) {
          const d = unitDef(e.typeId[i]!);
          if (d.role !== 'villager') { army[o]!++; if (d.role === 'siege') siege[o]!++; }
        } else if (e.kind[i] === EntityKind.Building) {
          const d = buildingDef(e.typeId[i]!);
          if (d.id === 'town_center') tcHp[o] = (tcHp[o]! + e.hp[i]!/256)|0;
          if (d.id === 'siege_workshop') ws[o]!++;
        }
      }
      return `${String(Math.round(t/25/60)).padStart(2)}分 時代${w.players[0]!.age}/${w.players[1]!.age} 兵${army[0]}/${army[1]} 攻城${siege[0]}/${siege[1]} 工房${ws[0]}/${ws[1]} 町中心HP${tcHp[0]}/${tcHp[1]}`;
    };
    const rows: string[] = [];
    for (let t = 0; t < 45000; t++) {
      const cmds: Command[] = [];
      for (let p = 0; p < 2; p++) cmds.push(...ais[p]!.think(w));
      stepWorld(w, cmds);
      if (w.tick % 18750 === 0) rows.push(line(w.tick));
      if (w.gameOver) { dt = w.tick; break; }
    }
    rows.push(line(w.tick));
    if (dt > 0) decided++;
    for (const p of [0,1]) { seats++; if (w.players[p]!.age >= 2) iron++; }
    console.log(`=== ${c0} 対 ${c1} ${dt > 0 ? `**決着 ${Math.round(dt/25/60)}分**` : '時間切れ'}\n  ` + rows.join('\n  '));
  }
  console.log(`【段階5まとめ】決着 ${decided}/${PAIRS.length} 組 / 鉄器以上 ${iron}/${seats} 席`);
}, 1800000);
