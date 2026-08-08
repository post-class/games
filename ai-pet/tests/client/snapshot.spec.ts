/**
 * 記念撮影（G-3）の純粋関数のテスト。
 *
 * 描画（`composePhoto`）は canvas が必要で vitest の environment: 'node' では動かないため、
 * **文字とファイル名と寸法の組み立て**だけをここで固定する。
 * 見た目は親のブラウザ確認に任せる（AI_CODING §12: ブラウザは1つだけ使う方針）。
 */
import { describe, expect, it } from 'vitest';
import {
  ISLAND_NAME,
  captionBandHeight,
  captionSubtitle,
  photoLayout,
  seasonLabel,
  snapshotFileName,
  timeOfDayLabel,
  wrapText,
} from '../../packages/client/src/ui/snapshot.ts';

describe('季節と時間帯の日本語化', () => {
  it('季節は1文字で出す', () => {
    expect(seasonLabel('spring')).toBe('春');
    expect(seasonLabel('summer')).toBe('夏');
    expect(seasonLabel('autumn')).toBe('秋');
    expect(seasonLabel('winter')).toBe('冬');
  });

  it('時間帯は「夏の夕方」と読めるように「夕方」まで書く', () => {
    expect(timeOfDayLabel('morning')).toBe('朝');
    expect(timeOfDayLabel('day')).toBe('昼');
    expect(timeOfDayLabel('evening')).toBe('夕方');
    expect(timeOfDayLabel('night')).toBe('夜');
  });

  it('知らない値はそのまま出す（プロトコルが増えても文字が消えない）', () => {
    expect(seasonLabel('monsoon')).toBe('monsoon');
    expect(timeOfDayLabel('dawn')).toBe('dawn');
  });
});

describe('ファイル名の組み立て', () => {
  it('島日と撮った時刻（実時間）が入る', () => {
    const at = new Date(2026, 7, 8, 14, 32, 9);
    expect(snapshotFileName(3, at)).toBe('pokomofu-3日目-1432.png');
  });

  it('時刻は2桁ゼロ埋め', () => {
    expect(snapshotFileName(12, new Date(2026, 0, 1, 5, 7))).toBe('pokomofu-12日目-0507.png');
    expect(snapshotFileName(1, new Date(2026, 0, 1, 0, 0))).toBe('pokomofu-1日目-0000.png');
  });

  it('壊れた島日でもファイル名が崩れない', () => {
    const at = new Date(2026, 0, 1, 9, 3);
    expect(snapshotFileName(Number.NaN, at)).toBe('pokomofu-0日目-0903.png');
    expect(snapshotFileName(-5, at)).toBe('pokomofu-0日目-0903.png');
    expect(snapshotFileName(2.7, at)).toBe('pokomofu-2日目-0903.png');
  });

  it('拡張子はPNG（保存形式と一致していること）', () => {
    expect(snapshotFileName(1, new Date(2026, 0, 1, 1, 1)).endsWith('.png')).toBe(true);
  });
});

describe('説明文の組み立て', () => {
  it('いつ・誰と が1行で読める', () => {
    expect(captionSubtitle({ islandDay: 3, season: 'summer', timeOfDay: 'evening', petName: 'もふ' })).toBe(
      '3日目 ・ 夏の夕方 ・ もふといっしょ',
    );
  });

  it('名前が空でも「ペット」で埋める（名前欄が未受信のとき）', () => {
    expect(captionSubtitle({ islandDay: 1, season: 'spring', timeOfDay: 'morning', petName: '  ' })).toBe(
      '1日目 ・ 春の朝 ・ ペットといっしょ',
    );
  });

  it('島の名前は上の行に出すので説明文には入れない', () => {
    const sub = captionSubtitle({ islandDay: 9, season: 'winter', timeOfDay: 'night', petName: 'ぽこ' });
    expect(sub.includes(ISLAND_NAME)).toBe(false);
  });
});

describe('説明文の折返し', () => {
  /** 1文字10pxの等幅として測る（実描画では ctx.measureText を渡す） */
  const measure = (s: string): number => [...s].length * 10;

  it('入り切るときは1行', () => {
    expect(wrapText('あいうえお', 100, measure)).toEqual(['あいうえお']);
  });

  it('幅を超えたら次の行へ送る', () => {
    expect(wrapText('あいうえおかきくけこ', 50, measure)).toEqual(['あいうえお', 'かきくけこ']);
  });

  it('最大行数を超える分は三点リーダで切る', () => {
    const lines = wrapText('あいうえおかきくけこさしすせそ', 50, measure, 2);
    // 三点リーダぶんの幅を差し引いて「かきくけ」までしか残らない
    expect(lines).toEqual(['あいうえお', 'かきくけ…']);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(50);
  });

  it('1行だけ指定すると先頭だけを切って返す', () => {
    expect(wrapText('あいうえおかきくけこ', 50, measure, 1)).toEqual(['あいうえ…']);
  });

  it('1文字も入らない幅でも無限に行が増えない（最低1文字は置く）', () => {
    const lines = wrapText('あいうえお', 1, measure, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toBe('あ');
  });

  it('空文字でも1行返す（呼び出し側で行数を使うため）', () => {
    expect(wrapText('', 100, measure)).toEqual(['']);
  });

  it('サロゲートペア（絵文字混じりの名前）を割らない', () => {
    // ペットの名前はプレイヤー入力なので絵文字が入り得る。UTF-16の単位で切ると壊れる
    const lines = wrapText('🐰🐰🐰🐰', 20, measure, 2);
    expect(lines).toEqual(['🐰🐰', '🐰🐰']);
  });
});

describe('枠の寸法', () => {
  it('短辺に比例し、上限で止まる（スマホで枠が太すぎ／PCで文字が小さすぎになるのを防ぐ）', () => {
    const phone = photoLayout(390, 844);
    const pc = photoLayout(1280, 720);
    expect(phone.pad).toBeLessThan(pc.pad);
    expect(phone.titleSize).toBeLessThan(pc.titleSize);
    // 上限
    expect(photoLayout(4000, 4000).pad).toBe(26);
    expect(photoLayout(4000, 4000).titleSize).toBe(34);
    // 下限（極端に小さいウィンドウでも読める大きさを保つ）
    expect(photoLayout(10, 10).subSize).toBe(11);
    expect(photoLayout(10, 10).border).toBe(4);
  });

  it('すべて整数（半端な値でにじむのを避ける）', () => {
    const L = photoLayout(1024, 640);
    for (const v of [L.pad, L.border, L.radius, L.titleSize, L.subSize]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('帯の高さは行数が増えると高くなる', () => {
    const L = photoLayout(1280, 720);
    const one = captionBandHeight(L, 1);
    const two = captionBandHeight(L, 2);
    expect(two).toBeGreaterThan(one);
    // タイトル1行＋説明1行が確実に収まる高さであること
    expect(one).toBeGreaterThan(L.titleSize + L.subSize);
    expect(Number.isInteger(one)).toBe(true);
  });
});
