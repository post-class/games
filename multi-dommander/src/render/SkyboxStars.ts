import { BufferGeometry, Float32BufferAttribute, Points, PointsMaterial, Color } from "three";

/**
 * 球殻状に分布する簡易星空を Points で生成する。
 * radius は星までの距離、count は星の数。
 */
export function createStarfield(count = 8000, radius = 15000): Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
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
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));

  const material = new PointsMaterial({
    size: 40,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });

  const points = new Points(geometry, material);
  points.name = "starfield";
  // 背景として常に最遠に描画。
  points.frustumCulled = false;
  return points;
}
