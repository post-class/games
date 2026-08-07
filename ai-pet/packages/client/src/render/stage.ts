/**
 * Pixiの初期化とレイヤ構築（docs/02_ゲーム実装プラン/06_クライアント設計.md §2）
 */
import { Application, Container } from 'pixi.js';

export interface Layers {
  worldRoot: Container;
  ground: Container;
  decal: Container;
  /**
   * 接地影。アクターと設置物の足元の楕円をここにまとめて描く。
   * entities より下・decal より上に置くので、影が地面の装飾を隠しつつキャラには重ならない。
   */
  shadow: Container;
  /** objects/actors/overObj を統合し y座標でソートする層 */
  entities: Container;
  /**
   * 夜の光源（加算ブレンド）。entities より上に置き、
   * 時間帯オーバーレイ（overlayRoot の TimeTint）より下で光を足す。
   */
  light: Container;
  bubbles: Container;
  weather: Container;
  overlayRoot: Container;
}

export interface Stage {
  app: Application;
  layers: Layers;
  resize: () => void;
}

export async function createStage(host: HTMLElement): Promise<Stage> {
  const app = new Application();
  await app.init({
    background: '#cfe3a0',
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    resizeTo: host,
    preference: 'webgl',
  });
  host.appendChild(app.canvas);

  const worldRoot = new Container({ label: 'worldRoot', isRenderGroup: true });
  const ground = new Container({ label: 'ground' });
  const decal = new Container({ label: 'decal' });
  const shadow = new Container({ label: 'shadow' });
  const entities = new Container({ label: 'entities', sortableChildren: true });
  const light = new Container({ label: 'light' });
  const bubbles = new Container({ label: 'bubbles' });
  const weather = new Container({ label: 'weather' });
  const overlayRoot = new Container({ label: 'overlayRoot' });

  worldRoot.addChild(ground, decal, shadow, entities, light, bubbles, weather);
  app.stage.addChild(worldRoot, overlayRoot);

  const resize = (): void => {
    app.renderer.resize(host.clientWidth, host.clientHeight);
  };
  window.addEventListener('resize', resize);

  // 非アクティブタブでは描画を止める（スマホの発熱対策）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) app.ticker.stop();
    else app.ticker.start();
  });

  return {
    app,
    layers: { worldRoot, ground, decal, shadow, entities, light, bubbles, weather, overlayRoot },
    resize,
  };
}
