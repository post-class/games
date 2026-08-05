import type { InputManager } from './input';
import type { World } from '../world/world';
import { forwardOf } from '../core/math';

export type ReplayCamera = 'cockpit' | 'chase' | 'tactical';

export interface ReplayShipFrame {
  id: number;
  label: string;
  faction: string;
  pos: [number, number, number];
  forward: [number, number, number];
  radius: number;
  hull: number;
  ace: boolean;
  player: boolean;
}

export interface ReplayFrame {
  time: number;
  input: { pitch: number; yaw: number; roll: number; throttle: number };
  ships: ReplayShipFrame[];
  marker?: string;
}

/** 直近30秒の固定ステップを保持する軽量リプレイ記録。 */
export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  private elapsed = 0;
  private readonly maxSeconds = 30;

  reset(): void {
    this.frames = [];
    this.elapsed = 0;
  }

  record(world: World, input: InputManager, dt: number): void {
    this.elapsed += Math.max(0, dt);
    const ships = world.entities
      .filter((e) => e.alive && e.kind === 'ship' && e.ship)
      .map((e) => ({
        id: e.id,
        label: e.label ?? e.ship!.pilot ?? e.ship!.def.name,
        faction: e.faction,
        pos: [Number(e.pos.x.toFixed(1)), Number(e.pos.y.toFixed(1)), Number(e.pos.z.toFixed(1))] as [number, number, number],
        forward: (() => {
          const f = forwardOf(e.quat);
          return [Number(f.x.toFixed(3)), Number(f.y.toFixed(3)), Number(f.z.toFixed(3))] as [number, number, number];
        })(),
        radius: e.radius,
        hull: e.ship!.hull,
        ace: !!e.ship!.ace,
        player: e.id === world.playerId,
      }));
    this.frames.push({
      time: this.elapsed,
      input: { pitch: input.pitch, yaw: input.yaw, roll: input.roll, throttle: input.throttle },
      ships,
    });
    const cutoff = this.elapsed - this.maxSeconds;
    while (this.frames.length > 1 && this.frames[0].time < cutoff) this.frames.shift();
  }

  mark(text: string): void {
    const last = this.frames[this.frames.length - 1];
    if (last) last.marker = text;
  }

  get length(): number {
    return this.frames.length;
  }

  get duration(): number {
    if (this.frames.length < 2) return this.frames[0]?.time ?? 0;
    return this.frames[this.frames.length - 1].time - this.frames[0].time;
  }

  frameAt(index: number): ReplayFrame | undefined {
    if (!this.frames.length) return undefined;
    return this.frames[Math.max(0, Math.min(this.frames.length - 1, Math.floor(index)))];
  }

  /** 経過時間を指定して再生用フレームを取得する。時間はバッファ先頭からの秒。 */
  frameAtTime(seconds: number): ReplayFrame | undefined {
    if (!this.frames.length) return undefined;
    const first = this.frames[0].time;
    const absolute = first + Math.max(0, Math.min(this.duration, seconds));
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.frames[mid].time < absolute) lo = mid;
      else hi = mid - 1;
    }
    const next = Math.min(this.frames.length - 1, lo + 1);
    return Math.abs(this.frames[next].time - absolute) < Math.abs(this.frames[lo].time - absolute)
      ? this.frames[next]
      : this.frames[lo];
  }

  /** UI がバッファを走査するための読み取り専用スナップショット。 */
  snapshot(): ReplayFrame[] {
    return this.frames.slice();
  }

  recentMarkers(): string[] {
    return this.frames.filter((f) => !!f.marker).map((f) => `${f.time.toFixed(1)}s　${f.marker}`);
  }
}

/**
 * 直近30秒の戦闘を見返すための軽量タクティカルビュー。
 * Three.js のワールドを再構築せず、固定ステップのスナップショットを
 * 3つの視点（コクピット／追尾／戦術）で描画する。ゲーム本体の状態は変更しない。
 */
export class ReplayPanel {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly slider: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly viewButton: HTMLButtonElement;
  private readonly buffer: ReplayBuffer;
  private readonly markers: HTMLElement;
  private frameSeconds = 0;
  private playing = true;
  private speed = 1;
  private view: ReplayCamera = 'cockpit';
  private lastNow = performance.now();
  private raf = 0;
  private disposed = false;

