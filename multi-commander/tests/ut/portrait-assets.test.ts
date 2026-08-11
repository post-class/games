import { describe, expect, it } from 'vitest';
import { FACE_ART_IDS, type Expression } from '../../src/ui/Portrait';
import { PROTAGONISTS, VEIL_PEOPLE, veilPerson } from '../../src/content/veil/people';
import { VEIL_MISSION_LIST } from '../../src/content/veil/missions';

/**
 * 顔画像アセットの実在確認（404 の回帰テスト）。
 *
 * `Portrait.ts` / `BriefingScene.ts` は `public/art/tex/face-<id>-<表情>.jpg` を
 * 直接 `<img src>` で引くため、ファイルが無いと実行時に静かに 404 になる。
 * ビルド時には検出できないので、ここでファイルシステムを見て確かめる。
 */

/**
 * `public/art/tex/` に実在する顔画像のファイル名一覧。
 *
 * `@types/node` を入れていないので `node:fs` は使わず、Vite の `import.meta.glob`
 * （パターンはビルド時に実ファイルへ展開される）でファイルシステムを見る。
 */
const FACE_FILES: ReadonlySet<string> = new Set(
  Object.keys(import.meta.glob('../../public/art/tex/face-*.jpg')).map(
    (p) => p.slice(p.lastIndexOf('/') + 1),
  ),
);

/** `Portrait.ts` の `Expression` と同じ5種。増減したらここも合わせる。 */
const EXPRESSIONS: readonly Expression[] = ['neutral', 'talk', 'grin', 'grim', 'strain'];

function faceFile(id: string, exp: Expression): string {
  return `face-${id}-${exp}.jpg`;
}

function hasFaceFile(file: string): boolean {
  return FACE_FILES.has(file);
}

describe('顔画像アセット', () => {
  it('FACE_ART_IDS の全 id × 5表情のファイルが実在する（404 防止）', () => {
    const missing: string[] = [];
    for (const id of FACE_ART_IDS) {
      for (const exp of EXPRESSIONS) {
        if (!hasFaceFile(faceFile(id, exp))) missing.push(`face-${id}-${exp}.jpg`);
      }
    }
    expect(missing).toEqual([]);
    // 人物名簿の76名ぶんが登録されている
    expect(FACE_ART_IDS.size).toBe(76);
  });

  /**
   * 旧キャンペーン（canon / expanded）の暫定 id は、戦役を THE VEIL FRONT だけに
   * したときに画像ごと削除した。復活させないための回帰。
   */
  it('旧キャンペーンの暫定 id は残っていない', () => {
    for (const id of ['halcyon', 'spirit', 'maniac', 'angel', 'tinman', 'cricket', 'padre', 'slate', 'nomad']) {
      expect(FACE_ART_IDS.has(id)).toBe(false);
      expect(hasFaceFile(faceFile(id, 'neutral'))).toBe(false);
    }
  });

  it('人物名簿の全員が顔画像を持つ', () => {
    const missing = VEIL_PEOPLE.filter((person) => !FACE_ART_IDS.has(person.id)).map((p) => p.id);
    expect(missing).toEqual([]);
    expect(VEIL_PEOPLE).toHaveLength(76);
  });

  it('主人公候補5名の顔画像が揃っている', () => {
    expect(PROTAGONISTS).toHaveLength(5);
    for (const hero of PROTAGONISTS) {
      expect(FACE_ART_IDS.has(hero.id)).toBe(true);
      for (const exp of EXPRESSIONS) expect(hasFaceFile(faceFile(hero.id, exp))).toBe(true);
    }
  });

  it('ブリーフィング話者の顔画像が揃っている', () => {
    // 十章の話者として仕様で名前が挙がっている人物。
    // ハート艦長(confed-06) / ソフィー・ローラン(confed-07) / キム・ソヨン(confed-08) / ニア・ウィリアムズ(confed-11)
    const speakers = ['confed-06', 'confed-07', 'confed-08', 'confed-11'];
    for (const id of speakers) {
      // 名簿に実在する id であること（採番ずれの検出）
      expect(() => veilPerson(id)).not.toThrow();
      expect(FACE_ART_IDS.has(id)).toBe(true);
      for (const exp of EXPRESSIONS) expect(hasFaceFile(faceFile(id, exp))).toBe(true);
    }
  });

  it('ミッションが指定している briefingSpeakerId は必ず顔画像を持つ', () => {
    for (const mission of VEIL_MISSION_LIST) {
      if (mission.briefingSpeakerId === undefined) continue;
      expect(FACE_ART_IDS.has(mission.briefingSpeakerId)).toBe(true);
      for (const exp of EXPRESSIONS) {
        expect(hasFaceFile(faceFile(mission.briefingSpeakerId, exp))).toBe(true);
      }
    }
  });
});
