import { describe, it } from 'vitest';
import { createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import { RESOURCE_IDS, EntityKind } from '@/shared/types';
import { fxToInt } from '@/sim/core/fx';
import { isAliveIndex } from '@/sim/core/entity';
import { unitDefById, buildingDef } from '@/sim/core/defs';
import { UnitState } from '@/shared/types';

describe('内政の律速', () => {
  it('村人が何をしているか', () => {
    const { world: w } = createMatch({ seed: 7, playerCount: 2, civs: ['yamato','mongol'], mapType: 'plain' });
    const ais = [new AiPlayer(0, 3), new AiPlayer(1, 3)];
    const vt = unitDefById('villager').index;
    for (let t = 0; t <= 27000; t++) {
      if (t % 9000 === 0) {
        const st: Record<string, number> = {};
        let vill = 0, carrying = 0;
        for (let i = 0; i < w.entities.highWater; i++) {
          if (!isAliveIndex(w.entities, i)) continue;
          if (w.entities.owner[i] !== 0) continue;
          if (w.entities.kind[i] === EntityKind.Unit && w.entities.typeId[i] === vt) {
            vill++;
            const s = String(w.entities.state[i]);
            st[s] = (st[s] ?? 0) + 1;
            if (w.entities.carryKind[i]! > 0) carrying++;
          }
        }
        const pl = w.players[0]!;
        console.log(`t=${t} 村人${vill} 状態${JSON.stringify(st)} 運搬中${carrying} age${pl.age} `+
          RESOURCE_IDS.map((r,i)=>`${r[0]}${fxToInt(pl.resources[i]!)}`).join(','));
      }
      const cmds: any[] = [];
      for (const ai of ais) cmds.push(...ai.think(w));
      stepWorld(w, cmds);
    }
    console.log('UnitState:', JSON.stringify(UnitState));
  }, 180000);
});
