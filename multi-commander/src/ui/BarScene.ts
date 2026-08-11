import { PERSONALITIES, pilotDef, type PortraitSpec } from '../content/pilots';
import { relationStage, type PilotState } from '../app/roster';
import { PILOT_BOND_KINDS } from '../content/pilotBonds';
import { BARTENDER_PERSON_ID } from '../content/barRumors';
import { pilotDisplayName, type BarBanterView, type BarTalkView, type HubContext } from './HubPanels';
import { portraitFace } from './Portrait';
import { bustUrl, hasBustArt } from './Portrait';
import { escapeHtml } from './ScreenHost';

/**
 * 酒場を「絵の中の場面」として描く画面（本家 Wing Commander のレクリエーション室）。
 *
 * 表組みではなく、艦内バーの一枚絵の上に隊員の立ち絵を座席の位置へ置き、
 * 下端の会話ボックスで喋らせる。会話の進行そのものは
 * `src/app/barTalk.ts` / `src/app/barBanter.ts` が持ち、ここは表示だけを行う。
 *
 * 表示データは `HubContext`（`HubPanels.ts` の型）をそのまま受ける。
 * 従来の表組み版 `recRoomHtml()` は、席割りを渡さない呼び出し（古い保存データ・
 * 単体テスト）のために残してある。
 */

/** 立ち絵を置く位置。stage の左端からの % と、下端からの %。 */
interface SpotLayout {
  /** 立ち絵の中心の x（stage 幅に対する %） */
  x: number;
  /** 足元の y（stage 下端からの %）。奥の席は上げる */
  bottom: number;
  /** 立ち絵の高さ（stage 高さに対する %）。奥の席は小さくする */
  height: number;
  /** 同席2名のときの左右のずらし量（stage 幅に対する %） */
  spread: number;
  /** 席札を出す側 */
  align: 'left' | 'right';
}

/**
 * `public/art/tex/bg-bar.jpg` の構図に合わせた座席の位置。
 *
 * 背景は左手前にソファとローテーブル、中央奥に壁の紋章と扉、
 * 右にカウンターとスツール、右奥に酒棚。席 id は `src/app/barSeats.ts` の
 * `BAR_SEAT_SLOTS` と一致させる（増減はそちらが唯一の出所）。
 *
 * 高さは「頭が上端で切れない」かつ「足元の名札が会話ボックスに隠れない」
 * ように決めてある（1280×720 で確認）。
 */
const SPOTS: Record<string, SpotLayout> = {
  // 窓際のテーブル: 左手前のソファ。いちばん手前なので大きく出す
  'table-1': { x: 18, bottom: 9, height: 74, spread: 10, align: 'left' },
  // 奥のテーブル: 中央奥の暗がり。奥行きを出すため小さく、床から上げる
  'table-2': { x: 39, bottom: 27, height: 50, spread: 7, align: 'left' },
  // ビリヤード台: 中央右。カウンターの手前
  pool: { x: 56, bottom: 15, height: 62, spread: 8, align: 'right' },
  // カウンター: 右のスツール
  counter: { x: 76, bottom: 9, height: 72, spread: 10, align: 'right' },
};

/**
 * 立ち絵を置ける席 id。`BAR_SEAT_SLOTS` と一致していることを
 * `tests/ut/t9-bar-scene.test.ts` が確かめる（ずれると席の隊員が画面から消える）。
 */
export const BAR_SPOT_IDS: readonly string[] = Object.keys(SPOTS);

/** 酒保はカウンターの向こう側（右奥の酒棚の前）に立つ */
const BARTENDER_SPOT: SpotLayout = { x: 91, bottom: 31, height: 45, spread: 0, align: 'right' };

/** 1秒あたりの文字数。ブリーフィングと同じ速さにしてある */
const CPS = 30;

export interface BarSceneOptions {
  /** 部屋の一枚絵（`artUrl('tex/bg-bar','jpg')`） */
  background: string;
  ctx: HubContext;
}

