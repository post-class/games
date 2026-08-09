import { describe, expect, it } from 'vitest';
import { classifyDestruction } from '../../src/core/destruction';
import { PlaytestLog, PlaytestRecorder } from '../../src/app/playtest';

describe('PlaytestRecorder', () => {
  it('目標の変化、Nav 到達、死亡理由、入力遅延を任務単位で保持する', () => {
    const recorder = new PlaytestRecorder({
      missionId: 'm1-patrol',
      missionTitle: '哨戒',
      shipId: 'rapier',
      difficultyId: 'normal',
      startedAt: 123,
    });

    recorder.recordObjectives([{ id: 'nav', text: 'NAV 1', state: 'active' }], 0);
    recorder.recordObjectives([{ id: 'nav', text: 'NAV 1', state: 'done' }], 8.5);
    recorder.recordNavReached(0, '前線', 8.5);
    recorder.recordNavReached(0, '前線', 9);
    recorder.recordDeath('enemy-missile', 12, 'Dralthi');
    recorder.recordDeath('rock', 13);
    recorder.recordInputLatency({ samples: 2, averageMs: 10, maxMs: 18 });
    recorder.recordInputLatency({ samples: 1, averageMs: 30, maxMs: 30 });
    recorder.finish('loss', 12.1);

    const record = recorder.snapshot();
    expect(record.death).toEqual({ atSeconds: 12, reason: 'enemy-missile', source: 'Dralthi' });
    expect(record.navReached).toEqual([{ index: 0, name: '前線', atSeconds: 8.5 }]);
    expect(record.objectives).toEqual([{ id: 'nav', text: 'NAV 1', state: 'done' }]);
    expect(record.objectiveTransitions).toEqual([{ id: 'nav', state: 'done', atSeconds: 8.5 }]);
    expect(record.inputLatency).toEqual({ samples: 3, averageMs: 50 / 3, maxMs: 30 });
    expect(record.outcome).toBe('loss');
  });

  it('完了任務を複数件まとめて JSON に書き出せる', () => {
    const log = new PlaytestLog();
    const recorder = log.begin({
      missionId: 'm2-escort',
      missionTitle: '護衛',
      shipId: 'rapier',
      difficultyId: 'easy',
    });
    recorder.finish('win', 42);
    log.complete(recorder);

    const exported = JSON.parse(log.exportJson(456)) as {
      schemaVersion: number;
      exportedAt: number;
      missions: Array<{ missionId: string; outcome?: string }>;
    };
    expect(exported.schemaVersion).toBe(1);
    expect(exported.exportedAt).toBe(456);
    expect(exported.missions).toEqual([{ ...recorder.snapshot() }]);
  });
});

describe('classifyDestruction', () => {
  it('武器の所属と環境要因を死亡理由へ分類する', () => {
    expect(classifyDestruction('gun', 'kilrathi', 'confed')).toBe('enemy-gun');
    expect(classifyDestruction('missile', 'confed', 'confed')).toBe('friendly-missile');
    expect(classifyDestruction('rock')).toBe('rock');
    expect(classifyDestruction('mine')).toBe('mine');
    expect(classifyDestruction('collision')).toBe('collision');
  });
});
