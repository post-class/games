import { PERSONALITIES, pilotDef, type PortraitSpec } from '../content/pilots';
import { relationStage, type PilotState } from '../app/roster';
import { PILOT_BOND_KINDS } from '../content/pilotBonds';
import { BARTENDER_PERSON_ID } from '../content/barRumors';
import { pilotDisplayName, type BarBanterView, type BarTalkView, type HubContext } from './HubPanels';
import { bustUrl, hasBustArt, portraitFace } from './Portrait';
import {
  barCameraCss,
  barCameraPair,
  barCameraTransform,
  barCameraWide,
  barFocusOrder,
  barNextFocus,
  type BarCameraTransform,
} from './barCamera';

/**
 * 酒場を「絵の中の場面」として描く画面（本家 Wing Commander のレクリエーション室）。
 *
 * 表組みではなく、艦内バーの一枚絵の上に隊員の立ち絵を座席の位置へ置き、
 * 下端の会話ボックスで喋らせる。会話の進行そのものは
 * `src/app/barTalk.ts` / `src/app/barBanter.ts` が持ち、ここは表示だけを行う。
 *
 * ■ この場面は作り直さない
 * 返事を選ぶたびに画面を作り直すと、CSS アニメーションの時間軸が 0 に戻り、
 * 立ち絵の `<img>` も読み直しになる（カメラ移動や入退場の演出が成立しない）。
 * そこで **一度作ったら生かし続け、状態は `update(ctx)` で差分だけ受ける**。
 * - 立ち絵は `figures` に持ち、同じ人物なら要素を使い回す
 * - 会話ボックスは `boxKey()` が変わったときだけ組み直す
 *   （＝文字送りが巻き戻らない／噂が勝手に入れ替わらない）
 *
 * ■ `querySelector` を使わない
 * 単体テストの最小 DOM（`tests/ut/fake-dom.ts`）はセレクタを持たないので、
 * 要素はすべてフィールドに参照を持つ（`BriefingScene` と同じ流儀）。
 *
 * 表示データは `HubContext`（`HubPanels.ts` の型）をそのまま受ける。
 * 従来の表組み版 `recRoomHtml()` は、席割りを渡さない呼び出し（古い保存データ・
 * 単体テスト）のために残してある。
 */

/** 立ち絵を置く位置。stage の左端からの % と、下端からの %。 */
interface SpotLayout {
  /** 立ち絵の中心の x（stage 幅に対する %） */
  x: number;
  /** 足元の y（stage 下端からの %）。奥の席は上げる */
  bottom: number;
  /** 立ち絵の高さ（stage 高さに対する %）。奥の席は小さくする */
  height: number;
  /** 同席2名のときの左右のずらし量（stage 幅に対する %） */
  spread: number;
  /** 席札を出す側 */
  align: 'left' | 'right';
}

/**
 * `public/art/tex/bg-bar.jpg` の構図に合わせた座席の位置。
 *
 * 背景は左手前にソファとローテーブル、中央奥に壁の紋章と扉、
 * 右にカウンターとスツール、右奥に酒棚。席 id は `src/app/barSeats.ts` の
 * `BAR_SEAT_SLOTS` と一致させる（増減はそちらが唯一の出所）。
 *
 * 高さは「頭が上端で切れない」かつ「足元の名札が会話ボックスに隠れない」
 * ように決めてある（1280×720 で確認）。
 */
export const BAR_SPOTS: Record<string, SpotLayout> = {
  // 窓際のテーブル: 左手前のソファ。いちばん手前なので大きく出す
  'table-1': { x: 18, bottom: 9, height: 74, spread: 10, align: 'left' },
  // 奥のテーブル: 中央奥の暗がり。奥行きを出すため小さく、床から上げる
  'table-2': { x: 39, bottom: 27, height: 50, spread: 7, align: 'left' },
  // ビリヤード台: 中央右。カウンターの手前
  pool: { x: 56, bottom: 15, height: 62, spread: 8, align: 'right' },
  // カウンター: 右のスツール
  counter: { x: 76, bottom: 9, height: 72, spread: 10, align: 'right' },
};

/**
 * 立ち絵を置ける席 id。`BAR_SEAT_SLOTS` と一致していることを
 * `tests/ut/t9-bar-scene.test.ts` が確かめる（ずれると席の隊員が画面から消える）。
 */
export const BAR_SPOT_IDS: readonly string[] = Object.keys(BAR_SPOTS);

/** 酒保はカウンターの向こう側（右奥の酒棚の前）に立つ */
const BARTENDER_SPOT: SpotLayout = { x: 91, bottom: 31, height: 45, spread: 0, align: 'right' };

/** 立ち絵が無い人物のつなぎに使う顔の見た目 */
const FALLBACK_PORTRAIT: PortraitSpec = { skin: '#e7c9a4', hair: '#2b2119', hairStyle: 'short', eyes: 'normal' };

/** 1秒あたりの文字数。ブリーフィングと同じ速さにしてある */
const CPS = 30;