export class BarScene {
  readonly el: HTMLElement;

  private readonly ctx: HubContext;
  /** 文字送り中の行 */
  private typing?: { el: HTMLElement; text: string; chars: number; startedAt?: number };
  private raf?: number;

  constructor(o: BarSceneOptions) {
    this.ctx = o.ctx;

    const root = document.createElement('div');
    root.className = 'mc-barroom';

    const stage = document.createElement('div');
    stage.className = 'mc-barroom-stage';
    // 部屋の絵は独立した層に置く。立ち絵を浮かせるため、こちらだけ
    // わずかにぼかして彩度を落とす（立ち絵側には効かせない）。
    const bg = document.createElement('div');
    bg.className = 'mc-barroom-bg';
    bg.style.backgroundImage = `url('${o.background}')`;
    stage.appendChild(bg);
    stage.insertAdjacentHTML('beforeend', this.stageHtml());

    const box = document.createElement('div');
    box.className = 'mc-barroom-box';
    box.innerHTML = this.boxHtml();

    root.append(stage, box);
    this.el = root;
  }

  /** 文字送りを始める。画面に載せた後に呼ぶ */
  start(): void {
    const el = this.el.querySelector<HTMLElement>('.mc-barroom-turn.now .said');
    if (el) {
      const text = el.dataset.text ?? '';
      el.textContent = '';
      this.typing = { el, text, chars: 0 };
      this.tick();
    }
  }

  /** 文字送りを飛ばして全文を出す */
  skip(): void {
    if (!this.typing) return;
    this.typing.el.textContent = this.typing.text;
    this.typing = undefined;
    this.stopSpeaking();
  }

  dispose(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
    this.typing = undefined;
  }

  // ───────── 部屋 ─────────

  private stageHtml(): string {
    const ctx = this.ctx;
    const seats = ctx.barSeats ?? [];
    const speaking = this.speakingIds();
    const active = this.activeIds();
    const parts: string[] = [];

    // 部屋の名前と、そのときの一言（席にいない人の気配）
    parts.push(
      `<div class="mc-barroom-plate"><b>酒場</b><span>レクリエーション室 — ${escapeHtml(
        String(ctx.roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded').length),
      )} 名在室</span></div>`,
    );

    for (const seat of seats) {
      const at = SPOTS[seat.id];
      if (!at || seat.occupants.length === 0) continue;
      const n = seat.occupants.length;
      const figs = seat.occupants.map((p, i) => {
        // 2名なら左右へ振り分ける。手前側（右）をわずかに大きくする
        const dx = n === 1 ? 0 : (i === 0 ? -at.spread : at.spread);
        const scale = n === 1 ? 1 : i === 0 ? 0.94 : 1;
        return this.figureHtml(p, {
          x: at.x + dx,
          bottom: at.bottom,
          height: at.height * scale,
          z: i,
          speaking: speaking.has(p.id),
          active: active.has(p.id),
          seatLabel: seat.label,
          align: at.align,
        });
      });
      parts.push(figs.join(''));
    }

    // 立ち飲み（席が足りなかった隊員）は扉の前に小さく並べる
    const standing = ctx.barStanding ?? [];
    standing.forEach((p, i) => {
      parts.push(
        this.figureHtml(p, {
          x: 30 + i * 7,
          bottom: 24,
          height: 54,
          z: 0,
          speaking: speaking.has(p.id),
          active: active.has(p.id),
          seatLabel: '立ったまま',
          align: 'left',
        }),
      );
    });

    // 酒保
    if (ctx.bartender) {
      parts.push(
        `<div class="mc-barroom-fig tender" style="${this.figStyle(BARTENDER_SPOT, 0)}">` +
          this.bustHtml(BARTENDER_PERSON_ID, undefined) +
          `<figcaption class="right"><b>${escapeHtml(ctx.bartender.name)}</b><span>酒保</span></figcaption>` +
          `</div>`,
      );
    }

    return parts.join('');
  }

