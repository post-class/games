import { describe, it } from 'vitest';
import { createMatch, stepWorld } from '@/sim';
import { AiPlayer } from '@/ai/AiPlayer';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import { UnitState, isAliveIndex } from '@/sim/core/entity';
import { fxToInt } from '@/sim/core/fx';

import { unitDefById } from '@/sim/core/defs';
import { resourceNodeDef } from '@/sim/core/gather';

describe('村人の稼働', () => {
  it('遊んでいる村人と残っている食料ノード', () => {
    const vt = unitDefById('villager').index;
    const { world: w } = createMatch({
      seed: 31337,
      playerCount: 2,
      civs: ['yamato', 'mongol'],
      mapType: 'plain',
    });
    const ais = [new AiPlayer(0, 4), new AiPlayer(1, 4)];
    for (let t = 0; t <= 45000; t++) {
      const cmds: never[] = [];
      for (const ai of ais) (cmds as unknown[]).push(...ai.think(w));
      stepWorld(w, cmds);
      if (t % 11250 === 0 || t === 45000) {
        const st: Record<string, number> = {};
        let vill = 0;
        for (let i = 0; i < w.entities.highWater; i++) {
          if (!isAliveIndex(w.entities, i) || w.entities.owner[i] !== 0) continue;
          if (w.entities.kind[i] !== EntityKind.Unit || w.entities.typeId[i] !== vt) continue;
          vill++;
          const s = w.entities.state[i]!;
          const name =
            s === UnitState.Idle
              ? '遊休'
              : s === UnitState.Gathering
                ? '採集'
                : s === UnitState.Moving
                  ? '移動'
                  : `他${s}`;
          st[name] = (st[name] ?? 0) + 1;
        }
        // 生きている食料ノードの残量
        let foodLeft = 0;
        const byId: Record<string, number> = {};
        for (let i = 0; i < w.entities.highWater; i++) {
          if (!isAliveIndex(w.entities, i) || w.entities.kind[i] !== EntityKind.Resource) continue;
          const d = resourceNodeDef(w.entities.typeId[i]!);
          if (d.resource !== RESOURCE_IDS.indexOf('food')) continue;
          if (w.entities.amount[i]! <= 0) continue;
          foodLeft += fxToInt(w.entities.amount[i]!);
          byId[d.id] = (byId[d.id] ?? 0) + 1;
        }
        const pl = w.players[0]!;
        console.log(
          `${Math.round(t / 25 / 60)}分 age${pl.age} 村${vill} ${JSON.stringify(st)} 食料残${foodLeft} ${JSON.stringify(byId)} 手持ちf${fxToInt(pl.resources[0]!)}`,
        );
      }
    }
  }, 200000);
});
