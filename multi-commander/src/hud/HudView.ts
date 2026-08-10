import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { bus } from '../core/events';
import { settings } from '../app/settings';
import { AIM_ORIGIN_Y } from '../core/aim';
import { clamp01 } from '../core/math';
import { FACTION_HEX, factionColorVar, factionLabel, isHostile } from '../content/factions';
import { gunDef, gunPresentation, missileDef } from '../content/weapons';
import { healthRatios, healthValues, type HealthValue } from '../sim/damage';
import { radarQuality, stateOf, SUBSYSTEMS } from '../sim/subsystems';
import { primaryGunSpeed } from '../sim/targeting';
/**
 * 通信遅延 (第6章)。味方の位置は「報告位置」を通して読む。
 * レーダー・マーカー・ターゲット枠・距離・ITTS のすべてが同じ出所を使うので、
 * 表示だけが遅れて照準が正確、という状態にならない。
 * 遅延が宣言されていないミッションでは実位置がそのまま返る。
 */
import {
  commsDelaySeconds,
  reportedLeadPoint,
  reportedPosition,
  reportedVelocity,
} from '../sim/comms';
import { activeMissileSlot } from '../sim/weapons';
import type { ArmorFace, Entity } from '../world/entity';
import type { World } from '../world/world';
import { PILOTS } from '../content/pilots';
import { expressionFor, portraitFace } from '../ui/Portrait';
import { NavMap } from './NavMap';
import {
  clampLabel,
  edgeArrow,
  estimateLabelHalfWidth,
  openingRectPx,
  pointInRect,
  rectEdgeArrow,
  worldToScreen,
  type ScreenPoint,
  type ViewRect,
} from './project';
import { recoveryHudView, type RecoveryHudView } from './recoveryHud';
import {
  buildObjectiveLines,
  formatTimeLeft,
  objectiveMark,
  type ObjectiveLine,
  type ObjectiveView,
} from './objectiveLines';
import { warningText } from './warning';
import { HIT_EDGE_LABEL, hitEdgeOf, hitFaceOf, type HitEdge, type HitFace } from './hitDirection';
// 風防の開口部 (NDC)。3D 側 (render/Cockpit.ts) が唯一の出所なので、ここでは読むだけ。
import { COCKPIT_OPENING } from '../render/Cockpit';
import {
  damageStage,
  damageStageAdvice,
  damageStageLabel,
  type DamageStage,
} from './damageStage';

// 目標表示の型は `objectiveLines.ts` が持つ (3行に絞る組み立てと同じ場所)。
// 既存の参照 (`MissionRunner` など) をそのまま通すため、ここから再輸出する。
export type { ObjectiveLine, ObjectiveView } from './objectiveLines';

export interface HudFrame {
  world: World;
  camera: PerspectiveCamera;
  width: number;
  height: number;
  /** 入力レバーのスロットル値 */
  throttle: number;
  /** プレイヤー主砲の実弾速倍率。ITTS表示と弾道を一致させる。 */
  playerGunSpeedScale?: number;
  mouseFlight: boolean;
  stick?: { x: number; y: number };
  objectives?: ObjectiveView[];
  /** 現在向かっている Nav */
  nav?: Entity;
  /** マウス操縦の有効化待ち (カーソルを中央へ促す) */
  mouseArmPending?: boolean;
  /** オートパイロット作動中か */
  autopilot?: boolean;
  /** HUD 全体の表示 (メニュー中は false) */
  visible?: boolean;
}

const MAX_MARKERS = 28;
/**
 * 操縦ヒントを出しておく秒数 (T2-⑧)。
 * 画面中央に出したまま消えないと、航法マップにも重なって邪魔になる。
 */
export const MOUSE_HINT_SECONDS = 6;
/** 被弾方向の光と装甲図のハイライトを残す秒数。 */
export const HIT_DIRECTION_SECONDS = 1.6;
/** 直近に片付いた目標を「達成した1件」として出しておく秒数。 */
export const RECENT_OBJECTIVE_SECONDS = 8;
/** Nav ラベルの高さの半分 (px)。`.mc-marker` の font-size 12px から見積もる。 */
const NAV_LABEL_HALF_HEIGHT = 9;
/** マーカーを出す最大距離 */
const MARKER_RANGE = 24000;
/** 障害物をレーダーに映す距離 (数が多いので至近だけ) */
const HAZARD_RADAR_RANGE = 3000;

interface RadioLine {
  el: HTMLElement;
  until: number;
}

interface PendingTorpedo {
  targetId?: number;
  targetPosition?: Vector3;
  targetRadius?: number;
  targetLabel?: string;
  expiresAt: number;
}

interface PendingExplosion {
  pos: Vector3;
  radius: number;
}

/**
 * コクピット計器と照準表示 (DOM + SVG)。
 * ロジックからは毎フレーム update() を呼ぶだけ。
 */
export class HudView {
  private root: HTMLElement;
  private hud: HTMLElement;

  // 上部オーバーレイ
  private lead: HTMLElement;
  private tgtBox: HTMLElement;
  private tgtLabel: HTMLElement;
  private tgtArrow: HTMLElement;
  private navArrow: HTMLElement;
  private navMarker: HTMLElement;
  private markerPool: HTMLElement[] = [];
  private markersUsed = 0;
  private announce: HTMLElement;
  private announceUntil = 0;
  private radioBox: HTMLElement;
  private radioLines: RadioLine[] = [];
  /** 口を動かしている顔 (声が終わったら止める) */
  private speakingFaces: Array<{ el: HTMLElement; speaker: string; until: number }> = [];
  private killFeed: HTMLElement;
  private killLines: RadioLine[] = [];
  private pendingTorpedoes: PendingTorpedo[] = [];
  private pendingExplosions: PendingExplosion[] = [];
  private playerFaction?: Entity['faction'];
  private objectivesBox: HTMLElement;
  /** 全目標 (右 VDU の一覧ページで出す。常時表示は3行だけ) */
  private allObjectives: ObjectiveView[] = [];
  /** 直近に片付いた1件と、その残り表示時間 */
  private recentObjective?: ObjectiveView;
  private recentLeft = 0;
  /** 前フレームの目標状態 (片付いた瞬間を拾う) */
  private objectiveStates = new Map<string, ObjectiveView['state']>();
  private warnLock: HTMLElement;
  private warnMissile: HTMLElement;
  private warnShield: HTMLElement;
  private warnEject!: HTMLElement;
  /** ハル危険域の警告灯 (脱出できることを併記する) */
  private warnHull!: HTMLElement;
  private vignette: HTMLElement;
  private vignetteLevel = 0;
  /** ハル危険域で画面周辺を赤く縁取る枠 */
  private dangerFrame!: HTMLElement;
  private dangerPhase = 0;
  /** 被弾段階が進んだときだけ出す短い告知 (任務アナウンスとは別枠) */
  private stageEl!: HTMLElement;
  private stageUntil = 0;
  /** 戦死者の名前を画面中央に出す枠 (右上の撃墜ログとは別) */
  private casualtyEl!: HTMLElement;
  private casualtyUntil = 0;
  /** 外部視点用の最小 HUD (ダッシュボードを隠した代わりに出す) */
  private extHud!: HTMLElement;
  private externalView = false;
  private stickEl: HTMLElement;
  private autopilotEl: HTMLElement;
  private mouseHintEl!: HTMLElement;
  /** お手本モードの実演中か (マウス操縦の促しを抑える) */
  private demoMode = false;
  /** 操縦ヒントの残り表示時間 (0 で消す)。促しが終わっても出しっぱなしにしない。 */
  private mouseHintLeft = 0;
  /** 促しが立ち上がった瞬間を拾うための前フレームの値 */
  private mouseHintArmed = false;
  /** 被弾方向を示す画面端の光 (4辺) */
  private hitEdgeEls: Record<HitEdge, HTMLElement> = {} as Record<HitEdge, HTMLElement>;
  /** 辺ごとの残り時間 */
  private hitEdgeLeft: Record<HitEdge, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  /** 被弾方向の文字表示 (点滅を抑える設定でも情報が残るように) */
  private hitDirEl!: HTMLElement;
  private hitDirLeft = 0;
  /** 直前に食らった装甲面 (装甲図でハイライトする) */
  private hitFace?: HitFace;
  private hitFaceLeft = 0;
  /** 通信遅延の表示 (第6章。遅延が無い作戦では常に非表示) */
  private commsDelayEl!: HTMLElement;
  /** 収容 (T4-⑮) の進捗と条件。`recovery` イベントの間だけ出す */
  private recoveryEl!: HTMLElement;
  private recoveryBar!: HTMLElement;
  private recoveryTitle!: HTMLElement;
  private recoveryAdvice!: HTMLElement;
  private cockpit: HTMLElement;
  private chrome: HTMLElement[] = [];
  /** コクピット装飾 (風防・計器盤の筐体) が出ているか */
  private decorated = false;

  // 計器
  private vduLeft: HTMLElement;
  private vduRight: HTMLElement;
  private gaugeEls: Record<string, { root: HTMLElement; fill: HTMLElement; val: HTMLElement }> = {};
  private speedEl: HTMLElement;
  private hullNum: HTMLElement;
  private shieldParts: Record<string, SVGElement> = {};
  /** 翼下パイロン (副兵装の残弾)。発射順と同じ左右交互の並び */
  private readonly missilePips: SVGElement[] = [];
  /** 残弾の数値表示 (パイロンの数より多い場合もあるので数字も出す) */
  private mslNum!: HTMLElement;
  private radarBlips: SVGCircleElement[] = [];
  private radarG: SVGGElement;
  /** レーダー上の目的地マーカー（現在向かっている Nav）。機体の点と混ざらないよう菱形にする */
  private radarNav!: SVGPathElement;
  private radarBox!: HTMLElement;
  private radarNoise = 1;

  /** D キーで右 VDU を武装/被害に切り替える */
  damageMode = false;
  /**
   * V キーで切り替える、通常時の右 VDU ページ。
   *
   * 目標の常時表示を3行に絞った代わりに、**全目標の一覧を3ページ目**に置く (T2-⑧)。
   * 新しいキーを増やさないので、既存の割り当て (X / D / N など) と衝突しない。
   */
  private rightVduPage: 'tactical' | 'weapons' | 'objectives' = 'tactical';
  /** N キーで開く航法マップ */
  readonly navMap: NavMap;
  private shown = true;

  private unsubs: Array<() => void> = [];
  private tmpScreen: ScreenPoint = { x: 0, y: 0, inFront: false, onScreen: false };
  private tmpV = new Vector3();
  /** 報告位置・報告速度の作業用 (通信遅延) */
  private tmpReport = new Vector3();
  private tmpReportVel = new Vector3();
  private tmpQ = new Quaternion();