  constructor(buffer: ReplayBuffer) {
    this.buffer = buffer;
    this.el = document.createElement('div');
    this.el.className = 'mc-replay';

    const header = document.createElement('div');
    header.className = 'mc-replay-head';
    const title = document.createElement('strong');
    title.textContent = '直近30秒 — 戦闘リプレイ';
    header.appendChild(title);
    this.timeLabel = document.createElement('span');
    this.timeLabel.className = 'mc-replay-time';
    header.appendChild(this.timeLabel);
    this.el.appendChild(header);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mc-replay-canvas';
    this.canvas.setAttribute('aria-label', '戦闘リプレイ画面');
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('リプレイ描画コンテキストを作成できません');
    this.ctx = context;
    this.el.appendChild(this.canvas);

    const controls = document.createElement('div');
    controls.className = 'mc-replay-controls';
    this.playButton = this.button('再生中', () => {
      this.playing = !this.playing;
      this.playButton.textContent = this.playing ? '一時停止' : '再生';
    });
    controls.appendChild(this.playButton);
    const speedButton = this.button('速度 1x', () => {
      this.speed = this.speed >= 2 ? 0.5 : this.speed + 0.5;
      speedButton.textContent = `速度 ${this.speed}x`;
    });
    controls.appendChild(speedButton);
    this.viewButton = this.button('視点: コクピット', () => {
      this.view = this.view === 'cockpit' ? 'chase' : this.view === 'chase' ? 'tactical' : 'cockpit';
      this.viewButton.textContent = `視点: ${cameraLabel(this.view)}`;
    });
    controls.appendChild(this.viewButton);
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = String(Math.max(0.01, buffer.duration));
    this.slider.step = '0.05';
    this.slider.value = '0';
    this.slider.className = 'mc-replay-slider';
    this.slider.addEventListener('input', () => {
      this.frameSeconds = Number(this.slider.value);
      this.playing = false;
      this.playButton.textContent = '再生';
      this.render();
    });
    controls.appendChild(this.slider);
    this.el.appendChild(controls);

    this.markers = document.createElement('div');
    this.markers.className = 'mc-replay-markers';
    const markerText = buffer.recentMarkers();
    this.markers.textContent = markerText.length ? `記録: ${markerText.join(' / ')}` : '記録された決定的な瞬間はありません。';
    this.el.appendChild(this.markers);

    this.render();
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (now: number): void => {
    if (this.disposed || !this.el.isConnected) {
      this.dispose();
      return;
    }
    const realDt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (this.playing && this.buffer.duration > 0) {
      this.frameSeconds += realDt * this.speed;
      if (this.frameSeconds > this.buffer.duration) this.frameSeconds = 0;
      this.slider.value = String(this.frameSeconds);
    }
    this.render();
    this.raf = requestAnimationFrame(this.tick);
  };

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  private render(): void {
    const frame = this.buffer.frameAtTime(this.frameSeconds);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(320, this.canvas.clientWidth || 800);
    const height = Math.max(180, this.canvas.clientHeight || 420);
    if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) {
      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.fillStyle = '#03080d';
    this.ctx.fillRect(0, 0, width, height);
    if (!frame) {
      this.ctx.fillStyle = '#8fbfa8';
      this.ctx.fillText('リプレイデータなし', 24, 32);
      return;
    }
    const player = frame.ships.find((s) => s.player) ?? frame.ships[0];
    if (!player) return;
    this.drawStars(width, height, frame.time);
    for (const ship of frame.ships) {
      const point = this.project(ship, player, width, height);
      if (!point) continue;
      this.drawShip(ship, point.x, point.y, point.scale);
    }
    this.timeLabel.textContent = `${frame.time.toFixed(1)}s　${this.view === 'tactical' ? '上面戦術図' : this.view === 'chase' ? '追尾視点' : 'コクピット視点'}`;
    const marker = frame.marker;
    if (marker) {
      this.ctx.fillStyle = '#ffd75e';
      this.ctx.font = 'bold 13px monospace';
      this.ctx.fillText(`★ ${marker}`, 18, height - 18);
    }
  }

  private drawStars(width: number, height: number, time: number): void {
    this.ctx.fillStyle = 'rgba(127, 227, 176, 0.5)';
    for (let i = 0; i < 44; i++) {
      const x = (i * 83 + Math.floor(time * (i % 3 + 1) * 4)) % width;
      const y = (i * 47 + 19) % height;
      this.ctx.fillRect(x, y, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
    }
  }

  private project(ship: ReplayShipFrame, player: ReplayShipFrame, width: number, height: number): { x: number; y: number; scale: number } | undefined {
    if (this.view === 'tactical') {
      const dx = ship.pos[0] - player.pos[0];
      const dz = ship.pos[2] - player.pos[2];
      const range = 4200;
      return { x: width / 2 + (dx / range) * width * 0.45, y: height / 2 + (dz / range) * height * 0.45, scale: 1 };
    }
    const f = player.forward;
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    const forward: [number, number, number] = [f[0] / fl, f[1] / fl, f[2] / fl];
    let right: [number, number, number] = [forward[2], 0, -forward[0]];
    const rl = Math.hypot(right[0], right[2]);
    if (rl < 0.01) right = [1, 0, 0];
    else right = [right[0] / rl, 0, right[2] / rl];
    const up: [number, number, number] = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    const cameraOffset = this.view === 'chase' ? 700 : 0;
    const rel = [
      ship.pos[0] - player.pos[0] + forward[0] * cameraOffset,
      ship.pos[1] - player.pos[1] + forward[1] * cameraOffset,
      ship.pos[2] - player.pos[2] + forward[2] * cameraOffset,
    ];
    const depth = rel[0] * forward[0] + rel[1] * forward[1] + rel[2] * forward[2] + (this.view === 'chase' ? 900 : 700);
    if (depth < 30) return undefined;
    const x = rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2];
    const y = rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2];
    const scale = Math.min(7, Math.max(0.45, 680 / depth));
    return { x: width / 2 + x * scale * 0.7, y: height / 2 - y * scale * 0.7, scale };
  }

  private drawShip(ship: ReplayShipFrame, x: number, y: number, scale: number): void {
    if (x < -40 || x > this.canvas.clientWidth + 40 || y < -40 || y > this.canvas.clientHeight + 40) return;
    const color = ship.player ? '#7fe3b0' : ship.ace ? '#ffd75e' : ship.faction === 'kilrathi' ? '#ff716b' : '#5fd8ff';
    const size = Math.max(3, Math.min(18, 4 + ship.radius * 0.035 * scale));
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = ship.player ? 2 : 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, -size);
    this.ctx.lineTo(size * 0.72, size);
    this.ctx.lineTo(0, size * 0.45);
    this.ctx.lineTo(-size * 0.72, size);
    this.ctx.closePath();
    ship.player ? this.ctx.stroke() : this.ctx.fill();
    this.ctx.font = '10px monospace';
    this.ctx.fillText(ship.label, size + 4, 3);
    this.ctx.restore();
  }
}

function cameraLabel(camera: ReplayCamera): string {
  return camera === 'cockpit' ? 'コクピット' : camera === 'chase' ? '追尾' : '戦術';
}
