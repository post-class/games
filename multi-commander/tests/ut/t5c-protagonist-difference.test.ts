import { describe, expect, it } from 'vitest';
import { COMBAT_GRADES, PROTAGONISTS } from '../../src/content/veil/people';
import { speakerName } from '../../src/content/veil/missions/shared';
import {
  PROTAGONIST_BOND_LIMIT,
  PROTAGONIST_VOICES,
  protagonistBriefingLine,
  protagonistControlCall,
  protagonistDebriefLine,
  protagonistInitialBond,
  protagonistVoice,
  protagonistWingCall,
  protagonistWingReadyLine,
  type ProtagonistVoice,
} from '../../src/content/dialogue';
import {
  applyProtagonistInitialBond,
  newRoster,
  RELATION_STAGES,
  relationStage,
} from '../../src/app/roster';
import { PROTAGONIST_EFFECTS } from '../../src/ui/PilotSelectScene';
import { difficulty } from '../../src/app/settings';
import { MISSIONS } from '../../src/content/missions';
import { PLAYABLE_SHIPS, shipDef } from '../../src/content/ships';
import { PILOTS } from '../../src/content/pilots';

/**
 * T5-⑬c 主人公5名に「ゲーム上の差」を付ける。
 *
 * 付けてよい差は3つだけ。
 *   1. 無線での呼ばれ方（管制／僚機）
 *   2. 固有台詞（ブリーフィング・デブリーフィング・僚機の一言）
 *   3. 僚機の初期関係値（±0.2 まで）
 *
 * 逆に「強さ」は1つも変えない。難易度・敵性能・自機性能・初期機体・勝敗条件が
 * 主人公で動いていないことを、このファイルで機械照合する。
 * ここが緩むと「主人公選択が難易度選択」になり、設計として誤りになる。
 */

const IDS = PROTAGONISTS.map((p) => p.id);
const voiceOf = (id: string): ProtagonistVoice => {
  const v = protagonistVoice(id);
  if (!v) throw new Error(`no voice: ${id}`);
  return v;
};
const linesOf = (id: string): string[] => {
  const v = voiceOf(id);
  return [v.briefing, v.debriefWin, v.debriefLoss, v.wingReady];
};
const personOf = (id: string) => PROTAGONISTS.find((p) => p.id === id)!;

describe('T5-⑬c 主人公5名の呼ばれ方', () => {
  it('5名すべてに呼称と台詞が定義されている', () => {
    expect(IDS).toHaveLength(5);
    for (const id of IDS) {
      const v = voiceOf(id);
      expect(v.controlCall.length, id).toBeGreaterThan(0);
      expect(v.wingCall.length, id).toBeGreaterThan(0);
    }
    // 主人公以外の人物 id は定義しない（`PROTAGONIST_VOICES` が主人公5名に閉じている）
    expect(Object.keys(PROTAGONIST_VOICES).sort()).toEqual([...IDS].sort());
  });

  it('管制と僚機の呼び方の組み合わせが、5名すべてで違う', () => {
    const pairs = IDS.map((id) => `${voiceOf(id).controlCall}/${voiceOf(id).wingCall}`);
    expect(new Set(pairs).size).toBe(5);
    // 「管制も僚機も同じ呼び方」の人がいない（呼び分けが実際に起きている）
    for (const id of IDS) expect(voiceOf(id).controlCall, id).not.toBe(voiceOf(id).wingCall);
  });

  it('呼称は speakerName() / epithet / 立場を表す語のどれかで、姓名の切り出しを再実装していない', () => {
    // 名前の整形はここで作らない。使えるのは名簿の値そのままか、立場を表す短い語だけ。
    const standing = new Set(['隊長', '新人']);
    for (const id of IDS) {
      const person = personOf(id);
      const allowed = new Set([speakerName(id), person.epithet]);
      for (const call of [voiceOf(id).controlCall, voiceOf(id).wingCall]) {
        expect(allowed.has(call) || standing.has(call), `${id}: ${call}`).toBe(true);
      }
    }
  });

  it('「隊長」と呼ばれるのは role が隊長の人だけ、「新人」と呼ばれるのは訓練生だけ', () => {
    for (const id of IDS) {
      const role = personOf(id).role;
      const calls = `${voiceOf(id).controlCall} ${voiceOf(id).wingCall}`;
      if (calls.includes('隊長')) expect(role, id).toContain('隊長');
      if (calls.includes('新人')) expect(role, id).toContain('訓練生');
    }
  });

  it('他人の二つ名で呼ばれる人がいない', () => {
    for (const id of IDS) {
      const others = PROTAGONISTS.filter((p) => p.id !== id).map((p) => p.epithet);
      const text = [voiceOf(id).controlCall, voiceOf(id).wingCall, ...linesOf(id)].join(' ');
      for (const epithet of others) expect(text, `${id} / ${epithet}`).not.toContain(epithet);
    }
  });

  it('未選択（旧セーブ）と未知の id では呼称を作らない', () => {
    for (const id of [undefined, '', 'confed-99', 'kilrashi-01']) {
      expect(protagonistVoice(id)).toBeUndefined();
      expect(protagonistControlCall(id)).toBeUndefined();
      expect(protagonistWingCall(id)).toBeUndefined();
      expect(protagonistBriefingLine(id)).toBeUndefined();
      expect(protagonistDebriefLine(id, 'win')).toBeUndefined();
      expect(protagonistDebriefLine(id, 'loss')).toBeUndefined();
      expect(protagonistWingReadyLine(id)).toBeUndefined();
      expect(protagonistInitialBond(id)).toBe(0);
    }
  });
});

