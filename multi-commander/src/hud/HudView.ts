import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { bus } from '../core/events';
import { settings } from '../app/settings';
import { clamp01 } from '../core/math';
import { isHostile } from '../content/factions';
import { gunDef, gunPresentation, missileDef } from '../content/weapons';
import { healthRatios, healthValues, type HealthValue } from '../sim/damage';
import { radarQuality, stateOf, SUBSYSTEMS } from '../sim/subsystems';
import { ittsPoint } from '../sim/targeting';
import { activeMissileSlot } from '../sim/weapons';
import type { ArmorFace, Entity } from '../world/entity';
import type { World } from '../world/world';
import { PILOTS } from '../content/pilots';
import { expressionFor, portraitFace } from '../ui/Portrait';
import { NavMap } from './NavMap';
import { edgeArrow, worldToScreen, type ScreenPoint } from './project';

export interface ObjectiveView {
  text: string;
  state: 'active' | 'done' | 'failed';
}

export interface HudFrame {
  world: World;
  camera: PerspectiveCamera;
  width: number;
  height: number;
  /** 入力レバーのスロットル値 */
  throttle: number;
  /** プレイヤー主砲の実弾速倍率。ITTS表示と弾道を一致させる。 */
  playerGunSpeedScale?: number;
  mouseFlight: boolean;
  stick?: { x: number; y: number };
  objectives?: ObjectiveView[];
  /** 現在向かっている Nav */
  nav?: Entity;
  /** マウス操縦の有効化待ち (カーソルを中央へ促す) */
  mouseArmPending?: boolean;
  /** オートパイロット作動中か */
  autopilot?: boolean;
  /** HUD 全体の表示 (メニュー中は false) */
  visible?: boolean;
}

const MAX_MARKERS = 28;
/** マーカーを出す最大距離 */
const MARKER_RANGE = 24000;
/** 障害物をレーダーに映す距離 (数が多いので至近だけ) */
const HAZARD_RADAR_RANGE = 3000;

interface RadioLine {
  el: HTMLElement;
  until: number;
}

interface PendingTorpedo {
  targetId?: number;
  targetPosition?: Vector3;
  targetRadius?: number;
  targetLabel?: string;
  expiresAt: number;
}

interface PendingExplosion {
  pos: Vector3;
  radius: number;
}

/**
 * コクピット計器と照準表示 (DOM + SVG)。
 * ロジックからは毎フレーム update() を呼ぶだけ。
 */
export class HudView {
  private root: HTMLElement;
  private hud: HTMLElement;

  // 上部オーバーレイ
  private lead: HTMLElement;
  private tgtBox: HTMLElement;
  private tgtLabel: HTMLElement;
  private tgtArrow: HTMLElement;
  private navArrow: HTMLElement;
  private navMarker: HTMLElement;
  private markerPool: HTMLElement[] = [];
  private markersUsed = 0;
  private announce: HTMLElement;
  private announceUntil = 0;
  private radioBox: HTMLElement;
  private radioLines: RadioLine[] = [];
  /** 口を動かしている顔 (声が終わったら止める) */
  private speakingFaces: Array<{ el: HTMLElement; speaker: string; until: number }> = [];
  private killFeed: HTMLElement;
  private killLines: RadioLine[] = [];
  private pendingTorpedoes: PendingTorpedo[] = [];
  private pendingExplosions: PendingExplosion[] = [];
  private playerFaction?: Entity['faction'];
  private objectivesBox: HTMLElement;
  private warnLock: HTMLElement;
  private warnMissile: HTMLElement;
  private warnShield: HTMLElement;
  private warnEject!: HTMLElement;
  private vignette: HTMLElement;
  private vignetteLevel = 0;
  private stickEl: HTMLElement;
  private autopilotEl: HTMLElement;
  private mouseHintEl!: HTMLElement;
  private cockpit: HTMLElement;
  private chrome: HTMLElement[] = [];

  // 計器
  private vduLeft: HTMLElement;
  private vduRight: HTMLElement;
  private gaugeEls: Record<string, { root: HTMLElement; fill: HTMLElement; val: HTMLElement }> = {};
  private speedEl: HTMLElement;
  private hullNum: HTMLElement;
  private shieldParts: Record<string, SVGElement> = {};
  private radarBlips: SVGCircleElement[] = [];
  private radarG: SVGGElement;
  private radarBox!: HTMLElement;
  private radarNoise = 1;

  /** D キーで右 VDU を武装/被害に切り替える */
  damageMode = false;
  /** V キーで切り替える、通常時の右 VDU ページ */
  private rightVduPage: 'tactical' | 'weapons' = 'tactical';
  /** N キーで開く航法マップ */
  readonly navMap: NavMap;
  private shown = true;

  private unsubs: Array<() => void> = [];
  private tmpScreen: ScreenPoint = { x: 0, y: 0, inFront: false, onScreen: false };
  private tmpV = new Vector3();
  private tmpQ = new Quaternion();

