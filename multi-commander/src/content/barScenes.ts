import { whenMatches, type RumorContext, type RumorWhen } from './barRumors';

/**
 * 酒場の「節目の一幕」。
 *
 * 酒場に入った瞬間、こちらが話しかける前に始まっている短い場面。
 * 噂（`barRumors.ts`）が「誰かの一言」であるのに対し、こちらは
 * **二人以上のやり取り**で、章や戦況の節目にだけ起きる。
 *
 * ■ 数値は動かさない
 * 見るだけの場面なので、関係値も4状態も動かさない。酒場は何度でも入れるので、
 * 入り直して稼げる場所を作らない（増減があるのは会話・割り込み・奢りだけ）。
 *
 * 話し手は「役」で書く。実際に誰が喋るかは席にいる隊員から選ばれるので、
 * 戦死・負傷で顔ぶれが変わっても場面が壊れない。
 */

/** 一幕の話し手の役 */
export type BarSceneRole =
  /** 酒保（必ず在室している） */
  | 'tender'
  /** 席にいる隊員のうち、最も付き合いが長い者 */
  | 'senior'
  /** 席にいる隊員のうち、最も付き合いが浅い者 */
  | 'junior';

export interface BarSceneLine {
  role: BarSceneRole;
  text: string;
}

export interface BarSceneDef {
  /** 安定キー */
  id: string;
  /** 一幕の見出し（何の場面かを一言で） */
  title: string;
  /** 出る条件。噂と同じ判定（`whenMatches`）を使う */
  when?: RumorWhen;
  lines: BarSceneLine[];
}

/**
 * 一幕の一覧。上から順に条件を見て、最初に合ったものを出す
 * （条件がきついものを先に置く）。
 */
export const BAR_SCENES: readonly BarSceneDef[] = [
  {
    id: 'fallen-empty-seat',
    title: '空いた席',
    when: { hasFallen: true },
    lines: [
      { role: 'tender', text: 'その席、まだ片付けてないの。誰も座らないから。' },
      { role: 'senior', text: '片付けなくていい。座らないのが、こっちの都合だ。' },
      { role: 'junior', text: '……いつまで、そのままにしておくんですか。' },
      { role: 'senior', text: '名前が名簿から消える日まで。消えない名前は、消えない席だ。' },
    ],
  },
  {
    id: 'wounded-back',
    title: '医務室帰り',
    when: { hasWounded: true },
    lines: [
      { role: 'junior', text: '医務室、出てきていいって言われたんですか。' },
      { role: 'senior', text: '言われてない。座ってるだけだ。座るのは治療の邪魔にならない。' },
      { role: 'tender', text: '水にしておくわね。あなたのぶんは、明日まで預かっておく。' },
    ],
  },
  {
    id: 'ace-oath-high',
    title: '相手の名前',
    when: { aceOathAbove: 66, chapterMin: 3 },
    lines: [
      { role: 'senior', text: '向こうの隊、こっちの機体番号を覚えてる。名乗ってから来る。' },
      { role: 'junior', text: '敵に名前を覚えられるのって、いいことなんですか。' },
      { role: 'senior', text: '撃つ前に一度考える相手が増える。悪いことじゃない。' },
    ],
  },
  {
    id: 'ace-oath-low',
    title: '名乗らない相手',
    when: { aceOathBelow: 34, chapterMin: 3 },
    lines: [
      { role: 'senior', text: '向こうはもう名乗らない。開いた周波数に、何も乗ってこない。' },
      { role: 'tender', text: '前は挨拶くらいはあったのにね。' },
      { role: 'junior', text: '……次に会うときは、話が通じないってことですか。' },
    ],
  },
  {
    id: 'command-trust-low',
    title: '補給の割当',
    when: { commandTrustBelow: 34, chapterMin: 2 },
    lines: [
      { role: 'junior', text: 'ミサイルの割当、また減ってました。書類の不備だって。' },
      { role: 'senior', text: '不備じゃない。順番を後ろにされてるんだ。理由は上が知ってる。' },
      { role: 'tender', text: '愚痴なら聞くけど、酒は増やせないの。そっちも割当だから。' },
    ],
  },
  {
    id: 'route-trust-high',
    title: '航路の礼',
    when: { routeTrustAbove: 66, chapterMin: 2 },
    lines: [
      { role: 'tender', text: '中立の商船からね。荷札に「通してくれた礼」って書いてあった。' },
      { role: 'senior', text: '航路を残したのが効いてる。撃たなかった日の分だ。' },
      { role: 'junior', text: '撃たなかったことが、礼になるんですね。' },
    ],
  },
  {
    id: 'returnees-low',
    title: '短い名簿',
    when: { returneesBelow: 25, chapterMin: 3 },
    lines: [
      { role: 'senior', text: '名簿が短い。連れて帰った数が、出た数に追いついてない。' },
      { role: 'junior', text: '……間に合わなかった、ということですか。' },
      { role: 'senior', text: '間に合わなかった。それも記録だ。次に間に合わせるための記録だ。' },
    ],
  },
  {
    id: 'late-chapter',
    title: '門の話',
    when: { chapterMin: 7 },
    lines: [
      { role: 'junior', text: '門って、閉めたら本当に終わるんですか。' },
      { role: 'senior', text: '終わらない。閉めた側が、閉めた理由を持ち続けるだけだ。' },
      { role: 'tender', text: 'その話、今週で四回目よ。答えが出るまで何回でもやるといい。' },
    ],
  },
  {
    id: 'first-days',
    title: '着任の日',
    when: { chapterMax: 2 },
    lines: [
      { role: 'tender', text: '新しい顔。割当は一人二杯まで、それだけ覚えて帰って。' },
      { role: 'senior', text: '覚えることは他にもある。だが今日はそれでいい。' },
      { role: 'junior', text: 'えっと……二杯って、飛ぶ前でも大丈夫なんですか。' },
    ],
  },
];

/**
 * 条件に合う一幕を1つ返す。無ければ `undefined`。
 *
 * `seed` は「同じ帰艦のあいだ同じ一幕になる」ようにするための種で、
 * 乱数は使わない（噂と同じ流儀）。
 */
export function barSceneFor(ctx: RumorContext, seed: number): BarSceneDef | undefined {
  const matched = BAR_SCENES.filter((scene) => whenMatches(scene.when, ctx));
  if (!matched.length) return undefined;
  const i = Math.abs(Math.floor(seed)) % matched.length;
  return matched[i];
}

/** データの取りこぼしを見つける（テストから呼ぶ） */
export function validateBarScenes(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const scene of BAR_SCENES) {
    if (seen.has(scene.id)) problems.push(`id 重複: ${scene.id}`);
    seen.add(scene.id);
    if (!scene.title.trim()) problems.push(`${scene.id}: 見出しが空`);
    if (scene.lines.length < 2) problems.push(`${scene.id}: 一幕が2行未満`);
    for (const line of scene.lines) {
      if (!line.text.trim()) problems.push(`${scene.id}: 空の台詞`);
    }
  }
  return problems;
}
