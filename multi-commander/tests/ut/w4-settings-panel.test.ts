import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom, type FakeElement } from './fake-dom';
import { buildSettingsPanel } from '../../src/ui/SettingsPanel';
import {
  COCKPIT_STYLES,
  COCKPIT_STYLE_LABEL,
  SFX_CATEGORIES,
  SFX_CATEGORY_LABEL,
  SFX_SOURCE_LABEL,
  SFX_SOURCE_OPTIONS,
  resetSettings,
  settings,
  updateSettings,
} from '../../src/app/settings';
import {
  DEFAULT_MUSIC_ASSIGNMENT,
  MUSIC_CUES,
  MUSIC_CUE_LABEL,
  musicChoiceLabel,
} from '../../src/audio/musicCues';

/**
 * W4 / W5 — 設定パネルの 4タブ化と新 UI（`src/ui/SettingsPanel.ts`）。
 *
 * `fake-dom.ts` の最小 DOM に差し替えて、実際に組まれた行とクリック経路を検証する
 * （`t3a-screen-host-pager.test.ts` と同じ流儀）。
 * 設定モジュールは読むだけで、書き込みは必ず UI のクリックを通す。
 */

/** タブのラベルで表示を切り替える。 */
function selectTab(dom: FakeDom, root: FakeElement, label: string): void {
  const tab = dom.findAll(root, 'mc-tab').find((t) => t.textContent === label);
  if (!tab) throw new Error(`タブが見つからない: ${label}`);
  tab.fire('click');
}

/** 行（`.mc-setting`）をラベルで探す。ラベルは行の最初の子。 */
function rowOf(dom: FakeDom, root: FakeElement, label: string): FakeElement | undefined {
  return dom.findAll(root, 'mc-setting').find((r) => r.children[0]?.textContent === label);
}

function requireRow(dom: FakeDom, root: FakeElement, label: string): FakeElement {
  const r = rowOf(dom, root, label);
  if (!r) throw new Error(`行が見つからない: ${label}`);
  return r;
}

/** 行の中の操作部（`.ctl`）。 */
function ctlOf(row: FakeElement): FakeElement {
  const ctl = row.children.find((c) => c.classNames().includes('ctl'));
  if (!ctl) throw new Error('操作部が無い行');
  return ctl;
}

/** ◀ ▶ を押す。 */
function clickArrow(row: FakeElement, arrow: '◀' | '▶'): void {
  const btn = ctlOf(row).children.find((c) => c.textContent === arrow);
  if (!btn) throw new Error(`${arrow} が無い行`);
  btn.fire('click');
}

/** 行に表示されている現在値（`.val` の最初のもの＝◀▶ の間の文字）。 */
function currentValue(row: FakeElement): string {
  const val = ctlOf(row).children.find((c) => c.classNames().includes('val'));
  return val?.textContent ?? '';
}

describe('W4 設定パネルのタブ構成', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
    dom.restore();
    vi.restoreAllMocks();
  });

  it('タブは ゲーム / 操作 / 表示 / オーディオ の4つ', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    const labels = dom.findAll(root, 'mc-tab').map((t) => t.textContent);
    expect(labels).toEqual(['ゲーム', '操作', '表示', 'オーディオ']);
  });

  it('見た目の項目は表示タブにあり、操作・オーディオタブからは消えている', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    const moved = [
      'コクピット表示',
      '被弾カメラ揺れ',
      '追尾視点の遅延',
      'アフターバーナー画角',
      '無線字幕サイズ',
      '無線ログの表示時間',
      'ブルーム (発光のにじみ)',
      '閃光を抑える',
      '色覚サポート配色',
    ];
    selectTab(dom, root, '操作');
    for (const label of moved) expect(rowOf(dom, root, label), label).toBeUndefined();
    // ゲームパッド振動は逆に「操作」へ移した
    expect(rowOf(dom, root, 'ゲームパッド振動')).toBeDefined();

    selectTab(dom, root, 'オーディオ');
    for (const label of moved) expect(rowOf(dom, root, label), label).toBeUndefined();
    expect(rowOf(dom, root, 'ゲームパッド振動')).toBeUndefined();

    selectTab(dom, root, '表示');
    for (const label of moved) expect(rowOf(dom, root, label), label).toBeDefined();
  });
});

