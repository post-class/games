/**
 * ui/hud/commandGrid.ts — コマンドグリッド（`05§6-9` / `05§9`。T-M5-06）
 *
 * 「3 段 12 ボタンで、キー `QWER` / `ASDF` / `ZXCV` と**並びが一対一**」（`05§9`）。
 * 選択対象で中身が丸ごと入れ替わる（`05§9`「この 1 か所が内政のすべてを担う」）。
 *
 * 暗いボタンの理由は 3 種（`05§9`）:
 *   時代不足 / 資源不足 / その文明が持てない
 * 資源不足のときは**足りない資源だけ**を返す（HUD がアイコンを赤くする）。
 *
 * ここは「何ができるか」を並べるだけで、World は読むだけ。
 * 実際の変更は返した `Command` を `emit` したときに sim が行う。
 */

import { RESOURCE_IDS, type EntityId, type PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import {
  BUILDING_DEFS,
  buildingDef,
  canCivBuild,
  canCivResearch,
  resolveBuildingForCiv,
  techDefById,
  unitDefById,
} from '@/sim/core/defs';
import { resolveIndex } from '@/sim/core/entity';
import { isVillagerIndex } from '@/sim/core/gather';
import type { World } from '@/sim/core/world';
import { getPlayer } from '@/sim/core/world';

/** グリッドのキー配列（`05§9` の QWER / ASDF / ZXCV）。 */
export const GRID_KEYS: readonly string[] = [
  'Q',
  'W',
  'E',
  'R',
  'A',
  'S',
  'D',
  'F',
  'Z',
  'X',
  'C',
  'V',
];

/** ボタンが押せない理由（`05§9` の 3 種）。 */
export const DisabledReason = {
  None: '',
  Age: '時代が足りない',
  Resource: '資源が足りない',
  Civ: 'この文明は持てない',
} as const;
export type DisabledReasonId = (typeof DisabledReason)[keyof typeof DisabledReason];

/** グリッド 1 ボタン。 */
export interface GridButton {
  /** 対応キー（`GRID_KEYS`）。 */
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason: DisabledReasonId;
  /** 足りない資源の index（`RESOURCE_IDS` 順）。 */
  readonly lacking: readonly number[];
  /** 押したときに送る Command。null なら「置くモード」に入る（`building` を見る）。 */
  readonly command: Command | null;
  /** 建設したい建物 ID（`placeBuilding` は位置が必要なので、クリック後に決める）。 */
  readonly building: string | null;
  /** ツールチップ（コストと効果）。 */
  readonly hint: string;
}

/** コストを払えるか調べ、足りない資源の index を返す。 */
function lackingResources(w: World, p: PlayerId, cost: Int32Array): number[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const out: number[] = [];
  for (let r = 0; r < cost.length; r++) {
    if (pl.resources[r]! < cost[r]!) out.push(r);
  }
  return out;
}

/** コストを「食 100 / 木 50」のような文字列にする。 */
function costText(cost: Int32Array): string {
  const parts: string[] = [];
  for (let r = 0; r < cost.length; r++) {
    if (cost[r]! <= 0) continue;
    parts.push(`${RESOURCE_IDS[r] === 'food' ? '食' : RESOURCE_IDS[r] === 'wood' ? '木' : RESOURCE_IDS[r] === 'stone' ? '石' : '金'}${Math.round(cost[r]! / 256)}`);
  }
  return parts.join(' / ');
}

/**
 * 選択対象からグリッドを作る（最大 12 件）。
 *
 * - 建物を選んでいる: 生産できるユニット → 研究 → 時代進化
 * - 村人を選んでいる: 今の時代に建てられる建物（クリック後に位置を指定する）
 * - それ以外: 空
 */
export function buildCommandGrid(
  w: World,
  viewer: PlayerId,
  selected: readonly EntityId[],
): GridButton[] {
  const pl = getPlayer(w, viewer);
  if (pl === undefined || selected.length === 0) return [];
  const e = w.entities;
  const head = selected[0]!;
  const i = resolveIndex(e, head);
  if (i < 0) return [];

  const out: GridButton[] = [];
  const push = (b: Omit<GridButton, 'key'>): void => {
    if (out.length >= GRID_KEYS.length) return;
    out.push({ ...b, key: GRID_KEYS[out.length]! });
  };

  // ---- 村人: 建設一覧 ---------------------------------------------------
  if (isVillagerIndex(e, i)) {
    for (const def of BUILDING_DEFS) {
      if (!def.buildable) continue;
      if (def.civ !== null && def.civ !== pl.civ) continue;
      // 文明置換（例: モンゴルの城 = 大天幕）を解決し、置換元は出さない
      const resolved = resolveBuildingForCiv(pl.civ, def.id);
      if (resolved === null) continue;
      if (resolved !== def.id) continue;
      if (!canCivBuild(pl.civ, def.id)) continue;
      const lacking = lackingResources(w, viewer, def.cost);
      const ageOk = def.age <= pl.age;
      push({
        label: def.name,
        enabled: ageOk && lacking.length === 0,
        reason: !ageOk
          ? DisabledReason.Age
          : lacking.length > 0
            ? DisabledReason.Resource
            : DisabledReason.None,
        lacking,
        command: null,
        building: def.id,
        hint: `${def.name}（${costText(def.cost)}）— クリックしてから地面をクリックで建設`,
      });
      if (out.length >= GRID_KEYS.length) break;
    }
    return out;
  }

  // ---- 建物: 生産・研究・時代進化 ---------------------------------------
  const bdef = buildingDef(e.typeId[i]!);
  if (e.owner[i] !== viewer) return [];

  for (const unitId of bdef.produces) {
    let udef;
    try {
      udef = unitDefById(unitId);
    } catch {
      continue; // データ差し替えで消えた ID は黙って飛ばす
    }
    if (udef.civ !== null && udef.civ !== pl.civ) continue;
    const lacking = lackingResources(w, viewer, udef.cost);
    const ageOk = udef.age <= pl.age;
    push({
      label: udef.name,
      enabled: ageOk && lacking.length === 0,
      reason: !ageOk
        ? DisabledReason.Age
        : lacking.length > 0
          ? DisabledReason.Resource
          : DisabledReason.None,
      lacking,
      command: { t: 'produce', p: viewer, building: head, unit: unitId, count: 1 },
      building: null,
      hint: `${udef.name}（${costText(udef.cost)}）`,
    });
  }

  for (const techId of bdef.researches) {
    let tdef;
    try {
      tdef = techDefById(techId);
    } catch {
      continue;
    }
    if (!canCivResearch(pl.civ, techId)) continue;
    if (pl.researched[tdef.index] === 1) continue;
    const lacking = lackingResources(w, viewer, tdef.cost);
    const ageOk = tdef.age <= pl.age;
    push({
      label: tdef.name,
      enabled: ageOk && lacking.length === 0,
      reason: !ageOk
        ? DisabledReason.Age
        : lacking.length > 0
          ? DisabledReason.Resource
          : DisabledReason.None,
      lacking,
      command: { t: 'research', p: viewer, building: head, tech: techId },
      building: null,
      hint: `研究: ${tdef.name}（${costText(tdef.cost)}）`,
    });
  }

  // 時代進化（町の中心 = `canAdvanceAge`。`buildings.json` の値で判定する）
  if (bdef.lossCausesDefeat && pl.age < 3) {
    push({
      label: '時代進化',
      enabled: true,
      reason: DisabledReason.None,
      lacking: [],
      command: { t: 'advanceAge', p: viewer, building: head },
      building: null,
      hint: '次の時代へ（戦域スロットが増える）',
    });
  }
  return out;
}
