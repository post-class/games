import { describe, expect, it } from 'vitest';
import dialogueSource from '../../src/content/dialogue.ts?raw';
import pilotDialogueSource from '../../src/content/pilotDialogue.ts?raw';
import missionsSource from '../../src/content/missions.ts?raw';
import {
  ALLY_RESCUE_ACK,
  ENEMY_ACK_TAUNT,
  ENEMY_DISENGAGE,
  ENEMY_DISTRESS,
  ENEMY_NAME_EXCHANGE,
  ENEMY_TAUNT,
  KILRATHI_NAMES,
  PLAYER_TAUNT,
  allyRescueAckLine,
  enemyDisengageLine,
  enemyDistressLine,
  enemyNameExchangeLine,
  enemyTaunt,
  enemyTauntReply,
  kilrathiName,
  playerTaunt,
  wingmanAck,
  wingmanKillLine,
  wingmanTroubleLine,
} from '../../src/content/dialogue';
import { rumor } from '../../src/content/pilotDialogue';
import { ACES } from '../../src/content/aces';
import { VEIL_PEOPLE } from '../../src/content/veil/people';

/** 旧世界観（キルラシー＝獣扱い）の語彙。物語三原則に反するため1件も残さない。 */
const FORBIDDEN = ['猫', '毛玉', '毛のない猿', '猿'];

/**
 * 台詞ファイルの全文を走査する。
 *
 * `missions.ts` は旧11ミッション（互換のため残置）を含み、エース台詞に1件だけ
 * 「猿」が残っている（T2-7 の対象外として指定された台詞のため、ここでは対象語を絞る）。
 */
const SOURCES: ReadonlyArray<{ name: string; source: string; words: readonly string[] }> = [
  { name: 'dialogue.ts', source: dialogueSource, words: FORBIDDEN },
  { name: 'pilotDialogue.ts', source: pilotDialogueSource, words: FORBIDDEN },
  { name: 'missions.ts', source: missionsSource, words: ['猫', '毛玉', '毛のない猿'] },
];

describe('台詞データの世界観適合（回帰）', () => {
  for (const { name, source, words } of SOURCES) {
    it(`${name} に旧世界観の語彙が含まれない`, () => {
      for (const word of words) {
        expect(source.includes(word), `${name} に「${word}」が残っている`).toBe(false);
      }
    });
  }

  it('エクスポートされた全台詞配列に旧世界観の語彙が含まれない', () => {
    const all = [
      ...ENEMY_TAUNT.oath,
      ...ENEMY_TAUNT.radical,
      ...ENEMY_ACK_TAUNT.oath,
      ...ENEMY_ACK_TAUNT.radical,
      ...PLAYER_TAUNT,
      ...ENEMY_DISTRESS,
      ...ENEMY_NAME_EXCHANGE,
      ...ENEMY_DISENGAGE,
      ...ALLY_RESCUE_ACK,
    ];
    for (const line of all) {
      for (const word of FORBIDDEN) {
        expect(line.includes(word), `「${line}」に「${word}」が残っている`).toBe(false);
      }
    }
  });
});

describe('敵台詞の2系統（oath / radical）', () => {
  it('系統ごとに別の集合から返る', () => {
    expect(ENEMY_TAUNT.oath.length).toBeGreaterThan(0);
    expect(ENEMY_TAUNT.radical.length).toBeGreaterThan(0);
    // 集合が重複していない（同じ台詞を両方に置いていない）
    const overlap = ENEMY_TAUNT.oath.filter((line) => ENEMY_TAUNT.radical.includes(line));
    expect(overlap).toEqual([]);

    for (let i = 0; i < 50; i += 1) {
      expect(ENEMY_TAUNT.oath).toContain(enemyTaunt('oath'));
      expect(ENEMY_TAUNT.radical).toContain(enemyTaunt('radical'));
      expect(ENEMY_ACK_TAUNT.oath).toContain(enemyTauntReply('oath'));
      expect(ENEMY_ACK_TAUNT.radical).toContain(enemyTauntReply('radical'));
    }
  });

  it('引数なしでも従来どおり呼べる（後方互換）', () => {
    expect(() => enemyTaunt()).not.toThrow();
    expect(() => enemyTauntReply()).not.toThrow();
    expect(enemyTaunt().length).toBeGreaterThan(0);
    expect(enemyTauntReply().length).toBeGreaterThan(0);
  });

  it('誓約派の台詞は決闘・誓約・名のいずれかに触れる', () => {
    for (const line of ENEMY_TAUNT.oath) {
      expect(/誓約|名|一対一|追わない|門/.test(line)).toBe(true);
    }
  });
});

describe('救難・名の交換の台詞', () => {
  it('空文字を返さない', () => {
    for (let i = 0; i < 30; i += 1) {
      expect(enemyDistressLine().length).toBeGreaterThan(0);
      expect(enemyNameExchangeLine().length).toBeGreaterThan(0);
      expect(enemyDisengageLine().length).toBeGreaterThan(0);
      expect(allyRescueAckLine().length).toBeGreaterThan(0);
    }
  });

  it('救難信号は撃墜以外の選択肢を示す語を含む', () => {
    expect(ENEMY_DISTRESS.some((line) => line.includes('救'))).toBe(true);
    expect(ENEMY_DISENGAGE.some((line) => line.includes('離脱'))).toBe(true);
  });
});

describe('キルラシー帝国のパイロット名', () => {
  const kilrashi = VEIL_PEOPLE.filter((person) => person.faction === 'kilrashi');
  const names = new Set(kilrashi.map((person) => person.name));

  it('すべて人物名簿の名前である', () => {
    expect(KILRATHI_NAMES.length).toBeGreaterThan(0);
    for (const name of KILRATHI_NAMES) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('最高権力者（ヴァルカーン）を含まない', () => {
    const leader = kilrashi.find((person) => person.isLeader === true);
    expect(leader).toBeDefined();
    expect(KILRATHI_NAMES).not.toContain(leader!.name);
  });

  it('エースを含まない', () => {
    const aceNames = ACES.filter((ace) => ace.faction === 'kilrathi').map(
      (ace) => VEIL_PEOPLE.find((person) => person.id === ace.personId)!.name,
    );
    expect(aceNames.length).toBeGreaterThan(0);
    for (const aceName of aceNames) {
      expect(KILRATHI_NAMES).not.toContain(aceName);
    }
  });

  it('kilrathiName は名簿の名前を巡回して返す', () => {
    for (let i = 0; i < KILRATHI_NAMES.length * 2; i += 1) {
      expect(KILRATHI_NAMES).toContain(kilrathiName(i));
    }
    expect(kilrathiName(KILRATHI_NAMES.length)).toBe(kilrathiName(0));
  });
});

describe('既存エクスポートの後方互換', () => {
  it('僚機・プレイヤーの台詞関数が文字列を返す', () => {
    expect(wingmanAck('form').length).toBeGreaterThan(0);
    expect(wingmanAck('help-me').length).toBeGreaterThan(0);
    expect(wingmanKillLine().length).toBeGreaterThan(0);
    expect(wingmanTroubleLine().length).toBeGreaterThan(0);
    expect(playerTaunt().length).toBeGreaterThan(0);
    expect(rumor().length).toBeGreaterThan(0);
  });
});