/** 立ち絵の入退場にかける時間 (ms)。CSS の `mc-bar-enter` / `mc-bar-leave` と揃える */
const ENTER_MS = 420;
const LEAVE_MS = 380;

/** カメラの移動にかける時間 (ms)。CSS の `.mc-barroom-camera` の transition と揃える */
const CAMERA_MS = 620;
/** 「近づく」の歩き（カメラが中間まで寄る）にかける時間 (ms) */
const WALK_MS = 380;

/** 会話中に寄る倍率。上限は `barCamera.ts` の `BAR_ZOOM_MAX` */
const ZOOM_TALK = 1.85;
/** 掛け合いは2人を収めるので1段落とす */
const ZOOM_PAIR = 1.55;
/** 歩いている途中の倍率 */
const ZOOM_WALK = 1.25;
/** 見回しているときの浅いパン */
const ZOOM_LOOK = 1.12;

/**
 * 場面の段階。
 * `room`（部屋を見回す）→ `walk`（近づく）→ `talk`（二人芝居）→ `back`（引く）→ `room`。
 * `.mc-barroom-camera` の `data-phase` に書き出し、CSS とテストの両方から使う。
 */
export type BarPhase = 'room' | 'walk' | 'talk' | 'back';

/** 立ち絵1体ぶんの保持物。`update()` はこれを使い回す */
interface BarFigure {
  el: HTMLElement;
  /** 名札。文字だけ差し替える */
  cap: HTMLElement;
  capName: HTMLElement;
  capReal: HTMLElement;
  capSub: HTMLElement;
  /** 退場アニメーション中か（二重に消さない） */
  leaving?: boolean;
}

/** 会話ボックスに出す1行 */
interface BoxTurn {
  who: string;
  text: string;
  speaker: 'pilot' | 'player';
  /** 文字送りする行（＝いちばん新しい発言） */
  now: boolean;
}

/** 会話ボックスの表示内容。`renderBox()` がこれを DOM に起こす */
interface BoxView {
  /** VDU に出す顔のパイロット id。空なら酒保の顔 */
  faces: string[];
  name: string;
  sub?: string;
  /** 右端に出す関係・仲 */
  rel?: string;
  /** 相関の種類（左罫線の色分けに使う） */
  kind?: string;
  turns: BoxTurn[];
  reason?: string;
  outcome?: string;
  cue: string;
  rumors?: Array<{ source: string; text: string }>;
}

export interface BarSceneOptions {
  /** 部屋の一枚絵（`artUrl('tex/bg-bar','jpg')`） */
  background: string;
  ctx: HubContext;
}

export class BarScene {
  readonly el: HTMLElement;

  private ctx: HubContext;

  // ── 要素の参照（`querySelector` を使わないため）
  /** 覗き窓。カメラの実寸はここから測る */
  private readonly stageEl: HTMLElement;
  /** 歩きの揺れ専用の層。カメラと transform を混ぜない */
  private readonly dollyEl: HTMLElement;
  /** パンとズームの層。ここだけを動かす */
  private readonly cameraEl: HTMLElement;
  private readonly bgEl: HTMLElement;
  private readonly plateEl: HTMLElement;
  private readonly cursorEl: HTMLElement;
  private readonly boxEl: HTMLElement;
  private readonly figures = new Map<string, BarFigure>();
  /** 酒保は席割りに乗らないので別に持つ */
  private tenderFig?: BarFigure;
  /** 文字送り中の行（`.now` の本文） */
  private nowSaidEl?: HTMLElement;
  /** VDU に出している顔。口の動きを止めるときに触る */
  private faceEls: HTMLElement[] = [];

  /** 会話ボックスを組み直すかの判定キー */
  private boxKey = '';
  private typing?: { el: HTMLElement; text: string; chars: number; startedAt?: number };
  private raf?: number;
  private timers = new Set<number>();

  // ── カメラと段階
  private phase: BarPhase = 'room';
  /** 見回しで選んでいる相手 */
  private selected?: string;
  /** 「近づく」の到着待ちタイマー */
  private walkTimer?: number;
  /** 近づいた先。到着したら App へ知らせる */
  private walkTarget?: string;
  /** `start()` したか（キー購読の二重登録を防ぐ） */
  private started = false;
  private keyHandler = (ev: KeyboardEvent) => this.onKey(ev);

  /** 近づき終わったときに呼ばれる（App が会話を始める） */
  onApproachEnd?: (pilotId: string) => void;
  /** 見回す相手が変わったときに呼ばれる */
  onSelectionChange?: (pilotId: string | undefined) => void;

