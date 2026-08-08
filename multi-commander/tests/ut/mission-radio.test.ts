import { describe, expect, it } from 'vitest';
import { bus } from '../../src/core/events';
import { DIFFICULTIES } from '../../src/app/settings';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { World } from '../../src/world/world';

const radioTestMission: MissionDef = {
  id: 'radio-test',
  title: '無線テスト',
  system: 'テスト宙域',
  briefing: ['無線テスト'],
  briefingSpeaker: '管制',
  navs: [{ name: '帰投', pos: [0, 0, -2000] }],
  spawns: [
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      offset: [0, 0, -500],
      spread: 0,
    },
  ],
  objectives: [
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
  ],
  playerShipId: 'hornet',
  debriefWin: ['成功'],
  debriefLoss: ['失敗'],
};

describe('ミッション無線', () => {
  it('味方大型艦への接近を艦名付きで一度だけ警告する', () => {
    const world = new World();
    const runner = new MissionRunner(
      world,
      radioTestMission,
      { shipId: 'hornet' },
      DIFFICULTIES.normal,
    );
    const messages: Array<{ speaker: string; text: string }> = [];
    const unsubscribe = bus.on('radio', (message) => messages.push(message));

    runner.build();
    runner.update(1 / 60);
    runner.update(1 / 60);

    const proximity = messages.filter((message) => message.text.includes('近づきすぎ'));
    expect(proximity).toHaveLength(1);
    expect(proximity[0].speaker).toBe('ドレイマン級輸送艦');

    unsubscribe();
    runner.dispose();
  });

  it('帰投可能になったら管制がAキーを一度だけ案内する', () => {
    const world = new World();
    const runner = new MissionRunner(
      world,
      { ...radioTestMission, spawns: [] },
      { shipId: 'hornet' },
      DIFFICULTIES.normal,
    );
    const messages: Array<{ speaker: string; text: string }> = [];
    const unsubscribe = bus.on('radio', (message) => messages.push(message));

    runner.build();
    runner.update(1 / 60);
    runner.update(1 / 60);

    const returnInstructions = messages.filter((message) => message.text.includes('Aキー'));
    expect(returnInstructions).toHaveLength(1);
    expect(returnInstructions[0].speaker).toBe('管制');

    unsubscribe();
    runner.dispose();
  });
});
