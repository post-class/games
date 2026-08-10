import { Vector3 } from 'three';
import { isHostile } from '../content/factions';
import { InputManager, type InputAction, type ScriptedFlightInput } from '../app/input';
import { difficulty, settings, type ControlBinding } from '../app/settings';
import { forwardOf, leadPoint } from '../core/math';
import { steerCommandToPoint, type SteerCommand } from '../sim/steer';
import { primaryGunSpeed } from '../sim/targeting';
import { activeMissileSlot } from '../sim/weapons';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

/**
 * お手本モード（チュートリアル）。
 *
 * ■ 何をするものか
 * 「このキーを押すとこうなる」を**実際に操縦して見せる**課程。
 * スロットル・ピッチ・ヨー・ロール・アフターバーナー・ターゲット・主砲・
 * ミサイル・フレア・HUD操作を順に実演し、最後に敵とのドッグファイトを行う。
 * 実演中は、いま押しているキーを画面に出す。
 *
 * ■ 設計の要点（ここを崩すと「表示と実挙動が違う」状態に戻る）
 * 1. 操縦は `InputManager.scripted` と `pushAction()` を通す。
 *    つまり**人間が操作したときと同じ経路**で `Game` に届くので、
 *    お手本だけ特別な処理で動く、ということが起きない。
 * 2. 画面に出す「押しているキー」は、その経路へ渡した値そのものから導く
 *    (`derivePressedKeys`)。表示用に別の台本を持たない。
 * 3. キーの表示名は `settings.keyBindings` + `InputManager.keyLabel` から作る。
 *    キー割り当てを変えている人には、その人のキーが表示される。
 * 4. 機首の向け方は AI と同じ式 (`sim/steer.ts`) を使う。
 *    お手本だけ超人的に曲がる、ということが起きない。
 */

/** 実演がゲームへ渡す入力の一式 */
interface DemoDrive extends ScriptedFlightInput {
  /** 0..1。`InputManager.throttle` へそのまま入れる */
  throttle: number;
  /** このフレームで押す単発キー */
  actions: InputAction[];
}

interface DemoStepContext {
  world: World;
  player: Entity;
  /** このステップの経過秒 */
  t: number;
  /** 今フレームの秒数 */
  dt: number;
  demo: TutorialDemo;
}

/**
 * スロットルを目標値へ「レバーを動かす速さで」寄せる。
 *
 * 目標値を直接代入すると、実機の出撃時スロットル (難易度で変わる) から
 * 1フレームで飛び、点灯キーが一瞬逆向き (増やしたいのに「スロットル-」) に出る。
 * 人がキーを押している速さ (`THROTTLE_KEY_RATE` 相当) で動かす。
 */
function throttleToward(current: number, target: number, dt: number, rate = 0.5): number {
  if (current < target) return Math.min(target, current + rate * dt);
  if (current > target) return Math.max(target, current - rate * dt);
  return target;
}

interface DemoStep {
  id: string;
  /** 何を見せているか (1行) */
  title: string;
  /** どのキーで何が起きるか */
  detail: string;
  /** 画面に並べるキー (押していない間は暗く出す) */
  keys: ControlBinding[];
  seconds: number;
  drive(d: DemoDrive, c: DemoStepContext): void;
  /** 秒数を待たずに次へ進む条件 */
  done?(c: DemoStepContext): boolean;
}

/** 単発キーと操作の対応 (表示に使う)。同じ表から `Game` の処理名を引く */
const ACTION_KEY: Partial<Record<InputAction, ControlBinding>> = {
  fireMissile: 'fireMissile',
  targetNext: 'targetNext',
  targetNearest: 'targetNearest',
  targetFront: 'targetFront',
  autopilot: 'autopilot',
  comms: 'comms',
  damageDisplay: 'damageDisplay',
  hudPanelToggle: 'hudPanelToggle',
  viewToggle: 'viewToggle',
  navMap: 'navMap',
  nextSecondary: 'nextSecondary',
  flare: 'flare',
  mouseToggle: 'mouseToggle',
  flightModeToggle: 'flightModeToggle',
};

