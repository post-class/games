import { bus } from '../core/events';
import {
  advance,
  CAMPAIGN,
  CAMPAIGN_START,
  campaignNode,
  isTerminal,
  TOTAL_CHAPTERS,
  VICTORY,
  type CampaignNodeId,
} from '../content/campaign';
import { missionDef } from '../content/missions';
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
  type HangarSelection,
  type HubContext,
} from '../ui/HubPanels';
import { portraitFace } from '../ui/Portrait';
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
  pilotState,
  type SortieOutcome,
} from './roster';
import { Game } from './game';
import { loadSave, newSave, writeSave, type CampaignSave } from './save';
import { difficulty, settings, updateSettings } from './settings';
import { showcase, type ShowcaseOptions, type ShowcaseResult } from './showroom';

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

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.game = new Game(canvas, overlay);
    this.screens = new ScreenHost(overlay);
    this.save = loadSave() ?? newSave();

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
    this.game.sound.music.play('theme');
    this.game.endMission();
    const hasSave = !!loadSave();
    const items: MenuItem[] = [
      { label: '新しい戦役を始める', onSelect: () => this.startCampaign(true) },
      {
        label: '続きから',
        disabled: !hasSave,
        onSelect: () => this.startCampaign(false),
      },
      { label: '設定', onSelect: () => this.showSettings(() => this.showTitle()) },
      { label: '操作説明', onSelect: () => this.showHelp() },
    ];
    const saved = loadSave();
    const progress = saved
      ? `前回の記録: 第 ${this.chapterOf(saved.node)} 章 / 通算撃墜 ${saved.totalKills} 機`
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

  private chapterOf(node: CampaignNodeId): number {
    if (isTerminal(node)) return TOTAL_CHAPTERS;
    return campaignNode(node).chapter;
  }

  private showHelp(): void {
    this.screens.show({
      title: '操作説明',
      bodyHtml:
        `<div class="block"><h3>飛ぶ</h3>` +
        `マウスを画面中央から動かすと機首が向く (M でオン/オフ)。キーボードなら ↑↓←→。` +
        `スロットルは <b>] [</b> かホイール、数字 <b>1〜9</b> で割合指定。<b>Tab</b> でアフターバーナー。</div>` +
        `<div class="block"><h3>戦う</h3>` +
        `<b>Space</b> か左クリックで主砲。<b>T</b> でターゲット切替、<b>Y</b> で正面の敵を掴む。` +
        `黄色い点線の丸が「そこを撃てば当たる」位置 (偏差照準)。<b>Enter</b> か右クリックでミサイル。` +
        `誘導ミサイルは正面に捉え続けてロックしてから撃つ。</div>` +
        `<div class="block"><h3>移動する</h3>` +
        `Nav ポイント間の移動は <b>A</b> のオートパイロット。敵が近くにいると使えない。</div>` +
        `<div class="block"><h3>指示する</h3>` +
        `<b>C</b> で通信メニュー。数字キーで僚機へ指示、または敵を挑発できる。</div>`,
      items: [{ label: '戻る', onSelect: () => this.showTitle() }],
      onCancel: () => this.showTitle(),
    });
  }

  private showSettings(back: () => void): void {
    const panel = buildSettingsPanel(() => {
      this.game.applyDifficulty();
      this.game.input.mouseFlight = settings.mouseFlight;
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
      this.save = newSave();
      writeSave(this.save);
    } else {
      this.save = loadSave() ?? newSave();
    }
    this.selection = undefined;
    this.showHub();
  }

  private currentMission(): MissionDef {
    const node = campaignNode(this.save.node);
    return missionDef(node.missionId);
  }

  private loadoutFor(def: MissionDef): Loadout {
    const sel = this.ensureSelection(def);
    const load: Loadout = {
      shipId: sel.shipId,
      gunId: sel.gunId,
      missiles: sel.missiles,
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
          obedience: pers.obedience,
          aggression: pers.aggression,
          caution: pers.caution,
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
      totalChapters: TOTAL_CHAPTERS,
    };
  }

  /** 出撃準備の選択内容 (未設定ならミッションの既定から作る) */
  private ensureSelection(def: MissionDef): HangarSelection {
    if (!this.selection || this.selection.shipId === undefined) {
      this.selection = {
        shipId: def.playerShipId,
        missiles: def.playerMissiles,
        wingmanId: defaultWingman(this.save.roster),
      };
    }
    // 僚機が戦死・負傷していたら選び直す
    const w = this.selection.wingmanId
      ? pilotState(this.save.roster, this.selection.wingmanId)
      : undefined;
    if (!w || w.status !== 'active' || w.benchedFor > 0) {
      this.selection.wingmanId = defaultWingman(this.save.roster);
    }
    return this.selection;
  }

  /**
   * 母艦ハブ。出撃前の行き先を選ぶ。
   * WC の「ミッションの間」を作るための画面。
   */
  private showHub(): void {
    this.game.sound.music.play('theme');
    if (isTerminal(this.save.node)) {
      this.showEnding(this.save.node === VICTORY);
      return;
    }
    const node = campaignNode(this.save.node);
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
        `第 ${node.chapter} 章 / ${TOTAL_CHAPTERS}　—　${def.system} 星系` +
        `${node.losingRoute ? '　(戦況悪化)' : ''}`,
      bodyHtml:
        `<div class="block">` +
        `<div class="mc-rank-line">${artImg(rankArt(rank.id), { className: 'mc-rank-pin', height: 26, alt: rank.label })}` +
        `<span>${escapeHtml(rank.label)}　通算撃墜 ${this.save.totalKills}　出撃 ${this.save.sorties} 回` +
        `${dead.length ? `　<span class="ng">戦死 ${dead.length} 名</span>` : ''}</span></div>` +
        `<div class="dim">次の任務: ${escapeHtml(def.title)}</div>` +
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
    this.screens.show({
      background: artUrl('tex/bg-bar', 'jpg'),
      title: '酒場',
      bodyHtml: recRoomHtml(this.hubContext()),
      items: [
        { label: 'もう少し話す', onSelect: () => this.showRecRoom() },
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
      items: [{ label: '戻る', onSelect: () => this.showHub() }],
      onCancel: () => this.showHub(),
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

  /** 格納庫: 機体と僚機を選ぶ */
  private showHangar(): void {
    const def = this.currentMission();
    const sel = this.ensureSelection(def);
    const ships = [...PLAYABLE_SHIPS];
    const avail = availablePilots(this.save.roster);

    const items: MenuItem[] = [
      {
        label: `機体を変える (${escapeHtml(shipDef(sel.shipId).name)})`,
        onSelect: () => {
          const i = ships.indexOf(sel.shipId as (typeof ships)[number]);
          sel.shipId = ships[(i + 1) % ships.length];
          // 機体を変えたら副兵装は機体の既定に戻す
          sel.missiles =
            sel.shipId === def.playerShipId ? def.playerMissiles : undefined;
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
    const node = campaignNode(this.save.node);
    const def = this.currentMission();
    const ship = shipDef(def.playerShipId);
    const load = this.loadoutFor(def);
    const missiles = (load.missiles ?? ship.missiles)
      .map((m) => `${missileDef(m.missileId).name} ×${m.count}`)
      .join(' / ');

    const objectives = def.objectives
      .map((o) => `<li>${escapeHtml(o.text)}${o.required ? '' : ' <span class="dim">(任意)</span>'}</li>`)
      .join('');
    const speech = def.briefing
      .map((p) => `<div>${escapeHtml(p)}</div>`)
      .join('');

    this.screens.show({
      crest: artUrl('emblem-confed'),
      crestHeight: 64,
      background: artUrl('tex/bg-briefing', 'jpg'),
      title: def.title,
      subtitle: `第 ${node.chapter} 章 / ${TOTAL_CHAPTERS}　—　${def.system} 星系${node.losingRoute ? '　(戦況悪化)' : ''}`,
      bodyHtml:
        `<div class="mc-two">` +
        `<div>` +
        `<div class="block"><h3>ブリーフィング</h3>` +
        `<div class="speaker">${escapeHtml(def.briefingSpeaker)}:</div>${speech}</div>` +
        `</div><div>` +
        `<div class="block"><h3>任務目標</h3><ul>${objectives}</ul></div>` +
        `<div class="block"><h3>飛行計画</h3>${this.navMapSvg(def)}</div>` +
        `<div class="block"><h3>機体</h3>` +
        `${escapeHtml(ship.name)}<br><span class="dim">副兵装: ${escapeHtml(missiles || 'なし')}` +
        `${def.wingman ? `<br>僚機: ${escapeHtml(def.wingman.pilot)}` : ''}</span></div>` +
        `</div></div>`,
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
      hint: `難易度: ${difficulty().label}`,
    });
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
      const py = 20 + ((z - (minZ + maxZ) / 2) / span + 0.5) * 120;
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
      `<svg viewBox="0 0 200 160" style="width:100%;max-width:340px;background:rgba(4,10,12,0.6);border:1px solid rgba(127,227,176,0.25)">` +
      `<path d="${path.join(' ')}" fill="none" stroke="rgba(127,227,176,0.55)" stroke-width="1" stroke-dasharray="3 3"/>` +
      nodes.join('') +
      `</svg>`
    );
  }

  private launch(withTutorial = false): void {
    const def = this.currentMission();
    this.screens.hide();
    this.save.sorties++;
    writeSave(this.save);
    this.game.startMission(def, this.loadoutFor(def), withTutorial);
  }

  /** 初回プレイの1本目だけ訓練案内を出す */
  private shouldTutorial(): boolean {
    return !settings.tutorialDone && this.save.node === CAMPAIGN_START;
  }

  private onMissionEnd(outcome: 'win' | 'loss'): void {
    this.lastSummary = this.game.runner?.summary();
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
    const kills = s?.kills ?? 0;
    this.save.totalKills += kills;
    if (outcome === 'win' && !this.save.cleared.includes(def.id)) {
      this.save.cleared.push(def.id);
    }
    const nextNode = advance(this.save.node, outcome);
    this.save.node = nextNode;
    writeSave(this.save);

    const objectives = (s?.objectives ?? [])
      .map(
        (o) =>
          `<li class="${o.state === 'done' ? 'ok' : o.state === 'failed' ? 'ng' : 'dim'}">` +
          `${o.state === 'done' ? '達成' : o.state === 'failed' ? '失敗' : '未達'}　${escapeHtml(o.text)}</li>`,
      )
      .join('');
    const speech = (outcome === 'win' ? def.debriefWin : def.debriefLoss)
      .map((p) => `<div>${escapeHtml(p)}</div>`)
      .join('');
    const minutes = Math.floor((s?.seconds ?? 0) / 60);
    const seconds = Math.floor((s?.seconds ?? 0) % 60);

    this.game.sound.music.setIntensity(0);
    this.game.sound.music.play(outcome === 'win' ? 'victory' : 'requiem');
    this.screens.show({
      crest: outcome === 'win' ? artUrl('emblem-confed') : artUrl('emblem-kilrathi'),
      crestHeight: 72,
      title: outcome === 'win' ? '任務達成' : '任務失敗',
      subtitle: def.title,
      bodyHtml:
        `<div class="block"><h3>デブリーフィング</h3>` +
        `<div class="speaker">${escapeHtml(def.briefingSpeaker)}:</div>${speech}</div>` +
        `<div class="block"><h3>戦果</h3><ul>` +
        `<li>撃墜 ${kills} 機</li>` +
        `<li>撃退 ${s?.routed ?? 0} 機</li>` +
        `<li>飛行時間 ${minutes}分${String(seconds).padStart(2, '0')}秒</li>` +
        `<li>通算撃墜 ${this.save.totalKills} 機 / 出撃 ${this.save.sorties} 回</li>` +
        `</ul></div>` +
        `<div class="block"><h3>目標</h3><ul>${objectives}</ul></div>` +
        (outcome === 'loss'
          ? `<div class="block dim">失敗しても戦争は続く。次の任務は戦況の悪化を受けたものになる。</div>`
          : ''),
      items: [
        { label: '続ける', onSelect: () => this.afterDebrief(nextNode) },
        { label: 'この任務をやり直す', onSelect: () => this.retry(def.id, outcome) },
        { label: 'タイトルへ戻る', onSelect: () => this.showTitle() },
      ],
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

    this.game.sound.music.play('requiem');
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
    for (const [id, node] of Object.entries(CAMPAIGN)) {
      if (node.missionId === missionId) {
        this.save.node = id;
        break;
      }
    }
    writeSave(this.save);
    this.selection = undefined;
    this.showHub();
  }

  private showEnding(victory: boolean): void {
    this.game.sound.music.play(victory ? 'victory' : 'requiem');
    this.game.endMission();
    this.screens.show({
      crest: victory ? artUrl('emblem-confed') : artUrl('emblem-kilrathi'),
      crestHeight: 132,
      title: victory ? '戦役完了' : '戦役終了',
      heroTitle: true,
      subtitle: victory ? 'VEGA SECTOR SECURED' : 'TIGER’S CLAW LOST',
      bodyHtml: victory
        ? `<div class="block">` +
          `ヴェガ宙域からキルラシー艦隊は退いた。タイガーズ・クローは健在で、君はまだ生きている。` +
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
      items: [{ label: '戻る', onSelect: () => this.showPause2() }],
      onCancel: () => this.showPause2(),
      transparent: true,
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
