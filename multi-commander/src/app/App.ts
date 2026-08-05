import { bus } from '../core/events';
import {
  campaignGraph,
  campaignMap,
  campaignNode,
  campaignStart,
  isTerminal,
  totalChapters,
  VICTORY,
  DEFEAT,
  type CampaignMode,
  type CampaignNodeId,
} from '../content/campaign';
import { missionDef } from '../content/missions';
import { dynamicMissionDef, chooseDynamicMission, applyFrontlineOutcome, type DynamicMissionKind } from '../content/frontline';
import { PERSONALITIES, pilotDef } from '../content/pilots';
import { mournLine } from '../content/pilotDialogue';
import { PLAYABLE_SHIPS, shipDef } from '../content/ships';
import { missileDef } from '../content/weapons';
import type { Loadout, MissionDef } from '../mission/types';
import {
  barracksHtml,
  hangarHtml,
  killBoardHtml,
  recRoomHtml,
  frontlineHtml,
  statisticsHtml,
  type HangarSelection,
  type HubContext,
} from '../ui/HubPanels';
import { BriefingScene, type BriefingPanel } from '../ui/BriefingScene';
import { portraitFace, type Expression } from '../ui/Portrait';
import { escapeHtml, ScreenHost, type MenuItem } from '../ui/ScreenHost';
import { artImg, artUrl, medalArt, rankArt } from '../ui/art';
import { buildSettingsPanel } from '../ui/SettingsPanel';
import { medalById, newlyEarned, rankFor, type MedalContext } from './medals';
import {
  applySortie,
  availablePilots,
  defaultWingman,
  defOf,
  fallen,
  hasWingman,
  pilotState,
  type SortieOutcome,
} from './roster';
import { Game } from './game';
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
import { availableMissiles, clampLoadout, consumeLoadout, replenishForMission } from './supplies';
import { recordMissionStatistics } from './statistics';
import { difficulty, settings, updateSettings } from './settings';
import { showcase, type ShowcaseOptions, type ShowcaseResult } from './showroom';
import { ReplayPanel } from './replay';
import { audio } from '../audio/AudioManager';
import { type MusicTrackId } from '../audio/musicCues';
import { buildSoundCheckPanel } from '../ui/SoundCheckPanel';

/** 母艦の名前。ブリーフィング官の名札に出す */
const CLAW_NAME = 'TCS タイガーズ・クロー';

/**
 * 画面遷移とキャンペーン進行の統括。
 * タイトル → ブリーフィング → 出撃 → デブリーフ → 分岐 を回す。
 */
