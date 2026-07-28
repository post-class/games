import {
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  Color,
  CanvasTexture,
  AdditiveBlending,
  Group,
  Sprite,
  SpriteMaterial,
  SphereGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three";

/**
 * 円形ソフトグローのスプライトテクスチャを動的生成する。
 * 星や光点に柔らかい見た目を与える。
 */
function createStarTexture(size = 64): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const center = size / 2;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.2, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.3)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  return texture;
}

/**
 * 球殻状に分布する星空を Points で生成する。
 * radius は星までの距離、count は星の数。
 * ソフトグローのスプライトとAdditiveBlendingで柔らかい光点にする。
 */
export function createStarfield(count = 8000, radius = 15000): Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const c = new Color();

  for (let i = 0; i < count; i++) {
    // 球面上に一様分布させる。
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const x = r * Math.cos(theta);
    const y = u;
    const z = r * Math.sin(theta);
    // わずかに距離をゆらす。
    const dist = radius * (0.7 + Math.random() * 0.3);
    positions[i * 3] = x * dist;
    positions[i * 3 + 1] = y * dist;
    positions[i * 3 + 2] = z * dist;

    // 青白〜黄白の色ゆらぎ。
    const hue = 0.55 + (Math.random() - 0.5) * 0.15;
    const sat = Math.random() * 0.4;
    const light = 0.7 + Math.random() * 0.3;
    c.setHSL(hue, sat, light);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;

    // サイズにも個体差を与える。
    sizes[i] = 30 + Math.random() * 20;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setAttribute("size", new Float32BufferAttribute(sizes, 1));

  const starTexture = createStarTexture();
  const material = new PointsMaterial({
    size: 40,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    map: starTexture,
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, material);
  points.name = "starfield";
  // 背景として常に最遠に描画。
  points.frustumCulled = false;
  return points;
}

/**
 * パララックス用の遠距離・低密度・暗めの星群を生成する。
 * 第1層より遠くに配置することで奥行き感を出す。
 */
export function createStarfieldFar(count = 2500, radius = 30000): Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const c = new Color();

  for (let i = 0; i < count; i++) {
    // 球面上に一様分布させる。
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const x = r * Math.cos(theta);
    const y = u;
    const z = r * Math.sin(theta);
    const dist = radius * (0.8 + Math.random() * 0.2);
    positions[i * 3] = x * dist;
    positions[i * 3 + 1] = y * dist;
    positions[i * 3 + 2] = z * dist;

    // 遠距離層は暗めに。
    const hue = 0.55 + (Math.random() - 0.5) * 0.2;
    const sat = Math.random() * 0.3;
    const light = 0.4 + Math.random() * 0.3;
    c.setHSL(hue, sat, light);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;

    sizes[i] = 20 + Math.random() * 15;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setAttribute("size", new Float32BufferAttribute(sizes, 1));

  const starTexture = createStarTexture();
  const material = new PointsMaterial({
    size: 35,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    map: starTexture,
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, material);
  points.name = "starfieldFar";
  points.frustumCulled = false;
  return points;
}

/**
 * 星雲テクスチャを動的生成する。
 * 放射状グラデーションで大気感のある色付きの光を表現。
 */
function createNebulaTexture(baseColor: Color, size = 512): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const center = size / 2;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  const r = Math.floor(baseColor.r * 255);
  const g = Math.floor(baseColor.g * 255);
  const b = Math.floor(baseColor.b * 255);
  gradient.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
  gradient.addColorStop(0.3, `rgba(${r},${g},${b},0.4)`);
  gradient.addColorStop(0.6, `rgba(${r},${g},${b},0.15)`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  return texture;
}

/**
 * 星雲を生成する。半透明の大型Spriteを数枚配置し背景に色彩と大気感を加える。
 */
export function createNebulae(count = 4, radius = 18000): Group {
  const group = new Group();
  group.name = "nebulae";
  group.frustumCulled = false;

  // 色バリエーション（青紫/オレンジ系）
  const colorPalette = [
    new Color(0.4, 0.2, 0.8), // 青紫
    new Color(0.8, 0.4, 0.2), // オレンジ
    new Color(0.2, 0.5, 0.9), // 青
    new Color(0.9, 0.5, 0.3), // 暖色オレンジ
    new Color(0.5, 0.3, 0.7), // 紫
  ];

  for (let i = 0; i < count; i++) {
    // 球面上にランダム配置
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const x = r * Math.cos(theta);
    const y = u;
    const z = r * Math.sin(theta);
    const dist = radius * (0.8 + Math.random() * 0.3);

    const baseColor = colorPalette[i % colorPalette.length];
    const texture = createNebulaTexture(baseColor);
    const material = new SpriteMaterial({
      map: texture,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      opacity: 0.5 + Math.random() * 0.3,
    });

    const sprite = new Sprite(material);
    sprite.position.set(x * dist, y * dist, z * dist);
    // 星雲は大型に
    const scale = 3000 + Math.random() * 2000;
    sprite.scale.set(scale, scale, 1);
    sprite.frustumCulled = false;
    group.add(sprite);
  }

  return group;
}

/**
 * 惑星/太陽の定義。
 */
export interface PlanetDef {
  radius: number;
  distance: number;
  direction: [number, number, number];
  color: number;
  emissive?: number;
}

/**
 * 遠景の惑星/太陽を生成する。
 * 太陽は自己発光（MeshBasicMaterial、Bloom閾値超えの輝度）、
 * 惑星はMeshStandardMaterialで片側照射。
 */
export function createDistantPlanets(defs?: PlanetDef[]): Group {
  const group = new Group();
  group.name = "distantPlanets";
  group.frustumCulled = false;

  // 既定の構成: 太陽1 + 惑星2
  const defaultDefs: PlanetDef[] = defs || [
    // 太陽（明るい白、自己発光）
    {
      radius: 800,
      distance: 25000,
      direction: [0.6, 0.3, -0.7],
      color: 0xffffff,
      emissive: 0xffffff,
    },
    // 惑星1（赤系）
    {
      radius: 400,
      distance: 20000,
      direction: [-0.5, -0.2, 0.8],
      color: 0xcc6644,
    },
    // 惑星2（青系）
    {
      radius: 300,
      distance: 30000,
      direction: [0.4, -0.6, 0.7],
      color: 0x4488cc,
    },
  ];

  for (const def of defaultDefs) {
    const geometry = new SphereGeometry(def.radius, 32, 32);
    let material;

    if (def.emissive !== undefined) {
      // 太陽: 自己発光、Bloom閾値超えを狙う
      material = new MeshBasicMaterial({
        color: def.color,
        fog: false,
      });
    } else {
      // 惑星: 標準マテリアル、環境マップと主光源で照らされる
      material = new MeshStandardMaterial({
        color: def.color,
        metalness: 0.2,
        roughness: 0.8,
        fog: false,
      });
    }

    const mesh = new Mesh(geometry, material);
    const [dx, dy, dz] = def.direction;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    mesh.position.set(
      (dx / len) * def.distance,
      (dy / len) * def.distance,
      (dz / len) * def.distance
    );
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return group;
}
