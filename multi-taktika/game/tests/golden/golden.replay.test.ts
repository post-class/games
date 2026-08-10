/**
 * T-M15-06: ゴールデンリプレイ回帰テスト（手順書 §14.1 / §14.3）
 *
 * ■ 何を守るのか
 * 「代表試合の `.mtr` + 期待ハッシュを CI で毎回検証。
 *   **バランス調整以外の変更で壊れたら即バグ**」（§14.1）。
 * 決定論テストは「同じ入力なら同じ結果」しか見ないので、
 * **結果が変わったこと自体**はここでしか捕まらない。
 *
 * ■ 落ちたときの読み方（`npm run golden:rebase` を打つ前に必ず読む）
 *   1. `dataHash` が違う  → `src/data/*.json` を変えた。**バランス調整なら rebase してよい**
 *   2. `dataHash` は同じでハッシュが違う → **ロジックが変わった。rebase してはいけない**（バグ）
 *   3. 入力列が違う → シナリオのコードか、コマンドの解釈が変わった
 * 2 を黙って rebase すると、以後どんな回帰も検出できなくなる。
 *
 * ■ rebase の手順（§14.3）
 *   1. 変更前に `npm run test:golden` が緑であることを確認
 *   2. JSON を変更
 *   3. `npm run golden:rebase`（= `GOLDEN_REBASE=1 vitest run tests/golden`）
 *   4. コミットメッセージに `[rebase-golden]` を付け、**何をどう変えたか**を本文に書く
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPLAY_VERSION, checkReplay, parseReplay, serializeReplay } from '@/replay/format';
import type { Replay } from '@/replay/format';
import { dataHash } from '@/data/hash';
import { GOLDEN_SCENARIOS, recordScenario, replayScenario, type GoldenScenario } from './scenarios';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `GOLDEN_REBASE=1` で期待値を作り直す（`npm run golden:rebase`）。 */
const REBASE = process.env['GOLDEN_REBASE'] === '1';

function fixturePath(sc: GoldenScenario): string {
  return join(HERE, 'fixtures', `${sc.id}.mtr.json`);
}

function readFixture(sc: GoldenScenario): Replay | null {
  const path = fixturePath(sc);
  if (!existsSync(path)) return null;
  return parseReplay(readFileSync(path, 'utf8'));
}

function writeFixture(sc: GoldenScenario, replay: Replay): void {
  const path = fixturePath(sc);
  mkdirSync(dirname(path), { recursive: true });
  // `.mtr` は JSON + gzip（`07§12`）。テストの固定値は読めるように非圧縮で置く。
  writeFileSync(path, `${serializeReplay(replay)}\n`, 'utf8');
  console.log(`[golden] ${sc.id} の期待値を書き直した: ${path}`);
}

/** rebase を促すメッセージ（**黙って落ちるだけにしない**。§14.3）。 */
function rebaseMessage(sc: GoldenScenario, fixture: Replay): string {
  return [
    `ゴールデンリプレイ「${sc.id}」（${sc.what}）が記録時と違うデータで走っています。`,
    `  記録時の dataHash: ${fixture.dataHash}`,
    `  今の   dataHash: ${dataHash()}`,
    'src/data/*.json が変わっています。**バランス調整でこれが起きたのなら**',
    '`npm run golden:rebase` で期待値を作り直し、コミットメッセージに [rebase-golden] を付けてください（手順書 §14.3）。',
    'データを変えていないのにこれが出た場合は、データの読み込み順かキー順が変わっています（バグ）。',
  ].join('\n');
}

describe('T-M15-06: ゴールデンリプレイ（代表 3 試合を CI で毎回検証する）', () => {
  it('代表試合は 3 本ある（内政だけ / 戦域と令 / 8 人戦）', () => {
    expect(GOLDEN_SCENARIOS.map((s) => s.id)).toEqual(['econ-2p', 'fronts-2p', 'eight-8p']);
    expect(GOLDEN_SCENARIOS.some((s) => s.setup.playerCount === 8)).toBe(true);
  });

  for (const sc of GOLDEN_SCENARIOS) {
    describe(`${sc.id}: ${sc.what}`, () => {
      const fixture = readFixture(sc);

      if (fixture === null || REBASE) {
        // 期待値が無い（初回）か rebase 指定。**作って終わる**（緑にはしない用途）。
        it('期待値を作る（固定ファイルが無い / GOLDEN_REBASE=1）', () => {
          const fresh = recordScenario(sc);
          writeFixture(sc, fresh);
          expect(fresh.hashes.length).toBeGreaterThan(0);
        });
        return;
      }

      it('固定した `.mtr` が今のビルドで再生できる（形式とデータの指紋が合う）', () => {
        expect(fixture.version).toBe(REPLAY_VERSION);
        const check = checkReplay(fixture, dataHash());
        if (!check.ok && check.reason.kind === 'dataHash') {
          throw new Error(rebaseMessage(sc, fixture));
        }
        expect(check).toEqual({ ok: true });
      });

      it('固定した入力列が、シナリオから作られる入力列と一致する', () => {
        const fresh = recordScenario(sc);
        expect(
          fresh.inputs,
          `入力列が変わった（シナリオのコードか Command の扱いが変わった）: ${sc.id}`,
        ).toEqual(fixture.inputs);
        // 記録側のハッシュ列も同じであること（= 今のロジックで同じ試合になる）
        expect(
          fresh.hashes,
          [
            `ハッシュ列が変わった: ${sc.id}（${sc.what}）`,
            fixture.dataHash === dataHash()
              ? 'データは変わっていないのに結果が変わっています。**ロジックの回帰です。rebase してはいけません。**'
              : rebaseMessage(sc, fixture),
          ].join('\n'),
        ).toEqual(fixture.hashes);
      });

      it('固定した入力列を再生すると、固定した期待ハッシュに一致する', () => {
        const back = replayScenario(sc, fixture);
        expect(back.length, 'ハッシュを 1 つも突き合わせていない（テストが空回りしている）')
          .toBeGreaterThan(0);
        expect(back).toEqual(fixture.hashes.map((h) => ({ tick: h.tick, hash: h.hash })));
      });

      it('入力を取り除くと落ちる（この検証が効いている証明）', () => {
        if (fixture.inputs.length === 0) return; // 入力の無いシナリオは対象外
        // ■ 改ざんの仕方を一度変えている
        // 元は「最初の入力を 1 tick ずらす」形だった。これは**効かない場合がある**
        // ―― ずらした先でも同じ結果になると（令が両方とも入力段で弾かれる、
        // 同じ令を出し直しているなど）ハッシュが変わらず落ちる。実際に落ちた。
        //
        // いまは「**記録した入力を全部取り除く**」形。固定したハッシュは
        // 入力ありの試合のものなので、入力なしの試合とは必ず違う。
        // 見たいこと（＝この検証が入力に反応している）はこれで示せる。
        const tampered: Replay = { ...fixture, inputs: [] };
        const back = replayScenario(sc, tampered);
        expect(back).not.toEqual(fixture.hashes.map((h) => ({ tick: h.tick, hash: h.hash })));
      });
    });
  }
});