  constructor(container: HTMLElement) {
    this.root = container;
    this.hud = el('div', 'mc-hud');
    this.root.appendChild(this.hud);

    this.hud.appendChild(reticleSvg());
    this.lead = el('div', 'mc-lead');
    this.lead.appendChild(leadSvg());
    this.lead.style.display = 'none';
    this.hud.appendChild(this.lead);

    this.tgtBox = el('div', 'mc-tgtbox');
    this.tgtLabel = el('div', 'mc-tgtbox-label');
    this.tgtBox.appendChild(this.tgtLabel);
    this.tgtBox.style.display = 'none';
    this.hud.appendChild(this.tgtBox);

    this.tgtArrow = el('div', 'mc-arrow');
    this.tgtArrow.style.color = 'var(--enemy)';
    this.tgtArrow.style.display = 'none';
    this.hud.appendChild(this.tgtArrow);

    this.navArrow = el('div', 'mc-arrow');
    this.navArrow.style.color = 'var(--hud)';
    this.navArrow.style.display = 'none';
    this.hud.appendChild(this.navArrow);

    this.navMarker = el('div', 'mc-marker nav');
    this.navMarker.style.display = 'none';
    this.hud.appendChild(this.navMarker);

    this.announce = el('div', 'mc-announce');
    this.hud.appendChild(this.announce);

    this.radioBox = el('div', 'mc-radio');
    this.hud.appendChild(this.radioBox);
    this.killFeed = el('div', 'mc-killfeed');
    this.hud.appendChild(this.killFeed);
    this.objectivesBox = el('div', 'mc-objectives');
    this.hud.appendChild(this.objectivesBox);

    const warn = el('div', 'mc-warnlights');
    this.warnLock = el('span', 'lock');
    this.warnLock.textContent = 'ロックオン警告';
    this.warnMissile = el('span', 'missile');
    this.warnMissile.textContent = 'ミサイル接近';
    this.warnShield = el('span', 'shield');
    this.warnShield.textContent = 'シールド低下';
    this.warnEject = el('span', 'eject');
    this.warnEject.textContent = '脱出 — 救助待機';
    // ハル危険域。「何が起きたか」＋「どうするか」を1つの灯に載せる。
    this.warnHull = el('span', 'eject');
    this.warnHull.textContent = 'ハル危険域 — Alt+E で脱出';
    warn.append(this.warnLock, this.warnMissile, this.warnShield, this.warnEject, this.warnHull);
    this.hud.appendChild(warn);

    this.vignette = el('div', 'mc-vignette');
    this.hud.appendChild(this.vignette);

    // 被弾方向の光 (T2-⑨)。左から撃たれたら左端が赤く光る。
    // 位置と大きさはここで指定し、濃さだけを毎フレーム動かす。
    for (const edge of ['left', 'right', 'top', 'bottom'] as HitEdge[]) {
      const n = el('div', `mc-hitedge ${edge}`);
      n.style.position = 'absolute';
      n.style.pointerEvents = 'none';
      const across = edge === 'left' || edge === 'right' ? '16%' : '100%';
      const along = edge === 'left' || edge === 'right' ? '100%' : '14%';
      n.style.width = across;
      n.style.height = along;
      n.style.top = edge === 'bottom' ? 'auto' : '0';
      n.style.bottom = edge === 'bottom' ? '0' : 'auto';
      n.style.left = edge === 'right' ? 'auto' : '0';
      n.style.right = edge === 'right' ? '0' : 'auto';
      const to =
        edge === 'left' ? 'right' : edge === 'right' ? 'left' : edge === 'top' ? 'bottom' : 'top';
      n.style.background = `linear-gradient(to ${to}, rgba(255,60,60,0.85), rgba(255,60,60,0))`;
      n.style.opacity = '0';
      n.style.display = 'none';
      this.hitEdgeEls[edge] = n;
      this.hud.appendChild(n);
    }

    // 被弾方向の文字。点滅を抑える設定でも「どこから撃たれたか」が残る。
    this.hitDirEl = el('div', 'mc-hitdir');
    this.hitDirEl.style.position = 'absolute';
    this.hitDirEl.style.left = '50%';
    this.hitDirEl.style.top = '19%';
    this.hitDirEl.style.transform = 'translateX(-50%)';
    this.hitDirEl.style.padding = '2px 10px';
    this.hitDirEl.style.background = 'rgba(4,12,14,0.72)';
    this.hitDirEl.style.color = '#ff9b7a';
    this.hitDirEl.style.fontSize = '15px';
    this.hitDirEl.style.letterSpacing = '0.1em';
    this.hitDirEl.style.textShadow = '0 0 8px #000';
    this.hitDirEl.style.display = 'none';
    this.hud.appendChild(this.hitDirEl);

    // ハル危険域の赤い縁取り。CSS を増やさずに済むよう、見た目はここで指定する
    // (`src/styles/cockpit.css` は別作業で編集中のため、新しい規則を足さない)。
    this.dangerFrame = el('div', 'mc-hulldanger');
    this.dangerFrame.style.position = 'absolute';
    this.dangerFrame.style.inset = '0';
    this.dangerFrame.style.pointerEvents = 'none';
    this.dangerFrame.style.boxShadow = 'inset 0 0 90px 22px rgba(255,40,40,0.55)';
    this.dangerFrame.style.border = '2px solid rgba(255,70,70,0.75)';
    this.dangerFrame.style.opacity = '0';
    this.dangerFrame.style.display = 'none';
    this.hud.appendChild(this.dangerFrame);

    // 被弾段階の告知。任務アナウンス (mc-announce) を潰さないよう別の位置に出す。
    this.stageEl = el('div', 'mc-damagestage');
    this.stageEl.style.position = 'absolute';
    this.stageEl.style.left = '50%';
    this.stageEl.style.top = '14%';
    this.stageEl.style.transform = 'translateX(-50%)';
    this.stageEl.style.padding = '3px 12px';
    this.stageEl.style.background = 'rgba(4,12,14,0.72)';
    this.stageEl.style.color = '#ff8f6a';
    this.stageEl.style.fontSize = '17px';
    this.stageEl.style.fontWeight = '700';
    this.stageEl.style.letterSpacing = '0.1em';
    this.stageEl.style.textShadow = '0 0 8px #000';
    this.stageEl.style.display = 'none';
    this.hud.appendChild(this.stageEl);

    // 戦死者・自機撃墜の告知。右上の撃墜ログでは見落とすので中央に出す。
    this.casualtyEl = el('div', 'mc-casualty');
    this.casualtyEl.style.position = 'absolute';
    this.casualtyEl.style.left = '50%';
    this.casualtyEl.style.top = '44%';
    this.casualtyEl.style.transform = 'translate(-50%,-50%)';
    this.casualtyEl.style.textAlign = 'center';
    this.casualtyEl.style.color = '#ff6b6b';
    this.casualtyEl.style.fontSize = '30px';
    this.casualtyEl.style.fontWeight = '700';
    this.casualtyEl.style.letterSpacing = '0.14em';
    this.casualtyEl.style.lineHeight = '1.35';
    this.casualtyEl.style.textShadow = '0 0 12px #000, 0 0 26px rgba(255,60,60,0.6)';
    this.casualtyEl.style.display = 'none';
    this.hud.appendChild(this.casualtyEl);

    // 収容の進捗と条件 (T4-⑮)。「何をすれば良いか」を必ず一緒に出す。
    // 照準環 (50%) と被弾段階 (14%) を避けて、視界の下寄りに置く。
    // CSS を増やさずに済むよう見た目はここで指定する
    // (`src/styles/cockpit.css` は別作業で編集中のため、新しい規則を足さない)。
    this.recoveryEl = el('div', 'mc-recovery');
    this.recoveryEl.style.position = 'absolute';
    this.recoveryEl.style.left = '50%';
    this.recoveryEl.style.top = '62%';
    this.recoveryEl.style.transform = 'translateX(-50%)';
    this.recoveryEl.style.minWidth = '300px';
    this.recoveryEl.style.padding = '4px 14px 6px';
    this.recoveryEl.style.background = 'rgba(4,12,14,0.72)';
    this.recoveryEl.style.border = '1px solid rgba(127,227,176,0.35)';
    this.recoveryEl.style.textAlign = 'center';
    this.recoveryEl.style.textShadow = '0 0 8px #000';
    this.recoveryEl.style.pointerEvents = 'none';
    this.recoveryEl.style.display = 'none';
    this.recoveryTitle = el('div', 'mc-recovery-title');
    this.recoveryTitle.style.fontSize = '17px';
    this.recoveryTitle.style.fontWeight = '700';
    this.recoveryTitle.style.letterSpacing = '0.08em';
    this.recoveryAdvice = el('div', 'mc-recovery-advice');
    this.recoveryAdvice.style.fontSize = '15px';
    this.recoveryAdvice.style.letterSpacing = '0.06em';
    this.recoveryAdvice.style.color = '#ffd9a0';
    const recoveryTrack = el('div', 'mc-recovery-track');
    recoveryTrack.style.marginTop = '4px';
    recoveryTrack.style.height = '5px';
    recoveryTrack.style.background = 'rgba(127,227,176,0.16)';
    this.recoveryBar = el('div', 'mc-recovery-bar');
    this.recoveryBar.style.height = '100%';
    this.recoveryBar.style.width = '0%';
    this.recoveryBar.style.background = 'var(--hud)';
    recoveryTrack.appendChild(this.recoveryBar);
    this.recoveryEl.appendChild(this.recoveryTitle);
    this.recoveryEl.appendChild(this.recoveryAdvice);
    this.recoveryEl.appendChild(recoveryTrack);
    this.hud.appendChild(this.recoveryEl);

    // 外部視点で計器盤を隠した代わりに出す最小 HUD。
    // 情報を消すのではなく置き換える (速度・スロットル・ターゲット・目標)。
    this.extHud = el('div', 'mc-exthud');
    this.extHud.style.position = 'absolute';
    this.extHud.style.left = '50%';
    this.extHud.style.bottom = '24px';
    this.extHud.style.transform = 'translateX(-50%)';
    this.extHud.style.padding = '6px 16px';
    this.extHud.style.border = '1px solid rgba(127,227,176,0.35)';
    this.extHud.style.background = 'rgba(4,14,14,0.72)';
    this.extHud.style.color = 'var(--hud)';
    this.extHud.style.fontSize = '15px';
    this.extHud.style.letterSpacing = '0.08em';
    this.extHud.style.lineHeight = '1.5';
    this.extHud.style.textAlign = 'center';
    this.extHud.style.whiteSpace = 'pre';
    this.extHud.style.textShadow = '0 0 6px #000';
    this.extHud.style.display = 'none';
    this.hud.appendChild(this.extHud);

    this.stickEl = el('div', 'mc-stick');
    this.stickEl.style.display = 'none';
    this.hud.appendChild(this.stickEl);

    this.autopilotEl = el('div', 'mc-autopilot');
    this.autopilotEl.style.display = 'none';
    this.hud.appendChild(this.autopilotEl);

    this.mouseHintEl = el('div', 'mc-mousehint');
    this.mouseHintEl.textContent = 'マウスを照準へ動かすと操縦できます (M でマウス操縦 OFF)';
    this.mouseHintEl.style.display = 'none';
    this.hud.appendChild(this.mouseHintEl);

    // 通信遅延の表示。CSS を増やさずに済むよう、位置と色はここで指定する
    // (遅延を宣言していない作戦では display:none のまま一度も出ない)。
    this.commsDelayEl = el('div', 'mc-commsdelay');
    this.commsDelayEl.style.position = 'absolute';
    this.commsDelayEl.style.right = '20px';
    this.commsDelayEl.style.top = '96px';
    this.commsDelayEl.style.color = '#ffd166';
    this.commsDelayEl.style.fontSize = '13px';
    this.commsDelayEl.style.letterSpacing = '0.08em';
    this.commsDelayEl.style.textShadow = '0 0 6px rgba(0,0,0,0.8)';
    this.commsDelayEl.style.display = 'none';
    this.hud.appendChild(this.commsDelayEl);

    // ── コクピット ──
    // 風防の枠と柱は 3D 内装 (render/Cockpit.ts) が描くので、
    // DOM 側は計器パネルだけを重ねる
    const cockpit = el('div', 'mc-cockpit');
    this.cockpit = cockpit;

    // 3D 内装はカメラに追従するが、HUD の読み取り面は画面上の固定構図にする。
    // 16:9 の左右に余白を残し、4:3 に近い視界の中へ計器を収める。
    const cockpitFrame = el('div', 'mc-cockpit-frame');
    const leftPillar = el('div', 'mc-pillar left');
    const rightPillar = el('div', 'mc-pillar right');
    cockpit.append(cockpitFrame, leftPillar, rightPillar);

    const panels = el('div', 'mc-panels');
    this.vduLeft = el('div', 'mc-vdu left');
    this.vduRight = el('div', 'mc-vdu right');

    const center = el('div', 'mc-center');
    const gauges = el('div', 'mc-gauges');
    this.speedEl = el('div', 'mc-speed');
    gauges.appendChild(this.speedEl);
    for (const g of [
      { id: 'throttle', label: 'THROTTLE' },
      { id: 'energy', label: 'GUN PWR' },
      { id: 'fuel', label: 'AB FUEL' },
    ]) {
      gauges.appendChild(this.makeGauge(g.id, g.label));
    }

    const shieldBox = el('div', 'mc-shielddisp');
    const sl = el('div', 'mc-boxlabel');
    // 機体の被害と搭載兵装を同じ図で示す (機首・翼の位置＝被弾面、翼下＝副兵装)。
    // ラベルは短くする。狭い計器では右上の残弾表示と重なる。
    sl.textContent = 'DAMAGE';
    shieldBox.append(this.shieldSvg(), sl);
    this.hullNum = el('div', 'mc-hullnum');
    this.mslNum = el('div', 'mc-mslnum');
    shieldBox.append(this.hullNum, this.mslNum);

    const radarBox = el('div', 'mc-radarbox');
    this.radarBox = radarBox;
    const rl = el('div', 'mc-boxlabel');
    rl.textContent = 'RADAR';
    const { svg, g, nav } = radarSvg();
    this.radarG = g;
    this.radarNav = nav;
    radarBox.append(svg, rl);

    center.append(gauges, shieldBox, radarBox);
    panels.append(this.vduLeft, center, this.vduRight);
    // 計器盤の上端を走る梁と警告灯の列 (生成アセット)
    cockpit.appendChild(el('div', 'mc-dashtrim'));
    cockpit.appendChild(el('div', 'mc-lamprow'));
    cockpit.appendChild(panels);
    this.root.appendChild(cockpit);

    this.navMap = new NavMap(this.root);
    this.chrome.push(this.hud, cockpit);

    this.subscribe();
  }

