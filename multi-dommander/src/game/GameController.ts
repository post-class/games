import type { Game } from "./Game";
import type { GameStateData } from "./GameState";
import type { MissionManager } from "./mission/MissionManager";
import type { MissionScreens } from "./ui/MissionScreens";
import type { ExplosionSystem } from "./systems/ExplosionSystem";
import { MISSIONS, MISSION_ORDER, CAMPAIGN } from "./mission/missions";
import { SaveManager } from "./SaveManager";
import { DIFFICULTIES, SettingsStore, type Difficulty } from "./Settings";

/** 難易度を保持する可変ホルダ (設定画面で更新)。 */
export interface SettingsHolder {
  difficulty: Difficulty;
}

/**
 * ゲーム全体の進行を統括する。
 * タイトル → ブリーフィング → 出撃(Playing) → デブリーフ → 分岐 のフロー管理。
 * キャンペーンは分岐グラフ (CAMPAIGN) に従い、進捗を localStorage に保存する。
 */
export class GameController {
  private currentMissionId = CAMPAIGN.start;
  private totalKills = 0;
  private cleared: string[] = [];

  constructor(
    private readonly game: Game,
    private readonly state: GameStateData,
    private readonly mission: MissionManager,
    private readonly screens: MissionScreens,
    private readonly explosions: ExplosionSystem,
    private readonly settings: SettingsHolder,
  ) {}

  /** 起動時: 「開始 / 設定」のトップメニューを表示。 */
  start(): void {
    this.showMainMenu();
  }

  private showMainMenu(): void {
    this.state.phase = "Menu";
    this.screens.showMainMenu(
      DIFFICULTIES[this.settings.difficulty].label,
      () => this.onStart(),
      () => this.openSettings(),
    );
  }

  /** 「開始」選択時。セーブがあれば「続きから / 最初から」を提示。 */
  private onStart(): void {
    const save = SaveManager.load();
    if (save !== null) {
      this.screens.showTitle(
        true,
        () => this.continueFromSave(),
        () => this.beginNewCampaign(),
      );
    } else {
      this.beginNewCampaign();
    }
  }

  /** 「設定」選択時。難易度変更は即 localStorage に保存し、戻るとメニューへ。 */
  private openSettings(): void {
    this.screens.showSettings(
      this.settings.difficulty,
      (d) => {
        this.settings.difficulty = d;
        SettingsStore.save(d);
      },
      () => this.showMainMenu(),
    );
  }

  private beginNewCampaign(): void {
    SaveManager.clear();
    this.currentMissionId = CAMPAIGN.start;
    this.totalKills = 0;
    this.cleared = [];
    this.toBriefing();
  }

  private continueFromSave(): void {
    const save = SaveManager.load();
    if (!save || !MISSIONS[save.missionId]) {
      this.beginNewCampaign();
      return;
    }
    this.currentMissionId = save.missionId;
    this.totalKills = save.totalKills;
    this.cleared = save.cleared ?? [];
    this.toBriefing();
  }

  private toBriefing(): void {
    // 前ミッションの残存エンティティ・エフェクトを一掃。
    this.mission.dispose();
    this.explosions.reset();
    this.state.phase = "Briefing";
    this.state.result = null;
    this.state.resultText = "";
    this.state.kills = 0;

    // 進捗を保存 (次に開始するミッションを記録)。
    SaveManager.save({
      missionId: this.currentMissionId,
      totalKills: this.totalKills,
      cleared: this.cleared,
      updatedAt: this.game.simTime,
    });

    const def = MISSIONS[this.currentMissionId];
    const index = Math.max(0, MISSION_ORDER.indexOf(this.currentMissionId as never));
    this.screens.showBriefing(def, index, MISSION_ORDER.length, () => this.launch());
  }

  private launch(): void {
    const def = MISSIONS[this.currentMissionId];
    this.state.kills = 0;
    this.mission.load(def, this.game.simTime, DIFFICULTIES[this.settings.difficulty]);
    this.state.phase = "Playing";
    this.screens.hide();
  }

  /** MissionSystem から勝敗確定時に呼ばれる (phase は既に Debrief)。 */
  onMissionEnd(result: "success" | "failure"): void {
    const node = CAMPAIGN.nodes[this.currentMissionId];
    const next = result === "success" ? node.success : node.failure;
    const label =
      result === "failure"
        ? "再挑戦"
        : next === null
          ? "キャンペーン完了"
          : "次のミッションへ";
    this.screens.showDebrief(
      result,
      this.state.resultText,
      this.state.kills,
      this.mission.objectives,
      () => this.proceed(result, next),
      label,
    );
  }

  private proceed(result: "success" | "failure", next: string | "retry" | null): void {
    if (result === "success") {
      this.totalKills += this.state.kills;
      if (!this.cleared.includes(this.currentMissionId)) this.cleared.push(this.currentMissionId);
      if (next === null) {
        // キャンペーン完全クリア。
        SaveManager.clear();
        this.mission.dispose();
        this.explosions.reset();
        this.state.phase = "Menu";
        this.screens.showCampaignComplete(this.totalKills, () => this.showMainMenu());
        return;
      }
    }
    // 遷移先を決定 (retry または指定ID)。失敗で next===null の場合も retry 扱い。
    if (next === null || next === "retry") {
      // 同ミッションを再挑戦 (currentMissionId 据え置き)。
    } else {
      this.currentMissionId = next;
    }
    this.toBriefing();
  }
}
