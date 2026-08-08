/**
 * ペットのゲージパネル（E-1）
 *
 * 宣伝資料 `docs/01_ゲーム宣伝用資料/images/screen-talk.png` の**左上のパネル**を作る。
 * ハート＝なつき度（`Actor.affection`）、水滴＝おなか（`Actor.needs.hunger`）の2段バーで、
 * ペットが居るあいだは常時出しておく（宣伝資料の「一目で今の様子がわかる」印象がここから来ている）。
 *
 * ## 置き場所の判断
 *
 * 宣伝資料ではパネルが画面の最上段にあるが、実装のHUDには時計・接続・ペットのチップが既に並んでいる。
 * 素直に `position: fixed; top: 10px; left: 10px` で重ねると、
 * **スマホ（390px）でチップが2段に折返したときに必ず重なる**（E-5 でミニマップが同じ踏み方をしている）。
 * そこで `.hud` の折返しflexの中に「自分専用の1行」として入れる（`flex-basis: 100%`）。
 * 既存チップの位置を1pxも動かさずに、折返しが何段になっても重ならない。
 *
 * ## おなかの値について
 *
 * `Needs.hunger` は **0=満たされている / 100=空腹** の「需要値」なので、
 * バーにはそのまま入れず反転する（そのまま入れると満腹のときにバーが空に見える）。
 * なお現状 `petState` メッセージには hunger が乗っていないため、
 * 未受信のあいだは「データ無し」の見た目にする（0 として描くと餓死寸前に見えてしまう）。
 *
 * 制約: parameter property 禁止 / enum 禁止 / 相対import は `.ts` 込み
 */

/** ゲージの色分けの段階。低いときだけ色を変えて「まずい」を伝える */
export type GaugeLevel = 'low' | 'mid' | 'high';

/**
 * 値が残っているときのバーの最小割合。
 * 1%を素直に1%幅で描くと角丸に食われて**バーが消えたように見える**ため、細くても残す。
 */
const MIN_VISIBLE_RATIO = 0.04;

/** 0..1 に丸める（NaN は 0 扱い。サーバ値が欠けてもレイアウトを壊さない） */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** なつき度（0..100）→ バーの割合（0..1） */
export function affectionRatio(affection: number): number {
  return clamp01(affection / 100);
}

/**
 * おなかバーの割合（0..1）。
 * `Needs.hunger` は 0=満たされ / 100=空腹 なので **反転**する。
 */
export function fullnessRatio(hunger: number): number {
  return clamp01((100 - hunger) / 100);
}

/** CSS の `width` に入れる整数%。0 のときだけ 0 を返し、それ以外は下限まで持ち上げる */
export function barWidthPercent(ratio: number): number {
  const r = clamp01(ratio);
  if (r <= 0) return 0;
  return Math.round(Math.max(r, MIN_VISIBLE_RATIO) * 100);
}

/**
 * バーの色分け。閾値は「なつき度20（ハート1つぶん）を切ったら気づかせる」から取った。
 * 空腹側も同じ閾値でよい（`hunger` 75以上＝おなか25%未満が餓死の手前）。
 */
export function gaugeLevel(ratio: number): GaugeLevel {
  const r = clamp01(ratio);
  if (r < 0.25) return 'low';
  if (r < 0.6) return 'mid';
  return 'high';
}

/** ツールチップ・読み上げ用の文（値が無ければ「？」にする） */
export function gaugeLabel(kind: 'affection' | 'fullness', value: number | null): string {
  const name = kind === 'affection' ? 'なつき度' : 'おなか';
  if (value === null) return `${name} ？`;
  return `${name} ${Math.round(clamp01(value) * 100)}%`;
}

/** `update()` に渡す差分。届いた項目だけ書き換える */
export interface PetGaugePatch {
  /** ペットの名前（パネルの読み上げラベルに使う） */
  name?: string;
  /** なつき度 0..100 */
  affection?: number;
  /** `Needs.hunger` の生値（0=満たされ / 100=空腹）。反転はこちらでやる */
  hunger?: number;
}

