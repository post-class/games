import {
  BufferGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface PlaceOpts {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
}

/**
 * 手続き生成メッシュの組み立て器。
 *
 * 細部を増やすとメッシュ数が増えてドローコールが膨らむので、
 * マテリアルごとにジオメトリをマージして、1機あたり数個のメッシュに畳む。
 */
export class PartBuilder {
  private groups = new Map<string, BufferGeometry[]>();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly v = new Vector3();
  private readonly s = new Vector3();

  /** 部品を1つ足す。geo は複製されるので呼び出し側で使い回してよい。 */
  add(geo: BufferGeometry, materialKey: string, o: PlaceOpts = {}): this {
    const g = geo.clone();
    const scale = o.scale ?? 1;
    this.v.set(...(o.pos ?? [0, 0, 0]));
    this.e.set(...(o.rot ?? [0, 0, 0]));
    this.q.setFromEuler(this.e);
    if (typeof scale === 'number') this.s.setScalar(scale);
    else this.s.set(...scale);
    this.m.compose(this.v, this.q, this.s);
    g.applyMatrix4(this.m);

    let list = this.groups.get(materialKey);
    if (!list) {
      list = [];
      this.groups.set(materialKey, list);
    }
    list.push(g);
    return this;
  }

  /** 左右対称に同じ部品を置く (x を反転)。rot の y,z も反転する。 */
  addMirrored(geo: BufferGeometry, materialKey: string, o: PlaceOpts): this {
    const pos = o.pos ?? [0, 0, 0];
    const rot = o.rot ?? [0, 0, 0];
    this.add(geo, materialKey, o);
    this.add(geo, materialKey, {
      ...o,
      pos: [-pos[0], pos[1], pos[2]],
      rot: [rot[0], -rot[1], -rot[2]],
    });
    return this;
  }

  /** マテリアル解決関数を受け取ってメッシュ群に畳む */
  build(resolve: (key: string) => Material): Group {
    const root = new Group();
    for (const [key, list] of this.groups) {
      if (list.length === 0) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, resolve(key));
      mesh.name = key;
      root.add(mesh);
    }
    this.groups.clear();
    return root;
  }
}