/** 実演を次へ送るキー。`ui/Tutorial.ts` の案内送りと同じ B を使う。 */
const DEMO_SKIP_CODE = 'KeyB';

/** 舵を「押している」と表示する下限 */
const STICK_SHOWN = 0.12;

const _lead = new Vector3();
const _steer: SteerCommand = { pitch: 0, yaw: 0, roll: 0 };
const _to = new Vector3();
const _fwd = new Vector3();

/** いま狙っている敵 (生きていて敵対しているものだけ) */
function liveTarget(world: World, player: Entity): Entity | undefined {
  const id = player.ship?.targetId;
  if (id === undefined) return undefined;
  const t = world.byId(id);
  if (!t || !t.alive || t.kind !== 'ship') return undefined;
  return isHostile(player.faction, t.faction) ? t : undefined;
}

/** 空域に残っている敵機の数 */
function hostileCount(world: World, player: Entity): number {
  let n = 0;
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
    if (e.ship.ejected) continue;
    if (isHostile(player.faction, e.faction)) n += 1;
  }
  return n;
}

/**
 * 追尾と射撃。実演のうち「戦う」部分はすべてここを通す。
 *
 * 偏差射点 (`leadPoint`) は HUD の黄色い点線の丸と同じ式なので、
 * お手本は画面に出ている射点へ機首を運んでいることになる。
 */
function pursue(
  d: DemoDrive,
  c: DemoStepContext,
  o: { fire: boolean; missile: boolean; useAb: boolean },
): { target?: Entity; range: number; aimError: number } {
  const { world, player, demo } = c;
  const ship = player.ship!;
  const target = liveTarget(world, player);
  if (!target) {
    // 目標を失ったら R で取り直す。人間と同じキーを押す。
    if (hostileCount(world, player) > 0 && demo.cooldownReady('retarget', 1.2)) {
      d.actions.push('targetNearest');
    }
    d.throttle = throttleToward(d.throttle, 0.45, c.dt);
    return { range: Infinity, aimError: Math.PI };
  }

  const gunSpeed = primaryGunSpeed(player, difficulty().playerGunSpeedScale);
  leadPoint(player.pos, target.pos, target.vel, gunSpeed, _lead);
  steerCommandToPoint(player, _lead, 2.6, 0.45, _steer);
  d.pitch = _steer.pitch;
  d.yaw = _steer.yaw;
  d.roll = _steer.roll;

  const range = player.pos.distanceTo(target.pos);
  _to.copy(_lead).sub(player.pos);
  const leadDist = _to.length();
  const cos = leadDist > 1e-4 ? _to.divideScalar(leadDist).dot(forwardOf(player.quat, _fwd)) : -1;
  const aimError = Math.acos(Math.max(-1, Math.min(1, cos)));

  // 間合い: 遠ければ詰め、近ければ絞って追い越さない
  const wantThrottle = range > 2400 ? 1 : range > 1100 ? 0.75 : 0.42;
  d.throttle = throttleToward(d.throttle, wantThrottle, c.dt, 0.9);
  d.afterburner = o.useAb && range > 3000 && ship.fuel > ship.fuelMax * 0.3;

  // 照準が乗って射程内なら主砲を引く
  if (o.fire && aimError < 0.06 && range < 1600) d.firePrimary = true;

  // 誘導弾はロックが付いてから。近すぎると信管が働かないので距離も見る
  if (o.missile && ship.lockedId === target.id && range > 700 && range < 4500) {
    const slot = activeMissileSlot(player);
    if (slot && demo.cooldownReady('missile', 4)) d.actions.push('fireMissile');
  }

  // 自分に向かうミサイルにはフレアを撒く (HUD の警告と同じ出所)
  if (ship.incomingMissileId !== undefined && ship.flares > 0 && demo.cooldownReady('flare', 2.5)) {
    d.actions.push('flare');
  }
  return { target, range, aimError };
}

