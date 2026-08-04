import { ACTION_DURATION_MS, type PetAction } from '../../shared/actions.js';
import type { Needs, PetView } from '../../shared/types.js';
import type { Personality } from '../../shared/personality.js';

/**
 * ペットの自律行動。
 *
 * LLM を毎秒叩くのは高コストで不安定なので、
 * 見た目の動きは決定論的な FSM で回し、LLM は低頻度の「思いつき」だけに使う。
 * 行動の選択はニーズ・性格・時刻から重み付き抽選する。
 */

interface Candidate {
  action: PetAction;
  weight: number;
}

/** 各行動の素点。ニーズが低いほど、その解決行動が選ばれやすい。 */
export function candidates(needs: Needs, personality: Personality, hour: number): Candidate[] {
  const lack = (value: number) => Math.max(0, (60 - value) / 60); // 0〜1
  const night = hour >= 22 || hour < 6;

  const list: Candidate[] = [
    { action: 'idle', weight: 1 },
    { action: 'walk', weight: 0.8 + (personality.energy / 100) * 1.6 },
    { action: 'nap', weight: 0.2 + lack(needs.energy) * 4 + (night ? 2.5 : 0) },
    { action: 'play', weight: lack(needs.fun) * 3 + (personality.energy / 100) * 0.8 },
    { action: 'wash', weight: lack(needs.clean) * 2 },
    { action: 'stare_owner', weight: lack(needs.hunger) * 3 + (personality.clingy / 100) * 1.2 },
    { action: 'nuzzle', weight: (personality.clingy / 100) * 1.8 * (needs.mood / 100) },
    { action: 'peek_window', weight: 0.6 + (personality.social / 100) * 1.4 },
    { action: 'hide_item', weight: (personality.mischief / 100) * 1.8 },
    { action: 'daydream', weight: 0.4 + (personality.clever / 100) * 1.2 },
    { action: 'tidy_room', weight: (1 - personality.mischief / 100) * 0.8 },
    { action: 'sulk_corner', weight: needs.mood < 25 ? 4 : 0 },
    { action: 'jump_joy', weight: needs.mood > 80 && needs.fun > 60 ? 1.5 : 0 },
  ];

  // 臆病な子は外を覗いたり跳ねたりしにくい。
  const timidity = personality.timid / 100;
  for (const candidate of list) {
    if (candidate.action === 'peek_window' || candidate.action === 'jump_joy') {
      candidate.weight *= 1 - timidity * 0.7;
    }
  }
  return list.filter((candidate) => candidate.weight > 0);
}

export function pickAction(
  needs: Needs,
  personality: Personality,
  hour: number,
  rand: () => number = Math.random,
): PetAction {
  const list = candidates(needs, personality, hour);
  const total = list.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = rand() * total;
  for (const candidate of list) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.action;
  }
  return 'idle';
}

export interface FsmState {
  action: PetAction;
  /** 現在の行動が終わる時刻（performance.now 基準）。 */
  until: number;
  /** 歩行の目標位置（0〜1 の横位置）。 */
  targetX: number;
  x: number;
  facing: 1 | -1;
}

export function initialFsm(now: number): FsmState {
  return { action: 'idle', until: now + 2000, targetX: 0.5, x: 0.5, facing: 1 };
}

/** たまごは動かない。 */
function allowedForStage(action: PetAction, pet: PetView): PetAction {
  if (pet.stage === 'egg') return 'idle';
  return action;
}

export interface FsmUpdate {
  state: FsmState;
  /** この更新で行動が切り替わったか。 */
  changed: boolean;
}

export function updateFsm(
  state: FsmState,
  pet: PetView,
  now: number,
  deltaMs: number,
  rand: () => number = Math.random,
): FsmUpdate {
  let changed = false;
  const next = { ...state };

  if (now >= state.until) {
    const hour = new Date().getHours();
    const action = allowedForStage(pickAction(pet.needs, pet.personality, hour, rand), pet);
    next.action = action;
    next.until = now + ACTION_DURATION_MS[action] * (0.75 + rand() * 0.5);
    if (action === 'walk') {
      next.targetX = 0.18 + rand() * 0.64;
    } else if (action === 'sulk_corner') {
      next.targetX = rand() < 0.5 ? 0.12 : 0.88;
    }
    changed = true;
  }

  // 歩行・移動。目標へゆっくり近づく。
  const moving = next.action === 'walk' || next.action === 'sulk_corner';
  if (moving) {
    const speed = (next.action === 'walk' ? 0.00011 : 0.00007) * deltaMs;
    const diff = next.targetX - next.x;
    if (Math.abs(diff) > 0.004) {
      next.x += Math.sign(diff) * Math.min(Math.abs(diff), speed);
      next.facing = diff > 0 ? 1 : -1;
    }
  }

  return { state: next, changed };
}

/** 外部（LLM の思いつき・世話の反応）から行動を差し込む。 */
export function forceAction(
  state: FsmState,
  action: PetAction,
  now: number,
  rand: () => number = Math.random,
): FsmState {
  const next = { ...state, action, until: now + ACTION_DURATION_MS[action] };
  if (action === 'walk') next.targetX = 0.18 + rand() * 0.64;
  if (action === 'sulk_corner') next.targetX = rand() < 0.5 ? 0.12 : 0.88;
  return next;
}
