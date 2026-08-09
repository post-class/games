import { describe, expect, it } from 'vitest';
import { gateOutcomeFromChoice, VEIL_CAMPAIGN, isGateOutcome } from '../../src/content/campaign';
import { missionDef, MISSIONS } from '../../src/content/missions';
import { SHIPS } from '../../src/content/ships';
import { VEIL_CHAPTERS } from '../../src/content/veil/chapters';
import { veilPerson, VEIL_PEOPLE } from '../../src/content/veil/people';
import { VEIL_MISSION_LIST, VEIL_MISSIONS } from '../../src/content/veil/missions';
import { VEIL_THEATERS } from '../../src/content/veil/world';
import { FACE_ART_IDS } from '../../src/ui/Portrait';

/**
 * 章データ・人物名簿・機体・キャンペーン・ミッションの id が互いに噛み合っているかを横断的に検査する。
 *
 * なぜ必要か: 十章分の実装を並列で進めた結果、実際に次の食い違いが起きた。
 *   - 章側の戦域id `grey-crown` と世界観側の `ashcrown-corridor`
 *   - 人物名の表記（`Nia Williams（ニア・ウィリアムズ）`）が整形されず無線の話者名に出た
 *   - 選択肢id（`seal-gate`）と結末id（`closed`）の混同
 * どれも型では止まらない（すべて string）。このテストが最後の砦になる。
 */

const theaterIds = new Set<string>(VEIL_THEATERS.map((t) => t.id));
const personIds = new Set(VEIL_PEOPLE.map((p) => p.id));
const shipIds = new Set(Object.keys(SHIPS));

describe('章データと世界観の整合', () => {
  it('章の戦域idが世界観の戦域として存在する', () => {
    for (const chapter of VEIL_CHAPTERS) {
      expect(theaterIds.has(chapter.theater), `第${chapter.chapter}章の戦域 ${chapter.theater}`).toBe(true);
    }
  });

  it('章の登場人物idが人物名簿に存在する', () => {
    for (const chapter of VEIL_CHAPTERS) {
      for (const member of chapter.cast) {
        if (!member.id) continue; // id を書けなかった人物は name のみ（章側の TODO）
        expect(personIds.has(member.id), `第${chapter.chapter}章の ${member.name} (${member.id})`).toBe(true);
      }
    }
  });

  it('章番号が1..10で重複せず、idが veil-chNN 形式である', () => {
    const chapters = VEIL_CHAPTERS.map((c) => c.chapter);
    expect(chapters).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const chapter of VEIL_CHAPTERS) {
      expect(chapter.id).toBe(`veil-ch${String(chapter.chapter).padStart(2, '0')}`);
      expect(chapter.missionId).toBe(chapter.id);
    }
  });
});

describe('章の選択肢', () => {
  it('選択肢idが章の中で重複しない', () => {
    for (const chapter of VEIL_CHAPTERS) {
      const ids = chapter.choice.options.map((o) => o.id);
      expect(new Set(ids).size, `第${chapter.chapter}章`).toBe(ids.length);
    }
  });

  it('どの選択肢にも必ずマイナスが含まれる（明確な正解を作らない）', () => {
    for (const chapter of VEIL_CHAPTERS) {
      for (const option of chapter.choice.options) {
        const values = Object.values(option.effects).filter((v): v is number => typeof v === 'number');
        expect(
          values.some((v) => v < 0),
          `第${chapter.chapter}章 ${option.id} に失うものがない`,
        ).toBe(true);
      }
    }
  });

  it('増減の絶対値の合計が章をまたいで揃っている（重みの偏りを防ぐ）', () => {
    const totals = VEIL_CHAPTERS.flatMap((c) =>
      c.choice.options.map((o) =>
        Object.values(o.effects)
          .filter((v): v is number => typeof v === 'number')
          .reduce((sum, v) => sum + Math.abs(v), 0),
      ),
    );
    expect(new Set(totals).size, `合計値が揃っていない: ${[...new Set(totals)].join(', ')}`).toBe(1);
  });

  it('第10章の選択肢は3つで、すべて門の管理方法へ変換できる', () => {
    const tenth = VEIL_CHAPTERS.find((c) => c.chapter === 10)!;
    expect(tenth.choice.options).toHaveLength(3);
    for (const option of tenth.choice.options) {
      const outcome = gateOutcomeFromChoice(option.id);
      expect(isGateOutcome(outcome)).toBe(true);
    }
  });

  it('第9章は錨となる人物の選択で、選択肢が3つ以上ある', () => {
    const ninth = VEIL_CHAPTERS.find((c) => c.chapter === 9)!;
    expect(ninth.choice.options.length).toBeGreaterThanOrEqual(3);
  });
});