/**
 * 実演の台本。
 *
 * 前半は「1操作ずつ、何が起きるか」を見せる。後半で通しのドッグファイトへ入る。
 */
const DEMO_STEPS: DemoStep[] = [
  {
    id: 'throttle-up',
    title: 'スロットルを上げる',
    detail: 'スロットルを上げると加速する。押しっぱなしで上がり続け、離しても値は保たれる。',
    keys: ['throttleUp'],
    seconds: 6,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.7, c.dt, 0.16);
    },
  },
  {
    id: 'throttle-down',
    title: 'スロットルを下げる',
    detail: '速度を落とすと旋回が効くようになる。重い機体は「曲がりたければ絞る」。',
    keys: ['throttleDown'],
    seconds: 5,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.35, c.dt, 0.12);
    },
  },
  {
    id: 'pitch',
    title: '機首を上下に振る',
    detail: '機首上げ／機首下げ。照準環はいつも画面中央にあり、弾はそこへ飛ぶ。',
    keys: ['pitchUp', 'pitchDown'],
    seconds: 9,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.5, c.dt);
      if (c.t < 3) d.pitch = 0.7;
      else if (c.t < 6.5) d.pitch = -0.7;
    },
  },
  {
    id: 'yaw',
    title: '機首を左右に振る',
    detail: 'ヨーは機首の左右。旋回はロールと組み合わせると速い。',
    keys: ['yawLeft', 'yawRight'],
    seconds: 8,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.5, c.dt);
      if (c.t < 3) d.yaw = -0.8;
      else if (c.t < 6) d.yaw = 0.8;
    },
  },
  {
    id: 'roll',
    title: '機体をロールさせる',
    detail: 'ロールで機体を傾け、曲がりたい方向へ揚力を向ける。傾けてから機首を引く。',
    keys: ['rollLeft', 'rollRight', 'pitchUp'],
    seconds: 9,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.55, c.dt);
      if (c.t < 2.5) d.roll = -0.9;
      else if (c.t < 5) {
        d.roll = -0.35;
        d.pitch = 0.6;
      } else if (c.t < 7) d.roll = 0.9;
    },
  },
  {
    id: 'afterburner',
    title: 'アフターバーナー',
    detail: '押している間だけ加速する。燃料を食い、旋回性能も落ちるので離脱と接敵に使う。',
    keys: ['afterburner', 'throttleMax'],
    seconds: 7,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 1, c.dt, 0.8);
      d.afterburner = c.t > 0.6 && c.t < 5;
    },
  },
  {
    id: 'target',
    title: '敵をターゲットする',
    detail: '最至近の敵を掴む。HUD に距離・機体名・残ハルが出て、レーダーに枠が付く。',
    keys: ['targetNearest', 'targetNext', 'targetFront'],
    seconds: 6,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.6, c.dt);
      if (c.demo.once('take-target')) d.actions.push('targetNearest');
      pursue(d, c, { fire: false, missile: false, useAb: true });
    },
  },
  {
    id: 'guns',
    title: '主砲を撃つ',
    detail: '黄色い点線の丸が「そこを撃てば当たる」射点。機首をそこへ運んでから引く。',
    keys: ['firePrimary', 'targetNearest'],
    seconds: 14,
    drive: (d, c) => {
      pursue(d, c, { fire: true, missile: false, useAb: true });
    },
  },
  {
    id: 'secondary',
    title: '副兵装を切り替える',
    detail: '無誘導弾と誘導弾を切り替える。HUD の兵装名と残弾を見る。',
    keys: ['nextSecondary'],
    seconds: 6,
    drive: (d, c) => {
      if (c.demo.once('cycle-1') || (c.t > 2.5 && c.demo.once('cycle-2'))) {
        d.actions.push('nextSecondary');
      }
      pursue(d, c, { fire: false, missile: false, useAb: false });
    },
  },
  {
    id: 'missile',
    title: 'ミサイルを撃つ',
    detail: '敵を正面に捉え続けるとロックが進み、ロック完了で発射できる。',
    keys: ['fireMissile', 'nextSecondary'],
    seconds: 16,
    drive: (d, c) => {
      pursue(d, c, { fire: false, missile: true, useAb: true });
    },
  },
  {
    id: 'flare',
    title: 'フレアを撒く',
    detail: '敵ミサイルの警告が出たら投下する。誘導を引き剥がすための消耗品。',
    keys: ['flare'],
    seconds: 5,
    drive: (d, c) => {
      if (c.demo.once('drop-flare')) d.actions.push('flare');
      pursue(d, c, { fire: false, missile: false, useAb: false });
    },
  },
  {
    id: 'hud',
    title: '被害状況・視点・Nav マップ',
    detail: '被害状況、外部視点、Nav マップを切り替える。どれも押すたびに開閉する。',
    keys: ['damageDisplay', 'viewToggle', 'navMap'],
    seconds: 13,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.5, c.dt);
      const at = (sec: number, key: string) => c.t > sec && c.demo.once(key);
      if (at(0.5, 'dmg-on')) d.actions.push('damageDisplay');
      if (at(3, 'dmg-off')) d.actions.push('damageDisplay');
      if (at(4, 'view-out')) d.actions.push('viewToggle');
      if (at(7, 'view-in')) d.actions.push('viewToggle');
      if (at(8, 'nav-on')) d.actions.push('navMap');
      if (at(11, 'nav-off')) d.actions.push('navMap');
    },
  },
  {
    id: 'dogfight',
    title: 'ドッグファイト',
    detail: '実戦の形。絞って曲がり、射点へ機首を置いて撃つ。深追いせず、間合いを取り直す。',
    keys: ['firePrimary', 'fireMissile', 'afterburner', 'targetNearest', 'flare'],
    seconds: 75,
    drive: (d, c) => {
      pursue(d, c, { fire: true, missile: true, useAb: true });
    },
    // 「敵を出し切って全機落とした」ときだけ早く終える。
    // 増援が出る前 (出現待ちの間) は 0 機なので、見たことがある場合に限る。
    done: (c) => c.demo.sawHostiles && hostileCount(c.world, c.player) === 0,
  },
  {
    id: 'handover',
    title: 'お手本は終わり',
    detail: 'ここから操作を引き継ぐ。同じ空域でそのまま試せる (Esc で終了)。',
    keys: [],
    seconds: 6,
    drive: (d, c) => {
      d.throttle = throttleToward(d.throttle, 0.5, c.dt);
    },
  },
];

