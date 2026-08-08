/**
 * 共同建設の「みんなで作る」パネル（G-1 の残り）
 *
 * 足場と進捗バーは `render/constructions.ts` で出るようになったが、
 * HUDに `橋 0%` のチップが1つ出るだけで
 * **誰がどれだけ手伝ったのか / 自分が何をすればいいのか**が分からなかった。
 * 宣伝資料（`docs/01_ゲーム宣伝用資料/index.html`「島は、みんなのもの」）の
 * 「共同作業：橋づくりなど、みんなで少しずつ進める建設」はここが要なので、
 * 近づいたときに「名前・進捗・自分の貢献・手伝うボタン」を出す。
 *
 * ## 設計の判断
 *
 * - サーバ機能は増やさない。既存の `{ t:'contribute', constructionId }` をそのまま送る
 * - **押す前に押せるか分かるようにする**（`ui/actionButtons.ts` と同じ方針）。
 *   実装済みの経路は「押してから `warn` が返る」だけで、しかも `rate`（連打）は
 *   サーバが黙って捨てる（`hub.ts`）ので**なぜ押せないのかが永遠に分からない**。
 *   クールダウンの残りをこちら側で数えて見せるのが、このパネルのいちばんの仕事
 * - しきい値はサーバと同値にする（距離3タイル / クールダウン8tick=2秒）。
 *   甘いと「押せたのに断られる」、厳しいと「サーバは受けるのに押せない」
 * - ⚠️ **クールダウンはプレイヤー単位で建設物をまたいで共有**される（M7申し送り6 /
 *   `build.ts` の `lastContribTick` はプレイヤー鍵）。なので待ち時間はパネル1つに1個だけ持ち、
 *   別の工事へ歩いて行っても引き継ぐ。文言でも「（どの工事でも）」と伝える
 * - `main.ts` は配線の集約点で衝突しやすいので依存は注入（`BuildPanelDeps`）。
 *   判定は純粋関数（`pickPanelTarget` / `resolveContribute`）に切り出してテストしている
 *
 * ## 置き場所の判断（重要）
 *
 * `position: fixed` の絶対配置は**使わない**。`.hud` の折返しflexの中に
 * 「自分専用の1行」として入れる（`ui/petGauge.ts` と同じ手）。理由:
 *
 * - 右下は `touchPad` の設置ボタンと `actionButtons` の丸ボタンで埋まっている
 * - 左下はチャット欄、右上はミニマップ、上寄り中央はチュートリアルのバナー
 * - スマホ（390px）ではHUDのチップが2段に折返すので、`top` 固定だと必ず重なる
 *   （E-5でミニマップが同じ踏み方をしている）
 *
 * ## 落とし穴
 *
 * - **`.hud` は `pointer-events: none`**（AI_CODING §7）。「手伝う」ボタン側で
 *   `pointer-events: auto` を明示しないとクリックが canvas に吸われて**押せない**
 *
 * 制約: parameter property 禁止 / enum 禁止 / 相対import は `.ts` 込み
 */

/** 貢献できる距離（タイル）。サーバ `sim/build.ts` の `CONTRIBUTE_RANGE_TILES` と同じ */
export const CONTRIBUTE_RANGE_TILES = 3;

/**
 * パネルを出す距離（タイル）。貢献できる距離より広くとる。
 * 3タイルで出し始めると「出た瞬間に押せる」ので、
 * 近づく途中で「近づいてください」を読める余裕（+5タイル）を持たせた。
 */
export const PANEL_RANGE_TILES = 8;

/**
 * 貢献のクールダウン（ms）。サーバは `CONTRIBUTE_COOLDOWN_TICKS = 8`、`TICK_HZ = 4` なので2秒。
 * ⚠️ プレイヤー単位で**建設物をまたいで共有**される（M7申し送り6）。
 */
export const CONTRIBUTE_COOLDOWN_MS = 2000;

/** 1回の貢献で進む量（%）。サーバ `CONTRIBUTE_STEP` と同じ。「あと何回」の表示に使う */
export const CONTRIBUTE_STEP = 5;

/** 完成に必要な progress。サーバ `CONSTRUCTION_GOAL` と同じ */
export const CONSTRUCTION_GOAL = 100;

