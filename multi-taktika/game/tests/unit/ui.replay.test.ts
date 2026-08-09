/**
 * T-M15-04, 05: リプレイ・観戦画面の判定部分（`src/ui/screens/Replay.ts`）
 *
 * DOM は触らない（jsdom 無しで動く）。見るのは
 *   - `06§10` のキー割当（**試合中とキーの意味が変わる**ところ）
 *   - 引数の読み取り（壊れた JSON を渡されても落ちない）
 *   - 表示の文字（時刻・倍速・視点・カードの説明）
 * だけ。DOM を組む部分は目視確認（T 列 = V）に任せる。
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '@/sim/index';
import { REPLAY_VERSION, serializeReplay, type Replay } from '@/replay/format';
import {
  LANE_NAME_WIDTH,
  clockLabel,
  markTitle,
  orderName,
  readReplayParams,
  replayKeyAction,
  scanLabel,
  speedLabel,
  viewerLabel,
} from '@/ui/screens/Replay';

const NO_MODS = { shift: false, ctrl: false, alt: false };

describe('`06§10` のキー割当（試合中とキーの意味が変わる）', () => {
  it('`Space` は再生／一時停止（試合中の「次の警告へ」ではない）', () => {
    expect(replayKeyAction(' ', NO_MODS)).toEqual({ k: 'toggle' });
  });

  it('`←` `→` は前後の「令を出した瞬間」へジャンプ', () => {
    expect(replayKeyAction('ArrowRight', NO_MODS)).toEqual({ k: 'jumpOrder', dir: 1 });
    expect(replayKeyAction('ArrowLeft', NO_MODS)).toEqual({ k: 'jumpOrder', dir: -1 });
  });

  it('`Shift`+`←` `→` は 10 秒ずつ', () => {
    expect(replayKeyAction('ArrowRight', { ...NO_MODS, shift: true })).toEqual({
      k: 'shiftTime',
      dir: 1,
    });
    expect(replayKeyAction('ArrowLeft', { ...NO_MODS, shift: true })).toEqual({
      k: 'shiftTime',
      dir: -1,
    });
  });

  it('`1`〜`6` はその戦域レーンを追いかける。`7` 以降は反応しない', () => {
    for (let n = 1; n <= 6; n++) {
      expect(replayKeyAction(String(n), NO_MODS)).toEqual({ k: 'lane', slot: n });
    }
    expect(replayKeyAction('7', NO_MODS)).toBeNull();
    expect(replayKeyAction('0', NO_MODS)).toBeNull();
  });

  it('`+` `-` は倍速（`=` も `+` として扱う）', () => {
    expect(replayKeyAction('+', NO_MODS)).toEqual({ k: 'speed', dir: 1 });
    expect(replayKeyAction('=', NO_MODS)).toEqual({ k: 'speed', dir: 1 });
    expect(replayKeyAction('-', NO_MODS)).toEqual({ k: 'speed', dir: -1 });
  });

  it('`Tab` は視点の切り替え（観戦）', () => {
    expect(replayKeyAction('Tab', NO_MODS)).toEqual({ k: 'viewer' });
  });

  it('`Ctrl` / `Alt` 付きは何もしない（ブラウザの操作を奪わない）', () => {
    expect(replayKeyAction(' ', { ...NO_MODS, ctrl: true })).toBeNull();
    expect(replayKeyAction('ArrowRight', { ...NO_MODS, alt: true })).toBeNull();
  });

  it('割当の無いキーは null', () => {
    expect(replayKeyAction('q', NO_MODS)).toBeNull();
    expect(replayKeyAction('Escape', NO_MODS)).toBeNull();
  });
});

describe('引数の読み取り', () => {
  const replay: Replay = {
    version: REPLAY_VERSION,
    seed: 1,
    setup: { playerCount: 2, civs: ['yamato', 'mongol'], mapType: 'plain' },
    dataHash: 'abc',
    inputs: [],
    hashes: [],
    endTick: 100,
  };

  it('`replay` をそのまま受け取る', () => {
    expect(readReplayParams({ replay })).toEqual({ replay });
  });

  it('`replayText`（JSON）から読める', () => {
    const p = readReplayParams({ replayText: serializeReplay(replay) });
    expect(p.replay?.endTick).toBe(100);
  });

  it('壊れた JSON でも落ちない（`replay` が無い状態になる）', () => {
    expect(readReplayParams({ replayText: '{壊れている' }).replay).toBeUndefined();
  });

  it('頭出しの tick は 0 以上に丸める（結果画面から来る）', () => {
    expect(readReplayParams({ replay, tick: 1234 }).tick).toBe(1234);
    expect(readReplayParams({ replay, tick: -5 }).tick).toBe(0);
    expect(readReplayParams({ replay, tick: Number.NaN }).tick).toBeUndefined();
  });

  it('観戦の指定を読む', () => {
    expect(readReplayParams({ replay, spectate: true }).spectate).toBe(true);
    expect(readReplayParams({ replay }).spectate).toBeUndefined();
  });
});

describe('表示の文字', () => {
  it('時刻は `mm:ss / mm:ss`', () => {
    expect(clockLabel(0, 45000)).toBe('0:00 / 30:00');
    expect(clockLabel(25 * 83, 45000)).toBe('1:23 / 30:00');
  });

  it('倍速は 0.5 倍と 8 倍で読める形', () => {
    expect(speedLabel(0.5)).toBe('0.5 倍');
    expect(speedLabel(1)).toBe('1 倍');
    expect(speedLabel(8)).toBe('8 倍');
    // 段の外の値も丸めて出す（スライダーの生の値が来ても壊れない）
    expect(speedLabel(2.4)).toBe('2 倍');
  });

  it('視点はプレイヤー番号と文明名', () => {
    expect(viewerLabel(0, ['yamato', 'mongol'])).toBe('P1 ヤマト');
    expect(viewerLabel(1, ['yamato', 'mongol'])).toBe('P2 モンゴル');
    expect(viewerLabel(5, ['yamato'])).toContain('P6');
  });

  it('令の名前は orders.json の name', () => {
    expect(orderName(0)).toBe('突撃');
  });

  it('カードの説明に「出した時刻」と「届いた時刻」とずれの秒数が出る', () => {
    const t = markTitle(0, 'upper', 25 * 60, 25 * 60 + Math.round(2.25 * TICK_RATE));
    expect(t).toContain('突撃');
    expect(t).toContain('出した 1:00');
    expect(t).toContain('届いた');
    // `07§4` の検算値 2.25 秒に対応する遅延。表示は tick 粒度（1 tick = 0.04 秒）なので
    // 56 tick = 2.24 秒になる。**丸めて 2.25 と書かない**（実際に届く tick は 56 後）。
    expect(t).toContain('2.24 秒');
  });

  it('届く前に記録が終わった令はそう書く（黙って 0 秒にしない）', () => {
    expect(markTitle(0, 'upper', 100, -1)).toContain('届く前に記録が終わった');
  });

  it('走査の進捗が出る（タイムラインがどこまで埋まったか）', () => {
    expect(scanLabel(0)).toContain('0%');
    expect(scanLabel(0.5)).toContain('50%');
    expect(scanLabel(1)).toBe('タイムライン: 全区間');
  });

  it('レーン名の列幅は再生ヘッドの位置計算と共有する定数', () => {
    expect(LANE_NAME_WIDTH).toBeGreaterThan(0);
  });
});

describe('mount の中で「初期化前の参照」を作っていない', () => {
  /**
   * ■ なぜこのテストがあるか（実機で起きた不具合）
   * `let lastLaneKey = ''` の宣言が、それを空にする `resize()` の**呼び出しより下**にあった。
   * `resize()` は mount の中で即座に呼ばれるので、毎フレーム
   * `ReferenceError: Cannot access 'lastLaneKey' before initialization` が飛び、
   * **盤面が真っ黒・タイムライン解析 0% のまま**という形で表面化した。
   * 型検査も lint も通ってしまう（TDZ は実行時のみ）ので、ここで並びを固定する。
   *
   * DOM を組まずに検出したいので、ソースの並びを直接見る。
   */
  it('レーン判定キーの宣言が、それを使う関数の呼び出しより前にある', async () => {
    const src = await readFile(
      new URL('../../src/ui/screens/Replay.ts', import.meta.url),
      'utf-8',
    );
    const declare = src.indexOf("let lastLaneKey");
    expect(declare, 'lastLaneKey の宣言が見つからない').toBeGreaterThan(0);
    // mount の中で resize() を即座に呼んでいる箇所（`resize();` の単独行）
    const call = src.indexOf('\n    resize();');
    expect(call, 'resize() の即時呼び出しが見つからない').toBeGreaterThan(0);
    expect(declare).toBeLessThan(call);
  });
});
