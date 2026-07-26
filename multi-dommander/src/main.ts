import { setupScene } from "./render/SceneSetup";
import { Game } from "./game/Game";
import { bootstrap } from "./game/bootstrap";

const container = document.getElementById("app");
if (!container) throw new Error("#app container not found");

const render = setupScene(container);
const game = new Game(render);

// システム・エンティティ・HUD などの初期化。
bootstrap(game, container);

game.start();

// デバッグ用にグローバル公開。
(window as unknown as { game: Game }).game = game;
