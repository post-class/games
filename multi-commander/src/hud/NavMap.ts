import { Vector3 } from 'three';
import { isHostile } from '../content/factions';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

/**
 * 飛行中に開く航法マップ (N キー)。
 *
 * Nav ポイントの並びと、いま把握している機体・艦艇を上から見た図で示す。
 * 3D で自由に回せるものではなく、「どこへ向かうか」を判断するための平面図。
 */

interface Blip {
  x: number;
  y: number;
  kind:
    | 'nav'
    | 'navDone'
    | 'player'
    | 'friend'
    | 'enemy'
    | 'neutral'
    | 'capital'
    | 'rock'
    | 'mine';
  label?: string;
}

const _tmp = new Vector3();

export class NavMap {
  private root: HTMLElement;
  open = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'mc-navmap';
    this.root.style.display = 'none';
    container.appendChild(this.root);
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(v: boolean): void {
    this.open = v;
    this.root.style.display = v ? '' : 'none';
  }

  /** 開いている間だけ描き直す */
  update(world: World): void {
    if (!this.open) return;
    const player = world.player;
    if (!player) {
      this.root.innerHTML = '<div class="mc-navmap-title">航法マップ</div><div class="dim">自機喪失</div>';
      return;
    }

    const blips: Blip[] = [];
    const navs: Entity[] = [];
    for (const e of world.entities) {
      if (!e.alive) continue;
      if (e.kind === 'nav' && e.nav) {
        navs.push(e);
        blips.push({
          x: e.pos.x,
          y: e.pos.z,
          kind: e.nav.reached ? 'navDone' : 'nav',
          label: e.nav.name,
        });
      } else if (e.kind === 'rock' || e.kind === 'mine') {
        // 障害物は「その宙域の地形」なので、航路を考えられるように出す
        blips.push({ x: e.pos.x, y: e.pos.z, kind: e.kind });
      } else if (e.kind === 'ship' && e.ship) {
        const capital = e.ship.def.role === 'capital' || e.ship.def.role === 'transport';
        blips.push({
          x: e.pos.x,
          y: e.pos.z,
          kind:
            e.id === player.id
              ? 'player'
              : capital
                ? 'capital'
                : isHostile(player.faction, e.faction)
                  ? 'enemy'
                  : e.faction === player.faction
                    ? 'friend'
                    : 'neutral',
        });
      }
    }

    // 全要素が入る範囲を求める (自機は必ず含む)
    let minX = player.pos.x;
    let maxX = player.pos.x;
    let minY = player.pos.z;
    let maxY = player.pos.z;
    for (const b of blips) {
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x);
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y);
    }
    const span = Math.max(4000, Math.max(maxX - minX, maxY - minY) * 1.15);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const W = 420;
    const H = 300;
    const toPx = (x: number, y: number): [number, number] => [
      W / 2 + ((x - cx) / span) * (W - 60),
      H / 2 + ((y - cy) / span) * (H - 60),
    ];

    const parts: string[] = [];
    // Nav を結ぶ航路線
    navs.sort((a, b) => a.nav!.index - b.nav!.index);
    if (navs.length) {
      const path = navs
        .map((n, i) => {
          const [px, py] = toPx(n.pos.x, n.pos.z);
          return `${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`;
        })
        .join(' ');
      parts.push(
        `<path d="${path}" fill="none" stroke="rgba(127,227,176,0.4)" stroke-width="1" stroke-dasharray="4 4"/>`,
      );
      // 自機から次の Nav へ伸ばす線
      const next = navs.find((n) => !n.nav!.reached);
      if (next) {
        const [ax, ay] = toPx(player.pos.x, player.pos.z);
        const [bx, by] = toPx(next.pos.x, next.pos.z);
        parts.push(
          `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="rgba(255,209,102,0.6)" stroke-width="1"/>`,
        );
      }
    }

    for (const b of blips) {
      const [px, py] = toPx(b.x, b.y);
      switch (b.kind) {
        case 'player':
          parts.push(
            `<path d="M ${px} ${py - 6} L ${px + 4.5} ${py + 5} L ${px} ${py + 2.5} L ${px - 4.5} ${py + 5} Z" fill="#cdefdd"/>`,
          );
          break;
        case 'nav':
          parts.push(
            `<rect x="${px - 4}" y="${py - 4}" width="8" height="8" transform="rotate(45 ${px} ${py})" fill="none" stroke="#7fe3b0" stroke-width="1.4"/>`,
          );
          break;
        case 'navDone':
          parts.push(
            `<rect x="${px - 3}" y="${py - 3}" width="6" height="6" transform="rotate(45 ${px} ${py})" fill="rgba(127,227,176,0.35)"/>`,
          );
          break;
        case 'enemy':
          parts.push(`<circle cx="${px}" cy="${py}" r="3.2" fill="#ff4d4d"/>`);
          break;
        case 'friend':
          parts.push(`<circle cx="${px}" cy="${py}" r="3.2" fill="#5fd8ff"/>`);
          break;
        case 'rock':
          parts.push(`<circle cx="${px}" cy="${py}" r="2" fill="rgba(150,140,125,0.75)"/>`);
          break;
        case 'mine':
          parts.push(
            `<path d="M ${px} ${py - 3} L ${px + 3} ${py} L ${px} ${py + 3} L ${px - 3} ${py} Z" fill="rgba(255,120,90,0.9)"/>`,
          );
          break;
        case 'capital':
          parts.push(
            `<rect x="${px - 5}" y="${py - 2.5}" width="10" height="5" fill="rgba(255,209,102,0.85)"/>`,
          );
          break;
        default:
          parts.push(`<circle cx="${px}" cy="${py}" r="2.6" fill="#ffd166"/>`);
          break;
      }
      if (b.label) {
        parts.push(
          `<text x="${(px + 7).toFixed(1)}" y="${(py + 3.5).toFixed(1)}" font-size="9" fill="#8fbfa8">${escapeHtml(b.label)}</text>`,
        );
      }
    }

    // 距離の目安 (スケールバー)
    const barKm = span / 4;
    const barPx = ((W - 60) * barKm) / span;
    parts.push(
      `<line x1="20" y1="${H - 16}" x2="${20 + barPx}" y2="${H - 16}" stroke="#8fbfa8" stroke-width="1"/>` +
        `<text x="${24 + barPx}" y="${H - 12}" font-size="9" fill="#8fbfa8">${(barKm / 1000).toFixed(1)}k</text>`,
    );

    const next = navs.find((n) => !n.nav!.reached);
    const dist = next ? _tmp.copy(next.pos).sub(player.pos).length() : 0;

    this.root.innerHTML =
      `<div class="mc-navmap-title">航法マップ　<span class="dim">[N で閉じる]</span></div>` +
      `<svg viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>` +
      `<div class="mc-navmap-foot">` +
      (next
        ? `次の目的地: <b>${escapeHtml(next.nav!.name)}</b>　距離 ${(dist / 1000).toFixed(1)}k　` +
          `<span class="dim">A でオートパイロット</span>`
        : `<span class="dim">目的地なし</span>`) +
      `</div>`;
  }

  dispose(): void {
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
