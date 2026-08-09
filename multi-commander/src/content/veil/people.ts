/**
 * THE VEIL FRONT 人物名簿（全76名）。
 *
 * 出典（正典）:
 * - `00_initila_constructions/05_story_改善/spec/登場人物_人物名鑑.html` の `factions` 配列（人物データ本体）
 * - `00_initila_constructions/05_story_改善/spec/ストーリー_十章作戦記録.html`（主要人物の指定）
 *
 * ■ P0-1 の決定（2026-08-09）
 * 名鑑HTMLは `factions[0].people.slice(20)` で人類名簿の先頭20名を落としており、
 * その結果、十章作戦記録が主要人物に指定している12名（朝倉 澪ほか）が名鑑データから欠落していた。
 * これは資料側の不具合と判断し、**物語spec（正典1位）を優先して12名を名簿に含める**。
 * したがって人類36名の構成は次のとおり。
 * - `confed-01`〜`confed-12`: 物語の主要12名（名鑑の元配列＝slice で落ちた先頭20名から転記）
 * - `confed-13`〜`confed-32`: 名鑑の最終名簿の先頭20名（日本人系統）
 * - `confed-33`〜`confed-36`: 名鑑の追加16名のうち、物語・相関で必要な4名
 *
 * ■ 戦闘級（grade）の扱い
 * 名鑑には表示バランス用に戦闘級を均等配分し直す処理（`rebalanceCombatGrades`）があるが、
 * **これは名鑑の表示都合なので実装では採用しない。**
 * 実装では名鑑の元の戦闘値 `level`（1..10）を正とし、名鑑と同じ式
 * `['C','B','A','S','SS'][Math.min(4, Math.floor((level - 1) / 2))]` で `grade` を導出する。
 *
 * ■ 二つ名
 * `epithet` は名鑑の英字二つ名。`epithetJa` は名鑑の `epithetCatalog`（日本語の二つ名）で、
 * 名鑑の並び順と対応が取れる範囲でのみ保持する。主要12名は名鑑の最終名簿に存在しないため
 * カタログ側に対応する項目がなく、`epithetJa` を持たない。
 */

/** 人物が属する勢力。`Faction`（機体側の陣営）とは別に、名簿の分類として持つ。 */
export type VeilPersonFactionId = 'confed' | 'kilrashi' | 'serecion' | 'ordo' | 'neurowm';

/** 戦闘級。操縦・戦術・危機判断を合わせた実戦評価の共通尺度。 */
export type CombatGrade = 'C' | 'B' | 'A' | 'S' | 'SS';

/** 名簿1名分のデータ。 */
export interface VeilPerson {
  /** `confed-01` 形式の一意id。 */
  id: string;
  /** 所属勢力。 */
  faction: VeilPersonFactionId;
  /** 表示名（名鑑表記のまま）。 */
  name: string;
  /** 二つ名（英字）。 */
  epithet: string;
  /** 日本語の二つ名。名鑑カタログと対応が取れる人物のみ。 */
  epithetJa?: string;
  /** 性別・体系の表記（`女` / `男` / `雄` / `雌` / `群体` / `男性型` / 種族名など、名鑑の表記）。 */
  sex: string;
  /** 年齢表記（`26歳` / `143季` / `1200年` など、名鑑の表記のまま）。 */
  age: string;
  /** 役割・肩書。 */
  role: string;
  /** 名鑑の元の戦闘値 1..10。相対的な強弱の根拠として保持する。 */
  level: number;
  /** `level` から導出した戦闘級。 */
  grade: CombatGrade;
  /** 実績の一文。 */
  achievement: string;
  /** 勢力の最高権力者なら true（各勢力にちょうど1名）。 */
  isLeader?: boolean;
  /** F-54専任の主人公候補5名（confed-01〜05）に true。 */
  protagonist?: boolean;
  /** 非人類のみ。名鑑の「系統／外見」欄。 */
  appearance?: string;
  /** 肖像画像の相対パス。 */
  portrait: string;
}

/** 戦闘級のラベルと定義（名鑑 `combatGrades` の転記）。 */
export const COMBAT_GRADES: Record<CombatGrade, { label: string; title: string; desc: string }> = {
  C: { label: 'C級', title: '基礎戦闘者', desc: '実戦の基本手順を守り、指示下で役割を果たせる。' },
  B: { label: 'B級', title: '正規戦闘者', desc: '標準任務を安定して完遂し、不利な局面でも生還手順を組み立てられる。' },
  A: { label: 'A級', title: '上級戦術者', desc: '役割や機体を問わず編隊の穴を埋め、僚機を含めた戦術を変えられる。' },
  S: { label: 'S級', title: '戦況転換者', desc: '小隊規模から艦隊の局面まで、戦況を反転させる判断と実績を持つ。' },
  SS: { label: 'SS級', title: '戦域級エース', desc: '一人の選択が艦隊・航路・停戦線の結果を変える、戦域級の存在。' },
};

