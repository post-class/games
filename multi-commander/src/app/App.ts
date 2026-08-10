import { bus } from '../core/events';
import {
  campaignGraph,
  campaignMap,
  campaignNode,
  campaignStart,
  chapterPosition,
  chapterProgressText,
  gateOutcomeFromChoice,
  isTerminal,
  totalChapters,
  VICTORY,
  DEFEAT,
  type CampaignMode,
  type CampaignNodeId,
  type GateOutcome,
} from '../content/campaign';
import { missionDef } from '../content/missions';
import { VEIL_ERA } from '../content/veil/world';
import { resolveVeilChoice, VEIL_CHAPTERS, type VeilChoiceEffects } from '../content/veil/chapters';
import { speakerName } from '../content/veil/missions/shared';
import { veilPerson } from '../content/veil/people';
import { dynamicMissionDef, chooseDynamicMission, applyFrontlineOutcome, frontlineSystemName, FRONTLINE_SYSTEM_IDS, type DynamicMissionKind, type FrontlineSystemId } from '../content/frontline';
import { PERSONALITIES, pilotDef } from '../content/pilots';
import { mournLine } from '../content/pilotDialogue';
import { PLAYABLE_SHIPS, shipDef } from '../content/ships';
import { GUNS, MISSILES, missileDef } from '../content/weapons';
import type { Loadout, MissionDef } from '../mission/types';
import { MISSION_GRADE_LABEL, objectiveRewardPrefix, type MissionGrade } from '../mission/MissionRunner';
import {
  barracksHtml,
  bondBoardHtml,
  mailHtml,
  hangarHtml,
  killBoardHtml,
  recRoomHtml,
  frontlineHtml,
  statisticsHtml,
  codexHtml,
  CODEX_PAGES,
  type CodexPage,
  type HangarSelection,
  type HubContext,
} from '../ui/HubPanels';
import { BriefingScene, type BriefingPanel } from '../ui/BriefingScene';
import { portraitFace, type Expression } from '../ui/Portrait';
import { escapeHtml, ScreenHost, type MenuItem } from '../ui/ScreenHost';
import { artImg, artUrl, medalArt, rankArt } from '../ui/art';
import { buildSettingsPanel } from '../ui/SettingsPanel';
import {
  protagonistBriefingLine,
  protagonistDebriefLine,
  protagonistWingReadyLine,
} from '../content/dialogue';
import { medalById, newlyEarned, rankFor, type MedalContext } from './medals';
import {
  applyProtagonistInitialBond,
  applySortie,
  availablePilots,
  barMemory,
  buyDrink,
  canBuyDrink,
  defaultWingman,
  defOf,
  fallen,
  hasWingman,
  pilotState,
  relationBetween,
  rememberBarTalk,
  rememberIntervention,
  shiftBond,
  shiftRelation,
  toastFallen,
  type PilotState,
  type SortieOutcome,
} from './roster';
import {
  buildBarTalk,
  chooseBarReply,
  newBarTalk,
  type BarTalkFacts,
  type BarTalkState,
  type BarTalkView,
} from './barTalk';
import { banterSeats, seatBondKey, seatPlan, type BarSeat } from './barSeats';
import {
  buildBanter,
  chooseBanterReply,
  newBanter,
  type BanterFacts,
  type BanterState,
  type BanterView,
} from './barBanter';
import { bondKey, PILOT_BOND_KINDS } from '../content/pilotBonds';
import {
  bartenderName,
  bartenderLine,
  gossipLine,
  rumorsFor,
  RUMOR_SOURCE_LABELS,
} from '../content/barRumors';
import { mailFor } from '../content/mail';
import { Game } from './game';
import type { TutorialCourse } from '../ui/Tutorial';
import {
  advanceCampaignSave,
  loadSave,
  loadSaveSlot,
  newCampaignSave,
  SAVE_SLOT_COUNT,
  saveToSlot,
  writeSave,
  type CampaignSave,
} from './save';
import { availableMissiles, clampLoadout, consumeLoadout, replenishForMission, scaleLoadout } from './supplies';
import { recordMissionStatistics } from './statistics';
import {
  addReturneeEntries,
  adjustNarrative,
  applyChoice,
  MAX_RELAYS,
  narrativeSummary,
  NARRATIVE_LABEL,
  recordRelaysHeld,
  returneeRollCall,
  returneeScore,
  sortieNarrative,
  supportLevel,
  type NarrativeLine,
  type ReturneeKind,
  type SortieFacts,
} from './narrative';
import { difficulty, settings, updateSettings } from './settings';
import { showcase, type ShowcaseOptions, type ShowcaseResult } from './showroom';
import { ReplayPanel } from './replay';
import { audio } from '../audio/AudioManager';
import { type MusicTrackId } from '../audio/musicCues';
import { previewSfx } from '../audio/sfxPreview';
import { buildSoundCheckPanel } from '../ui/SoundCheckPanel';
import { PilotSelectScene } from '../ui/PilotSelectScene';
import { ChoiceScene } from '../ui/ChoiceScene';
import type { AceState } from '../content/aces';

/**
 * エースとのやりとりの累積値 (T4-⑯)。
 *
 * `AceState` は章をまたいで積み上がるので、1回の出撃で何をしたかは
 * 「出撃前に控えた値との差」でしか取れない。ここはその控え／差分用の形。
 */
interface AceTally {
  spared: number;
  executed: number;
  namesExchanged: number;
  duelsAccepted: number;
}

const EMPTY_ACE_TALLY: AceTally = { spared: 0, executed: 0, namesExchanged: 0, duelsAccepted: 0 };

/** 全エースぶんを合計する。欠落フィールド（旧セーブ）は 0 として扱う。 */
function aceTally(states: readonly AceState[]): AceTally {
  const t: AceTally = { ...EMPTY_ACE_TALLY };
  for (const s of states) {
    t.spared += Math.max(0, s.spared ?? 0);
    t.executed += Math.max(0, s.executed ?? 0);
    t.namesExchanged += Math.max(0, s.namesExchanged ?? 0);
    t.duelsAccepted += Math.max(0, s.duelsAccepted ?? 0);
  }
  return t;
}

/** 母艦の名前。ブリーフィング官の名札に出す */
const CLAW_NAME = 'TCS タイガーズ・クロー';
/**
 * タイトルで切り替えられる新規戦役のモード。
 * 十章キャンペーン（veil）を先頭に置き、既存の canon / expanded も選べるまま残す。
 */
const NEW_CAMPAIGN_MODES: readonly CampaignMode[] = ['veil', 'canon', 'expanded'];

/** 最終無線で読み上げる立場のラベル */
const RETURNEE_KIND_LABEL: Record<ReturneeKind, string> = {
  civilian: '民間',
  wingman: '僚機',
  'enemy-ace': '敵エース',
  'ally-faction': '他勢力',
};

/** デブリーフに出す4状態の増減。理由を必ず添える（数値だけでは何が効いたか分からない） */
interface NarrativeChange {
  label: string;
  delta: number;
  reason: string;
}


/**
 * 画面遷移とキャンペーン進行の統括。
 * タイトル → ブリーフィング → 出撃 → デブリーフ → 分岐 を回す。
 */
export class App {
  private game: Game;
  private screens: ScreenHost;
  private save: CampaignSave;
  private lastSummary?: ReturnType<NonNullable<Game['runner']>['summary']>;
  /** 出撃直前のエース記録。差分で「この出撃でのやりとり」を出す (T4-⑯) */
  private aceTallyAtLaunch?: AceTally;
  /** 格納庫で選んだ内容 (出撃まで保持する) */
  private selection?: HangarSelection;
  /**
   * 直前の出撃で守り切った護衛対象・輸送船の数 (T2-③)。
   *
   * `summary()` は喪失の有無 (`escortLost`) しか持たないので、
   * `MissionRunner.escortTags` と `summary().tagSurvivors` から数え直す
   * （`src/mission/` は他の担当が触っているため、読むだけにしている）。
   */
  /** 直前の章末選択 (デブリーフに「方針」として1行出す。T2-③) */
  private lastChoiceEffects?: { label: string; effects: VeilChoiceEffects };
  /** 直前の出撃で失った僚機 (追悼画面に使う) */
  private lastLostWingman?: string;
  /** 最後に到達した階級 (昇進の検出に使う) */
  private lastRankId = '2lt';
  /** 訓練室はキャンペーン進行を変更しない */
  private trainingActive = false;
  /** タイトルから起動したチュートリアル。キャンペーン進行を変更しない */
  private tutorialActive = false;
  private tutorialMode: TutorialCourse = 'simple';
  private trainingKind: DynamicMissionKind = 'patrol';
  private trainingEnemyCount = 3;
  private trainingSkill = 0.55;
  private replayPanel?: ReplayPanel;
  /**
   * 新規戦役で選ぶモード。既存セーブのモードはセーブ側を優先する。
   * 既定は十章キャンペーン（veil）。canon / expanded は互換のため選べるまま残す。
   */
  private newCampaignMode: CampaignMode = 'veil';
  private barPilotId?: string;
  /** 酒場の往復会話の進行（T3-⑪）。出撃を挟むとリセットされる。 */
  private barTalk?: BarTalkState;
  /**
   * 酒場の掛け合いへの割り込みの進行（T8-①）。
   * 1対1の会話（`barTalk`）とは同時に開かない（どちらかを開くと他方を閉じる）。
   */
  private barBanter?: BanterState;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.game = new Game(canvas, overlay);
    this.screens = new ScreenHost(overlay);
    this.save = loadSave() ?? newCampaignSave('veil');
    this.newCampaignMode = this.save.campaignMode;

