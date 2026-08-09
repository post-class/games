/**
 * ui/screens/router.ts — 画面の切り替え（手順書 §8 の 13 画面）
 *
 * `05§1` の画面遷移:
 * ```
 * 試合前: タイトル → 対戦設定 → 文明選択 →（キャンペーン）
 * 試合中: 対戦画面（常時） ⇄ 各パネル（オーバーレイ。**試合は止まらない**）
 * 試合後: 結果 → リプレイ・観戦
 * ```
 *
 * ■ 設計の要点
 *  - **試合前・試合後の画面は「全画面を占める Screen」**。1 つだけ表示する。
 *  - **試合中のパネルは Screen ではなく HUD のオーバーレイ**（`ui/hud/*`）。
 *    ここを混ぜると「パネルを開いたら試合が止まる」実装を誘発する。
 *  - 各画面は `Screen` を実装して `register` するだけ。**ルータは画面の中身を知らない**
 *    ので、画面を並行して実装しても衝突しない。
 *  - 画面から画面への遷移は `nav`（`ScreenNav`）経由。画面が別の画面を直接 import しない
 *    （import の輪ができると、1 画面の変更が他画面のビルドを壊す）。
 */

/** 画面の識別子。13 画面のうち「全画面を占めるもの」だけ。 */
export type ScreenId =
  | 'title'
  | 'matchSetup'
  | 'civSelect'
  | 'campaign'
  | 'match'
  | 'result'
  | 'replay'
  | 'settings';

/** 画面に渡す引数（画面ごとに中身は自由。JSON 相当の値だけ）。 */
export type ScreenParams = Readonly<Record<string, unknown>>;

/** 画面が使う遷移 API。 */
export interface ScreenNav {
  /** 別の画面へ移る。 */
  go(id: ScreenId, params?: ScreenParams): void;
  /** 直前の画面へ戻る（履歴が無ければ何もしない）。 */
  back(): void;
  /** 現在の画面 ID。 */
  current(): ScreenId | null;
}

/** 1 画面の実装。 */
export interface Screen {
  /**
   * 画面を作って `root` に入れる。**呼ばれるのは表示のたび**なので、
   * 重い初期化はモジュールスコープに置くか、内部でキャッシュすること。
   */
  mount(root: HTMLElement, nav: ScreenNav, params: ScreenParams): void;
  /** 画面を片付ける（イベントリスナの解除など）。 */
  unmount?(): void;
  /**
   * 毎フレーム呼ばれる（アニメーションのある画面だけ実装する）。
   * 対戦画面はここでシムを進める。
   */
  frame?(nowMs: number): void;
}

/** 画面の登録簿と切り替え。 */
export class ScreenRouter implements ScreenNav {
  private readonly root: HTMLElement;
  private readonly screens = new Map<ScreenId, Screen>();
  private readonly history: { id: ScreenId; params: ScreenParams }[] = [];
  private active: { id: ScreenId; screen: Screen } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /**
   * 画面を登録する。
   * **同じ ID を 2 回登録するのは実装ミス**（どちらが表示されるか分からなくなる）なので例外にする。
   */
  register(id: ScreenId, screen: Screen): void {
    if (this.screens.has(id)) throw new Error(`ScreenRouter: 画面 "${id}" が二重に登録された`);
    this.screens.set(id, screen);
  }

  /** 登録済みか（未実装の画面へ飛ばそうとしたときの判定用）。 */
  has(id: ScreenId): boolean {
    return this.screens.has(id);
  }

  current(): ScreenId | null {
    return this.active?.id ?? null;
  }

  go(id: ScreenId, params: ScreenParams = {}): void {
    const screen = this.screens.get(id);
    if (screen === undefined) {
      // 未実装の画面（M12 の途中）へ飛ばそうとした場合は**黙って無視しない**。
      // 画面が出ないまま操作不能になるより、原因が分かる方がよい。
      console.warn(`ScreenRouter: 画面 "${id}" は未登録`);
      return;
    }
    if (this.active !== null) {
      this.history.push({ id: this.active.id, params: {} });
      this.active.screen.unmount?.();
    }
    this.root.textContent = '';
    this.active = { id, screen };
    screen.mount(this.root, this, params);
  }

  back(): void {
    const prev = this.history.pop();
    if (prev === undefined) return;
    if (this.active !== null) this.active.screen.unmount?.();
    this.root.textContent = '';
    const screen = this.screens.get(prev.id);
    if (screen === undefined) return;
    this.active = { id: prev.id, screen };
    screen.mount(this.root, this, prev.params);
  }

  /** 毎フレーム（現在の画面にだけ流す）。 */
  frame(nowMs: number): void {
    this.active?.screen.frame?.(nowMs);
  }
}

// ---------------------------------------------------------------- DOM の小道具

/**
 * 要素を 1 つ作る。全画面で使う最小のヘルパ。
 *
 * 画面ごとに同じ関数を書くと綴りとクラス名の規約がずれるので 1 か所に置く。
 * クラス名は `mt-` 接頭辞で始める（他のスタイルとの衝突を避ける）。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** ボタンを 1 つ作る（クリックで `onClick`）。 */
export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
