import { COMBAT_GRADES, PROTAGONISTS, type VeilPerson } from '../content/veil/people';
import { speakerName } from '../content/veil/missions/shared';
import type { PortraitSpec } from '../content/pilots';
import { portraitFace } from './Portrait';

/**
 * 主人公選択画面（T7-1）。
 *
 * 新規戦役の開始時に、F-54 専任パイロット5名（`PROTAGONISTS`）を
 * 肖像・名前・二つ名・戦闘級・役割・実績つきで並べ、1名を選ばせる。
 *
 * 画面遷移には依存しない。呼び出し側は `el` を好きな場所（ScreenHost の
 * `content`）へ差し込み、`onSelect` で選ばれた人物 id を受け取る。
 *
 *   const scene = new PilotSelectScene({
 *     onSelect: (personId) => { ... },   // 1回だけ呼ばれる
 *   });
 *   host.show({ title: '専任パイロット選任', content: scene.el, hint: scene.hint });
 *   scene.start();
 *
 * 肖像画像（`person.portrait` = `characters/<id>.png`）はまだ未整備なので、
 * 既定は `portraitFace()`。人物の肖像（`face-<人物id>-neutral.jpg`）があればそれを使い、
 * 無ければ `portraitSvg()` のプレースホルダへ自動で落ちる（404 を出さない）。
 * 差し替えたい場合は `portraitHtml` を渡す。
 */

export interface PilotSelectOptions {
  /** 選ばれた人物 id を受け取る。連打・キーリピートでも1回しか呼ばれない。 */
  onSelect: (personId: string) => void;
  /** 候補の一覧。既定は主人公候補5名。 */
  people?: readonly VeilPerson[];
  /** 最初に選択状態にする人物 id（前回の選択の復元用）。 */
  initialId?: string;
  /** 肖像の HTML を差し替える（生成画像が用意できたとき用）。 */
  portraitHtml?: (person: VeilPerson) => string;
}

/** 画面下部に出すと操作が伝わるヒント文 */
export const PILOT_SELECT_HINT = '←→ で選択 / Enter で決定 / クリックでも選べます';

/**
 * 名簿の表記を1つに揃える（T3-⑬）。
 *
 * `people.ts` の `name` は `朝倉 澪（アサクラ ミオ）` と
 * `Amina Okafor（アミナ・オカフォー）` の2形式が混在している。そのまま並べると
 * 同じ画面に英字と漢字が混ざるので、**必ず `speakerName()` を通す**
 * （無線・ブリーフィングと同じ出所。ここで括弧の剥がし方を再実装しない）。
 */
export function protagonistDisplayName(person: VeilPerson): string {
  try {
    return speakerName(person.id);
  } catch {
    // 名簿に無い人物を `people` オプションで差し込まれても画面を壊さない
    return person.name;
  }
}

/**
 * 「選ぶと何が変わるのか」（T3-⑬-3）。
 *
 * コードを追った結果、`save.protagonistId` は
 * **ブリーフィングの搭乗者表示に出るだけ**で、技量・初期機体・僚機・敵の強さ・
 * 難易度には一切影響しない。ここで盛って書くと「表示だけ変えて実挙動が
 * 変わらない」状態になるため、変わるものと変わらないものを分けて明示する。
 */
export const PROTAGONIST_EFFECTS = {
  changes: [
    'ブリーフィングの「搭乗」に出る名前と二つ名',
    '記録に残る主人公（セーブに保存され、以後の戦役で変わらない）',
  ],
  unchanged: ['技量・機体性能', '初期機体（格納庫で4機から選べる）', '僚機の顔ぶれ', '敵の強さ・難易度'],
} as const;

export class PilotSelectScene {
  readonly el: HTMLElement;
  /** ScreenHost の `hint` にそのまま渡せる操作説明 */
  readonly hint = PILOT_SELECT_HINT;

  private readonly people: readonly VeilPerson[];
  private readonly o: PilotSelectOptions;
  private readonly cardEls: HTMLElement[] = [];
  private readonly detailEl: HTMLElement;
  private index = 0;
  private decided = false;
  private keyHandler = (ev: KeyboardEvent) => this.onKey(ev);

  constructor(o: PilotSelectOptions) {
    this.o = o;
    this.people = o.people?.length ? o.people : PROTAGONISTS;
    const initial = this.people.findIndex((p) => p.id === o.initialId);
    this.index = initial >= 0 ? initial : 0;

    const root = document.createElement('div');
    root.className = 'mc-pilot-select';

    const track = document.createElement('div');
    track.className = 'mc-pilot-track';
    this.people.forEach((person, i) => {
      const card = this.buildCard(person);
      card.addEventListener('click', () => {
        this.index = i;
        this.highlight();
        this.decide();
      });
      track.appendChild(card);
      this.cardEls.push(card);
    });
    root.appendChild(track);

    const detail = document.createElement('div');
    detail.className = 'mc-pilot-detail';
    this.detailEl = detail;
    root.appendChild(detail);

    this.el = root;
    this.highlight();
  }

  /** いま選択されている人物 id（まだ決定していない状態でも読める） */
  get selectedId(): string {
    return this.people[this.index]?.id ?? '';
  }

  /** 決定済みか（決定後は入力を受け付けない） */
  get isDecided(): boolean {
    return this.decided;
  }

