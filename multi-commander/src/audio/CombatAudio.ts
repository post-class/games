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

export type CombatExplosionSize = 'small' | 'large' | 'torpedo';

/** 爆発イベントの既存情報だけで音の規模を選ぶ。新しい payload が無くても安全。 */
export function explosionAudioSize(
  kind: 'missile' | 'ship' | 'small',
  radius: number,
  detonation?: string,
): CombatExplosionSize {
  if (kind === 'small') return 'small';
  if (kind === 'ship') return 'large';
  if (detonation === 'torpedo') return 'torpedo';
  // 現行の対艦魚雷の blastRadius (70) にだけ合わせる。岩(最大84)や
  // 機雷(95)も kind=missile で通知されるため、単純な大小判定はしない。
  return Math.abs(radius - 70) <= 1 ? 'torpedo' : 'small';
}

/**
 * イベントバスと音を繋ぐ層。
 * 距離減衰と左右のパンはカメラ姿勢から求める。
 */
export class CombatAudio {
  readonly music = new MusicDirector(audio);
  private unsubs: Array<() => void> = [];
  private camera?: PerspectiveCamera;
  private playerId?: number;
  private wingmanId?: number;
  private playerMissileId?: string;
  private sequenceTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.unsubs.push(
      bus.on('weaponFired', (p) => {
        const { distance, pan } = this.place(p.muzzle);
        if (p.weaponKind === 'gun') audio.gun(p.weaponId, p.isPlayer ? 0 : distance, pan);
        else {
          if (p.isPlayer) this.playerMissileId = p.weaponId;
          audio.missileLaunch(p.weaponId, p.isPlayer ? 0 : distance, pan);
        }
      }),
      bus.on('shieldHit', (p) => {
        const { distance, pan } = this.place(p.point);
        audio.shieldHit(p.isPlayer ? 0 : distance, pan, p.weaponId);
      }),
      bus.on('armorHit', (p) => {
        const { distance, pan } = this.place(p.point);
        audio.armorHit(p.isPlayer ? 0 : distance, pan, p.layer, p.weaponId);
      }),
      bus.on('explosion', (p) => {
        const { distance, pan } = this.place(p.pos);
        audio.explosion(distance, pan, explosionAudioSize(p.kind, p.radius, p.detonation));
      }),
      bus.on('destroyed', (p) => {
        const { distance, pan } = this.place(p.target.pos);
        // ミサイル起爆では直後に explosion イベントが来るため、そこで
        // 小型/魚雷を鳴らし、ここでは船体撃破音を二重にしない。
        if (p.reason !== 'enemy-missile' && p.reason !== 'friendly-missile') {
          audio.explosion(distance, pan, 'large');
        }
        if (p.target.ship?.ace) {
          audio.motif('nemesis');
          this.music.playBattle('boss');
        }
        const isWingman =
          p.target.id === this.wingmanId ||
          (this.playerId !== undefined &&
            p.target.id !== this.playerId &&
            p.target.ship?.def.role === 'fighter' &&
            p.target.ai?.leaderId === this.playerId);
        if (isWingman) audio.motif('wingman');
      }),
      bus.on('wingmanInTrouble', (p) => {
        if (
          p.entity.id === this.wingmanId ||
          (this.playerId !== undefined && p.entity.ai?.leaderId === this.playerId)
        ) {
          audio.motif('wingman');
        }
      }),
      bus.on('lockChanged', (p) => {
        audio.lockTone(p.locked, this.playerMissileId);
      }),
      bus.on('weaponDenied', (p) => {
        if (!p.isPlayer) return;
        const frequency =
          p.reason === 'energy'
            ? 180
            : p.reason === 'damaged'
              ? 240
              : p.reason === 'no-lock'
                ? 360
                : p.reason === 'invalid-target'
                  ? 430
                  : 280;
        audio.beep(frequency, 0.08, 0.16, 'square');
      }),
      bus.on('autopilot', (p) => {
        audio.beep(p.active ? 1100 : 700, 0.12, 0.2, 'triangle');
      }),
      bus.on('navReached', (p) => {
        audio.beep(1300, 0.1, 0.18, 'triangle');
        if (p.name === '帰投') audio.motif('carrier');
      }),
      bus.on('radio', (p) => {
        // 声の代替。喋っている長さを HUD に返して口を動かす
        const seconds = audio.radioVoice(p.text, p.tone ?? 'friendly', p.speaker);
        if (seconds > 0) bus.emit('radioVoice', { speaker: p.speaker, seconds });
      }),
      bus.on('missionEnded', (p) => {
        // 曲が切り替わるまでの間を短いジングルで埋める
        const base = p.outcome === 'win' ? [523, 659, 784] : [392, 330, 262];
        base.forEach((f, i) => {
          const timer = setTimeout(() => {
            this.sequenceTimers.delete(timer);
            audio.beep(f, 0.28, 0.22, 'triangle');
          }, i * 180);
          this.sequenceTimers.add(timer);
        });
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
      this.playerId = undefined;
      this.wingmanId = undefined;
      this.playerMissileId = undefined;
      audio.stopEngine();
      audio.setMusicDuck(1);
      this.music.update(dt);
      return;
    }
    this.playerId = player.id;
    this.wingmanId = world.entities.find(
      (e) =>
        e.alive &&
        e.id !== player.id &&
        e.kind === 'ship' &&
        e.faction === player.faction &&
        e.ship?.def.role === 'fighter' &&
        e.ai?.leaderId === player.id,
    )?.id;
    const ship = player.ship;
    const def = ship.def;
    this.playerMissileId = ship.missiles[ship.activeMissile]?.missileId;
    const power = Math.min(1, player.vel.length() / Math.max(1, def.maxSpeed));
    audio.updateEngine(
      power,
      !ship.ejected && !!player.input?.afterburner && ship.fuel > 0,
      !ship.ejected,
      `${def.role}:${def.id}`,
    );

    // 警報
    const incoming = world.byId(ship.incomingMissileId);
    if (incoming?.missile) audio.warning('missile', incoming.missile.def.id);
    else if (ship.lockedByEnemy) audio.warning('lock');
    const h = healthRatios(player);
    if (h.shieldFront < 0.15 && h.shieldRear < 0.15 && h.hull < 0.6) audio.warning('shield');

    // ロック進行中の断続音
    if (ship.lockProgress > 0.02 && ship.lockProgress < 1) audio.lockTone(false, this.playerMissileId);

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
    audio.setMusicDuck(near >= 3 ? 0.78 : near >= 1 ? 0.9 : 1);
    this.music.update(dt);
    void _camDir;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const timer of this.sequenceTimers) clearTimeout(timer);
    this.sequenceTimers.clear();
    this.music.stop();
  }
}