describe('T5-⑬c 固有台詞が role / grade / achievement と矛盾しない', () => {
  it('管制の台詞は管制の呼称で、僚機の一言は僚機の呼称で呼ぶ', () => {
    for (const id of IDS) {
      const v = voiceOf(id);
      for (const line of [v.briefing, v.debriefWin, v.debriefLoss]) {
        expect(line, id).toContain(v.controlCall);
      }
      expect(v.wingReady, id).toContain(v.wingCall);
    }
  });

  it('ブリーフィングの台詞が、その人の achievement に実際に出てくる語を含む', () => {
    for (const id of IDS) {
      const v = voiceOf(id);
      // キーワードは「名簿の実績に書いてある語」でなければならない（作り話を足さない）
      expect(personOf(id).achievement, id).toContain(v.achievementKeyword);
      expect(v.briefing, id).toContain(v.achievementKeyword);
    }
  });

  it('訓練生を歴戦扱いしない（B級・訓練生の台詞に隊長格の語が出ない）', () => {
    const forbidden = ['歴戦', '百戦', 'エース', '隊長', 'ベテラン', '指揮官', '名は通って', '数えきれ'];
    for (const id of IDS) {
      const person = personOf(id);
      if (!person.role.includes('訓練生')) continue;
      // 前提の確認（名簿が変わって歴戦の役割になったら、この検査を見直す）
      expect(person.grade, id).toBe('B');
      const text = linesOf(id).join(' ');
      for (const word of forbidden) expect(text, `${id} / ${word}`).not.toContain(word);
    }
  });

  it('隊長・編隊リーダーを新人扱いしない', () => {
    const forbidden = ['訓練生', '新人', '見習', '初陣', '初めての出撃', '慣れないうち'];
    for (const id of IDS) {
      const person = personOf(id);
      if (!/隊長|リーダー/.test(person.role)) continue;
      expect(['S', 'SS'], id).toContain(person.grade);
      const text = linesOf(id).join(' ');
      for (const word of forbidden) expect(text, `${id} / ${word}`).not.toContain(word);
    }
  });

  it('台詞が5名すべてで異なる', () => {
    const all = IDS.flatMap((id) => linesOf(id));
    expect(new Set(all).size).toBe(all.length);
  });

  it('台詞に敵性能・難易度に関わる約束を書いていない', () => {
    // 「弾が増える」「敵が弱くなる」等を台詞で約束すると、表示と実挙動が食い違う。
    const forbidden = ['難易度', '装甲を強化', 'ミサイルを増', '敵は弱', '出撃前に補給を増'];
    const text = IDS.flatMap((id) => linesOf(id)).join(' ');
    for (const word of forbidden) expect(text).not.toContain(word);
  });
});

