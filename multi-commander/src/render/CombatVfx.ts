import type { Scene } from 'three';
import { bus } from '../core/events';
import { gunDef } from '../content/weapons';
import { settings } from '../app/settings';
import type { World } from '../world/world';
import type { CameraRig } from './CameraRig';
import { ShieldFx } from './ShieldFx';
import { VfxManager } from './Vfx';

const TRAIL_INTERVAL = 0.035;
/** 損傷煙を出す間隔 */
const SMOKE_INTERVAL = 0.09;

/**
 * イベントバスと VfxManager を繋ぐ層。
 * シミュレーション側は「何が起きたか」だけを飛ばし、見せ方はここが決める。
 */
export class CombatVfx {
  readonly vfx: VfxManager;
  /** シールドの被弾殻と波紋 */
  readonly shieldFx: ShieldFx;
  private unsubs: Array<() => void> = [];
  private trailTimer = 0;
  private smokeTimer = 0;

  constructor(scene: Scene, private rig: CameraRig, private hitStop: (ms: number) => void) {
    this.vfx = new VfxManager(scene);
    this.shieldFx = new ShieldFx(scene);

    this.unsubs.push(
      bus.on('weaponFired', (p) => {
        if (p.weaponKind === 'gun') {
          if (!settings.reducedFlashes) this.vfx.muzzleFlash(p.muzzle, gunDef(p.weaponId).color);
          if (p.isPlayer) this.rig.addShake(0.035);
        } else {
          this.vfx.explosion(p.muzzle, 8, 'small');
        }
      }),
      bus.on('shieldHit', (p) => {
        this.vfx.shieldSpark(p.point, p.isPlayer ? 1.6 : 1);
        // シールドが張られていることを、機体を包む殻と面の波紋で見せる
        const def = p.target.ship?.def;
        const cap = Math.max(1, ((def?.shield.front ?? 40) + (def?.shield.rear ?? 40)) * 0.25);
        this.shieldFx.hit(p.target.pos, p.point, p.target.radius, p.amount / cap);
        if (p.isPlayer) this.rig.addShake(settings.reducedFlashes ? 0.09 : 0.18);
      }),
      bus.on('armorHit', (p) => {
        const scale = p.isPlayer ? 1.8 : 1;
        if (p.layer === 'hull') this.vfx.hullHit(p.point, scale);
        else this.vfx.hitSpark(p.point, scale);
        if (p.isPlayer) this.rig.addShake(p.layer === 'hull' ? 0.42 : 0.3);
      }),
      bus.on('explosion', (p) => {
        this.vfx.explosion(p.pos, p.radius, p.kind);
      }),
      bus.on('destroyed', (p) => {
        const r = Math.max(14, p.target.radius * 1.3);
        this.vfx.explosion(p.target.pos, r, 'ship');
        if (p.killedByPlayer) {
          this.rig.addShake(0.22);
          this.hitStop(70);
        }
      }),
      bus.on('cameraShake', (p) => this.rig.addShake(p.strength)),
    );
  }

  /** 描画フレームごと: ミサイル/フレアの軌跡を出しつつ、エフェクトを進める */
  update(world: World, dt: number): void {
    this.shieldFx.update(dt);
    this.trailTimer += dt;
    if (this.trailTimer >= TRAIL_INTERVAL) {
      this.trailTimer = 0;
      for (const e of world.entities) {
        if (!e.alive) continue;
        if (e.kind === 'missile' && e.missile) {
          this.vfx.missileTrail(e.pos, e.missile.def.color);
        } else if (e.kind === 'flare') {
          this.vfx.flareGlow(e.pos);
        }
      }
    }
    // 損傷した機体は煙と火花を引く
    this.smokeTimer += dt;
    if (this.smokeTimer >= SMOKE_INTERVAL) {
      this.smokeTimer = 0;
      for (const e of world.entities) {
        if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
        const ratio = e.ship.hull / e.ship.def.hull;
        if (ratio > 0.6) continue;
        // 損傷が深いほど濃く、頻繁に出す
        const severity = 1 - ratio / 0.6;
        this.vfx.damageSmoke(e.pos, e.vel, e.radius, severity);
      }
    }

    this.vfx.update(dt);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.vfx.clear();
    this.shieldFx.clear();
  }
}
