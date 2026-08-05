import type { PetAction } from '../../shared/actions.js';
import type { PetView, RoomLayout } from '../../shared/types.js';
import { findSpot, isNight, zoneAt } from '../../shared/world.js';
import { preloadFor } from './assets.js';
import {
  drawBubble,
  drawParticles,
  spawnParticles,
  updateParticles,
  type Bubble,
  type Particle,
} from './Effects.js';
import { drawPet, drawShadow } from './PetSprite.js';
import {
  clampCam,
  depthScale,
  depthY,
  drawFurniture,
  drawMinimap,
  drawSpots,
  drawWorld,
  screenX,
  worldMetrics,
  type WorldMetrics,
} from './WorldLayer.js';
import {
  forceAction,
  initialAgenda,
  updateAgenda,
  type AgendaEvent,
  type AgendaState,
} from '../sim/agenda.js';

/**
 * 2D ステージ。
 *
 * 世界は画面より横に広いので、カメラがペットを追いかける。
 * ペットは指示待ちではなく、アジェンダ（sim/agenda.ts）に従って
 * 自分で行き先を決めて歩き、その場所ならではの行動をする。
 *
 * 飼い主が世界を自分で見て回れるように、横ドラッグでカメラを動かせる。
 * 手を離してしばらくすると、またペットを追いかけ直す（見失わせない）。
 */

export interface StageCallbacks {
  /** ペットが触られた（撫でた）。 */
  onPetTouched(): void;
  /** FSM が新しい行動を選んだ。LLM の思いつきを挟むタイミングの判断に使う。 */
  onActionChanged?(action: PetAction): void;
  /** 新しい場所で何かを始めた。ログ表示と発見の報酬に使う。 */
  onAgendaEvent?(event: AgendaEvent): void;
}

const PARTICLE_BY_ACTION: Partial<Record<PetAction, Particle['kind']>> = {
  eat: 'crumb',
  play: 'note',
  nap: 'zzz',
  nuzzle: 'heart',
  jump_joy: 'sparkle',
  wash: 'sparkle',
  dig: 'crumb',
  bury_treasure: 'crumb',
  splash_puddle: 'sparkle',
  sniff_flower: 'sparkle',
  chase_butterfly: 'note',
  dance: 'note',
  sing: 'note',
  stargaze: 'sparkle',
  sunbathe: 'sparkle',
  chat_bird: 'note',
  roll_around: 'note',
  climb_tree: 'sparkle',
  daydream: 'zzz',
};

/** カメラが手動操作から自動追尾に戻るまでの時間。 */
const MANUAL_CAM_MS = 6000;

export class Stage {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private pet: PetView | null = null;
  private layout: RoomLayout = { wall: 'cream', floor: 'wood', furniture: [] };
  private agenda: AgendaState = initialAgenda(0);
  private particles: Particle[] = [];
  private bubble: Bubble | null = null;
  private lastFrame = 0;
  private elapsed = 0;
  private raf = 0;
  private lastParticleAt = 0;
  /** ペットの当たり判定（画面座標）。 */
  private petBox = { x: 0, y: 0, width: 0, height: 0 };
  /** ペットの足元（世界 px）。パーティクルの発生位置に使う。 */
  private petWorld = { x: 0, y: 0 };
  private camX = 0;
  private manualCamUntil = 0;
  private drag: { startX: number; startCam: number; moved: boolean } | null = null;