describe('T5-⑬c 僚機の初期関係値', () => {
  it('5名で初期値が違い、±0.2 を超えない', () => {
    const bonds = IDS.map((id) => protagonistInitialBond(id));
    expect(new Set(bonds).size).toBe(5);
    for (const [i, bond] of bonds.entries()) {
      expect(Math.abs(bond), IDS[i]).toBeLessThanOrEqual(PROTAGONIST_BOND_LIMIT);
    }
    expect(PROTAGONIST_BOND_LIMIT).toBe(0.2);
  });

  it('隊長格ほど高く、訓練生がいちばん低い（grade / role と向きが合う）', () => {
    const leader = protagonistInitialBond('confed-01'); // 艦載戦闘機隊長 / SS級
    const wingLead = protagonistInitialBond('confed-02'); // 迎撃編隊リーダー / SS級
    const trainee = protagonistInitialBond('confed-05'); // 訓練生 / B級
    expect(COMBAT_GRADES[personOf('confed-01').grade].label).toBe('SS級');
    expect(leader).toBeGreaterThan(wingLead);
    expect(wingLead).toBeGreaterThan(trainee);
    expect(trainee).toBeLessThan(0);
  });

  it('関係値5段階のラベルが壊れない（開始時点で「不信」に落ちる主人公がいない）', () => {
    for (const id of IDS) {
      const roster = newRoster();
      applyProtagonistInitialBond(roster, id);
      for (const p of roster.pilots) {
        const stage = relationStage(p);
        expect(RELATION_STAGES, `${id}/${p.id}`).toContain(stage.label);
        expect(stage.step, `${id}/${p.id}`).toBeGreaterThanOrEqual(0);
        expect(stage.step, `${id}/${p.id}`).toBeLessThanOrEqual(stage.max);
        expect(stage.label, `${id}/${p.id}`).not.toBe('不信');
      }
    }
    // 隊長を選ぶと「初対面」より一段上、訓練生を選ぶと「初対面」から始まる
    const leaderRoster = newRoster();
    applyProtagonistInitialBond(leaderRoster, 'confed-01');
    expect(relationStage(leaderRoster.pilots[0]).label).toBe('顔見知り');
    const traineeRoster = newRoster();
    applyProtagonistInitialBond(traineeRoster, 'confed-05');
    expect(relationStage(traineeRoster.pilots[0]).label).toBe('初対面');
  });

  it('主人公を変えると初期 bond が実際に動き、選び直しても冪等', () => {
    const roster = newRoster();
    applyProtagonistInitialBond(roster, 'confed-01');
    const high = roster.pilots.map((p) => p.bond);
    applyProtagonistInitialBond(roster, 'confed-01');
    expect(roster.pilots.map((p) => p.bond)).toEqual(high);
    applyProtagonistInitialBond(roster, 'confed-05');
    const low = roster.pilots.map((p) => p.bond);
    expect(low).not.toEqual(high);
    expect(low.every((b, i) => b < high[i])).toBe(true);
  });

  it('既に一緒に飛んだ相手の積み上げは書き換えない', () => {
    const roster = newRoster();
    roster.pilots[0].sorties = 3;
    roster.pilots[0].bond = 0.55;
    applyProtagonistInitialBond(roster, 'confed-01');
    expect(roster.pilots[0].bond).toBe(0.55);
    expect(roster.pilots[1].bond).toBe(0.2);
  });

  it('旧セーブ（protagonistId なし）では初期 bond を動かさない', () => {
    for (const id of [undefined, 'confed-99']) {
      const roster = newRoster();
      expect(applyProtagonistInitialBond(roster, id)).toBe(0);
      for (const p of roster.pilots) expect(p.bond).toBe(0);
      // 段階表示も従来どおり
      expect(relationStage(roster.pilots[0]).label).toBe('初対面');
    }
  });
});