  constructor(container: HTMLElement) {
    this.root = container;
    this.hud = el('div', 'mc-hud');
    this.root.appendChild(this.hud);

    this.hud.appendChild(reticleSvg());
    this.lead = el('div', 'mc-lead');
    this.lead.appendChild(leadSvg());
    this.lead.style.display = 'none';
    this.hud.appendChild(this.lead);

    this.tgtBox = el('div', 'mc-tgtbox');
    this.tgtLabel = el('div', 'mc-tgtbox-label');
    this.tgtBox.appendChild(this.tgtLabel);
    this.tgtBox.style.display = 'none';
    this.hud.appendChild(this.tgtBox);

    this.tgtArrow = el('div', 'mc-arrow');
    this.tgtArrow.style.color = 'var(--enemy)';
    this.tgtArrow.style.display = 'none';
    this.hud.appendChild(this.tgtArrow);

    this.navArrow = el('div', 'mc-arrow');
    this.navArrow.style.color = 'var(--hud)';
    this.navArrow.style.display = 'none';
    this.hud.appendChild(this.navArrow);

    this.navMarker = el('div', 'mc-marker nav');
    this.navMarker.style.display = 'none';
    this.hud.appendChild(this.navMarker);

    this.announce = el('div', 'mc-announce');
    this.hud.appendChild(this.announce);

    this.radioBox = el('div', 'mc-radio');
    this.hud.appendChild(this.radioBox);
    this.killFeed = el('div', 'mc-killfeed');
    this.hud.appendChild(this.killFeed);
    this.objectivesBox = el('div', 'mc-objectives');
    this.hud.appendChild(this.objectivesBox);

    const warn = el('div', 'mc-warnlights');
    this.warnLock = el('span', 'lock');
    this.warnLock.textContent = 'ロックオン警告';
    this.warnMissile = el('span', 'missile');
    this.warnMissile.textContent = 'ミサイル接近';
    this.warnShield = el('span', 'shield');
    this.warnShield.textContent = 'シールド低下';
    this.warnEject = el('span', 'eject');
    this.warnEject.textContent = '脱出 — 救助待機';
    warn.append(this.warnLock, this.warnMissile, this.warnShield, this.warnEject);
    this.hud.appendChild(warn);

    this.vignette = el('div', 'mc-vignette');
    this.hud.appendChild(this.vignette);

    this.stickEl = el('div', 'mc-stick');
    this.stickEl.style.display = 'none';
    this.hud.appendChild(this.stickEl);

    this.autopilotEl = el('div', 'mc-autopilot');
    this.autopilotEl.style.display = 'none';
    this.hud.appendChild(this.autopilotEl);

    this.mouseHintEl = el('div', 'mc-mousehint');
    this.mouseHintEl.textContent = 'マウスを照準へ動かすと操縦できます (M でマウス操縦 OFF)';
    this.mouseHintEl.style.display = 'none';
    this.hud.appendChild(this.mouseHintEl);

    // ── コクピット ──
    // 風防の枠と柱は 3D 内装 (render/Cockpit.ts) が描くので、
    // DOM 側は計器パネルだけを重ねる
    const cockpit = el('div', 'mc-cockpit');
    this.cockpit = cockpit;

    // 3D 内装はカメラに追従するが、HUD の読み取り面は画面上の固定構図にする。
    // 16:9 の左右に余白を残し、4:3 に近い視界の中へ計器を収める。
    const cockpitFrame = el('div', 'mc-cockpit-frame');
    const leftPillar = el('div', 'mc-pillar left');
    const rightPillar = el('div', 'mc-pillar right');
    cockpit.append(cockpitFrame, leftPillar, rightPillar);

    const panels = el('div', 'mc-panels');
    this.vduLeft = el('div', 'mc-vdu left');
    this.vduRight = el('div', 'mc-vdu right');

    const center = el('div', 'mc-center');
    const gauges = el('div', 'mc-gauges');
    this.speedEl = el('div', 'mc-speed');
    gauges.appendChild(this.speedEl);
    for (const g of [
      { id: 'throttle', label: 'THROTTLE' },
      { id: 'energy', label: 'GUN PWR' },
      { id: 'fuel', label: 'AB FUEL' },
    ]) {
      gauges.appendChild(this.makeGauge(g.id, g.label));
    }

    const shieldBox = el('div', 'mc-shielddisp');
    const sl = el('div', 'mc-boxlabel');
    sl.textContent = 'SHIELDS / ARMOR';
    shieldBox.append(this.shieldSvg(), sl);
    this.hullNum = el('div', 'mc-hullnum');
    shieldBox.appendChild(this.hullNum);

    const radarBox = el('div', 'mc-radarbox');
    this.radarBox = radarBox;
    const rl = el('div', 'mc-boxlabel');
    rl.textContent = 'RADAR';
    const { svg, g } = radarSvg();
    this.radarG = g;
    radarBox.append(svg, rl);

    center.append(gauges, shieldBox, radarBox);
    panels.append(this.vduLeft, center, this.vduRight);
    // 計器盤の上端を走る梁と警告灯の列 (生成アセット)
    cockpit.appendChild(el('div', 'mc-dashtrim'));
    cockpit.appendChild(el('div', 'mc-lamprow'));
    cockpit.appendChild(panels);
    this.root.appendChild(cockpit);

    this.navMap = new NavMap(this.root);
    this.chrome.push(this.hud, cockpit);

    this.subscribe();
  }

  /** 視認性に直接関係しないコクピット装飾だけをまとめて切り替える。 */
  setCockpitDecorations(enabled: boolean): void {
    this.cockpit.classList.toggle('decorated', enabled);
    this.hud.classList.toggle('cockpit-decorated', enabled);
  }

  /** 任務をまたいで持ち越してはいけない HUD の一時表示を消す。 */
  resetTransientState(): void {
    this.announce.textContent = '';
    this.announce.className = 'mc-announce';
    this.announceUntil = 0;

    for (const line of this.radioLines) line.el.remove();
    this.radioLines = [];
    for (const line of this.killLines) line.el.remove();
    this.killLines = [];
    this.pendingTorpedoes = [];
    this.pendingExplosions = [];
    this.playerFaction = undefined;
    this.speakingFaces = [];

    this.objectivesBox.textContent = '';
    delete this.objectivesBox.dataset.sig;
    this.vignetteLevel = 0;
    this.vignette.style.opacity = '0';
    this.navMap.setOpen(false);
    this.rightVduPage = 'tactical';
  }

  toggleRightVduPage(): void {
    this.rightVduPage = this.rightVduPage === 'tactical' ? 'weapons' : 'tactical';
  }

  private makeGauge(id: string, label: string): HTMLElement {
    const root = el('div', 'mc-gauge');
    const lbl = el('div', 'lbl');
    const name = el('span');
    name.textContent = label;
    const val = el('span');
    lbl.append(name, val);
    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    bar.appendChild(fill);
    root.append(lbl, bar);
    this.gaugeEls[id] = { root, fill, val };
    return root;
  }