export class App {
  private game: Game;
  private screens: ScreenHost;
  private save: CampaignSave;
  private lastSummary?: ReturnType<NonNullable<Game['runner']>['summary']>;
  /** 格納庫で選んだ内容 (出撃まで保持する) */
  private selection?: HangarSelection;
  /** 直前の出撃で失った僚機 (追悼画面に使う) */
  private lastLostWingman?: string;
  /** 最後に到達した階級 (昇進の検出に使う) */
  private lastRankId = '2lt';
  /** 訓練室はキャンペーン進行を変更しない */
  private trainingActive = false;
  private trainingKind: DynamicMissionKind = 'patrol';
  private trainingEnemyCount = 3;
  private trainingSkill = 0.55;
  private replayPanel?: ReplayPanel;
  /** 新規戦役で選ぶモード。既存セーブのモードはセーブ側を優先する。 */
  private newCampaignMode: CampaignMode = 'canon';
  private barPilotId?: string;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.game = new Game(canvas, overlay);
    this.screens = new ScreenHost(overlay);
    this.save = loadSave() ?? newCampaignSave('canon');
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
          this.newCampaignMode = this.newCampaignMode === 'canon' ? 'expanded' : 'canon';
          this.showTitle();
        },
      },
      { label: '設定', onSelect: () => this.showSettings(() => this.showTitle()) },
      { label: '操作説明', onSelect: () => this.showHelp() },
    ];
    const saved = loadSave();
    const progress = saved
      ? `前回の記録: ${this.modeLabel(saved.campaignMode)}・第 ${this.chapterOf(saved.node, saved.campaignMode)} 章 / 勝利点 ${saved.seriesScore} / 通算撃墜 ${saved.totalKills} 機`
      : '記録なし';
    this.screens.show({
      title: 'MULTI-COMMANDER',
      subtitle: 'TCS TIGER’S CLAW — VEGA SECTOR',
      heroTitle: true,
      crest: artUrl('title-crest'),
      crestHeight: 210,
      background: artUrl('tex/bg-space', 'jpg'),
      bodyHtml:
        `<div class="block"><h3>状況</h3>` +
        `キルラシー帝国との戦争は6年目に入った。君はタイガーズ・クローに配属された新任パイロットだ。` +
        `ブリーフィングを受け、出撃し、生きて帰れ。戦況は君の戦果で変わる。</div>` +
        `<div class="dim">${escapeHtml(progress)}　難易度: ${difficulty().label}</div>`,
      items,
      hint: '▲▼ で選択 / Enter で決定',
    });
  }

  private modeLabel(mode: CampaignMode): string {
    return mode === 'canon' ? 'CANON / ENYO' : 'EXPANDED / McCAFFREY';
  }

  private chapterOf(node: CampaignNodeId, mode: CampaignMode = this.save.campaignMode): number {
    if (isTerminal(node)) return totalChapters(mode);
    return campaignNode(node, mode).chapter;
  }

  private showHelp(): void {
    this.screens.show({
      title: '操作説明',
      bodyHtml:
        `<div class="block"><h3>飛ぶ</h3>` +
        `マウスを照準から動かすと機首が向く (M でオン/オフ)。キーボードなら ↑↓←→。` +
        `スロットルは <b>] [</b> かホイール、数字 <b>1〜9</b> で割合指定。<b>Tab</b> でアフターバーナー。</div>` +
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

  private showSettings(back: () => void): void {
    const panel = buildSettingsPanel(() => {
      this.game.applySettings();
    });
    this.screens.show({
      title: '設定',
      content: panel,
      items: [{ label: '戻る', onSelect: back }],
      onCancel: back,
      transparent: this.game.runner !== undefined,
    });
  }

  // ───────── キャンペーン進行 ─────────

  private startCampaign(fresh: boolean): void {
    if (fresh) {
      this.save = newCampaignSave(this.newCampaignMode);
      writeSave(this.save);
    } else {
      this.save = loadSave() ?? newCampaignSave(this.newCampaignMode);
    }
    this.newCampaignMode = this.save.campaignMode;
    this.selection = undefined;
    this.showHub();
  }

  private currentMission(): MissionDef {
    if (this.trainingActive) return this.trainingDef();
    if (this.save.campaignMode === 'expanded' && this.save.dynamicMission) return dynamicMissionDef(this.save.dynamicMission);
    const node = campaignNode(this.save.node, this.save.campaignMode);
    const base = missionDef(node.missionId);
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
    const load: Loadout = {
      shipId: sel.shipId,
      gunId: sel.gunId,
      missiles: clampLoadout(this.save.supplies, missilePackage),
      aceStates: this.save.aceStates,
      wingmanSlot: sel.wingmanSlot,
      flares: Math.min(12, this.save.supplies.flares),
    };
    const w = sel.wingmanId ? pilotState(this.save.roster, sel.wingmanId) : undefined;
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
          obedience: Math.max(0, Math.min(1, pers.obedience + w.bond * 0.12)),
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
        `<div class="dim">戦況: ${escapeHtml(this.save.campaignSituation)}　/　勝利点 ${this.save.seriesScore}　/　${this.frontlineSummary()}</div>` +
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

  private showRecRoom(): void {
    const talkers = this.save.roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded');
    this.screens.show({
      background: artUrl('tex/bg-bar', 'jpg'),
      title: '酒場',
      bodyHtml: recRoomHtml({ ...this.hubContext(), barPilotId: this.barPilotId }),
      items: [
        ...talkers.map((pilot) => ({
          label: `${pilot.id === this.barPilotId ? '会話中: ' : ''}${escapeHtml(pilotDef(pilot.id).callsign)} と話す`,
          onSelect: () => {
            pilot.bond = Math.min(1, pilot.bond + 0.08);
            this.barPilotId = pilot.id;
            writeSave(this.save);
            this.showRecRoom();
          },
        })),
        { label: '噂を聞く', onSelect: () => this.showRecRoom() },
        { label: '戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
    });
  }

  private showBarracks(): void {
    this.screens.show({
      background: artUrl('tex/bg-quarters', 'jpg'),
      title: '自室',
      bodyHtml: barracksHtml(this.hubContext()),
      items: [
        { label: 'セーブスロットへ — 現在の戦役を保存', onSelect: () => this.showSaveSlots('save') },
        { label: 'セーブスロットからロード', onSelect: () => this.showSaveSlots('load') },
        { label: '戻る', onSelect: () => this.showHub() },
      ],
      onCancel: () => this.showHub(),
    });
  }

  /** 帰艦後の自室でだけ触れる、本家風8スロット記録画面。 */
  private showSaveSlots(mode: 'save' | 'load'): void {
    const slots = Array.from({ length: SAVE_SLOT_COUNT }, (_, slot) => ({ slot, save: loadSaveSlot(slot) }));
    const rows = slots.map(({ slot, save }) =>
      `<div class="mc-save-slot ${save ? 'filled' : 'empty'}"><b>SLOT ${slot + 1}</b>` +
      (save
        ? `<span>${escapeHtml(this.modeLabel(save.campaignMode))}　${this.chapterOf(save.node, save.campaignMode)}章　勝利点 ${save.seriesScore}　撃墜 ${save.totalKills}</span>`
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
    return systems.map(([id, s]) => `${id} ${s.control.toFixed(0)}%`).join(' / ');
  }

  /** 勝敗で塗り替わる戦役の道筋。現在地と次に進み得る両方を同時に見せる。 */
  private campaignMapHtml(): string {
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
    const frontlinePanel = this.save.campaignMode === 'expanded'
      ? frontlineHtml(this.hubContext()) +
        `<div class="block"><h3>独自拡張の作戦方針</h3><div class="dim">McCaffrey / Gimle / Vega の動的前線作戦は EXPANDED モードでのみ発生する。</div></div>`
      : `<div class="block"><h3>CANON 戦役</h3><div class="dim">この画面では Enyo → McAuliffe → Gateway の固定戦役だけを表示する。独自前線作戦は発生しない。</div></div>`;
    this.screens.show({
      background: artUrl('tex/bg-briefing', 'jpg'),
      title: '戦況マップ',
      bodyHtml: this.campaignMapHtml() + frontlinePanel,
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
    const ref = { id: `training-${this.trainingKind}`, system: 'McCaffrey' as const, kind: this.trainingKind, seed: 99, returnNode: this.save.node };
    const base = dynamicMissionDef(ref);
    if (this.trainingKind === 'quiet') return { ...base, title: '訓練室 — 航法・帰投', debriefWin: ['航法訓練を終了した。'], debriefLoss: ['訓練を中断した。'] };
    const spawns = base.spawns.map((g) => ({ ...g, skill: this.trainingSkill, count: g.faction === 'kilrathi' ? this.trainingEnemyCount : g.count }));
    return { ...base, id: `training-${this.trainingKind}`, title: `訓練室 — ${base.title}`, spawns, debriefWin: ['訓練終了。実戦では、敵も弾も戻ってこない。'], debriefLoss: ['訓練を中断した。機体を点検してもう一度試せる。'] };
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
        { label: 'プレイテスト記録を保存 (JSON)', onSelect: () => this.downloadPlaytestLog() },
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
      bodyHtml: hangarHtml(this.hubContext(), sel, def.playerShipId),
      items,
      onCancel: () => this.showHub(),
    });
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

    const objectives = def.objectives
      .map((o) => `<li>${escapeHtml(o.text)}${o.required ? '' : ' <span class="dim">(任意)</span>'}</li>`)
      .join('');

    const wing = load.wingman?.callsign;
    const scene = this.briefingScene(def, def.briefing, [
      { html: `<div class="block"><h3>任務目標</h3><ul>${objectives}</ul></div>`, slot: 'lower-left' },
      { html: `<div class="block"><h3>飛行計画</h3>${this.navMapSvg(def)}</div>`, slot: 'flight-plan' },
      { html: `<div class="block"><h3>機体</h3>` +
        `${escapeHtml(ship.name)}<br><span class="dim">副兵装: ${escapeHtml(missiles || 'なし')}` +
        `${wing ? `<br>僚機: ${escapeHtml(wing)}` : ''}</span></div>`, slot: 'lower-right' },
    ]);

    this.screens.show({
      variant: 'briefing',
      crest: artUrl('emblem-confed'),
      crestHeight: 64,
      background: artUrl('tex/bg-briefing', 'jpg'),
      title: def.title,
      subtitle: `${this.modeLabel(this.save.campaignMode)}　${node.seriesName}　${node.chapter}/${totalChapters(this.save.campaignMode)}　—　${def.system} 星系${node.losingRoute ? '　(戦況悪化)' : ''}`,
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
    if (this.trainingActive) {
      this.trainingActive = false;
      this.showTrainingDebrief(outcome);
      return;
    }
    this.applyRosterOutcome();
    this.showDebrief(outcome);
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

    const objectives = (s?.objectives ?? [])
      .map(
        (o) =>
          `<li class="${o.state === 'done' ? 'ok' : o.state === 'failed' ? 'ng' : 'dim'}">` +
          `${o.state === 'done' ? '達成' : o.state === 'failed' ? '失敗' : '未達'}　${escapeHtml(o.text)}</li>`,
      )
      .join('');
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
      outcome === 'win' ? def.debriefWin : def.debriefLoss,
      [
        { html: campaignReport + `<div class="block"><h3>戦果</h3><ul>` +
          `<li>撃墜 ${kills} 機</li>` +
          `<li>撃退 ${s?.routed ?? 0} 機</li>` +
          `<li>機体状態 ${Math.round((s?.playerHullRatio ?? 0) * 100)}%　フレア ${this.save.lastSortie?.flares ?? 0}　` +
          `僚機 ${s?.escortLost ? '護衛対象喪失' : '護衛維持'}</li>` +
          `<li>飛行時間 ${minutes}分${String(seconds).padStart(2, '0')}秒</li>` +
          `<li>通算撃墜 ${this.save.totalKills} 機 / 出撃 ${this.save.sorties} 回</li>` +
          `</ul></div>`, slot: 'flight-plan' },
        { html: `<div class="block"><h3>目標</h3><ul>${objectives}</ul></div>` +
          (outcome === 'loss'
            ? `<div class="dim">失敗しても戦争は続く。次の任務は戦況の悪化を受けたものになる。</div>`
            : ''), slot: 'lower-left' },
      ],
      '報告受信中',
      outcome === 'loss' ? 'grim' : 'talk',
    );

    this.game.sound.music.play(outcome === 'win' ? 'victory' : 'defeat');
    this.screens.show({
      variant: 'briefing',
      crest: outcome === 'win' ? artUrl('emblem-confed') : artUrl('emblem-kilrathi'),
      crestHeight: 72,
      title: outcome === 'win' ? '任務達成' : '任務失敗',
      subtitle: def.title,
      background: artUrl('tex/bg-briefing', 'jpg'),
      content: scene.el,
      items: [
        { label: '続ける', onSelect: () => this.afterDebrief(nextNode) },
        // デブリーフは表示時に統計を確定するため、戻り先は再集計を起こさない艦内画面にする。
        { label: 'リプレイ / キルカム', disabled: this.game.replay.length < 2, onSelect: () => this.showReplayPanel(() => this.showHub()) },
        { label: 'プレイテスト記録を保存 (JSON)', onSelect: () => this.downloadPlaytestLog() },
        { label: 'この任務をやり直す', onSelect: () => this.retry(def.id, outcome) },
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
        `<div class="block"><div class="speaker">ハルシオン大佐:</div>` +
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

  private showEnding(victory: boolean): void {
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
      bodyHtml: `<div class="dim">${escapeHtml(this.currentMission().title)}</div>`,
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
        `マウスを照準から動かすと機首が向く (M でオン/オフ)。キーボードなら ↑↓←→。` +
        `スロットルは <b>] [</b> かホイール、数字 <b>1〜9</b> で割合指定。<b>Tab</b> でアフターバーナー。</div>` +
        `<div class="block"><h3>戦う</h3>` +
        `<b>Space</b> か左クリックで主砲。<b>T</b> でターゲット切替、<b>Y</b> で正面の敵を掴む。` +
        `<b>Enter</b> か右クリックでミサイル。</div>` +
        `<div class="block"><h3>移動・指示</h3>` +
        `<b>A</b> でオートパイロット。<b>C</b> で通信メニュー。<b>Esc</b> でポーズ。</div>`,
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