/** 建設物の名前。サーバ `build.ts` の `CONSTRUCTION_LABEL` と同じ */
const TYPE_LABEL: Record<string, string> = {
  bridge: '橋',
  well: '井戸',
  observatory: '天文台',
};

/** 押せない理由。ツールチップと `data-reason`（E2E/デバッグ用）に出す */
export type BuildReason = 'ok' | 'no_target' | 'too_far' | 'cooldown';

/** 位置だけを見る最小の型 */
export interface PointLike {
  x: number;
  y: number;
}

/** `ConstructionWire` がそのまま入る形（テストから素の値を渡せるように別定義にしている） */
export interface ConstructionLike extends PointLike {
  i: number;
  ty: string;
  /** 0..100 */
  p: number;
  done: boolean;
  /** 自分の貢献値（progress と同じ単位） */
  mine: number;
}

/** パネルが対象にしている工事。`dist` は自分からの距離（タイル） */
export interface BuildTarget {
  id: number;
  ty: string;
  progress: number;
  mine: number;
  dist: number;
}

/** パネルの状態。DOMはこれを見て描く */
export interface BuildPanelState {
  target: BuildTarget | null;
  /** パネルを出すか */
  visible: boolean;
  /** 「手伝う」を押せるか */
  enabled: boolean;
  reason: BuildReason;
  /** クールダウンの残り（ms）。0 なら待ちなし */
  cooldownMs: number;
}

// ---------- 純粋関数（テスト対象） ----------

/** タイル座標の距離 */
export function tileDistance(a: PointLike, b: PointLike): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 建設物の表示名（未知の種類はそのまま出す。サーバが種類を増やしても壊れない） */
export function constructionLabel(ty: string): string {
  return TYPE_LABEL[ty] ?? ty;
}

/**
 * パネルに出す工事を選ぶ（いちばん近い未完成のもの）。範囲外・完成済みだけなら null。
 *
 * 「未完成」で絞ってから距離で選ぶ。完成済みを含めて最短を決めてしまうと、
 * 完成した橋のそばに立っているあいだ、少し先の井戸のパネルが出なくなる。
 */
export function pickPanelTarget(
  self: PointLike,
  items: Iterable<ConstructionLike>,
  range: number = PANEL_RANGE_TILES,
): BuildTarget | null {
  let best: BuildTarget | null = null;
  let bestD = range;
  for (const c of items) {
    if (c.done) continue;
    const d = tileDistance(self, c);
    if (d <= bestD) {
      bestD = d;
      best = { id: c.i, ty: c.ty, progress: c.p, mine: c.mine, dist: d };
    }
  }
  return best;
}

/**
 * 「手伝う」を押せるかを決める。
 *
 * 距離とクールダウンの2つだけを見る（サーバの拒否理由のうち
 * `not_found` / `already_done` は、対象を毎フレーム選び直すこの作りでは起こらない）。
 */
export function resolveContribute(
  target: BuildTarget | null,
  timing?: { nowMs: number; cooldownUntilMs: number },
): BuildPanelState {
  if (!target) {
    return { target: null, visible: false, enabled: false, reason: 'no_target', cooldownMs: 0 };
  }
  const cooldownMs = timing ? Math.max(0, timing.cooldownUntilMs - timing.nowMs) : 0;
  if (target.dist > CONTRIBUTE_RANGE_TILES) {
    return { target, visible: true, enabled: false, reason: 'too_far', cooldownMs };
  }
  if (cooldownMs > 0) {
    return { target, visible: true, enabled: false, reason: 'cooldown', cooldownMs };
  }
  return { target, visible: true, enabled: true, reason: 'ok', cooldownMs: 0 };
}

/** 進捗の表示（整数%。小数を出すと「99.9%」で完成しないように見える） */
export function progressLabel(progress: number): string {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  return `${Math.round(p)}%`;
}

/** バーの割合（0..1）。CSSの width に入れる */
export function progressRatio(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress / CONSTRUCTION_GOAL));
}

/**
 * 自分の貢献の表示。
 * `mine` は progress と同じ単位なので、回数（`/ CONTRIBUTE_STEP`）に直すと「手伝った実感」が出る。
 */