describe('T5-⑬c 主人公を変えても「強さ」は1つも変わらない', () => {
  /** 主人公を1名選んだ状態を作り、強さに関わる値をすべて文字列化する */
  const strengthSnapshot = (id: string): string => {
    const roster = newRoster();
    applyProtagonistInitialBond(roster, id);
    return JSON.stringify({
      // 難易度パラメータ（敵技量・被ダメージ・同時攻撃数・ミサイル頻度など）
      difficulty: difficulty(),
      // 自機性能と初期機体の候補（格納庫で選べる集合）
      playableShips: [...PLAYABLE_SHIPS],
      ships: PLAYABLE_SHIPS.map((shipId) => shipDef(shipId)),
      // 敵の出現定義・目標・制限時間（全ミッション）
      missions: MISSIONS,
      // 僚機の技量
      pilotSkills: PILOTS.map((p) => [p.id, p.skill]),
    });
  };

  it('難易度・敵の出現定義・自機性能・初期機体・僚機技量が5名で完全に一致する', () => {
    const snapshots = IDS.map(strengthSnapshot);
    for (const snap of snapshots) expect(snap).toBe(snapshots[0]);
    // 未選択（旧セーブ）でも同じ
    const roster = newRoster();
    applyProtagonistInitialBond(roster, undefined);
    expect(strengthSnapshot('confed-01')).toBe(snapshots[0]);
  });

  it('格納庫で選べる機体は主人公に関わらず4機のまま', () => {
    expect([...PLAYABLE_SHIPS]).toEqual(['hornet', 'scimitar', 'raptor', 'rapier']);
    for (const id of IDS) {
      // 主人公データは機体を1機も指名しない（初期機体を固定する余地を残さない）
      const text = JSON.stringify(voiceOf(id));
      for (const shipId of PLAYABLE_SHIPS) expect(text, `${id}/${shipId}`).not.toContain(shipId);
    }
  });

  it('主人公データが持てるのは呼称・台詞・関係値だけ（強さの項目を足せない）', () => {
    const allowed = [
      'controlCall',
      'wingCall',
      'achievementKeyword',
      'briefing',
      'debriefWin',
      'debriefLoss',
      'wingReady',
      'initialBond',
    ].sort();
    for (const id of IDS) {
      expect(Object.keys(voiceOf(id)).sort(), id).toEqual(allowed);
      // 数値は初期関係値の1つだけ。ここに hp や damage の類が増えていないこと
      const numbers = Object.entries(voiceOf(id)).filter(([, v]) => typeof v === 'number');
      expect(numbers.map(([k]) => k), id).toEqual(['initialBond']);
    }
  });
});

describe('T5-⑬c 選任画面の「変わる／変わらない」が実態と合う', () => {
  it('「変わる」に書いた3つの差が、すべて実装されている', () => {
    const changes = PROTAGONIST_EFFECTS.changes.join(' ');
    // 呼ばれ方
    expect(changes).toContain('呼ぶ名前');
    expect(new Set(IDS.map((id) => voiceOf(id).controlCall)).size).toBe(5);
    // 固有台詞
    expect(changes).toContain('専用の1行');
    expect(IDS.every((id) => (protagonistBriefingLine(id) ?? '').length > 0)).toBe(true);
    expect(IDS.every((id) => (protagonistDebriefLine(id, 'win') ?? '').length > 0)).toBe(true);
    expect(IDS.every((id) => (protagonistDebriefLine(id, 'loss') ?? '').length > 0)).toBe(true);
    expect(IDS.every((id) => (protagonistWingReadyLine(id) ?? '').length > 0)).toBe(true);
    // 僚機の初期関係値
    expect(changes).toContain('関係値の初期値');
    expect(new Set(IDS.map((id) => protagonistInitialBond(id))).size).toBe(5);
  });

  it('「変わらない」に、実際に動かないものだけが挙がっている', () => {
    const unchanged = PROTAGONIST_EFFECTS.unchanged.join(' ');
    for (const word of ['技量', '機体性能', '初期機体', '僚機の顔ぶれ', '敵の強さ', '難易度', '勝敗条件']) {
      expect(unchanged, word).toContain(word);
    }
    // 戦闘中の無線は未実装なので「変わる」側に書いていない
    expect(unchanged).toContain('戦闘中の無線');
    expect(PROTAGONIST_EFFECTS.changes.join(' ')).not.toContain('戦闘中');
  });
});
