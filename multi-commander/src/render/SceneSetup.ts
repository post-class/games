import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  DirectionalLight,
  AmbientLight,
  Color,
  Fog,
  Vector2,
  PMREMGenerator,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  Object3D,
  Mesh,
  Points,
  Sprite,
  type Material,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  createStarfield,
  createStarfieldFar,
  createNebulae,
  createDistantPlanets,
} from "./SkyboxStars";
import { VignetteGradeShader } from "./shaders/VignetteGradeShader";

export interface RenderContext {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** ポストプロセス合成器。描画は composer.render() を通す。 */
  composer: EffectComposer;
  /** ブルーム段 (性能プリセットで強度/解像度を調整するため公開)。 */
  bloomPass: UnrealBloomPass;
  dispose(): void;
}

/** 背景オブジェクト(星空/星雲/惑星)の全マテリアルの fog を無効化する (遠景がfogで消えないように)。 */
function disableFog(root: Object3D): void {
  root.traverse((o) => {
    const mat = (o as Mesh | Points | Sprite).material as Material | Material[] | undefined;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach((m) => ((m as Material & { fog?: boolean }).fog = false));
    else (mat as Material & { fog?: boolean }).fog = false;
  });
}

/** Three.js のシーン・カメラ・レンダラー・ライト・ポストプロセス・星空背景を初期化する。 */
export function setupScene(container: HTMLElement): RenderContext {
  const scene = new Scene();
  scene.background = new Color(0x01030a);
  // fog は近〜中距離の機体の奥行き手掛かり。背景(星空/惑星)は disableFog で影響外にする。
  scene.fog = new Fog(0x02040c, 3500, 14000);

  const camera = new PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.5,
    60000,
  );
  camera.position.set(0, 5, 20);

  // ポストプロセスで AA するため MSAA(antialias) は切る。
  const renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // フィルミックなトーンマッピングで発光のハイライト破綻を抑え、階調を締める。
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = SRGBColorSpace;
  // ポストプロセス(複数パス)で info が最終パスに上書きされないよう自動リセットを切る。
  // Game.frame() が composer.render() 直前に手動 reset して1フレーム分を集計する。
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);

  // 環境マップ(IBL): 金属マテリアルに周囲反射を与えフラットさを解消 (起動時1回)。
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // ライティング: 主光源 + リムライト + 環境光。ACES 化に合わせやや強めに。
  const key = new DirectionalLight(0xffffff, 2.6);
  key.position.set(1, 1, 1);
  scene.add(key);
  const rim = new DirectionalLight(0x4466ff, 1.2);
  rim.position.set(-1, -0.3, -1);
  scene.add(rim);
  scene.add(new AmbientLight(0x223344, 0.9));

  // 星空背景 (2層パララックス + 星雲 + 遠景の惑星/太陽)。fog の影響外に置く。
  const stars = createStarfield(8000, 15000);
  const starsFar = createStarfieldFar(2500, 30000);
  const nebulae = createNebulae(4, 18000);
  const planets = createDistantPlanets();
  for (const bg of [stars, starsFar, nebulae, planets]) {
    disableFog(bg);
    scene.add(bg);
  }

  // --- ポストプロセス パイプライン ---
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new Vector2(window.innerWidth, window.innerHeight),
    0.5, // strength: 控えめにして発光体が巨大な塊にならないように
    0.4, // radius
    0.9, // threshold: 明るい発光体のみ滲ませ、通常マテリアルの白飛びを避ける
  );
  composer.addPass(bloomPass);

  const smaaPass = new SMAAPass(
    window.innerWidth * renderer.getPixelRatio(),
    window.innerHeight * renderer.getPixelRatio(),
  );
  composer.addPass(smaaPass);

  const gradePass = new ShaderPass(VignetteGradeShader);
  gradePass.renderToScreen = true;
  composer.addPass(gradePass);

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  return {
    scene,
    camera,
    renderer,
    composer,
    bloomPass,
    dispose() {
      window.removeEventListener("resize", onResize);
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
