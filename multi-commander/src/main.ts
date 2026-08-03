import './styles/base.css';
import './styles/cockpit.css';
import './styles/ui.css';
import { App } from './app/App';
import { loadSettings } from './app/settings';

function boot(): void {
  loadSettings();

  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  const overlay = document.getElementById('overlay') as HTMLElement | null;
  if (!canvas || !overlay) throw new Error('canvas / overlay が見つかりません');

  const app = new App(canvas, overlay);
  app.start();

  // デバッグ用にグローバル公開 (Playwright からの確認に使う)
  (window as unknown as Record<string, unknown>).__mc = app;
}

boot();
