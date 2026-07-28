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
    // scene.environment (PMREM) の反射強度。金属パネルの質感を出す。
    envMapIntensity: 0.9,
  });
  const accent = new MeshStandardMaterial({
    color: p.accentColor,
    metalness: 0.4,
    roughness: 0.3,
    emissive: p.accentColor,
    emissiveIntensity: 0.25,
    flatShading: true,
    envMapIntensity: 0.9,
  });

  if (p.shape === "interceptor") {
    // 細長い紡錘形の胴体 + 翼 (Rapier 風の鋭角戦闘機)。
    // 主胴体: 細長い円錐形。
    const hull = new Mesh(new CylinderGeometry(h * 0.4, h * 0.5, l * 0.6, 6), body);
    hull.rotation.x = Math.PI / 2;
    hull.position.z = -l * 0.05;
    group.add(hull);

    // 機首: 鋭く尖った円錐。
    const nose = new Mesh(new ConeGeometry(h * 0.4, l * 0.4, 6), body);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = l * 0.45;
    group.add(nose);

    // キャノピー: 中央上部のコックピット窓 (発光アクセント)。
    const canopy = new Mesh(new SphereGeometry(h * 0.35, 6, 6), accent);
    canopy.scale.set(0.8, 1.2, 1.4);
    canopy.position.set(0, h * 0.3, l * 0.15);
    group.add(canopy);

    // 主翼: 後退翼 (左右対称)。
    const wingL = new Mesh(new BoxGeometry(w * 0.35, h * 0.12, l * 0.4), body);
    wingL.position.set(-w * 0.35, -h * 0.15, -l * 0.05);
    wingL.rotation.z = -0.1;
    group.add(wingL);
    const wingR = wingL.clone();
    wingR.position.x = w * 0.35;
    wingR.rotation.z = 0.1;
    group.add(wingR);

    // 翼端アクセント (小さなエルロン/翼端灯)。
    const wingTipL = new Mesh(new BoxGeometry(w * 0.08, h * 0.06, l * 0.15), accent);
    wingTipL.position.set(-w * 0.47, -h * 0.15, -l * 0.05);
    group.add(wingTipL);
    const wingTipR = wingTipL.clone();
    wingTipR.position.x = w * 0.47;
    group.add(wingTipR);

    // エンジンナセル (双発)。
    const nacelleL = new Mesh(new CylinderGeometry(h * 0.25, h * 0.3, l * 0.35, 6), body);
    nacelleL.rotation.x = Math.PI / 2;
    nacelleL.position.set(-w * 0.25, -h * 0.1, -l * 0.25);
    group.add(nacelleL);
    const nacelleR = nacelleL.clone();
    nacelleR.position.x = w * 0.25;
    group.add(nacelleR);

    // ナセルの発光排気口 (双発エンジングローに置き換え)。
    const glowMat = new MeshBasicMaterial({
      color: p.engineGlow,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const glowL = new Mesh(new SphereGeometry(h * 0.28, 8, 8), glowMat);
    glowL.position.set(-w * 0.25, -h * 0.1, -l * 0.45);
    glowL.scale.set(1, 1, 1.5);
    glowL.name = "engineGlow";
    group.add(glowL);
    const glowR = glowL.clone();
    glowR.position.x = w * 0.25;
    glowR.name = "engineGlow";
    group.add(glowR);

    // 胴体ディテール: 上部装甲パネル (グリーブル)。
    const panel = new Mesh(new BoxGeometry(w * 0.12, h * 0.08, l * 0.25), body);
    panel.position.set(0, h * 0.4, -l * 0.15);
    group.add(panel);
    return group;
  } else if (p.shape === "wedge") {
    // 平たいデルタ翼 (Kilrathi Dralthi 風の円盤型戦闘機)。
    // 主胴体: 平たい三角錐 (上面を潰した形)。
    const hull = new Mesh(new ConeGeometry(w * 0.45, l * 0.7, 3), body);
    hull.rotation.x = Math.PI / 2;
    hull.rotation.z = Math.PI;
    hull.scale.set(1, 0.5, 1);
    hull.position.z = -l * 0.05;
    group.add(hull);

    // 中央コックピット: 球状の発光キャノピー。
    const cockpit = new Mesh(new SphereGeometry(h * 0.7, 8, 6), accent);
    cockpit.scale.set(1, 0.8, 1.2);
    cockpit.position.set(0, h * 0.1, l * 0.15);
    group.add(cockpit);

    // 機首: 小さな尖った装甲。
    const nose = new Mesh(new ConeGeometry(h * 0.3, l * 0.25, 4), body);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = l * 0.42;
    group.add(nose);

    // 左右の広い翼 (デルタ翼の張り出し部)。
    const wingL = new Mesh(new BoxGeometry(w * 0.3, h * 0.15, l * 0.5), body);
    wingL.position.set(-w * 0.38, 0, -l * 0.08);
    wingL.rotation.z = -0.08;
    group.add(wingL);
    const wingR = wingL.clone();
    wingR.position.x = w * 0.38;
    wingR.rotation.z = 0.08;
    group.add(wingR);

    // 翼端武器マウント (小さなアクセント)。
    const mountL = new Mesh(new BoxGeometry(w * 0.06, h * 0.2, l * 0.12), accent);
    mountL.position.set(-w * 0.52, 0, 0);
    group.add(mountL);
    const mountR = mountL.clone();
    mountR.position.x = w * 0.52;
    group.add(mountR);

    // 後部エンジン (中央単発)。
    const engine = new Mesh(new CylinderGeometry(h * 0.35, h * 0.4, l * 0.3, 6), body);
    engine.rotation.x = Math.PI / 2;
    engine.position.z = -l * 0.3;
    group.add(engine);

    // 胴体側面ディテール (装甲グリーブル 左右2個)。
    const detailL = new Mesh(new BoxGeometry(w * 0.08, h * 0.1, l * 0.2), body);
    detailL.position.set(-w * 0.15, -h * 0.25, l * 0.05);
    group.add(detailL);
    const detailR = detailL.clone();
    detailR.position.x = w * 0.15;
    group.add(detailR);

    // エンジングロー (中央単発なので1個のみ維持)。
    const glowMat = new MeshBasicMaterial({
      color: p.engineGlow,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const glow = new Mesh(new SphereGeometry(h * 0.42, 8, 8), glowMat);
    glow.position.z = -l * 0.48;
    glow.scale.set(1, 1, 1.5);
    glow.name = "engineGlow";
    group.add(glow);
    return group;
  } else {
    // heavy: 箱型の重戦闘機 (Gratha 風) と大型輸送艦 (Transport)。
    // 主胴体: 角張った太い箱。
    const hull = new Mesh(new BoxGeometry(w * 0.7, h * 0.8, l * 0.6), body);
    hull.position.z = -l * 0.05;
    group.add(hull);

    // 機首装甲: 段差のある前方ブロック。
    const noseFront = new Mesh(new BoxGeometry(w * 0.5, h * 0.6, l * 0.25), body);
    noseFront.position.z = l * 0.38;
    group.add(noseFront);
    const noseTip = new Mesh(new ConeGeometry(h * 0.4, l * 0.2, 4), accent);
    noseTip.rotation.x = Math.PI / 2;
    noseTip.position.z = l * 0.55;
    group.add(noseTip);

    // コックピット: 上部中央の小窓 (発光)。
    const canopy = new Mesh(new BoxGeometry(w * 0.2, h * 0.15, l * 0.18), accent);
    canopy.position.set(0, h * 0.45, l * 0.12);
    group.add(canopy);

    // 側面装甲パネル (左右対称のディテール)。
    const panelL = new Mesh(new BoxGeometry(w * 0.08, h * 0.5, l * 0.4), body);
    panelL.position.set(-w * 0.39, 0, -l * 0.05);
    group.add(panelL);
    const panelR = panelL.clone();
    panelR.position.x = w * 0.39;
    group.add(panelR);

    // エンジンナセル (双発・大型)。
    const nacelleL = new Mesh(new CylinderGeometry(h * 0.35, h * 0.4, l * 0.4, 6), body);
    nacelleL.rotation.x = Math.PI / 2;
    nacelleL.position.set(-w * 0.3, -h * 0.15, -l * 0.25);
    group.add(nacelleL);
    const nacelleR = nacelleL.clone();
    nacelleR.position.x = w * 0.3;
    group.add(nacelleR);

    // 上部装甲ブロック (重戦闘機らしいディテール)。
    const topArmor = new Mesh(new BoxGeometry(w * 0.3, h * 0.12, l * 0.3), body);
    topArmor.position.set(0, h * 0.46, -l * 0.15);
    group.add(topArmor);

    // 後部カーゴベイ or 装甲ブロック (Transport向けに大きめ)。
    if (w > 15) {
      // Transport (scale [16,12,48]) の場合は大型コンテナブロックを追加。
      const cargo1 = new Mesh(new BoxGeometry(w * 0.6, h * 0.7, l * 0.25), body);
      cargo1.position.z = -l * 0.3;
      group.add(cargo1);
      const cargo2 = new Mesh(new BoxGeometry(w * 0.5, h * 0.6, l * 0.15), body);
      cargo2.position.z = -l * 0.48;
      group.add(cargo2);
      // 輸送艦の側面コンテナ (左右)。
      const containerL = new Mesh(new BoxGeometry(w * 0.12, h * 0.4, l * 0.2), accent);
      containerL.position.set(-w * 0.41, 0, -l * 0.3);
      group.add(containerL);
      const containerR = containerL.clone();
      containerR.position.x = w * 0.41;
      group.add(containerR);
    }

    // ナセルの双発エンジングロー (左右2個)。
    const glowMat = new MeshBasicMaterial({
      color: p.engineGlow,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const glowL = new Mesh(new SphereGeometry(h * 0.38, 8, 8), glowMat);
    glowL.position.set(-w * 0.3, -h * 0.15, -l * 0.48);
    glowL.scale.set(1, 1, 1.5);
    glowL.name = "engineGlow";
    group.add(glowL);
    const glowR = glowL.clone();
    glowR.position.x = w * 0.3;
    glowR.name = "engineGlow";
    group.add(glowR);
    return group;
  }
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
