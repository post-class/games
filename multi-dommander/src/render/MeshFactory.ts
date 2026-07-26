import {
  Group,
  Mesh,
  MeshStandardMaterial,
  ConeGeometry,
  BoxGeometry,
  CylinderGeometry,
  TorusGeometry,
  Object3D,
  Vector3,
  SphereGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ShipDefinition } from "../game/ships/ShipDefinition";

/** GLTF ローダとモデルキャッシュ (同一URLの多重ロードを防ぐ)。 */
const gltfLoader = new GLTFLoader();
const gltfCache = new Map<string, Object3D>();

/**
 * ShipDefinition から機体メッシュを生成する。機首は +z 方向。
 * - kind: "primitive" → プログラマアートを同期生成 (既定)。
 * - kind: "gltf" → 空の Group を即返しつつ非同期ロードし、完了時に差し替える
 *   (ロード失敗時はプリミティブ相当のフォールバックを表示)。
 * これによりアセットを用意すれば ShipDefinition の visual を差し替えるだけで移行できる。
 */
export function createShipMesh(def: ShipDefinition): Object3D {
  const v = def.visual;
  if (v.kind === "gltf") {
    return createGltfShipMesh(def);
  }
  const p = v.primitive!;
  const [w, h, l] = p.scale;
  const group = new Group();
  group.name = `ship:${def.id}`;

  const body = new MeshStandardMaterial({
    color: p.bodyColor,
    metalness: 0.6,
    roughness: 0.45,
    flatShading: true,
  });
  const accent = new MeshStandardMaterial({
    color: p.accentColor,
    metalness: 0.4,
    roughness: 0.3,
    emissive: p.accentColor,
    emissiveIntensity: 0.25,
    flatShading: true,
  });

  if (p.shape === "interceptor") {
    // 細長い紡錘形の胴体 + 翼。
    const hull = new Mesh(new ConeGeometry(h * 0.6, l, 6), body);
    hull.rotation.x = Math.PI / 2; // 円錐の先端を +z に。
    hull.scale.set(1, 1, 1);
    group.add(hull);
    const wing = new Mesh(new BoxGeometry(w, h * 0.3, l * 0.4), accent);
    wing.position.z = -l * 0.1;
    group.add(wing);
  } else if (p.shape === "wedge") {
    // 平たいデルタ翼 (Kilrathi Dralthi 風)。
    const hull = new Mesh(new ConeGeometry(w * 0.5, l, 3), body);
    hull.rotation.x = Math.PI / 2;
    hull.rotation.z = Math.PI;
    group.add(hull);
    const cockpit = new Mesh(new SphereGeometry(h * 0.6, 8, 6), accent);
    cockpit.position.z = l * 0.1;
    group.add(cockpit);
  } else {
    // heavy: 箱型の重戦闘機。
    const hull = new Mesh(new BoxGeometry(w, h, l), body);
    group.add(hull);
    const nose = new Mesh(new ConeGeometry(h * 0.5, l * 0.4, 4), accent);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = l * 0.6;
    group.add(nose);
  }

  // エンジングロー (機体後方の発光球)。
  const glowMat = new MeshBasicMaterial({
    color: p.engineGlow,
    transparent: true,
    opacity: 0.9,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const glow = new Mesh(new SphereGeometry(h * 0.5, 8, 8), glowMat);
  glow.position.z = -l * 0.55;
  glow.scale.set(1, 1, 1.6);
  glow.name = "engineGlow";
  group.add(glow);

  return group;
}

/** 弾(曳光弾)用の小さな発光メッシュ。 */
export function createProjectileMesh(color: number): Object3D {
  const mat = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new Mesh(new SphereGeometry(1, 6, 6), mat);
  mesh.scale.set(1.2, 1.2, 6); // 弾を進行方向(+z)に伸ばす。
  return mesh;
}

/** GLTF モデルで機体を生成 (非同期ロード + フォールバック)。 */
function createGltfShipMesh(def: ShipDefinition): Object3D {
  const group = new Group();
  group.name = `ship:${def.id}`;
  const url = def.visual.gltf?.url;
  if (!url) {
    group.add(buildFallbackMesh());
    return group;
  }

  const cached = gltfCache.get(url);
  if (cached) {
    group.add(cached.clone(true));
    return group;
  }

  gltfLoader.load(
    url,
    (gltf) => {
      const model = gltf.scene;
      gltfCache.set(url, model);
      group.add(model.clone(true));
    },
    undefined,
    () => {
      // ロード失敗時は簡易フォールバックを表示 (ゲーム進行を止めない)。
      group.add(buildFallbackMesh());
    },
  );
  return group;
}

/** GLTF ロード前/失敗時の簡易フォールバック形状。 */
function buildFallbackMesh(): Object3D {
  const mesh = new Mesh(
    new ConeGeometry(4, 12, 6),
    new MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.5, roughness: 0.5, flatShading: true }),
  );
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/** ナビポイント用のリングマーカー (2重トーラス)。 */
export function createNavMarker(radius: number): Object3D {
  const group = new Group();
  const mat = new MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.5,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  for (let i = 0; i < 2; i++) {
    const ring = new Mesh(new TorusGeometry(radius, radius * 0.03, 6, 32), mat);
    ring.rotation.x = i === 0 ? 0 : Math.PI / 2;
    group.add(ring);
  }
  group.name = "navMarker";
  group.frustumCulled = false;
  return group;
}

/** ミサイル用メッシュ。 */
export function createMissileMesh(): Object3D {
  const group = new Group();
  const body = new Mesh(
    new CylinderGeometry(0.6, 0.6, 5, 6),
    new MeshStandardMaterial({ color: 0xdddddd, metalness: 0.5, roughness: 0.5 }),
  );
  body.rotation.x = Math.PI / 2;
  group.add(body);
  const flame = new Mesh(
    new SphereGeometry(0.8, 6, 6),
    new MeshBasicMaterial({ color: 0xffaa33, blending: AdditiveBlending, depthWrite: false }),
  );
  flame.position.z = -3;
  group.add(flame);
  return group;
}

const _tmp = new Vector3();
export { _tmp as tmpMeshVec };