  /** 視認性に直接関係しないコクピット装飾だけをまとめて切り替える。 */
  setCockpitDecorations(enabled: boolean): void {
    this.decorated = enabled;
    this.cockpit.classList.toggle('decorated', enabled);
    this.hud.classList.toggle('cockpit-decorated', enabled);
  }

  /**
   * いま実際に外が見えている範囲 (ピクセル)。
   *
   * コクピット装飾が ON のときは、風防の開口部より外は構造物なので、
   * そこにターゲット枠やラベルを描くと「見えない敵に枠が付く」ことになる。
   * 装飾 OFF と外部視点では制限しない (従来どおり画面全体)。
   *
   * @param margin 縁から内側に取る余白 (矢印を置くときに使う)
   */
  private viewRect(width: number, height: number, margin = 0): ViewRect | undefined {
    if (!this.decorated || this.externalView) return undefined;
    return openingRectPx(COCKPIT_OPENING, width, height, margin);
  }

  /** 開口部の内側に描けるか (画面内かつ構造物に隠れていない)。 */
  private isReadable(p: ScreenPoint, rect: ViewRect | undefined): boolean {
    return p.onScreen && (!rect || pointInRect(p, rect));
  }

  /**
   * 見えていない対象を指す矢印。
   * 開口部があるときは画面の縁ではなく**開口部の縁**へ寄せる。
   */
  private clippedArrow(
    f: HudFrame,
    pos: Vector3,
    margin: number,
    p: ScreenPoint,
  ): { x: number; y: number; angleDeg: number } {
    const arrowRect = this.viewRect(f.width, f.height, margin);
    // 前方にあるなら、投影点の向きをそのまま使う (敵の真上あたりに矢印が出る)
    if (arrowRect && p.inFront) return rectEdgeArrow(p, arrowRect);
    const a = edgeArrow(f.camera, pos, f.width, f.height, margin);
    if (!arrowRect) return a;
    return { ...rectEdgeArrow(a, arrowRect), angleDeg: a.angleDeg };
  }

  /**
   * 外部視点 (F) ではダッシュボードを隠し、最小 HUD に置き換える。
   *
   * 情報を消すと操作不能になるので、速度・スロットル・ターゲット・目標は
   * `mc-exthud` に出し続ける。視点の違いが一目で分かることが目的。
   */
  setExternalView(external: boolean): void {
    if (this.externalView === external) return;
    this.externalView = external;
    this.applyChromeVisibility();
  }

  /**
   * お手本モードの実演中かを伝える。
   * 実演中は操縦を代行しているので、マウス操縦の促しは出さない。
   */
  setDemoMode(on: boolean): void {
    this.demoMode = on;
    if (on) this.mouseHintEl.style.display = 'none';
  }

  /** 外部視点かどうか (テスト・確認用) */
  get isExternalView(): boolean {
    return this.externalView;
  }

  /** ダッシュボードが表示されているか (テスト・確認用) */
  get dashboardVisible(): boolean {
    return this.cockpit.style.display !== 'none';
  }

  private applyChromeVisibility(): void {
    for (const n of this.chrome) n.style.display = this.shown ? '' : 'none';
    // ダッシュボード (DOM の計器盤) は外部視点では出さない。
    this.cockpit.style.display = this.shown && !this.externalView ? '' : 'none';
    this.extHud.style.display = this.shown && this.externalView ? '' : 'none';
  }

  /**
   * 戦死・自機撃墜を画面中央に出す。
   * 右上の撃墜ログは流れて消えるため、見落とされない位置に別枠で置く。
   */
  showCasualty(title: string, note = '', durationMs = 2600): void {
    this.casualtyEl.innerHTML = note
      ? `<div>${escapeHtml(title)}</div><div style="font-size:16px;letter-spacing:0.1em;color:#ffb3a7">${escapeHtml(note)}</div>`
      : `<div>${escapeHtml(title)}</div>`;
    this.casualtyEl.style.display = '';
    this.casualtyUntil = performance.now() + durationMs;
  }

  /**
   * 収容の表示 (T4-⑮)。`undefined` で消す。
   *
   * 文言と進捗の割合は `hud/recoveryHud.ts` が唯一の出所。
   * ここでは色（保持中＝緑 / 条件未達＝橙）と幅を当てるだけにして、
   * 表示から条件を逆算する経路を作らない。
   */
  showRecovery(view?: RecoveryHudView): void {
    if (!view) {
      this.recoveryEl.style.display = 'none';
      this.recoveryBar.style.width = '0%';
      return;
    }
    this.recoveryEl.style.display = '';
    this.recoveryTitle.textContent = view.title;
    this.recoveryAdvice.textContent = view.advice;
    this.recoveryTitle.style.color = view.holding ? 'var(--hud)' : '#ffb066';
    this.recoveryBar.style.background = view.holding ? 'var(--hud)' : '#ffb066';
    this.recoveryBar.style.width = `${Math.round(clamp01(view.ratio) * 100)}%`;
  }

  /** 収容表示が出ているか (テスト・確認用) */
  get recoveryVisible(): boolean {
    return this.recoveryEl.style.display !== 'none';
  }

  /** 被弾段階が進んだときの告知 (段階名 + どうするか)。 */
  showDamageStage(stage: DamageStage, durationMs = 2600): void {
    const label = damageStageLabel(stage);
    if (!label) return;
    this.stageEl.textContent = `${label} — ${damageStageAdvice(stage)}`;
    this.stageEl.style.display = '';
    this.stageUntil = performance.now() + durationMs;
  }

  /** 画面中央の告知が出ているか (テスト・確認用) */
  get casualtyVisible(): boolean {
    return this.casualtyEl.style.display !== 'none';
  }

  /** 任務をまたいで持ち越してはいけない HUD の一時表示を消す。 */
  resetTransientState(): void {
    this.announce.textContent = '';
    this.announce.className = 'mc-announce';
    this.announceUntil = 0;

    for (const line of this.radioLines) line.el.remove();
    this.radioLines = [];
    for (const line of this.killLines) line.el.remove();
    this.killLines = [];
    this.pendingTorpedoes = [];
    this.pendingExplosions = [];
    this.playerFaction = undefined;
    this.speakingFaces = [];

    // 収容表示は任務をまたいで残さない (T4-⑮)
    this.showRecovery(undefined);

    this.objectivesBox.textContent = '';
    delete this.objectivesBox.dataset.sig;
    this.allObjectives = [];
    this.objectiveStates.clear();
    this.recentObjective = undefined;
    this.recentLeft = 0;
    // 被弾方向の光・文字・装甲図のハイライトは任務をまたいで残さない
    for (const edge of ['left', 'right', 'top', 'bottom'] as HitEdge[]) {
      this.hitEdgeLeft[edge] = 0;
      this.hitEdgeEls[edge].style.display = 'none';
      this.hitEdgeEls[edge].style.opacity = '0';
    }
    this.hitDirLeft = 0;
    this.hitDirEl.style.display = 'none';
    this.hitFace = undefined;
    this.hitFaceLeft = 0;
    this.mouseHintLeft = 0;
    this.mouseHintArmed = false;
    this.mouseHintEl.style.display = 'none';
    this.vignetteLevel = 0;
    this.vignette.style.opacity = '0';
    this.navMap.setOpen(false);
    this.rightVduPage = 'tactical';

    // 段階告知・戦死告知・危険域の縁取りは任務をまたいで残してはいけない
    this.stageUntil = 0;
    this.stageEl.style.display = 'none';
    this.casualtyUntil = 0;
    this.casualtyEl.style.display = 'none';
    this.dangerFrame.style.display = 'none';
    this.dangerFrame.style.opacity = '0';
    this.dangerPhase = 0;
    this.externalView = false;
    this.applyChromeVisibility();
  }

  /** 右 VDU のページを順に送る (戦術 → 武装 → 目標一覧 → 戦術)。 */
  toggleRightVduPage(): void {
    this.rightVduPage =
      this.rightVduPage === 'tactical'
        ? 'weapons'
        : this.rightVduPage === 'weapons'
          ? 'objectives'
          : 'tactical';
  }

  /** 右 VDU の現在ページ (テスト・確認用)。 */
  get vduPage(): 'tactical' | 'weapons' | 'objectives' {
    return this.rightVduPage;
  }

  private makeGauge(id: string, label: string): HTMLElement {
    const root = el('div', 'mc-gauge');
    const lbl = el('div', 'lbl');
    const name = el('span');
    name.textContent = label;
    const val = el('span');
    lbl.append(name, val);
    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    bar.appendChild(fill);
    root.append(lbl, bar);
    this.gaugeEls[id] = { root, fill, val };
    return root;
  }