  /**
   * 立ち絵の位置。重なり順は「右にいる人ほど手前」にする
   * （名札が左隣の立ち絵に潜らないようにするため）。
   */
  private figStyle(at: { x: number; bottom: number; height: number }, z: number): string {
    return (
      `left:${at.x}%;bottom:${at.bottom}%;height:${at.height}%;` +
      `z-index:${10 + Math.round(at.x) + z}`
    );
  }

  private figureHtml(
    p: PilotState,
    o: {
      x: number;
      bottom: number;
      height: number;
      z: number;
      speaking: boolean;
      active: boolean;
      seatLabel: string;
      align: 'left' | 'right';
    },
  ): string {
    const def = pilotDef(p.id);
    const stage = relationStage(p);
    const cls = [
      'mc-barroom-fig',
      o.speaking ? 'speaking' : '',
      o.active ? 'active' : '',
      p.status === 'wounded' ? 'wounded' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      `<div class="${cls}" data-pilot="${escapeHtml(p.id)}" style="${this.figStyle(o, o.z)}">` +
      this.bustHtml(def.personId, def.portrait) +
      `<figcaption class="${o.align}">` +
      `<b>${escapeHtml(def.callsign)}</b>` +
      `<span>${escapeHtml(pilotDisplayName(def))}</span>` +
      `<span class="sub">${escapeHtml(PERSONALITIES[def.personality].label)}` +
      `${p.status === 'wounded' ? ' ／ 負傷' : ''}` +
      ` ／ ${escapeHtml(stage.label)}</span>` +
      `</figcaption>` +
      `</div>`
    );
  }

  /** 立ち絵。無い人物は顔画像を丸く切り抜いて代わりに置く */
  private bustHtml(personId: string, portrait?: PortraitSpec): string {
    if (hasBustArt(personId)) {
      return `<img class="mc-barroom-bust" src="${bustUrl(personId)}" alt="" decoding="async">`;
    }
    // 立ち絵が無い人物のつなぎ。顔だけを丸く出す（欠けた枠を見せない）
    return (
      `<span class="mc-barroom-bust fallback">` +
      portraitFace(personId, portrait ?? { skin: '#e7c9a4', hair: '#2b2119', hairStyle: 'short', eyes: 'normal' }, {
        size: 120,
        scanlines: false,
      }) +
      `</span>`
    );
  }

  // ───────── 会話ボックス ─────────

  /** いま喋っている（＝直前の発言者の）パイロット id */
  private speakingIds(): Set<string> {
    const out = new Set<string>();
    const banter = this.ctx.barBanter;
    if (banter) {
      const last = [...banter.turns].reverse().find((t) => t.speaker !== 'player');
      if (last?.pilotId) out.add(last.pilotId);
      return out;
    }
    const talk = this.ctx.barTalk;
    if (talk) {
      out.add(talk.pilotId);
      return out;
    }
    const moment = this.ctx.barMoment;
    if (moment) {
      const last = [...moment.lines].reverse().find((l) => l.pilotId);
      if (last?.pilotId) out.add(last.pilotId);
    }
    return out;
  }

  /**
   * 会話の当事者。掛け合いなら二人とも当事者なので、
   * 喋っていない側も暗く落とさない（席の空気を二人で作っているため）。
   */
  private activeIds(): Set<string> {
    const banter = this.ctx.barBanter;
    if (banter) return new Set([banter.bond.a, banter.bond.b]);
    if (!this.ctx.barTalk && this.ctx.barMoment) {
      // 一幕の話し手は全員が当事者
      return new Set(
        this.ctx.barMoment.lines
          .map((l) => l.pilotId)
          .filter((id): id is string => !!id),
      );
    }
    return this.speakingIds();
  }

  private boxHtml(): string {
    const banter = this.ctx.barBanter;
    if (banter) return this.banterBoxHtml(banter);
    const talk = this.ctx.barTalk;
    if (talk) return this.talkBoxHtml(talk);
    return this.idleBoxHtml();
  }

