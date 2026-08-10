/**
 * sim/core/sight.ts — エンティティ 1 体の**実効視界**（研究の効果を含む）
 *
 * ■ なぜこのファイルを作ったか
 * 視界を必要とするのは 2 か所ある:
 *  - `render/vision.ts` … 画面の霧（`05§14`）
 *  - `ai/view.ts` … AI に見せる範囲（`07§11`。**ここが視界より広いと AI がズルをする**）
 * 両方が `buildingDef(...).sight` を**直に読んでいた**ため、研究「測量」（建物の視界 +4）が
 * どちらにも効かなかった（`docs/ISSUES.md` の「効果適用エンジンが未結線」の 1 件）。
 *
 * 直すときに片方だけ直すと**画面と AI の視界がずれる**。ずれた側が広ければズルになり、
 * 狭ければ「見えているのに AI が反応しない」ことになる。
 * どちらも起きないよう、**視界の求め方をここ 1 か所に集める**。
 *
 * ■ なぜ sim に置くのか（render でも ai でもなく）
 * `sim` は render/ui/input/ai/net/replay を import できない（ESLint で禁止）。
 * 逆向きは許されているので、**両方から呼べる位置は sim だけ**。
 * 視界そのものは（いまは）試合結果に影響しないが、置き場所としてここが唯一成立する。
 */

import { EntityKind } from '@/shared/types';
import type { PlayerId } from '@/shared/types';
import { buildingDef, unitDef } from './defs';
import type { Fx } from './fx';
import { buildingSightAdd, getPlayerModifiers } from './effects';
import type { World } from './world';

/**
 * エンティティ 1 体の実効視界（Fx。マス単位）。視界を持たないものは 0。
 *
 * - ユニット … `units.json` の `sight` そのまま（ユニットの視界を変える効果はいまは無い）
 * - 建物・付属物 … `buildings.json` の `sight` ＋ 研究の加算（測量 +4）
 *
 * **未完成の建物も視界を持つ**扱いにしている（`render/vision.ts` の既存の挙動を変えないため。
 * 建てかけの足場が見えないと、自分が建てている場所が霧に隠れる）。
 * 完成しているかで分けたい呼び出し側は、呼ぶ前に自分で判定すること
 * ―― `ai/view.ts` は実際にそうしている（未完成の建物は視界に数えない）。
 */
export function entitySightFx(w: World, i: number): Fx {
  const e = w.entities;
  const kind = e.kind[i]!;
  if (kind === EntityKind.Unit) return unitDef(e.typeId[i]!).sight;
  if (kind !== EntityKind.Building && kind !== EntityKind.Attachment) return 0;

  const base = buildingDef(e.typeId[i]!).sight;
  if (base <= 0) return 0; // 視界を持たない建物（壁・敷設物）に加算しても意味がない
  const owner = e.owner[i]!;
  if (owner >= w.playerCount) return base; // 中立の建物に効果の持ち主はいない
  const add = buildingSightAdd(getPlayerModifiers(w, owner as PlayerId));
  const r = base + add;
  return r > 0 ? r : 0;
}