  /**
   * 被害表示 (SHIELDS / ARMOR)。
   *
   * ■ 図の作り
   * 抽象的な四象限ではなく、**上から見た自機の形**で描く。
   * 「機首を撃たれた」「左翼を撃たれた」が図の位置と一致するので、
   * どこから来ているか (`hitFace`) が直感的に読める。
   * - 機首 = front / 尾部 = rear / 左翼 = left / 右翼 = right / 胴体 = hull
   * - 前後の円弧 = シールド
   *
   * ■ 翼下のパイロン
   * 副兵装の残弾を、翼下のパイロン (点) として同じ図に出す。
   * 残弾は `ship.missiles` の合計そのものなので、右 VDU の兵装ページと
   * 必ず同じ数を示す (表示ごとに別の数え方をしない)。
   * 実弾の射出も左右交互 (`sim/weapons.ts`) なので、左右に並べる形と合う。
   */
  private shieldSvg(): SVGSVGElement {
    const svg = svgEl('svg') as SVGSVGElement;
    svg.setAttribute('viewBox', '0 0 100 108');
    const add = (key: string, tag: string, attrs: Record<string, string>) => {
      const n = svgEl(tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.appendChild(n);
      this.shieldParts[key] = n;
      return n;
    };
    // シールド (機首側・尾部側の円弧)
    add('sf', 'path', { d: 'M 14 26 Q 50 2 86 26', fill: 'none', 'stroke-width': '5', stroke: '#5fd8ff' });
    add('sr', 'path', { d: 'M 14 88 Q 50 112 86 88', fill: 'none', 'stroke-width': '5', stroke: '#5fd8ff' });
    // 機体 (上面図)。機首・尾部・左右の翼がそれぞれ装甲の面に対応する
    add('af', 'polygon', { points: '50,22 57,42 43,42' });
    add('al', 'polygon', { points: '43,44 15,62 21,69 43,58' });
    add('arr', 'polygon', { points: '57,44 85,62 79,69 57,58' });
    add('ar', 'polygon', { points: '43,74 57,74 64,88 36,88' });
    // 胴体 (ハル)
    add('hull', 'rect', { x: '43', y: '40', width: '14', height: '36', rx: '3' });
    // キャノピー (向きを一目で分かるようにする飾り。値は持たない)
    const canopy = svgEl('ellipse');
    canopy.setAttribute('cx', '50');
    canopy.setAttribute('cy', '49');
    canopy.setAttribute('rx', '4');
    canopy.setAttribute('ry', '7');
    canopy.setAttribute('fill', 'rgba(205,239,221,0.5)');
    svg.appendChild(canopy);
    // 翼下のパイロン (副兵装の残弾)。左右交互に並べる
    this.missilePips.length = 0;
    const pip = (x: number, y: number) => {
      const n = svgEl('rect');
      n.setAttribute('x', String(x));
      n.setAttribute('y', String(y));
      n.setAttribute('width', '7');
      n.setAttribute('height', '3.4');
      n.setAttribute('rx', '1.7');
      svg.appendChild(n);
      this.missilePips.push(n);
    };
    // 発射順 (左右交互) と同じ並びにする: 左1・右1・左2・右2・左3・右3
    const rows: Array<[number, number]> = [
      [26, 64], [67, 64],
      [30, 70], [63, 70],
      [34, 76], [59, 76],
    ];
    for (const [x, y] of rows) pip(x, y);
    return svg;
  }

  /** 声が鳴り終わった顔の口を止め、消えた行は追跡から外す */
  private stopFinishedSpeech(now: number): void {
    for (let i = this.speakingFaces.length - 1; i >= 0; i--) {
      const f = this.speakingFaces[i];
      if (!f.el.isConnected) {
        this.speakingFaces.splice(i, 1);
        continue;
      }
      if (f.until && now > f.until) {
        f.el.querySelector('.mc-face, .mc-portrait')?.classList.remove('speaking');
        this.speakingFaces.splice(i, 1);
      }
    }
  }

  private subscribe(): void {
    this.unsubs.push(
      // 収容 (T4-⑮)。判定は MissionRunner が持ち、HUD は表示だけを受け持つ。
      bus.on('recovery', (p) => {
        if (!p.active || !p.view) {
          this.showRecovery(undefined);
          return;
        }
        this.showRecovery(recoveryHudView(p.view));
      }),
    );
    this.unsubs.push(
      bus.on('announce', (p) => {
        if (!p.text) return;
        // 警告は「何が起きたか」＋「どうするか」の2行にする (T2-⑧)。
        // 文言の対応表は hud/warning.ts が唯一の出所。
        const w = warningText(p.text);
        this.announce.textContent = '';
        const what = el('div', 'what');
        what.textContent = w.what;
        this.announce.appendChild(what);
        if (w.how) {
          const how = el('div', 'how');
          how.textContent = w.how;
          how.style.fontSize = '17px';
          how.style.fontWeight = '400';
          how.style.letterSpacing = '0.08em';
          how.style.opacity = '0.92';
          this.announce.appendChild(how);
        }
        this.announce.className = `mc-announce show ${p.kind ?? 'info'}`;
        this.announceUntil = performance.now() + (p.durationMs ?? 1800);
      }),
      bus.on('weaponFired', (p) => {
        if (!p.isPlayer || p.weaponKind !== 'missile' || p.weaponId !== 'torpedo') return;
        this.pendingTorpedoes.push({
          targetId: p.shooter.ship?.targetId,
          expiresAt: performance.now() + 22000,
        });
        while (this.pendingTorpedoes.length > 4) this.pendingTorpedoes.shift();
      }),
      bus.on('explosion', (p) => {
        if (p.kind !== 'missile') return;
        this.pendingExplosions.push({ pos: p.pos.clone(), radius: p.radius });
      }),
      bus.on('radio', (p) => {
        const line = el('div', `mc-radio-line ${p.tone ?? 'friendly'}`);
        line.style.fontSize = `${settings.subtitleScale}em`;
        // 喋っている人物の顔を出す (WC の VDU 相当)
        const pilot = PILOTS.find((x) => x.callsign === p.speaker);
        if (pilot) {
          const face = el('div');
          face.innerHTML = portraitFace(pilot.id, pilot.portrait, {
            size: 56,
            expression: expressionFor(p.text, p.tone),
            speaking: true,
          });
          line.appendChild(face);
          // 声が鳴り終わったら口を止める
          this.speakingFaces.push({ el: face, speaker: p.speaker, until: 0 });
        } else {
          // 顔が無い相手 (管制・敵・艦艇) は空欄で桁を揃える
          line.appendChild(el('div'));
        }
        const body = el('div', 'mc-radio-body');
        const who = el('span', 'who');
        who.textContent = `${p.speaker}:`;
        const txt = el('span');
        txt.textContent = p.text;
        body.append(who, txt);
        line.appendChild(body);
        this.radioBox.appendChild(line);
        this.radioLines.push({
          el: line,
          until: performance.now() + settings.radioDuration * 1000,
        });
        while (this.radioLines.length > 5) {
          const old = this.radioLines.shift()!;
          old.el.remove();
        }
      }),
      bus.on('radioVoice', (p) => {
        // 鳴っている秒数だけ口を動かす。指定が来る前は止めておく
        const now = performance.now();
        for (const f of this.speakingFaces) {
          if (f.speaker !== p.speaker || f.until > now) continue;
          f.until = now + p.seconds * 1000;
          f.el.querySelector('.mc-face, .mc-portrait')?.classList.add('speaking');
        }
      }),
      bus.on('destroyed', (p) => {
        if (p.target.kind !== 'ship') return;
        if (p.killedByPlayer) {
          for (const torpedo of this.pendingTorpedoes) {
            if (torpedo.targetId !== p.target.id) continue;
            torpedo.targetPosition = p.target.pos.clone();
            torpedo.targetRadius = p.target.radius;
            torpedo.targetLabel = p.target.label;
          }
        }
        const line = el('div', p.target.ship?.ace ? 'ace' : '');
        const who = p.target.ship?.pilot ?? p.target.label ?? '?';
        const star = p.target.ship?.ace ? '★ ' : '';
        line.classList.add(p.killedByPlayer ? 'destroyed' : 'impact');
        line.textContent = p.killedByPlayer ? `${star}${who} 撃破` : `${star}${who} 破壊`;
        this.killFeed.appendChild(line);
        this.killLines.push({ el: line, until: performance.now() + 5000 });
        while (this.killLines.length > 6) {
          const old = this.killLines.shift()!;
          old.el.remove();
        }
      }),
      bus.on('shieldHit', (p) => {
        if (p.isPlayer) {
          this.vignetteLevel = Math.min(0.6, this.vignetteLevel + 0.14);
          this.noteHitDirection(p.target, p.point, p.hitFace);
        } else if (this.isHostileToPlayer(p.target)) this.pushCombatLine('命中確認 — シールド', 'hit');
      }),
      bus.on('armorHit', (p) => {
        if (p.isPlayer) {
          this.vignetteLevel = Math.min(0.9, this.vignetteLevel + 0.3);
          this.noteHitDirection(p.target, p.point, p.hitFace);
        } else if (this.isHostileToPlayer(p.target)) {
          this.pushCombatLine(p.layer === 'hull' ? '命中確認 — 船体' : '命中確認 — 装甲', 'hit');
        }
      }),
    );
  }

  /**
   * 被弾方向を覚える (T2-⑨)。
   *
   * 深刻さは `damageStage()` が決めるので、ここは**方向だけ**を扱う。
   * 装甲面はダメージ計算が返した `hitFace` を優先し、無いときだけ方向から求める。
   */
  private noteHitDirection(target: Entity, point: Vector3, face?: HitFace): void {
    this.tmpV.copy(point).sub(target.pos);
    if (this.tmpV.lengthSq() > 0) this.tmpV.applyQuaternion(this.tmpQ.copy(target.quat).invert());
    const edge = hitEdgeOf(this.tmpV);
    this.hitEdgeLeft[edge] = HIT_DIRECTION_SECONDS;
    this.hitFace = face ?? hitFaceOf(this.tmpV);
    this.hitFaceLeft = HIT_DIRECTION_SECONDS;
    this.hitDirLeft = HIT_DIRECTION_SECONDS;
    const text = `被弾 ${HIT_EDGE_LABEL[edge]}方向`;
    if (this.hitDirEl.textContent !== text) this.hitDirEl.textContent = text;
  }

  /** いま光っている画面端の濃さ (テスト・確認用)。 */
  hitEdgeOpacity(edge: HitEdge): number {
    return Number(this.hitEdgeEls[edge].style.opacity || '0');
  }

  /** 被弾方向の文字 (テスト・確認用)。点滅を抑える設定でも残る。 */
  get hitDirectionText(): string {
    return this.hitDirEl.style.display === 'none' ? '' : this.hitDirEl.textContent ?? '';
  }

  /** 装甲図でハイライトしている面 (テスト・確認用)。 */
  get highlightedFace(): HitFace | undefined {
    return this.hitFaceLeft > 0 ? this.hitFace : undefined;
  }

  /**
   * 被弾方向の表示を時間で薄くする。
   *
   * `reducedFlashes` では明滅させず一定の濃さで出し、文字は常に残す
   * （設定で情報が減らないようにする）。
   */
  private renderHitDirection(dtReal: number): void {
    for (const edge of ['left', 'right', 'top', 'bottom'] as HitEdge[]) {
      const left = Math.max(0, this.hitEdgeLeft[edge] - dtReal);
      this.hitEdgeLeft[edge] = left;
      const node = this.hitEdgeEls[edge];
      if (left <= 0) {
        if (node.style.display !== 'none') {
          node.style.display = 'none';
          node.style.opacity = '0';
        }
        continue;
      }
      node.style.display = '';
      const ratio = left / HIT_DIRECTION_SECONDS;
      node.style.opacity = settings.reducedFlashes ? '0.35' : (0.15 + 0.7 * ratio).toFixed(3);
    }
    this.hitFaceLeft = Math.max(0, this.hitFaceLeft - dtReal);
    this.hitDirLeft = Math.max(0, this.hitDirLeft - dtReal);
    const showText = this.hitDirLeft > 0;
    const want = showText ? '' : 'none';
    if (this.hitDirEl.style.display !== want) this.hitDirEl.style.display = want;
  }

  // ───────── 毎フレーム更新 ─────────

  update(f: HudFrame, dtReal: number): void {
    // メニュー表示中は計器類を丸ごと隠す
    const show = f.visible !== false;
    this.hud.classList.toggle('mc-colorblind', settings.colorblindMode);
    if (this.shown !== show) {
      this.shown = show;
      this.applyChromeVisibility();
    }
    if (!show) {
      this.navMap.setOpen(false);
      return;
    }

    const now = performance.now();
    const player = f.world.player;
    this.playerFaction = player?.faction;

    this.expire(this.radioLines, now);
    this.expire(this.killLines, now);
    this.confirmTorpedoHits(f.world, now);
    this.stopFinishedSpeech(now);
    if (this.announceUntil && now > this.announceUntil) {
      this.announce.className = 'mc-announce';
      this.announceUntil = 0;
    }
    if (this.stageUntil && now > this.stageUntil) {
      this.stageUntil = 0;
      this.stageEl.style.display = 'none';
    }
    if (this.casualtyUntil && now > this.casualtyUntil) {
      this.casualtyUntil = 0;
      this.casualtyEl.style.display = 'none';
    }

    this.vignetteLevel = Math.max(0, this.vignetteLevel - dtReal * 1.6);
    this.vignette.style.opacity = String(this.vignetteLevel);

    // 操縦ヒント (T2-⑧)。促しが立ち上がった瞬間から数秒だけ、画面下部に出す。
    // 航法マップを開いている間は出さない (マップに重ねない)。
    const armPending = !!f.mouseArmPending;
    if (armPending && !this.mouseHintArmed) this.mouseHintLeft = MOUSE_HINT_SECONDS;
    this.mouseHintArmed = armPending;
    if (!armPending) this.mouseHintLeft = 0;
    else this.mouseHintLeft = Math.max(0, this.mouseHintLeft - dtReal);
    // お手本モード中は操縦を代行しているので、マウス操縦の促しは出さない
    // (実演の説明帯と同じ高さに出て重なる)。
    const hintVisible = !this.demoMode && this.mouseHintLeft > 0 && !this.navMap.open;
    this.mouseHintEl.style.display = hintVisible ? '' : 'none';

    this.renderHitDirection(dtReal);

    // 通信遅延 (第6章)。位置表示が何秒古いかを明示する。
    const delay = commsDelaySeconds();
    if (delay > 0) {
      const text = `通信妨害 — 味方位置 ${delay.toFixed(1)}s 遅延`;
      if (this.commsDelayEl.textContent !== text) this.commsDelayEl.textContent = text;
      this.commsDelayEl.style.display = '';
    } else {
      this.commsDelayEl.style.display = 'none';
    }

    if (f.stick && f.mouseFlight) {
      this.stickEl.style.display = '';
      this.stickEl.style.left = `${(f.stick.x * 0.5 + 0.5) * f.width}px`;
      this.stickEl.style.top = `${(f.stick.y * 0.5 + 0.5) * f.height}px`;
    } else {
      this.stickEl.style.display = 'none';
    }

    this.renderObjectives(f.objectives, dtReal);
    this.navMap.update(f.world);

    if (f.autopilot && f.nav && player) {
      const d = f.nav.pos.distanceTo(player.pos);
      this.autopilotEl.style.display = '';
      this.autopilotEl.textContent = `AUTOPILOT  →  ${f.nav.label ?? 'NAV'}   ${(d / 1000).toFixed(1)}k`;
    } else {
      this.autopilotEl.style.display = 'none';
    }

    if (!player || !player.ship) {
      this.tgtBox.style.display = 'none';
      this.lead.style.display = 'none';
      // 自機を失った直後は危険域の縁取りを残さない (撃墜演出は別枠で見せる)
      this.dangerFrame.style.display = 'none';
      // 撃墜後は計器を読めない。空の枠を残さないよう最小 HUD も畳む。
      if (this.extHud.style.display !== 'none') this.extHud.style.display = 'none';
      this.hideMarkersFrom(0);
      return;
    }

    this.renderGauges(f, player);
    this.renderShieldDisplay(player);
    this.renderRadar(f, player);
    this.renderLeftVdu(player);
    this.renderRightVdu(f, player);
    this.renderWarnings(f, player);
    this.renderDanger(player, dtReal);
    this.renderExternalHud(f, player);
    this.renderWorldMarkers(f, player);
  }

  /**
   * ハル危険域の赤い縁取り。
   *
   * `reducedFlashes` では点滅させず一定の濃さで出す。点滅を抑えても
   * 警告灯の文字 (ハル危険域 — Alt+E で脱出) は残るので、情報は失われない。
   */
  private renderDanger(player: Entity, dtReal: number): void {
    const ship = player.ship!;
    const critical = !ship.ejected && damageStage(healthRatios(player)) === 'hull-critical';
    if (!critical) {
      if (this.dangerFrame.style.display !== 'none') {
        this.dangerFrame.style.display = 'none';
        this.dangerFrame.style.opacity = '0';
      }
      this.dangerPhase = 0;
      return;
    }
    this.dangerFrame.style.display = '';
    if (settings.reducedFlashes) {
      this.dangerFrame.style.opacity = '0.5';
      return;
    }
    this.dangerPhase = (this.dangerPhase + dtReal * 3.4) % (Math.PI * 2);
    this.dangerFrame.style.opacity = (0.34 + 0.3 * (0.5 + 0.5 * Math.sin(this.dangerPhase))).toFixed(3);
  }

  /** 外部視点用の最小 HUD。計器盤を隠した分の情報をここへ移す。 */
  private renderExternalHud(f: HudFrame, player: Entity): void {
    if (!this.externalView) return;
    const speed = player.vel.length();
    const target = f.world.byId(player.ship!.targetId);
    const targetText = target
      ? `${target.ship?.pilot ?? target.label ?? '目標'} ${target.pos.distanceTo(player.pos).toFixed(0)}m`
      : '—';
    const navText = f.nav
      ? `${f.nav.label ?? 'NAV'} ${(f.nav.pos.distanceTo(player.pos) / 1000).toFixed(1)}k`
      : '—';
    const objective = f.objectives?.find((o) => o.state === 'active')?.text ?? '—';
    const text =
      `外部視点 [F]　SPD ${speed.toFixed(0)} KPS　THR ${(f.throttle * 100) | 0}%\n` +
      `TGT ${targetText}　NAV ${navText}\n目標 ${objective}`;
    if (this.extHud.textContent !== text) this.extHud.textContent = text;
  }

  private expire(lines: RadioLine[], now: number): void {
    while (lines.length && lines[0].until < now) {
      const old = lines.shift()!;
      old.el.remove();
    }
  }

  private isHostileToPlayer(target: Entity): boolean {
    return !!this.playerFaction && isHostile(this.playerFaction, target.faction);
  }

  private pushCombatLine(text: string, kind: 'hit' | 'torpedo'): void {
    const line = el('div', kind);
    line.textContent = text;
    this.killFeed.appendChild(line);
    this.killLines.push({ el: line, until: performance.now() + (kind === 'torpedo' ? 5200 : 2200) });
    while (this.killLines.length > 6) {
      const old = this.killLines.shift()!;
      old.el.remove();
    }
  }

  private confirmTorpedoHits(world: World, now: number): void {
    this.pendingTorpedoes = this.pendingTorpedoes.filter((torpedo) => torpedo.expiresAt > now);
    if (!this.pendingTorpedoes.length) {
      this.pendingExplosions = [];
      return;
    }
    if (!this.pendingExplosions.length) return;

    for (const explosion of this.pendingExplosions.splice(0)) {
      const match = this.pendingTorpedoes.findIndex((torpedo) => {
        const target = torpedo.targetId === undefined ? undefined : world.byId(torpedo.targetId);
        const targetPosition = target?.pos ?? torpedo.targetPosition;
        const targetRadius = target?.radius ?? torpedo.targetRadius ?? 0;
        if (!targetPosition) return false;
        return explosion.pos.distanceTo(targetPosition) <= explosion.radius + targetRadius * 1.5;
      });
      if (match < 0) continue;
      const targetId = this.pendingTorpedoes[match].targetId;
      const target = targetId === undefined ? undefined : world.byId(targetId);
      const targetLabel = target?.label ?? this.pendingTorpedoes[match].targetLabel;
      this.pendingTorpedoes.splice(match, 1);
      this.pushCombatLine(`魚雷命中${targetLabel ? ` — ${targetLabel}` : ''}`, 'torpedo');
    }
  }

  /** 常時表示の行 (テスト・確認用)。3行を超えないことをここで確かめられる。 */
  get objectiveLineCount(): number {
    return this.objectivesBox.children.length;
  }

  /** 操縦ヒントが出ているか (テスト・確認用)。 */
  get mouseHintVisible(): boolean {
    return this.mouseHintEl.style.display !== 'none';
  }

  /**
   * 目標の常時表示 (T2-⑧)。
   *
   * 出すのは3行だけ (追うべき目標 / 一番差し迫った制限時間 / 直近に片付いた1件)。
   * 全目標は右 VDU の一覧ページ (`V`) へ移す。
   * 文字の後ろには半透明の暗い帯を敷き、太陽や星雲に重なっても読めるようにする。
   */
  private renderObjectives(objs: ObjectiveView[] | undefined, dtReal: number): void {
    this.allObjectives = objs ?? [];
    if (!objs || objs.length === 0) {
      this.objectiveStates.clear();
      this.recentObjective = undefined;
      this.recentLeft = 0;
      if (this.objectivesBox.children.length) {
        this.objectivesBox.innerHTML = '';
        delete this.objectivesBox.dataset.sig;
      }
      return;
    }

    // 片付いた瞬間を拾って「達成した直近1件」にする。
    // 記録は毎フレーム作り直す (制限時間の目標は文が毎秒変わるので、溜め込まない)。
    const states = new Map<string, ObjectiveView['state']>();
    for (const o of objs) {
      const prev = this.objectiveStates.get(o.text);
      if (prev !== o.state && o.state !== 'active') {
        this.recentObjective = o;
        this.recentLeft = RECENT_OBJECTIVE_SECONDS;
      }
      states.set(o.text, o.state);
    }
    this.objectiveStates = states;
    this.recentLeft = Math.max(0, this.recentLeft - dtReal);
    if (this.recentLeft <= 0) this.recentObjective = undefined;

    const lines = buildObjectiveLines(objs, this.recentObjective);
    const sig = lines.map((l) => `${l.role}|${l.state}|${l.required}|${l.timeLeftSec ?? ''}|${l.others ?? ''}|${l.text}`).join('\n');
    if (this.objectivesBox.dataset.sig === sig) return;
    this.objectivesBox.dataset.sig = sig;
    // 帯を1行ずつ敷くので、行は要素として作り直す (innerHTML では帯を検証できない)
    this.objectivesBox.textContent = '';
    for (const l of lines) this.objectivesBox.appendChild(objectiveLineEl(l));
  }

  private renderGauges(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    const def = ship.def;
    const speed = player.vel.length();
    this.speedEl.innerHTML = `${speed.toFixed(0)} <small>KPS</small>`;

    this.setGauge('throttle', f.throttle, `${(f.throttle * 100) | 0}%`);
    const e = clamp01(ship.energy / def.energy);
    this.setGauge('energy', e, `${ship.energy.toFixed(0)}`, e < 0.2 ? 'bad' : e < 0.45 ? 'warn' : '');
    const fu = ship.fuelMax > 0 ? clamp01(ship.fuel / ship.fuelMax) : 0;
    this.setGauge('fuel', fu, `${ship.fuel.toFixed(1)}s`, fu < 0.15 ? 'bad' : fu < 0.35 ? 'warn' : '');
  }

  private setGauge(id: string, ratio: number, text: string, cls = ''): void {
    const g = this.gaugeEls[id];
    if (!g) return;
    g.fill.style.width = `${clamp01(ratio) * 100}%`;
    g.val.textContent = text;
    const want = `mc-gauge${cls ? ' ' + cls : ''}`;
    if (g.root.className !== want) g.root.className = want;
  }

  private renderShieldDisplay(player: Entity): void {
    const h = healthRatios(player);
    const setArc = (key: string, r: number) => {
      const n = this.shieldParts[key];
      n.setAttribute('stroke', barColor(r));
      n.setAttribute('opacity', String(0.18 + 0.82 * r));
    };
    setArc('sf', h.shieldFront);
    setArc('sr', h.shieldRear);
    const setPoly = (key: string, face: ArmorFace) => {
      const r = h.armor[face];
      const n = this.shieldParts[key];
      n.setAttribute('fill', barColor(r));
      // 直前に食らった面を縁で強調する (T2-⑨)。どこから撃たれているかを図で示す。
      const hit = this.hitFaceLeft > 0 && this.hitFace === face;
      n.setAttribute('opacity', String((hit ? 0.34 : 0.14) + 0.72 * r));
      n.setAttribute('stroke', hit ? '#ff6b6b' : 'rgba(127,227,176,0.35)');
      n.setAttribute('stroke-width', hit ? '2.2' : '0.7');
    };
    setPoly('af', 'front');
    setPoly('ar', 'rear');
    setPoly('al', 'left');
    setPoly('arr', 'right');
    const hull = this.shieldParts['hull'];
    hull.setAttribute('fill', barColor(h.hull));
    hull.setAttribute('opacity', String(0.2 + 0.7 * h.hull));
    this.hullNum.textContent = `HULL ${(h.hull * 100) | 0}%`;
    this.hullNum.style.color = barColor(h.hull);
    this.renderOrdnancePips(player);
  }

  /**
   * 翼下パイロンと残弾数。
   *
   * 数え方は `ship.missiles` の合計ひとつだけ。右 VDU の兵装ページ
   * (`ordnanceLines`) と同じ配列を読むので、両方の表示が食い違わない。
   * パイロンは6本しか描けないので、正確な数は数字でも出す。
   */
  private renderOrdnancePips(player: Entity): void {
    const ship = player.ship;
    const slots = ship?.missiles ?? [];
    let left = 0;
    for (const slot of slots) left += Math.max(0, slot.count);
    const active = activeMissileSlot(player);
    const color = left > 0 ? '#ffd166' : 'rgba(255,93,93,0.85)';
    this.missilePips.forEach((pip, i) => {
      const loaded = i < left;
      pip.setAttribute('fill', loaded ? color : 'rgba(127,227,176,0.10)');
      pip.setAttribute('stroke', loaded ? color : 'rgba(127,227,176,0.28)');
      pip.setAttribute('stroke-width', '0.7');
    });
    // 選択中の兵装が分かるように、残弾は「選択中 / 合計」で出す
    this.mslNum.textContent =
      left > 0 ? `MSL ${active ? active.count : 0}/${left}` : 'MSL 0';
    this.mslNum.style.color = color;
  }

  private renderRadar(f: HudFrame, player: Entity): void {
    // レーダー損傷: 品質が落ちると位置がぶれ、一部が映らなくなる
    const quality = radarQuality(player.ship);
    if (this.radarNoise !== quality) {
      this.radarNoise = quality;
      this.radarBox.classList.toggle('degraded', quality > 0 && quality < 1);
      this.radarBox.classList.toggle('dead', quality <= 0);
    }
    if (quality <= 0) {
      for (const blip of this.radarBlips) blip.setAttribute('visibility', 'hidden');
      return;
    }
    this.tmpQ.copy(player.quat).invert();
    const ships: Array<{ e: Entity; d: number }> = [];
    const hazards: Array<{ e: Entity; d: number }> = [];
    for (const e of f.world.entities) {
      if (!e.alive || e.id === player.id) continue;
      const isHazard = e.kind === 'rock' || e.kind === 'mine';
      if (e.kind !== 'ship' && e.kind !== 'missile' && !isHazard) continue;
      // 味方はレーダーにも遅れて映る (報告位置で距離を測る)
      const d = reportedPosition(e, this.tmpReport).distanceTo(player.pos);
      // 障害物は数が多いので、ぶつかりうる至近距離のものだけ映す
      if (d > (isHazard ? HAZARD_RADAR_RANGE : MARKER_RANGE)) continue;
      (isHazard ? hazards : ships).push({ e, d });
    }
    ships.sort((a, b) => a.d - b.d);
    hazards.sort((a, b) => a.d - b.d);
    // 機体の枠を障害物で埋めてしまわないよう、枠を分けて確保する
    const targets = [...ships.slice(0, 18), ...hazards.slice(0, 6)];
    const n = targets.length;

    while (this.radarBlips.length < n) {
      const c = svgEl('circle') as SVGCircleElement;
      c.setAttribute('r', '2.6');
      this.radarG.appendChild(c);
      this.radarBlips.push(c);
    }
    for (let i = 0; i < this.radarBlips.length; i++) {
      const blip = this.radarBlips[i];
      if (i >= n) {
        blip.setAttribute('visibility', 'hidden');
        continue;
      }
      const { e } = targets[i];
      // 品質が低いほど映らない機体が増える
      if (quality < 1 && ((e.id * 2654435761) % 1000) / 1000 > quality + 0.25) {
        blip.setAttribute('visibility', 'hidden');
        continue;
      }
      this.tmpV
        .copy(reportedPosition(e, this.tmpReport))
        .sub(player.pos)
        .applyQuaternion(this.tmpQ)
        .normalize();
      if (quality < 1) {
        // 位置をぶらす
        const j = (1 - quality) * 0.22;
        const t = performance.now() * 0.004 + e.id;
        this.tmpV.x += Math.sin(t) * j;
        this.tmpV.y += Math.sin(t * 1.31 + 1) * j;
        this.tmpV.z += Math.sin(t * 0.87 + 2) * j;
        this.tmpV.normalize();
      }
      const p = radarPoint(this.tmpV);
      blip.setAttribute('cx', p.x.toFixed(2));
      blip.setAttribute('cy', p.y.toFixed(2));
      blip.setAttribute('visibility', 'visible');
      let color: string;
      if (e.kind === 'rock') color = '#9a8f7d';
      else if (e.kind === 'mine') color = '#ff8a5a';
      else if (e.kind === 'missile') color = '#ffffff';
      else if (e.ship?.ace && isHostile(player.faction, e.faction)) color = '#ffd75e';
      else if (isHostile(player.faction, e.faction)) color = '#ff4d4d';
      // 中立艦も敵対せずロック対象外なので、味方と同じ水色で表示する。
      else if (e.faction === player.faction || e.faction === 'neutral') color = '#68e5ff';
      // 非敵対の他勢力（セレシオン・オルド、共同作戦中の相手）は敵色にせず勢力色で示す。
      else color = FACTION_HEX[e.faction];
      blip.setAttribute('fill', color);
      blip.setAttribute(
        'r',
        e.id === player.ship!.targetId
          ? '3.8'
          : e.kind === 'missile'
            ? '1.8'
            : e.kind === 'rock' || e.kind === 'mine'
              ? '1.6'
              : '2.6',
      );
    }

    this.renderRadarNav(f, player, quality);
  }

  /**
   * レーダーに目的地（現在向かっている Nav）を出す。
   *
   * 機体は円なので Nav は菱形にして区別する。Nav は数キロ〜数十キロ先にあり
   * 機体の探知範囲（`MARKER_RANGE`）より遠いことが多いので、**距離では間引かず
   * 必ず表示する**。「どこへ向かえばいいか」を示すのがこのマーカーの役目なので、
   * 遠いほど外周へ寄る（真後ろが外周）という向きの情報だけで十分に用を果たす。
   */
  private renderRadarNav(f: HudFrame, player: Entity, quality: number): void {
    const nav = f.nav;
    if (!nav || !nav.alive || quality <= 0) {
      this.radarNav.setAttribute('visibility', 'hidden');
      return;
    }
    this.tmpV.copy(nav.pos).sub(player.pos).applyQuaternion(this.tmpQ).normalize();
    const p = radarPoint(this.tmpV);
    this.radarNav.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
    this.radarNav.setAttribute('visibility', 'visible');
  }

  /** 左 VDU は常に自機の状態を表示する (本家の systems / damage display)。 */
  private renderLeftVdu(player: Entity): void {
    const ship = player.ship!;
    const h = healthRatios(player);
    const avgShield = (h.shieldFront + h.shieldRear) / 2;
    const avgArmor = (h.armor.front + h.armor.rear + h.armor.left + h.armor.right) / 4;
    const primary = ship.def.guns[0]?.gunId?.toUpperCase() ?? 'NONE';
    const body = [
      `<div class="name friend">${escapeHtml(ship.pilot ?? 'PILOT')} / ${escapeHtml(ship.def.name)}</div>`,
      `<div class="row"><span class="k">SHIELD</span><span style="color:${barColor(avgShield)}">${(avgShield * 100) | 0}%</span></div>`,
      `<div class="row"><span class="k">ARMOR</span><span style="color:${barColor(avgArmor)}">${(avgArmor * 100) | 0}%</span></div>`,
      `<div class="row"><span class="k">HULL</span><span style="color:${barColor(h.hull)}">${(h.hull * 100) | 0}%</span></div>`,
      `<div class="row"><span class="k">GUN PWR</span><span>${ship.energy.toFixed(0)} / ${ship.def.energy}</span></div>`,
      `<div class="row"><span class="k">PRIMARY</span><span>${escapeHtml(primary)}</span></div>`,
      `<div class="mc-vdu-section">SYSTEMS</div>`,
      `<div class="mc-status-chip ${stateOf(ship, 'radar') === 'ok' ? 'ok' : 'warn'}">RADAR　${stateOf(ship, 'radar') === 'ok' ? 'READY' : 'DEGRADED'}</div>`,
      `<div class="mc-status-chip ${stateOf(ship, 'gunsLeft') === 'ok' && stateOf(ship, 'gunsRight') === 'ok' ? 'ok' : 'warn'}">GUNS　${stateOf(ship, 'gunsLeft') === 'ok' && stateOf(ship, 'gunsRight') === 'ok' ? 'READY' : 'DAMAGED'}</div>`,
    ].join('');
    this.setVdu(this.vduLeft, 'SELF / SYSTEMS', body);
  }

  /** 右 VDU は target / nav / weapon / wingman を一つの戦術面に固定する。 */
  private renderRightVdu(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    if (this.damageMode) {
      const h = healthRatios(player);
      // 装甲・シールドの残量と、部位の生死を並べる
      const bar = (k: string, r: number) =>
        `<div class="mc-sys-line"><span class="k">${k}</span>` +
        `<span class="v ${r > 0.6 ? 'ok' : r > 0.25 ? 'warn' : 'bad'}">${(r * 100) | 0}%</span></div>`;
      const sys = (label: string, st: 'ok' | 'damaged' | 'dead') =>
        `<div class="mc-sys-line ${st}"><span class="k">${label}</span>` +
        `<span class="v ${st === 'ok' ? 'ok' : st === 'damaged' ? 'warn' : 'bad'}">` +
        `${st === 'ok' ? '正常' : st === 'damaged' ? '損傷' : '損失'}</span></div>`;

      const body =
        bar('シールド 前/後', (h.shieldFront + h.shieldRear) / 2) +
        bar('装甲 前', h.armor.front) +
        bar('装甲 後', h.armor.rear) +
        bar('装甲 左/右', (h.armor.left + h.armor.right) / 2) +
        bar('船体', h.hull) +
        '<div class="mc-sys-sep">システム</div>' +
        SUBSYSTEMS.map((info) => sys(info.label, stateOf(player.ship, info.id))).join('');
      this.setVdu(this.vduRight, 'DAMAGE  [D]', body, 'compact');
      return;
    }

    const target = f.world.byId(ship.targetId);
    const navDistance = f.nav ? f.nav.pos.distanceTo(player.pos) : 0;
    const navHtml = f.nav
      ? `<div class="row"><span class="k">NAV</span><span class="nav-value">${escapeHtml(f.nav.label ?? 'NAV')}</span></div>` +
        `<div class="row"><span class="k">DIST</span><span>${(navDistance / 1000).toFixed(1)}k</span></div>`
      : `<div class="row"><span class="k">NAV</span><span class="dim">STANDBY</span></div>` +
        `<div class="row"><span class="k">DIST</span><span>—</span></div>`;

    let targetHtml = '<div class="mc-vdu-empty mc-target-idle"><b>NO TARGET</b><span>T / R / Y で選択</span></div>';
    if (target?.ship) {
      const h = healthRatios(target);
      const values = healthValues(target);
      // 距離と接近速度も報告値から作る (味方を選ぶと3秒古い数字が出る)
      const reportedTargetPos = reportedPosition(target, this.tmpReport);
      const d = reportedTargetPos.distanceTo(player.pos);
      const cls = target.ship.ace
        ? 'ace'
        : isHostile(player.faction, target.faction)
          ? 'enemy'
          : target.faction === player.faction
            ? 'friend'
            : '';
      const closing = this.tmpV
        .copy(reportedVelocity(target, this.tmpReportVel))
        .sub(player.vel)
        .dot(this.tmpV.clone().copy(reportedTargetPos).sub(player.pos).normalize());
      const targetValue = (label: string, value: HealthValue): string =>
        `<span style="color:${barColor(value.max > 0 ? value.current / value.max : 0)}">${label} ${Math.round(value.current)}/${Math.round(value.max)}</span>`;
      const targetValues = (leftLabel: string, left: HealthValue, rightLabel: string, right: HealthValue): string =>
        `<span class="mc-target-values">${targetValue(leftLabel, left)}<span class="mc-target-gap"> </span>${targetValue(rightLabel, right)}</span>`;
      targetHtml = [
        // 文字色 = 敵味方（cls）、勢力ラベル = 勢力色。どちらも factions.ts の関係テーブル由来。
        `<div class="name ${cls}">${target.ship.ace ? '★ ' : ''}${escapeHtml(target.ship.pilot ?? target.label ?? '')}` +
          `<span class="mc-target-faction" style="color:${factionColorVar(target.faction)}">${escapeHtml(factionLabel(target.faction))}</span></div>`,
        `<div class="row"><span class="k">TYPE</span><span>${escapeHtml(target.ship.def.name)}</span></div>`,
        `<div class="row"><span class="k">DIST</span><span>${d.toFixed(0)}</span></div>`,
        `<div class="row"><span class="k">${closing < 0 ? 'CLOSING' : 'BREAKING'}</span><span>${Math.abs(closing).toFixed(0)}</span></div>`,
        `<div class="row"><span class="k">SHIELD F/R</span>${targetValues('F', values.shield.front, 'R', values.shield.rear)}</div>`,
        `<div class="row"><span class="k">ARMOR F/R</span>${targetValues('F', values.armor.front, 'R', values.armor.rear)}</div>`,
        `<div class="row"><span class="k">ARMOR L/R</span>${targetValues('L', values.armor.left, 'R', values.armor.right)}</div>`,
        `<div class="row"><span class="k">HULL</span><span style="color:${barColor(h.hull)}">${(h.hull * 100) | 0}%</span></div>`,
      ].join('');
    }

    const wing = f.world.entities.find(
      (e) => e.alive && e.id !== player.id && e.kind === 'ship' && e.faction === player.faction && !!e.ship,
    );
    const wingName = wing?.ship?.pilot ?? wing?.label ?? 'UNASSIGNED';
    const wingRatio = wing?.ship ? wing.ship.hull / Math.max(1, wing.ship.def.hull) : 0;
    const wingState = wing ? (wingRatio > 0.6 ? 'FORMED' : wingRatio > 0.2 ? 'DAMAGED' : 'CRITICAL') : 'NONE';
    const wingClass = wing ? (wingRatio > 0.6 ? 'ok' : wingRatio > 0.2 ? 'warn' : 'bad') : 'dim';
    const usableSlot = activeMissileSlot(player);

    const lines: string[] = [];
    for (let i = 0; i < ship.missiles.length; i++) {
      const m = ship.missiles[i];
      const def = missileDef(m.missileId);
      const active = i === (usableSlot?.index ?? ship.activeMissile);
      lines.push(
        `<div class="mc-weapon-line ${active ? 'active' : ''} ${m.count === 0 ? 'empty' : ''}">` +
          `<span>${active ? '▸ ' : '  '}${escapeHtml(def.name)}</span><span>${m.count}</span></div>`,
      );
    }
    if (lines.length === 0) lines.push('<div class="mc-vdu-empty">副兵装なし</div>');
    lines.push(`<div class="mc-weapon-line"><span>フレア</span><span>${ship.flares}</span></div>`);

    const selectedSlot = ship.missiles[ship.activeMissile];
    const slot = usableSlot ? ship.missiles[usableSlot.index] : selectedSlot;
    const def = slot ? missileDef(slot.missileId) : undefined;
    let lock = '';
    if (def && def.seeker !== 'none') {
      if (ship.lockedId !== undefined) {
        lock = '<div class="mc-lockstate locked"><span class="lock-meter"><i style="width:100%"></i></span>■ ロック完了</div>';
      }
      else if (ship.lockProgress > 0.02)
        lock = `<div class="mc-lockstate locking"><span class="lock-meter"><i style="width:${(ship.lockProgress * 100).toFixed(1)}%"></i></span>□ ロック中 ${(ship.lockProgress * 100) | 0}%</div>`;
      else lock = '<div class="mc-lockstate"><span class="lock-meter"><i style="width:0%"></i></span>□ ロック未完了</div>';
    } else if (def) {
      lock = '<div class="mc-lockstate ready"><span class="lock-meter"><i style="width:100%"></i></span>■ ロック不要 / 即時発射</div>';
    }
    const gun = ship.def.guns[0]?.gunId ? gunDef(ship.def.guns[0].gunId) : undefined;
    const selected = def?.name ?? gun?.name ?? '武装なし';
    const selectedUse =
      def?.description ?? (gun ? gunPresentation(gun).description : undefined) ?? '使用できる武装がありません';
    const ammo = def ? `${slot?.count ?? 0}` : gun ? '∞' : '—';
    const energyCost = gun?.energyCost ?? 0;
    const lockedTarget = ship.lockedId === undefined ? undefined : f.world.byId(ship.lockedId);
    const fireStatus = def
      ? missileFireStatus(ship, slot, def, lockedTarget)
      : gun
        ? gunFireStatus(ship, gun)
        : '発射不可 — 武装なし';
    const tacticalBody =
      `<div class="mc-vdu-section">TARGET</div>${targetHtml}` +
      `<div class="mc-vdu-section">NAV / WING</div>${navHtml}` +
      `<div class="row"><span class="k">WINGMAN</span><span class="${wingClass}">${escapeHtml(wingName)}</span></div>` +
      `<div class="row"><span class="k">STATUS</span><span class="${wingClass}">${wingState}</span></div>`;
    const weaponsBody =
      `<div class="mc-vdu-section">SELECTED WEAPON</div>` +
      `<div class="mc-weapon-selected">` +
      `<div class="row"><span class="k">SELECTED</span><span class="active-weapon">${escapeHtml(selected)}</span></div>` +
      `<div class="weapon-use">${escapeHtml(selectedUse)}</div>` +
      `<div class="row"><span class="k">AMMO</span><span>${ammo}</span></div>` +
      `<div class="row"><span class="k">ENERGY</span><span>${ship.energy.toFixed(0)} / ${ship.def.energy}${energyCost ? `　(−${energyCost}/shot)` : ''}</span></div>` +
      `<div class="mc-fire-status ${fireStatus.startsWith('発射不可') ? 'blocked' : fireStatus.includes('損傷') ? 'warn' : ''}">${escapeHtml(fireStatus)}</div>` +
      `</div>` +
      `<div class="mc-vdu-section">ORDNANCE</div>` +
      lines.join('') +
      lock;
    // 全目標の一覧。常時表示は3行だけなので、詳細はこのページで読む。
    const objectivesBody =
      this.allObjectives.length === 0
        ? '<div class="mc-vdu-empty">目標なし</div>'
        : this.allObjectives
            .map(
              (o) =>
                `<div class="mc-obj-row ${o.state} ${o.required === false ? 'bonus' : 'required'}">` +
                `<span class="k">${o.state === 'active' && o.required === false ? '＋' : objectiveMark(o.state)}</span>` +
                `<span>${escapeHtml(o.text)}</span></div>`,
            )
            .join('');

    const title =
      this.rightVduPage === 'tactical'
        ? 'TARGET / NAV  [V]'
        : this.rightVduPage === 'weapons'
          ? 'WEAPONS  [V]'
          : 'OBJECTIVES  [V]';
    const body =
      this.rightVduPage === 'tactical'
        ? tacticalBody
        : this.rightVduPage === 'weapons'
          ? weaponsBody
          : objectivesBody;
    this.setVdu(this.vduRight, title, body, this.rightVduPage);
  }

  private setVdu(box: HTMLElement, title: string, bodyHtml: string, extraClass = ''): void {
    const sig = title + bodyHtml + extraClass;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    // 行数の多い表示 (被害一覧) は詰めて全項目を収める
    const base = box.classList.contains('left') ? 'mc-vdu left' : 'mc-vdu right';
    box.className = extraClass ? `${base} ${extraClass}` : base;
    box.innerHTML = `<div class="mc-vdu-title">${title}</div>${bodyHtml}`;
  }

  private renderWarnings(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    const h = healthRatios(player);
    toggle(this.warnLock, ship.lockedByEnemy);
    toggle(this.warnMissile, !!f.world.byId(ship.incomingMissileId));
    toggle(this.warnShield, !ship.ejected && h.shieldFront < 0.2 && h.shieldRear < 0.2);
    toggle(this.warnEject, !!ship.ejected);
    // ハル危険域。点滅を抑える設定では文字だけを残す (情報は消さない)。
    const critical = !ship.ejected && damageStage(h) === 'hull-critical';
    toggle(this.warnHull, critical);
    const animation = settings.reducedFlashes ? 'none' : '';
    if (this.warnHull.style.animation !== animation) this.warnHull.style.animation = animation;
  }

  private renderWorldMarkers(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    const target = f.world.byId(ship.targetId);
    const w = f.width;
    const hgt = f.height;
    // 風防の開口部。ここより外は構造物なので、枠やラベルを置くと
    // 「見えない敵に枠が付く」ことになる (装飾 OFF / 外部視点では undefined)。
    const rect = this.viewRect(w, hgt);

    // ── ターゲット枠 ──
    if (target) {
      // 味方は報告位置に枠が出る (3秒前の場所を囲む)
      const targetPos = reportedPosition(target, this.tmpReport);
      const p = worldToScreen(f.camera, targetPos, w, hgt, this.tmpScreen);
      if (this.isReadable(p, rect)) {
        // 距離に応じた枠の大きさ
        const d = Math.max(1, targetPos.distanceTo(player.pos));
        const px = Math.max(22, Math.min(320, (target.radius * 2.2 * hgt) / (2 * d * Math.tan((f.camera.fov * Math.PI) / 360))));
        this.tgtBox.style.display = '';
        this.tgtBox.style.left = `${p.x}px`;
        this.tgtBox.style.top = `${p.y}px`;
        this.tgtBox.style.width = `${px}px`;
        this.tgtBox.style.height = `${px}px`;
        const cls = target.ship?.ace
          ? 'mc-tgtbox ace'
          : isHostile(player.faction, target.faction)
            ? 'mc-tgtbox'
            : 'mc-tgtbox friend';
        if (this.tgtBox.className !== cls) this.tgtBox.className = cls;
        // 枠線は敵味方（cls）、ラベル文字は勢力色。中立・非敵対勢力が敵色にならない。
        const tint = factionColorVar(target.faction);
        if (this.tgtLabel.style.color !== tint) this.tgtLabel.style.color = tint;
        this.tgtLabel.textContent = `${target.label ?? ''} ${d.toFixed(0)}`;
        this.tgtArrow.style.display = 'none';
      } else {
        // 画面外、または構造物の裏。どちらも「見えていない」ので矢印に寄せる。
        this.tgtBox.style.display = 'none';
        const a = this.clippedArrow(f, targetPos, 40, p);
        this.tgtArrow.style.display = '';
        this.tgtArrow.style.left = `${a.x}px`;
        this.tgtArrow.style.top = `${a.y}px`;
        this.tgtArrow.style.transform = `translate(-50%,-50%) rotate(${-a.angleDeg}deg)`;
      }

      // ── ITTS リード表示 ──
      // 照準支援も報告位置・報告速度から作る。距離表示と同じ出所なので、
      // 「表示は3秒古いのに照準だけ正確」という状態にならない。
      // 遅延の無い相手 (敵・非遅延ミッション) では従来の ittsPoint と同値。
      const leadPos = reportedLeadPoint(
        player,
        target,
        primaryGunSpeed(player, f.playerGunSpeedScale ?? 1),
        this.tmpV,
      );
      const lp = worldToScreen(f.camera, leadPos, w, hgt);
      // リード表示も開口部の内側だけ。構造物の上に照準環だけ浮かせない。
      if (this.isReadable(lp, rect)) {
        this.lead.style.display = '';
        this.lead.style.left = `${lp.x}px`;
        this.lead.style.top = `${lp.y}px`;
      } else {
        this.lead.style.display = 'none';
      }
    } else {
      this.tgtBox.style.display = 'none';
      this.tgtArrow.style.display = 'none';
      this.lead.style.display = 'none';
    }

    // ── Nav 表示 ──
    if (f.nav) {
      const p = worldToScreen(f.camera, f.nav.pos, w, hgt);
      const d = f.nav.pos.distanceTo(player.pos);
      if (this.isReadable(p, rect)) {
        const text = `◇ ${f.nav.label ?? 'NAV'} ${(d / 1000).toFixed(1)}k`;
        // 画面端では中央合わせのラベルが切れる (`発艦点 2.6k` が x=0 で欠ける)。
        // ラベルの半分だけ内側へ押し戻して、必ず画面内に収める (T2-⑧)。
        const c = clampLabel(p, w, hgt, estimateLabelHalfWidth(text), NAV_LABEL_HALF_HEIGHT, rect);
        this.navMarker.style.display = '';
        this.navMarker.style.left = `${c.x}px`;
        this.navMarker.style.top = `${c.y}px`;
        this.navMarker.textContent = text;
        this.navArrow.style.display = 'none';
      } else {
        this.navMarker.style.display = 'none';
        const a = this.clippedArrow(f, f.nav.pos, 70, p);
        this.navArrow.style.display = '';
        this.navArrow.style.left = `${a.x}px`;
        this.navArrow.style.top = `${a.y}px`;
        this.navArrow.style.transform = `translate(-50%,-50%) rotate(${-a.angleDeg}deg)`;
      }
    } else {
      this.navMarker.style.display = 'none';
      this.navArrow.style.display = 'none';
    }

    // ── その他の機体マーカー ──
    let used = 0;
    const list: Array<{ e: Entity; d: number }> = [];
    for (const e of f.world.entities) {
      if (!e.alive || e.kind !== 'ship' || e.id === player.id) continue;
      if (target && e.id === target.id) continue;
      // 味方のマーカーも報告位置に出る (通信遅延)
      const d = reportedPosition(e, this.tmpReport).distanceTo(player.pos);
      if (d > MARKER_RANGE) continue;
      list.push({ e, d });
    }
    list.sort((a, b) => a.d - b.d);
    for (const { e, d } of list) {
      if (used >= MAX_MARKERS) break;
      const p = worldToScreen(f.camera, reportedPosition(e, this.tmpReport), w, hgt);
      // 構造物の裏にいる機体には印を付けない (方向は矢印とレーダーで示す)
      if (!this.isReadable(p, rect)) continue;
      const m = this.marker(used++);
      const hostile = isHostile(player.faction, e.faction);
      const cls = `mc-marker ${hostile ? 'enemy' : 'friend'}`;
      if (m.className !== cls) m.className = cls;
      m.style.display = '';
      m.style.left = `${p.x}px`;
      m.style.top = `${p.y}px`;
      const shape = e.ship?.ace ? '★' : hostile ? '△' : '○';
      m.textContent = d > 3000 ? shape : `${shape} ${(d / 1000).toFixed(1)}k`;
      if (e.ship?.ace) m.style.color = 'var(--ace)';
      else m.style.color = '';
    }
    this.hideMarkersFrom(used);
  }

  private marker(i: number): HTMLElement {
    let m = this.markerPool[i];
    if (!m) {
      m = el('div', 'mc-marker');
      this.hud.appendChild(m);
      this.markerPool[i] = m;
    }
    return m;
  }

  private hideMarkersFrom(i: number): void {
    for (let k = i; k < this.markersUsed; k++) this.markerPool[k].style.display = 'none';
    this.markersUsed = i;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.navMap.dispose();
    this.hud.remove();
  }
}

// ───────── DOM/SVG ヘルパー ─────────

function el(tag: string, className = ''): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

function svgEl(tag: string): SVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElement;
}

