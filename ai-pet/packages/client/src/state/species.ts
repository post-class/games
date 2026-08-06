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

/** キャラアセットの prefix 一覧（player / pet / critter） */
export function charPrefixes(): string[] {
  return ['player_a', ...PET_SPECIES.map((s) => `pet_${s}`), ...CRITTER_SPECIES.map((s) => `critter_${s}`)];
}
