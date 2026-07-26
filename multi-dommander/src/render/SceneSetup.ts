import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  DirectionalLight,
  AmbientLight,
  Color,
  Fog,
} from "three";
import { createStarfield } from "./SkyboxStars";

export interface RenderContext {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  dispose(): void;
}

/** Three.js のシーン・カメラ・レンダラー・ライト・星空背景を初期化する。 */
export function setupScene(container: HTMLElement): RenderContext {
  const scene = new Scene();
  scene.background = new Color(0x01030a);
  scene.fog = new Fog(0x01030a, 4000, 12000);

  const camera = new PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.5,
    30000,
  );
  camera.position.set(0, 5, 20);

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  // ライティング: 主光源 + 環境光 + 補助光。
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1, 1);
  scene.add(key);
  const rim = new DirectionalLight(0x4466ff, 1.0);
  rim.position.set(-1, -0.3, -1);
  scene.add(rim);
  scene.add(new AmbientLight(0x223344, 1.0));

  // 星空背景。
  const stars = createStarfield(8000, 15000);
  scene.add(stars);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);

  return {
    scene,
    camera,
    renderer,
    dispose() {
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
