import './styles/base.css';
import './styles/cockpit.css';
import './styles/ui.css';
import { App } from './app/App';
import { loadSettings } from './app/settings';

let fatalShown = false;

function showFatal(reason: unknown): void {
  if (fatalShown) return;
  fatalShown = true;
  const overlay = document.getElementById('overlay');
  if (!overlay) return;
  overlay.classList.add('interactive');
  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;inset:12%;padding:32px;background:#071015;color:#cdefdd;border:1px solid #ff5d5d;font:16px monospace;z-index:9999;white-space:pre-wrap';
  panel.textContent = 'MULTI-COMMANDER は安全に停止しました。\n\n' +
    '保存データは変更されていません。ページを再読み込みしてください。\n\n' +
    (reason instanceof Error ? reason.message : String(reason));
  overlay.appendChild(panel);
}

function boot(): void {
  try {
    loadSettings();
    const canvas = document.getElementById('view') as HTMLCanvasElement | null;
    const overlay = document.getElementById('overlay') as HTMLElement | null;
    if (!canvas || !overlay) throw new Error('canvas / overlay が見つかりません');
    const app = new App(canvas, overlay);
    app.start();
    // デバッグ用にグローバル公開 (Playwright からの確認に使う)
    (window as unknown as Record<string, unknown>).__mc = app;
  } catch (error) {
    showFatal(error);
  }
}

window.addEventListener('error', (event) => showFatal(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showFatal(event.reason));
boot();