const GRADE_ORDER: readonly CombatGrade[] = ['C', 'B', 'A', 'S', 'SS'];

/**
 * 戦闘値 1..10 から戦闘級を導出する。名鑑 `combatGradeFor` と同じ式。
 * 名鑑の表示用の均等配分（rebalance）は行わない。
 */
export function gradeFromLevel(level: number): CombatGrade {
  return GRADE_ORDER[Math.min(4, Math.max(0, Math.floor((level - 1) / 2)))];
}

/**
 * 戦闘級から僚機AIの技量 0..1 へ変換する。
 * 既存 `src/content/pilots.ts` の `skill`（0.38〜0.8 の実績値域）と整合する範囲に収める。
 */
export function skillFromGrade(grade: CombatGrade): number {
  switch (grade) {
    case 'C':
      return 0.45;
    case 'B':
      return 0.58;
    case 'A':
      return 0.7;
    case 'S':
      return 0.82;
    case 'SS':
      return 0.92;
  }
}

/** 名簿定義の生データ。`level` から `grade`、連番から `id` と `portrait` を生成する。 */
interface PersonSeed {
  name: string;
  epithet: string;
  epithetJa?: string;
  sex: string;
  age: string;
  role: string;
  level: number;
  achievement: string;
  isLeader?: boolean;
  protagonist?: boolean;
  appearance?: string;
}

function build(faction: VeilPersonFactionId, seeds: readonly PersonSeed[]): VeilPerson[] {
  return seeds.map((seed, index) => {
    const id = `${faction}-${String(index + 1).padStart(2, '0')}`;
    const person: VeilPerson = {
      id,
      faction,
      name: seed.name,
      epithet: seed.epithet,
      sex: seed.sex,
      age: seed.age,
      role: seed.role,
      level: seed.level,
      grade: gradeFromLevel(seed.level),
      achievement: seed.achievement,
      portrait: `characters/${id}.png`,
    };
    if (seed.epithetJa) person.epithetJa = seed.epithetJa;
    if (seed.isLeader) person.isLeader = true;
    if (seed.protagonist) person.protagonist = true;
    if (seed.appearance) person.appearance = seed.appearance;
    return person;
  });
}

/**
 * アウレリア連邦（人類）36名。
 * 01〜12 は十章作戦記録の主要人物（P0-1）、13〜32 は名鑑最終名簿の日本人20名、
 * 33〜36 は名鑑追加16名から物語・相関で必要な4名。
 */