export function contributionLabel(mine: number): string {
  const m = Number.isFinite(mine) ? Math.max(0, mine) : 0;
  if (m <= 0) return 'あなた：まだ手伝っていません';
  const times = Math.round(m / CONTRIBUTE_STEP);
  return `あなた：${times}回（全体の ${Math.round(m)}%）`;
}

/** 残り何回で完成するか（みんなの合計で。「あと少し」を伝えるため） */
export function remainingTimes(progress: number): number {
  const left = CONSTRUCTION_GOAL - (Number.isFinite(progress) ? progress : 0);
  return Math.max(0, Math.ceil(left / CONTRIBUTE_STEP));
}

/**
 * 押せない理由の1文。**なぜ押せないか**を必ず出すのがこのパネルの主眼。
 * クールダウンは「どの工事でも」を明記する（プレイヤー単位で共有されるため。M7申し送り6）。
 */
export function buildHint(state: BuildPanelState): string {
  switch (state.reason) {
    case 'too_far':
      return 'もう少し近づいてください';
    case 'cooldown':
      return `ひと休み中… ${(state.cooldownMs / 1000).toFixed(1)}秒（どの工事でも共通）`;
    case 'ok': {
      const left = state.target ? remainingTimes(state.target.progress) : 0;
      return left <= 1 ? 'あと1回で完成します' : `みんなであと${left}回`;
    }
    default:
      return '';
  }
}

/** パネルの見出し。`橋をつくる 45%` */
export function buildTitle(state: BuildPanelState): string {
  if (!state.target) return '';
  return `${constructionLabel(state.target.ty)}をつくる`;
}

/** ボタンのツールチップ／読み上げラベル */
export function buttonTitle(state: BuildPanelState): string {
  const hint = buildHint(state);
  return state.reason === 'ok' ? '手伝う' : `手伝う（${hint}）`;
}

// ---------- 本体 ----------

export interface BuildPanelDeps {
  /** 自分の描画位置（タイル座標）。`main.ts` の `selfPos()` をそのまま渡せる */
  selfPos: () => PointLike;
  /** サーバから来た共同建設の一覧 */
  constructions: () => Iterable<ConstructionLike>;
  send: (msg: { t: 'contribute'; constructionId: number }) => void;
  /** 案内（チュートリアル）と効果音のフック。送れたときだけ呼ぶ */
  onUsed?: (constructionId: number) => void;
  /** テスト用の時計。既定は `performance.now()` */
  now?: () => number;
}

/** 金づちのアイコン。絵文字は端末ごとに形が変わるのでSVGで描く（petGauge.ts と同じ方針） */
const ICON_HAMMER =
  '<svg class="buildpanel-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<g stroke="#4a3b2a" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">' +
  '<path d="M4.2 19.8 13 11l1.6 1.6-8.8 8.8a1.1 1.1 0 0 1-1.6-1.6Z" fill="#e0a86a"/>' +
  '<path d="M12 6.2 17.8 12l2.4-2.4a4.1 4.1 0 0 0-5.8-5.8Z" fill="#a892e0"/>' +
  '</g></svg>';

