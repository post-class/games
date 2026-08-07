/**
 * ミニマップ（docs/02_ゲーム実装プラン/06_クライアント設計.md §2, §5）
 *
 * 128×128タイルの島は画面に収まらないので、全体像と自分の位置を出す。
 * DOMではなく `<canvas>` に直接描く（1万6千タイルをDOMで持つのは無理がある）。
 *
 * 描き方:
 * - 地形は**受信済みチャンクだけ**を1タイル=1pxで塗る。まだ来ていない所は空けておく
 *   （「行っていない場所は白い」ほうが、島を歩いて開いていく感じに合う）
 * - 地形は変化が少ないので、チャンクが増えたときだけ塗り直す
 * - 点（自分・ペット・他プレイヤー）は毎フレーム動くので、地形を焼いたcanvasを
 *   下敷きにして、その上に点だけ描き直す
 * - 折りたためる（スマホでは画面が狭いので、既定で閉じる）
 */
import { CHUNK, CHUNKS_X, CHUNKS_Y, MAP_H, MAP_W, TERRAINS } from '@ai-pet/shared';
import type { WorldState } from '../state/world.ts';

const OPEN_KEY = 'pokomofu.minimap.open';

/** 地形の色（宣伝資料のパレットに寄せた縮小表示用の色） */
const TERRAIN_COLOR: Record<string, string> = {
  grass: '#bcd98c',
  dirt: '#d8bd8e',
  sand: '#f0dfae',
  water: '#8fc9e0',
  forest: '#8fbb6b',
  plaza: '#f4e6c4',
};

/** 点の色 */
const DOT_SELF = '#ff8f6b';
const DOT_PET = '#ffffff';
const DOT_OTHER = '#a99bff';

export class Minimap {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  /** 地形だけを焼いた下敷き */
  private base: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D | null;
  /** 焼いた時点のチャンク数。増えたら焼き直す */
  private bakedChunks = -1;
  private open: boolean;

  constructor() {
    // スマホは画面が狭いので既定で閉じる。一度開いたら次回も開く
    const saved = localStorage.getItem(OPEN_KEY);
    this.open = saved === null ? !window.matchMedia('(pointer: coarse)').matches : saved === '1';

    this.root = document.createElement('div');
    this.root.className = 'minimap' + (this.open ? '' : ' closed');
    this.root.dataset['testid'] = 'minimap';
    this.root.innerHTML = `
      <button type="button" class="minimap-toggle" data-testid="minimap-toggle"
              aria-label="ミニマップの開閉">島</button>
      <canvas width="${MAP_W}" height="${MAP_H}" data-testid="minimap-canvas"></canvas>
    `;
    document.body.appendChild(this.root);

    this.canvas = this.root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.base.width = MAP_W;
    this.base.height = MAP_H;
    this.baseCtx = this.base.getContext('2d');

    const toggle = this.root.querySelector('.minimap-toggle') as HTMLElement;
    toggle.addEventListener('click', () => this.toggle());
    this.reflect();
  }

  private toggle(): void {
    this.open = !this.open;
    localStorage.setItem(OPEN_KEY, this.open ? '1' : '0');
    this.reflect();
  }

  /**
   * 開閉状態を見た目に反映する。
   * ペット情報パネルも右上に出るので、開いているあいだは下へ避けてもらう
   * （CSS側で `body.minimap-open` を見ている）。
   */
  private reflect(): void {
    this.root.classList.toggle('closed', !this.open);
    document.body.classList.toggle('minimap-open', this.open);
  }

  /** 毎フレーム呼ぶ。閉じているときは何もしない */
  update(world: WorldState): void {
    if (!this.open || !this.ctx) return;

    if (world.loadedChunks.size !== this.bakedChunks) this.bake(world);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, MAP_W, MAP_H);
    ctx.drawImage(this.base, 0, 0);

    // 他プレイヤー → ペット → 自分 の順に描く（自分がいちばん上に来るように）
    for (const a of world.actors.values()) {
      if (a.kind !== 'player' || a.id === world.selfId) continue;
      this.dot(a.x, a.y, DOT_OTHER, 2);
    }
    for (const a of world.actors.values()) {
      if (a.kind !== 'pet') continue;
      this.dot(a.x, a.y, DOT_PET, a.id === world.petId ? 2.5 : 1.5);
    }
    const self = world.selfId === null ? null : world.actors.get(world.selfId);
    if (self) this.dot(self.x, self.y, DOT_SELF, 3);
  }

  private dot(x: number, y: number, color: string, r: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // 小さい点は背景に溶けるので、細い縁を付ける
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(74,59,42,.55)';
    ctx.stroke();
  }

  /** 受信済みチャンクの地形を下敷きに焼く */
  private bake(world: WorldState): void {
    const ctx = this.baseCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, MAP_W, MAP_H);

    for (let cy = 0; cy < CHUNKS_Y; cy++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        if (!world.hasChunk(cx, cy)) continue;
        const x0 = cx * CHUNK;
        const y0 = cy * CHUNK;
        for (let ty = 0; ty < CHUNK; ty++) {
          for (let tx = 0; tx < CHUNK; tx++) {
            const t = world.terrainAt(x0 + tx, y0 + ty);
            if (t < 0) continue;
            const name = TERRAINS[t];
            ctx.fillStyle = (name && TERRAIN_COLOR[name]) || '#d9d2c4';
            ctx.fillRect(x0 + tx, y0 + ty, 1, 1);
          }
        }
      }
    }
    this.bakedChunks = world.loadedChunks.size;
  }

  /** 地形が変わったとき（橋の完成など）に焼き直させる */
  invalidate(): void {
    this.bakedChunks = -1;
  }

  get isOpen(): boolean {
    return this.open;
  }
}