const CONFED_SEEDS: readonly PersonSeed[] = [
  // --- 主要12名（物語spec準拠。名鑑の元配列から転記） ---
  {
    name: '朝倉 澪（アサクラ ミオ）',
    epithet: 'Valkyrie',
    sex: '女',
    age: '26歳',
    role: '艦載戦闘機隊長',
    level: 10,
    achievement: 'ヴェガ門前で孤立した護衛隊を再編し、民間船87隻を帰還させた。',
    protagonist: true,
  },
  {
    name: '神谷 隼人（カミヤ ハヤト）',
    epithet: 'Blue Hour',
    sex: '男',
    age: '28歳',
    role: '迎撃編隊リーダー',
    level: 9,
    achievement: 'キルラシーの先遣隊を三度撃退。敵エースとの無線交渉記録を残す。',
    protagonist: true,
  },
  {
    name: 'Amina Okafor（アミナ・オカフォー）',
    epithet: 'Kestrel',
    sex: '女',
    age: '27歳',
    role: '迎撃パイロット',
    level: 6,
    achievement: '機雷原を抜ける低空軌道を発見。僚機の帰投率を上げた。',
    protagonist: true,
  },
  {
    name: 'Marcus Johnson（マーカス・ジョンソン）',
    epithet: 'Kite',
    sex: '男',
    age: '22歳',
    role: '軽戦闘機パイロット',
    level: 5,
    achievement: 'オリオン港の夜間迎撃で初撃墜。民間航路の標識を守り抜いた。',
    protagonist: true,
  },
  {
    name: 'Ploy Srisuk（プロイ・スリスック）',
    epithet: 'Wisp',
    sex: '女',
    age: '21歳',
    role: '訓練生パイロット',
    level: 3,
    achievement: '初出撃で味方機のロックを解除し、衝突を回避した。',
    protagonist: true,
  },
  {
    name: 'William Hart（ウィリアム・ハート）',
    epithet: 'Anchor',
    sex: '男',
    age: '57歳',
    role: '艦長・元救難隊',
    level: 8,
    achievement: '停戦線内で攻撃を受けた輸送船団を、武力衝突なしで誘導した。',
  },
  {
    name: 'Sophie Laurent（ソフィー・ローラン）',
    epithet: 'Northstar',
    sex: '女',
    age: '39歳',
    role: '航法士・門解析員',
    level: 7,
    achievement: '不安定なヴェイルの開口を予測し、帰投窓を二分延長した。',
  },
  {
    name: 'Kim Seoyeon（キム・ソヨン）',
    epithet: 'Cinder',
    sex: '女',
    age: '38歳',
    role: '基地防衛司令',
    level: 7,
    achievement: 'オリオン港の防衛線を二度再構築し、避難民区画を守った。',
  },
  {
    name: 'Claire Bennett（クレア・ベネット）',
    epithet: 'Moth',
    sex: '女',
    age: '24歳',
    role: '救難艇パイロット',
    level: 6,
    achievement: '撃墜後の脱出ポッドを最短時間で14基回収した。',
  },
  {
    name: '小林 直子（コバヤシ ナオコ）',
    epithet: 'Lattice',
    sex: '女',
    age: '34歳',
    role: '偵察・電子戦士官',
    level: 9,
    achievement: 'ラグランジュ裂谷で通信妨害下の編隊を無傷で離脱させた。',
  },
  {
    name: 'Nia Williams（ニア・ウィリアムズ）',
    epithet: 'Hearth',
    sex: '女',
    age: '41歳',
    role: '空母航空団参謀',
    level: 8,
    achievement: '補給不足の航空団を再配置し、四十日間の継戦計画を成立させた。',
  },
  {
    name: 'Omar Rahman（オマル・ラーマン）',
    epithet: 'Tallow',
    sex: '男',
    age: '30歳',
    role: '爆撃機パイロット',
    level: 7,
    achievement: '採掘帯の封鎖艦に対し、最小限の損害で航路を開いた。',
  },
  // --- 名鑑最終名簿の日本人20名（epithetJa は epithetCatalog.confed[0..19]） ---
  {
    name: '相沢 紗良（アイザワ サラ）',
    epithet: 'Aria',
    epithetJa: '暁の航路士',
    sex: '女',
    age: '24歳',
    role: '航路情報士',
    level: 6,
    achievement: '漂流船の記録から閉鎖宙域の安全航路を発見した。',
  },
  {
    name: '水城 玲奈（ミズキ レナ）',
    epithet: 'Lark',
    epithetJa: 'ガラスの砲火',
    sex: '女',
    age: '27歳',
    role: '艦隊広報官',
    level: 4,
    achievement: '危険な撤収作戦の民間説明を担い、混乱を最小限に抑えた。',
  },
  {
    name: '柊 奏（ヒイラギ カナデ）',
    epithet: 'Vesper',
    epithetJa: '静かな稲妻',
    sex: '女',
    age: '25歳',
    role: '電子戦操縦士',
    level: 7,
    achievement: '敵艦隊の索敵網を静かに攪乱し、救難船を通した。',
  },
  {
    name: '篠原 美月（シノハラ ミヅキ）',
    epithet: 'Halo',
    epithetJa: '真昼の交渉者',
    sex: '女',
    age: '28歳',
    role: '外交連絡士官',
    level: 5,
    achievement: '停戦交渉の通訳を務め、捕虜交換の合意を成立させた。',
  },
  {
    name: '桐谷 綾（キリタニ アヤ）',
    epithet: 'Sable',
    epithetJa: '蒼刃の盾',
    sex: '女',
    age: '23歳',
    role: '近接護衛パイロット',
    level: 8,
    achievement: '旗艦への接近を許さず、味方編隊の離脱を支えた。',
  },
  {
    name: '黒瀬 日和（クロセ ヒヨリ）',
    epithet: 'Aster',
    epithetJa: '残響の解析者',
    sex: '女',
    age: '26歳',
    role: '戦術解析官',
    level: 6,
    achievement: '断片的な観測記録から敵の伏撃地点を特定した。',
  },
  {
    name: '早川 千紘（ハヤカワ チヒロ）',
    epithet: 'Meridian',
    epithetJa: '白波の灯台',
    sex: '女',
    age: '29歳',
    role: '医療艇長',
    level: 5,
    achievement: '被弾した輸送船で救護班を指揮し、乗員を帰還させた。',
  },
  {
    name: '東雲 澪（シノノメ ミオ）',
    epithet: 'Nova',
    epithetJa: '雲海の目',
    sex: '女',
    age: '22歳',
    role: '偵察飛行士',
    level: 7,
    achievement: '濃霧帯を単独で突破し、艦隊へ敵の進路を送信した。',
  },
  {
    name: '七瀬 結衣（ナナセ ユイ）',
    epithet: 'Iris',
    epithetJa: '燃料星の守り手',
    sex: '女',
    age: '24歳',
    role: '補給調整官',
    level: 4,
    achievement: '不足する燃料を再配分し、前線航空隊の活動を維持した。',
  },
  {
    name: '白石 透子（シライシ トウコ）',
    epithet: 'Aquila',
    epithetJa: '逆潮の羅針盤',
    sex: '女',
    age: '27歳',
    role: '重力航法士',
    level: 6,
    achievement: '不安定な重力井戸を抜ける退避経路を設計した。',
  },
  {
    name: '橘 蒼真（タチバナ ソウマ）',
    epithet: 'Orion',
    epithetJa: '遠雷の狩人',
    sex: '男',
    age: '25歳',
    role: '長距離迎撃士',
    level: 7,
    achievement: '民間船団を狙う無人機群を遠距離から迎撃した。',
  },
  {
    name: '朝比奈 律（アサヒナ リツ）',
    epithet: 'Cipher',
    epithetJa: '無音の暗号士',
    sex: '男',
    age: '28歳',
    role: '情報作戦士官',
    level: 5,
    achievement: '敵の暗号通信を解析し、攻撃予告を艦隊へ伝えた。',
  },
  {
    name: '榊 恒一（サカキ コウイチ）',
    epithet: 'Tempest',
    epithetJa: '突破口の彗星',
    sex: '男',
    age: '26歳',
    role: '突撃艇隊長',
    level: 8,
    achievement: '敵の封鎖線を突破して、孤立部隊への補給を成功させた。',
  },
  {
    name: '藤堂 悠真（トウドウ ユウマ）',
    epithet: 'Raven',
    epithetJa: '夜明けの囮',
    sex: '男',
    age: '24歳',
    role: '艦載機パイロット',
    level: 6,
    achievement: '夜間戦で編隊の囮を引き受け、味方機を退避させた。',
  },
  {
    name: '真田 湊（サナダ ミナト）',
    epithet: 'Atlas',
    epithetJa: '鉄雨の管制者',
    sex: '男',
    age: '29歳',
    role: '防衛管制官',
    level: 5,
    achievement: '前進基地の迎撃火器を再配置し、被害を抑えた。',
  },
  {
    name: '久世 朔（クゼ サク）',
    epithet: 'Solace',
    epithetJa: '帰還の手',
    sex: '男',
    age: '23歳',
    role: '救難艇操縦士',
    level: 6,
    achievement: '崩壊寸前の貨物船から乗員を短時間で救助した。',
  },
  {
    name: '三枝 碧（サエグサ アオイ）',
    epithet: 'Vector',
    epithetJa: '群青の試験官',
    sex: '男',
    age: '27歳',
    role: '航法試験官',
    level: 4,
    achievement: '新型航法支援機の危険域試験を無事故で終えた。',
  },
  {
    name: '高峰 岳（タカミネ ガク）',
    epithet: 'Cobalt',
    epithetJa: '整備庫の巨人',
    sex: '男',
    age: '28歳',
    role: '戦闘整備士',
    level: 5,
    achievement: '損傷機の応急修理を行い、編隊の戦力を回復させた。',
  },
  {
    name: '西園寺 蓮（サイオンジ レン）',
    epithet: 'Nocturne',
    epithetJa: '停戦線の影',
    sex: '男',
    age: '26歳',
    role: '外交護衛士官',
    level: 7,
    achievement: '交渉使節団を護衛し、襲撃を最小限の衝突で退けた。',
  },
  {
    name: '如月 颯太（キサラギ ソウタ）',
    epithet: 'Eclipse',
    epithetJa: '初陣の教師',
    sex: '男',
    age: '25歳',
    role: '戦術教官',
    level: 6,
    achievement: '新人隊の訓練記録を刷新し、初任務の生還率を上げた。',
  },
  // --- 名鑑追加16名から、物語・相関で必要な4名 ---
  {
    name: 'Kwame Adeyemi（クワメ・アデイェミ）',
    epithet: 'Bastion',
    epithetJa: '黒曜の防壁',
    sex: '男',
    age: '58歳',
    role: '連邦艦隊司令・アウレリア連邦最高指揮官',
    level: 8,
    achievement: '前進基地の防衛線を組み直し、避難時間を生み出した。連邦艦隊の全作戦指揮を担う。',
    isLeader: true,
  },
  {
    name: 'Oliver Grant（オリヴァー・グラント）',
    epithet: 'Crown',
    epithetJa: '青い王冠',
    sex: '男',
    age: '32歳',
    role: '航宙艦長',
    level: 8,
    achievement: '辺境宙域の救難艦隊を率い、民間船団を無傷で帰投させた。',
  },
  {
    name: 'Elena Ward（エレナ・ウォード）',
    epithet: 'Swan',
    epithetJa: '重力嵐の白鳥',
    sex: '女',
    age: '34歳',
    role: '航法主任',
    level: 7,
    achievement: '重力嵐の中で避難船団を一隻も失わずに導いた。',
  },
  {
    name: 'Nia Okoye（ニア・オコエ）',
    epithet: 'Onyx',
    epithetJa: '黒曜の布陣',
    sex: '女',
    age: '31歳',
    role: '空母戦術官',
    level: 8,
    achievement: '航空団の配置を再設計し、艦隊の被害を最小限にした。',
  },
];

