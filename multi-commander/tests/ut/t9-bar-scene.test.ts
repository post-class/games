import { describe, expect, it } from 'vitest';
import { BUST_ART_IDS, FACE_ART_IDS, hasBustArt } from '../../src/ui/Portrait';
import { PILOTS } from '../../src/content/pilots';
import { BARTENDER_PERSON_ID } from '../../src/content/barRumors';
import { veilPerson } from '../../src/content/veil/people';
import { BAR_SEAT_SLOTS } from '../../src/app/barSeats';
import { BAR_SPOT_IDS } from '../../src/ui/BarScene';
import { BAR_SCENES, barSceneFor, validateBarScenes } from '../../src/content/barScenes';

/**
 * 酒場の場面（`src/ui/BarScene.ts`）が必要とするアセットと、
 * 席 id の対応の回帰テスト。
 *
 * 立ち絵は `<img src>` で直接引くので、ファイルが無いと実行時に静かに 404 になる。
 * 席 id がずれると、その席の隊員が画面のどこにも出なくなる（無言で消える）。
 */

/** `public/art/tex/` に実在する立ち絵のファイル名一覧。 */
const BUST_FILES: ReadonlySet<string> = new Set(
  Object.keys(import.meta.glob('../../public/art/tex/bust-*.webp')).map(
    (p) => p.slice(p.lastIndexOf('/') + 1),
  ),
);

describe('酒場の場面（立ち絵）', () => {
  it('BUST_ART_IDS の全 id のファイルが実在する（404 防止）', () => {
    const missing = [...BUST_ART_IDS].filter((id) => !BUST_FILES.has(`bust-${id}.webp`));
    expect(missing).toEqual([]);
    expect(BUST_ART_IDS.size).toBeGreaterThanOrEqual(9);
  });

  it('立ち絵の人物は名簿に実在し、顔画像も持つ（会話ボックスの顔と同じ人物になる）', () => {
    for (const id of BUST_ART_IDS) {
      expect(() => veilPerson(id)).not.toThrow();
      expect(FACE_ART_IDS.has(id)).toBe(true);
    }
  });

  it('飛行隊8名と酒保に立ち絵がある（酒場に出る全員）', () => {
    const missing = PILOTS.filter((p) => !hasBustArt(p.personId)).map((p) => p.id);
    expect(missing).toEqual([]);
    expect(hasBustArt(BARTENDER_PERSON_ID)).toBe(true);
  });

  it('立ち絵を置く席 id は BAR_SEAT_SLOTS と一致する（席が画面から消えない）', () => {
    const slots = BAR_SEAT_SLOTS.map((s) => s.id).sort();
    expect([...BAR_SPOT_IDS].sort()).toEqual(slots);
  });
});

describe('酒場の節目の一幕', () => {
  const ctx = (over: Partial<Parameters<typeof barSceneFor>[0]> = {}) => ({
    chapter: 1,
    gauges: { returnees: 50, routeTrust: 50, commandTrust: 50, aceOath: 50 },
    hasFallen: false,
    hasWounded: false,
    ...over,
  });

  it('データの取りこぼしがない', () => {
    expect(validateBarScenes()).toEqual([]);
    expect(BAR_SCENES.length).toBeGreaterThanOrEqual(8);
  });

  it('戦死者が出ていれば「空いた席」が出る', () => {
    const scene = barSceneFor(ctx({ chapter: 5, hasFallen: true }), 0);
    expect(scene?.id).toBe('fallen-empty-seat');
  });

  it('同じ種でも同じ一幕になる（決定論）', () => {
    const a = barSceneFor(ctx({ chapter: 4 }), 7);
    const b = barSceneFor(ctx({ chapter: 4 }), 7);
    expect(a?.id).toBe(b?.id);
  });

  it('種が負・小数でも落ちない', () => {
    for (const seed of [-3, -0.5, 2.7, 0]) {
      expect(() => barSceneFor(ctx({ chapter: 3 }), seed)).not.toThrow();
    }
  });

  it('4状態の条件を持つ一幕は gauges が無いときに出ない', () => {
    // gauges 無しで条件付きの一幕（誓約・信用・信頼・帰還者）が選ばれてはいけない
    const gaugeIds = BAR_SCENES.filter((s) =>
      s.when &&
      ['returneesBelow', 'returneesAbove', 'routeTrustAbove', 'routeTrustBelow',
       'commandTrustBelow', 'commandTrustAbove', 'aceOathAbove', 'aceOathBelow']
        .some((k) => (s.when as Record<string, unknown>)[k] !== undefined),
    ).map((s) => s.id);
    for (let seed = 0; seed < 12; seed++) {
      const scene = barSceneFor({ chapter: 5 }, seed);
      if (scene) expect(gaugeIds).not.toContain(scene.id);
    }
  });

  it('一幕の役は senior / junior / tender だけ（解決できない役を書かない）', () => {
    for (const scene of BAR_SCENES) {
      for (const line of scene.lines) {
        expect(['senior', 'junior', 'tender']).toContain(line.role);
      }
    }
  });
});
