import type { Game } from "./Game";
import type { GameStateData } from "./GameState";
import type { MissionManager } from "./mission/MissionManager";
import type { MissionScreens } from "./ui/MissionScreens";
import type { ExplosionSystem } from "./systems/ExplosionSystem";
import type { InputManager, FlightAxes, DiscreteActions, EdgeActions } from "./input/InputManager";
import type { AudioManager } from "./AudioManager";
import { MISSIONS, MISSION_ORDER, CAMPAIGN, TUTORIAL_MISSION, TUTORIAL_MODS } from "./mission/missions";
import { SaveManager } from "./SaveManager";
import { DIFFICULTIES, SettingsStoreV2, type Difficulty, type GameSettingsV2 } from "./Settings";
import type { LoadoutChoice } from "./ui/LoadoutScreen";
import { TutorialManager } from "./tutorial/TutorialManager";

/** 難易度・状況ヒント設定を保持する可変ホルダ (設定画面で更新、HintSystem等が参照)。 */
export interface SettingsHolder {
  difficulty: Difficulty;
  contextualHints: boolean;
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
  private lastLoadout: LoadoutChoice = { shipId: "rapier", gunId: "laser", secondaries: ["heat-seeker"] };
  private tutorialManager: TutorialManager | null = null;
  /** 直近の連続失敗数 (成功でリセット)。デブリーフでの提案表示に使う。 */
  private failureCount = 0;

  constructor(
    private readonly game: Game,
    private readonly state: GameStateData,
    private readonly mission: MissionManager,
    private readonly screens: MissionScreens,
    private readonly explosions: ExplosionSystem,
    private readonly settings: SettingsHolder,
    private readonly input?: InputManager,
    private readonly audio?: AudioManager,
    private settingsV2: GameSettingsV2 = SettingsStoreV2.load(),
  ) {}

  /** 起動時: 「開始 / 設定」のトップメニューを表示。 */
  start(): void {
    this.showMainMenu();
  }

  private showMainMenu(): void {
    this.input?.setContext("menu");
    this.state.phase = "Menu";
    this.screens.showMainMenu(
      DIFFICULTIES[this.settings.difficulty].label,
      () => this.onStart(),
      () => this.openSettings(),
    );
  }

  /**
   * 「開始」選択時。
   * セーブがあれば「続きから / 最初から」を提示。
   * セーブがなく訓練未完了なら「訓練を開始 / スキップ」を提示。
   * それ以外はそのままキャンペーン開始。
   */
  private onStart(): void {
    const save = SaveManager.load();
    if (save !== null) {
      this.screens.showTitle(
        true,
        () => this.continueFromSave(),
        () => this.beginNewCampaign(),
      );
    } else if (!this.settingsV2.tutorialCompleted) {
      this.screens.showTitle(
        false,
        () => this.startTutorial(),
        () => this.beginNewCampaign(),
      );
    } else {
      this.beginNewCampaign();
    }
  }

  /** 訓練ミッションを開始する。敵は無害化されており、基本操作を試しながら撃墜すれば完了。 */
  private startTutorial(): void {
    this.tutorialManager = new TutorialManager(this.input?.mouseFlightEnabled ?? false);
    this.mission.dispose();
    this.explosions.reset();
    this.state.phase = "Playing";
    this.state.result = null;
    this.state.resultText = "";
    this.state.kills = 0;
    this.mission.load(TUTORIAL_MISSION, this.game.simTime, TUTORIAL_MODS);
    this.screens.hide();
    this.input?.setContext("combat");
  }

  /** 現在の訓練指示テキスト (訓練中でなければ null)。HudSystem から参照。 */
  getTutorialInstructionText(): string | null {
    return this.tutorialManager?.getInstructionText() ?? null;
  }

  /** 訓練プレイ中かどうか。HintSystem 等で通常ヒントと競合させないために使う。 */
  isTutorialActive(): boolean {
    return this.tutorialManager !== null;
  }

  /** 現在の照準アシスト設定 (HUD 状態表示用)。 */
  getAimAssistLabel(): string {
    return this.settingsV2.assists.aimAssist;
  }

  /** 入力サンプルを訓練ステートマシンへ渡し、ステップ進行をチェックする。InputSystem から毎フレーム呼ばれる。 */
  updateTutorial(axes: FlightAxes, discrete: DiscreteActions, edges: EdgeActions, hasTarget: boolean, dt: number): void {
    this.tutorialManager?.checkProgress(axes, discrete, edges, hasTarget, dt);
  }

  /** 「設定」選択時。変更は即座に反映 + 保存し、戻るとメニューへ。 */
  private openSettings(): void {
    this.input?.setContext("menu");
    this.screens.showSettings(
      this.settingsV2,
      (s) => this.applySettings(s),
      () => {
        this.applySettings(SettingsStoreV2.reset());
        this.openSettings(); // デフォルト値で再描画。
      },
      () => this.showMainMenu(),
    );
  }