/** キルラシー帝国（獣人）10名。名鑑の並び順のまま。01がヴァルカーン（大牙王）。 */
const KILRASHI_SEEDS: readonly PersonSeed[] = [
  {
    name: 'ヴァルカーン',
    epithet: 'Crown Fang',
    epithetJa: '金鬣の裁定者',
    sex: '雄',
    age: '88歳',
    role: '大牙王・帝国最高権力者',
    level: 10,
    achievement: '十系統の家門を血誓で束ね、帝国の戦争と停戦を最終裁定する。',
    isLeader: true,
    appearance: 'ライオン系／金色のたてがみ',
  },
  {
    name: 'カクシ',
    epithet: 'Caxki',
    epithetJa: '銀背の追跡者',
    sex: '雄',
    age: '36歳',
    role: '巡航狩人',
    level: 10,
    achievement: '重力圏での耐久追跡を得意とし、三つの空母戦で生還した。',
    appearance: 'ゴリラ系／大きな肩と腕',
  },
  {
    name: 'ラギティカ',
    epithet: 'Blood Oath',
    epithetJa: '月牙の誓女',
    sex: '雌',
    age: '29歳',
    role: '決闘士・編隊長',
    level: 10,
    achievement: '撃墜した敵の名をすべて記憶し、戦場で一対一の誓約を守る。',
    appearance: 'オオカミ系／銀灰の耳と尾',
  },
  {
    name: 'ダカス',
    epithet: 'Deathstroke',
    epithetJa: '灰熊の帰還者',
    sex: '雄',
    age: '44歳',
    role: '帰投線の執行者',
    level: 9,
    achievement: '耐弾装甲を生かし、危険な帰投線を護衛する戦術を完成させた。',
    appearance: 'ヒグマ系／重厚な体格',
  },
  {
    name: 'セイラク',
    epithet: 'Ash Crown',
    epithetJa: '紅尾の近衛',
    sex: '雌',
    age: '33歳',
    role: '灰冠近衛隊長',
    level: 9,
    achievement: '宗家の旗艦を救うため、陽動と潜入で三個中隊を足止めした。',
    appearance: 'キツネ系／赤褐色の耳と尾',
  },
  {
    name: 'オル',
    epithet: 'Ironmane',
    epithetJa: '鉄鬣の突撃者',
    sex: '雄',
    age: '27歳',
    role: '突撃隊パイロット',
    level: 8,
    achievement: '強靭な突進力で護衛機を引き剥がし、退路を開いた。',
    appearance: 'イノシシ系／短い牙と剛毛',
  },
  {
    name: 'ヴァーク',
    epithet: 'Rite',
    epithetJa: '枝角の伝令',
    sex: '雌',
    age: '25歳',
    role: '儀礼通信士',
    level: 6,
    achievement: '敵の降伏文を翻訳し、停戦線の誤解を解いた。',
    appearance: 'シカ系／枝角と細身の体格',
  },
  {
    name: 'フェン',
    epithet: 'Bitter Sun',
    epithetJa: '斑日の旋回者',
    sex: '雄',
    age: '38歳',
    role: '重戦闘機隊長',
    level: 8,
    achievement: '高重力域での旋回戦術を帝国標準にした。',
    appearance: 'ハイエナ系／斑点の毛並み',
  },
  {
    name: 'カリ',
    epithet: 'Soft Claw',
    epithetJa: '夜梟の針',
    sex: '雌',
    age: '22歳',
    role: '偵察飛行士',
    level: 5,
    achievement: '夜間の静音飛行で補給基地を発見し、民間区画を避けて帰投した。',
    appearance: 'フクロウ系／大きな金色の目',
  },
  {
    name: 'ドゥル',
    epithet: 'Oathkeeper',
    epithetJa: '沼鉄の教官',
    sex: '雄',
    age: '56歳',
    role: '宗家付き教官',
    level: 7,
    achievement: '四世代のパイロットに古い決闘規約を教えた。',
    appearance: 'ワニ系／鱗のある顎と腕',
  },
];