  /** 1対1の会話 */
  private talkBoxHtml(talk: BarTalkView): string {
    const def = pilotDef(talk.pilotId);
    const turns = talk.turns.map((t, i) =>
      this.turnHtml(
        t.speaker === 'player' ? '自分' : def.callsign,
        t.text,
        t.speaker,
        i === talk.turns.length - 1 && t.speaker === 'pilot',
      ),
    );
    const cue = talk.replies.length
      ? `返事は下の「→」から選ぶ（${talk.replies.length} 択）`
      : 'この話は終わった。';
    return (
      this.vduHtml([talk.pilotId]) +
      `<div class="mc-barroom-said">` +
      `<div class="mc-barroom-who"><b>${escapeHtml(def.callsign)}</b>` +
      `<span>${escapeHtml(pilotDisplayName(def))} ／ ${escapeHtml(PERSONALITIES[def.personality].label)}</span>` +
      `<span class="rel">関係 ${escapeHtml(talk.relation.label)}</span></div>` +
      `<div class="mc-barroom-lines">${turns.join('')}</div>` +
      (talk.relation.reason ? `<div class="mc-barroom-reason">${escapeHtml(talk.relation.reason)}</div>` : '') +
      `<div class="mc-barroom-cue">${escapeHtml(cue)}</div>` +
      `</div>`
    );
  }

  /** 同席2名の掛け合いへの割り込み */
  private banterBoxHtml(view: BarBanterView): string {
    const a = pilotDef(view.bond.a);
    const b = pilotDef(view.bond.b);
    const kind = PILOT_BOND_KINDS[view.bond.kind as keyof typeof PILOT_BOND_KINDS];
    const turns = view.turns.map((t, i) => {
      const who = t.speaker === 'player' ? '自分' : t.pilotId ? pilotDef(t.pilotId).callsign : '';
      return this.turnHtml(
        who,
        t.text,
        t.speaker === 'player' ? 'player' : 'pilot',
        i === view.turns.length - 1 && t.speaker !== 'player',
      );
    });
    const cue = view.replies.length
      ? `下の「→」から割り込む（${view.replies.length} 択）`
      : 'もう口を挟む場面ではない。';
    return (
      this.vduHtml([view.bond.a, view.bond.b]) +
      `<div class="mc-barroom-said">` +
      `<div class="mc-barroom-who" data-kind="${escapeHtml(view.bond.kind)}">` +
      `<b>${escapeHtml(a.callsign)} と ${escapeHtml(b.callsign)}</b>` +
      `<span>${escapeHtml(kind?.label ?? '')} ／ ${escapeHtml(view.bond.title)}</span>` +
      `<span class="rel">二人の仲 ${escapeHtml(view.level.label)}</span></div>` +
      `<div class="mc-barroom-lines">${turns.join('')}</div>` +
      (view.reason ? `<div class="mc-barroom-reason">${escapeHtml(view.reason)}</div>` : '') +
      (view.outcome ? `<div class="mc-barroom-outcome">${escapeHtml(view.outcome)}</div>` : '') +
      `<div class="mc-barroom-cue">${escapeHtml(cue)}</div>` +
      `</div>`
    );
  }

  /**
   * 誰とも話していないとき。
   * 節目の一幕（`barMoment`）があればそれを、無ければ酒保の一言と噂を出す。
   */
  private idleBoxHtml(): string {
    const ctx = this.ctx;
    if (ctx.barMoment) return this.momentBoxHtml(ctx.barMoment);
    const rumors = (ctx.rumors ?? [])
      .map(
        (r) =>
          `<div class="mc-barroom-rumor"><span>${escapeHtml(r.source)}</span>${escapeHtml(r.text)}</div>`,
      )
      .join('');
    return (
      this.vduHtml([]) +
      `<div class="mc-barroom-said">` +
      (ctx.bartender
        ? `<div class="mc-barroom-who"><b>${escapeHtml(ctx.bartender.name)}</b><span>酒保</span></div>` +
          `<div class="mc-barroom-lines">${this.turnHtml('', ctx.bartender.line, 'pilot', true)}</div>`
        : '') +
      (rumors ? `<div class="mc-barroom-rumors">${rumors}</div>` : '') +
      `<div class="mc-barroom-cue">下の項目から話し相手を選ぶ。同じ席の二人には割り込める。</div>` +
      `</div>`
    );
  }

