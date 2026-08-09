/**
 * 試合中のメニューの検証（`06§11` の F10 / Pause）。
 *
 * ■ なぜ後から足したか
 * `06§11` の操作表に `F10 メニュー（設定・投了・退出）` と `Pause 一時停止` があるのに
 * どちらも実装されていなかった。とくに**投了は `03§10` の勝敗 3 通りのうちの 1 つ**
 * （服属）で、押す手段が無いと負け方が 1 つ足りず、キャンペーンの服属ルートにも入れない。
 *
 * DOM は触らない（判断は 3 つの純関数に出してある）。
 */

import { describe, expect, it } from 'vitest';
import { canPause, gameMenuKeyAction, pauseLabel } from '@/ui/hud/gameMenu';

describe('キー割当（`06§11` の表そのまま）', () => {
  it('F10 でメニューを開閉する', () => {
    expect(gameMenuKeyAction('F10', false)).toBe('toggleMenu');
    expect(gameMenuKeyAction('F10', true)).toBe('toggleMenu');
  });

  it('Pause で一時停止する', () => {
    expect(gameMenuKeyAction('Pause', false)).toBe('togglePause');
  });

  it('Esc はメニューが開いているときだけ拾う（他のパネルの Esc を奪わない）', () => {
    // 開いていれば閉じる
    expect(gameMenuKeyAction('Escape', true)).toBe('close');
    // 開いていなければ**何もしない** ―― `06§4` の「Esc はパネルを閉じる」を
    // このメニューが横取りすると、情報パネルや令カードが閉じられなくなる。
    expect(gameMenuKeyAction('Escape', false)).toBeNull();
  });

  it('関係ないキーは拾わない', () => {
    for (const k of ['a', '1', 'Tab', ' ', 'F11', 'F12', 'Enter']) {
      expect(gameMenuKeyAction(k, true), `${k} を拾ってしまっている`).toBeNull();
    }
  });
});

describe('一時停止（オンラインでは効かない）', () => {
  it('単独プレイでは止められる', () => {
    expect(canPause(false)).toBe(true);
  });

  it('オンライン対戦では止められない', () => {
    // ロックステップは全端末が同じ tick を同じ順で進める前提なので、
    // 1 人が止めれば全員が止まる（＝止めた人が有利になる）。
    expect(canPause(true)).toBe(false);
  });

  it('表示は「なぜ押せないか」まで言う（暗いボタンだけにしない）', () => {
    expect(pauseLabel(false, true)).toContain('オンライン');
    expect(pauseLabel(false, false)).toBe('一時停止');
    expect(pauseLabel(true, false)).toBe('再開する');
  });
});