describe('W4 表示タブ', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
    dom.restore();
  });

  it('コクピット表示を一巡すると 5値すべてを取る', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, '表示');
    const seen: string[] = [settings.cockpitStyle];
    const labels: string[] = [currentValue(requireRow(dom, root, 'コクピット表示'))];
    for (let i = 0; i < COCKPIT_STYLES.length; i++) {
      // 押すたびに再描画されるので、毎回行を取り直す
      clickArrow(requireRow(dom, root, 'コクピット表示'), '▶');
      seen.push(settings.cockpitStyle);
      labels.push(currentValue(requireRow(dom, root, 'コクピット表示')));
    }
    expect([...new Set(seen)].sort()).toEqual([...COCKPIT_STYLES].sort());
    // 一巡して元の値に戻る
    expect(seen[seen.length - 1]).toBe(seen[0]);
    // 表示ラベルは settings 側の表と同じ出所
    expect(labels).toEqual(seen.map((s) => COCKPIT_STYLE_LABEL[s as (typeof COCKPIT_STYLES)[number]]));
  });

  it('ガラスの映り込みは full / glass のときだけ出る', () => {
    for (const style of COCKPIT_STYLES) {
      updateSettings({ cockpitStyle: style });
      const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
      selectTab(dom, root, '表示');
      const shown = rowOf(dom, root, 'ガラスの映り込み') !== undefined;
      expect(shown, `style=${style}`).toBe(style === 'full' || style === 'glass');
    }
  });

  it('ガラスの映り込みを動かすと glassOpacity に入る', () => {
    updateSettings({ cockpitStyle: 'full' });
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, '表示');
    const ctl = ctlOf(requireRow(dom, root, 'ガラスの映り込み'));
    const input = ctl.children[0] as FakeElement & { value: string };
    input.value = '0.8';
    input.fire('input');
    expect(settings.glassOpacity).toBeCloseTo(0.8);
  });

  it('コクピット表示とブルーム・色覚サポートの変更は onChange を呼ぶ', () => {
    let calls = 0;
    const root = buildSettingsPanel(() => {
      calls++;
    }) as unknown as FakeElement;
    selectTab(dom, root, '表示');
    clickArrow(requireRow(dom, root, 'コクピット表示'), '▶');
    expect(calls).toBe(1);
    ctlOf(requireRow(dom, root, 'ブルーム (発光のにじみ)')).children[0].fire('click');
    expect(calls).toBe(2);
    ctlOf(requireRow(dom, root, '色覚サポート配色')).children[0].fire('click');
    expect(calls).toBe(3);
  });
});

describe('W7-3 操作タブのミサイルロック', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
    dom.restore();
  });

  it('自動 / 手動 の2択で missileLock が切り替わる', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, '操作');
    expect(currentValue(requireRow(dom, root, 'ミサイルロック'))).toBe('自動');
    clickArrow(requireRow(dom, root, 'ミサイルロック'), '▶');
    expect(settings.missileLock).toBe('manual');
    expect(currentValue(requireRow(dom, root, 'ミサイルロック'))).toBe('手動');
    clickArrow(requireRow(dom, root, 'ミサイルロック'), '▶');
    expect(settings.missileLock).toBe('auto');
  });

  it('手動ロックのキーを添えた説明が出る', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, '操作');
    expect(dom.text(root)).toContain('手動では L を押した目標だけロックします');
  });
});

describe('W5-A オーディオタブの BGM', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
    dom.restore();
  });

  it('11 場面の行があり、既定の曲名が出ている', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    expect(MUSIC_CUES).toHaveLength(11);
    for (const cue of MUSIC_CUES) {
      const row = requireRow(dom, root, MUSIC_CUE_LABEL[cue]);
      expect(currentValue(row), cue).toBe(musicChoiceLabel(DEFAULT_MUSIC_ASSIGNMENT[cue]));
    }
  });

  it('曲を変えると musicAssignment に入り、表示も変わる', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    clickArrow(requireRow(dom, root, MUSIC_CUE_LABEL.combat), '▶');
    const chosen = settings.musicAssignment.combat;
    expect(chosen).toBeDefined();
    expect(chosen).not.toBe(DEFAULT_MUSIC_ASSIGNMENT.combat);
    expect(currentValue(requireRow(dom, root, MUSIC_CUE_LABEL.combat))).toBe(
      musicChoiceLabel(chosen!),
    );
    // 他の場面は動かさない
    expect(settings.musicAssignment.title).toBeUndefined();
  });

  it('◀ で1つ戻すと「無音」に到達できる', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    // 既定は先頭の曲なので、◀ で末尾（無音）へ回り込む
    clickArrow(requireRow(dom, root, MUSIC_CUE_LABEL.title), '◀');
    expect(settings.musicAssignment.title).toBe('silent');
    expect(currentValue(requireRow(dom, root, MUSIC_CUE_LABEL.title))).toBe('無音');
  });
});

