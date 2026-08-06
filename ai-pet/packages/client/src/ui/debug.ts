/** `?debug=1` のときだけ読み込まれる開発用パネル（fps / entity数 / チャンク数 / RTT） */
import type { Application } from 'pixi.js';

export interface DebugReadout {
  rttMs: number;
  state: string;
  tick: number;
  /** 保持しているアクター数 */
  actors?: number;
  /** 実際に描いたアクター数（culling後） */
  drawn?: number;
  /** 焼成済みチャンク数 */
  chunks?: number;
  zoom?: number;
  /** 自機の位置（E2Eテストが移動を検証するために使う） */
  pos?: { x: number; y: number };
}

export function attachDebugPanel(app: Application, read: () => DebugReadout): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:50;background:rgba(0,0,0,.7);color:#fff;' +
    'font:11px/1.5 ui-monospace,monospace;padding:6px 10px;border-radius:8px;white-space:pre;pointer-events:none';
  el.dataset['testid'] = 'debug-panel';
  document.body.appendChild(el);

  let frames = 0;
  let last = performance.now();
  let fps = 0;

  app.ticker.add(() => {
    frames++;
    const now = performance.now();
    if (now - last >= 500) {
      fps = Math.round((frames * 1000) / (now - last));
      frames = 0;
      last = now;
      const s = read();
      el.textContent = [
        `fps    ${fps}`,
        `render ${app.renderer.type}`,
        `net    ${s.state} ${s.rttMs}ms`,
        `tick   ${s.tick}`,
        `actors ${s.actors ?? 0} (draw ${s.drawn ?? 0})`,
        `chunks ${s.chunks ?? 0}`,
        `zoom   ${(s.zoom ?? 1).toFixed(2)}`,
        `pos    ${(s.pos?.x ?? 0).toFixed(2)},${(s.pos?.y ?? 0).toFixed(2)}`,
      ].join('\n');
    }
  });
}