  constructor(
    container: HTMLElement,
    private readonly callbacks: StageCallbacks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D が使えません');
    this.ctx = ctx;

    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', () => {
      this.drag = null;
    });
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setPet(pet: PetView): void {
    const speciesChanged = this.pet?.species !== pet.species || this.pet?.stage !== pet.stage;
    this.pet = pet;
    if (speciesChanged) preloadFor(pet.species, pet.stage);
  }

  setLayout(layout: RoomLayout): void {
    this.layout = layout;
  }

  /** LLM や世話の反応で行動を差し込む。 */
  playAction(action: PetAction): void {
    this.agenda = forceAction(this.agenda, action, this.elapsed);
    const kind = PARTICLE_BY_ACTION[action];
    if (kind) {
      this.particles.push(
        ...spawnParticles(kind, this.petWorld.x, this.petWorld.y - this.petBox.height * 0.8, 5),
      );
    }
  }

  /** お祝いの紙吹雪（成長したときなど）。 */
  celebrate(): void {
    for (let i = 0; i < 3; i += 1) {
      this.particles.push(
        ...spawnParticles(
          'sparkle',
          this.petWorld.x,
          this.petWorld.y - this.petBox.height * (0.4 + i * 0.3),
          6,
        ),
        ...spawnParticles('heart', this.petWorld.x, this.petWorld.y - this.petBox.height * 0.7, 3),
      );
    }
    this.agenda = forceAction(this.agenda, 'jump_joy', this.elapsed);
  }

  say(text: string, durationMs = 5200): void {
    this.bubble = { text, until: this.elapsed + durationMs, pending: false };
    // 話しているのに画面外だと誰の言葉か分からないので、カメラを呼び戻す。
    this.manualCamUntil = 0;
  }

  showPending(): void {
    this.bubble = { text: '', until: this.elapsed + 20_000, pending: true };
  }

  clearBubble(): void {
    this.bubble = null;
  }

  /** いまペットが居る場所の言い方（「にわ の みずたまり」）。LLM に渡す。 */
  placeCaption(): string {
    const zone = zoneAt(this.agenda.x);
    const spot = this.agenda.spotId ? findSpot(this.agenda.spotId) : null;
    if (this.agenda.phase === 'travel') {
      return spot ? `${zone.name}から ${spot.name} へ 移動中` : `${zone.name}を うろうろ`;
    }
    return spot ? `${zone.name}の ${spot.name}` : zone.name;
  }

  /** いまの行き先・滞在先（サーバに渡して独り言の材料にする）。 */
  currentSpotId(): string | null {
    return this.agenda.spotId;
  }

  start(): void {
    if (this.raf) return;
    const loop = (timestamp: number) => {
      const delta = this.lastFrame ? Math.min(80, timestamp - this.lastFrame) : 16;
      this.lastFrame = timestamp;
      this.elapsed += delta;
      this.update(delta);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastFrame = 0;
  }

  /** HUD の描画後に呼ぶと、実際の HUD の高さに合わせてステージを詰め直す。 */
  refit(): void {
    this.resize();
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const width = Math.max(280, rect?.width ?? 320);
    // プレイテストで画面下に大きな余白が余っていたので、
    // 画面の高さから HUD の分を引いた残りをステージに使う（縦長画面ほど広くなる）。
    const hudHeight = document.querySelector('.hud')?.getBoundingClientRect().height ?? 330;
    const headerHeight = document.querySelector('.app-head')?.getBoundingClientRect().height ?? 46;
    const available = window.innerHeight - hudHeight - headerHeight - 60;
    const height = Math.max(220, Math.min(width * 1.1, available));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private metrics(): WorldMetrics {
    return worldMetrics(
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.camX,
      isNight(new Date().getHours()),
    );
  }

  private update(delta: number): void {
    this.particles = updateParticles(this.particles, delta);
    if (this.bubble && this.elapsed > this.bubble.until) this.bubble = null;
    if (!this.pet) return;

    // パネルを開いている間は行動を切り替えない。
    // ミニゲーム中に勝手に寝てしまって気が抜けたため（プレイテストで判明）。
    const panelOpen = document.querySelector('.modal-backdrop') !== null;
    if (!panelOpen) {
      const result = updateAgenda(this.agenda, this.pet, this.elapsed, delta);
      this.agenda = result.state;
      if (result.changed) this.callbacks.onActionChanged?.(this.agenda.action);
      if (result.event) this.callbacks.onAgendaEvent?.(result.event);
    }

    // カメラ。手動で動かした直後は追尾しない。
    const m = this.metrics();
    if (this.elapsed > this.manualCamUntil && !this.drag) {
      const target = clampCam(m, this.agenda.x * m.worldW - m.viewW / 2);
      // 距離に比例して寄せる（急に飛ばない）。
      this.camX += (target - this.camX) * Math.min(1, delta / 420);
    }
    this.camX = clampCam(m, this.camX);

    // 行動に応じたパーティクルを間欠的に出す。
    const kind = PARTICLE_BY_ACTION[this.agenda.action];
    if (kind && this.elapsed - this.lastParticleAt > 900) {
      this.lastParticleAt = this.elapsed;
      this.particles.push(
        ...spawnParticles(kind, this.petWorld.x, this.petWorld.y - this.petBox.height * 0.75, 2),
      );
    }
  }

  private draw(): void {
    const m = this.metrics();
    drawWorld(this.ctx, m, this.layout);
    drawFurniture(this.ctx, m, this.layout);

    if (!this.pet) return;

    const depth = this.agenda.depth;
    const petHeight =
      m.viewH *
      (this.pet.stage === 'adult' ? 0.4 : this.pet.stage === 'child' ? 0.33 : 0.24) *
      depthScale(depth);
    const x = screenX(m, this.agenda.x);
    const baseY = depthY(m, depth);
    this.petBox = { x, y: baseY, width: petHeight * 0.86, height: petHeight };
    this.petWorld = { x: this.agenda.x * m.worldW, y: baseY };

    // 奥のスポット → ペット → 手前のスポットの順に描くと、
    // ペットが物の裏や前に回り込んで見える。
    drawSpots(this.ctx, m, this.elapsed, {
      petDepth: depth,
      activeSpotId: this.agenda.spotId,
      front: false,
    });

    drawShadow(this.ctx, x, baseY, petHeight);
    drawPet(this.ctx, {
      species: this.pet.species,
      stage: this.pet.stage,
      emotion: this.pet.emotion,
      action: this.agenda.action,
      time: this.elapsed,
      x,
      y: baseY,
      height: petHeight,
      facing: this.agenda.facing,
    });

    drawSpots(this.ctx, m, this.elapsed, {
      petDepth: depth,
      activeSpotId: this.agenda.spotId,
      front: true,
    });

    drawParticles(this.ctx, this.particles, m.camX);

    if (this.bubble) {
      drawBubble(this.ctx, this.bubble, x, baseY - petHeight, Math.min(300, m.viewW - 24));
    }

    drawMinimap(this.ctx, m, this.agenda.x, `${this.pet.name}は ${this.placeCaption()}`);
  }

  // --- 入力 ----------------------------------------------------------------

  private onPointerDown(event: PointerEvent): void {
    this.drag = { startX: event.clientX, startCam: this.camX, moved: false };
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag) return;
    const dx = event.clientX - this.drag.startX;
    if (Math.abs(dx) > 6) this.drag.moved = true;
    if (!this.drag.moved) return;
    this.camX = clampCam(this.metrics(), this.drag.startCam - dx);
    this.manualCamUntil = this.elapsed + MANUAL_CAM_MS;
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.moved) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit =
      Math.abs(x - this.petBox.x) < this.petBox.width * 0.8 &&
      y > this.petBox.y - this.petBox.height * 1.2 &&
      y < this.petBox.y + 12;
    if (!hit) return;
    this.particles.push(
      ...spawnParticles('heart', this.petWorld.x, this.petWorld.y - this.petBox.height * 0.8, 3),
    );
    this.callbacks.onPetTouched();
  }
}
