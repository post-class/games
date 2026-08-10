/**
 * 第9章 OPERATION NINE MINUTES — ヴェガ門の内側（位相迷路）。
 *
 * 出典（正典）:
 * - `00_initila_constructions/05_story_改善/spec/ストーリー_十章作戦記録.html` CHAPTER 09
 * - 章メタ: `src/content/veil/chapters.ts` の `veil-ch09`（錨の4択は章側の `choice` が持つ）
 *
 * ■ この章の核心
 * 「門は過去を保存していない。選ばれなかった未来を反射している。」
 * 攻略手段は火力ではなく記憶で、迷路は座標ではなく**整合性**で進む。
 * 矛盾する三つの記録が並ぶとき、二つは反射である。
 *
 * ■ Nav 配置で「三つの記録／二つは反射」をどう表すか（F5の実装方針）
 * 迷路の各層に Nav を**必ず3つ**置く。うち2つは「事故が起きなかった時間線」＝反射で、
 * 到達しても目標は進まず、`onArrive` の無線が矛盾を告げる（帰投窓が遠ざかる演出）。
 * 実経路の Nav だけが `reachNav` の必須目標になっている。
 * つまり「どれを幻と呼べるか」の判断が、そのまま Nav 選択として現れる。
 *   層1: Nav1 オリオン港（反射・避難民がいない） / Nav2 ラグランジュ裂谷（反射・交戦線がない） / Nav3 灰冠回廊（実）
 *   層2: Nav4 格納庫（反射・拾えなかった者が笑っている） / Nav5 静穏海（反射・撃たなかった機雷原） / Nav6 公証中継所（実）
 * 反射側は自機に近く、実経路は遠い。「楽な道はいつも、選ばなかった方の未来」を距離で表現している。
 *
 * ■ F6（T6-9）で入れたもの
 * 1. **反射経路を踏むと帰投窓が縮む**: 反射 Nav に `reflection.penaltySeconds` を持たせた。
 *    層1は90秒、層2は110秒（奥ほど高い）。4つすべて踏むと計400秒が引かれ、
 *    残り140秒では実経路の巡航所要（約180秒）に届かない＝**楽な道を全部選ぶと帰れない**。
 *    実経路だけを踏めば所要は9分の3分の1程度で、交戦と読み取りに十分な余裕が残る。
 *    帰投窓は `MissionRunner` の `missionClock`（= 経過 + ペナルティ）で判定する。
 *    `elapsed` を直接進めないのは、無線の発火時刻や `recon` の進捗まで動いてしまうため。
 * 2. **反射 Nav は航法チェーンから外れている**: `nextNav` は index 最小の未到達 Nav しか
 *    見ないので、反射を通常 Nav として置くと必ず踏まされてしまう。`reflection` 宣言のある
 *    Nav は到達済みとして置かれ、踏んだ判定は `MissionRunner.updateReflections()` が行う。
 *    オートパイロットと HUD の誘導は実経路（NAV 3 → NAV 6 → …）だけを指す。
 * 3. **踏むほど幻影の僚機が増える**: `spawns[].afterReflections` を出現条件にした
 *    （1回・2回・3回で1群ずつ増える。「そちらへ進むほど僚機の声は増える」）。
 * 4. **過去章の無線を実際の選択から再生する**: `RadioLineDef.whenChoice` で
 *    第1章・第5章・第8章の選択idと突き合わせる。救難を優先した無線は**告発**として、
 *    追撃を選んだ無線は**謝罪**として返る。記録が無い出撃では `whenChoiceMissing` の
 *    台詞（どちらの意味にも転ぶ声）を出す。
 *    選択記録は `Loadout.choices` から受け取る（無ければ保存データを読む）。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

/** 無線・ブリーフィングの話者名。人物名簿を単一の出所にする */
const NEUROWM_01 = speakerName('neurowm-01');
const CONFED_07 = speakerName('confed-07');
const KILRASHI_03 = speakerName('kilrashi-03');

const scenery = theaterScenery('vega-gate');