describe('W5-B オーディオタブの効果音', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
    dom.restore();
  });

  it('9 カテゴリの行があり、音源を変えると sfx[category].source に入る', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    expect(SFX_CATEGORIES).toHaveLength(9);
    for (const category of SFX_CATEGORIES) {
      const row = requireRow(dom, root, SFX_CATEGORY_LABEL[category]);
      expect(currentValue(row), category).toBe(SFX_SOURCE_LABEL[settings.sfx[category].source]);
    }
    clickArrow(requireRow(dom, root, SFX_CATEGORY_LABEL.gun), '▶');
    expect(settings.sfx.gun.source).toBe('synth');
    expect(currentValue(requireRow(dom, root, SFX_CATEGORY_LABEL.gun))).toBe('合成音');
  });

  it('カテゴリごとの選択肢は SFX_SOURCE_OPTIONS どおり（被弾に「実音声」は出ない）', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    const seen = new Set<string>();
    for (let i = 0; i < SFX_SOURCE_OPTIONS.impact.length; i++) {
      seen.add(currentValue(requireRow(dom, root, SFX_CATEGORY_LABEL.impact)));
      clickArrow(requireRow(dom, root, SFX_CATEGORY_LABEL.impact), '▶');
    }
    expect([...seen].sort()).toEqual(
      SFX_SOURCE_OPTIONS.impact.map((s) => SFX_SOURCE_LABEL[s]).sort(),
    );
    expect(seen.has(SFX_SOURCE_LABEL.sample)).toBe(false);
  });

  it('カテゴリ音量のスライダが sfx[category].gain に入る', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    const ctl = ctlOf(requireRow(dom, root, SFX_CATEGORY_LABEL.warning));
    const input = ctl.children.find((c) => c.tagName === 'INPUT') as FakeElement & {
      value: string;
    };
    input.value = '0.35';
    input.fire('input');
    expect(settings.sfx.warning.gain).toBeCloseTo(0.35);
    expect(settings.sfx.gun.gain).toBe(1);
  });
});

describe('試聴ボタン', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
    dom.restore();
  });

  it('actions を渡さないと [試聴] は出ない', () => {
    const root = buildSettingsPanel(() => {}) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    expect(dom.findAll(root, 'mc-preview')).toHaveLength(0);
    expect(dom.text(root)).not.toContain('試聴');
  });

  it('actions を渡すと BGM 11 行・効果音 9 行に [試聴] が出る', () => {
    const root = buildSettingsPanel(() => {}, {
      previewMusic: () => {},
      previewSfx: () => {},
    }) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    expect(dom.findAll(root, 'mc-preview')).toHaveLength(MUSIC_CUES.length + SFX_CATEGORIES.length);
  });

  it('[試聴] のクリックで場面 / カテゴリを渡してコールバックが呼ばれる', () => {
    const music: string[] = [];
    const sfx: string[] = [];
    const root = buildSettingsPanel(() => {}, {
      previewMusic: (cue) => music.push(cue),
      previewSfx: (category) => sfx.push(category),
    }) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');

    const musicRow = requireRow(dom, root, MUSIC_CUE_LABEL.boss);
    ctlOf(musicRow)
      .children.find((c) => c.classNames().includes('mc-preview'))!
      .fire('click');
    expect(music).toEqual(['boss']);

    const sfxRow = requireRow(dom, root, SFX_CATEGORY_LABEL.explosion);
    ctlOf(sfxRow)
      .children.find((c) => c.classNames().includes('mc-preview'))!
      .fire('click');
    expect(sfx).toEqual(['explosion']);
  });

  it('片方だけ渡したときはそのセクションにだけ出る', () => {
    const root = buildSettingsPanel(() => {}, { previewSfx: () => {} }) as unknown as FakeElement;
    selectTab(dom, root, 'オーディオ');
    expect(dom.findAll(root, 'mc-preview')).toHaveLength(SFX_CATEGORIES.length);
  });
});
