import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Cockpit } from './Cockpit';
import { SpaceDust } from './SpaceDust';
import { Skybox, type SkyboxOptions } from './Starfield';

/** 通常時の視野角。ジャンプ演出でここから広げる */
const BASE_FOV = 70;
/** 通常時のブルーム強度。ジャンプ演出でここから上げる */
const BLOOM_STRENGTH = 0.26;

export class SceneSetup {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  skybox: Skybox;
  readonly cockpit: Cockpit;
  readonly dust: SpaceDust;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private sun: DirectionalLight;
  private fill!: DirectionalLight;
  private useBloom = true;
  private warpLevel = 0;
  private frameMs = 16.7;
  private slowFrames = 0;
  private fastFrames = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    // 恒星や星雲がHUDより先に目に入らないよう、暗部を保った露出にする。
    // 敵機と照準が背景より先に読めることを優先し、遠景の作り込みは強度だけ落とす。
    this.renderer.toneMappingExposure = 0.7;

    this.camera = new PerspectiveCamera(BASE_FOV, 1, 0.5, 30000);

    this.skybox = new Skybox();
    this.scene.add(this.skybox.group);

    // 金属マテリアルが真っ黒にならないよう、環境マップを焼いて反射を与える
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // 細部を描き込んだ分、環境光を絞らないと白飛びして陰影が消える
    this.scene.environmentIntensity = 0.2;
    pmrem.dispose();

    // 主光源は太陽方向。宇宙なので影側は落ちるが、機体形状が読める程度の補助光を入れる
    this.scene.add(new AmbientLight(0x2a3442, 1.15));
    this.scene.add(new HemisphereLight(0x3a4a5e, 0x0f1216, 0.6));
    this.sun = new DirectionalLight(0xfff0d8, 2.7);
    this.sun.position.copy(this.skybox.sunDirection).multiplyScalar(1000);
    this.scene.add(this.sun);
    // 反対側からの弱い寒色フィル (シルエットが潰れないように)
    // 影側が真っ黒だと形が読めない。宇宙の暗さより可読性を取る
    this.fill = new DirectionalLight(0x7f9ecd, 1.0);
    this.fill.position.copy(this.skybox.sunDirection).multiplyScalar(-1000);
    this.scene.add(this.fill);

    // コクピット内装はカメラの子として吊るので、カメラをシーンに入れておく
    this.cockpit = new Cockpit(this.scene, this.camera);
    this.dust = new SpaceDust(this.scene);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // しきい値を上げて、発光体 (エンジン・灯火・爆発) だけを滲ませる。
    // 低いと日向の金属面まで白く潰れて、laser のような棒に見えてしまう。
    // 太陽と星雲が目標テキストや敵機と視線を奪い合っていたので、強度を下げ、
    // しきい値を上げて「本当に光っているもの」だけを滲ませる。
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), BLOOM_STRENGTH, 0.55, 1.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
  }

  /** ミッションごとに空の見た目を差し替える */
  setSkybox(opts: SkyboxOptions): void {
    this.scene.remove(this.skybox.group);
    this.skybox = new Skybox(opts);
    this.scene.add(this.skybox.group);
    this.sun.position.copy(this.skybox.sunDirection).multiplyScalar(1000);
    this.fill.position.copy(this.skybox.sunDirection).multiplyScalar(-1000);
  }

  /**
   * ジャンプ演出の発光。
   * 画角は CameraRig が一括で決めるので、ここでは触らない。
   */
  setWarp(v: number): void {
    const level = Math.max(0, Math.min(1, v));
    if (Math.abs(level - this.warpLevel) < 0.004) return;
    this.warpLevel = level;
    this.bloom.strength = BLOOM_STRENGTH + level * 0.5;
  }

  setBloom(on: boolean): void {
    this.useBloom = on;
    this.bloom.enabled = on;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  render(): void {
    const start = performance.now();
    this.skybox.update(this.camera);
    if (this.useBloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.frameMs = performance.now() - start;
    if (this.frameMs > 28) {
      this.slowFrames += 1;
      this.fastFrames = 0;
      if (this.slowFrames >= 8) {
        this.renderer.setPixelRatio(Math.max(0.75, Math.min(window.devicePixelRatio, 1.35)));
        this.slowFrames = 0;
      }
    } else if (this.frameMs < 18) {
      this.fastFrames += 1;
      this.slowFrames = 0;
      if (this.fastFrames >= 120) {
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.fastFrames = 0;
      }
    }
  }

  get performanceBudget(): { frameMs: number; quality: 'full' | 'adaptive' } {
    return { frameMs: this.frameMs, quality: this.renderer.getPixelRatio() < Math.min(window.devicePixelRatio, 2) ? 'adaptive' : 'full' };
  }
}
