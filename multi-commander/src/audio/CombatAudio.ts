import { Vector3, type PerspectiveCamera } from 'three';
import { bus } from '../core/events';
import { isHostile } from '../content/factions';
import { healthRatios } from '../sim/damage';
import type { World } from '../world/world';
import { audio } from './AudioManager';
import { MusicDirector } from './MusicDirector';
import { combatMusicCue } from './musicCues';

const _rel = new Vector3();
const _right = new Vector3();
const _camDir = new Vector3();

/**
 * イベントバスと音を繋ぐ層。
 * 距離減衰と左右のパンはカメラ姿勢から求める。
 */
export class CombatAudio {
  readonly music = new MusicDirector(audio);
  private unsubs: Array<() => void> = [];
  private camera?: PerspectiveCamera;

  constructor() {
    this.unsubs.push(
      bus.on('weaponFired', (p) => {
        const { distance, pan } = this.place(p.muzzle);
        if (p.weaponKind === 'gun') audio.gun(p.weaponId, p.isPlayer ? 0 : distance, pan);
        else audio.missileLaunch(p.isPlayer ? 0 : distance, pan);
      }),
      bus.on('shieldHit', (p) => {
        const { distance, pan } = this.place(p.point);
        audio.shieldHit(p.isPlayer ? 0 : distance, pan);
      }),
      bus.on('armorHit', (p) => {
        const { distance, pan } = this.place(p.point);
        audio.armorHit(p.isPlayer ? 0 : distance, pan);
      }),
      bus.on('explosion', (p) => {
        const { distance, pan } = this.place(p.pos);
        audio.explosion(distance, pan, false);
      }),
      bus.on('destroyed', (p) => {
        const { distance, pan } = this.place(p.target.pos);
        audio.explosion(distance, pan, true);
      }),
      bus.on('lockChanged', (p) => {
        if (p.locked) audio.lockTone(true);
      }),
      bus.on('autopilot', (p) => {
        audio.beep(p.active ? 1100 : 700, 0.12, 0.2, 'triangle');
      }),
      bus.on('navReached', () => audio.beep(1300, 0.1, 0.18, 'triangle')),
      bus.on('radio', (p) => {
        // 声の代替。喋っている長さを HUD に返して口を動かす
        const seconds = audio.radioVoice(p.text, p.tone ?? 'friendly', p.speaker);
        if (seconds > 0) bus.emit('radioVoice', { speaker: p.speaker, seconds });
      }),
      bus.on('missionEnded', (p) => {
        // 曲が切り替わるまでの間を短いジングルで埋める
        const base = p.outcome === 'win' ? [523, 659, 784] : [392, 330, 262];
        base.forEach((f, i) => setTimeout(() => audio.beep(f, 0.28, 0.22, 'triangle'), i * 180));
      }),
    );
  }

  setCamera(camera: PerspectiveCamera): void {
    this.camera = camera;
  }

  private place(pos: Vector3): { distance: number; pan: number } {
    if (!this.camera) return { distance: 0, pan: 0 };
    _rel.copy(pos).sub(this.camera.position);
    const distance = _rel.length();
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const pan = distance > 1e-3 ? _rel.divideScalar(distance).dot(_right) : 0;
    return { distance, pan };
  }

  /** 毎フレーム: 警報とエンジン音、BGM の盛り上がりを更新する */
  update(world: World, dt: number, active: boolean): void {
    const player = world.player;
    if (!active || !player?.ship) {
      audio.stopEngine();
      this.music.update(dt);
      return;
    }
    const ship = player.ship;
    const def = ship.def;
    const power = Math.min(1, player.vel.length() / Math.max(1, def.maxSpeed));
    audio.updateEngine(power, !!player.input?.afterburner && ship.fuel > 0, true);

    // 警報
    if (world.byId(ship.incomingMissileId)) audio.warning('missile');
    else if (ship.lockedByEnemy) audio.warning('lock');
    const h = healthRatios(player);
    if (h.shieldFront < 0.15 && h.shieldRear < 0.15 && h.hull < 0.6) audio.warning('shield');

    // ロック進行中の断続音
    if (ship.lockProgress > 0.02 && ship.lockProgress < 1) audio.lockTone(false);

    // 近くの敵の数で BGM の緊張度を決める
    let near = 0;
    let aceNearby = false;
    for (const e of world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
      if (!isHostile(player.faction, e.faction)) continue;
      if (e.pos.distanceToSquared(player.pos) < 6000 * 6000) {
        near++;
        aceNearby ||= !!e.ship.ace;
      }
    }
    this.music.playBattle(combatMusicCue(near, aceNearby));
    this.music.update(dt);
    void _camDir;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.music.stop();
  }
}