export class BuildPanel {
  private deps: BuildPanelDeps;
  private root: HTMLElement;
  private nameEl: HTMLElement;
  private pctEl: HTMLElement;
  private fillEl: HTMLElement;
  private mineEl: HTMLElement;
  private hintEl: HTMLElement;
  private goEl: HTMLButtonElement;
  /** 直前に描いた内容の鍵。DOMの書き換えを変化時だけにする（`update()` は毎フレーム呼ばれる） */
  private painted = '';
  /** 次に貢献できる時刻（ms）。**工事をまたいで1つ**（サーバと同じ持ち方） */
  private cooldownUntilMs = 0;
  private now: () => number;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  /**
   * @param parent 既定は `#hud`。折返しflexの中に1行として入るので既存チップと重ならない
   */
  constructor(deps: BuildPanelDeps, parent?: HTMLElement | null) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());

    this.root = document.createElement('div');
    this.root.className = 'buildpanel hidden';
    this.root.dataset['testid'] = 'build-panel';
    this.root.setAttribute('role', 'group');
    this.root.innerHTML = `
      <div class="buildpanel-box">
        <div class="buildpanel-head">
          ${ICON_HAMMER}
          <b data-el="name">工事</b>
          <span class="buildpanel-pct" data-el="pct">0%</span>
        </div>
        <div class="buildpanel-track"><div class="buildpanel-fill" data-el="fill" style="width:0%"></div></div>
        <div class="buildpanel-foot">
          <span class="buildpanel-mine" data-el="mine"></span>
          <button class="buildpanel-go" type="button" data-el="go" data-testid="build-help">手伝う</button>
        </div>
        <p class="buildpanel-hint" data-el="hint"></p>
      </div>`;

    (parent ?? document.getElementById('hud') ?? document.body).appendChild(this.root);

    this.nameEl = this.root.querySelector('[data-el=name]') as HTMLElement;
    this.pctEl = this.root.querySelector('[data-el=pct]') as HTMLElement;
    this.fillEl = this.root.querySelector('[data-el=fill]') as HTMLElement;
    this.mineEl = this.root.querySelector('[data-el=mine]') as HTMLElement;
    this.hintEl = this.root.querySelector('[data-el=hint]') as HTMLElement;
    this.goEl = this.root.querySelector('[data-el=go]') as HTMLButtonElement;

    this.goEl.addEventListener('click', () => {
      if (this.goEl.disabled) return;
      this.help();
    });

    this.update();
  }

  /** 毎フレーム呼ばれ、対象と押せる／押せないを更新する */
  update(): void {
    this.paint(this.resolve());
  }

  /**
   * 「手伝う」を押したときの送信。押せない状態でも呼ばれ得る（Enterキーなど）ので、
   * ここでも状態を作り直して確認する。
   */
  help(): boolean {
    const state = this.resolve();
    if (!state.enabled || !state.target) {
      this.paint(state);
      return false;
    }
    this.deps.send({ t: 'contribute', constructionId: state.target.id });
    this.noteContributed();
    this.deps.onUsed?.(state.target.id);
    this.update();
    return true;
  }

  /**
   * 「いま貢献を送った」ことを記録してクールダウンを始める。
   *
   * `main.ts` のクリック操作（`nearestConstruction` 経由）からも `contribute` は送られる。
   * そちらを通したときにここへ知らせないと、パネルは「押せます」の見た目のまま
   * サーバに黙って捨てられる（`rate` は warn を返さない）ので、外から呼べるようにしてある。
   */
  noteContributed(nowMs?: number): void {
    this.cooldownUntilMs = (nowMs ?? this.now()) + CONTRIBUTE_COOLDOWN_MS;
  }

  /** いまの状態（デバッグ・テスト用） */
  get state(): BuildPanelState {
    return this.resolve();
  }

  destroy(): void {
    this.root.remove();
  }

  private resolve(): BuildPanelState {
    const target = pickPanelTarget(this.deps.selfPos(), this.deps.constructions());
    return resolveContribute(target, { nowMs: this.now(), cooldownUntilMs: this.cooldownUntilMs });
  }

  /** DOMは内容が変わったときだけ書く（毎フレーム呼ばれるため。AI_CODING §12） */
  private paint(state: BuildPanelState): void {
    // クールダウンの残りは 0.1秒 単位でだけ書き換える（毎フレーム書くと無駄に触ることになる）
    const cd = Math.round(state.cooldownMs / 100);
    const key = state.target
      ? `${state.target.id}:${Math.round(state.target.progress)}:${Math.round(state.target.mine)}:` +
        `${state.reason}:${cd}`
      : 'none';
    if (this.painted === key) return;
    this.painted = key;

    if (!state.visible || !state.target) {
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');
    this.nameEl.textContent = buildTitle(state);
    this.pctEl.textContent = progressLabel(state.target.progress);
    this.fillEl.style.width = `${Math.round(progressRatio(state.target.progress) * 100)}%`;
    this.fillEl.classList.toggle('half', state.target.progress >= 50);
    this.mineEl.textContent = contributionLabel(state.target.mine);
    this.hintEl.textContent = buildHint(state);
    this.goEl.disabled = !state.enabled;
    this.goEl.dataset['reason'] = state.reason;
    this.goEl.title = buttonTitle(state);
    this.goEl.setAttribute('aria-label', buttonTitle(state));
    this.root.setAttribute(
      'aria-label',
      `${buildTitle(state)} ${progressLabel(state.target.progress)} / ${contributionLabel(state.target.mine)}`,
    );
  }
}