export class TutorialDemo {
  active = false;
  /** 台本を最後まで流したか */
  completed = false;
  private index = 0;
  private stepElapsed = 0;
  private readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly keysEl: HTMLElement;
  private readonly headEl: HTMLElement;
  /** ステップ内で1回だけ行う操作の記録 */
  private flags = new Set<string>();
  /** 連続で押さないための最後の実行時刻 (ステップ経過秒ではなく通算) */
  private cooldowns = new Map<string, number>();
  private elapsed = 0;
  private lastThrottle = 0;
  private readonly drive: DemoDrive = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    afterburner: false,
    firePrimary: false,
    throttle: 0,
    actions: [],
  };
  /** 直前に描画した内容 (毎フレーム DOM を書き換えない) */
  private renderedStep = -1;
  private renderedKeys = '';
  /**
   * 一度でも敵機を空域に見たか。
   * 出現待ちの「まだ0機」と、撃ち終えた「もう0機」を区別するために持つ。
   */
  sawHostiles = false;
  /** B キーで「次の実演へ」が要求されたか (update で消費する) */
  private skipRequested = false;
  private readonly unsubs: Array<() => void> = [];

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'mc-demo';
    this.el.style.display = 'none';
    this.headEl = document.createElement('div');
    this.headEl.className = 'head';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'title';
    this.detailEl = document.createElement('div');
    this.detailEl.className = 'detail';
    this.keysEl = document.createElement('div');
    this.keysEl.className = 'keys';
    this.el.append(this.headEl, this.titleEl, this.detailEl, this.keysEl);
    container.appendChild(this.el);

    // 見ている側が飽きたときに飛ばせるようにする。チュートリアルの案内送りと同じキー。
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!this.active || ev.repeat || ev.code !== DEMO_SKIP_CODE) return;
      // B はチュートリアル専用。ゲーム側へ渡して意図しない操作を起こさない。
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.skipRequested = true;
    };
    window.addEventListener('keydown', onKeyDown);
    this.unsubs.push(() => window.removeEventListener('keydown', onKeyDown));
  }

  /** 実演を始める */
  start(): void {
    this.active = true;
    this.completed = false;
    this.index = 0;
    this.stepElapsed = 0;
    this.elapsed = 0;
    this.flags.clear();
    this.cooldowns.clear();
    this.renderedStep = -1;
    this.renderedKeys = '';
    this.lastThrottle = 0;
    this.skipRequested = false;
    this.sawHostiles = false;
    this.render([]);
  }

  /** 実演を終える。操縦は人間へ戻す。 */
  stop(input?: InputManager): void {
    this.active = false;
    this.el.style.display = 'none';
    if (input) input.scripted = undefined;
  }

  /** 現在のステップ番号 (0 始まり。テスト・確認用) */
  get stepIndex(): number {
    return this.index;
  }

  /** 全ステップ数 (テスト・確認用) */
  get stepCount(): number {
    return DEMO_STEPS.length;
  }

  /** 現在のステップ id (テスト・確認用) */
  get stepId(): string {
    return DEMO_STEPS[this.index]?.id ?? '';
  }

  /** 帯が出ているか (テスト・確認用) */
  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  /** ステップ内で1回だけ true を返す */
  once(key: string): boolean {
    if (this.flags.has(key)) return false;
    this.flags.add(key);
    return true;
  }

  /** 前回から `seconds` 秒以上たっていれば true (連射防止) */
  cooldownReady(key: string, seconds: number): boolean {
    const last = this.cooldowns.get(key);
    if (last !== undefined && this.elapsed - last < seconds) return false;
    this.cooldowns.set(key, this.elapsed);
    return true;
  }

  /**
   * 実演を1ステップ進める。
   *
   * @param locked 発艦演出中など、操作を渡してはいけない状態
   */
  update(world: World, input: InputManager, dt: number, locked = false): void {
    if (!this.active) return;
    const player = world.player;
    const step = DEMO_STEPS[this.index];
    if (!step || !player?.ship || player.ship.ejected) {
      input.scripted = undefined;
      if (!step) this.finishScript(input);
      return;
    }
    if (locked) {
      // 演出中は台本を止め、操縦も渡さない (時計も進めない)
      input.scripted = undefined;
      return;
    }

    this.elapsed += dt;
    this.stepElapsed += dt;
    if (hostileCount(world, player) > 0) this.sawHostiles = true;

    const d = this.drive;
    d.pitch = 0;
    d.yaw = 0;
    d.roll = 0;
    d.afterburner = false;
    d.firePrimary = false;
    d.throttle = input.throttle;
    d.actions.length = 0;
    step.drive(d, { world, player, t: this.stepElapsed, dt, demo: this });

    // 表示するキーは「ゲームへ渡した値」から作る (別の台本を持たない)
    const pressed = derivePressedKeys(d, this.lastThrottle);
    this.lastThrottle = d.throttle;

    // 人間の操作と同じ経路へ流す
    input.scripted = d;
    input.throttle = Math.max(0, Math.min(1, d.throttle));
    for (const a of d.actions) input.pushAction(a);

    this.render(pressed);

    if (
      this.skipRequested ||
      this.stepElapsed >= step.seconds ||
      step.done?.({ world, player, t: this.stepElapsed, dt, demo: this })
    ) {
      this.skipRequested = false;
      this.advance(input);
    }
  }

  private advance(input: InputManager): void {
    this.index += 1;
    this.stepElapsed = 0;
    this.flags.clear();
    if (this.index >= DEMO_STEPS.length) this.finishScript(input);
  }

  /** 台本を流し終えた。帯を畳んで操縦を人間へ返す。 */
  private finishScript(input: InputManager): void {
    this.completed = true;
    this.stop(input);
  }

  private render(pressed: ControlBinding[]): void {
    const step = DEMO_STEPS[this.index];
    if (!step || !this.active) return;
    this.el.style.display = '';
    if (this.renderedStep !== this.index) {
      this.renderedStep = this.index;
      this.headEl.textContent = `お手本 ${this.index + 1} / ${DEMO_STEPS.length}　[B] 次の実演へ`;
      this.titleEl.textContent = step.title;
      this.detailEl.textContent = step.detail;
    }
    // 並べるキー: ステップが宣言したもの + 実際に押しているもの
    const shown: ControlBinding[] = [...step.keys];
    for (const k of pressed) if (!shown.includes(k)) shown.push(k);
    const signature = `${shown.join(',')}|${pressed.join(',')}`;
    if (signature === this.renderedKeys) return;
    this.renderedKeys = signature;
    this.keysEl.replaceChildren();
    for (const binding of shown) {
      const chip = document.createElement('span');
      chip.className = pressed.includes(binding) ? 'key on' : 'key';
      chip.textContent = keyChipLabel(binding);
      this.keysEl.appendChild(chip);
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.el.remove();
  }
}