  private shieldSvg(): SVGSVGElement {
    const svg = svgEl('svg') as SVGSVGElement;
    svg.setAttribute('viewBox', '0 0 100 108');
    const add = (key: string, tag: string, attrs: Record<string, string>) => {
      const n = svgEl(tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.appendChild(n);
      this.shieldParts[key] = n;
      return n;
    };
    // シールド (前後の円弧)
    add('sf', 'path', { d: 'M 14 28 Q 50 2 86 28', fill: 'none', 'stroke-width': '5', stroke: '#5fd8ff' });
    add('sr', 'path', { d: 'M 14 86 Q 50 112 86 86', fill: 'none', 'stroke-width': '5', stroke: '#5fd8ff' });
    // アーマー4象限
    add('af', 'polygon', { points: '26,26 74,26 60,46 40,46' });
    add('ar', 'polygon', { points: '26,88 74,88 60,68 40,68' });
    add('al', 'polygon', { points: '26,26 40,46 40,68 26,88' });
    add('arr', 'polygon', { points: '74,26 60,46 60,68 74,88' });
    // ハル
    add('hull', 'rect', { x: '40', y: '46', width: '20', height: '22' });
    // 機体シルエット
    const sil = svgEl('path');
    sil.setAttribute('d', 'M 50 40 L 57 62 L 50 58 L 43 62 Z');
    sil.setAttribute('fill', 'rgba(205,239,221,0.55)');
    svg.appendChild(sil);
    return svg;
  }

  /** 声が鳴り終わった顔の口を止め、消えた行は追跡から外す */
  private stopFinishedSpeech(now: number): void {
    for (let i = this.speakingFaces.length - 1; i >= 0; i--) {
      const f = this.speakingFaces[i];
      if (!f.el.isConnected) {
        this.speakingFaces.splice(i, 1);
        continue;
      }
      if (f.until && now > f.until) {
        f.el.querySelector('.mc-face, .mc-portrait')?.classList.remove('speaking');
        this.speakingFaces.splice(i, 1);
      }
    }
  }

  private subscribe(): void {
    this.unsubs.push(
      bus.on('announce', (p) => {
        if (!p.text) return;
        this.announce.textContent = readableAnnouncement(p.text);
        this.announce.className = `mc-announce show ${p.kind ?? 'info'}`;
        this.announceUntil = performance.now() + (p.durationMs ?? 1800);
      }),
      bus.on('weaponFired', (p) => {
        if (!p.isPlayer || p.weaponKind !== 'missile' || p.weaponId !== 'torpedo') return;
        this.pendingTorpedoes.push({
          targetId: p.shooter.ship?.targetId,
          expiresAt: performance.now() + 22000,
        });
        while (this.pendingTorpedoes.length > 4) this.pendingTorpedoes.shift();
      }),
      bus.on('explosion', (p) => {
        if (p.kind !== 'missile') return;
        this.pendingExplosions.push({ pos: p.pos.clone(), radius: p.radius });
      }),
      bus.on('radio', (p) => {
        const line = el('div', `mc-radio-line ${p.tone ?? 'friendly'}`);
        line.style.fontSize = `${settings.subtitleScale}em`;
        // 喋っている人物の顔を出す (WC の VDU 相当)
        const pilot = PILOTS.find((x) => x.callsign === p.speaker);
        if (pilot) {
          const face = el('div');
          face.innerHTML = portraitFace(pilot.id, pilot.portrait, {
            size: 56,
            expression: expressionFor(p.text, p.tone),
            speaking: true,
          });
          line.appendChild(face);
          // 声が鳴り終わったら口を止める
          this.speakingFaces.push({ el: face, speaker: p.speaker, until: 0 });
        } else {
          // 顔が無い相手 (管制・敵・艦艇) は空欄で桁を揃える
          line.appendChild(el('div'));
        }
        const body = el('div', 'mc-radio-body');
        const who = el('span', 'who');
        who.textContent = `${p.speaker}:`;
        const txt = el('span');
        txt.textContent = p.text;
        body.append(who, txt);
        line.appendChild(body);
        this.radioBox.appendChild(line);
        this.radioLines.push({
          el: line,
          until: performance.now() + settings.radioDuration * 1000,
        });
        while (this.radioLines.length > 5) {
          const old = this.radioLines.shift()!;
          old.el.remove();
        }
      }),
      bus.on('radioVoice', (p) => {
        // 鳴っている秒数だけ口を動かす。指定が来る前は止めておく
        const now = performance.now();
        for (const f of this.speakingFaces) {
          if (f.speaker !== p.speaker || f.until > now) continue;
          f.until = now + p.seconds * 1000;
          f.el.querySelector('.mc-face, .mc-portrait')?.classList.add('speaking');
        }
      }),
      bus.on('destroyed', (p) => {
        if (p.target.kind !== 'ship') return;
        if (p.killedByPlayer) {
          for (const torpedo of this.pendingTorpedoes) {
            if (torpedo.targetId !== p.target.id) continue;
            torpedo.targetPosition = p.target.pos.clone();
            torpedo.targetRadius = p.target.radius;
            torpedo.targetLabel = p.target.label;
          }
        }
        const line = el('div', p.target.ship?.ace ? 'ace' : '');
        const who = p.target.ship?.pilot ?? p.target.label ?? '?';
        const star = p.target.ship?.ace ? '★ ' : '';
        line.classList.add(p.killedByPlayer ? 'destroyed' : 'impact');
        line.textContent = p.killedByPlayer ? `${star}${who} 撃破` : `${star}${who} 破壊`;
        this.killFeed.appendChild(line);
        this.killLines.push({ el: line, until: performance.now() + 5000 });
        while (this.killLines.length > 6) {
          const old = this.killLines.shift()!;
          old.el.remove();
        }
      }),
      bus.on('shieldHit', (p) => {
        if (p.isPlayer) this.vignetteLevel = Math.min(0.6, this.vignetteLevel + 0.14);
        else if (this.isHostileToPlayer(p.target)) this.pushCombatLine('命中確認 — シールド', 'hit');
      }),
      bus.on('armorHit', (p) => {
        if (p.isPlayer) this.vignetteLevel = Math.min(0.9, this.vignetteLevel + 0.3);
        else if (this.isHostileToPlayer(p.target)) {
          this.pushCombatLine(p.layer === 'hull' ? '命中確認 — 船体' : '命中確認 — 装甲', 'hit');
        }
      }),
    );
  }

  // ───────── 毎フレーム更新 ─────────

  update(f: HudFrame, dtReal: number): void {
    // メニュー表示中は計器類を丸ごと隠す
    const show = f.visible !== false;
    this.hud.classList.toggle('mc-colorblind', settings.colorblindMode);
    if (this.shown !== show) {
      this.shown = show;
      for (const n of this.chrome) n.style.display = show ? '' : 'none';
    }
    if (!show) {
      this.navMap.setOpen(false);
      return;
    }

    const now = performance.now();
    const player = f.world.player;
    this.playerFaction = player?.faction;

    this.expire(this.radioLines, now);
    this.expire(this.killLines, now);
    this.confirmTorpedoHits(f.world, now);
    this.stopFinishedSpeech(now);
    if (this.announceUntil && now > this.announceUntil) {
      this.announce.className = 'mc-announce';
      this.announceUntil = 0;
    }

    this.vignetteLevel = Math.max(0, this.vignetteLevel - dtReal * 1.6);
    this.vignette.style.opacity = String(this.vignetteLevel);

    this.mouseHintEl.style.display = f.mouseArmPending ? '' : 'none';

    if (f.stick && f.mouseFlight) {
      this.stickEl.style.display = '';
      this.stickEl.style.left = `${(f.stick.x * 0.5 + 0.5) * f.width}px`;
      this.stickEl.style.top = `${(f.stick.y * 0.5 + 0.5) * f.height}px`;
    } else {
      this.stickEl.style.display = 'none';
    }

    this.renderObjectives(f.objectives);
    this.navMap.update(f.world);

    if (f.autopilot && f.nav && player) {
      const d = f.nav.pos.distanceTo(player.pos);
      this.autopilotEl.style.display = '';
      this.autopilotEl.textContent = `AUTOPILOT  →  ${f.nav.label ?? 'NAV'}   ${(d / 1000).toFixed(1)}k`;
    } else {
      this.autopilotEl.style.display = 'none';
    }

    if (!player || !player.ship) {
      this.tgtBox.style.display = 'none';
      this.lead.style.display = 'none';
      this.hideMarkersFrom(0);
      return;
    }

    this.renderGauges(f, player);
    this.renderShieldDisplay(player);
    this.renderRadar(f, player);
    this.renderLeftVdu(player);
    this.renderRightVdu(f, player);
    this.renderWarnings(f, player);
    this.renderWorldMarkers(f, player);
  }

  private expire(lines: RadioLine[], now: number): void {
    while (lines.length && lines[0].until < now) {
      const old = lines.shift()!;
      old.el.remove();
    }
  }

  private isHostileToPlayer(target: Entity): boolean {
    return !!this.playerFaction && isHostile(this.playerFaction, target.faction);
  }

  private pushCombatLine(text: string, kind: 'hit' | 'torpedo'): void {
    const line = el('div', kind);
    line.textContent = text;
    this.killFeed.appendChild(line);
    this.killLines.push({ el: line, until: performance.now() + (kind === 'torpedo' ? 5200 : 2200) });
    while (this.killLines.length > 6) {
      const old = this.killLines.shift()!;
      old.el.remove();
    }
  }

  private confirmTorpedoHits(world: World, now: number): void {
    this.pendingTorpedoes = this.pendingTorpedoes.filter((torpedo) => torpedo.expiresAt > now);
    if (!this.pendingTorpedoes.length) {
      this.pendingExplosions = [];
      return;
    }
    if (!this.pendingExplosions.length) return;

    for (const explosion of this.pendingExplosions.splice(0)) {
      const match = this.pendingTorpedoes.findIndex((torpedo) => {
        const target = torpedo.targetId === undefined ? undefined : world.byId(torpedo.targetId);
        const targetPosition = target?.pos ?? torpedo.targetPosition;
        const targetRadius = target?.radius ?? torpedo.targetRadius ?? 0;
        if (!targetPosition) return false;
        return explosion.pos.distanceTo(targetPosition) <= explosion.radius + targetRadius * 1.5;
      });
      if (match < 0) continue;
      const targetId = this.pendingTorpedoes[match].targetId;
      const target = targetId === undefined ? undefined : world.byId(targetId);
      const targetLabel = target?.label ?? this.pendingTorpedoes[match].targetLabel;
      this.pendingTorpedoes.splice(match, 1);
      this.pushCombatLine(`魚雷命中${targetLabel ? ` — ${targetLabel}` : ''}`, 'torpedo');
    }
  }

  private renderObjectives(objs: ObjectiveView[] | undefined): void {
    if (!objs || objs.length === 0) {
      if (this.objectivesBox.childElementCount) this.objectivesBox.textContent = '';
      return;
    }
    const html = objs
      .map((o) => `<div class="${o.state}">${o.state === 'done' ? '✔' : o.state === 'failed' ? '✖' : '▸'} ${escapeHtml(o.text)}</div>`)
      .join('');
    if (this.objectivesBox.dataset.sig !== html) {
      this.objectivesBox.dataset.sig = html;
      this.objectivesBox.innerHTML = html;
    }
  }

  private renderGauges(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    const def = ship.def;
    const speed = player.vel.length();
    this.speedEl.innerHTML = `${speed.toFixed(0)} <small>KPS</small>`;

    this.setGauge('throttle', f.throttle, `${(f.throttle * 100) | 0}%`);
    const e = clamp01(ship.energy / def.energy);
    this.setGauge('energy', e, `${ship.energy.toFixed(0)}`, e < 0.2 ? 'bad' : e < 0.45 ? 'warn' : '');
    const fu = ship.fuelMax > 0 ? clamp01(ship.fuel / ship.fuelMax) : 0;
    this.setGauge('fuel', fu, `${ship.fuel.toFixed(1)}s`, fu < 0.15 ? 'bad' : fu < 0.35 ? 'warn' : '');
  }

  private setGauge(id: string, ratio: number, text: string, cls = ''): void {
    const g = this.gaugeEls[id];
    if (!g) return;
    g.fill.style.width = `${clamp01(ratio) * 100}%`;
    g.val.textContent = text;
    const want = `mc-gauge${cls ? ' ' + cls : ''}`;
    if (g.root.className !== want) g.root.className = want;
  }

  private renderShieldDisplay(player: Entity): void {
    const h = healthRatios(player);
    const setArc = (key: string, r: number) => {
      const n = this.shieldParts[key];
      n.setAttribute('stroke', barColor(r));
      n.setAttribute('opacity', String(0.18 + 0.82 * r));
    };
    setArc('sf', h.shieldFront);
    setArc('sr', h.shieldRear);
    const setPoly = (key: string, face: ArmorFace) => {
      const r = h.armor[face];
      const n = this.shieldParts[key];
      n.setAttribute('fill', barColor(r));
      n.setAttribute('opacity', String(0.14 + 0.72 * r));
      n.setAttribute('stroke', 'rgba(127,227,176,0.35)');
      n.setAttribute('stroke-width', '0.7');
    };
    setPoly('af', 'front');
    setPoly('ar', 'rear');
    setPoly('al', 'left');
    setPoly('arr', 'right');
    const hull = this.shieldParts['hull'];
    hull.setAttribute('fill', barColor(h.hull));
    hull.setAttribute('opacity', String(0.2 + 0.7 * h.hull));
    this.hullNum.textContent = `HULL ${(h.hull * 100) | 0}%`;
    this.hullNum.style.color = barColor(h.hull);
  }

  private renderRadar(f: HudFrame, player: Entity): void {
    // レーダー損傷: 品質が落ちると位置がぶれ、一部が映らなくなる
    const quality = radarQuality(player.ship);
    if (this.radarNoise !== quality) {
      this.radarNoise = quality;
      this.radarBox.classList.toggle('degraded', quality > 0 && quality < 1);
      this.radarBox.classList.toggle('dead', quality <= 0);
    }
    if (quality <= 0) {
      for (const blip of this.radarBlips) blip.setAttribute('visibility', 'hidden');
      return;
    }
    this.tmpQ.copy(player.quat).invert();
    const ships: Array<{ e: Entity; d: number }> = [];
    const hazards: Array<{ e: Entity; d: number }> = [];
    for (const e of f.world.entities) {
      if (!e.alive || e.id === player.id) continue;
      const isHazard = e.kind === 'rock' || e.kind === 'mine';
      if (e.kind !== 'ship' && e.kind !== 'missile' && !isHazard) continue;
      const d = e.pos.distanceTo(player.pos);
      // 障害物は数が多いので、ぶつかりうる至近距離のものだけ映す
      if (d > (isHazard ? HAZARD_RADAR_RANGE : MARKER_RANGE)) continue;
      (isHazard ? hazards : ships).push({ e, d });
    }
    ships.sort((a, b) => a.d - b.d);
    hazards.sort((a, b) => a.d - b.d);
    // 機体の枠を障害物で埋めてしまわないよう、枠を分けて確保する
    const targets = [...ships.slice(0, 18), ...hazards.slice(0, 6)];
    const n = targets.length;

    while (this.radarBlips.length < n) {
      const c = svgEl('circle') as SVGCircleElement;
      c.setAttribute('r', '2.6');
      this.radarG.appendChild(c);
      this.radarBlips.push(c);
    }
    for (let i = 0; i < this.radarBlips.length; i++) {
      const blip = this.radarBlips[i];
      if (i >= n) {
        blip.setAttribute('visibility', 'hidden');
        continue;
      }
      const { e } = targets[i];
      // 品質が低いほど映らない機体が増える
      if (quality < 1 && ((e.id * 2654435761) % 1000) / 1000 > quality + 0.25) {
        blip.setAttribute('visibility', 'hidden');
        continue;
      }
      this.tmpV.copy(e.pos).sub(player.pos).applyQuaternion(this.tmpQ).normalize();
      if (quality < 1) {
        // 位置をぶらす
        const j = (1 - quality) * 0.22;
        const t = performance.now() * 0.004 + e.id;
        this.tmpV.x += Math.sin(t) * j;
        this.tmpV.y += Math.sin(t * 1.31 + 1) * j;
        this.tmpV.z += Math.sin(t * 0.87 + 2) * j;
        this.tmpV.normalize();
      }
      // 機首 (-Z) を中心、真後ろを外周に
      const angle = Math.acos(Math.max(-1, Math.min(1, -this.tmpV.z)));
      const r = (angle / Math.PI) * 44;
      const az = Math.atan2(this.tmpV.x, this.tmpV.y);
      blip.setAttribute('cx', (r * Math.sin(az)).toFixed(2));
      blip.setAttribute('cy', (-r * Math.cos(az)).toFixed(2));
      blip.setAttribute('visibility', 'visible');
      let color: string;
      if (e.kind === 'rock') color = '#9a8f7d';
      else if (e.kind === 'mine') color = '#ff8a5a';
      else if (e.kind === 'missile') color = '#ffffff';
      else if (e.ship?.ace && isHostile(player.faction, e.faction)) color = '#ffd75e';
      else if (isHostile(player.faction, e.faction)) color = '#ff4d4d';
      else if (e.faction === player.faction) color = '#68e5ff';
      else color = '#ffd166';
      blip.setAttribute('fill', color);
      blip.setAttribute(
        'r',
        e.id === player.ship!.targetId
          ? '3.8'
          : e.kind === 'missile'
            ? '1.8'
            : e.kind === 'rock' || e.kind === 'mine'
              ? '1.6'
              : '2.6',
      );
    }
  }

  /** 左 VDU は常に自機の状態を表示する (本家の systems / damage display)。 */
  private renderLeftVdu(player: Entity): void {
    const ship = player.ship!;
    const h = healthRatios(player);
    const avgShield = (h.shieldFront + h.shieldRear) / 2;
    const avgArmor = (h.armor.front + h.armor.rear + h.armor.left + h.armor.right) / 4;
    const primary = ship.def.guns[0]?.gunId?.toUpperCase() ?? 'NONE';
    const body = [
      `<div class="name friend">${escapeHtml(ship.pilot ?? 'PILOT')} / ${escapeHtml(ship.def.name)}</div>`,
      `<div class="row"><span class="k">SHIELD</span><span style="color:${barColor(avgShield)}">${(avgShield * 100) | 0}%</span></div>`,
      `<div class="row"><span class="k">ARMOR</span><span style="color:${barColor(avgArmor)}">${(avgArmor * 100) | 0}%</span></div>`,
      `<div class="row"><span class="k">HULL</span><span style="color:${barColor(h.hull)}">${(h.hull * 100) | 0}%</span></div>`,
      `<div class="row"><span class="k">GUN PWR</span><span>${ship.energy.toFixed(0)} / ${ship.def.energy}</span></div>`,
      `<div class="row"><span class="k">PRIMARY</span><span>${escapeHtml(primary)}</span></div>`,
      `<div class="mc-vdu-section">SYSTEMS</div>`,
      `<div class="mc-status-chip ${stateOf(ship, 'radar') === 'ok' ? 'ok' : 'warn'}">RADAR　${stateOf(ship, 'radar') === 'ok' ? 'READY' : 'DEGRADED'}</div>`,
      `<div class="mc-status-chip ${stateOf(ship, 'gunsLeft') === 'ok' && stateOf(ship, 'gunsRight') === 'ok' ? 'ok' : 'warn'}">GUNS　${stateOf(ship, 'gunsLeft') === 'ok' && stateOf(ship, 'gunsRight') === 'ok' ? 'READY' : 'DAMAGED'}</div>`,
    ].join('');
    this.setVdu(this.vduLeft, 'SELF / SYSTEMS', body);
  }

  /** 右 VDU は target / nav / weapon / wingman を一つの戦術面に固定する。 */
  private renderRightVdu(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    if (this.damageMode) {
      const h = healthRatios(player);
      // 装甲・シールドの残量と、部位の生死を並べる
      const bar = (k: string, r: number) =>
        `<div class="mc-sys-line"><span class="k">${k}</span>` +
        `<span class="v ${r > 0.6 ? 'ok' : r > 0.25 ? 'warn' : 'bad'}">${(r * 100) | 0}%</span></div>`;
      const sys = (label: string, st: 'ok' | 'damaged' | 'dead') =>
        `<div class="mc-sys-line ${st}"><span class="k">${label}</span>` +
        `<span class="v ${st === 'ok' ? 'ok' : st === 'damaged' ? 'warn' : 'bad'}">` +
        `${st === 'ok' ? '正常' : st === 'damaged' ? '損傷' : '損失'}</span></div>`;

      const body =
        bar('シールド 前/後', (h.shieldFront + h.shieldRear) / 2) +
        bar('装甲 前', h.armor.front) +
        bar('装甲 後', h.armor.rear) +
        bar('装甲 左/右', (h.armor.left + h.armor.right) / 2) +
        bar('船体', h.hull) +
        '<div class="mc-sys-sep">システム</div>' +
        SUBSYSTEMS.map((info) => sys(info.label, stateOf(player.ship, info.id))).join('');
      this.setVdu(this.vduRight, 'DAMAGE  [D]', body, 'compact');
      return;
    }

    const target = f.world.byId(ship.targetId);
    const navDistance = f.nav ? f.nav.pos.distanceTo(player.pos) : 0;
    const navHtml = f.nav
      ? `<div class="row"><span class="k">NAV</span><span class="nav-value">${escapeHtml(f.nav.label ?? 'NAV')}</span></div>` +
        `<div class="row"><span class="k">DIST</span><span>${(navDistance / 1000).toFixed(1)}k</span></div>`
      : `<div class="row"><span class="k">NAV</span><span class="dim">STANDBY</span></div>` +
        `<div class="row"><span class="k">DIST</span><span>—</span></div>`;

    let targetHtml = '<div class="mc-vdu-empty mc-target-idle"><b>NO TARGET</b><span>T / R / Y で選択</span></div>';
    if (target?.ship) {
      const h = healthRatios(target);
      const values = healthValues(target);
      const d = target.pos.distanceTo(player.pos);
      const cls = target.ship.ace
        ? 'ace'
        : isHostile(player.faction, target.faction)
          ? 'enemy'
          : target.faction === player.faction
            ? 'friend'
            : '';
      const closing = this.tmpV.copy(target.vel).sub(player.vel).dot(
        this.tmpV.clone().copy(target.pos).sub(player.pos).normalize(),
      );
      const targetValue = (label: string, value: HealthValue): string =>
        `<span style="color:${barColor(value.max > 0 ? value.current / value.max : 0)}">${label} ${Math.round(value.current)}/${Math.round(value.max)}</span>`;
      const targetValues = (leftLabel: string, left: HealthValue, rightLabel: string, right: HealthValue): string =>
        `<span class="mc-target-values">${targetValue(leftLabel, left)}<span class="mc-target-gap"> </span>${targetValue(rightLabel, right)}</span>`;
      targetHtml = [
        `<div class="name ${cls}">${target.ship.ace ? '★ ' : ''}${escapeHtml(target.ship.pilot ?? target.label ?? '')}</div>`,
        `<div class="row"><span class="k">TYPE</span><span>${escapeHtml(target.ship.def.name)}</span></div>`,
        `<div class="row"><span class="k">DIST</span><span>${d.toFixed(0)}</span></div>`,
        `<div class="row"><span class="k">${closing < 0 ? 'CLOSING' : 'BREAKING'}</span><span>${Math.abs(closing).toFixed(0)}</span></div>`,
        `<div class="row"><span class="k">SHIELD F/R</span>${targetValues('F', values.shield.front, 'R', values.shield.rear)}</div>`,
        `<div class="row"><span class="k">ARMOR F/R</span>${targetValues('F', values.armor.front, 'R', values.armor.rear)}</div>`,
        `<div class="row"><span class="k">ARMOR L/R</span>${targetValues('L', values.armor.left, 'R', values.armor.right)}</div>`,
        `<div class="row"><span class="k">HULL</span><span style="color:${barColor(h.hull)}">${(h.hull * 100) | 0}%</span></div>`,
      ].join('');
    }

    const wing = f.world.entities.find(
      (e) => e.alive && e.id !== player.id && e.kind === 'ship' && e.faction === player.faction && !!e.ship,
    );
    const wingName = wing?.ship?.pilot ?? wing?.label ?? 'UNASSIGNED';
    const wingRatio = wing?.ship ? wing.ship.hull / Math.max(1, wing.ship.def.hull) : 0;
    const wingState = wing ? (wingRatio > 0.6 ? 'FORMED' : wingRatio > 0.2 ? 'DAMAGED' : 'CRITICAL') : 'NONE';
    const wingClass = wing ? (wingRatio > 0.6 ? 'ok' : wingRatio > 0.2 ? 'warn' : 'bad') : 'dim';
    const usableSlot = activeMissileSlot(player);

    const lines: string[] = [];
    for (let i = 0; i < ship.missiles.length; i++) {
      const m = ship.missiles[i];
      const def = missileDef(m.missileId);
      const active = i === (usableSlot?.index ?? ship.activeMissile);
      lines.push(
        `<div class="mc-weapon-line ${active ? 'active' : ''} ${m.count === 0 ? 'empty' : ''}">` +
          `<span>${active ? '▸ ' : '  '}${escapeHtml(def.name)}</span><span>${m.count}</span></div>`,
      );
    }
    if (lines.length === 0) lines.push('<div class="mc-vdu-empty">副兵装なし</div>');
    lines.push(`<div class="mc-weapon-line"><span>フレア</span><span>${ship.flares}</span></div>`);

    const selectedSlot = ship.missiles[ship.activeMissile];
    const slot = usableSlot ? ship.missiles[usableSlot.index] : selectedSlot;
    const def = slot ? missileDef(slot.missileId) : undefined;
    let lock = '';
    if (def && def.seeker !== 'none') {
      if (ship.lockedId !== undefined) {
        lock = '<div class="mc-lockstate locked"><span class="lock-meter"><i style="width:100%"></i></span>■ ロック完了</div>';
      }
      else if (ship.lockProgress > 0.02)
        lock = `<div class="mc-lockstate locking"><span class="lock-meter"><i style="width:${(ship.lockProgress * 100).toFixed(1)}%"></i></span>□ ロック中 ${(ship.lockProgress * 100) | 0}%</div>`;
      else lock = '<div class="mc-lockstate"><span class="lock-meter"><i style="width:0%"></i></span>□ ロック未完了</div>';
    } else if (def) {
      lock = '<div class="mc-lockstate ready"><span class="lock-meter"><i style="width:100%"></i></span>■ ロック不要 / 即時発射</div>';
    }
    const gun = ship.def.guns[0]?.gunId ? gunDef(ship.def.guns[0].gunId) : undefined;
    const selected = def?.name ?? gun?.name ?? '武装なし';
    const selectedUse =
      def?.description ?? (gun ? gunPresentation(gun).description : undefined) ?? '使用できる武装がありません';
    const ammo = def ? `${slot?.count ?? 0}` : gun ? '∞' : '—';
    const energyCost = gun?.energyCost ?? 0;
    const lockedTarget = ship.lockedId === undefined ? undefined : f.world.byId(ship.lockedId);
    const fireStatus = def
      ? missileFireStatus(ship, slot, def, lockedTarget)
      : gun
        ? gunFireStatus(ship, gun)
        : '発射不可 — 武装なし';
    const tacticalBody =
      `<div class="mc-vdu-section">TARGET</div>${targetHtml}` +
      `<div class="mc-vdu-section">NAV / WING</div>${navHtml}` +
      `<div class="row"><span class="k">WINGMAN</span><span class="${wingClass}">${escapeHtml(wingName)}</span></div>` +
      `<div class="row"><span class="k">STATUS</span><span class="${wingClass}">${wingState}</span></div>`;
    const weaponsBody =
      `<div class="mc-vdu-section">SELECTED WEAPON</div>` +
      `<div class="mc-weapon-selected">` +
      `<div class="row"><span class="k">SELECTED</span><span class="active-weapon">${escapeHtml(selected)}</span></div>` +
      `<div class="weapon-use">${escapeHtml(selectedUse)}</div>` +
      `<div class="row"><span class="k">AMMO</span><span>${ammo}</span></div>` +
      `<div class="row"><span class="k">ENERGY</span><span>${ship.energy.toFixed(0)} / ${ship.def.energy}${energyCost ? `　(−${energyCost}/shot)` : ''}</span></div>` +
      `<div class="mc-fire-status ${fireStatus.startsWith('発射不可') ? 'blocked' : fireStatus.includes('損傷') ? 'warn' : ''}">${escapeHtml(fireStatus)}</div>` +
      `</div>` +
      `<div class="mc-vdu-section">ORDNANCE</div>` +
      lines.join('') +
      lock;
    this.setVdu(
      this.vduRight,
      this.rightVduPage === 'tactical' ? 'TARGET / NAV  [V]' : 'WEAPONS  [V]',
      this.rightVduPage === 'tactical' ? tacticalBody : weaponsBody,
      this.rightVduPage === 'tactical' ? 'tactical' : 'weapons',
    );
  }

  private setVdu(box: HTMLElement, title: string, bodyHtml: string, extraClass = ''): void {
    const sig = title + bodyHtml + extraClass;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    // 行数の多い表示 (被害一覧) は詰めて全項目を収める
    const base = box.classList.contains('left') ? 'mc-vdu left' : 'mc-vdu right';
    box.className = extraClass ? `${base} ${extraClass}` : base;
    box.innerHTML = `<div class="mc-vdu-title">${title}</div>${bodyHtml}`;
  }

  private renderWarnings(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    const h = healthRatios(player);
    toggle(this.warnLock, ship.lockedByEnemy);
    toggle(this.warnMissile, !!f.world.byId(ship.incomingMissileId));
    toggle(this.warnShield, !ship.ejected && h.shieldFront < 0.2 && h.shieldRear < 0.2);
    toggle(this.warnEject, !!ship.ejected);
  }

  private renderWorldMarkers(f: HudFrame, player: Entity): void {
    const ship = player.ship!;
    const target = f.world.byId(ship.targetId);
    const w = f.width;
    const hgt = f.height;

    // ── ターゲット枠 ──
    if (target) {
      const p = worldToScreen(f.camera, target.pos, w, hgt, this.tmpScreen);
      if (p.onScreen) {
        // 距離に応じた枠の大きさ
        const d = Math.max(1, target.pos.distanceTo(player.pos));
        const px = Math.max(22, Math.min(320, (target.radius * 2.2 * hgt) / (2 * d * Math.tan((f.camera.fov * Math.PI) / 360))));
        this.tgtBox.style.display = '';
        this.tgtBox.style.left = `${p.x}px`;
        this.tgtBox.style.top = `${p.y}px`;
        this.tgtBox.style.width = `${px}px`;
        this.tgtBox.style.height = `${px}px`;
        const cls = target.ship?.ace
          ? 'mc-tgtbox ace'
          : isHostile(player.faction, target.faction)
            ? 'mc-tgtbox'
            : 'mc-tgtbox friend';
        if (this.tgtBox.className !== cls) this.tgtBox.className = cls;
        this.tgtLabel.textContent = `${target.label ?? ''} ${d.toFixed(0)}`;
        this.tgtArrow.style.display = 'none';
      } else {
        this.tgtBox.style.display = 'none';
        const a = edgeArrow(f.camera, target.pos, w, hgt, 40);
        this.tgtArrow.style.display = '';
        this.tgtArrow.style.left = `${a.x}px`;
        this.tgtArrow.style.top = `${a.y}px`;
        this.tgtArrow.style.transform = `translate(-50%,-50%) rotate(${-a.angleDeg}deg)`;
      }

      // ── ITTS リード表示 ──
      const leadPos = ittsPoint(player, target, this.tmpV, f.playerGunSpeedScale ?? 1);
      const lp = worldToScreen(f.camera, leadPos, w, hgt);
      if (lp.onScreen) {
        this.lead.style.display = '';
        this.lead.style.left = `${lp.x}px`;
        this.lead.style.top = `${lp.y}px`;
      } else {
        this.lead.style.display = 'none';
      }
    } else {
      this.tgtBox.style.display = 'none';
      this.tgtArrow.style.display = 'none';
      this.lead.style.display = 'none';
    }

    // ── Nav 表示 ──
    if (f.nav) {
      const p = worldToScreen(f.camera, f.nav.pos, w, hgt);
      const d = f.nav.pos.distanceTo(player.pos);
      if (p.onScreen) {
        this.navMarker.style.display = '';
        this.navMarker.style.left = `${p.x}px`;
        this.navMarker.style.top = `${p.y}px`;
        this.navMarker.textContent = `◇ ${f.nav.label ?? 'NAV'} ${(d / 1000).toFixed(1)}k`;
        this.navArrow.style.display = 'none';
      } else {
        this.navMarker.style.display = 'none';
        const a = edgeArrow(f.camera, f.nav.pos, w, hgt, 70);
        this.navArrow.style.display = '';
        this.navArrow.style.left = `${a.x}px`;
        this.navArrow.style.top = `${a.y}px`;
        this.navArrow.style.transform = `translate(-50%,-50%) rotate(${-a.angleDeg}deg)`;
      }
    } else {
      this.navMarker.style.display = 'none';
      this.navArrow.style.display = 'none';
    }

    // ── その他の機体マーカー ──
    let used = 0;
    const list: Array<{ e: Entity; d: number }> = [];
    for (const e of f.world.entities) {
      if (!e.alive || e.kind !== 'ship' || e.id === player.id) continue;
      if (target && e.id === target.id) continue;
      const d = e.pos.distanceTo(player.pos);
      if (d > MARKER_RANGE) continue;
      list.push({ e, d });
    }
    list.sort((a, b) => a.d - b.d);
    for (const { e, d } of list) {
      if (used >= MAX_MARKERS) break;
      const p = worldToScreen(f.camera, e.pos, w, hgt);
      if (!p.onScreen) continue;
      const m = this.marker(used++);
      const hostile = isHostile(player.faction, e.faction);
      const cls = `mc-marker ${hostile ? 'enemy' : e.faction === player.faction ? 'friend' : ''}`;
      if (m.className !== cls) m.className = cls;
      m.style.display = '';
      m.style.left = `${p.x}px`;
      m.style.top = `${p.y}px`;
      const shape = e.ship?.ace ? '★' : hostile ? '△' : e.faction === player.faction ? '○' : '◇';
      m.textContent = d > 3000 ? shape : `${shape} ${(d / 1000).toFixed(1)}k`;
      if (e.ship?.ace) m.style.color = 'var(--ace)';
      else m.style.color = '';
    }
    this.hideMarkersFrom(used);
  }

  private marker(i: number): HTMLElement {
    let m = this.markerPool[i];
    if (!m) {
      m = el('div', 'mc-marker');
      this.hud.appendChild(m);
      this.markerPool[i] = m;
    }
    return m;
  }

  private hideMarkersFrom(i: number): void {
    for (let k = i; k < this.markersUsed; k++) this.markerPool[k].style.display = 'none';
    this.markersUsed = i;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.navMap.dispose();
    this.hud.remove();
  }
}

// ───────── DOM/SVG ヘルパー ─────────

function el(tag: string, className = ''): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

function svgEl(tag: string): SVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElement;
}

