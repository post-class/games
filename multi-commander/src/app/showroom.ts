import { Quaternion, Vector3 } from 'three';
import { shipDef } from '../content/ships';
import { spawnShip } from '../world/world';
import type { Entity } from '../world/entity';
import type { Game } from './game';

/**
 * 開発用のショールーム。
 *
 * 見た目を直したときの確認を一発で済ませるための道具。
 * 戦域から邪魔なものを消し、指定した機体を決めた角度・距離に置き、
 * 自機をそれを見る位置に固定する。誰も撃たないので絵が動かない。
 *
 * 製品の挙動には一切関与しない (`App.debug` からのみ呼ぶ)。
 */

export interface ShowcaseOptions {
  /** 自機からの距離 */
  dist?: number;
  /** 水平の回り込み角 (rad)。0 で真後ろ、PI/2 で真横 */
  azimuth?: number;
  /** 見下ろし角 (rad) */
  elevation?: number;
  /** 残ハル率。下げると損傷の見た目を確認できる */
  hullRatio?: number;
  /** シールドを剥がすか */
  stripShield?: boolean;
  /** 外部視点にするか */
  external?: boolean;
  /** 絵を止めるか (既定 true)。false なら噴射炎や煙が動く */
  freeze?: boolean;
}

export interface ShowcaseResult {
  shipId: string;
  dist: number;
  hullRatio: number;
}

/** 指定機体を1機だけ置いて、自機をその正面に固定する */
export function showcase(game: Game, shipId: string, o: ShowcaseOptions = {}): ShowcaseResult {
  const world = game.world;
  const player = world.player;
  if (!player) throw new Error('showcase: 自機がいない (先に出撃すること)');

  const dist = o.dist ?? 260;
  const az = o.azimuth ?? 0.9;
  const el = o.elevation ?? 0.22;

  // 自機以外を戦域から外す。撃たれると絵が動くので容赦なく消す
  for (const e of world.entities) {
    if (e.id === player.id) continue;
    if (e.kind === 'nav') continue;
    world.kill(e);
  }
  world.compact();

  // 自機は原点で静止
  player.pos.set(0, 0, 0);
  player.vel.set(0, 0, 0);
  player.quat.identity();
  if (player.input) {
    player.input.throttle = 0;
    player.input.firePrimary = false;
  }
  if (player.ship) {
    player.ship.hull = player.ship.def.hull;
    player.ship.shield.front = player.ship.def.shield.front;
    player.ship.shield.rear = player.ship.def.shield.rear;
  }

  // 見せる機体。中立にして誰にも撃たせない
  const def = shipDef(shipId);
  const pos = new Vector3(0, 0, -dist);
  const target = spawnShip(world, {
    def,
    faction: 'neutral',
    pos,
    quat: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), az),
    speed: 0,
    label: `SHOWCASE ${def.name}`,
    // AI を与えない。与えると巡航して画面から出ていく
  });
  target.vel.set(0, 0, 0);

  const ratio = Math.max(0.01, Math.min(1, o.hullRatio ?? 1));
  applyWear(target, ratio, o.stripShield ?? ratio < 1);

  // 自機を見上げ／見下ろしの位置へ置き、機体の方を向ける
  const eye = new Vector3(0, dist * Math.sin(el), dist * (1 - Math.cos(el)) - 0.001);
  player.pos.copy(eye);
  player.quat.setFromUnitVectors(
    new Vector3(0, 0, -1),
    pos.clone().sub(player.pos).normalize(),
  );
  player.renderPrevPos.copy(player.pos);
  player.renderPrevQuat.copy(player.quat);
  target.renderPrevPos.copy(target.pos);
  target.renderPrevQuat.copy(target.quat);

  game.rig.mode = o.external ? 'chase' : 'cockpit';
  // 既定では時間を止める。動くと撮るたびに絵が変わって比較できない
  game.paused = o.freeze === false ? false : true;

  return { shipId, dist, hullRatio: ratio };
}

/** 損傷した状態を作る (部位も壊す) */
function applyWear(e: Entity, hullRatio: number, stripShield: boolean): void {
  const ship = e.ship;
  if (!ship) return;
  ship.hull = ship.def.hull * hullRatio;
  if (stripShield) {
    ship.shield.front = 0;
    ship.shield.rear = 0;
    ship.armor.front = 0;
    ship.armor.left = 0;
  }
  const subs = ship.subsystems;
  if (hullRatio < 0.7 && subs) {
    // 見た目の確認用に部位をいくつか壊す
    const ids = Object.keys(subs) as Array<keyof typeof subs>;
    ids.forEach((id, i) => {
      if (hullRatio < 0.35) subs[id] = i % 2 === 0 ? 'dead' : 'damaged';
      else if (i % 3 === 0) subs[id] = 'damaged';
    });
  }
}
