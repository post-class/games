import { App } from './app/App.js';

const host = document.querySelector<HTMLElement>('#app');
if (!host) throw new Error('#app が見つかりません');

const app = new App(host);
void app.start();