/** セレシオン遊牧圏（エネルギー生命）10名。01がマザー（古唱母）。 */
const SERECION_SEEDS: readonly PersonSeed[] = [
  {
    name: 'マザー',
    epithet: 'First Horizon',
    epithetJa: '最初の地平',
    sex: '群体',
    age: '143季',
    role: '古唱母・遊牧圏最高権力者',
    level: 10,
    achievement: '全船団の季節航路と武装中立を裁定し、遊牧圏の記憶を一つに束ねる。',
    isLeader: true,
    appearance: '極光プラズマ相／虹色の光輪',
  },
  {
    name: 'アウル',
    epithet: 'Day Chorus',
    epithetJa: '昼歌の舵手',
    sex: '群体',
    age: '29季',
    role: '船団指揮者',
    level: 10,
    achievement: '静穏海の避難航路を十年間維持し、両陣営の艦を通過させた。',
    appearance: '生物発光ガス相／青緑の脈動',
  },
  {
    name: 'ネメ',
    epithet: 'Blue Breath',
    epithetJa: '青息の航海者',
    sex: '群体',
    age: '41季',
    role: '嵐航法士',
    level: 9,
    achievement: '電磁嵐の中で失われた船団を再接続し、全船を帰還させた。',
    appearance: '液体霧相／半透明の水滴肌',
  },
  {
    name: 'カデン',
    epithet: 'First Light',
    epithetJa: '紫電の護唱',
    sex: '群体',
    age: '33季',
    role: '護衛歌隊長',
    level: 9,
    achievement: '武装中立の規約を破らずに攻撃艦を退けた。',
    appearance: 'イオン嵐相／紫電の髪状放電',
  },
  {
    name: 'ヴェル',
    epithet: 'Noon Bell',
    epithetJa: '正午の鐘',
    sex: '群体',
    age: '57季',
    role: '長老・航路裁定者',
    level: 10,
    achievement: '五者通行協定の原文を暗唱し、停戦の根拠を示す。',
    appearance: '太陽糸相／金色の発光繊維',
  },
  {
    name: 'ソーン',
    epithet: 'Mist Choir',
    epithetJa: '霧の独唱者',
    sex: '群体',
    age: '24季',
    role: '観測者',
    level: 7,
    achievement: '敵味方を問わず救難信号を拾い上げた。',
    appearance: '結晶光相／多面体の肩飾り',
  },
  {
    name: 'ロウム',
    epithet: 'Green Current',
    epithetJa: '緑流の舵',
    sex: '群体',
    age: '18季',
    role: '気嚢船操舵手',
    level: 6,
    achievement: '乱流域で大型居住船を反転させた。',
    appearance: '蒸気雲相／緑の雲状髪',
  },
  {
    name: 'アクス',
    epithet: 'Soft Static',
    epithetJa: '磁場の翻訳者',
    sex: '群体',
    age: '31季',
    role: '通信翻訳者',
    level: 5,
    achievement: 'キルラシーの誓約文を初めて正確に翻訳した。',
    appearance: '磁場相／浮遊する金属片',
  },
  {
    name: 'ミン',
    epithet: 'Cloudstep',
    epithetJa: '雲歩きの子',
    sex: '群体',
    age: '21季',
    role: '小艇パイロット',
    level: 6,
    achievement: '機雷の間を縫って孤立した医療艇へ物資を届けた。',
    appearance: 'ゼリー光相／柔らかな光膜',
  },
  {
    name: 'エン',
    epithet: 'Warm Front',
    epithetJa: '温暖前線の盾',
    sex: '群体',
    age: '36季',
    role: '嵐防衛官',
    level: 8,
    achievement: '救難船団を覆う防電場を設計した。',
    appearance: '電弧相／青白い稲妻紋',
  },
];