describe('ミッション定義の整合', () => {
  it('十章すべてが MISSIONS に登録されている', () => {
    for (const chapter of VEIL_CHAPTERS) {
      expect(MISSIONS[chapter.missionId], `${chapter.missionId} が未登録`).toBeDefined();
    }
    expect(VEIL_MISSION_LIST).toHaveLength(10);
    expect(Object.keys(VEIL_MISSIONS)).toHaveLength(10);
  });

  it('キャンペーンノードのミッションidが解決できる', () => {
    for (const [id, node] of Object.entries(VEIL_CAMPAIGN)) {
      expect(() => missionDef(node.missionId), `${id}`).not.toThrow();
    }
  });

  it('出現させる機体idが SHIPS に新idとして存在する（エイリアス経由でない）', () => {
    for (const mission of VEIL_MISSION_LIST) {
      expect(shipIds.has(mission.playerShipId), `${mission.id} の自機 ${mission.playerShipId}`).toBe(true);
      for (const spawn of mission.spawns) {
        expect(shipIds.has(spawn.shipId), `${mission.id} の ${spawn.shipId}`).toBe(true);
        if (spawn.ace?.shipId) {
          expect(shipIds.has(spawn.ace.shipId), `${mission.id} のエース機 ${spawn.ace.shipId}`).toBe(true);
        }
      }
    }
  });

  it('目標が参照するタグを出現させる編成がある（綴り違いで目標が成立しないのを防ぐ）', () => {
    for (const mission of VEIL_MISSION_LIST) {
      const tags = new Set(mission.spawns.map((s) => s.tag).filter(Boolean));
      for (const objective of mission.objectives) {
        const spec = objective.spec as { tag?: string };
        if (!spec.tag) continue;
        expect(tags.has(spec.tag), `${mission.id} の目標 ${objective.id} が参照する ${spec.tag}`).toBe(true);
      }
      for (const stage of [...(mission.capitalStages ?? []), ...(mission.capitalSequence ?? [])]) {
        expect(tags.has(stage.tag), `${mission.id} の段階 ${stage.id} が参照する ${stage.tag}`).toBe(true);
      }
    }
  });

  it('reachNav の索引が navs の範囲内にある', () => {
    for (const mission of VEIL_MISSION_LIST) {
      for (const objective of mission.objectives) {
        if (objective.spec.kind !== 'reachNav') continue;
        expect(objective.spec.navIndex, `${mission.id} の ${objective.id}`).toBeLessThan(mission.navs.length);
      }
    }
  });

  it('必須目標が1つ以上あり、達成不能な必須目標がない（protect 単独で必須にしない）', () => {
    for (const mission of VEIL_MISSION_LIST) {
      const required = mission.objectives.filter((o) => o.required);
      expect(required.length, `${mission.id} に必須目標がない`).toBeGreaterThan(0);
      // `protect` / `timeLimit` / 制約系は「達成する目標」ではないので、
      // それだけが必須だと勝利条件が満たされず永久に終わらない。
      const achievable = required.filter(
        (o) => !['protect', 'timeLimit', 'protectCount', 'weaponsSafe', 'noFriendlyFire'].includes(o.spec.kind),
      );
      expect(achievable.length, `${mission.id} に達成できる必須目標がない`).toBeGreaterThan(0);
    }
  });
});

describe('話者名と肖像', () => {
  it('話者名に名簿の生表記（英字＋括弧の読み）が漏れていない', () => {
    for (const mission of VEIL_MISSION_LIST) {
      const names = [
        mission.briefingSpeaker,
        ...(mission.openingRadio ?? []).map((r) => r.speaker),
        ...mission.navs.flatMap((n) => (n.onArrive ?? []).map((r) => r.speaker)),
        ...mission.spawns.flatMap((s) => (s.radio ?? []).map((r) => r.speaker)),
      ];
      for (const name of names) {
        expect(/[A-Za-z].*（/.test(name), `${mission.id} の話者 "${name}" が整形されていない`).toBe(false);
      }
    }
  });

  it('ブリーフィング話者の顔画像idが人物名簿にあり、画像が登録されている', () => {
    for (const mission of VEIL_MISSION_LIST) {
      const id = mission.briefingSpeakerId;
      expect(id, `${mission.id} に briefingSpeakerId がない`).toBeDefined();
      expect(personIds.has(id!), `${mission.id} の話者 ${id} が名簿にいない`).toBe(true);
      expect(FACE_ART_IDS.has(id!), `${mission.id} の話者 ${id} の肖像が未登録`).toBe(true);
      expect(() => veilPerson(id!)).not.toThrow();
    }
  });
});
