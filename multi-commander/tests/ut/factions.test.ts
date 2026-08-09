import { afterEach, describe, expect, it } from 'vitest';
import {
  FACTION_HEX,
  factionColor,
  factionColorVar,
  factionLabel,
  factionStance,
  isHostile,
  resetFactionStances,
  setFactionStance,
} from '../../src/content/factions';
import type { Faction } from '../../src/content/ships';

const ALL: Faction[] = ['confed', 'kilrathi', 'serecion', 'ordo', 'neurowm', 'neutral'];

afterEach(() => {
  resetFactionStances();
});

describe('既存挙動の回帰（confed / kilrathi / neutral）', () => {
  it('連邦とキルラシーは敵対、同陣営は非敵対', () => {
    expect(isHostile('confed', 'kilrathi')).toBe(true);
    expect(isHostile('kilrathi', 'confed')).toBe(true);
    expect(isHostile('confed', 'confed')).toBe(false);
    expect(isHostile('kilrathi', 'kilrathi')).toBe(false);
  });

  it('neutral は誰とも非敵対', () => {
    for (const f of ALL) {
      expect(isHostile('neutral', f)).toBe(false);
      expect(isHostile(f, 'neutral')).toBe(false);
    }
  });

  it('ラベルと色が従来値のまま', () => {
    expect(factionLabel('confed')).toBe('連邦');
    expect(factionLabel('kilrathi')).toBe('キルラシー');
    expect(factionLabel('neutral')).toBe('中立');
    expect(factionColor('confed', 'confed')).toBe('var(--friend)');
    expect(factionColor('kilrathi', 'confed')).toBe('var(--enemy)');
    expect(factionColor('confed', 'kilrathi')).toBe('var(--enemy)');
    expect(factionColor('kilrathi', 'kilrathi')).toBe('var(--friend)');
    expect(factionColor('neutral', 'confed')).toBe('var(--neutral)');
    expect(factionColor('neutral', 'kilrathi')).toBe('var(--neutral)');
  });
});

describe('五勢力の敵対関係テーブル', () => {
  it('セレシオン（武装中立）は連邦・キルラシー双方に非敵対', () => {
    expect(isHostile('serecion', 'confed')).toBe(false);
    expect(isHostile('serecion', 'kilrathi')).toBe(false);
    expect(factionStance('serecion', 'confed')).toBe('neutral');
  });

  it('オルド（条件付き協力）は連邦・キルラシー双方に非敵対', () => {
    expect(isHostile('ordo', 'confed')).toBe(false);
    expect(isHostile('ordo', 'kilrathi')).toBe(false);
    expect(factionStance('ordo', 'kilrathi')).toBe('neutral');
  });

  it('ニューロウムは連邦・キルラシー双方に敵対', () => {
    expect(isHostile('neurowm', 'confed')).toBe(true);
    expect(isHostile('neurowm', 'kilrathi')).toBe(true);
    expect(factionStance('confed', 'neurowm')).toBe('hostile');
  });

  it('セレシオンとオルドは互いに、ニューロウムに対しても非敵対（表に無い組は neutral）', () => {
    expect(isHostile('serecion', 'ordo')).toBe(false);
    expect(isHostile('serecion', 'neurowm')).toBe(false);
    expect(isHostile('ordo', 'neurowm')).toBe(false);
  });

  it('isHostile は対称である', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(isHostile(a, b)).toBe(isHostile(b, a));
      }
    }
  });
});

describe('関係の実行時上書き（第8章以降の共同作戦）', () => {
  it('setFactionStance で敵対を解除でき、逆順でも反映される', () => {
    setFactionStance('confed', 'kilrathi', 'neutral');
    expect(isHostile('confed', 'kilrathi')).toBe(false);
    expect(isHostile('kilrathi', 'confed')).toBe(false);
    // 表示色も同じテーブルから生成されるため、敵色ではなくなる。
    expect(factionColor('kilrathi', 'confed')).toBe('var(--faction-kilrathi)');
  });

  it('setFactionStance で非敵対を敵対へ変更できる', () => {
    setFactionStance('confed', 'serecion', 'hostile');
    expect(isHostile('confed', 'serecion')).toBe(true);
    expect(factionColor('serecion', 'confed')).toBe('var(--enemy)');
  });

  it('resetFactionStances で既定へ戻る', () => {
    setFactionStance('confed', 'kilrathi', 'neutral');
    setFactionStance('confed', 'serecion', 'hostile');
    resetFactionStances();
    expect(isHostile('confed', 'kilrathi')).toBe(true);
    expect(isHostile('confed', 'serecion')).toBe(false);
    expect(isHostile('confed', 'neurowm')).toBe(true);
    expect(factionColor('kilrathi', 'confed')).toBe('var(--enemy)');
  });

  it('neutral と同一勢力は上書きできない', () => {
    setFactionStance('neutral', 'confed', 'hostile');
    setFactionStance('confed', 'confed', 'hostile');
    expect(isHostile('neutral', 'confed')).toBe(false);
    expect(isHostile('confed', 'confed')).toBe(false);
  });
});

describe('表示（ラベル・色）', () => {
  it('factionLabel が全6値で空文字を返さない', () => {
    for (const f of ALL) {
      expect(factionLabel(f).length).toBeGreaterThan(0);
    }
  });

  it('非敵対の他勢力は敵色にならず勢力色で表示される', () => {
    expect(factionColor('serecion', 'confed')).toBe('var(--faction-serecion)');
    expect(factionColor('ordo', 'confed')).toBe('var(--faction-ordo)');
    expect(factionColor('neurowm', 'confed')).toBe('var(--enemy)');
  });

  it('勢力色は名鑑の色値と一致し、CSS 変数名と対応する', () => {
    expect(FACTION_HEX.confed).toBe('#73d7ff');
    expect(FACTION_HEX.kilrathi).toBe('#ff7d86');
    expect(FACTION_HEX.serecion).toBe('#7fe3b0');
    expect(FACTION_HEX.ordo).toBe('#d9b977');
    expect(FACTION_HEX.neurowm).toBe('#c9a6ff');
    for (const f of ALL) {
      expect(FACTION_HEX[f]).toMatch(/^#[0-9a-f]{6}$/);
      expect(factionColorVar(f)).toBe(f === 'neutral' ? 'var(--neutral)' : `var(--faction-${f})`);
    }
  });
});