function toggle(node: HTMLElement, on: boolean): void {
  const has = node.classList.contains('on');
  if (on && !has) node.classList.add('on');
  else if (!on && has) node.classList.remove('on');
}

function barColor(r: number): string {
  if (r > 0.6) return '#6fe38f';
  if (r > 0.3) return '#ffd166';
  return '#ff5d5d';
}

function gunFireStatus(ship: Entity['ship'], gun: ReturnType<typeof gunDef>): string {
  if (!ship) return '発射不可 — 機体なし';
  if (ship.energy < gun.energyCost) return '発射不可 — エネルギー不足';
  const gunStates = ship.def.guns.map((hp) =>
    stateOf(ship, ship.def.role === 'capital' ? 'turret' : hp.offset[0] < 0 ? 'gunsLeft' : 'gunsRight'),
  );
  if (gunStates.length > 0 && gunStates.every((state) => state === 'dead')) return '発射不可 — 砲損傷';
  if (gunStates.some((state) => state !== 'ok')) return '砲損傷 — 火力低下 / 不発あり';
  return '発射可能';
}

function missileFireStatus(
  ship: Entity['ship'],
  slot: { count: number } | undefined,
  def: ReturnType<typeof missileDef>,
  target?: Entity,
): string {
  if (!ship || !slot || slot.count <= 0) return '発射不可 — 弾切れ';
  if (def.seeker !== 'none' && ship.lockedId === undefined) return '発射不可 — ロック未完了';
  if (
    def.targetRole === 'capital' &&
    target?.ship &&
    target.ship.def.role !== 'capital' &&
    target.ship.def.role !== 'transport'
  ) {
    return '発射不可 — 大型目標のみ';
  }
  return '発射可能';
}