/**
 * ゲームへ渡した入力から「押しているキー」を求める。
 *
 * 表示の出所をここ1本にしているので、実演の内容を変えても
 * 表示だけが古いまま残ることがない。
 */
export function derivePressedKeys(
  d: { pitch: number; yaw: number; roll: number; afterburner: boolean; firePrimary: boolean; throttle: number; actions: InputAction[] },
  previousThrottle: number,
): ControlBinding[] {
  const keys: ControlBinding[] = [];
  if (d.throttle > previousThrottle + 1e-4) keys.push('throttleUp');
  else if (d.throttle < previousThrottle - 1e-4) keys.push('throttleDown');
  if (d.pitch > STICK_SHOWN) keys.push('pitchUp');
  else if (d.pitch < -STICK_SHOWN) keys.push('pitchDown');
  if (d.yaw > STICK_SHOWN) keys.push('yawRight');
  else if (d.yaw < -STICK_SHOWN) keys.push('yawLeft');
  if (d.roll > STICK_SHOWN) keys.push('rollRight');
  else if (d.roll < -STICK_SHOWN) keys.push('rollLeft');
  if (d.afterburner) keys.push('afterburner');
  if (d.firePrimary) keys.push('firePrimary');
  for (const a of d.actions) {
    const binding = ACTION_KEY[a];
    if (binding && !keys.includes(binding)) keys.push(binding);
  }
  return keys;
}