  constructor(o: BarSceneOptions) {
    this.ctx = o.ctx;

    const root = document.createElement('div');
    root.className = 'mc-barroom';

    const stage = document.createElement('div');
    stage.className = 'mc-barroom-stage';

    // 歩きの揺れ（dolly）とパン・ズーム（camera）は層を分ける。
    // 同じ要素の transform に混ぜると transition と keyframes が取り合って片方が消える。
    const dolly = document.createElement('div');
    dolly.className = 'mc-barroom-dolly';
    const camera = document.createElement('div');
    camera.className = 'mc-barroom-camera';
    camera.dataset.phase = 'room';

    // 部屋の絵は独立した層に置く。立ち絵を浮かせるため、こちらだけ
    // わずかにぼかして彩度を落とす（立ち絵側には効かせない）。
    const bg = document.createElement('div');
    bg.className = 'mc-barroom-bg';
    bg.style.backgroundImage = `url('${o.background}')`;

    const plate = document.createElement('div');
    plate.className = 'mc-barroom-plate';
    // 選択カーソルは camera の外に置く（拡大で歪まない）
    const cursor = document.createElement('div');
    cursor.className = 'mc-barroom-cursor';

    camera.appendChild(bg);
    dolly.appendChild(camera);
    stage.append(dolly, plate, cursor);
    this.stageEl = stage;
    this.dollyEl = dolly;
    this.cameraEl = camera;
    this.bgEl = bg;
    this.plateEl = plate;
    this.cursorEl = cursor;

    const box = document.createElement('div');
    box.className = 'mc-barroom-box';
    this.boxEl = box;

    root.append(stage, box);
    this.el = root;

    // 背景を叩いたら引く（会話から抜ける）
    bg.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.pullBack();
    });

    this.syncPlate();
    this.syncFigures();
    this.syncBox();
    this.applyCamera();
  }

  /**
   * 状態を受け直す。**DOM は作り直さない**。
   *
   * 席の顔ぶれが変わった人物だけ入退場し、会話ボックスは内容が変わったときだけ
   * 組み直す。App 側は返事・奢り・献杯のあとにこれを呼ぶ。
   */
  update(ctx: HubContext): void {
    const wasTalking = this.talkingIds().length > 0;
    this.ctx = ctx;
    this.syncPlate();
    this.syncFigures();
    this.syncBox();

    // 会話に入ったら寄り、終わったら引く。メニューの「○○と話す」経路でも
    // カメラが付いてくるように、ここで段階を合わせる。
    const talking = this.talkingIds();
    if (talking.length > 0) {
      if (this.phase !== 'walk') this.enterTalk();
    } else if (wasTalking && this.phase === 'talk') {
      this.pullBack();
    } else {
      this.applyCamera();
    }
  }

  // ───────── カメラと段階 ─────────

  /** いまの段階。`data-phase` と同じ値 */
  get currentPhase(): BarPhase {
    return this.phase;
  }

  /** 見回しで選んでいる相手 */
  get selectedPilotId(): string | undefined {
    return this.selected;
  }

  /** 見回す順番（画面の左から右へ） */
  focusOrder(): string[] {
    const entries: Array<{ pilotId: string; x: number }> = [];
    for (const seat of this.ctx.barSeats ?? []) {
      const at = BAR_SPOTS[seat.id];
      if (!at) continue;
      const n = seat.occupants.length;
      seat.occupants.forEach((p, i) => {
        const dx = n === 1 ? 0 : i === 0 ? -at.spread : at.spread;
        entries.push({ pilotId: p.id, x: at.x + dx });
      });
    }
    (this.ctx.barStanding ?? []).forEach((p, i) => entries.push({ pilotId: p.id, x: 30 + i * 7 }));
    return barFocusOrder(entries);
  }

  /**
   * ←→ で見回す。部屋を見ているときだけ動く
   * （歩いている間・話している間は相手を変えない）。
   */
  select(dir: -1 | 1): void {
    if (this.phase !== 'room') return;
    const order = this.focusOrder();
    const next = barNextFocus(order, this.selected, dir);
    if (next === this.selected) return;
    this.selected = next;
    this.markSelection();
    this.applyCamera();
    this.onSelectionChange?.(next);
  }

  /** 相手を直接選ぶ（立ち絵のクリック） */
  selectPilot(pilotId: string): void {
    if (this.phase !== 'room' || !this.figures.has(pilotId)) return;
    if (this.selected === pilotId) return;
    this.selected = pilotId;
    this.markSelection();
    this.applyCamera();
    this.onSelectionChange?.(pilotId);
  }

  /**
   * 近づく。カメラが寄り切ったところで `onApproachEnd` を呼ぶ。
   * 到着までは入力を受けない（`walk` の間は `select` も `approach` も無視する）。
   */
  approach(pilotId?: string): void {
    if (this.phase === 'walk') return;
    const target = pilotId ?? this.selected;
    if (!target || !this.figures.has(target)) return;
    this.selected = target;
    this.walkTarget = target;
    this.markSelection();
    this.setPhase('walk');
    this.applyCamera();
    this.clearWalkTimer();
    this.walkTimer = window.setTimeout(() => {
      this.walkTimer = undefined;
      const id = this.walkTarget;
      this.walkTarget = undefined;
      this.setPhase('talk');
      this.applyCamera();
      if (id) this.onApproachEnd?.(id);
    }, WALK_MS);
  }

  /** 引いて部屋の全景へ戻る */
  pullBack(o: { instant?: boolean } = {}): void {
    if (this.phase === 'room') return;
    this.clearWalkTimer();
    this.walkTarget = undefined;
    if (o.instant) {
      this.setPhase('room');
      this.applyCamera();
      return;
    }
    this.setPhase('back');
    this.applyCamera();
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      // 引いている途中に会話が始まったら、そのまま寄せ直す
      if (this.phase !== 'back') return;
      this.setPhase('room');
      this.applyCamera();
    }, CAMERA_MS);
    this.timers.add(timer);
  }

  /** カメラの移動と文字送りを即座に終わらせる（テストと読み飛ばし用） */
  settle(): void {
    if (this.walkTimer !== undefined) {
      this.clearWalkTimer();
      const id = this.walkTarget;
      this.walkTarget = undefined;
      this.setPhase('talk');
      this.applyCamera();
      if (id) this.onApproachEnd?.(id);
    } else if (this.phase === 'back') {
      this.setPhase('room');
      this.applyCamera();
    }
    this.skip();
  }

  private setPhase(phase: BarPhase): void {
    this.phase = phase;
    this.cameraEl.dataset.phase = phase;
  }

  private clearWalkTimer(): void {
    if (this.walkTimer !== undefined) clearTimeout(this.walkTimer);
    this.walkTimer = undefined;
  }

  /** 会話に入る（すでに `talk` なら寄せ直すだけ） */
  private enterTalk(): void {
    this.clearWalkTimer();
    const ids = this.talkingIds();
    if (ids.length) this.selected = ids[0];
    this.markSelection();
    this.setPhase('talk');
    this.applyCamera();
  }

  /** 会話・掛け合いの当事者（カメラが寄る先） */
  private talkingIds(): string[] {
    const banter = this.ctx.barBanter;
    if (banter) return [banter.bond.a, banter.bond.b];
    const talk = this.ctx.barTalk;
    return talk ? [talk.pilotId] : [];
  }

  /** その人物の席の座標。立ち絵の実位置（同席のずらしを含む）を返す */
  private spotOf(pilotId: string): SpotLayout | undefined {
    for (const seat of this.ctx.barSeats ?? []) {
      const at = BAR_SPOTS[seat.id];
      if (!at) continue;
      const n = seat.occupants.length;
      const i = seat.occupants.findIndex((p) => p.id === pilotId);
      if (i < 0) continue;
      const dx = n === 1 ? 0 : i === 0 ? -at.spread : at.spread;
      const scale = n === 1 ? 1 : i === 0 ? 0.94 : 1;
      return { ...at, x: at.x + dx, height: at.height * scale };
    }
    const standing = this.ctx.barStanding ?? [];
    const si = standing.findIndex((p) => p.id === pilotId);
    if (si >= 0) return { x: 30 + si * 7, bottom: 24, height: 54, spread: 0, align: 'left' };
    return undefined;
  }

  /** 段階と選択からカメラの transform を決めて当てる */
  private applyCamera(): void {
    const view = { w: this.stageEl.clientWidth || 1280, h: this.stageEl.clientHeight || 385 };
    const t = this.cameraTarget(view);
    this.cameraEl.style.transform = barCameraCss(t);
    this.cameraEl.dataset.scale = t.scale.toFixed(2);
    this.cameraEl.dataset.focus = this.selected ?? '';
    // 寄るほど背景を落として被写界深度に見せる（背景の解像度不足を逃がす）
    this.bgEl.classList.toggle('near', t.scale > 1.3);
    this.dollyEl.classList.toggle('walking', this.phase === 'walk');
    this.markCursor(view, t);
  }

  private cameraTarget(view: { w: number; h: number }): BarCameraTransform {
    if (this.phase === 'room' || this.phase === 'back') {
      const spot = this.selected ? this.spotOf(this.selected) : undefined;
      // 見回している間は浅く寄せる。誰も選んでいなければ全景
      return spot && this.phase === 'room'
        ? barCameraTransform(spot, view, { scale: ZOOM_LOOK, anchorX: 0.5 })
        : barCameraWide();
    }
    const ids = this.phase === 'talk' ? this.talkingIds() : [];
    if (ids.length >= 2) {
      const a = this.spotOf(ids[0]);
      const b = this.spotOf(ids[1]);
      if (a && b) return barCameraPair(a, b, view, ZOOM_PAIR);
    }
    const target = this.phase === 'walk' ? this.walkTarget : (ids[0] ?? this.selected);
    const spot = target ? this.spotOf(target) : undefined;
    if (!spot) return barCameraWide();
    return barCameraTransform(spot, view, {
      scale: this.phase === 'walk' ? ZOOM_WALK : ZOOM_TALK,
    });
  }

  /** 選択中の立ち絵にだけ `.sel` を付ける */
  private markSelection(): void {
    for (const [id, fig] of this.figures) {
      fig.el.classList.toggle('sel', id === this.selected && this.phase === 'room');
    }
  }

  /**
   * 選択カーソル。camera の外に px で置くので、拡大しても歪まない。
   * 部屋を見回しているときだけ出す。
   */
  private markCursor(view: { w: number; h: number }, t: BarCameraTransform): void {
    const spot = this.phase === 'room' && this.selected ? this.spotOf(this.selected) : undefined;
    if (!spot) {
      this.cursorEl.classList.remove('on');
      this.cursorEl.textContent = '';
      return;
    }
    // 立ち絵の頭の少し上に置く
    const px = (view.w * spot.x) / 100;
    const py = (view.h * (100 - (spot.bottom + spot.height))) / 100;
    this.cursorEl.style.left = `${(t.tx + t.scale * px).toFixed(1)}px`;
    this.cursorEl.style.top = `${Math.max(4, t.ty + t.scale * py - 22).toFixed(1)}px`;
    this.cursorEl.textContent = '▼';
    this.cursorEl.classList.add('on');
  }

  /** 文字送りを始める。画面に載せた後に呼ぶ */
  start(): void {
    if (!this.started) {
      this.started = true;
      window.addEventListener('keydown', this.keyHandler, true);
      // 実寸が確定してからカメラを当て直す（初回は clientWidth が 0 のことがある）
      this.applyCamera();
    }
    if (!this.typing && this.nowSaidEl) this.beginTyping(this.nowSaidEl);
    if (this.raf === undefined) this.tick();
  }

  /**
   * キー入力。**扱うのは ←→ / E / Q の4つだけ**。
   *
   * ▲▼・Enter・Space・Esc は `ScreenHost` のものなので必ず素通しする
   * （ここで食うと出撃も帰艦もできなくなる）。
   */
  private onKey(ev: KeyboardEvent): void {
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    const consume = () => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    };
    switch (ev.code) {
      case 'ArrowLeft':
        consume();
        this.select(-1);
        break;
      case 'ArrowRight':
        consume();
        this.select(1);
        break;
      case 'KeyE':
        // 押しっぱなしで何度も歩き出さない
        if (ev.repeat) {
          consume();
          break;
        }
        consume();
        this.approach();
        break;
      case 'KeyQ':
        if (ev.repeat) {
          consume();
          break;
        }
        consume();
        this.pullBack();
        break;
      default:
        break;
    }
  }

  /** 文字送りを飛ばして全文を出す */
  skip(): void {
    if (!this.typing) return;
    this.typing.el.textContent = this.typing.text;
    this.typing = undefined;
    this.stopSpeaking();
  }

  dispose(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
    this.typing = undefined;
    this.clearWalkTimer();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    if (this.started) {
      window.removeEventListener('keydown', this.keyHandler, true);
      this.started = false;
    }
  }

  // ───────── 部屋 ─────────

  /** 部屋の名札（在室人数）。人数が変わるだけなので文字を差し替える */
  private syncPlate(): void {
    const inRoom = this.ctx.roster.pilots.filter(
      (p) => p.status === 'active' || p.status === 'wounded',
    ).length;
    this.plateEl.textContent = '';
    const b = document.createElement('b');
    b.textContent = '酒場';
    const s = document.createElement('span');
    s.textContent = `レクリエーション室 — ${inRoom} 名在室`;
    this.plateEl.append(b, s);
  }

  /**
   * 立ち絵を席の位置へ置く。
   *
   * 既にいる人物は**要素を使い回して**位置とクラスだけ更新する。
   * 新しく来た人物は入場、席を離れた人物は退場のアニメーションを付けてから消す。
   */
  private syncFigures(): void {
    const speaking = this.speakingIds();
    const active = this.activeIds();
    const seen = new Set<string>();

    for (const seat of this.ctx.barSeats ?? []) {
      const at = BAR_SPOTS[seat.id];
      if (!at || seat.occupants.length === 0) continue;
      const n = seat.occupants.length;
      seat.occupants.forEach((p, i) => {
        // 2名なら左右へ振り分ける。手前側（右）をわずかに大きくする
        const dx = n === 1 ? 0 : i === 0 ? -at.spread : at.spread;
        const scale = n === 1 ? 1 : i === 0 ? 0.94 : 1;
        seen.add(p.id);
        this.syncFigure(p, {
          x: at.x + dx,
          bottom: at.bottom,
          height: at.height * scale,
          z: i,
          align: at.align,
          speaking: speaking.has(p.id),
          active: active.has(p.id),
        });
      });
    }

    // 立ち飲み（席が足りなかった隊員）は扉の前に小さく並べる
    (this.ctx.barStanding ?? []).forEach((p, i) => {
      seen.add(p.id);
      this.syncFigure(p, {
        x: 30 + i * 7,
        bottom: 24,
        height: 54,
        z: 0,
        align: 'left',
        speaking: speaking.has(p.id),
        active: active.has(p.id),
      });
    });

    // 席を離れた人物を退場させる
    for (const [id, fig] of this.figures) {
      if (seen.has(id) || fig.leaving) continue;
      fig.leaving = true;
      fig.el.classList.remove('enter');
      fig.el.classList.add('leave');
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        fig.el.remove();
        this.figures.delete(id);
      }, LEAVE_MS);
      this.timers.add(timer);
    }

    this.syncTender();
  }

  private syncFigure(
    p: PilotState,
    o: {
      x: number;
      bottom: number;
      height: number;
      z: number;
      align: 'left' | 'right';
      speaking: boolean;
      active: boolean;
    },
  ): void {
    const def = pilotDef(p.id);
    let fig = this.figures.get(p.id);
    if (!fig) {
      fig = this.createFigure(def.personId, def.portrait, o.align, p.id);
      fig.el.classList.add('enter');
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        fig!.el.classList.remove('enter');
      }, ENTER_MS);
      this.timers.add(timer);
      this.cameraEl.appendChild(fig.el);
      this.figures.set(p.id, fig);
    }
    fig.leaving = false;
    fig.el.classList.remove('leave');

    // 位置。重なり順は「右にいる人ほど手前」にする
    // （名札が左隣の立ち絵に潜らないようにするため）
    fig.el.style.left = `${o.x}%`;
    fig.el.style.bottom = `${o.bottom}%`;
    fig.el.style.height = `${o.height}%`;
    fig.el.style.zIndex = String(10 + Math.round(o.x) + o.z);

    fig.el.classList.toggle('speaking', o.speaking);
    fig.el.classList.toggle('active', o.active);
    fig.el.classList.toggle('wounded', p.status === 'wounded');

    const stage = relationStage(p);
    fig.capName.textContent = def.callsign;
    fig.capReal.textContent = pilotDisplayName(def);
    fig.capSub.textContent =
      `${PERSONALITIES[def.personality].label}` +
      `${p.status === 'wounded' ? ' ／ 負傷' : ''}` +
      ` ／ ${stage.label}`;
  }

  /** 酒保。席割りに乗らないので固定位置で1体だけ置く */
  private syncTender(): void {
    if (!this.ctx.bartender) return;
    if (!this.tenderFig) {
      const fig = this.createFigure(BARTENDER_PERSON_ID, FALLBACK_PORTRAIT, 'right');
      fig.el.classList.add('tender');
      fig.el.style.left = `${BARTENDER_SPOT.x}%`;
      fig.el.style.bottom = `${BARTENDER_SPOT.bottom}%`;
      fig.el.style.height = `${BARTENDER_SPOT.height}%`;
      fig.el.style.zIndex = String(10 + Math.round(BARTENDER_SPOT.x));
      this.cameraEl.appendChild(fig.el);
      this.tenderFig = fig;
    }
    this.tenderFig.capName.textContent = this.ctx.bartender.name;
    this.tenderFig.capReal.textContent = '酒保';
    this.tenderFig.capSub.textContent = '';
  }

  /** 立ち絵1体ぶんの DOM を作る。無い人物は顔画像を丸く切り抜いて代わりに置く */
  private createFigure(
    personId: string,
    portrait: PortraitSpec,
    align: 'left' | 'right',
    pilotId?: string,
  ): BarFigure {
    const el = document.createElement('div');
    el.className = 'mc-barroom-fig';
    if (pilotId) {
      el.dataset.pilot = pilotId;
      // 本家と同じで、部屋の人をクリックしたら話しかけに行く
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (this.phase !== 'room') return;
        this.selectPilot(pilotId);
        this.approach(pilotId);
      });
    }

    if (hasBustArt(personId)) {
      const img = document.createElement('img');
      img.className = 'mc-barroom-bust';
      img.src = bustUrl(personId);
      img.alt = '';
      img.decoding = 'async';
      el.appendChild(img);
    } else {
      // 立ち絵が無い人物のつなぎ。顔だけを丸く出す（欠けた枠を見せない）
      const span = document.createElement('span');
      span.className = 'mc-barroom-bust fallback';
      span.innerHTML = portraitFace(personId, portrait, { size: 120, scanlines: false });
      el.appendChild(span);
    }

    const cap = document.createElement('figcaption');
    cap.className = align;
    const capName = document.createElement('b');
    const capReal = document.createElement('span');
    const capSub = document.createElement('span');
    capSub.className = 'sub';
    cap.append(capName, capReal, capSub);
    el.appendChild(cap);

    return { el, cap, capName, capReal, capSub };
  }

  // ───────── 会話ボックス ─────────

  /** いま喋っている（＝直前の発言者の）パイロット id */
  private speakingIds(): Set<string> {
    const out = new Set<string>();
    const banter = this.ctx.barBanter;
    if (banter) {
      const last = [...banter.turns].reverse().find((t) => t.speaker !== 'player');
      if (last?.pilotId) out.add(last.pilotId);
      return out;
    }
    const talk = this.ctx.barTalk;
    if (talk) {
      out.add(talk.pilotId);
      return out;
    }
    const moment = this.ctx.barMoment;
    if (moment) {
      const last = [...moment.lines].reverse().find((l) => l.pilotId);
      if (last?.pilotId) out.add(last.pilotId);
    }
    return out;
  }

  /**
   * 会話の当事者。掛け合いなら二人とも当事者なので、
   * 喋っていない側も暗く落とさない（席の空気を二人で作っているため）。
   */
  private activeIds(): Set<string> {
    const banter = this.ctx.barBanter;
    if (banter) return new Set([banter.bond.a, banter.bond.b]);
    if (!this.ctx.barTalk && this.ctx.barMoment) {
      // 一幕の話し手は全員が当事者
      return new Set(
        this.ctx.barMoment.lines.map((l) => l.pilotId).filter((id): id is string => !!id),
      );
    }
    return this.speakingIds();
  }

  /**
   * 会話ボックスを組み直すかの判定キー。
   *
   * 「何が表示されているか」を文字列で表し、前回と同じなら DOM に触らない。
   * 触らないので文字送りが巻き戻らず、噂も勝手に入れ替わらない。
   */
  private currentBoxKey(): string {
    const banter = this.ctx.barBanter;
    if (banter) return `banter:${banter.bond.a}:${banter.bond.b}:${banter.turns.length}`;
    const talk = this.ctx.barTalk;
    if (talk) return `talk:${talk.pilotId}:${talk.turns.length}`;
    const moment = this.ctx.barMoment;
    const tender = this.ctx.bartender?.line ?? '';
    const rumors = (this.ctx.rumors ?? []).map((r) => r.text).join('|');
    return `idle:${moment?.id ?? ''}:${tender}:${rumors}`;
  }

  private syncBox(): void {
    const key = this.currentBoxKey();
    if (key === this.boxKey) return;
    this.boxKey = key;
    this.renderBox(this.boxView());
    // 直前の文字送りは破棄して、新しい行から始める
    this.typing = undefined;
    if (this.raf !== undefined && this.nowSaidEl) this.beginTyping(this.nowSaidEl);
  }

  private boxView(): BoxView {
    const banter = this.ctx.barBanter;
    if (banter) return this.banterBox(banter);
    const talk = this.ctx.barTalk;
    if (talk) return this.talkBox(talk);
    if (this.ctx.barMoment) return this.momentBox(this.ctx.barMoment);
    return this.idleBox();
  }

  /** 1対1の会話 */
  private talkBox(talk: BarTalkView): BoxView {
    const def = pilotDef(talk.pilotId);
    return {
      faces: [talk.pilotId],
      name: def.callsign,
      sub: `${pilotDisplayName(def)} ／ ${PERSONALITIES[def.personality].label}`,
      rel: `関係 ${talk.relation.label}`,
      turns: talk.turns.map((t, i) => ({
        who: t.speaker === 'player' ? '自分' : def.callsign,
        text: t.text,
        speaker: t.speaker,
        now: i === talk.turns.length - 1 && t.speaker === 'pilot',
      })),
      reason: talk.relation.reason,
      cue: talk.replies.length
        ? `返事は下の「→」から選ぶ（${talk.replies.length} 択）`
        : 'この話は終わった。',
    };
  }

  /** 同席2名の掛け合いへの割り込み */
  private banterBox(view: BarBanterView): BoxView {
    const a = pilotDef(view.bond.a);
    const b = pilotDef(view.bond.b);
    const kind = PILOT_BOND_KINDS[view.bond.kind as keyof typeof PILOT_BOND_KINDS];
    return {
      faces: [view.bond.a, view.bond.b],
      name: `${a.callsign} と ${b.callsign}`,
      sub: `${kind?.label ?? ''} ／ ${view.bond.title}`,
      rel: `二人の仲 ${view.level.label}`,
      kind: view.bond.kind,
      turns: view.turns.map((t, i) => ({
        who: t.speaker === 'player' ? '自分' : t.pilotId ? pilotDef(t.pilotId).callsign : '',
        text: t.text,
        speaker: t.speaker === 'player' ? 'player' : 'pilot',
        now: i === view.turns.length - 1 && t.speaker !== 'player',
      })),
      reason: view.reason,
      outcome: view.outcome,
      cue: view.replies.length
        ? `下の「→」から割り込む（${view.replies.length} 択）`
        : 'もう口を挟む場面ではない。',
    };
  }

  /**
   * 節目の一幕。こちらが話しかける前に始まっている場面なので、
   * 返事は出さず、見出しと台詞だけを並べる。
   */
  private momentBox(moment: NonNullable<HubContext['barMoment']>): BoxView {
    const faces = moment.lines
      .map((l) => l.pilotId)
      .filter((id): id is string => !!id)
      // 同じ人を二度出さない
      .filter((id, i, all) => all.indexOf(id) === i)
      .slice(0, 2);
    return {
      faces,
      name: moment.title,
      sub: '入ったときには、もう始まっていた',
      turns: moment.lines.map((l, i) => ({
        who: l.who,
        text: l.text,
        speaker: 'pilot' as const,
        now: i === moment.lines.length - 1,
      })),
      cue: '下の項目から話し相手を選ぶ。同じ席の二人には割り込める。',
    };
  }

  /** 誰とも話していないとき。酒保の一言と噂を出す */
  private idleBox(): BoxView {
    const tender = this.ctx.bartender;
    return {
      faces: [],
      name: tender?.name ?? '酒場',
      sub: tender ? '酒保' : undefined,
      turns: tender ? [{ who: '', text: tender.line, speaker: 'pilot' as const, now: true }] : [],
      rumors: this.ctx.rumors,
      cue: '下の項目から話し相手を選ぶ。同じ席の二人には割り込める。',
    };
  }

  /** 会話ボックスを組む。文字送りの対象は `nowSaidEl` に控える */
  private renderBox(v: BoxView): void {
    this.boxEl.textContent = '';
    this.nowSaidEl = undefined;
    this.faceEls = [];

    // ── VDU（話者の顔）。喋っている間は口が動く
    const vdu = document.createElement('div');
    vdu.className = v.faces.length > 1 ? 'mc-barroom-vdu pair' : 'mc-barroom-vdu';
    const speaking = this.speakingIds();
    if (v.faces.length === 0) {
      const face = document.createElement('span');
      face.innerHTML = portraitFace(BARTENDER_PERSON_ID, FALLBACK_PORTRAIT, {
        size: 92,
        speaking: true,
      });
      vdu.appendChild(face);
      this.faceEls.push(face);
    } else {
      for (const id of v.faces) {
        const def = pilotDef(id);
        const face = document.createElement('span');
        face.innerHTML = portraitFace(def.id, def.portrait, {
          size: v.faces.length > 1 ? 78 : 92,
          speaking: speaking.has(id),
        });
        vdu.appendChild(face);
        this.faceEls.push(face);
      }
    }

    // ── 台詞
    const said = document.createElement('div');
    said.className = 'mc-barroom-said';

    const who = document.createElement('div');
    who.className = 'mc-barroom-who';
    if (v.kind) who.dataset.kind = v.kind;
    const name = document.createElement('b');
    name.textContent = v.name;
    who.appendChild(name);
    if (v.sub) {
      const sub = document.createElement('span');
      sub.textContent = v.sub;
      who.appendChild(sub);
    }
    if (v.rel) {
      const rel = document.createElement('span');
      rel.className = 'rel';
      rel.textContent = v.rel;
      who.appendChild(rel);
    }
    said.appendChild(who);

    const lines = document.createElement('div');
    lines.className = 'mc-barroom-lines';
    for (const t of v.turns) {
      const p = document.createElement('p');
      p.className = `mc-barroom-turn ${t.speaker}${t.now ? ' now' : ''}`;
      if (t.who) {
        const w = document.createElement('span');
        w.className = 'who';
        w.textContent = t.who;
        p.appendChild(w);
      }
      const body = document.createElement('span');
      body.className = 'said';
      if (t.now) {
        // 文字送りの対象。本文は `beginTyping()` が1文字ずつ入れる
        body.dataset.text = t.text;
        this.nowSaidEl = body;
      } else {
        body.textContent = t.text;
      }
      p.appendChild(body);
      lines.appendChild(p);
    }
    said.appendChild(lines);

    if (v.reason) {
      const el = document.createElement('div');
      el.className = 'mc-barroom-reason';
      el.textContent = v.reason;
      said.appendChild(el);
    }
    if (v.outcome) {
      const el = document.createElement('div');
      el.className = 'mc-barroom-outcome';
      el.textContent = v.outcome;
      said.appendChild(el);
    }
    if (v.rumors?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'mc-barroom-rumors';
      for (const r of v.rumors) {
        const el = document.createElement('div');
        el.className = 'mc-barroom-rumor';
        const src = document.createElement('span');
        src.textContent = r.source;
        const body = document.createElement('span');
        body.textContent = r.text;
        el.append(src, body);
        wrap.appendChild(el);
      }
      said.appendChild(wrap);
    }

    const cue = document.createElement('div');
    cue.className = 'mc-barroom-cue';
    cue.textContent = v.cue;
    said.appendChild(cue);

    this.boxEl.append(vdu, said);
  }

  // ───────── 文字送り ─────────

  private beginTyping(el: HTMLElement): void {
    const text = el.dataset.text ?? '';
    el.textContent = '';
    this.typing = { el, text, chars: 0 };
  }

  private tick(): void {
    this.raf = requestAnimationFrame(() => this.tick());
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    const t = this.typing;
    if (!t) return;
    const now = performance.now();
    if (t.startedAt === undefined) t.startedAt = now;
    const want = Math.min(t.text.length, Math.floor(((now - t.startedAt) / 1000) * CPS));
    if (want === t.chars) return;
    t.chars = want;
    t.el.textContent = t.text.slice(0, want);
    if (want >= t.text.length) {
      this.typing = undefined;
      this.stopSpeaking();
    }
  }

  /** 喋り終わったら口の動きを止め、聞き手にうなずかせる */
  private stopSpeaking(): void {
    for (const face of this.faceEls) {
      // `portraitFace` が入れた `.mc-face.speaking` を止める。
      // innerHTML で作った子なので、直下の要素だけ見ればよい
      const child = face.firstElementChild;
      child?.classList.remove('speaking');
    }
    for (const fig of this.figures.values()) {
      if (!fig.el.classList.contains('active') || fig.el.classList.contains('speaking')) continue;
      fig.el.classList.add('nod');
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        fig.el.classList.remove('nod');
      }, 700);
      this.timers.add(timer);
    }
  }
}