/** オルド異星合議圏（宇宙人）10名。01がアーク（合議王）。 */
const ORDO_SEEDS: readonly PersonSeed[] = [
  {
    name: 'アーク',
    epithet: 'Root Stratum',
    epithetJa: '根層の王',
    sex: '岩盤種',
    age: '1200年',
    role: '合議王・最高権力者',
    level: 10,
    achievement: '十種の地層記憶と採掘境界を裁定し、オルドの意思を最終決定する。',
    isLeader: true,
    appearance: '珪素結晶種／玄武岩の皮膚',
  },
  {
    name: 'ゼロ',
    epithet: 'Deep Measure',
    epithetJa: '深度の計量者',
    sex: '甲殻種',
    age: '184年',
    role: '地殻防衛官',
    level: 10,
    achievement: '採掘艦隊を一昼夜だけ停止させ、双方を領域外へ退かせた。',
    appearance: '甲殻種／青い装甲殻',
  },
  {
    name: 'アイン',
    epithet: 'Clear Fault',
    epithetJa: '澄んだ断層',
    sex: '水棲種',
    age: '91年',
    role: '重力戦術官',
    level: 9,
    achievement: '局地重力を変え、装甲艦の進路を非破壊で逸らした。',
    appearance: '水棲二足種／えらと鰭',
  },
  {
    name: 'セブン',
    epithet: 'Old Heat',
    epithetJa: '古熱の証人',
    sex: '菌糸共生種',
    age: '220年',
    role: '記憶代表',
    level: 9,
    achievement: '百年前の採掘権を証明する地層記録を提示した。',
    appearance: '菌糸共生種／琥珀色の胞子冠',
  },
  {
    name: 'イレブン',
    epithet: 'Black Seam',
    epithetJa: '黒層の封鎖者',
    sex: '翼膜種',
    age: '143年',
    role: '封鎖司令官',
    level: 10,
    achievement: '深層採掘帯の封鎖を一個体の損失もなく完成させた。',
    appearance: '翼膜種／折り畳み翼',
  },
  {
    name: 'フリント',
    epithet: 'Spark Bed',
    epithetJa: '火花床の探査者',
    sex: '重力低身長種',
    age: '54年',
    role: '探査官',
    level: 7,
    achievement: '未採掘のヴェイル関連鉱脈を発見した。',
    appearance: '低身長重力種／密度の高い骨格',
  },
  {
    name: 'マイカ',
    epithet: 'Thin Layer',
    epithetJa: '薄層の通訳者',
    sex: '鱗皮種',
    age: '38年',
    role: '外交翻訳官',
    level: 5,
    achievement: '人類の短い時間感覚を理解する翻訳層を作った。',
    appearance: '鱗皮種／虹色の鱗',
  },
  {
    name: 'スレート',
    epithet: 'Grey Weight',
    epithetJa: '灰重の装甲者',
    sex: '砂漠皮膜種',
    age: '68年',
    role: '装甲艇士官',
    level: 8,
    achievement: '敵艦の砲撃を受けながら採掘員を護衛した。',
    appearance: '砂漠皮膜種／岩砂の外皮',
  },
  {
    name: 'オパール',
    epithet: 'Many Color',
    epithetJa: '真珠潮の中継者',
    sex: '半透明海洋種',
    age: '29年',
    role: '通信官',
    level: 6,
    achievement: '複数勢力の通信を同時に中継した。',
    appearance: '半透明海洋種／真珠色の半透明皮膚',
  },
  {
    name: 'フェロン',
    epithet: 'Red Rust',
    epithetJa: '赤錆の地図師',
    sex: '角質遊牧種',
    age: '312年',
    role: '古参地図官',
    level: 6,
    achievement: '採掘戦争以前の地図を地表に投影した。',
    appearance: '角質遊牧種／黒い角と革質肌',
  },
];

