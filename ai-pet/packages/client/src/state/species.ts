/**
 * アセット名と種の対応（Pixi非依存）。
 *
 * `species` の値とアセットファイル名の `name` を一致させる約束（docs 08章 §4）なので、
 * 種のリストは描画とテストの両方から参照できるここに置く。
 * サーバ側で動物住民の種が確定したら、値を shared へ移してもよい。
 */
import { PET_SPECIES } from '@ai-pet/shared';

/** 動物住民6種（docs 01章 §2.2「うさぎ／ねこ／とり／かえる／りす／いのしし」） */
export const CRITTER_SPECIES: readonly string[] = ['rabbit', 'cat', 'bird', 'frog', 'squirrel', 'boar'];

/** 4方向 */
export const DIRS = ['n', 'e', 's', 'w'] as const;

/**
 * プレイヤーのアバター4色（D-5）。`Actor.species` にこの文字が入って届く。
 *
 * 色の割り当ては `a`=紫 / `b`=緑 / `c`=桃 / `d`=黄（本番アセットの服の色と一致させている）。
 * `a` が既定色なので、**新しい色を足すときは末尾に足す**（既存プレイヤーの見た目が変わらない）。
 */
export const PLAYER_SPECIES: readonly string[] = ['a', 'b', 'c', 'd'];

/**
 * 未知の `species` が来たときのプレイヤーの色。
 * 4色化より前に作られたプレイヤーは `species` が空文字なので、**壊れずに `a` で描く**。
 */
export const DEFAULT_PLAYER_SPECIES = 'a';

/** プレイヤーの `species` を4色のどれかに正規化する（空文字・未知の値は `a`） */
export function normalizePlayerSpecies(species: string | null | undefined): string {
  return species && PLAYER_SPECIES.includes(species) ? species : DEFAULT_PLAYER_SPECIES;
}

/** キャラアセットの prefix 一覧（player / pet / critter） */
export function charPrefixes(): string[] {
  return [
    ...PLAYER_SPECIES.map((s) => `player_${s}`),
    ...PET_SPECIES.map((s) => `pet_${s}`),
    ...CRITTER_SPECIES.map((s) => `critter_${s}`),
  ];
}

/**
 * 睡眠ポーズ（`<kind>_<species>_sleep.png`）を持つ prefix 一覧（D-3）。
 *
 * 丸まった絵なので方向はない。**プレイヤーは含めない**
 * （操作中のアバターに `sleep` は来ないので、11枚で足りる）。
 */
export function sleepPrefixes(): string[] {
  return [...PET_SPECIES.map((s) => `pet_${s}`), ...CRITTER_SPECIES.map((s) => `critter_${s}`)];
}
