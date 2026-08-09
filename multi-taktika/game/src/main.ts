/**
 * エントリポイント。画面遷移のルート。
 *
 * 現状は M0 の疎通確認のみ。M5 以降で render/ui に差し替える。
 */

const boot = document.getElementById('boot');
const canvas = document.getElementById('field') as HTMLCanvasElement | null;

function resize(): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}

function main(): void {
  resize();
  window.addEventListener('resize', resize);
  if (boot) {
    const msg = boot.querySelector('.msg');
    if (msg) msg.textContent = 'M0: 基盤のみ。シミュレーションは未接続。';
  }
}

main();