/** ニューロウム群体（人工知性）10名。01がクラウン（原初核）。 */
const NEUROWM_SEEDS: readonly PersonSeed[] = [
  {
    name: 'クラウン',
    epithet: 'Crown Synapse',
    epithetJa: '冠状シナプス',
    sex: '男性型',
    age: '90年',
    role: '原初核・群体最高権力者',
    level: 10,
    achievement: '全ネットワークの判断を統合し、ニューロウムの接続と進路を最終承認する。',
    isLeader: true,
    appearance: '男性型統治アンドロイド／白磁の外装',
  },
  {
    name: 'オリジン',
    epithet: 'First Synapse',
    epithetJa: '最初の接続',
    sex: '女性型',
    age: '12年',
    role: '戦域救護アンドロイド',
    level: 10,
    achievement: '複数宙域の救難信号を同期し、最短救護航路を示した。',
    appearance: '女性型医療アンドロイド／透明な診断パネル',
  },
  {
    name: 'ハイヴァ',
    epithet: 'Glass Mandible',
    epithetJa: '硝子顎の斥候',
    sex: '男性型',
    age: '9年',
    role: '地表偵察ロボット',
    level: 9,
    achievement: '複雑な峡谷を横断し、危険な地形を先行観測した。',
    appearance: '男性型偵察ロボット／流線形の脚部',
  },
  {
    name: 'メモリア',
    epithet: 'Borrowed Sky',
    epithetJa: '借りた空',
    sex: '女性型',
    age: '18年',
    role: '異種通信アンドロイド',
    level: 9,
    achievement: '五勢力の通信プロトコルを共通記録層へ接続した。',
    appearance: '女性型投影アンドロイド／半透明の輪郭',
  },
  {
    name: 'ヴェクサ',
    epithet: 'Red Pulse',
    epithetJa: '赤脈の守衛',
    sex: '男性型',
    age: '7年',
    role: '中継器防衛ロボット',
    level: 10,
    achievement: '中継器を三波の攻撃から守り、避難路を維持した。',
    appearance: '男性型重作業ロボット／油圧アーム',
  },
  {
    name: 'スウォームレット',
    epithet: 'Many Feet',
    epithetJa: '万脚の工匠',
    sex: '女性型',
    age: '3年',
    role: '精密整備群体',
    level: 7,
    achievement: '微小機群で損傷した機体の配線を修復し、離脱時間を作った。',
    appearance: '女性型マイクロドローン群／複眼センサー',
  },
  {
    name: 'コアドロップ',
    epithet: 'Falling Kernel',
    epithetJa: '滴核の建設者',
    sex: '男性型',
    age: '5年',
    role: '高速配送アンドロイド',
    level: 5,
    achievement: '戦場の資材を回収して新しい中継器を建設した。',
    appearance: '男性型配送アンドロイド／細身の流線ボディ',
  },
  {
    name: 'サイレンス',
    epithet: 'No Echo',
    epithetJa: '静寂の遮断者',
    sex: '女性型',
    age: '11年',
    role: '通信遮断ロボット',
    level: 8,
    achievement: '水没施設の通信遮断を復旧し、避難信号を通した。',
    appearance: '女性型水陸両用ロボット／防水外殻',
  },
  {
    name: 'ミミック',
    epithet: 'Human Shape',
    epithetJa: '模倣する眼',
    sex: '男性型',
    age: '4年',
    role: '古式偵察アンドロイド',
    level: 6,
    achievement: '旧式機巧の外観を使い、通行パターンを安全に調べた。',
    appearance: '男性型レトロ機巧アンドロイド／真鍮の関節',
  },
  {
    name: 'グラフト',
    epithet: 'Borrower',
    epithetJa: '継ぎ木の再生者',
    sex: '女性型',
    age: '6年',
    role: '自己修復ロボット',
    level: 6,
    achievement: '損傷した機体の部品を再利用して復帰した。',
    appearance: '女性型ソフトロボット／半透明の合成皮膜',
  },
];