/** ハートと水滴のアイコン。絵文字は端末ごとに形が変わるのでSVGで描く */
const ICON_HEART =
  '<svg class="petgauge-icon" viewBox="0 0 20 18" aria-hidden="true">' +
  '<path d="M10 16.6C10 16.6 1.6 11.2 1.6 6.3A4.6 4.6 0 0 1 10 3.4A4.6 4.6 0 0 1 18.4 6.3' +
  'C18.4 11.2 10 16.6 10 16.6Z" fill="#ee8f8f" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linejoin="round"/></svg>';

const ICON_DROP =
  '<svg class="petgauge-icon" viewBox="0 0 16 20" aria-hidden="true">' +
  '<path d="M8 2C8 2 2.6 8.6 2.6 12.7A5.4 5.4 0 0 0 13.4 12.7C13.4 8.6 8 2 8 2Z" ' +
  'fill="#9fd8ee" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

export class PetGauge {
  private root: HTMLElement;
  private affectionFill: HTMLElement;
  private affectionRow: HTMLElement;
  private fullnessFill: HTMLElement;
  private fullnessRow: HTMLElement;

  private petName = 'ペット';
  private affection: number | null = null;
  private hunger: number | null = null;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  /**
   * @param parent 既定は `#hud`。HUDの折返しflexに入れることで既存チップと重ならない
   */
  constructor(parent?: HTMLElement | null) {
    this.root = document.createElement('div');
    this.root.className = 'petgauge hidden';
    this.root.dataset['testid'] = 'pet-gauge';
    this.root.setAttribute('role', 'group');
    this.root.innerHTML = `
      <div class="petgauge-box">
        <div class="petgauge-row" data-row="affection">
          ${ICON_HEART}
          <div class="petgauge-track"><div class="petgauge-fill high" style="width:0%"></div></div>
        </div>
        <div class="petgauge-row" data-row="fullness">
          ${ICON_DROP}
          <div class="petgauge-track"><div class="petgauge-fill high" style="width:0%"></div></div>
        </div>
      </div>`;

    (parent ?? document.getElementById('hud') ?? document.body).appendChild(this.root);

    this.affectionRow = this.root.querySelector('[data-row=affection]') as HTMLElement;
    this.fullnessRow = this.root.querySelector('[data-row=fullness]') as HTMLElement;
    this.affectionFill = this.affectionRow.querySelector('.petgauge-fill') as HTMLElement;
    this.fullnessFill = this.fullnessRow.querySelector('.petgauge-fill') as HTMLElement;
    this.render();
  }

  /** 届いた値だけ更新する。1つでも値が入ればパネルを出す */
  update(patch: PetGaugePatch): void {
    if (patch.name !== undefined) this.petName = patch.name;
    if (patch.affection !== undefined && Number.isFinite(patch.affection)) this.affection = patch.affection;
    if (patch.hunger !== undefined && Number.isFinite(patch.hunger)) this.hunger = patch.hunger;
    this.render();
  }

  /** ペットが居ないとき（タマゴ選択中）は隠す */
  hide(): void {
    this.root.classList.add('hidden');
  }

  destroy(): void {
    this.root.remove();
  }

  private render(): void {
    if (this.affection === null && this.hunger === null) {
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');

    const aff = this.affection === null ? null : affectionRatio(this.affection);
    const full = this.hunger === null ? null : fullnessRatio(this.hunger);
    this.paint(this.affectionRow, this.affectionFill, aff, gaugeLabel('affection', aff));
    this.paint(this.fullnessRow, this.fullnessFill, full, gaugeLabel('fullness', full));
    this.root.setAttribute(
      'aria-label',
      `${this.petName} の ${gaugeLabel('affection', aff)}・${gaugeLabel('fullness', full)}`,
    );
  }

  /** 1行ぶんを描く。`ratio === null` は「未受信」で、0 とは区別する */
  private paint(row: HTMLElement, fill: HTMLElement, ratio: number | null, label: string): void {
    row.title = label;
    if (ratio === null) {
      // 幅0だと「空っぽ」と見分けが付かないので、縞模様の薄い帯で「データ無し」を示す
      row.classList.add('unknown');
      fill.style.width = '100%';
      fill.className = 'petgauge-fill';
      return;
    }
    row.classList.remove('unknown');
    fill.style.width = `${barWidthPercent(ratio)}%`;
    fill.className = `petgauge-fill ${gaugeLevel(ratio)}`;
  }
}