  /**
   * 節目の一幕。こちらが話しかける前に始まっている場面なので、
   * 返事は出さず、見出しと台詞だけを並べる。
   */
  private momentBoxHtml(moment: NonNullable<HubContext['barMoment']>): string {
    const faces = moment.lines
      .map((l) => l.pilotId)
      .filter((id): id is string => !!id)
      // 同じ人を二度出さない
      .filter((id, i, all) => all.indexOf(id) === i)
      .slice(0, 2);
    const turns = moment.lines
      .map((l, i) => this.turnHtml(l.who, l.text, 'pilot', i === moment.lines.length - 1))
      .join('');
    return (
      this.vduHtml(faces) +
      `<div class="mc-barroom-said">` +
      `<div class="mc-barroom-who"><b>${escapeHtml(moment.title)}</b>` +
      `<span>入ったときには、もう始まっていた</span></div>` +
      `<div class="mc-barroom-lines">${turns}</div>` +
      `<div class="mc-barroom-cue">下の項目から話し相手を選ぶ。同じ席の二人には割り込める。</div>` +
      `</div>`
    );
  }

  /** 話者の顔（通信 VDU 風）。喋っている間は口が動く */
  private vduHtml(pilotIds: string[]): string {
    if (!pilotIds.length) {
      const id = BARTENDER_PERSON_ID;
      return (
        `<div class="mc-barroom-vdu">` +
        portraitFace(id, { skin: '#e7c9a4', hair: '#2b2119', hairStyle: 'tied', eyes: 'normal' }, {
          size: 92,
          speaking: true,
        }) +
        `</div>`
      );
    }
    const speaking = this.speakingIds();
    const faces = pilotIds
      .map((id) => {
        const def = pilotDef(id);
        return portraitFace(def.id, def.portrait, {
          size: pilotIds.length > 1 ? 78 : 92,
          speaking: speaking.has(id),
        });
      })
      .join('');
    return `<div class="mc-barroom-vdu${pilotIds.length > 1 ? ' pair' : ''}">${faces}</div>`;
  }

  private turnHtml(who: string, text: string, speaker: 'pilot' | 'player', now: boolean): string {
    // 文字送り中の行は data-text に本文を持たせ、start() が1文字ずつ出す。
    // 本文は必ず `.said` に入れる（話者名まで消さないため）。
    return (
      `<p class="mc-barroom-turn ${speaker}${now ? ' now' : ''}">` +
      (who ? `<span class="who">${escapeHtml(who)}</span>` : '') +
      `<span class="said"${now ? ` data-text="${escapeHtml(text)}"` : ''}>` +
      `${now ? '' : escapeHtml(text)}</span>` +
      `</p>`
    );
  }

  // ───────── 文字送り ─────────

  private tick(): void {
    this.raf = requestAnimationFrame(() => this.tick());
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    const t = this.typing;
    if (!t) return;
    const now = performance.now();
    if (t.startedAt === undefined) t.startedAt = now;
    const want = Math.min(t.text.length, Math.floor(((now - t.startedAt) / 1000) * CPS));
    if (want === t.chars) return;
    t.chars = want;
    t.el.textContent = t.text.slice(0, want);
    if (want >= t.text.length) {
      this.typing = undefined;
      this.stopSpeaking();
    }
  }

  /** 喋り終わったら口の動きを止める */
  private stopSpeaking(): void {
    this.el.querySelectorAll('.mc-face.speaking').forEach((n) => n.classList.remove('speaking'));
    this.el.querySelectorAll('.mc-barroom-fig.speaking').forEach((n) => n.classList.add('spoke'));
  }
}