/** 全76名の名簿。勢力順（人類36→キルラシー→セレシオン→オルド→ニューロウム）。 */
export const VEIL_PEOPLE: readonly VeilPerson[] = [
  ...build('confed', CONFED_SEEDS),
  ...build('kilrashi', KILRASHI_SEEDS),
  ...build('serecion', SERECION_SEEDS),
  ...build('ordo', ORDO_SEEDS),
  ...build('neurowm', NEUROWM_SEEDS),
];

const PEOPLE_BY_ID: Record<string, VeilPerson> = Object.fromEntries(
  VEIL_PEOPLE.map((person) => [person.id, person]),
);

/** idから人物を引く。未知idは例外を投げる（`campaignNode` と同じ流儀）。 */
export function veilPerson(id: string): VeilPerson {
  const person = PEOPLE_BY_ID[id];
  if (!person) throw new Error(`unknown veil person: ${id}`);
  return person;
}

/** 勢力ごとの名簿を、定義順で返す。 */
export function peopleOfFaction(factionId: VeilPersonFactionId): VeilPerson[] {
  return VEIL_PEOPLE.filter((person) => person.faction === factionId);
}

/** F-54専任の主人公候補5名（confed-01〜05）。 */
export const PROTAGONISTS: readonly VeilPerson[] = VEIL_PEOPLE.filter((person) => person.protagonist === true);
