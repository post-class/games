/**
 * 噂の報告（docs/02_ゲーム実装プラン/07_ペットAI設計.md §5.2）
 *
 * 宣伝資料の「今日ミズネがこんなこと言ってたよ」を成立させる部分。
 *
 * ペットが不在中に他のペットから聞いた話（`pet_memory` の kind='gossip'）を、
 * オーナーが戻ってきたときに**優先して**話題にする。
 *
 * ここではLLMを呼ばない。「まだ報告していない噂」を選ぶだけで、
 * 実際の言い方は会話プロンプト（`buildDialoguePrompt` の思い出ブロック）に任せる。
 * ログイン直後に待たせないための判断。
 */
import { LLM, type PetGoal } from '@ai-pet/shared';
import type { PetRepo } from '../db/petRepo.ts';
import type { MemoryRecord } from './memory.ts';

/** 一度に報告する噂の数（多いと「報告会」になってしまう） */
const MAX_REPORT = 2;
/** 何島日前までの噂を報告対象にするか */
const REPORT_WITHIN_ISLAND_DAYS = 3;

export interface GossipReport {
  petId: number;
  /** 報告する噂（新しい順） */
  items: MemoryRecord[];
  /** 吹き出しやチャットに出す1文（報告のきっかけ） */
  line: string;
}

/** ペットが「まだ話していない噂」を持っているか */
export class GossipReporter {
  private repo: PetRepo;
  /** 報告済みの記憶ID（プロセス内。再起動でリセットされるが二重報告しても害はない） */
  private reported = new Set<number>();
  private counters = { reports: 0, items: 0 };

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(repo: PetRepo) {
    this.repo = repo;
  }

  /**
   * 未報告の噂を取り出す。無ければ null。
   * 取り出した時点で「報告済み」にするので、同じ噂を何度も言わない。
   */
  take(petId: number, currentIslandDay: number, petName: string): GossipReport | null {
    const all = this.repo.recentMemories(petId, { kinds: ['gossip'], limit: 20 });
    const fresh = all.filter(
      (m) =>
        typeof m.id === 'number' &&
        !this.reported.has(m.id) &&
        currentIslandDay - m.islandDay <= REPORT_WITHIN_ISLAND_DAYS,
    );
    if (fresh.length === 0) return null;

    const items = fresh.slice(0, MAX_REPORT);
    for (const m of items) if (typeof m.id === 'number') this.reported.add(m.id);

    this.counters.reports++;
    this.counters.items += items.length;

    return { petId, items, line: reportLine(petName, items.length) };
  }

  /** まだ報告していない噂があるか（会話の話題選びに使う） */
  hasPending(petId: number, currentIslandDay: number): boolean {
    const all = this.repo.recentMemories(petId, { kinds: ['gossip'], limit: 20 });
    return all.some(
      (m) =>
        typeof m.id === 'number' &&
        !this.reported.has(m.id) &&
        currentIslandDay - m.islandDay <= REPORT_WITHIN_ISLAND_DAYS,
    );
  }

  /**
   * 会話のときにプロンプトへ混ぜる噂（報告済みにはしない）。
   * 「聞いた話をしたがる」性質を、記憶の検索結果に上乗せして表現する。
   */
  pendingForPrompt(petId: number, currentIslandDay: number): MemoryRecord[] {
    const all = this.repo.recentMemories(petId, { kinds: ['gossip'], limit: 10 });
    return all
      .filter((m) => currentIslandDay - m.islandDay <= REPORT_WITHIN_ISLAND_DAYS)
      .slice(0, Math.min(2, LLM.maxMemories));
  }

  /** ペットが自分から話しかけたくなる目標（噂があるとき） */
  suggestedGoal(): PetGoal {
    return 'follow_owner';
  }

  stats(): Record<string, unknown> {
    return { ...this.counters, remembered: this.reported.size };
  }
}

/** 報告のきっかけになる1文。ペット名を主語にする */
function reportLine(petName: string, count: number): string {
  return count >= 2 ? `${petName}「きのう聞いた話、ふたつあるよ」` : `${petName}「きのう聞いた話があるんだ」`;
}