/** 目標の色。必須は明るい白緑、加点は灰色。達成・失敗は状態の色を優先する。 */
function objectiveColor(l: ObjectiveLine): string {
  if (l.state === 'done') return '#6fe38f';
  if (l.state === 'failed') return '#ff6b6b';
  return l.required ? '#eaf7ff' : '#9fb4ab';
}

/**
 * 常時表示の1行 (T2-⑧)。
 *
 * - 記号は必須／加点で分ける (`▸` と `＋`)。達成は ✓、失敗は ✖ ＋取り消し線
 * - 文字の後ろに半透明の暗い帯を敷き、明るい背景 (太陽・星雲) でも読めるようにする
 * - 加点表記そのものは `MissionRunner.objectiveRewardPrefix()` の出力を**そのまま**載せる
 */
export function objectiveLineEl(l: ObjectiveLine): HTMLElement {
  const node = el('div', `mc-obj-line ${l.role} ${l.state}${l.required ? ' required' : ' bonus'}`);
  // 背景が明るくても読めるように、行ごとに暗い帯を敷く
  node.style.background = 'rgba(4,12,14,0.72)';
  node.style.padding = '1px 6px';
  node.style.color = objectiveColor(l);
  if (l.state === 'failed') node.style.textDecoration = 'line-through';
  const mark = l.state === 'active' && !l.required ? '＋' : objectiveMark(l.state);
  const timer =
    l.role === 'timer' && l.timeLeftSec !== undefined
      ? `残り ${formatTimeLeft(l.timeLeftSec)} — `
      : '';
  const others = l.others && l.others > 0 ? `　他${l.others}件` : '';
  node.textContent = `${mark} ${timer}${l.text}${others}`;
  return node;
}

