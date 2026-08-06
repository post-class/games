import { describe, expect, test } from 'vitest';
import {
  MAP_W,
  decodeAnim,
  decodeFacing,
  encodeAnim,
  encodeFacing,
  parseClientMsg,
  q2,
  rleDecode,
  rleEncode,
} from '@ai-pet/shared';

describe('parseClientMsg', () => {
  test('正常なメッセージを受け付ける', () => {
    const r = parseClientMsg(JSON.stringify({ t: 'hello', v: 1, displayName: 'りょう' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg.t).toBe('hello');
  });

  test('JSONでない文字列を拒否する', () => {
    expect(parseClientMsg('not json').ok).toBe(false);
  });

  test('未知の種別を拒否する', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'hack', payload: 1 })).ok).toBe(false);
  });

  test.each([
    ['マップ外の座標', { t: 'move', to: { x: MAP_W + 10, y: 0 } }],
    ['負の座標', { t: 'move', to: { x: -1, y: 0 } }],
    ['NaN座標', { t: 'move', to: { x: Number.NaN, y: 0 } }],
    ['長すぎる発話', { t: 'say', text: 'あ'.repeat(201) }],
    ['空の発話', { t: 'say', text: '' }],
    ['範囲外のaxis', { t: 'moveAxis', dx: 5, dy: 0 }],
    ['長すぎるペット名', { t: 'createPet', species: 'mofi', name: 'あ'.repeat(13), persona: {} }],
    ['未知のペット種', { t: 'createPet', species: 'dragon', name: 'ドラ', persona: {} }],
    ['未知のインタラクト', { t: 'interact', targetId: 1, act: 'delete_island' }],
  ])('不正な入力を拒否する: %s', (_label, payload) => {
    expect(parseClientMsg(JSON.stringify(payload)).ok).toBe(false);
  });

  test('createPetの正常系', () => {
    const r = parseClientMsg(
      JSON.stringify({
        t: 'createPet',
        species: 'mizune',
        name: 'ミズネ',
        persona: { traitTags: ['クール', '観察好き'], catchphrase: 'まあね', likes: 'さかな', dislikes: 'あめ' },
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('エンコード', () => {
  test('facingの往復', () => {
    for (const f of ['n', 'e', 's', 'w'] as const) {
      expect(decodeFacing(encodeFacing(f))).toBe(f);
    }
  });

  test('animの往復', () => {
    for (const a of ['idle', 'walk', 'act', 'sleep', 'talk'] as const) {
      expect(decodeAnim(encodeAnim(a))).toBe(a);
    }
  });

  test('q2 は小数2桁に丸める', () => {
    expect(q2(1.23456)).toBe(1.23);
    expect(q2(64)).toBe(64);
  });

  test('RLEの往復', () => {
    const values = [0, 0, 0, 1, 1, 2, 0, 0];
    const rle = rleEncode(values);
    expect(rle).toEqual([0, 3, 1, 2, 2, 1, 0, 2]);
    expect(rleDecode(rle, values.length)).toEqual(values);
  });

  test('RLEは長さ不一致を検出する', () => {
    expect(() => rleDecode([0, 3], 99)).toThrow();
  });

  test('RLEは大きな一様データを大幅に圧縮する', () => {
    const values = new Array(256).fill(3) as number[];
    expect(rleEncode(values)).toEqual([3, 256]);
  });
});
