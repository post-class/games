import { describe, expect, it } from 'vitest';
import { Mesh, Quaternion, Vector3 } from 'three';
import {
  BAND_DETAIL_MAX,
  BAND_SILHOUETTE_MAX,
  impactFlashScale,
  muzzleFlashScale,
  plumeVisibilityBoost,
  pointSpriteScale,
  rimShellScale,
  rimStrengthForBand,
  showsPointLight,
  TRACER_LENGTH_GAIN,
  tracerLengthScale,
  visibilityBand,
} from '../../src/render/Visibility';
import { RIM_COLORS, rimMaterial } from '../../src/render/ShipVisibility';
import {
  hardpointWorldPoint,
  localMuzzleOffset,
  worldMuzzlePoint,
} from '../../src/render/MuzzleAnchor';
import { createTracerMesh } from '../../src/render/MeshFactory';
import { gunDef } from '../../src/content/weapons';
import { HORNET } from '../../src/content/ships';

describe('距離帯ごとの見せ方', () => {
  it('1km 未満は detail、1〜3km は silhouette、3km 以上は point', () => {
    expect(visibilityBand(0)).toBe('detail');
    expect(visibilityBand(239)).toBe('detail');
    expect(visibilityBand(BAND_DETAIL_MAX - 1)).toBe('detail');
    expect(visibilityBand(BAND_DETAIL_MAX)).toBe('silhouette');
    expect(visibilityBand(1622)).toBe('silhouette');
    expect(visibilityBand(BAND_SILHOUETTE_MAX - 1)).toBe('silhouette');
    expect(visibilityBand(BAND_SILHOUETTE_MAX)).toBe('point');
    expect(visibilityBand(12000)).toBe('point');
  });

  it('縁光は影絵の帯 (1〜3km) が最も強く、近距離は塗装を残すため最も弱い', () => {
    const detail = rimStrengthForBand('detail');
    const silhouette = rimStrengthForBand('silhouette');
    const point = rimStrengthForBand('point');
    expect(silhouette).toBeGreaterThan(point);
    expect(point).toBeGreaterThan(detail);
    expect(detail).toBeGreaterThan(0);
  });

  it('縁光シェルは近距離で 2% だけ広がり、遠いほど外へ広がる', () => {
    expect(rimShellScale(0)).toBeCloseTo(1.02, 5);
    expect(rimShellScale(250)).toBeCloseTo(1.02, 5);
    expect(rimShellScale(1000)).toBeGreaterThan(rimShellScale(500));
    expect(rimShellScale(BAND_SILHOUETTE_MAX)).toBeCloseTo(1.12, 5);
    // 3km を超えても膨張し続けない
    expect(rimShellScale(20000)).toBeCloseTo(1.12, 5);
  });

  it('光点は 3km 以上でのみ出し、画面上の大きさが変わらないよう距離に比例する', () => {
    expect(showsPointLight(999)).toBe(false);
    expect(showsPointLight(2999)).toBe(false);
    expect(showsPointLight(3000)).toBe(true);
    // 戦闘機 (半径 15m) には出すが、艦艇 (半径 225m) は機体そのものが大きいので出さない
    expect(showsPointLight(3000, 15)).toBe(true);
    expect(showsPointLight(3000, 225)).toBe(false);
    expect(showsPointLight(30000, 225)).toBe(true);
    const near = pointSpriteScale(3000);
    const far = pointSpriteScale(9000);
    expect(far / near).toBeCloseTo(3, 5);
    // 近距離側でも潰れない下限を持つ
    expect(pointSpriteScale(0)).toBeGreaterThan(0);
  });

  it('エンジン光は 500m まで等倍で、3km 以上で最大 1.9 倍になる', () => {
    expect(plumeVisibilityBoost(0)).toBeCloseTo(1, 5);
    expect(plumeVisibilityBoost(500)).toBeCloseTo(1, 5);
    expect(plumeVisibilityBoost(1750)).toBeGreaterThan(1);
    expect(plumeVisibilityBoost(3000)).toBeCloseTo(1.9, 5);
    expect(plumeVisibilityBoost(30000)).toBeCloseTo(1.9, 5);
  });
});

describe('縁光マテリアルの共有と陣営色', () => {
  it('同じ陣営色・距離帯なら必ず同一インスタンス (機体ごとに作らない)', () => {
    expect(rimMaterial('hostile', 'silhouette')).toBe(rimMaterial('hostile', 'silhouette'));
    expect(rimMaterial('hostile', 'silhouette')).not.toBe(rimMaterial('friendly', 'silhouette'));
    expect(rimMaterial('hostile', 'silhouette')).not.toBe(rimMaterial('hostile', 'detail'));
  });

  it('敵は暖色、味方は寒色', () => {
    const hostile = RIM_COLORS.hostile;
    const friendly = RIM_COLORS.friendly;
    expect((hostile >> 16) & 0xff).toBeGreaterThan(hostile & 0xff);
    expect(friendly & 0xff).toBeGreaterThan((friendly >> 16) & 0xff);
  });

  it('距離帯ごとの強度がユニフォームに入る', () => {
    for (const band of ['detail', 'silhouette', 'point'] as const) {
      expect(rimMaterial('hostile', band).uniforms.uStrength.value).toBe(rimStrengthForBand(band));
    }
  });
});