function toggle(node: HTMLElement, on: boolean): void {
  const has = node.classList.contains('on');
  if (on && !has) node.classList.add('on');
  else if (!on && has) node.classList.remove('on');
}

function barColor(r: number): string {
  if (r > 0.6) return '#6fe38f';
  if (r > 0.3) return '#ffd166';
  return '#ff5d5d';
}

function gunFireStatus(ship: Entity['ship'], gun: ReturnType<typeof gunDef>): string {
  if (!ship) return '発射不可 — 機体なし';
  if (ship.energy < gun.energyCost) return '発射不可 — エネルギー不足';
  const gunStates = ship.def.guns.map((hp) =>
    stateOf(ship, ship.def.role === 'capital' ? 'turret' : hp.offset[0] < 0 ? 'gunsLeft' : 'gunsRight'),
  );
  if (gunStates.length > 0 && gunStates.every((state) => state === 'dead')) return '発射不可 — 砲損傷';
  if (gunStates.some((state) => state !== 'ok')) return '砲損傷 — 火力低下 / 不発あり';
  return '発射可能';
}

function missileFireStatus(
  ship: Entity['ship'],
  slot: { count: number } | undefined,
  def: ReturnType<typeof missileDef>,
  target?: Entity,
): string {
  if (!ship || !slot || slot.count <= 0) return '発射不可 — 弾切れ';
  if (def.seeker !== 'none' && ship.lockedId === undefined) return '発射不可 — ロック未完了';
  if (
    def.targetRole === 'capital' &&
    target?.ship &&
    target.ship.def.role !== 'capital' &&
    target.ship.def.role !== 'transport'
  ) {
    return '発射不可 — 大型目標のみ';
  }
  return '発射可能';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function reticleSvg(): HTMLElement {
  const wrap = el('div', 'mc-reticle');
  // 照準環の縦位置は射線と同じ定数から作る (`core/aim.ts`)。
  // CSS 側に数値を書くと、射線だけ直して照準環が取り残される。
  wrap.style.top = `${AIM_ORIGIN_Y * 100}%`;
  wrap.innerHTML = `
    <svg viewBox="0 0 46 46" width="46" height="46">
      <g fill="none" stroke="#7fe3b0" stroke-width="1.2">
        <circle cx="23" cy="23" r="3.2"/>
        <path d="M 23 6 V 13 M 23 40 V 33 M 6 23 H 13 M 40 23 H 33"/>
        <path d="M 10 10 L 14 14 M 36 10 L 32 14 M 10 36 L 14 32 M 36 36 L 32 32" opacity="0.5"/>
      </g>
    </svg>`;
  return wrap;
}

function leadSvg(): SVGSVGElement {
  const svg = svgEl('svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 34 34');
  svg.innerHTML =
    '<g fill="none" stroke="#ffd166" stroke-width="1.4">' +
    '<circle cx="17" cy="17" r="8" stroke-dasharray="3 3"/>' +
    '<circle cx="17" cy="17" r="1.6" fill="#ffd166"/>' +
    '</g>';
  return svg;
}

/** レーダーの外周半径（SVG 座標） */
const RADAR_RADIUS = 44;

/**
 * 自機から見た方向ベクトルを、レーダー面の座標へ写す。
 *
 * 機首 (-Z) が中心、真後ろが外周。機体の点と目的地マーカーで同じ写し方を使うため、
 * ここに1本化する（別々に書くと片方だけ直して食い違う）。
 *
 * @param dir 自機の姿勢を打ち消した後の方向ベクトル（正規化済み）
 */
export function radarPoint(dir: { x: number; y: number; z: number }): { x: number; y: number } {
  const angle = Math.acos(Math.max(-1, Math.min(1, -dir.z)));
  const r = (angle / Math.PI) * RADAR_RADIUS;
  const az = Math.atan2(dir.x, dir.y);
  return { x: r * Math.sin(az), y: -r * Math.cos(az) };
}

function radarSvg(): { svg: SVGSVGElement; g: SVGGElement; nav: SVGPathElement } {
  const svg = svgEl('svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '-50 -50 100 100');
  const bg = svgEl('g');
  bg.innerHTML =
    '<circle cx="0" cy="0" r="45" fill="rgba(10,25,20,0.55)" stroke="rgba(127,227,176,0.45)" stroke-width="1"/>' +
    '<circle cx="0" cy="0" r="22.5" fill="none" stroke="rgba(127,227,176,0.22)" stroke-width="0.8"/>' +
    '<path d="M -45 0 H 45 M 0 -45 V 45" stroke="rgba(127,227,176,0.18)" stroke-width="0.8"/>' +
    '<circle cx="0" cy="0" r="1.4" fill="rgba(127,227,176,0.6)"/>';
  svg.appendChild(bg);
  const g = svgEl('g') as SVGGElement;
  svg.appendChild(g);
  // 目的地マーカー。機体は円なので、Nav は菱形にして一目で区別できるようにする。
  // 機体の点より後ろに描くと隠れるので、g の後（＝最前面）に置く。
  const nav = svgEl('path') as SVGPathElement;
  nav.setAttribute('d', 'M 0 -4 L 3.4 0 L 0 4 L -3.4 0 Z');
  nav.setAttribute('fill', 'none');
  nav.setAttribute('stroke', '#eaf7ff');
  nav.setAttribute('stroke-width', '1.2');
  nav.setAttribute('visibility', 'hidden');
  svg.appendChild(nav);
  return { svg, g, nav };
}
