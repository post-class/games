import type { Object3D } from 'three';

/** GLTF の取得と、手続き生成メッシュからの差し替え状態。 */
export type ShipVisualState = 'procedural' | 'loading' | 'gltf' | 'fallback' | 'cancelled';

/**
 * 非同期の見た目差し替えを、エンティティの寿命から切り離して管理する。
 *
 * ロード中も呼び出し側は手続き生成メッシュを表示しているため、失敗しても
 * 画面から機体が消えない。cancel() 後に解決した Promise は適用しない。
 */
export class ShipVisualLifecycle {
  private currentState: ShipVisualState = 'procedural';
  private active = true;

  constructor(
    private readonly apply: (visual: Object3D) => void,
    private readonly onFailure?: (error: unknown) => void,
  ) {}

  get state(): ShipVisualState {
    return this.currentState;
  }

  private fallback(error: unknown): void {
    if (!this.active || this.currentState !== 'loading') return;
    this.currentState = 'fallback';
    this.onFailure?.(error);
  }

  start(load: () => Promise<Object3D>): void {
    if (!this.active || this.currentState !== 'procedural') return;
    this.currentState = 'loading';

    let pending: Promise<Object3D>;
    try {
      pending = load();
    } catch (error) {
      this.fallback(error);
      return;
    }

    void pending.then(
      (visual) => {
        if (!this.active || this.currentState !== 'loading') return;
        try {
          this.apply(visual);
          this.currentState = 'gltf';
        } catch (error) {
          this.fallback(error);
        }
      },
      (error: unknown) => this.fallback(error),
    );
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    if (this.currentState === 'procedural' || this.currentState === 'loading') {
      this.currentState = 'cancelled';
    }
  }
}