describe('砲口閃光', () => {
  it('カメラのすぐ前 (自機の砲口) では小さく、遠方では等倍に近づく', () => {
    // 自機の砲身はカメラの十数 m 先。ここが大きいと「空中に浮いた黄色い丸」になる
    expect(muzzleFlashScale(12)).toBeLessThan(0.25);
    expect(muzzleFlashScale(70)).toBeCloseTo(1, 5);
    // 極端な距離でも上下に張り付く
    expect(muzzleFlashScale(0)).toBe(0.16);
    expect(muzzleFlashScale(100000)).toBe(1.5);
    expect(muzzleFlashScale(400)).toBeGreaterThan(muzzleFlashScale(100));
  });

  it('hardpoint 位置に張り付き、機体が動いても回っても砲身から離れない', () => {
    const hp = HORNET.guns[0];
    const pos = new Vector3(120, -40, 700);
    const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7);

    // 発射時: sim と同じ式で求めたワールド座標
    const muzzle = hardpointWorldPoint(hp.offset, HORNET.hardpointScale, pos, quat);
    // 描画側はローカルへ戻して保持する
    const local = localMuzzleOffset(muzzle, pos, quat);
    expect(local.x).toBeCloseTo(hp.offset[0] * HORNET.hardpointScale, 4);
    expect(local.y).toBeCloseTo(hp.offset[1] * HORNET.hardpointScale, 4);
    expect(local.z).toBeCloseTo(hp.offset[2] * HORNET.hardpointScale, 4);

    // 機体が移動・回転した次のフレームでも、閃光は同じ砲身の上にある
    const pos2 = new Vector3(200, 10, 300);
    const quat2 = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, 0.5).normalize(), 1.9);
    const expected = hardpointWorldPoint(hp.offset, HORNET.hardpointScale, pos2, quat2);
    const followed = worldMuzzlePoint(local, pos2, quat2);
    expect(followed.distanceTo(expected)).toBeLessThan(1e-4);
    // 機体位置そのものではなく、砲身のオフセットぶん離れている
    expect(followed.distanceTo(pos2)).toBeGreaterThan(0.5);
  });

  it('hardpoint が左右にあるので、左右の砲口は別の点になる', () => {
    const pos = new Vector3();
    const quat = new Quaternion();
    const points = HORNET.guns.map((g) =>
      hardpointWorldPoint(g.offset, HORNET.hardpointScale, pos, quat).clone(),
    );
    expect(points.length).toBeGreaterThan(1);
    expect(points[0].distanceTo(points[1])).toBeGreaterThan(0.5);
  });
});

describe('曳光弾', () => {
  it('長さは武器定義 GunDef.tracer が出所で、武器ごとの差が保たれる', () => {
    const laser = gunDef('laser');
    const lance = gunDef('ion-lance');
    expect(tracerLengthScale(laser.tracer)).toBeCloseTo(laser.tracer * TRACER_LENGTH_GAIN, 6);
    // 底上げしても武器間の比は定義どおり
    expect(tracerLengthScale(lance.tracer) / tracerLengthScale(laser.tracer)).toBeCloseTo(
      lance.tracer / laser.tracer,
      6,
    );
    // 「どこへ飛んだか分かる」ため、底上げは 1 より大きい
    expect(TRACER_LENGTH_GAIN).toBeGreaterThan(1);
    // 未定義・不正値でも 0 長にならない
    expect(tracerLengthScale(0)).toBeGreaterThan(0);
    expect(tracerLengthScale(Number.NaN)).toBeGreaterThan(0);
  });

  it('生成される弾体メッシュの長さが定義値に比例する', () => {
    const laser = gunDef('laser');
    const driver = gunDef('mass-driver');
    const lengthOf = (mesh: ReturnType<typeof createTracerMesh>): number =>
      Math.max(...mesh.children.map((c) => (c as Mesh).scale.z));

    const a = lengthOf(createTracerMesh(laser.color, laser.tracer, laser));
    const b = lengthOf(createTracerMesh(driver.color, driver.tracer, driver));
    expect(a).toBeGreaterThan(0);
    // 同じ fireMode 同士ではないので、比ではなく「定義値を反映していること」を確認する
    const a2 = lengthOf(createTracerMesh(laser.color, laser.tracer * 2, laser));
    expect(a2 / a).toBeCloseTo(2, 5);
    const b2 = lengthOf(createTracerMesh(driver.color, driver.tracer * 3, driver));
    expect(b2 / b).toBeCloseTo(3, 5);
  });
});

describe('命中閃光', () => {
  it('近距離は等倍、遠距離は点にならないよう拡大する', () => {
    expect(impactFlashScale(0)).toBeCloseTo(1, 5);
    expect(impactFlashScale(200)).toBeCloseTo(1, 5);
    expect(impactFlashScale(1000)).toBeGreaterThan(1);
    expect(impactFlashScale(2000)).toBeCloseTo(2.6, 5);
    expect(impactFlashScale(50000)).toBeCloseTo(2.6, 5);
  });
});