function readableAnnouncement(text: string): string {
  if (text === 'ロックしていない') return '発射不可 — ロック未完了';
  if (text === 'ミサイル切れ') return '発射不可 — 弾切れ';
  if (text === '対艦魚雷は大型目標を選択してください') return '発射不可 — 魚雷は大型目標のみ';
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function reticleSvg(): HTMLElement {
  const wrap = el('div', 'mc-reticle');
  wrap.innerHTML = `
    <svg viewBox="0 0 46 46" width="46" height="46">
      <g fill="none" stroke="#7fe3b0" stroke-width="1.2">
        <circle cx="23" cy="23" r="3.2"/>
        <path d="M 23 6 V 13 M 23 40 V 33 M 6 23 H 13 M 40 23 H 33"/>
        <path d="M 10 10 L 14 14 M 36 10 L 32 14 M 10 36 L 14 32 M 36 36 L 32 32" opacity="0.5"/>
      </g>
    </svg>`;
  return wrap;
}

function leadSvg(): SVGSVGElement {
  const svg = svgEl('svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 34 34');
  svg.innerHTML =
    '<g fill="none" stroke="#ffd166" stroke-width="1.4">' +
    '<circle cx="17" cy="17" r="8" stroke-dasharray="3 3"/>' +
    '<circle cx="17" cy="17" r="1.6" fill="#ffd166"/>' +
    '</g>';
  return svg;
}

function radarSvg(): { svg: SVGSVGElement; g: SVGGElement } {
  const svg = svgEl('svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '-50 -50 100 100');
  const bg = svgEl('g');
  bg.innerHTML =
    '<circle cx="0" cy="0" r="45" fill="rgba(10,25,20,0.55)" stroke="rgba(127,227,176,0.45)" stroke-width="1"/>' +
    '<circle cx="0" cy="0" r="22.5" fill="none" stroke="rgba(127,227,176,0.22)" stroke-width="0.8"/>' +
    '<path d="M -45 0 H 45 M 0 -45 V 45" stroke="rgba(127,227,176,0.18)" stroke-width="0.8"/>' +
    '<circle cx="0" cy="0" r="1.4" fill="rgba(127,227,176,0.6)"/>';
  svg.appendChild(bg);
  const g = svgEl('g') as SVGGElement;
  svg.appendChild(g);
  return { svg, g };
}