  /** キーボード操作の購読を始める */
  start(): void {
    // ScreenHost も window で Enter を待っているので、capture で先に受ける
    window.addEventListener('keydown', this.keyHandler, true);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler, true);
  }

  // ───────── 内部 ─────────

  private buildCard(person: VeilPerson): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mc-pilot-card';
    card.dataset.personId = person.id;
    card.setAttribute('role', 'button');

    const face = document.createElement('div');
    face.className = 'mc-pilot-face';
    face.innerHTML = this.o.portraitHtml
      ? this.o.portraitHtml(person)
      // 人物id をそのまま顔画像id として渡す（`pilots.ts` も同じ規則）
      : portraitFace(person.id, placeholderPortraitSpec(person), { size: 112 });
    card.appendChild(face);

    const name = document.createElement('div');
    name.className = 'mc-pilot-name';
    name.textContent = protagonistDisplayName(person);
    card.appendChild(name);

    const epithet = document.createElement('div');
    epithet.className = 'mc-pilot-epithet';
    epithet.textContent = person.epithetJa ? `“${person.epithet}” ${person.epithetJa}` : `“${person.epithet}”`;
    card.appendChild(epithet);

    const grade = document.createElement('div');
    grade.className = 'mc-pilot-grade';
    grade.textContent = `${COMBAT_GRADES[person.grade].label} ${COMBAT_GRADES[person.grade].title}`;
    card.appendChild(grade);

    const role = document.createElement('div');
    role.className = 'mc-pilot-role';
    role.textContent = `${person.role} ／ ${person.sex} ${person.age}`;
    card.appendChild(role);

    const ach = document.createElement('div');
    ach.className = 'mc-pilot-ach';
    ach.textContent = person.achievement;
    card.appendChild(ach);

    return card;
  }

  private highlight(): void {
    this.cardEls.forEach((el, i) => {
      if (i === this.index) el.classList.add('sel');
      else el.classList.remove('sel');
    });
    const sel = this.cardEls[this.index];
    // 横スクロールで隠れている候補も、選択に追従して見えるようにする
    sel?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.renderDetail();
  }

  /**
   * 画面が狭いとカード内の実績を数行に抑えるため、選択中の人物の情報を
   * 下段に全文で出す（情報を削らずに収める）。
   */
  private renderDetail(): void {
    const person = this.people[this.index];
    if (!person) return;
    this.detailEl.textContent = '';
    const head = document.createElement('div');
    head.className = 'mc-pilot-detail-head';
    head.textContent = `${protagonistDisplayName(person)} “${person.epithet}” ／ ${COMBAT_GRADES[person.grade].label} ${COMBAT_GRADES[person.grade].title} ／ ${person.role}`;
    const body = document.createElement('div');
    body.className = 'mc-pilot-detail-body';
    body.textContent = `${person.achievement}（${COMBAT_GRADES[person.grade].desc}）`;
    // 「選ぶと何が変わるのか」を明示する。盛らずに、実際に変わるものだけを書く。
    const effects = document.createElement('div');
    effects.className = 'mc-pilot-detail-effects';
    effects.textContent =
      `この選択で変わる: ${PROTAGONIST_EFFECTS.changes.join(' / ')}　` +
      `｜　変わらない: ${PROTAGONIST_EFFECTS.unchanged.join(' / ')}`;
    this.detailEl.append(head, body, effects);
  }

  private move(delta: number): void {
    if (this.decided || this.people.length === 0) return;
    this.index = (this.index + delta + this.people.length) % this.people.length;
    this.highlight();
  }

  /** 選択を確定する。二重発火しないよう、最初の1回だけ通す。 */
  private decide(): void {
    if (this.decided) return;
    const person = this.people[this.index];
    if (!person) return;
    this.decided = true;
    this.el.classList.add('decided');
    this.dispose();
    this.o.onSelect(person.id);
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.el.isConnected) {
      // 画面から外されたら自分で購読を切る（呼び出し側に解放義務を持たせない）
      this.dispose();
      return;
    }
    if (this.decided) return;
    // 押しっぱなしのキーリピートで決定が複数回走らないようにする
    if (ev.repeat) {
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      }
      return;
    }
    switch (ev.code) {
      case 'ArrowLeft':
      case 'ArrowUp':
        this.consume(ev);
        this.move(-1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        this.consume(ev);
        this.move(1);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        this.consume(ev);
        this.decide();
        break;
      default:
        break;
    }
  }

  /** ScreenHost のメニューへ同じキーを渡さない */
  private consume(ev: KeyboardEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
  }
}

const SKINS = ['#e3b899', '#d3a17f', '#a9724f', '#7d5136', '#f0cdb4'];
const HAIRS = ['#2b2622', '#3a2f28', '#1d1a19', '#5a4230', '#141414'];
const HAIR_STYLES: PortraitSpec['hairStyle'][] = ['short', 'long', 'buzz', 'tied', 'short'];
const EYES: PortraitSpec['eyes'][] = ['normal', 'sharp', 'wide', 'tired', 'normal'];

/**
 * 肖像画像が未整備の間に使う顔。人物 id から決まるので、同じ人物は常に同じ顔になる。
 * 画像を読まないので 404 は出ない。
 */
export function placeholderPortraitSpec(person: VeilPerson): PortraitSpec {
  let hash = 0;
  for (let i = 0; i < person.id.length; i++) hash = (hash * 31 + person.id.charCodeAt(i)) % 100003;
  const pick = <T>(list: readonly T[], salt: number): T => list[(hash + salt) % list.length];
  return {
    skin: pick(SKINS, 0),
    hair: pick(HAIRS, 1),
    hairStyle: pick(HAIR_STYLES, 2),
    eyes: pick(EYES, 3),
  };
}
