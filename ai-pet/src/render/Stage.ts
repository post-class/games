import type { PetAction } from '../../shared/actions.js';
import type { PetView, RoomLayout } from '../../shared/types.js';
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
import { drawFurniture, drawRoom, roomMetrics } from './RoomLayer.js';
import { forceAction, initialFsm, updateFsm, type FsmState } from '../sim/fsm.js';

/**
 * 2D ステージ。requestAnimationFrame で回し、
 * ペットは FSM に従って勝手に動く（指示待ちにしない）。
 */

export interface StageCallbacks {
  /** ペットが触られた（撫でた）。 */
  onPetTouched(): void;
  /** FSM が新しい行動を選んだ。LLM の思いつきを挟むタイミングの判断に使う。 */
  onActionChanged?(action: PetAction): void;
}

const PARTICLE_BY_ACTION: Partial<Record<PetAction, Particle['kind']>> = {
  eat: 'crumb',
  play: 'note',
  nap: 'zzz',
  nuzzle: 'heart',
  jump_joy: 'sparkle',
  wash: 'sparkle',
};

export class Stage {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private pet: PetView | null = null;
  private layout: RoomLayout = { wall: 'cream', floor: 'wood', furniture: [] };
  private fsm: FsmState = initialFsm(0);
  private particles: Particle[] = [];
  private bubble: Bubble | null = null;
  private lastFrame = 0;
  private elapsed = 0;
  private raf = 0;
  private lastParticleAt = 0;
  private petBox = { x: 0, y: 0, width: 0, height: 0 };

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

    this.canvas.addEventListener('pointerdown', (event) => this.handlePointer(event));
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
    this.fsm = forceAction(this.fsm, action, this.elapsed);
    const kind = PARTICLE_BY_ACTION[action];
    if (kind) {
      this.particles.push(
        ...spawnParticles(kind, this.petBox.x, this.petBox.y - this.petBox.height * 0.8, 5),
      );
    }
  }

  say(text: string, durationMs = 5200): void {
    this.bubble = { text, until: this.elapsed + durationMs, pending: false };
  }

  showPending(): void {
    this.bubble = { text: '', until: this.elapsed + 20_000, pending: true };
  }

  clearBubble(): void {
    this.bubble = null;
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

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const width = Math.max(280, rect?.width ?? 320);
    const height = Math.max(220, Math.min(width * 0.66, (rect?.height ?? 320)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private update(delta: number): void {
    this.particles = updateParticles(this.particles, delta);
    if (this.bubble && this.elapsed > this.bubble.until) this.bubble = null;
    if (!this.pet) return;

    const result = updateFsm(this.fsm, this.pet, this.elapsed, delta);
    this.fsm = result.state;
    if (result.changed) {
      this.callbacks.onActionChanged?.(this.fsm.action);
    }

    // 行動に応じたパーティクルを間欠的に出す。
    const kind = PARTICLE_BY_ACTION[this.fsm.action];
    if (kind && this.elapsed - this.lastParticleAt > 900) {
      this.lastParticleAt = this.elapsed;
      this.particles.push(
        ...spawnParticles(kind, this.petBox.x, this.petBox.y - this.petBox.height * 0.75, 2),
      );
    }
  }

  private draw(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const metrics = roomMetrics(width, height);

    drawRoom(this.ctx, this.layout, metrics);
    drawFurniture(this.ctx, this.layout, metrics);

    if (!this.pet) return;

    const petHeight =
      height * (this.pet.stage === 'adult' ? 0.62 : this.pet.stage === 'child' ? 0.52 : 0.34);
    const x = this.fsm.x * width;
    const baseY = height * 0.92;
    this.petBox = { x, y: baseY, width: petHeight * 0.86, height: petHeight };

    drawShadow(this.ctx, x, baseY, petHeight);
    drawPet(this.ctx, {
      species: this.pet.species,
      stage: this.pet.stage,
      emotion: this.pet.emotion,
      action: this.fsm.action,
      time: this.elapsed,
      x,
      y: baseY,
      height: petHeight,
      facing: this.fsm.facing,
    });

    drawParticles(this.ctx, this.particles);

    if (this.bubble) {
      drawBubble(this.ctx, this.bubble, x, baseY - petHeight, Math.min(300, width - 24));
    }
  }

  private handlePointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit =
      Math.abs(x - this.petBox.x) < this.petBox.width * 0.8 &&
      y > this.petBox.y - this.petBox.height * 1.2 &&
      y < this.petBox.y + 12;
    if (!hit) return;
    this.particles.push(
      ...spawnParticles('heart', this.petBox.x, this.petBox.y - this.petBox.height * 0.8, 3),
    );
    this.callbacks.onPetTouched();
  }
}
