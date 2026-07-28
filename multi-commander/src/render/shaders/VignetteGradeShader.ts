/**
 * 常時適用の弱いムード用ポストシェーダ: ビネット + コントラスト + 彩度カーブ。
 * 被弾フィードバック用の一時ビネット (HUD側) とは別レイヤーで、画面全体の雰囲気付けに使う。
 * ShaderPass に渡して EffectComposer の最終段に置く想定。
 */
export const VignetteGradeShader = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    /** ビネットの強さ (0=無効)。 */
    vignette: { value: 0.85 },
    /** 減光が始まる中心からの距離 (大きいほど四隅のみ暗くなる)。 */
    vignetteSize: { value: 0.72 },
    /** コントラスト (1=変化なし)。 */
    contrast: { value: 1.06 },
    /** 彩度 (1=変化なし)。 */
    saturation: { value: 1.12 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float vignetteSize;
    uniform float contrast;
    uniform float saturation;
    varying vec2 vUv;

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec3 c = color.rgb;

      // コントラスト (0.5 を軸に伸縮)。
      c = (c - 0.5) * contrast + 0.5;

      // 彩度 (輝度からの偏差をスケール)。
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, saturation);

      // ビネット (画面端の減光)。
      vec2 d = vUv - 0.5;
      float dist = length(d) * 1.41421356;
      float v = smoothstep(1.0, vignetteSize, dist);
      c *= mix(1.0, v, vignette);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), color.a);
    }
  `,
};