  /** 設定変更を即時反映 (難易度ホルダ/入力/オーディオ) + 保存する。 */
  private applySettings(s: GameSettingsV2): void {
    this.settingsV2 = s;
    this.settings.difficulty = s.difficulty;
    if (this.input) {
      this.input.mouseFlightEnabled = s.controls.mouseEnabled;
      this.input.advancedFlightEnabled = s.controls.advancedFlight;
      this.input.mouse.setConfig({
        sensitivity: s.controls.mouseSensitivity,
        invertY: s.controls.invertMouseY,
      });
    }
    if (this.audio) {
      this.audio.setMasterVolume(s.audio.master);
      this.audio.setCategoryVolume("music", s.audio.music);
      this.audio.setCategoryVolume("sfx", s.audio.sfx);
    }
    SettingsStoreV2.save(s);
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
    this.screens.showBriefing(def, index, MISSION_ORDER.length, () => this.toLoadout());
  }

  private toLoadout(): void {
    this.input?.setContext("loadout");
    this.screens.showLoadout(this.lastLoadout, (choice) => {
      this.lastLoadout = choice;
      this.launch();
    });
  }

  private launch(): void {
    const def = MISSIONS[this.currentMissionId];
    const mods = DIFFICULTIES[this.settings.difficulty];
    this.state.kills = 0;
    this.mission.load(def, this.game.simTime, mods, this.lastLoadout);
    this.state.phase = "Playing";
    this.screens.hide();
    this.input?.setContext("combat");
    // InputManager 側のスロットル内部値も出撃時難易度に連動させる (ThrusterInput 側は MissionManager.load で設定済み)。
    this.input?.setThrottle(mods.initialThrottle);
  }

  /** Esc 押下時 (InputSystem から呼ばれる)。Playing 中のみ有効。 */
  pause(): void {
    if (this.state.phase !== "Playing") return;
    this.input?.setContext("paused");
    this.state.phase = "Paused";
    this.screens.showPause(
      () => this.resume(),
      () => this.openSettingsFromPause(),
      () => this.restartMission(),
      () => this.toTitleFromPause(),
    );
  }

  /** 「再開」選択時。戦闘へ戻る。 */
  private resume(): void {
    this.input?.setContext("combat");
    this.state.phase = "Playing";
    this.screens.hide();
  }

  /** Pause 中の「設定」選択時。閉じたら Pause 画面へ戻る。 */
  private openSettingsFromPause(): void {
    this.input?.setContext("menu");
    this.screens.showSettings(
      this.settingsV2,
      (s) => this.applySettings(s),
      () => {
        this.applySettings(SettingsStoreV2.reset());
        this.openSettingsFromPause();
      },
      () => this.pause(),
    );
  }

  /** 「ミッション再開」選択時。現ミッションを最初からやり直す (ウェーブ再生成)。 */
  private restartMission(): void {
    this.mission.dispose();
    this.explosions.reset();
    this.launch();
  }

  /** Pause 中の「タイトルへ」選択時。ミッションを放棄してメインメニューへ戻る。 */
  private toTitleFromPause(): void {
    this.mission.dispose();
    this.explosions.reset();
    this.showMainMenu();
  }

  /** MissionSystem から勝敗確定時に呼ばれる (phase は既に Debrief)。 */
  onMissionEnd(result: "success" | "failure"): void {
    this.input?.setContext("menu");
    if (this.tutorialManager) {
      // 訓練は成否を問わず完了扱いにし、通常キャンペーンへ進む (デブリーフ画面は挟まない)。
      this.tutorialManager = null;
      this.settingsV2.tutorialCompleted = true;
      SettingsStoreV2.save(this.settingsV2);
      this.beginNewCampaign();
      return;
    }
    const node = CAMPAIGN.nodes[this.currentMissionId];
    const next = result === "success" ? node.success : node.failure;
    const label =
      result === "failure"
        ? "再挑戦"
        : next === null
          ? "キャンペーン完了"
          : "次のミッションへ";
    if (result === "success") {
      this.failureCount = 0;
    } else {
      this.failureCount++;
    }
    const hint = result === "failure" ? this.buildHint(this.state.resultText) : undefined;
    const suggestEasyAssist = result === "failure" && this.failureCount >= 2;
    this.screens.showDebrief(
      result,
      this.state.resultText,
      this.state.kills,
      this.mission.objectives,
      () => this.proceed(result, next),
      label,
      hint,
      suggestEasyAssist,
    );
  }

  /** 失敗理由テキストから次回への具体的な1ヒントを生成する。 */
  private buildHint(resultText: string): string {
    if (resultText.includes("撃墜")) return "被弾を避けるため、移動し続けましょう";
    if (resultText.includes("護衛")) return "護衛対象に接近し、攻撃者を先に撃墜しましょう";
    if (resultText.includes("時間")) return "敵を素早く撃墜するため、リード点を狙いましょう";
    return "まずはターゲットを選び、照準を合わせましょう";
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