export const VEIL_CH09: MissionDef = {
  id: 'veil-ch09',
  title: `第9章 ${veilChapter(9).title}`,
  system: 'ヴェガ門・内部位相域',
  briefingSpeaker: CONFED_07,
  briefingSpeakerId: 'confed-07',
  briefingSpeakerRole: '航法士・門解析員',
  briefing: [
    '五つ目の署名が入る直前に、急進派が奪取した制御核を起動しました。ヴェガ門は各艦を引き込み、そして返しません。あなたが見るのは、事故が起きなかった時間線です。',
    'ラグランジュ裂谷に交戦線はありません。オリオン港に避難民はいません。〈タイガーズ・クロー〉の格納庫には、第1章で拾えなかった者が立って笑っています。門は過去を保存していない。選ばれなかった未来を反射しているのです。',
    '攻略は座標ではなく整合性で進みます。矛盾する三つの記録が並ぶとき、二つは反射です。自分の航法ログと突き合わせ、実際に下した判断だけを踏んでください。楽な道はいつも、選ばなかった方の未来です。',
    '帰投窓は九分。一致しない記録が三つあるなら、二つは幻です。問題は、あなたがどれを幻と呼べるかです。',
  ],
  // F-54 ホーネット。撃つための出撃ではないので、専任機のまま入る。
  playerShipId: 'hornet',
  // 実僚機は連れない（迷路の中で聞こえる声はすべて反射である、という演出のため）。
  skybox: {
    // 遠景は戦域共通（`theaterScenery('vega-gate')`）を土台にするが、
    // ここは**門の内側**なので暖色の航路が走っている、という章の描写に合わせて
    // 星雲色・主星色だけを暖色へ上書きする。座標系（seed）と惑星は共通のままにして
    // 「同じヴェガ門である」ことは崩さない。
    ...scenery.skybox,
    nebulaHue: 0.08,
    sunColor: 0xffd2a0,
    nebulae: ['nebula-dust', 'nebula-violet'],
  },
  landmarks: scenery.landmarks,
  navs: [
    // ── 層1: 三つの記録（Nav1・Nav2 が反射、Nav3 が実経路） ──
    {
      name: 'NAV 1 (記録: オリオン港)',
      pos: [3200, 900, -8000],
      arriveRadius: 1600,
      // 反射。踏むと帰投窓が90秒縮む（層1の反射）
      reflection: { penaltySeconds: 90 },
      onArrive: [
        { speaker: CONTROL, text: 'オリオン港、避難民ゼロ。……そんな記録は存在しない。', tone: 'command' },
        { speaker: CONFED_07, text: '反射を踏みました。帰投窓が九十秒遠ざかりました。', tone: 'friendly', after: 2 },
        // 第1章で救難を選んだ者には、その救難が「告発」として返ってくる
        {
          speaker: '幻影の避難民',
          text: 'あなたは私たちを拾った。だから追えなかった機が、次の港を焼いた。',
          tone: 'friendly',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch01', choiceId: 'rescue' },
        },
        // 追撃を選んだ者には、拾われなかった者の「謝罪」として返ってくる
        {
          speaker: '幻影の救難信号',
          text: '追ってくれてよかった。……こちらが遅かっただけだ。すまなかった。',
          tone: 'friendly',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch01', choiceId: 'pursue' },
        },
        {
          speaker: CONFED_07,
          text: 'この層の声は、まだどちらの意味にも転びます。記録が薄いのです。',
          tone: 'friendly',
          after: 2.4,
          whenChoiceMissing: 'veil-ch01',
        },
      ],
    },
    {
      name: 'NAV 2 (記録: ラグランジュ裂谷)',
      pos: [-3600, -1100, -9000],
      arriveRadius: 1600,
      reflection: { penaltySeconds: 90 },
      onArrive: [
        { speaker: CONFED_07, text: '裂谷に交戦線がない。事故が起きなかった時間線です。', tone: 'friendly' },
        { speaker: CONTROL, text: '航法ログと一致しない。戻れ。帰投窓が縮んでいる。', tone: 'command', after: 2 },
        // 第5章で勝利を選んだ者には、その撃墜が「告発」として返る
        {
          speaker: KILRASHI_03,
          text: '貴様は決闘を終わらせた。私の名は、両軍のどの記録にも残らなかった。',
          tone: 'enemy',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch05', choiceId: 'victory' },
        },
        // 救出を選んだ者には、勝敗を持ち帰れなかった側の「謝罪」として返る
        {
          speaker: KILRASHI_03,
          text: '貴様は私を回収した。勝敗を未決のまま持ち帰らせて、悪かったと思っている。',
          tone: 'enemy',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch05', choiceId: 'save-ace' },
        },
      ],
    },
    {
      name: 'NAV 3 (記録: 灰冠回廊)',
      pos: [7400, -2000, -15500],
      arriveRadius: 1800,
      onArrive: [
        { speaker: CONFED_07, text: '灰の色が合っています。ここはあなたが実際に通った空です。', tone: 'friendly' },
        { speaker: KILRASHI_03, text: 'あの日おまえが下した判断だけが、この層に残っている。', tone: 'enemy', after: 2 },
      ],
    },
    // ── 層2: 三つの記録（Nav4・Nav5 が反射、Nav6 が実経路） ──
    {
      name: 'NAV 4 (記録: 母艦格納庫)',
      pos: [5000, 1400, -20000],
      arriveRadius: 1600,
      // 層2の反射は層1より高くつく（奥へ行くほど戻りが遠い）
      reflection: { penaltySeconds: 110 },
      onArrive: [
        { speaker: CLAW, text: '格納庫、総員異常なし。誰も欠けていない。', tone: 'friendly' },
        { speaker: CONFED_07, text: '第1章で拾えなかった者が笑っています。……幻です。', tone: 'friendly', after: 2 },
        {
          speaker: '幻影の僚機',
          text: 'あんたが拾ってくれたから、俺はここで笑っている。誰の代わりに笑っているかは聞かないでくれ。',
          tone: 'friendly',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch01', choiceId: 'rescue' },
        },
        {
          speaker: '幻影の僚機',
          text: '空欄で記録された名前だ。恨んでいない。……ただ、謝りたかった。',
          tone: 'friendly',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch01', choiceId: 'pursue' },
        },
      ],
    },
    {
      name: 'NAV 5 (記録: 静穏海)',
      pos: [-5200, 1200, -21000],
      arriveRadius: 1600,
      reflection: { penaltySeconds: 110 },
      onArrive: [
        { speaker: CONFED_07, text: '機雷原が消えている。撃たなかった方の未来です。', tone: 'friendly' },
        { speaker: CONTROL, text: 'それは記録ではない。願望だ。帰投窓が縮んだ。', tone: 'command', after: 2 },
        // 第8章の停戦：味方艦を守った側には「救えなかった敵の告発」が返る
        {
          speaker: '幻影の救難信号',
          text: 'あの一分、あなたは艦を守った。こちらの信号は誰にも拾われなかった。',
          tone: 'enemy',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch08', choiceId: 'guard-fleet' },
        },
        // 敵を救った側には、守られなかった味方艦の「謝罪」が返る
        {
          speaker: CLAW,
          text: 'あの一分、俺たちは自力で耐えた。手が足りないと言えなかった。すまん。',
          tone: 'friendly',
          after: 2.4,
          whenChoice: { chapterId: 'veil-ch08', choiceId: 'rescue-enemy' },
        },
      ],
    },
    {
      name: 'NAV 6 (記録: 公証中継所)',
      pos: [-1800, -2600, -27000],
      arriveRadius: 1800,
      onArrive: [
        { speaker: CONFED_07, text: '六十秒の記録が一致しました。整合しています、進んでください。', tone: 'friendly' },
      ],
    },
    // ── 中心 ──
    {
      name: 'NAV 7 (迷路の中心)',
      pos: [0, 600, -33000],
      arriveRadius: 2200,
      onArrive: [
        { speaker: NEUROWM_01, text: '中心に兵器はない。あるのはヴェイル網の航路設計図だ。', tone: 'friendly' },
        { speaker: KILRASHI_03, text: '私は撃った全員と再会した。名前は、まだ全部覚えている。', tone: 'enemy', after: 2 },
      ],
    },
    // ── 錨（現実側の声）。章末の4択は chapters.ts の `choice` が扱う ──
    {
      name: 'NAV 8 (錨点)',
      pos: [0, 0, 0],
      arriveRadius: 1600,
      onArrive: [
        { speaker: CONFED_07, text: '錨の声が届いています。その一人の声で戻ってください。', tone: 'friendly' },
      ],
    },
  ],
  spawns: [
    // 幻影の僚機。連邦機として現れるが、これは反射であって味方ではない。
    // 出現条件は「反射を何回踏んだか」。楽な道へ進むほど声が増える（`afterReflections`）。
    {
      shipId: 'hornet',
      count: 2,
      faction: 'confed',
      afterReflections: 1,
      delay: 3,
      offset: [900, 300, -600],
      spread: 700,
      tag: TAG.decoy,
      radio: [
        {
          speaker: '幻影の僚機',
          text: '追撃してくれて助かった。おかげで帰れたよ。……礼を言わせてくれ。',
          tone: 'friendly',
          whenChoice: { chapterId: 'veil-ch01', choiceId: 'pursue' },
        },
        {
          speaker: '幻影の僚機',
          text: '救難を選んだな。あの日拾われた俺が、この航路を奪った。……告発しに来た。',
          tone: 'friendly',
          whenChoice: { chapterId: 'veil-ch01', choiceId: 'rescue' },
        },
        {
          speaker: '幻影の僚機',
          text: '礼を言うべきか、謝るべきか、こちらにも判らない。門が順序を混ぜている。',
          tone: 'friendly',
          whenChoiceMissing: 'veil-ch01',
        },
        { speaker: CONFED_07, text: 'その船は帰っていません。門が順序を変えているだけです。', tone: 'friendly', after: 2 },
      ],
    },
    {
      shipId: 'scimitar',
      count: 2,
      faction: 'confed',
      afterReflections: 2,
      delay: 4,
      offset: [-1200, -400, -900],
      spread: 700,
      tag: TAG.decoy,
      radio: [
        { speaker: '幻影の僚機', text: '声が増えている。増えたぶんだけ、帰り道が遠い。', tone: 'friendly' },
        { speaker: CONTROL, text: '責める声も赦す声も、過去の無線の再編集だ。門は嘘をつかない。', tone: 'command', after: 2 },
      ],
    },
    // 三つ目以降は「楽な道を選び続けた者」にだけ聞こえる
    {
      shipId: 'scimitar',
      count: 2,
      faction: 'confed',
      afterReflections: 3,
      delay: 4,
      offset: [400, 900, -1400],
      spread: 900,
      tag: TAG.decoy,
      radio: [
        {
          speaker: '幻影の僚機',
          text: 'まだ来るのか。楽な道はいつも、選ばなかった方の未来だぞ。',
          tone: 'friendly',
        },
        { speaker: CONFED_07, text: '帰投窓が閉じかけています。実際に下した判断だけを踏んでください。', tone: 'friendly', after: 2 },
      ],
    },
    // 迷路の中心の二人。どちらも撃つ対象ではない。
    // ラギティカは誓約下でこの空間では交戦しないため、敵対テーブルを触らずに
    // `neutral` で置く（`setFactionStance` による切り替えは T6-9 / T6-10 の担当）。
    {
      shipId: 'kf03-greyhaul',
      count: 1,
      faction: 'neutral',
      atNav: 6,
      tag: TAG.support,
      speed: 60,
      ace: { pilot: 'ラギティカ' },
      radio: [
        { speaker: KILRASHI_03, text: '撃たない。ここでは、撃つ意味がない。', tone: 'enemy' },
      ],
    },
    // クラウン（原初核）。展開した航路設計図が `recon` の対象になる。
    {
      shipId: 'nc01-protocol',
      count: 1,
      faction: 'neurowm',
      atNav: 6,
      delay: 2,
      offset: [-800, 200, -1200],
      tag: TAG.survey,
      speed: 40,
      radio: [
        { speaker: NEUROWM_01, text: '設計図を展開する。読み取れ。持ち出せるのは一枚だけだ。', tone: 'friendly' },
      ],
    },
  ],
  objectives: [
    // 必須: 実経路の Nav だけを目標にする。反射の Nav1・Nav2・Nav4・Nav5 には目標を置かない。
    // 「整合する記録を選べたか」がそのまま進行条件になるため required。
    {
      id: 'ch09-layer1',
      text: '層1: 三つの記録のうち、航法ログと一致する層を踏む (NAV 3)',
      required: true,
      spec: { kind: 'reachNav', navIndex: 2 },
    },
    {
      id: 'ch09-layer2',
      text: '層2: 三つの記録のうち、航法ログと一致する層を踏む (NAV 6)',
      required: true,
      spec: { kind: 'reachNav', navIndex: 5 },
    },
    // 必須: 中心へ到達しないと設計図も錨も成立しない。
    {
      id: 'ch09-core',
      text: '迷路の中心へ到達する',
      required: true,
      spec: { kind: 'reachNav', navIndex: 6 },
    },
    // 必須: 第10章の三択は「設計図が示す事実」から始まるため、持ち帰りは物語上の前提。
    // 撃つのではなく読み取る行為なので `recon` を使う。
    {
      id: 'ch09-blueprint',
      text: 'クラウンが展開するヴェイル網の航路設計図を読み取る',
      required: true,
      spec: { kind: 'recon', tag: TAG.survey, seconds: 6, range: 1400, coneDeg: 24 },
    },
    // 必須: 錨の声へ戻ることが「脱出」そのもの。
    {
      id: 'ch09-anchor',
      text: '錨となる声のもとへ帰投する (NAV 8)',
      required: true,
      spec: { kind: 'reachNav', navIndex: 7 },
    },
    // 必須: 帰投窓（九分）。超過すれば門は返さない。この章の主題が時間なので required。
    // 反射経路を踏んだ秒数はここから引かれる（note に「反射 N 回 (−Xs)」が出る）。
    {
      id: 'ch09-window',
      text: '帰投窓 9 分以内に位相迷路を抜ける (反射を踏むほど縮む)',
      required: true,
      spec: { kind: 'timeLimit', seconds: 540 },
    },
    // 任意: 幻影の無線を照合して反射を特定する。
    // 攻略には不要（無視して実経路だけ踏んでもよい）ので required ではない。
    // 幻影は反射を踏むまで現れないので、この目標は「楽な道を選んだ者だけが払う代価」の側にある。
    {
      id: 'ch09-verify',
      text: '幻影の僚機の無線を照合し、反射を特定する',
      required: false,
      // 攻略には不要だが、未達のまま帰れば「未達成の条件」として軍令信用が下がる
      reward: '＋軍令信用',
      spec: { kind: 'recon', tag: TAG.decoy, seconds: 4, range: 1600, coneDeg: 30 },
    },
  ],
  openingRadio: [
    { speaker: CONFED_07, text: '門の内側です。航路が暖かい色をしている。……ここは現実ではありません。', tone: 'friendly' },
    {
      speaker: CONFED_07,
      text: '一致しない記録が三つあるなら、二つは幻です。問題は、あなたがどれを幻と呼べるかです。',
      tone: 'friendly',
      after: 3,
    },
    { speaker: CONTROL, text: '帰投窓は九分。座標ではなく整合性で進め。', tone: 'command', after: 3 },
  ],
  debriefWin: [
    '位相迷路を抜けた。持ち出せたのは航路設計図一枚と、記憶の一部だけだ。',
    'ラギティカが同行を求めてきた。撃った全員と再会した決闘士は、この空間の外へ自分の名前を持ち帰りたいと言っている。',
    'クラウンは残った。裂け目の内側を測り終えていないからだ。',
    '門は過去を保存していない。選ばれなかった未来を反射していただけだ。何を置いてきたかは、次の章の無線が教えてくれる。',
  ],
  debriefLoss: [
    '帰投窓が閉じた。門は引き込んだ艦を返さない。',
    '楽な道を選ぶほど、僚機の声は増えていった。増えた声のどれも、現実にはいない者の声だった。',
  ],
};