    this.game.onMissionEnd = (outcome) => this.onMissionEnd(outcome);
    this.game.onPauseRequested = () => this.showPause();
  }

  start(): void {
    this.game.start();
    this.game.suspend();
    this.showTitle();
  }

  // ───────── タイトル ─────────

  private showTitle(): void {
    // 訓練中にタイトルへ戻っても、続きから再開したキャンペーンを
    // 訓練任務として扱わないようにする。
    this.trainingActive = false;
    this.tutorialActive = false;
    this.game.sound.music.play('title');
    this.game.endMission();
    const hasSave = !!loadSave();
    const items: MenuItem[] = [
      { label: `新しい戦役を始める (${this.modeLabel(this.newCampaignMode)})`, onSelect: () => this.startCampaign(true) },
      {
        label: '続きから',
        disabled: !hasSave,
        onSelect: () => this.startCampaign(false),
      },
      {
        label: `新規戦役モードを切替 (${this.modeLabel(this.newCampaignMode)})`,
        onSelect: () => {
          this.newCampaignMode = NEW_CAMPAIGN_MODES[
            (NEW_CAMPAIGN_MODES.indexOf(this.newCampaignMode) + 1) % NEW_CAMPAIGN_MODES.length
          ];
          this.showTitle();
        },
      },
      { label: '設定', onSelect: () => this.showSettings(() => this.showTitle()) },
      { label: 'チュートリアル', onSelect: () => this.showTutorialMenu() },
      { label: '操作説明', onSelect: () => this.showHelp() },
    ];
    const saved = loadSave();
    const progress = saved
      // 章の語順は progressLabel（`第N章 / 全K章`）と揃える。保存データの形式は変えない
      ? `前回の記録: ${this.modeLabel(saved.campaignMode)}・第${this.chapterOf(saved.node, saved.campaignMode)}章 / 全${totalChapters(saved.campaignMode)}章 / 勝利点 ${saved.seriesScore} / 通算撃墜 ${saved.totalKills} 機`
      : '記録なし';
    const veil = this.newCampaignMode === 'veil';
    this.screens.show({
      title: veil ? 'THE VEIL FRONT' : 'MULTI-COMMANDER',
      subtitle: veil
        ? `統合暦 ${VEIL_ERA.year} — ヴェガ非常事態 / ${CLAW_NAME}`
        : 'TCS TIGER’S CLAW — VEGA SECTOR',
      heroTitle: true,
      crest: artUrl('title-crest'),
      crestHeight: 210,
      background: artUrl('tex/bg-space', 'jpg'),
      bodyHtml:
        `<div class="block"><h3>状況</h3>` +
        (veil
          ? `五勢力がヴェガ門の通行権をめぐって睨み合っている。停戦線は残っているが、停戦を信じる艦は少ない。` +
            `君は前進基地オリオン港に寄港する空母の艦載機パイロットだ。護衛、偵察、迎撃、救難。` +
            `勝利は撃墜数では測れない。誰を帰し、どの航路を残すかが、門の明日を決める。`
          : `キルラシー帝国との戦争は6年目に入った。君はタイガーズ・クローに配属された新任パイロットだ。` +
            `ブリーフィングを受け、出撃し、生きて帰れ。戦況は君の戦果で変わる。`) +
        `</div>` +
        `<div class="dim">${escapeHtml(progress)}　難易度: ${difficulty().label}</div>`,
      items,
      hint: '▲▼ で選択 / Enter で決定',
    });
  }

  private modeLabel(mode: CampaignMode): string {
    if (mode === 'veil') return 'THE VEIL FRONT / 十章';
    return mode === 'canon' ? 'CANON / ENYO' : 'EXPANDED / McCAFFREY';
  }

  private chapterOf(node: CampaignNodeId, mode: CampaignMode = this.save.campaignMode): number {
    if (isTerminal(node)) return totalChapters(mode);
    return campaignNode(node, mode).chapter;
  }

  /**
   * 「いま何章の何本目か」の表示文（W6）。
   *
   * ポーズ画面とブリーフィング画面が同じ文字列を使う。文言の組み立ては
   * `chapterProgressText()`（campaign.ts の純関数）に置き、ここは現在ノードから
   * 位置を引くだけにしている。終端では章内位置が無いので空文字を返す。
   */
  private progressLabel(): string {
    if (isTerminal(this.save.node)) return '';
    return chapterProgressText(chapterPosition(this.save.node, this.save.campaignMode));
  }

  private showHelp(): void {
    this.screens.show({
      title: '操作説明',
      bodyHtml:
        `<div class="block"><h3>飛ぶ</h3>` +
        `機首は <b>↑↓←→</b>、ロールは <b>Q E</b>。マウス操縦は既定 OFF で、<b>M</b> で入れると照準から動かした方へ機首が向く。` +
        `スロットルは <b>] [</b>（10%ずつ）かホイール、数字 <b>1〜9</b> で割合指定。<b>Tab</b> でアフターバーナー。</div>` +
        `<div class="block"><h3>戦う</h3>` +
        `<b>Space</b> か左クリックで主砲。<b>T</b> でターゲット切替、<b>Y</b> で正面の敵を掴む。` +
        `黄色い点線の丸が「そこを撃てば当たる」位置 (偏差照準)。<b>Enter</b> か右クリックでミサイル。` +
        `誘導ミサイルは正面に捉え続けてロックしてから撃つ。</div>` +
        `<div class="block"><h3>移動する</h3>` +
        `Nav ポイント間の移動は <b>A</b> のオートパイロット。敵が近くにいると使えない。</div>` +
        `<div class="block"><h3>指示する</h3>` +
        `<b>C</b> で通信メニュー。数字キーで僚機へ指示、または敵を挑発できる。</div>`,
      items: [
        { label: '音楽クレジット', onSelect: () => this.showMusicCredits(() => this.showHelp()) },
        { label: '戻る', onSelect: () => this.showTitle() },
      ],
      onCancel: () => this.showTitle(),
    });
  }

  private showTutorialMenu(): void {
    this.screens.show({
      title: 'チュートリアル',
      subtitle: 'TRAINING FLIGHT / SELECT COURSE',
      bodyHtml:
        `<div class="block"><h3>操作を練習する</h3>` +
        `キャンペーンの戦果・補給・名簿を変更せず、専用の訓練空域で操作を確認できます。` +
        `簡易チュートリアルは初回出撃時の案内と同じ内容です。` +
        `詳細チュートリアルでは、戦闘以外の入力も順番に確認します。</div>` +
        `<div class="block"><h3>お手本モード</h3>` +
        `操作をこちらが実演します。押しているキーを画面に表示しながら、` +
        `スロットル・機首・アフターバーナー・ターゲット・主砲・ミサイル・フレア・HUD操作を順に見せ、` +
        `最後に敵機とのドッグファイトを行います。<b>B</b> で次の実演へ飛ばせます。</div>` +
        `<div class="dim">訓練中は Esc →「タイトルへ戻る」でいつでも終了できます。</div>`,
      items: [
        { label: 'お手本モード — 操作とドッグファイトを見る', onSelect: () => this.launchTutorial('demo') },
        { label: '簡易チュートリアル — 基本6ステップ', onSelect: () => this.launchTutorial('simple') },
        { label: '詳細チュートリアル — 全操作を確認', onSelect: () => this.launchTutorial('detailed') },
        { label: '戻る', onSelect: () => this.showTitle() },
      ],
      onCancel: () => this.showTitle(),
    });
  }

  private showSettings(back: () => void): void {
    /*
     * 設定画面を開いている間だけ、試聴で曲を差し替える (W5)。
     * 閉じるときに元の曲へ戻すのは、音楽クレジット画面と同じ方式。
     * 「設定を変えたら音がそのまま変わった」ことをその場で確認できるよう、
     * 試聴は本番と同じ出力経路 (MusicDirector / AudioManager) を通す。
     */
    const previousTrack = this.game.sound.music.current;
    const restore = () => {
      if (previousTrack) this.game.sound.music.play(previousTrack);
      back();
    };
    const panel = buildSettingsPanel(
      () => {
        this.game.applySettings();
      },
      {
        previewMusic: (cue) => {
          audio.resume();
          this.game.sound.music.play(cue);
          this.game.sound.music.start();
        },
        previewSfx: (category) => {
          audio.resume();
          previewSfx(category);
        },
      },
    );
    this.screens.show({
      title: '設定',
      content: panel,
      items: [{ label: '戻る', onSelect: restore }],
      onCancel: restore,
      transparent: this.game.runner !== undefined,
    });
  }

  // ───────── キャンペーン進行 ─────────

  /**
   * 十章キャンペーンの主人公を選ばせる。
   *
   * F-54 専任パイロット5名から選ぶ（固定主人公にしない仕様）。
   * veil 以外のモード、または既に選択済みのセーブでは呼ばない。
   */
  private showPilotSelect(after: () => void): void {
    const scene = new PilotSelectScene({
      initialId: this.save.protagonistId,
      onSelect: (personId) => {
        this.save.protagonistId = personId;
        // 選んだ主人公の立場に応じて、まだ一緒に飛んでいない僚機の関係値を少し寄せる。
        // 動くのは関係値だけで、技量・機体・敵の強さ・難易度には触れない（T5-⑬c）。
        applyProtagonistInitialBond(this.save.roster, personId);
        writeSave(this.save);
        scene.dispose();
        after();
      },
    });
    this.screens.show({
      title: 'F-54 専任パイロット 選任',
      subtitle: `統合暦 ${VEIL_ERA.year} — ヴェガ非常事態`,
      background: artUrl('tex/bg-briefing', 'jpg'),
      content: scene.el,
      hint: scene.hint,
      onCancel: () => {
        scene.dispose();
        this.showTitle();
      },
    });
    scene.start();
  }

  private startCampaign(fresh: boolean): void {
    if (fresh) {
      this.save = newCampaignSave(this.newCampaignMode);
      writeSave(this.save);
      if (this.save.campaignMode === 'veil') {
        this.newCampaignMode = this.save.campaignMode;
        this.selection = undefined;
        this.showPilotSelect(() => this.showHub());
        return;
      }
    } else {
      this.save = loadSave() ?? newCampaignSave(this.newCampaignMode);
    }
    this.newCampaignMode = this.save.campaignMode;
    this.selection = undefined;
    this.showHub();
  }

  private currentMission(): MissionDef {
    if (this.tutorialActive) return this.tutorialDef(this.tutorialMode);
    if (this.trainingActive) return this.trainingDef();
    if (this.save.campaignMode === 'expanded' && this.save.dynamicMission) return dynamicMissionDef(this.save.dynamicMission);
    const node = campaignNode(this.save.node, this.save.campaignMode);
    const base = missionDef(node.missionId);
    // 十章キャンペーンは章ごとに専用のミッション定義を持ち、題名・星系・本文は
    // すべて章データから作られている。下の canon 向けアダプタを通すと作戦名が
    // 題名に二重で入り（ヘッダが溢れる）、戦況文がブリーフィング冒頭に重複する。
    if (this.save.campaignMode === 'veil') return base;
    const localizedTitle = base.title
      .replace('マッカフリー', node.system)
      .replace('McCaffrey', node.system);
    // Canonノードの星系・シリーズ・戦況を、既存の戦闘データへ明示的に接続する。
    // id は履歴で独立させるため、同じ m4-defend を使う分岐も混ざらない。
    return {
      ...base,
      id: this.save.campaignMode === 'canon' ? this.save.node : base.id,
      title: `${node.seriesName} — ${localizedTitle}`,
      system: node.system,
      briefing: [node.situation, ...base.briefing],
      debriefWin: [node.winSituation, ...base.debriefWin],
      debriefLoss: [node.lossSituation, ...base.debriefLoss],
    };
  }

  private loadoutFor(def: MissionDef): Loadout {
    const sel = this.ensureSelection(def);
    const missilePackage = sel.missiles ?? shipDef(sel.shipId).missiles;
    /**
     * 十章キャンペーンでは、4状態が「味方の顔ぶれと持ち物」を決める（T4-3）。
     *
     * 難易度は動かさない。動かすのは搭載兵装の上限と僚機の出撃可否だけで、
     * 敵の強さには一切触れない（narrative.ts の実装規約）。
     */
    const support = this.save.campaignMode === 'veil' ? supportLevel(this.save.narrative) : undefined;
    const load: Loadout = {
      shipId: sel.shipId,
      gunId: sel.gunId,
      missiles: clampLoadout(
        this.save.supplies,
        scaleLoadout(
          missilePackage,
          difficulty().playerMissileCountScale * (support?.missileBudget ?? 1),
        ),
      ),
      aceStates: this.save.aceStates,
      wingmanSlot: sel.wingmanSlot,
      flares: Math.min(12, this.save.supplies.flares),
      // 章ごとの選択記録。第9章の位相迷路が「過去章の無線を反転した意味で再生する」ために使う
      choices: this.save.narrative.choices,
      // これまでに連れ帰った者（T4-⑮）。第10章の読み上げが過去章の分まで読むために渡す
      rescuedNames: this.save.rescuedNames,
    };
    /**
     * 軍令信用が落ちていると僚機が付かない（司令部が機体を出さない）。
     *
     * 仕様 §03 では僚機を左右するのは「軍令信用」なので、帰還者指標
     * （`supportLevel().wingmanSlots`）ではなくこちらで判定する。帰還者は
     * 増える一方の指標なので、それで門を作ると初回出撃から僚機が付かなくなる。
     * `wingmanSlots` は将来の複数僚機編成のための余剰枠として残している。
     */
    const wingmanAllowed = !support || this.save.narrative.commandTrust >= 25;
    const w = sel.wingmanId && wingmanAllowed ? pilotState(this.save.roster, sel.wingmanId) : undefined;
    if (w && w.status === 'active') {
      const wd = pilotDef(w.id);
      const pers = PERSONALITIES[wd.personality];
      load.wingman = {
        pilotId: w.id,
        callsign: wd.callsign,
        // 本人の好みの機体で出る (ミッションの指定機ではない)
        shipId: wd.preferredShip,
        skill: w.skill,
        personality: {
          // 酒場で会話を終えた相手は、その次の1回だけ指示への応えが早い（T3-⑪）。
          // 既存の bond → 性格補正と同じ経路に乗せる（新しい系統を作らない）。
          obedience: Math.max(
            0,
            Math.min(1, pers.obedience + w.bond * 0.12 + (w.talkedSinceSortie ? 0.06 : 0)),
          ),
          aggression: Math.max(0, Math.min(1, pers.aggression - w.bond * 0.08)),
          caution: Math.max(0, Math.min(1, pers.caution - w.bond * 0.05)),
          grit: pers.grit,
        },
      };
    }
    return load;
  }

  /** ハブの共通コンテキスト */
  private hubContext(): HubContext {
    return {
      roster: this.save.roster,
      totalKills: this.save.totalKills,
      sorties: this.save.sorties,
      cleared: this.save.cleared,
      medals: this.save.medals,
      chapter: this.chapterOf(this.save.node),
      totalChapters: totalChapters(this.save.campaignMode),
      aceStates: this.save.aceStates,
      frontline: this.save.frontline,
      supplies: this.save.supplies,
      statistics: this.save.statistics,
      lastSortie: this.save.lastSortie,
      // 戦況マップの星系図が4状態（帰還者・航路信頼・軍令信用・敵エースの誓約）を
      // 「それが効く場所」の上に出すために読む (T3-⑫)。渡さないと「記録なし」表示になる。
      //
      // 帰還者だけは `NarrativeState` が名簿（string[]）で持っているので、
      // 他3状態と同じ 0..100 の尺度へ `returneeScore()` で写す。
      // ここで人数をそのまま渡すと、地図の帯だけが別の尺度になる。
      narrative: {
        returnees: returneeScore(this.save.narrative),
        routeTrust: this.save.narrative.routeTrust,
        commandTrust: this.save.narrative.commandTrust,
        aceOath: this.save.narrative.aceOath,
      },
    };
  }

  /** 出撃準備の選択内容 (未設定ならミッションの既定から作る) */
  private ensureSelection(def: MissionDef): HangarSelection {
    if (!this.selection || this.selection.shipId === undefined) {
      this.selection = {
        shipId: def.playerShipId,
        missiles: def.playerMissiles,
        wingmanId: defaultWingman(this.save.roster),
        wingmanSlot: 2,
      };
    }
    const selection = this.selection;
    if (!selection) throw new Error('selection initialization failed');
    // 僚機が戦死・負傷していたら選び直す
    const w = selection.wingmanId
      ? pilotState(this.save.roster, selection.wingmanId)
      : undefined;
    if (!w || w.status !== 'active' || w.benchedFor > 0) {
      selection.wingmanId = defaultWingman(this.save.roster);
    }
    selection.missiles = clampLoadout(this.save.supplies, selection.missiles);
    return selection;
  }

  /**
   * 母艦ハブ。出撃前の行き先を選ぶ。
   * WC の「ミッションの間」を作るための画面。
   */
  private showHub(): void {
    this.game.sound.music.play('hub');
    if (isTerminal(this.save.node)) {
      this.showEnding(this.save.node === VICTORY);
      return;
    }
    const node = campaignNode(this.save.node, this.save.campaignMode);
    const def = this.currentMission();
    const sel = this.ensureSelection(def);
    const rank = rankFor(this.save.sorties, this.save.totalKills);
    const dead = fallen(this.save.roster);

    this.screens.show({
      crest: artUrl('emblem-carrier'),
      crestHeight: 72,
      background: artUrl('tex/bg-hangar', 'jpg'),
      title: 'TCS タイガーズ・クロー',
      subtitle:
        `${this.modeLabel(this.save.campaignMode)}　${node.seriesName}　${node.chapter}/${totalChapters(this.save.campaignMode)}　—　${def.system} 星系` +
        `${node.losingRoute ? '　(戦況悪化)' : ''}`,
      bodyHtml:
        `<div class="block">` +
        `<div class="mc-rank-line">${artImg(rankArt(rank.id), { className: 'mc-rank-pin', height: 26, alt: rank.label })}` +
        `<span>${escapeHtml(rank.label)}　通算撃墜 ${this.save.totalKills}　出撃 ${this.save.sorties} 回` +
        `${dead.length ? `　<span class="ng">戦死 ${dead.length} 名</span>` : ''}</span></div>` +
        `<div class="dim">次の任務: ${escapeHtml(def.title)}` +
        `${this.save.dynamicMission ? '　<span class="ok">戦況作戦</span>' : ''}</div>` +
        (this.save.campaignMode === 'veil'
          // 十章キャンペーンでは勝利点ではなく4状態が進行の指標なので、そちらを出す
          ? `<div class="dim">戦況: ${escapeHtml(this.save.campaignSituation)}</div>` +
            `<div class="dim">${this.narrativeGaugeLine()}</div>`
          : `<div class="dim">戦況: ${escapeHtml(this.save.campaignSituation)}　/　勝利点 ${this.save.seriesScore}　/　${this.frontlineSummary()}</div>`) +
        `</div>`,
      items: [
        {
          label: 'ブリーフィング室 — 任務の説明を受ける',
          icon: artUrl('icon-briefing'),
          onSelect: () => this.showBriefing(),
        },
        {
          label: '格納庫 — 機体と僚機を決める',
          icon: artUrl('icon-hangar'),
          onSelect: () => this.showHangar(),
        },
        { label: '酒場 — 隊員と話す', icon: artUrl('icon-bar'), onSelect: () => this.showRecRoom() },
        {
          label: '自室 — 名簿と戦績',
          icon: artUrl('icon-barracks'),
          onSelect: () => this.showBarracks(),
        },
        { label: 'キルボード', icon: artUrl('icon-killboard'), onSelect: () => this.showKillBoard() },
        { label: '戦況マップ', onSelect: () => this.showFrontline() },
        { label: '訓練室', onSelect: () => this.showTraining() },
        { label: '統計', onSelect: () => this.showStatistics() },
        // 名鑑は THE VEIL FRONT の資料なので veil のときだけ出す
        ...(this.save.campaignMode === 'veil'
          ? [{ label: '名鑑 — 人物・機体・戦域', onSelect: () => this.showCodex('people-confed') }]
          : []),
        {
          label: `出撃 (${escapeHtml(shipDef(sel.shipId).name)}${sel.wingmanId ? ' / ' + escapeHtml(pilotDef(sel.wingmanId).callsign) : ' / 単独'})`,
          icon: artUrl('icon-launch'),
          onSelect: () => this.launch(this.shouldTutorial()),
        },
        { label: '設定', onSelect: () => this.showSettings(() => this.showHub()) },
        { label: 'タイトルへ戻る', onSelect: () => this.showTitle() },
      ],
      hint: '▲▼ で選択 / Enter で決定',
    });
  }

  /**
   * 酒場（T3-⑪）。
   *
   * 誰かを選ぶと会話が始まり、相手の近況に対してこちらの返事を2択で選ぶ。
   * 2往復で終わり、選んだ返事で `bond` が動く。会話の進行は `this.barTalk`
   * が持ち、表示物は `barTalk.ts` が `BarTalkView` として組み立てる。
   */
  private showRecRoom(): void {
    const roster = this.save.roster;
    const talkers = roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded');
    const active = talkers.find((p) => p.id === this.barPilotId);
    const view = active ? this.barTalkView(active) : undefined;

    // ① 席割り。乱数を使わないので、同じ帰艦のあいだ席は動かない。
    //    種は「通算出撃回数」なので、出撃するたびに一人席の顔ぶれが入れ替わる。
    const plan = seatPlan(roster, { wingmanId: this.selection?.wingmanId, seed: this.save.sorties });

    // ② 割り込み中の掛け合い。席から二人が消えていたら会話を破棄する
    //    （負傷・戦死・転属で片方が席を離れることがある）。
    const banterSeat = banterSeats(plan).find((s) => seatBondKey(s) === this.barBanter?.bondKey);
    const banterView = banterSeat ? this.banterView(banterSeat) : undefined;
    if (this.barBanter && !banterSeat) this.barBanter = undefined;

    const ctx = {
      ...this.hubContext(),
      barPilotId: this.barPilotId,
      barTalk: view,
      barSeats: plan.seats,
      barStanding: plan.standing,
      barBanter: banterView,
      bondKinds: PILOT_BOND_KINDS,
      bartender: { name: bartenderName(), line: bartenderLine(this.rumorContext(), this.save.sorties) },
      // 噂は2件。3件だとパネルに収まらず、席の一覧までスクロールが出る。
      rumors: rumorsFor(this.rumorContext(), this.save.sorties, 2).map((r) => ({
        source: RUMOR_SOURCE_LABELS[r.source],
        text: r.text,
      })),
      gossip: this.barGossip(talkers),
      canBuyDrink: canBuyDrink(roster),
      toasted: barMemory(roster).toasted === true,
    } as HubContext;

    const dead = fallen(roster);
    this.screens.show({
      background: artUrl('tex/bg-bar', 'jpg'),
      title: '酒場',
      bodyHtml: recRoomHtml(ctx),
      items: [
        // 返事・割り込みを先頭に置く（会話中はそれが既定フォーカスになる）
        ...(banterView?.replies ?? []).map((reply) => ({
          label: `→ ${escapeHtml(reply.label)}`,
          onSelect: () => this.answerBanter(banterSeat!, reply.id),
        })),
        ...(view?.replies ?? []).map((reply) => ({
          label: `→ ${escapeHtml(reply.label)}`,
          onSelect: () => this.answerBarTalk(active!, reply.id),
        })),
        // 席ごとの操作。同席なら「二人の話に割り込む」、一人席なら「話す」。
        ...plan.seats.flatMap((seat) => this.seatMenuItems(seat)),
        ...plan.standing.map((pilot) => ({
          label: `${escapeHtml(pilotDef(pilot.id).callsign)} と話す（立ち飲み）`,
          onSelect: () => this.startBarTalk(pilot.id),
        })),
        // 一杯奢る。1回の帰艦につき1回だけ。
        ...(canBuyDrink(roster) && active
          ? [
              {
                label: `${escapeHtml(pilotDef(active.id).callsign)} に一杯奢る`,
                onSelect: () => this.buyBarDrink(active),
              },
            ]
          : []),
        ...(dead.length && !barMemory(roster).toasted
          ? [{ label: `空いた席にグラスを置く（${dead.length} 名）`, onSelect: () => this.toastTheFallen() }]
          : []),
        { label: '噂を聞き直す', onSelect: () => this.showRecRoom() },
        { label: '戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
    });
  }

  /** 噂の出方を決める文脈（章・4状態・隊の被害）。 */
  private rumorContext() {
    return {
      chapter: this.chapterOf(this.save.node),
      gauges: {
        returnees: returneeScore(this.save.narrative),
        routeTrust: this.save.narrative.routeTrust,
        commandTrust: this.save.narrative.commandTrust,
        aceOath: this.save.narrative.aceOath,
      },
      hasFallen: fallen(this.save.roster).length > 0,
      hasWounded: this.save.roster.pilots.some((p) => p.status === 'wounded'),
    };
  }

  /**
   * 席1つ分のメニュー項目。
   *
   * 同席（2名）なら掛け合いへの割り込みと、各人との1対1の会話を両方出す。
   * 「二人の話を聞く」だけにすると、ペアに入っている隊員と個別に話せなくなる。
   */
  private seatMenuItems(seat: BarSeat): Array<{ label: string; onSelect: () => void }> {
    if (seat.occupants.length === 0) return [];
    const call = (id: string) => escapeHtml(pilotDef(id).callsign);
    const items: Array<{ label: string; onSelect: () => void }> = [];
    if (seat.occupants.length === 2 && seat.bond) {
      const key = seatBondKey(seat)!;
      items.push({
        label:
          this.barBanter?.bondKey === key
            ? `${call(seat.bond.a)} と ${call(seat.bond.b)} の話を最初から`
            : `${call(seat.bond.a)} と ${call(seat.bond.b)} の話に近づく（${escapeHtml(seat.label)}）`,
        onSelect: () => {
          this.barBanter = newBanter(seat.bond!);
          // 掛け合いに寄ると1対1の会話は閉じる（同時に二つ開いていると読めない）
          this.barPilotId = undefined;
          this.barTalk = undefined;
          writeSave(this.save);
          this.showRecRoom();
        },
      });
    }
    for (const p of seat.occupants) {
      items.push({
        label:
          p.id === this.barPilotId
            ? `${call(p.id)} との会話を最初から`
            : `${call(p.id)} と話す`,
        onSelect: () => this.startBarTalk(p.id),
      });
    }
    return items;
  }

  private startBarTalk(pilotId: string): void {
    this.barPilotId = pilotId;
    this.barTalk = newBarTalk(pilotId);
    // 1対1に移ったら掛け合いは閉じる
    this.barBanter = undefined;
    writeSave(this.save);
    this.showRecRoom();
  }

  /** 掛け合いの表示物。二人の現在の仲を `relations` から読んで渡す。 */
  private banterView(seat: BarSeat): BanterView {
    const bond = seat.bond!;
    return buildBanter({
      bond,
      relation: relationBetween(this.save.roster, bond.a, bond.b),
      sorties: this.save.sorties,
      facts: this.banterFacts(),
      state: this.barBanter,
    });
  }

  private banterFacts(): BanterFacts {
    const s = this.lastSummary;
    return {
      wingmanId: s ? this.selection?.wingmanId : undefined,
      rescued: !!s?.wingmanRescued,
      abandoned: !!s?.wingmanAbandoned,
      fallenName: this.lastLostWingman ? pilotDef(this.lastLostWingman).callsign : undefined,
    };
  }

  /**
   * 掛け合いへ割り込む。
   *
   * `barBanter.ts` は一切書き換えないので、ここで
   * 「二人それぞれの bond」と「二人の仲（relations）」の両方へ反映する。
   * 介入は1回だけなので、`talkedSinceSortie` のような重複防止は要らない。
   */
  private answerBanter(seat: BarSeat, replyId: string): void {
    const bond = seat.bond;
    if (!bond) return;
    const result = chooseBanterReply(
      {
        bond,
        relation: relationBetween(this.save.roster, bond.a, bond.b),
        sorties: this.save.sorties,
        facts: this.banterFacts(),
        state: this.barBanter,
      },
      replyId,
    );
    this.barBanter = result.state;
    for (const { pilotId, delta } of result.effect.bondDelta) {
      const p = pilotState(this.save.roster, pilotId);
      if (p) shiftBond(p, delta);
    }
    shiftRelation(this.save.roster, bond.a, bond.b, result.effect.relationDelta);
    if (result.finished) {
      const side = replyId === 'side-a' ? 'a' : replyId === 'side-b' ? 'b' : 'defuse';
      rememberIntervention(this.save.roster, bondKey(bond.a, bond.b), side);
    }
    writeSave(this.save);
    this.showRecRoom();
  }

  /**
   * 一杯奢る（1回の帰艦につき1回）。
   *
   * 会話と違って選択肢が無い代わりに、**奢った相手の相棒・弟子が次の帰艦で
   * それを口にする**（`gossipLine`）。関係を伸ばす手段としては小さいが、
   * 隊の中に伝わるのはこちらだけである。
   */
  private buyBarDrink(pilot: PilotState): void {
    if (!buyDrink(this.save.roster, pilot.id)) return;
    shiftBond(pilot, 0.08);
    writeSave(this.save);
    this.showRecRoom();
  }

  /**
   * 空いた席へグラスを置く（1回の帰艦につき1回）。
   *
   * 戦死者を悼む行為なので、**生存者全員**の bond がわずかに動く。
   * 誰か一人に取り入る行為ではないことを、効果の形で示している。
   */
  private toastTheFallen(): void {
    if (!toastFallen(this.save.roster)) return;
    for (const p of this.save.roster.pilots) {
      if (p.status === 'dead' || p.status === 'transferred') continue;
      shiftBond(p, 0.04);
    }
    writeSave(this.save);
    this.showRecRoom();
  }

  /**
   * 噂の伝播。前回の帰艦でプレイヤーが酒場で何をしたかを、別の隊員が口にする。
   *
   * 対象は「いま席にいる隊員」だけ。自分の話は返らない（`gossipLine` の仕様）。
   */
  private barGossip(talkers: PilotState[]): Array<{ pilotId: string; text: string }> {
    const memory = barMemory(this.save.roster);
    const out: Array<{ pilotId: string; text: string }> = [];
    for (const p of talkers) {
      const text = gossipLine(p.id, memory, this.save.sorties + p.sorties);
      if (text) out.push({ pilotId: p.id, text });
    }
    return out;
  }

  /** 会話中の相手の表示物。`HubContext.barTalk` に渡す。 */
  private barTalkView(pilot: PilotState): BarTalkView {
    return buildBarTalk({
      pilot,
      personality: pilotDef(pilot.id).personality,
      facts: this.barTalkFacts(pilot.id),
      state: this.barTalk,
    });
  }

  /**
   * 直前の出撃で「その人に何が起きたか」。
   *
   * 助けた／見捨てたは僚機として飛んだ相手にしか起きないので、同じ帰艦でも
   * 人によって話題が変わる。出撃前（`lastSummary` が無い）は全部 false。
   */
  private barTalkFacts(pilotId: string): BarTalkFacts {
    const s = this.lastSummary;
    const flew = !!s && this.selection?.wingmanId === pilotId;
    return {
      flewWithPlayer: flew,
      rescued: flew && !!s?.wingmanRescued,
      abandoned: flew && !!s?.wingmanAbandoned,
      playerLost: !!s?.playerLost,
      fallenName: this.lastLostWingman ? pilotDef(this.lastLostWingman).callsign : undefined,
    };
  }

  /**
   * 返事を1つ選ぶ。
   *
   * bond が動くのは**その出撃までで最初の1会話だけ**（`talkedSinceSortie`）。
   * 会話をやり直して同じ返事を選び続けても関係値は稼げない。
   */
  private answerBarTalk(pilot: PilotState, replyId: string): void {
    const input = {
      pilot,
      personality: pilotDef(pilot.id).personality,
      facts: this.barTalkFacts(pilot.id),
      state: this.barTalk,
    };
    const already = pilot.talkedSinceSortie === true;
    const result = chooseBarReply(input, replyId);
    this.barTalk = result.state;
    if (!already) shiftBond(pilot, result.bondDelta);
    // 会話を終えた相手は、次の出撃で指示に早く応える（loadoutFor の obedience）
    if (result.finished) {
      pilot.talkedSinceSortie = true;
      // 誰と話したかを艦の記憶に残す。次の帰艦で、その人の相棒や弟子が口にする。
      rememberBarTalk(this.save.roster, pilot.id);
    }
    writeSave(this.save);
    this.showRecRoom();
  }

  /**
   * 自室（T8-①で私信を追加）。
   *
   * 『Wing Commander: Prophecy』の barracks が持っていたメール端末に相当する。
   * 章・4状態・隊員の生死で受信箱の中身が変わるので、名簿と同じ画面に置く。
   */
  private showBarracks(): void {
    this.screens.show({
      background: artUrl('tex/bg-quarters', 'jpg'),
      title: '自室',
      bodyHtml: barracksHtml(this.hubContext()),
      items: [
        {
          label: `私信 — ${this.mailItems().length} 通`,
          onSelect: () => this.showMail(),
        },
        { label: '隊内の相関 — 誰と誰が繋がっているか', onSelect: () => this.showBondBoard() },
        { label: 'セーブスロットへ — 現在の戦役を保存', onSelect: () => this.showSaveSlots('save') },
        { label: 'セーブスロットからロード', onSelect: () => this.showSaveSlots('load') },
        { label: '戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
    });
  }

  /** いま届いている私信。章・4状態・隊員の生死で変わる。 */
  private mailItems() {
    const roster = this.save.roster;
    const dead = fallen(roster);
    return mailFor({
      ...this.rumorContext(),
      activePilots: availablePilots(roster).map((p) => p.id),
      fallenPilots: dead.map((p) => p.id),
      fallenNames: dead.map((p) => pilotDef(p.id).callsign),
    });
  }

  /** 私信（WCP の barracks のメール端末に相当）。 */
  private showMail(): void {
    this.screens.show({
      background: artUrl('tex/bg-quarters', 'jpg'),
      title: '私信',
      subtitle: 'QUARTERS / PERSONAL TERMINAL',
      bodyHtml: mailHtml({ ...this.hubContext(), mail: this.mailItems() }),
      items: [{ label: '戻る', onSelect: () => this.showBarracks() }],
      onCancel: () => this.showBarracks(),
    });
  }

  /** 隊内の相関の一覧。酒場で席に着かなくても、隊の繋がりを一望できる。 */
  private showBondBoard(): void {
    this.screens.show({
      background: artUrl('tex/bg-quarters', 'jpg'),
      title: '隊内の相関',
      subtitle: 'SQUADRON TIES',
      bodyHtml: bondBoardHtml(this.hubContext()),
      items: [{ label: '戻る', onSelect: () => this.showBarracks() }],
      onCancel: () => this.showBarracks(),
    });
  }

  /** 帰艦後の自室でだけ触れる、本家風8スロット記録画面。 */
  private showSaveSlots(mode: 'save' | 'load'): void {
    const slots = Array.from({ length: SAVE_SLOT_COUNT }, (_, slot) => ({ slot, save: loadSaveSlot(slot) }));
    const rows = slots.map(({ slot, save }) =>
      `<div class="mc-save-slot ${save ? 'filled' : 'empty'}"><b>SLOT ${slot + 1}</b>` +
      (save
        // 章の語順は progressLabel（`第N章 / 全K章`）と揃える。保存データの形式は変えない
        ? `<span>${escapeHtml(this.modeLabel(save.campaignMode))}　第${this.chapterOf(save.node, save.campaignMode)}章 / 全${totalChapters(save.campaignMode)}章　勝利点 ${save.seriesScore}　撃墜 ${save.totalKills}</span>`
        : '<span class="dim">空きスロット</span>') +
      `</div>`).join('');
    this.screens.show({
      background: artUrl('tex/bg-quarters', 'jpg'),
      title: mode === 'save' ? '戦役記録 — 保存' : '戦役記録 — ロード',
      subtitle: 'BARRACKS / 8 MEMORY SLOTS',
      bodyHtml: `<div class="block"><div class="dim">${mode === 'save' ? '帰艦後の現在状態を選んだスロットへ保存する。' : 'ロードすると現在の進行を置き換える。'}</div></div>` + rows,
      items: [
        ...slots.map(({ slot, save }) => ({
          label: mode === 'save'
            ? `SLOT ${slot + 1}へ保存${save ? ' (上書き)' : ''}`
            : `SLOT ${slot + 1}をロード`,
          disabled: mode === 'load' && !save,
          onSelect: () => {
            if (mode === 'save') {
              saveToSlot(this.save, slot);
              this.showSaveSlots('save');
              return;
            }
            const loaded = loadSaveSlot(slot);
            if (!loaded) return;
            this.save = loaded;
            this.newCampaignMode = loaded.campaignMode;
            this.selection = undefined;
            this.showHub();
          },
        })),
        { label: '戻る', onSelect: () => this.showBarracks() },
      ],
      onCancel: () => this.showBarracks(),
    });
  }

  private showKillBoard(): void {
    this.screens.show({
      background: artUrl('tex/bg-hangar', 'jpg'),
      title: 'キルボード',
      bodyHtml: killBoardHtml(this.hubContext()),
      items: [{ label: '戻る', onSelect: () => this.showHub() }],
      onCancel: () => this.showHub(),
    });
  }

  private frontlineSummary(): string {
    const systems = Object.entries(this.save.frontline.systems);
    return systems.map(([id, s]) => `${frontlineSystemName(id as FrontlineSystemId)} ${s.control.toFixed(0)}%`).join(' / ');
  }

  /** 勝敗で塗り替わる戦役の道筋。現在地と次に進み得る両方を同時に見せる。 */
  /**
   * 授与式などで名前を出す上官。
   * veil はハート艦長（人物名簿を単一の出所にする）、既存モードは従来のハルシオン大佐。
   */
  private commanderName(): string {
    // 名前の整形は `speakerName()` を再利用する（章側と同じ表記に揃え、解析を二重に書かない）
    return this.save.campaignMode === 'veil' ? `${speakerName('confed-06')} 艦長` : 'ハルシオン大佐';
  }

  /**
   * 画面の背景画。
   *
   * 十章キャンペーンでは章ごとの生成画像（`tex/story-chNN.jpg`）を使い、
   * 「どの空域の話か」を絵でも示す。章が特定できない場面は既定の背景に落とす。
   */
  private chapterBackground(): string {
    if (this.save.campaignMode !== 'veil' || isTerminal(this.save.node)) {
      return artUrl('tex/bg-briefing', 'jpg');
    }
    const chapter = campaignNode(this.save.node, 'veil').chapter;
    return artUrl(`tex/story-ch${String(chapter).padStart(2, '0')}`, 'jpg');
  }

  /** 4状態を1行で並べる。ハブと作戦記録で同じ表現を使う */
  private narrativeGaugeLine(): string {
    const summary = narrativeSummary(this.save.narrative);
    const gauges = [summary.returnees, summary.routeTrust, summary.commandTrust, summary.aceOath]
      .map((g) => `${escapeHtml(g.label)} <b>${g.value}</b>（${escapeHtml(g.grade)}）`)
      .join('　');
    const relays = this.save.narrative.relaysHeld;
    return `${gauges}　名簿 <b>${this.save.narrative.returnees.length}</b> 名` +
      (relays === undefined ? '' : `　通信灯台 <b>${relays}/${MAX_RELAYS}</b>`);
  }

  /**
   * 十章キャンペーンの進行表示。
   *
   * veil は勝敗で分岐しない（敗北でも次章へ進み、達成しなかった条件は記録として残る）ため、
   * 分岐グラフではなく章順の一覧と、選択で動く4状態を見せる。
   */
  private veilChapterMapHtml(): string {
    const graph = campaignGraph('veil');
    const done = new Map(this.save.campaignHistory.map((h) => [h.node, h.outcome]));
    const current = this.save.node;
    const rows = Object.entries(graph)
      .sort(([, a], [, b]) => a.chapter - b.chapter)
      .map(([id, node]) => {
        const outcome = done.get(id);
        const status = id === current ? 'current' : outcome ? `completed-${outcome}` : 'unreached';
        const label = id === current ? '現在地' : outcome === 'win' ? '達成' : outcome === 'loss' ? '記録に残す' : '未到達';
        return `<div class="mc-campaign-node ${status}">` +
          `<span class="mc-campaign-node-status">${escapeHtml(label)}</span>` +
          `<div><b>第${node.chapter}章 ${escapeHtml(node.seriesName)}</b>` +
          `<div class="dim">${escapeHtml(node.system)}　${escapeHtml(node.victoryCondition)}</div></div>` +
          `</div>`;
      })
      .join('');
    const n = this.save.narrative;
    return `<div class="block mc-campaign-map"><h3>作戦記録 — 全${totalChapters('veil')}章</h3>` +
      `<div class="dim">${this.narrativeGaugeLine()}</div>` +
      `<div class="dim">帰還者 <b>${n.returnees.length}</b> 名　${escapeHtml(this.save.campaignSituation)}</div>` +
      rows + `</div>`;
  }

  private campaignMapHtml(): string {
    if (this.save.campaignMode === 'veil') return this.veilChapterMapHtml();
    const entries = campaignMap(this.save.campaignMode, this.save.node, this.save.campaignHistory);
    const statusLabel: Record<string, string> = {
      current: '現在地',
      'completed-win': '勝利',
      'completed-loss': '敗北 / 撤退',
      reachable: '次の分岐',
      unreached: '未到達',
      terminal: '終端',
    };
    const rows = entries.map((entry) => {
      const n = entry.node;
      const title = n ? `${n.seriesName} — ${n.system}` : entry.id === VICTORY ? '戦役勝利' : '戦役敗北';
      const detail = n ? `${n.missionType}　勝利点 ${n.victoryPoints}　${n.victoryCondition}` : 'この戦役の結果は保存される。';
      const route = entry.incoming === 'win' ? '勝利側から到達' : entry.incoming === 'loss' ? '敗北側から到達' : '';
      return `<div class="mc-campaign-node ${entry.status}">` +
        `<span class="mc-campaign-node-status">${escapeHtml(statusLabel[entry.status] ?? entry.status)}</span>` +
        `<div><b>${escapeHtml(title)}</b><div class="dim">${escapeHtml(detail)}${route ? `　${escapeHtml(route)}` : ''}</div></div>` +
        `</div>`;
    }).join('');
    return `<div class="block mc-campaign-map"><h3>戦役マップ — ${escapeHtml(this.modeLabel(this.save.campaignMode))}</h3>` +
      `<div class="dim">シリーズ勝利点 <b>${this.save.seriesScore}</b>　履歴 ${this.save.campaignHistory.length} 任務　${escapeHtml(this.save.campaignSituation)}</div>` +
      rows + `</div>`;
  }

  private showFrontline(): void {
    const active = this.save.dynamicMission;
    /*
     * 戦況マップ (T3-⑫)。
     *
     * `frontlineHtml()` が 8戦域の星系図（章の順路・現在地・4状態の設置場所）を描く。
     * veil が本編なのに expanded だけがこれを見られる状態だったので、veil でも出す。
     * canon は Enyo → McAuliffe → Gateway の固定戦役で 8戦域を持たないため、従来の文のまま。
     */
    const frontlinePanel =
      this.save.campaignMode === 'veil'
        ? frontlineHtml(this.hubContext())
        : this.save.campaignMode === 'expanded'
          ? frontlineHtml(this.hubContext()) +
            `<div class="block"><h3>独自拡張の作戦方針</h3><div class="dim">${escapeHtml(FRONTLINE_SYSTEM_IDS.map(frontlineSystemName).join(' / '))} の動的前線作戦は EXPANDED モードでのみ発生する。</div></div>`
          : `<div class="block"><h3>CANON 戦役</h3><div class="dim">この画面では Enyo → McAuliffe → Gateway の固定戦役だけを表示する。独自前線作戦は発生しない。</div></div>`;
    this.screens.show({
      background: artUrl('tex/bg-briefing', 'jpg'),
      title: '戦況マップ',
      /*
       * veil では**星系図を先頭に置く** (T3-⑫)。
       *
       * `campaignMapHtml()` は十章の一覧で 10 ブロックの縦長になるため、後ろに置いた
       * 星系図が画面の外へ押し出され、開いた瞬間には地図が見えなかった
       * （この画面の目的は「なぜ今この任務なのかが1枚で分かる」ことなので、
       * 地図が最初に見えないと意味がない）。一覧は地図の下で読む。
       */
      bodyHtml:
        this.save.campaignMode === 'veil'
          ? frontlinePanel + this.campaignMapHtml()
          : this.campaignMapHtml() + frontlinePanel,
      items: [
        ...(this.save.campaignMode === 'expanded' ? (active
          ? [{ label: '選択中の戦況作戦を確認', onSelect: () => this.showHub() }]
          : [{
              label: '最も危険な星系へ作戦を立てる',
              onSelect: () => {
                this.save.dynamicMission = chooseDynamicMission(this.save.frontline, this.save.node, this.save.sorties + this.save.frontline.operations + 1);
                writeSave(this.save);
                this.showHub();
              },
            }]) : []),
        { label: '戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
    });
  }

  /**
   * 名鑑。人物・機体・戦域を実装データから生成して見せる。
   *
   * 76名を1枚に出すとスクロールが必要になるので、勢力ごとにページを切る
   * （`AI_CODING.md`「スクロールバーを廃止するなら情報が欠落しないように」）。
   */
  private showCodex(page: CodexPage): void {
    const current = CODEX_PAGES.find((p) => p.id === page) ?? CODEX_PAGES[0];
    this.screens.show({
      title: '名鑑',
      subtitle: `${current.label}　—　THE VEIL FRONT / 統合暦 ${VEIL_ERA.year}`,
      background: artUrl('tex/bg-quarters', 'jpg'),
      bodyHtml: codexHtml(current.id),
      items: [
        ...CODEX_PAGES.filter((p) => p.id !== current.id).map((p) => ({
          label: p.label,
          onSelect: () => this.showCodex(p.id),
        })),
        { label: '艦内へ戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
      hint: '▲▼ でページを選択 / Enter で決定 / Esc で戻る',
    });
  }

  private showStatistics(): void {
    this.screens.show({
      background: artUrl('tex/bg-quarters', 'jpg'),
      title: '統計',
      bodyHtml: statisticsHtml(this.hubContext()),
      items: [{ label: '戻る', onSelect: () => this.showHub() }],
      onCancel: () => this.showHub(),
    });
  }

  private trainingDef(): MissionDef {
    const ref = { id: `training-${this.trainingKind}`, system: 'orion-port' as const, kind: this.trainingKind, seed: 99, returnNode: this.save.node };
    const base = dynamicMissionDef(ref);
    if (this.trainingKind === 'quiet') return { ...base, title: '訓練室 — 航法・帰投', debriefWin: ['航法訓練を終了した。'], debriefLoss: ['訓練を中断した。'] };
    const spawns = base.spawns.map((g) => ({ ...g, skill: this.trainingSkill, count: g.faction === 'kilrathi' ? this.trainingEnemyCount : g.count }));
    return { ...base, id: `training-${this.trainingKind}`, title: `訓練室 — ${base.title}`, spawns, debriefWin: ['訓練終了。実戦では、敵も弾も戻ってこない。'], debriefLoss: ['訓練を中断した。機体を点検してもう一度試せる。'] };
  }

  private tutorialDef(mode: TutorialCourse): MissionDef {
    const base = dynamicMissionDef({
      id: `tutorial-${mode}`,
      system: 'orion-port',
      kind: 'patrol',
      seed: 707,
      returnNode: this.save.node,
    });
    const tutorialSpawns: MissionDef['spawns'] = base.spawns.map((group) => ({
      ...group,
      // ターゲット操作の案内が出る前に敵を配置し、T/R/Y をすぐ試せるようにする。
      atNav: undefined,
      delay: 0,
      offset: group.offset ?? [0, 0, -1800],
    }));
    if (mode === 'demo') {
      /*
       * お手本モードは実演の途中で敵を落としてしまうので、敵を切らさないよう
       * 時間差の増援を宣言する。ミサイル・フレア・ドッグファイトの実演は
       * 「相手が居ないと実演にならない」ため、ここで供給を保証する。
       *
       * 実演の秒数の合計はターゲット段まで約 50 秒、ミサイル段が約 70 秒、
       * ドッグファイト段が約 100 秒。増援の `delay` はそれに合わせている
       * (やさしい難易度では `waveDelayBonus` で +12 秒される)。
       * それでも間に合わない場合は、実演側が敵が出るまで待つ
       * (`ui/TutorialDemo.ts` の `requiresHostile`)。
       */
      tutorialSpawns.push(
        { shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', delay: 0, offset: [900, 200, -2400], tag: 'demo-wave' },
        { shipId: 'kf03-greyhaul', count: 2, faction: 'kilrathi', delay: 40, offset: [-1200, -300, -2600], tag: 'demo-wave' },
        { shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', delay: 70, offset: [1500, 400, -2200], tag: 'demo-wave' },
        { shipId: 'kf03-greyhaul', count: 2, faction: 'kilrathi', delay: 105, offset: [-900, 200, -2800], tag: 'demo-wave' },
      );
    }
    return {
      ...base,
      id: `tutorial-${mode}`,
      title:
        mode === 'demo'
          ? 'お手本モード — 操作訓練空域'
          : mode === 'detailed'
            ? '詳細チュートリアル — 操作訓練空域'
            : '簡易チュートリアル — 操作訓練空域',
      briefing: [
        'これは独立した訓練空域だ。キャンペーンの記録や補給は変化しない。',
        mode === 'demo'
          ? '操作はこちらで実演する。押しているキーが画面に出るので、それを見てから自分で試せ。'
          : mode === 'detailed'
            ? '画面下の指示に従い、入力・HUD・戦闘・航法を順番に確認せよ。'
            : '画面下の指示に従い、まずは飛行と戦闘の基本を確認せよ。',
      ],
      playerShipId: 'hornet',
      // お手本モードは実演とドッグファイトで撃ち続けるので、弾数を多めに積む。
      // (搭載数・HUD の残弾・実際の消費はすべてこの宣言から作られる)
      playerMissiles:
        mode === 'demo'
          ? [
              { missileId: 'dumbfire', count: 6 },
              { missileId: 'heat-seeker', count: 8 },
            ]
          : [
              { missileId: 'dumbfire', count: 3 },
              { missileId: 'heat-seeker', count: 3 },
            ],
      spawns: tutorialSpawns,
      debriefWin: ['訓練を終了した。'],
      debriefLoss: ['訓練を中断した。'],
      // 操作確認を終えるまで空域を維持する。終了はポーズ画面から行う。
      objectives: [{ id: 'practice', text: '操作を確認する', required: true, spec: { kind: 'survive', seconds: 999999 } }],
    };
  }

  private launchTutorial(mode: TutorialCourse): void {
    const def = this.tutorialDef(mode);
    const load: Loadout = {
      shipId: def.playerShipId,
      gunId: 'laser',
      missiles: def.playerMissiles,
      flares: mode === 'demo' ? 20 : 12,
      wingmanSlot: 2,
    };
    this.tutorialActive = true;
    this.tutorialMode = mode;
    this.trainingActive = false;
    this.screens.hide();
    this.game.startMission(def, load, mode);
  }

  private showTutorialEnd(outcome: 'win' | 'loss'): void {
    this.game.sound.music.play(outcome === 'win' ? 'victory' : 'defeat');
    this.screens.show({
      title: outcome === 'win' ? '訓練終了' : '訓練中断',
      bodyHtml: `<div class="block">訓練空域を離れた。キャンペーンの記録・補給・名簿は変更されていない。</div>`,
      items: [
        { label: '同じチュートリアルをもう一度', onSelect: () => this.launchTutorial(this.tutorialMode) },
        { label: 'チュートリアル選択へ', onSelect: () => this.showTutorialMenu() },
        { label: 'タイトルへ戻る', onSelect: () => this.showTitle() },
      ],
      onCancel: () => this.showTutorialMenu(),
    });
  }

  private showTraining(): void {
    const kinds: DynamicMissionKind[] = ['patrol', 'escort', 'strike', 'rescue', 'quiet', 'capital'];
    this.screens.show({
      background: artUrl('tex/bg-hangar', 'jpg'),
      title: '訓練室',
      bodyHtml: `<div class="block"><h3>実戦前訓練</h3><div class="dim">キャンペーンの戦果・名簿・戦況は変わらない。操作、武装、帰投手順を確認できる。</div></div>` +
        `<div class="block">種目: <b>${escapeHtml(this.trainingKind)}</b><br>敵機数: <b>${this.trainingKind === 'quiet' ? 'なし' : this.trainingEnemyCount}</b><br>敵技量: <b>${Math.round(this.trainingSkill * 100)}%</b></div>`,
      items: [
        { label: `種目を変える (${this.trainingKind})`, onSelect: () => { this.trainingKind = kinds[(kinds.indexOf(this.trainingKind) + 1) % kinds.length]; this.showTraining(); } },
        { label: `敵機数を変える (${this.trainingEnemyCount})`, disabled: this.trainingKind === 'quiet', onSelect: () => { this.trainingEnemyCount = this.trainingEnemyCount >= 6 ? 1 : this.trainingEnemyCount + 1; this.showTraining(); } },
        { label: `敵技量を変える (${Math.round(this.trainingSkill * 100)}%)`, disabled: this.trainingKind === 'quiet', onSelect: () => { this.trainingSkill = this.trainingSkill >= 0.9 ? 0.3 : this.trainingSkill + 0.15; this.showTraining(); } },
        { label: '訓練を開始', onSelect: () => this.launchTraining() },
        { label: '戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
    });
  }

  private launchTraining(): void {
    const def = this.trainingDef();
    const load = this.loadoutFor(def);
    this.trainingActive = true;
    this.tutorialActive = false;
    this.screens.hide();
    this.game.startMission(def, load, false);
  }

  private showTrainingDebrief(outcome: 'win' | 'loss'): void {
    const s = this.lastSummary;
    this.game.sound.music.play(outcome === 'win' ? 'victory' : 'defeat');
    this.screens.show({
      title: outcome === 'win' ? '訓練終了' : '訓練中断',
      bodyHtml: `<div class="block"><h3>訓練記録</h3><ul><li>撃墜 ${s?.kills ?? 0}</li><li>発射 ${s?.shotsFired ?? 0}　命中 ${s?.hits ?? 0}</li><li>飛行時間 ${Math.floor(s?.seconds ?? 0)} 秒</li></ul></div>` +
        `<div class="dim">キャンペーンの資源と名簿は変化していない。</div>`,
      items: [
        { label: 'リプレイ / キルカム', disabled: this.game.replay.length < 2, onSelect: () => this.showReplayPanel(() => this.showTrainingDebrief(outcome)) },
        { label: '記録を保存 (JSON)', onSelect: () => this.downloadPlaytestLog() },
        { label: '訓練室へ戻る', onSelect: () => this.showTraining() },
        { label: '艦内へ戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showTraining(),
    });
  }

  /** 直前30秒の戦闘を停止画面から安全に見返す。 */
  private showReplayPanel(back: () => void): void {
    if (this.game.replay.length < 2) {
      back();
      return;
    }
    const panel = new ReplayPanel(this.game.replay);
    this.replayPanel = panel;
    const close = () => {
      panel.dispose();
      if (this.replayPanel === panel) this.replayPanel = undefined;
      back();
    };
    this.screens.show({
      background: artUrl('tex/bg-space', 'jpg'),
      title: 'リプレイ / キルカム',
      subtitle: '直近30秒 — 固定ステップ記録',
      content: panel.el,
      items: [{ label: 'デブリーフへ戻る', onSelect: close }],
      onCancel: close,
      hint: '再生画面のボタンで速度・視点・時間を操作 / Esc で戻る',
    });
  }

  /** 通しプレイの任務記録を、検証担当がそのまま共有できる JSON で保存する。 */
  private downloadPlaytestLog(): void {
    const blob = new Blob([this.game.exportPlaytestLog()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `multi-commander-playtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** 格納庫: 機体と僚機を選ぶ */
  private showHangar(): void {
    const def = this.currentMission();
    const sel = this.ensureSelection(def);
    const displayLoadout = this.loadoutFor(def);
    const ships = PLAYABLE_SHIPS.filter((id) =>
      shipDef(id).missiles.length === 0 || shipDef(id).missiles.some((m) => availableMissiles(this.save.supplies, m.missileId) > 0),
    );
    if (ships.length && !ships.includes(sel.shipId as (typeof ships)[number])) sel.shipId = ships[0];
    const shipPool = ships.length ? ships : [sel.shipId];
    const avail = availablePilots(this.save.roster);

    const items: MenuItem[] = [
      {
        label: `機体を変える (${escapeHtml(shipDef(sel.shipId).name)})`,
        disabled: ships.length === 0,
        onSelect: () => {
          const i = shipPool.indexOf(sel.shipId);
          sel.shipId = shipPool[(i + 1) % shipPool.length];
          // 機体を変えたら副兵装は機体の既定に戻す
          sel.missiles =
            sel.shipId === def.playerShipId ? clampLoadout(this.save.supplies, def.playerMissiles) : undefined;
          this.showHangar();
        },
      },
    ];
    const gunIds = Object.keys(GUNS);
    items.push({
      label: `主砲を変える (${sel.gunId ? GUNS[sel.gunId]?.name ?? sel.gunId : '機体標準'})`,
      onSelect: () => {
        const current = sel.gunId ? gunIds.indexOf(sel.gunId) : -1;
        sel.gunId = gunIds[(current + 1) % gunIds.length];
        this.showHangar();
      },
    });
    const missileIds = Object.keys(MISSILES).filter((id) => availableMissiles(this.save.supplies, id) > 0);
    items.push({
      label: `副兵装セットを変える (${sel.missiles?.[0] ? missileDef(sel.missiles[0].missileId).shortName : '機体標準'})`,
      disabled: missileIds.length === 0,
      onSelect: () => {
        if (missileIds.length === 0) return;
        const current = sel.missiles?.[0] ? missileIds.indexOf(sel.missiles[0].missileId) : -1;
        const missileId = missileIds[(current + 1) % missileIds.length];
        sel.missiles = [{ missileId, count: Math.min(4, availableMissiles(this.save.supplies, missileId)) }];
        this.showHangar();
      },
    });
    if (avail.length > 0) {
      items.push({
        label: `僚機を変える (${sel.wingmanId ? escapeHtml(pilotDef(sel.wingmanId).callsign) : '単独'})`,
        onSelect: () => {
          const ids = avail.map((p) => p.id);
          const i = sel.wingmanId ? ids.indexOf(sel.wingmanId) : -1;
          sel.wingmanId = ids[(i + 1) % ids.length];
          sel.wingmanSlot = ((sel.wingmanSlot ?? 2) % 4) + 1;
          this.save.roster.lastWingman = sel.wingmanId;
          this.showHangar();
        },
      });
      items.push({
        label: '単独で出撃する',
        onSelect: () => {
          sel.wingmanId = undefined;
          this.showHangar();
        },
      });
    }
    items.push({ label: '戻る', onSelect: () => this.showHub() });

    this.screens.show({
      background: artUrl('tex/bg-hangar', 'jpg'),
      title: '格納庫',
      bodyHtml: hangarHtml(
        this.hubContext(),
        { ...sel, missiles: displayLoadout.missiles },
        def.playerShipId,
      ),
      items,
      onCancel: () => this.showHub(),
    });
  }

  /**
   * 選任した主人公の呼称（T3-⑬）。
   *
   * 表記は必ず `speakerName()` を通す（名簿は `朝倉 澪（アサクラ ミオ）` と
   * `Amina Okafor（アミナ・オカフォー）` の2種類が混在しているため、
   * 各所で括弧を剥がすと表記が崩れる）。
   */
  private protagonistLabel(): string | undefined {
    const id = this.save.protagonistId;
    if (!id) return undefined;
    try {
      const person = veilPerson(id);
      const name = speakerName(id);
      return person.epithet ? `${name}　“${person.epithet}”` : name;
    } catch {
      // 保存データに未知の人物 id が入っていてもブリーフィングを壊さない
      return undefined;
    }
  }

  /**
   * 艦長の台詞に、選任した主人公あての1行を足す（T5-⑬c）。
   *
   * 呼称と内容は `src/content/dialogue.ts` の `PROTAGONIST_VOICES` が唯一の出所で、
   * ここでは組み立て直さない。未選択（旧セーブ）や未知の id では**何も足さない**ので、
   * 従来のブリーフィング／デブリーフィングがそのまま出る。
   */
  private withProtagonistLine(lines: string[], extra: string | undefined): string[] {
    return extra ? [...lines, extra] : lines;
  }

  private showBriefing(): void {
    if (isTerminal(this.save.node)) {
      this.showEnding(this.save.node === VICTORY);
      return;
    }
    const node = campaignNode(this.save.node, this.save.campaignMode);
    this.game.sound.music.play('briefing');
    const def = this.currentMission();
    const ship = shipDef(def.playerShipId);
    const load = this.loadoutFor(def);
    const missiles = (load.missiles ?? ship.missiles)
      .map((m) => `${missileDef(m.missileId).name} ×${m.count}`)
      .join(' / ');

    // 目標の表記は HUD・デブリーフと同じ出所（`src/mission/MissionRunner.ts` の
    // `objectiveRewardTag`）から作る。ここで `(任意)` を組み立て直すと、
    // 加点表記が反映されずブリーフィングだけ古い表記になる。
    const objectives = def.objectives
      .map((o) => {
        const prefix = objectiveRewardPrefix(o);
        // 必須は従来どおりそのまま、加点は前置だけを薄く出す（見え方は維持）
        return prefix
          ? `<li><span class="dim">${escapeHtml(prefix)}</span>${escapeHtml(o.text)}</li>`
          : `<li>${escapeHtml(o.text)}</li>`;
      })
      .join('');

    const wing = load.wingman?.callsign;
    const pilotLabel = this.protagonistLabel();
    // 僚機の一言。主人公をどう呼ぶかが、ここで初めて目に入る（T5-⑬c）
    const wingReady = protagonistWingReadyLine(this.save.protagonistId);
    const briefingLines = this.withProtagonistLine(
      def.briefing,
      protagonistBriefingLine(this.save.protagonistId),
    );
    const scene = this.briefingScene(def, briefingLines, [
      { html: `<div class="block"><h3>任務目標</h3><ul>${objectives}</ul></div>`, slot: 'lower-left' },
      { html: `<div class="block"><h3>飛行計画</h3>${this.navMapSvg(def)}</div>`, slot: 'flight-plan' },
      { html: `<div class="block"><h3>機体</h3>` +
        `${escapeHtml(ship.name)}<br><span class="dim">副兵装: ${escapeHtml(missiles || 'なし')}` +
        // 選任した主人公が「誰として飛んでいるか」を出す唯一の場所（T3-⑬）
        `${pilotLabel ? `<br>搭乗: ${escapeHtml(pilotLabel)}` : ''}` +
        `${wing ? `<br>僚機: ${escapeHtml(wing)}` : ''}` +
        `${wing && wingReady ? `<br><span class="mc-wing-ready">「${escapeHtml(wingReady)}」</span>` : ''}</span></div>`, slot: 'lower-right' },
    ]);

    this.screens.show({
      variant: 'briefing',
      crest: artUrl('emblem-confed'),
      crestHeight: 64,
      background: this.chapterBackground(),
      title: def.title,
      // ヘッダは最低限にする（横に溢れるとメインの領域を食う）。
      // veil は題名に「第N章 …」が入っていて章番号が二重になるが、副題は
      // 「/ 全10章」を持つので情報が違う（あと何章あるかが分かる）ため残す。
      subtitle:
        this.save.campaignMode === 'veil'
          ? `${this.progressLabel()}　${node.seriesName}　—　${def.system}`
          : `${this.modeLabel(this.save.campaignMode)}　${this.progressLabel()}　${node.seriesName}` +
            `　—　${def.system} 星系${node.losingRoute ? '　(戦況悪化)' : ''}`,
      content: scene.el,
      items: [
        {
          label: this.shouldTutorial() ? '出撃 (操作案内あり)' : '出撃',
          onSelect: () => this.launch(this.shouldTutorial()),
        },
        ...(this.shouldTutorial()
          ? [
              {
                label: '操作案内なしで出撃',
                onSelect: () => {
                  updateSettings({ tutorialDone: true });
                  this.launch(false);
                },
              },
            ]
          : []),
        { label: '艦内へ戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
      hint: `Space で読み進める / Esc で読み飛ばす　—　難易度: ${difficulty().label}`,
    });
  }

  /**
   * ブリーフィング/デブリーフィングの喋る顔を組み立てる。
   *
   * 音声は使わず、口の動きと文字送りで台詞の進行を見せる。
   * 画面から外れたら BriefingScene が自分で後片付けする。
   */
  private briefingScene(
    def: MissionDef,
    lines: string[],
    panels: BriefingPanel[],
    statusLabel?: string,
    mood?: Expression,
  ): BriefingScene {
    const scene = new BriefingScene({
      speakerId: def.briefingSpeakerId ?? 'halcyon',
      speakerName: def.briefingSpeaker,
      speakerRole: def.briefingSpeakerRole ?? `${CLAW_NAME}　艦長`,
      lines,
      // 顔画像が無い人物のときだけ使われる
      fallback: { skin: '#d8b894', hair: '#9aa0a0', hairStyle: 'short', eyes: 'sharp', marks: ['scar'] },
      panels,
      // 1行目は挨拶なので、資料は2行目から開いていく
      panelDelay: 1,
      statusLabel,
      mood,
    });
    scene.el.classList.add('mc-panel');
    // ScreenHost が DOM に載せた後に動かす
    requestAnimationFrame(() => scene.start());
    return scene;
  }

  /** 飛行計画の簡易マップ (XZ 平面を上から見た図) */
  private navMapSvg(def: MissionDef): string {
    const pts = [[0, 0, 0] as const, ...def.navs.map((n) => n.pos)];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, , z] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const span = Math.max(spanX, spanZ);
    const map = (x: number, z: number) => {
      const px = 20 + ((x - (minX + maxX) / 2) / span + 0.5) * 160;
      const py = 20 + ((z - (minZ + maxZ) / 2) / span + 0.5) * 180;
      return [px, py] as const;
    };

    const nodes: string[] = [];
    const path: string[] = [];
    pts.forEach((p, i) => {
      const [px, py] = map(p[0], p[2]);
      path.push(`${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`);
      const label = i === 0 ? '母艦' : def.navs[i - 1].name;
      nodes.push(
        `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${i === 0 ? 5 : 3.5}" fill="${i === 0 ? '#5fd8ff' : '#7fe3b0'}"/>` +
          `<text x="${(px + 7).toFixed(1)}" y="${(py + 3).toFixed(1)}" font-size="7" fill="#8fbfa8">${escapeHtml(label)}</text>`,
      );
    });

    return (
      `<svg viewBox="0 0 200 220" style="width:100%;background:rgba(4,10,12,0.6);border:1px solid rgba(127,227,176,0.25)">` +
      `<path class="mc-navpath" d="${path.join(' ')}" fill="none" stroke="rgba(127,227,176,0.55)" ` +
      `stroke-width="1" stroke-dasharray="3 3"/>` +
      nodes.join('') +
      `</svg>`
    );
  }

  private launch(withTutorial = false): void {
    const def = this.currentMission();
    const load = this.loadoutFor(def);
    // 出撃前のエース記録を控える。座席の扱い・名乗り・決闘は累積で持たれているので、
    // 「この出撃で何をしたか」は前後の差分でしか取れない (T4-⑯ → 誓約への反映)。
    this.aceTallyAtLaunch = aceTally(this.save.aceStates);
    consumeLoadout(this.save.supplies, load.missiles);
    this.save.supplies.flares = Math.max(0, this.save.supplies.flares - (load.flares ?? 0));
    this.screens.hide();
    if (!this.trainingActive) this.save.sorties++;
    writeSave(this.save);
    this.game.startMission(def, load, withTutorial);
  }

  /** 初回プレイの1本目だけ訓練案内を出す */
  private shouldTutorial(): boolean {
    return !settings.tutorialDone && this.save.node === campaignStart(this.save.campaignMode);
  }

  private onMissionEnd(outcome: 'win' | 'loss'): void {
    this.lastSummary = this.game.runner?.summary();
    this.lastChoiceEffects = undefined;
    if (this.tutorialActive) {
      this.tutorialActive = false;
      this.showTutorialEnd(outcome);
      return;
    }
    if (this.trainingActive) {
      this.trainingActive = false;
      this.showTrainingDebrief(outcome);
      return;
    }
    this.applyRosterOutcome();
    // 章末の選択は「今飛んだ章」に対して記録するので、キャンペーンを進める前に出す。
    this.showChapterChoice(() => this.showDebrief(outcome));
  }

  /**
   * 章末の FIELD CHOICE。
   *
   * veil モードで、今のノードに選択肢があり、まだ選んでいない章のときだけ出す。
   * `applyChoice` は同じ章で二度加算しないので、再表示されても状態は壊れない。
   */
  private showChapterChoice(after: () => void): void {
    if (this.save.campaignMode !== 'veil' || isTerminal(this.save.node)) {
      after();
      return;
    }
    const node = campaignNode(this.save.node, 'veil');
    const chapter = VEIL_CHAPTERS.find((c) => c.id === this.save.node);
    if (!chapter || this.save.narrative.choices[chapter.id]) {
      after();
      return;
    }
    // T2-④: 出撃結果で選択肢と状況説明を差し替える。
    // `resolveVeilChoice` は必ず2つ以上返すので、選択画面は常に成立する。
    const choice = resolveVeilChoice(chapter.choice, this.sortieFacts());
    const scene = new ChoiceScene({
      choice,
      chapterLabel: `第${node.chapter}章`,
      onSelect: (choiceId) => {
        const option = choice.options.find((o) => o.id === choiceId);
        if (option) {
          // デブリーフに「方針」として増減を出す（選択が小さいことを読ませる）
          this.lastChoiceEffects = { label: option.label, effects: option.effects };
          // 章データの `returnees` は「名前が判らない増減（人数）」なので、
          // 名簿（名前の配列）ではなくクレジットとして渡す。
          // 名前の付く帰還者は出撃結果の側から記録される。
          const { returnees, ...rest } = option.effects;
          applyChoice(this.save.narrative, chapter.id, choiceId, {
            ...rest,
            ...(returnees === undefined ? {} : { returneeCredit: returnees }),
          });
        }
        // 第10章の選択は門の管理方法そのもの。結末の分岐に使うので別に保存する。
        // 選択肢id（`seal-gate` 等）と結末id（`closed` 等）は別なので必ず変換を通す。
        if (node.chapter === 10) {
          try {
            this.save.gateOutcome = gateOutcomeFromChoice(choiceId);
          } catch {
            // 章データに門以外の選択肢が増えても結末選択を壊さない
          }
        }
        writeSave(this.save);
        scene.dispose();
        after();
      },
    });
    this.screens.show({
      title: chapter.choice.kind,
      subtitle: `第${node.chapter}章 ${chapter.title}`,
      background: this.chapterBackground(),
      content: scene.el,
      hint: scene.hint,
    });
    scene.start();
  }

  /**
   * 出撃結果を名簿へ反映する。
   * 僚機の戦死はここで確定し、以後その人物は二度と出撃候補に現れない。
   */
  private applyRosterOutcome(): void {
    const s = this.lastSummary;
    const sel = this.selection;
    const outcome: SortieOutcome = {
      wingmanId: sel?.wingmanId,
      wingmanLost: !!s?.wingmanLost,
      wingmanKills: s?.wingmanKills ?? 0,
      wingmanHullRatio: s?.wingmanHullRatio ?? 1,
      rescued: !!s?.wingmanRescued,
      abandoned: !!s?.wingmanAbandoned,
      missionTitle: this.currentMission().title,
      chapter: this.chapterOf(this.save.node),
    };
    if (outcome.wingmanLost) this.save.noWingmanLost = false;
    if (s?.escortLost) this.save.noEscortLost = false;
    this.save.acesKilled += s?.acesKilled ?? 0;
    applySortie(this.save.roster, outcome);
    this.lastLostWingman = outcome.wingmanLost ? outcome.wingmanId : undefined;
    // 帰艦したら酒場の会話は最初から（近況が新しい出撃結果に入れ替わる）
    this.barPilotId = undefined;
    this.barTalk = undefined;
    this.barBanter = undefined;
  }

  /**
   * この出撃で「実際にやったこと」(T2-③/④)。
   *
   * 4状態の増減（`sortieNarrative`）と、章末の選択肢の出方（`resolveVeilChoice`）は
   * どちらもこの1つの値だけを入力にする。**難易度・機体・所持兵装は含めない。**
   */
  private sortieFacts(): SortieFacts {
    const s = this.lastSummary;
    return {
      rescued: s?.rescued ?? 0,
      enemyRescued: s?.enemyRescued ?? 0,
      escortSurvivors: s?.escortSurvivors ?? 0,
      escortTotal: s?.escortTotal ?? 0,
      wingmenSurvived: s?.wingmenSurvived ?? 0,
      wingmenLost: s?.wingmenLost ?? 0,
      civilianLosses: s?.civilianLosses ?? 0,
      friendlyFireHits: s?.friendlyFireHits ?? 0,
      shotsFired: s?.shotsFired ?? 0,
      playerLost: s?.playerLost ?? false,
      objectivesFailed: s?.objectivesFailed.length ?? 0,
      // summary().grade は撃墜された出撃を必ず failed にしている（T1-①）
      grade: s?.grade ?? 'failed',
      ...this.aceSortieTally(),
    };
  }

  /**
   * この出撃でのエースとのやりとり (T4-⑯)。
   *
   * `AceState` は累積で持つので、出撃前に控えた値との差分を取る。
   * 差分が負になることはないが、旧セーブや不整合で負が出ても 0 に丸める。
   */
  private aceSortieTally(): Pick<
    SortieFacts,
    'acePodsSpared' | 'acePodsExecuted' | 'aceNamesExchanged' | 'aceDuelsAccepted'
  > {
    const before = this.aceTallyAtLaunch ?? EMPTY_ACE_TALLY;
    const after = aceTally(this.save.aceStates);
    const d = (a: number, b: number) => Math.max(0, a - b);
    return {
      acePodsSpared: d(after.spared, before.spared),
      acePodsExecuted: d(after.executed, before.executed),
      aceNamesExchanged: d(after.namesExchanged, before.namesExchanged),
      aceDuelsAccepted: d(after.duelsAccepted, before.duelsAccepted),
    };
  }


  /**
   * 出撃結果を4状態へ反映する（十章作戦記録 §03 / T2-③）。
   *
   * 撃墜数は一切見ない。見るのは「誰を帰したか」「守り切ったか」「撃たずに済ませたか」
   * 「民間を損なわなかったか」「命令の範囲で収めたか」だけである。
   * 重みの配分は `sortieNarrative` に置いてあり（1状態あたり最大 ±12）、
   * 章末の選択（1状態あたり最大 ±5）より必ず大きい。
   */
  private applySortieToNarrative(): { lines: NarrativeLine[]; extras: NarrativeChange[] } {
    const s = this.lastSummary;
    if (!s) return { lines: [], extras: [] };
    const chapter = campaignNode(this.save.node, 'veil').chapter;
    const n = this.save.narrative;
    const extras: NarrativeChange[] = [];

    const result = sortieNarrative(this.sortieFacts());
    adjustNarrative(n, result.delta);

    /*
     * 連れ帰った者を名簿と累積へ積む (T4-⑮)。
     *
     * `rescuedNames` は「自分の手で収容した人」の名前で、`MissionRunner` が
     * `SpawnGroupDef.displayName(s)` から解決したもの。ここでは作らない。
     * - `save.rescuedNames`: 第10章の読み上げが過去章の分まで読むための累積（重複なし）
     * - 名簿（`returneeLog`）: 帰還者の指標。`addReturneeEntries` が重複を弾く
     */
    const broughtHome = s.rescuedNames ?? [];
    if (broughtHome.length > 0) {
      for (const name of broughtHome) {
        if (!this.save.rescuedNames.includes(name)) this.save.rescuedNames.push(name);
      }
      addReturneeEntries(
        n,
        broughtHome.map((name) => ({ name, chapter, kind: 'civilian' as const })),
      );
    }

    // 生き延びた僚機は名前が判るので名簿に載せる（最終無線で読み上げる）。
    // 名簿に載った1名は指標の1名分なので、`sortieNarrative` は同じ人数を
    // クレジットから引いてある。載らなかった分（同じ名前が既にある等）だけ埋め戻す。
    const wingmanId = this.selection?.wingmanId;
    let named = 0;
    if (wingmanId && s.wingmenSurvived > 0) {
      const def = pilotDef(wingmanId);
      named = addReturneeEntries(n, [
        { name: def.name, chapter, kind: 'wingman', personId: def.personId },
      ]);
    }
    if (result.namedHeads > named) {
      adjustNarrative(n, { returneeCredit: result.namedHeads - named });
    }

    // 第8章の通信灯台。残した本数が第9章・第10章の援護の濃さになる。
    // 1基でも残れば認証は成立するが、記録するのは成否ではなく本数そのもの。
    const beacons = s.tagSurvivors['beacon'];
    if (beacons) {
      recordRelaysHeld(n, beacons.alive);
      extras.push({
        label: '通信灯台',
        delta: beacons.alive - beacons.total,
        reason: `${beacons.alive}/${beacons.total} 回線を維持`,
      });
    }
    return { lines: result.lines, extras };
  }

  /**
   * 4状態の増減を内訳つきで見せる（T7-5 / T2-③）。
   *
   * 合計だけを出さない。「帰還者 +4　＋5（救助 3名 / 僚機 1名が生還）　−1（僚機 1名が戦死）」
   * のように、プラス側とマイナス側を理由ごとに並べる。
   * 章末の選択の増減は別行に分けて出す（飛んだ結果と方針の表明を混ぜない）。
   */
  private narrativeChangeHtml(
    lines: readonly NarrativeLine[],
    extras: readonly NarrativeChange[],
  ): string {
    if (this.save.campaignMode !== 'veil') return '';
    const summary = narrativeSummary(this.save.narrative);
    const group = (reasons: readonly { text: string; delta: number }[], sign: '+' | '-') => {
      if (reasons.length === 0) return '';
      const sum = reasons.reduce((a, r) => a + r.delta, 0);
      const body = reasons.map((r) => escapeHtml(r.text)).join(' / ');
      return `　<span class="${sign === '+' ? 'ok' : 'ng'}">${sign === '+' ? '+' : '−'}${Math.abs(sum)}` +
        `（${body}）</span>`;
    };
    const rows = lines
      .map(
        (line) =>
          `<li class="${line.delta >= 0 ? 'ok' : 'ng'}" data-narrative="${escapeHtml(line.key)}">` +
          `${escapeHtml(line.label)} <b>${line.delta > 0 ? '+' : ''}${line.delta}</b>` +
          group(line.gains, '+') +
          group(line.losses, '-') +
          `</li>`,
      )
      .concat(
        extras.map(
          (c) =>
            // 0 は「損なわなかった」なので good 側に寄せる（灯台 3/3 維持など）
            `<li class="${c.delta >= 0 ? 'ok' : 'ng'}">` +
            `${escapeHtml(c.label)} <b>${c.delta > 0 ? '+' : ''}${c.delta}</b>　` +
            `<span class="dim">${escapeHtml(c.reason)}</span></li>`,
        ),
      )
      .join('');
    const now = [summary.returnees, summary.routeTrust, summary.commandTrust, summary.aceOath]
      .map((g) => `${escapeHtml(g.label)} ${g.value}`)
      .join('　');
    return `<div class="block"><h3>作戦の帰結</h3>` +
      (rows ? `<ul>${rows}</ul>` : `<div class="dim">この出撃では4状態は動かなかった。</div>`) +
      this.choiceEffectHtml() +
      this.rescuedNamesHtml() +
      // 「帰還者」は 0..100 の指標、「名簿」は読み上げる人数。名前を分けて混同を避ける
      `<div class="dim">現在: ${now}　名簿 ${this.save.narrative.returnees.length} 名</div></div>`;
  }

  /**
   * この出撃で連れ帰った者の名前（T4-⑮）。
   *
   * 「勝利は撃墜数では測れない。誰を帰したかが門の明日を決める」という本編の指標を、
   * 出撃ごとに名前で見せる行。名前は `MissionRunner` が `SpawnGroupDef.displayName(s)` から
   * 解決したものをそのまま出す（**ここで名前を作らない**）。
   * 一人も連れ帰れなかった出撃では行を出さない（空欄を並べても意味がない）。
   */
  private rescuedNamesHtml(): string {
    const names = this.lastSummary?.rescuedNames ?? [];
    if (names.length === 0) return '';
    return (
      `<div>連れ帰った者　${names.map((n) => escapeHtml(n)).join(' / ')}</div>`
    );
  }

  /**
   * 章末の選択が動かした分（T2-③）。
   *
   * 飛んだ結果より小さいことがひと目で判るよう、行を分けて薄く出す。
   * 帰還者は人数（名簿には出ない「名前の付かない増減」）なので単位を添える。
   */
  private choiceEffectHtml(): string {
    const picked = this.lastChoiceEffects;
    if (!picked) return '';
    const parts: string[] = [];
    const push = (key: keyof typeof NARRATIVE_LABEL, value: number | undefined, unit = '') => {
      if (value === undefined || value === 0) return;
      parts.push(`${NARRATIVE_LABEL[key]} ${value > 0 ? '+' : ''}${value}${unit}`);
    };
    push('returnees', picked.effects.returnees, '名');
    push('routeTrust', picked.effects.routeTrust);
    push('commandTrust', picked.effects.commandTrust);
    push('aceOath', picked.effects.aceOath);
    if (parts.length === 0) return '';
    return `<div class="dim">方針「${escapeHtml(picked.label)}」　${escapeHtml(parts.join(' / '))}</div>`;
  }

  /**
   * この出撃の達成度 (T1-①)。
   *
   * 勝敗そのものは win / loss の2値のまま。見出しと記録だけを
   * 「任務達成 / 部分達成 / 任務失敗」の3段階にする。
   * 集計が取れなかった場合 (訓練の中断など) は勝敗をそのまま段階に落とす。
   */
  private sortieGrade(outcome: 'win' | 'loss'): MissionGrade {
    if (outcome === 'loss') return 'failed';
    return this.lastSummary?.grade ?? 'complete';
  }

  private showDebrief(outcome: 'win' | 'loss'): void {
    const def = this.currentMission();
    const s = this.lastSummary;
    const dynamic = this.save.campaignMode === 'expanded' ? this.save.dynamicMission : undefined;
    const fixedNode = dynamic ? undefined : campaignNode(this.save.node, this.save.campaignMode);
    const kills = s?.kills ?? 0;
    this.save.totalKills += kills;
    if (outcome === 'win' && !this.save.cleared.includes(def.id)) {
      this.save.cleared.push(def.id);
    }
    if (s) {
      recordMissionStatistics(this.save.statistics, {
        outcome,
        shipId: s.shipId,
        seconds: s.seconds,
        shotsFired: s.shotsFired,
        hits: s.hits,
        wingmanHullRatio: s.wingmanHullRatio,
        wingmanRescued: s.wingmanRescued,
        wingmanAbandoned: s.wingmanAbandoned,
        navsReached: s.navsReached,
        escortSuccess: s.escortSuccess,
      });
    }
    const narrativeChanges =
      this.save.campaignMode === 'veil'
        ? this.applySortieToNarrative()
        : { lines: [], extras: [] };
    replenishForMission(this.save.supplies, outcome, !!s?.escortLost);
    let nextNode: CampaignNodeId;
    let transition: ReturnType<typeof advanceCampaignSave> | undefined;
    if (dynamic) {
      applyFrontlineOutcome(this.save.frontline, dynamic, outcome, { escortLost: s?.escortLost, kills });
      nextNode = dynamic.returnNode as CampaignNodeId;
      this.save.dynamicMission = undefined;
    } else {
      transition = advanceCampaignSave(this.save, outcome);
      nextNode = transition.nextNode;
      // 固定ミッションの間に、2回に1回は前線作戦を挿入する。
      // これにより本線9章の外側にも、哨戒・護衛・救難・強襲が積み上がる。
      if (this.save.campaignMode === 'expanded' && !isTerminal(nextNode) && this.save.sorties % 2 === 0) {
        this.save.dynamicMission = chooseDynamicMission(this.save.frontline, nextNode, this.save.sorties + this.save.frontline.operations + 1);
      }
    }
    if (!hasWingman(this.save.roster) && this.save.roster.reserves.length === 0) {
      nextNode = DEFEAT;
    }
    const sortieShip = this.game.world.player?.ship;
    this.save.lastSortie = {
      outcome,
      shipId: s?.shipId ?? sortieShip?.def.id ?? def.playerShipId,
      hullRatio: s?.playerHullRatio ?? 0,
      escortLost: !!s?.escortLost,
      missiles: Object.fromEntries((sortieShip?.missiles ?? []).map((m) => [m.missileId, m.count])),
      flares: sortieShip?.flares ?? 0,
    };
    if (nextNode === DEFEAT) this.save.ending = 'defeat';
    else if (nextNode === VICTORY) this.save.ending = this.endingQuality();
    this.save.node = nextNode;
    writeSave(this.save);

    // 目標の判定は「達成 / 未達 / 失敗」を出し分ける。
    // 破られていない制約 (protect など) は MissionRunner 側で done に解決済み。
    const objectives = (s?.objectives ?? [])
      .map(
        (o) =>
          `<li class="${o.state === 'done' ? 'ok' : o.state === 'failed' ? 'ng' : 'dim'}">` +
          `${o.state === 'done' ? '達成' : o.state === 'failed' ? '失敗' : '未達'}　${escapeHtml(o.text)}</li>`,
      )
      .join('');
    const grade = this.sortieGrade(outcome);
    // 自機を失った出撃は「機体喪失」を戦果に明示し、やり直しを既定の選択にする
    const playerLost = s?.playerLost ?? false;
    const minutes = Math.floor((s?.seconds ?? 0) / 60);
    const seconds = Math.floor((s?.seconds ?? 0) % 60);
    const routeLabel = transition
      ? transition.route === 'advance' ? '前進ルート' : transition.route === 'retreat' ? '撤退ルート' : '現状維持'
      : '前線作戦から帰投';
    const nextLabel = isTerminal(nextNode)
      ? nextNode === VICTORY ? '戦役勝利' : '戦役敗北'
      : campaignNode(nextNode, this.save.campaignMode).seriesName + ' — ' + campaignNode(nextNode, this.save.campaignMode).system;
    const campaignReport = fixedNode
      ? `<div class="block mc-debrief-campaign"><h3>戦役の分岐</h3>` +
        `<div><b>${escapeHtml(fixedNode.seriesName)}</b>　${escapeHtml(routeLabel)}　` +
        `勝利点 <b>${transition?.points ?? 0}</b>　累計 <b>${this.save.seriesScore}</b></div>` +
        `<div class="dim">${escapeHtml(transition?.situation ?? this.save.campaignSituation)}</div>` +
        `<div class="ok">次: ${escapeHtml(nextLabel)}</div></div>`
      : `<div class="block mc-debrief-campaign"><h3>戦況作戦</h3><div>${escapeHtml(routeLabel)}　次: ${escapeHtml(nextLabel)}</div></div>`;

    // 戦果を先に見せ、目標の判定を後から開く
    const scene = this.briefingScene(
      def,
      this.withProtagonistLine(
        outcome === 'win' ? def.debriefWin : def.debriefLoss,
        protagonistDebriefLine(this.save.protagonistId, outcome),
      ),
      [
        { html: campaignReport + `<div class="block"><h3>戦果</h3><ul>` +
          `<li>撃墜 ${kills} 機</li>` +
          `<li>撃退 ${s?.routed ?? 0} 機</li>` +
          `<li>機体状態 ${Math.round((s?.playerHullRatio ?? 0) * 100)}%　フレア ${this.save.lastSortie?.flares ?? 0}　` +
          `僚機 ${s?.escortLost ? '護衛対象喪失' : '護衛維持'}</li>` +
          // 撃墜されても戦役は止めない（案A）。代価として「機体喪失」を記録に残す
          (playerLost ? `<li class="ng">機体喪失 — 機体を1機失った</li>` : '') +
          `<li>飛行時間 ${minutes}分${String(seconds).padStart(2, '0')}秒</li>` +
          `<li>通算撃墜 ${this.save.totalKills} 機 / 出撃 ${this.save.sorties} 回</li>` +
          `</ul></div>`, slot: 'flight-plan' },
        { html: `<div class="block"><h3>目標</h3><ul>${objectives}</ul></div>` +
          this.narrativeChangeHtml(narrativeChanges.lines, narrativeChanges.extras) +
          (outcome === 'loss'
            ? `<div class="dim">${this.save.campaignMode === 'veil'
                ? '達成できなかった条件は記録として残る。次の章はこの記録の上で始まる。'
                : '失敗しても戦争は続く。次の任務は戦況の悪化を受けたものになる。'}</div>`
            : ''), slot: 'lower-left' },
      ],
      '報告受信中',
      outcome === 'loss' ? 'grim' : 'talk',
    );

    const continueItem: MenuItem = { label: '続ける', onSelect: () => this.afterDebrief(nextNode) };
    const retryItem: MenuItem = { label: 'この任務をやり直す', onSelect: () => this.retry(def.id, outcome) };
    this.game.sound.music.play(outcome === 'win' ? 'victory' : 'defeat');
    this.screens.show({
      variant: 'briefing',
      crest: outcome === 'win' ? artUrl('emblem-confed') : artUrl('emblem-kilrathi'),
      crestHeight: 72,
      // 見出しは達成度3段階（T1-①）。全未達で「任務達成」と出さない
      title: MISSION_GRADE_LABEL[grade],
      subtitle: def.title,
      background: artUrl('tex/bg-briefing', 'jpg'),
      content: scene.el,
      items: [
        // 撃墜された出撃だけ「やり直す」を先頭（＝既定フォーカス）にする（案A の救済）。
        // 達成した出撃では従来どおり「続ける」が既定。
        ...(playerLost ? [retryItem, continueItem] : [continueItem]),
        // デブリーフは表示時に統計を確定するため、戻り先は再集計を起こさない艦内画面にする。
        { label: 'リプレイ / キルカム', disabled: this.game.replay.length < 2, onSelect: () => this.showReplayPanel(() => this.showHub()) },
        { label: '記録を保存 (JSON)', onSelect: () => this.downloadPlaytestLog() },
        ...(playerLost ? [] : [retryItem]),
        { label: 'タイトルへ戻る', onSelect: () => this.showTitle() },
      ],
      hint: 'Space で読み進める / Esc で読み飛ばす',
    });
  }

  /**
   * デブリーフィングの後。
   * 戦死者がいれば追悼、勲章や昇進があれば授与式を挟んでから次へ進む。
   */
  private afterDebrief(nextNode: CampaignNodeId): void {
    if (this.lastLostWingman) {
      const lost = this.lastLostWingman;
      this.lastLostWingman = undefined;
      this.showMemorial(lost, nextNode);
      return;
    }
    const ceremony = this.pendingCeremony();
    if (ceremony) {
      this.showCeremony(ceremony, nextNode);
      return;
    }
    if (isTerminal(nextNode)) {
      this.showEnding(nextNode === VICTORY);
      return;
    }
    this.selection = undefined;
    this.showHub();
  }

  /** 戦死した僚機の追悼。席が空いたことを見せる */
  private showMemorial(pilotId: string, nextNode: CampaignNodeId): void {
    const def = pilotDef(pilotId);
    const p = pilotState(this.save.roster, pilotId);
    // 生き残りの誰かが一言述べる
    const others = this.save.roster.pilots.filter(
      (x) => x.id !== pilotId && x.status !== 'dead',
    );
    const speaker = others.length ? defOf(others[0]) : undefined;

    this.game.sound.music.play('defeat');
    this.screens.show({
      crest: artUrl('patch-squadron'),
      crestHeight: 76,
      title: '追悼',
      bodyHtml:
        `<div class="mc-memorial">` +
        `${portraitFace(def.id, def.portrait, { size: 150, dead: true })}` +
        `<div><div class="mc-memorial-name">${escapeHtml(def.callsign)}</div>` +
        `<div class="dim">${escapeHtml(def.name)}　${PERSONALITIES[def.personality].label}</div>` +
        `<div class="dim">撃墜 ${p?.kills ?? 0} 機 / 出撃 ${p?.sorties ?? 0} 回</div>` +
        `<div class="ng">${escapeHtml(p?.diedIn ?? this.currentMission().title)} にて戦死</div>` +
        `</div></div>` +
        (speaker
          ? `<div class="block"><div class="speaker">${escapeHtml(speaker.callsign)}:</div>` +
            `<div>${escapeHtml(mournLine(speaker.personality))}</div></div>`
          : '') +
        `<div class="block dim">この席は二度と埋まらない。補充は来るが、同じ人間ではない。</div>`,
      items: [{ label: '黙祷を終える', onSelect: () => this.afterDebrief(nextNode) }],
    });
  }

  /** 授与すべき勲章と昇進をまとめる */
  private pendingCeremony(): { medals: string[]; promotedTo?: string } | undefined {
    const ctx: MedalContext = {
      totalKills: this.save.totalKills,
      sorties: this.save.sorties,
      cleared: this.save.cleared.length,
      missionKills: this.lastSummary?.kills ?? 0,
      flawless: (this.lastSummary?.playerHullRatio ?? 0) >= 0.999,
      acesKilled: this.save.acesKilled,
      noEscortLost: this.save.noEscortLost,
      noWingmanLost: this.save.noWingmanLost,
    };
    const medals = newlyEarned(ctx, this.save.medals).map((m) => m.id);
    const rank = rankFor(this.save.sorties, this.save.totalKills);
    const promoted = rank.id !== this.lastRankId ? rank.label : undefined;
    if (medals.length === 0 && !promoted) return undefined;
    return { medals, promotedTo: promoted };
  }

  /** 勲章授与式と昇進 */
  private showCeremony(
    c: { medals: string[]; promotedTo?: string },
    nextNode: CampaignNodeId,
  ): void {
    this.game.sound.music.play('victory');
    // 授与済みとして記録し、二度出さない
    this.save.medals.push(...c.medals);
    this.lastRankId = rankFor(this.save.sorties, this.save.totalKills).id;
    writeSave(this.save);

    const medalHtml = c.medals
      .map((id) => {
        const m = medalById(id)!;
        return (
          `<div class="mc-medal">` +
          artImg(medalArt(m.id), { className: 'mc-medal-art', height: 96, alt: m.label }) +
          `<span><b>${escapeHtml(m.label)}</b><br><span class="dim">${escapeHtml(m.reason)}</span></span></div>`
        );
      })
      .join('');

    this.screens.show({
      crest: artUrl('emblem-confed'),
      crestHeight: 76,
      title: '授与式',
      subtitle: 'TCS タイガーズ・クロー 格納庫',
      bodyHtml:
        // 授与式は veil でも通る画面なので、艦長名をモードに合わせる。
        `<div class="block"><div class="speaker">${escapeHtml(this.commanderName())}:</div>` +
        `<div>${escapeHtml(
          c.promotedTo
            ? `全員、整列。本日をもって本官の権限により、貴官を${c.promotedTo}に任ずる。`
            : '全員、整列。貴官の働きに対し、以下を授与する。',
        )}</div></div>` +
        (medalHtml ? `<div class="block"><h3>勲章</h3>${medalHtml}</div>` : '') +
        (c.promotedTo
          ? `<div class="block"><h3>昇進</h3><div class="mc-rank-line">` +
            artImg(rankArt(this.lastRankId ?? ''), { className: 'mc-rank-pin', height: 44 }) +
            `<span><b>${escapeHtml(c.promotedTo)}</b> に昇進した。</span></div></div>`
          : '') +
        `<div class="block dim">拍手は短い。次の出撃が控えている。</div>`,
      items: [{ label: '解散', onSelect: () => this.afterDebrief(nextNode) }],
    });
  }

  /** 直前の任務をやり直す (分岐を戻す) */
  private retry(missionId: string, outcome: 'win' | 'loss'): void {
    void outcome;
    // 進行を1つ巻き戻す
    for (const [id, node] of Object.entries(campaignGraph(this.save.campaignMode))) {
      if (id === missionId || node.missionId === missionId) {
        this.save.node = id;
        break;
      }
    }
    writeSave(this.save);
    this.selection = undefined;
    this.showHub();
  }

  /**
   * 十章キャンペーンの結末（T7-6）。
   *
   * 仕様の要点をそのまま実装する。
   *   - 結末は3種（永久閉鎖 / 限定開放 / 五者共同管理）。どれも解決ではない
   *   - **撃墜数の集計を表示しない**
   *   - 帰還した者の名前を、艦と勢力を問わず一人ずつ読み上げる
   *   - 読み上げられる名前の数だけがプレイヤーの戦績である
   */
  private showVeilEnding(victory: boolean): void {
    this.game.sound.music.play(victory ? 'victory' : 'defeat');
    this.game.endMission();
    const gate = this.save.gateOutcome;
    const closing: Record<GateOutcome, { title: string; subtitle: string; body: string }> = {
      closed: {
        title: '門を閉じた',
        subtitle: 'THE GATE IS SEALED',
        body: '制御核は砕かれ、ヴェガ門は永久に閉じた。この宙域の戦争は終わる。' +
          '同時に、門の向こうにあった辺境の居住区も切り捨てられた。静かに枯れていく航路の名前は、誰も読み上げない。',
      },
      'limited-open': {
        title: '限定開放を選んだ',
        subtitle: 'THE GATE STANDS OPEN',
        body: '核は共鳴し、全勢力の航路が再起動した。連邦の物流は生き延びた。' +
          'だが開いた扉の管理者は、もう誰でもない。次に誰が通るのかを決める者がいない。',
      },
      'joint-custody': {
        title: '五者共同管理に委ねた',
        subtitle: 'FIVE SIGNATURES',
        body: '八十三年遅れて六つ目の条項が発効し、門制御核は共同管理下に入った。' +
          '最も遅く、最も脆く、最も多くの署名を必要とする道だ。誰も相手を信じていないまま、全員が明日も交渉を続ける。',
      },
    };
    const chosen = gate ? closing[gate] : undefined;
    const roll = returneeRollCall(this.save.narrative);
    const names = roll.length
      ? roll
          .map(
            (e) =>
              `<li>${escapeHtml(e.name)}` +
              `<span class="dim">　${e.chapter ? `第${e.chapter}章` : '章外'}・${escapeHtml(RETURNEE_KIND_LABEL[e.kind])}</span></li>`,
          )
          .join('')
      : '';
    this.screens.show({
      crest: artUrl('emblem-carrier'),
      // 名簿の行数を稼ぐため、他の結末画面（132）より紋章を小さくする
      crestHeight: 88,
      title: chosen?.title ?? (victory ? '門前の帰還' : '戦役終了'),
      heroTitle: true,
      subtitle: chosen?.subtitle ?? (victory ? 'OPERATION OPEN HAND' : 'THE GATE REMAINS'),
      background: artUrl('tex/bg-space', 'jpg'),
      bodyHtml:
        `<div class="block">${chosen?.body ?? (victory
          ? '旗艦は無力化した。だが門の管理方法は決まらないまま、艦隊は帰投した。'
          : '門は開いたままで、誰も止められなかった。停戦線は失われ、五者通行協定は口実を失った。')}</div>` +
        `<div class="block"><h3>最終無線 — 帰還した者</h3>` +
        (names
          // 名簿は十章分で数十名になり、パネル内でスクロールする。
          // 「読み上げた名前 N」＝この物語の戦績なので、一覧より前に置いて必ず見せる。
          ? `<div class="ok">読み上げた名前 <b>${roll.length}</b> — これが君の戦績である。</div>` +
            `<div class="dim">勝者の名は読まない。艦と勢力を問わず、帰ってきた者の名前だけを読み上げる。</div>` +
            `<ul>${names}</ul>`
          : `<div class="dim">読み上げる名前がない。誰も連れて帰らなかった。</div>`) +
        `</div>`,
      items: [
        { label: 'もう一度戦役を始める', onSelect: () => this.startCampaign(true) },
        { label: 'タイトルへ戻る', onSelect: () => this.showTitle() },
      ],
    });
  }

  private showEnding(victory: boolean): void {
    if (this.save.campaignMode === 'veil') {
      this.showVeilEnding(victory);
      return;
    }
    this.game.sound.music.play(victory ? 'victory' : 'defeat');
    this.game.endMission();
    const quality = victory ? (this.save.ending ?? 'victory') : 'defeat';
    const title = quality === 'victory' ? '完全勝利' : quality === 'pyrrhic' ? '苦い勝利' : quality === 'draw' ? '痛み分け' : '戦役終了';
    this.screens.show({
      crest: victory ? artUrl('emblem-confed') : artUrl('emblem-kilrathi'),
      crestHeight: 132,
      title,
      heroTitle: true,
      subtitle: quality === 'victory' ? 'VEGA SECTOR SECURED' : quality === 'defeat' ? 'TIGER’S CLAW LOST' : 'VEGA SECTOR HELD',
      bodyHtml: quality !== 'defeat'
        ? `<div class="block">` +
          `${quality === 'victory' ? 'ヴェガ宙域からキルラシー艦隊は退いた。' : quality === 'pyrrhic' ? 'ヴェガ宙域は守った。だが、空いた席と焼けた甲板が勝利の代償だ。' : '敵の主力は退いたが、両軍とも戦線を維持できるほどの余力を失った。'} ` +
          `タイガーズ・クローは健在で、君はまだ生きている。` +
          `戦争そのものはまだ終わらない。だが、この宙域の住民は今夜、空を見上げて眠れる。` +
          `</div><div class="block"><h3>最終記録</h3><ul>` +
          `<li>通算撃墜 ${this.save.totalKills} 機</li>` +
          `<li>出撃 ${this.save.sorties} 回</li>` +
          `<li>難易度 ${difficulty().label}</li></ul></div>`
        : `<div class="block">` +
          `タイガーズ・クローは失われた。ヴェガ宙域の連邦軍は事実上消滅し、戦線は後退する。` +
          `君の戦いは記録に残る。だが、記録が戦争を勝たせることはない。` +
          `</div><div class="block"><h3>最終記録</h3><ul>` +
          `<li>通算撃墜 ${this.save.totalKills} 機</li>` +
          `<li>出撃 ${this.save.sorties} 回</li></ul></div>`,
      items: [
        { label: 'もう一度戦役を始める', onSelect: () => this.startCampaign(true) },
        { label: 'タイトルへ戻る', onSelect: () => this.showTitle() },
      ],
    });
  }

  private endingQuality(): 'victory' | 'pyrrhic' | 'draw' {
    const systems = Object.values(this.save.frontline.systems);
    const control = systems.reduce((sum, s) => sum + s.control, 0) / Math.max(1, systems.length);
    const dead = fallen(this.save.roster).length;
    if (control >= 62 && dead <= 1) return 'victory';
    if (control >= 45) return 'pyrrhic';
    return 'draw';
  }

  // ───────── ポーズ ─────────

  private showPause(): void {
    if (this.screens.isOpen) return;
    this.game.paused = true;
    this.game.input.uiMode = true;
    const resume = () => {
      this.screens.hide();
      this.game.paused = false;
      this.game.input.uiMode = false;
    };
    this.screens.show({
      title: 'ポーズ',
      transparent: true,
      // 1行目に進行、2行目に題名、3行目に星系と難易度。項目が6つあるので3行を超えない
      bodyHtml:
        `<div class="mc-progress">${escapeHtml(this.progressLabel())}</div>` +
        `<div class="dim">${escapeHtml(this.currentMission().title)}</div>` +
        `<div class="dim">${escapeHtml(this.currentMission().system)}　難易度: ${escapeHtml(difficulty().label)}</div>`,
      items: [
        { label: '再開', onSelect: resume },
        {
          label: '設定',
          onSelect: () =>
            this.showSettings(() => {
              this.showPause2();
            }),
        },
        {
          label: '操作方法',
          onSelect: () => this.showPauseHelp(),
        },
        {
          label: `リプレイ / キルカム (${this.game.replay.length}フレーム)`,
          onSelect: () => this.showReplayPanel(() => this.showPause2()),
        },
        {
          label: 'ミッションをやり直す',
          onSelect: () => {
            this.screens.hide();
            this.game.paused = false;
            this.game.input.uiMode = false;
            const def = this.currentMission();
            this.game.startMission(def, this.loadoutFor(def), false);
          },
        },
        {
          label: 'タイトルへ戻る',
          onSelect: () => {
            this.game.paused = false;
            this.showTitle();
          },
        },
      ],
      onCancel: resume,
    });
  }

  /** 設定から戻ったときにポーズ画面を再表示する */
  private showPause2(): void {
    this.screens.hide();
    this.showPause();
  }

  /** ポーズ中の操作説明。閉じるとポーズ画面へ戻る。 */
  private showPauseHelp(): void {
    this.screens.show({
      title: '操作方法',
      bodyHtml:
        `<div class="block"><h3>飛ぶ</h3>` +
        `機首は <b>↑↓←→</b>、ロールは <b>Q E</b>。マウス操縦は既定 OFF で、<b>M</b> で入れると照準から動かした方へ機首が向く。` +
        `速度設定は <b>+</b> <b>-</b>（10%ずつ）かホイール、数字 <b>1〜9</b> で割合指定。` +
        `<b>;</b> で目標の速度に合わせる。<b>Tab</b> でアフターバーナー。<b>/</b> を押している間は後方視点。</div>` +
        `<div class="block"><h3>戦う</h3>` +
        `<b>Space</b> か左クリックで主砲。<b>T</b> でターゲット切替、<b>Y</b> で正面の敵、<b>I</b> で照準下の相手を掴む。` +
        `<b>Enter</b> か右クリックでミサイル。<b>L</b> で手動ロック（設定「操作」でロック方式を選べる）。</div>` +
        `<div class="block"><h3>移動・指示</h3>` +
        `<b>A</b> でオートパイロット。<b>C</b> で通信メニュー。` +
        `<b>Alt+F/A/B/H/R</b> で僚機へ直接指示（編隊 / 私の目標 / 散開 / 支援 / 報告）。<b>Esc</b> でポーズ。</div>`,
      items: [
        { label: '音楽クレジット', onSelect: () => this.showMusicCredits(() => this.showPauseHelp()) },
        { label: '戻る', onSelect: () => this.showPause2() },
      ],
      onCancel: () => this.showPause2(),
      transparent: true,
    });
  }

  /** 同梱したCC音源の作者・ライセンス情報を、ゲーム内からも確認できるようにする。 */
  private showMusicCredits(back: () => void): void {
    const previousTrack = this.game.sound.music.current;
    const restore = () => {
      if (previousTrack) this.game.sound.music.play(previousTrack);
      back();
    };
    const soundCheck = buildSoundCheckPanel({
      playMusic: (track: MusicTrackId) => {
        audio.resume();
        this.game.sound.music.play(track);
        this.game.sound.music.start();
      },
      playVoice: (tone, speaker, text) => {
        audio.resume();
        audio.radioVoice(text, tone, speaker);
      },
    });
    this.screens.show({
      title: '音楽クレジット',
      bodyHtml:
        `<div class="block"><h3>BGM</h3>` +
        `Kevin MacLeod / <b>Incompetech</b><br>` +
        `Creative Commons Attribution License（商用利用可・作者表記が必要）</div>` +
        `<div class="block dim">曲名、配布元URL、利用時の注意は ` +
        `<code>public/audio/music/README.md</code> を参照してください。` +
        `リリース前にはIncompetechで各曲の最新クレジット文言を確認してください。</div>`,
      content: soundCheck,
      items: [{ label: '戻る', onSelect: restore }],
      onCancel: restore,
      transparent: this.game.runner !== undefined,
    });
  }

  dispose(): void {
    this.screens.dispose();
    this.game.dispose();
    bus.clear();
  }

  /** デバッグ用 */
  get debug(): {
    game: Game;
    save: CampaignSave;
    showcase: (shipId: string, o?: ShowcaseOptions) => ShowcaseResult;
  } {
    return {
      game: this.game,
      save: this.save,
      // 見た目の確認用。製品の進行には影響しない
      showcase: (shipId, o) => showcase(this.game, shipId, o),
    };
  }
}