/** キーの表示名。割り当てを変えている人には、その人のキーを出す。 */
export function keyChipLabel(binding: ControlBinding): string {
  const code = settings.keyBindings[binding];
  return `${InputManager.keyLabel(code)} ${BINDING_LABEL[binding]}`;
}

/** チップに出す操作名 (設定画面の `CONTROL_BINDINGS` より短い表記) */
const BINDING_LABEL: Record<ControlBinding, string> = {
  pitchUp: '機首上げ',
  pitchDown: '機首下げ',
  yawLeft: 'ヨー左',
  yawRight: 'ヨー右',
  rollLeft: 'ロール左',
  rollRight: 'ロール右',
  afterburner: 'AB',
  firePrimary: '主砲',
  fireMissile: 'ミサイル',
  targetNext: '次の敵',
  targetNearest: '最至近',
  targetFront: '正面',
  autopilot: '自動航行',
  comms: '通信',
  damageDisplay: '被害',
  hudPanelToggle: 'HUD',
  viewToggle: '視点',
  navMap: 'Nav',
  nextSecondary: '副兵装',
  flare: 'フレア',
  mouseToggle: 'マウス',
  flightModeToggle: '飛行モード',
  pause: 'ポーズ',
  throttleMax: '全速',
  throttleStop: '停止',
  throttleUp: 'スロットル+',
  throttleDown: 'スロットル-',
};
