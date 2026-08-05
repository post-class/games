import type { DestructionReason } from '../core/destruction';

export type PlaytestObjectiveState = 'active' | 'done' | 'failed';

export interface PlaytestObjective {
  id: string;
  text: string;
  state: PlaytestObjectiveState;
}

export interface PlaytestInputLatency {
  samples: number;
  averageMs: number;
  maxMs: number;
}

export interface PlaytestMissionRecord {
  schemaVersion: 1;
  missionId: string;
  missionTitle: string;
  shipId: string;
  difficultyId: string;
  startedAt: number;
  outcome?: 'win' | 'loss';
  durationSeconds: number;
  death?: {
    atSeconds: number;
    reason: DestructionReason;
    source?: string;
  };
  navReached: Array<{ index: number; name: string; atSeconds: number }>;
  objectives: PlaytestObjective[];
  objectiveTransitions: Array<{
    id: string;
    state: PlaytestObjectiveState;
    atSeconds: number;
  }>;
  inputLatency: PlaytestInputLatency;
}

export interface PlaytestMissionMeta {
  missionId: string;
  missionTitle: string;
  shipId: string;
  difficultyId: string;
  startedAt?: number;
}

export interface PlaytestLatencyBatch {
  samples: number;
  averageMs: number;
  maxMs: number;
}

/**
 * 描画・Three.js・ブラウザ API を持たない、1任務ぶんの記録器。
 * 人間の通しプレイで「どこまで進んだか」「なぜ死んだか」を後から確認できる。
 */
export class PlaytestRecorder {
  private readonly record: PlaytestMissionRecord;
  private objectiveStates = new Map<string, PlaytestObjectiveState>();
  private finished = false;

  constructor(meta: PlaytestMissionMeta) {
    this.record = {
      schemaVersion: 1,
      missionId: meta.missionId,
      missionTitle: meta.missionTitle,
      shipId: meta.shipId,
      difficultyId: meta.difficultyId,
      startedAt: meta.startedAt ?? Date.now(),
      durationSeconds: 0,
      navReached: [],
      objectives: [],
      objectiveTransitions: [],
      inputLatency: { samples: 0, averageMs: 0, maxMs: 0 },
    };
  }

  recordObjectives(objectives: readonly PlaytestObjective[], atSeconds: number): void {
    const next = new Map(objectives.map((o) => [o.id, o.state] as const));
    if (this.objectiveStates.size > 0) {
      for (const objective of objectives) {
        if (this.objectiveStates.get(objective.id) === objective.state) continue;
        this.record.objectiveTransitions.push({
          id: objective.id,
          state: objective.state,
          atSeconds: Math.max(0, atSeconds),
        });
      }
    }
    this.objectiveStates = next;
    this.record.objectives = objectives.map((o) => ({ ...o }));
  }

  recordNavReached(index: number, name: string, atSeconds: number): void {
    if (this.record.navReached.some((nav) => nav.index === index)) return;
    this.record.navReached.push({ index, name, atSeconds: Math.max(0, atSeconds) });
  }

  recordDeath(reason: DestructionReason, atSeconds: number, source?: string): void {
    if (this.record.death) return;
    this.record.death = {
      atSeconds: Math.max(0, atSeconds),
      reason,
      ...(source ? { source } : {}),
    };
  }

  recordInputLatency(batch: PlaytestLatencyBatch): void {
    const samples = Math.max(0, Math.floor(batch.samples));
    if (samples === 0) return;
    const current = this.record.inputLatency;
    const total = current.averageMs * current.samples + Math.max(0, batch.averageMs) * samples;
    current.samples += samples;
    current.averageMs = total / current.samples;
    current.maxMs = Math.max(current.maxMs, Math.max(0, batch.maxMs));
  }

  finish(outcome: 'win' | 'loss', durationSeconds: number): void {
    if (this.finished) return;
    this.finished = true;
    this.record.outcome = outcome;
    this.record.durationSeconds = Math.max(0, durationSeconds);
  }

  get isFinished(): boolean {
    return this.finished;
  }

  snapshot(): PlaytestMissionRecord {
    return JSON.parse(JSON.stringify(this.record)) as PlaytestMissionRecord;
  }
}

/** セッション中に完了した複数任務をまとめて JSON 化する。 */
export class PlaytestLog {
  private records: PlaytestMissionRecord[] = [];

  begin(meta: PlaytestMissionMeta): PlaytestRecorder {
    return new PlaytestRecorder(meta);
  }

  complete(recorder: PlaytestRecorder): void {
    if (!recorder.isFinished) return;
    this.records.push(recorder.snapshot());
  }

  get missions(): readonly PlaytestMissionRecord[] {
    return this.records;
  }

  exportJson(exportedAt = Date.now()): string {
    return JSON.stringify(
      { schemaVersion: 1, exportedAt, missions: this.records },
      null,
      2,
    );
  }
}
