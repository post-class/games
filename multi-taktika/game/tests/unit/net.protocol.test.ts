/**
 * T-M14-02 / 04: パケットの形と符号化（`07§12` / 手順書 §11.2）
 *
 * 見るべきこと:
 *  1. **送るのは入力だけ**（`input` に座標の配列が入らない形になっている）
 *  2. **空入力は `cmds` を送らない**（T-M14-04 の圧縮。1 通あたり 10 バイト減る）
 *  3. 壊れた受信で**例外を投げない**（1 通で試合を落とさない）
 *  4. `#room=` / `?room=` の共有 URL から部屋 ID を読める（`01` アカウント登録なし）
 */

import { describe, expect, it } from 'vitest';
import type { Command } from '@/sim/command';
import {
  decodeS2C,
  defaultRelayUrl,
  encodeC2S,
  roomFromLocation,
  utf8Bytes,
} from '@/net';

describe('T-M14-04: 空入力の省略', () => {
  it('cmds が空なら cmds フィールドを丸ごと落とす', () => {
    const text = encodeC2S({ t: 'input', tick: 42, cmds: [] });
    expect(text).toBe('{"t":"input","tick":42}');
    // サーバ側は `Array.isArray(msg.cmds) ? msg.cmds : []` なので、欠けていれば空入力
    expect(JSON.parse(text)).toEqual({ t: 'input', tick: 42 });
  });

  it('省略のぶんだけ短くなる（1 通 10 バイト = `,"cmds":[]`）', () => {
    const withField = JSON.stringify({ t: 'input', tick: 42, cmds: [] });
    const omitted = encodeC2S({ t: 'input', tick: 42, cmds: [] });
    expect(utf8Bytes(withField) - utf8Bytes(omitted)).toBe(10);
  });

  it('入力があるときは普通に載せる（内容を書き換えない）', () => {
    const cmds: Command[] = [{ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' }];
    const text = encodeC2S({ t: 'input', tick: 6, cmds });
    expect(JSON.parse(text)).toEqual({ t: 'input', tick: 6, cmds });
  });
});

describe('T-M14-02: 受信の解読', () => {
  it('welcome / start / input / desync / left を読める', () => {
    expect(
      decodeS2C(
        JSON.stringify({
          t: 'welcome',
          playerId: 1,
          seed: 12345,
          inputDelayFrames: 3,
          players: [
            { playerId: 1, name: 'B', ready: false },
            { playerId: 0, name: 'A', ready: true },
          ],
        }),
      ),
    ).toEqual({
      t: 'welcome',
      playerId: 1,
      seed: 12345,
      inputDelayFrames: 3,
      // **playerId 昇順に直す**（受信した配列の順に判断を預けない。§0.3）
      players: [
        { playerId: 0, name: 'A', ready: true },
        { playerId: 1, name: 'B', ready: false },
      ],
    });

    expect(decodeS2C('{"t":"start","startTick":0}')).toEqual({ t: 'start', startTick: 0 });
    expect(decodeS2C('{"t":"input","tick":6,"byPlayer":{"0":[],"1":[]}}')).toEqual({
      t: 'input',
      tick: 6,
      byPlayer: { 0: [], 1: [] },
    });
    expect(decodeS2C('{"t":"desync","tick":250,"hashes":{"0":1,"1":2}}')).toEqual({
      t: 'desync',
      tick: 250,
      hashes: { 0: 1, 1: 2 },
    });
    expect(decodeS2C('{"t":"left","playerId":1,"atTick":-1,"holdMs":120000}')).toEqual({
      t: 'left',
      playerId: 1,
      atTick: -1,
      holdMs: 120_000,
    });
  });

  it('壊れた受信は例外ではなく null（1 通で試合を落とさない）', () => {
    expect(decodeS2C('これは JSON ではない')).toBeNull();
    expect(decodeS2C('42')).toBeNull();
    expect(decodeS2C('{"t":"まだ無い種別"}')).toBeNull();
    expect(decodeS2C('{"t":"input","tick":"6","byPlayer":{}}')).toBeNull();
  });

  it('Command らしくない要素は落とす（applyCommands まで持ち込まない）', () => {
    const got = decodeS2C('{"t":"input","tick":0,"byPlayer":{"0":[null,3,{"t":"resign","p":0}]}}');
    expect(got).toEqual({ t: 'input', tick: 0, byPlayer: { 0: [{ t: 'resign', p: 0 }] } });
  });
});

describe('T-M14-02: 部屋 ID の共有（URL だけで入れる）', () => {
  it('#room= を読む', () => {
    expect(roomFromLocation({ hash: '#room=abcd' })).toBe('abcd');
  });

  it('?room=（MatchSetup の共有 URL の形）も読む', () => {
    expect(roomFromLocation({ search: '?room=xy12&seed=7' })).toBe('xy12');
  });

  it('#room= が優先される', () => {
    expect(roomFromLocation({ hash: '#room=aaa', search: '?room=bbb' })).toBe('aaa');
  });

  it('無ければ null（= 単独プレイ）', () => {
    expect(roomFromLocation({})).toBeNull();
    expect(roomFromLocation({ hash: '#', search: '?seed=1' })).toBeNull();
    expect(roomFromLocation({ hash: '#room=' })).toBeNull();
  });

  it('中継サーバの URL はページと同じホスト（https なら wss）', () => {
    expect(defaultRelayUrl({ protocol: 'http:', hostname: 'localhost' })).toBe(
      'ws://localhost:8787',
    );
    expect(defaultRelayUrl({ protocol: 'https:', hostname: 'example.test' })).toBe(
      'wss://example.test:8787',
    );
  });
});
