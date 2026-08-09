/**
 * THE VEIL FRONT — 世界観・歴史データ。
 *
 * 出典: `00_initila_constructions` 配下の「世界観_歴史仕様.html」§01〜§06。
 * 表示文（勢力名、戦域の事実、年表、戦況、プレイヤーの立場）は、
 * すべてこのファイルを単一の出所とする。他のファイルは文字列を再定義せず、
 * ここからインポートして参照する。
 *
 * 記述は仕様テキストからの転記のみ。創作で補わない。
 * 仕様に項目が無いフィールドは省略する（型上は optional）。
 */

/* ------------------------------------------------------------------ *
 * 01 / Core premise — 設定基準時点
 * ------------------------------------------------------------------ */

/** 設定基準時点とキャッチコピー（§冒頭・§01） */
export const VEIL_ERA = {
  /** 設定タイトル */
  title: 'THE VEIL FRONT',
  /** 西暦での基準時点 */
  year: 2312,
  /** 統合暦での基準時点（2181 = U.C. 0） */
  uc: 131,
  /** 表示用の基準時点 */
  label: '設定基準時点：統合暦 2312',
  /** リード文（キャッチコピー） */
  catch:
    '人類が銀河へ出たとき、そこにあったのは空白ではなかった。古代航路をめぐる五つの文明の均衡は、ひとつの通信事故を境に崩れ、ヴェガ宙域はいま「戦争になる直前」のまま燃え続けている。',
  /** §01 の前提を2行で示す一句 */
  premise: ['銀河をつないだのは、人類のエンジンではない。', '人類は、誰かが残した扉を開けただけだ。'],
} as const;

/* ------------------------------------------------------------------ *
 * 03 / Five powers — 五勢力
 * ------------------------------------------------------------------ */

/**
 * 資料上の勢力id。
 *
 * 注意: 既存コード（`src/content/ships.ts` の `Faction`）のキルラシーは
 * `kilrathi`（th）だが、新設定の資料表記は `kilrashi`（sh）である。
 * このファイルは資料どおり `kilrashi` を使い、既存 `Faction` との差異は
 * `FACTION_ID_MAP` で吸収する。
 */
export interface VeilFaction {
  id: 'confed' | 'kilrashi' | 'serecion' | 'ordo' | 'neurowm';
  /** 表示名 */
  name: string;
  /** 名鑑のコード表記 */
  code: string;
  /** 名鑑の色値 */
  color: string;
  /** 1行の性格 */
  summary: string;
  /** 現在の立ち位置（交戦／武装中立 など） */
  stance: string;
  /** 勢力の解説 */
  description: string;
  /** 守りたいもの（資料に記載のある勢力のみ） */
  protects?: string;
  /** 戦い方 */
  tactics: string;
  /** ヴェイル観 */
  veilView: string;
  /** 現在（資料に記載のある勢力のみ） */
  current?: string;
  /** 弱点（資料に記載のある勢力のみ） */
  weakness?: string;
}

/** 五勢力（§03。連邦のヴェイル観のみ §01 から転記） */
export const VEIL_FACTIONS = [
  {
    id: 'confed',
    name: 'アウレリア連邦（人類）',
    code: 'CONFED / HUMAN',
    color: '#73d7ff',
    summary: '分裂しかけた開拓国家',
    stance: 'キルラシーと交戦',
    description:
      '地球圏を中心とする複数の居住圏・企業・軍港の連合。広い領土を持つが、辺境への支援は遅く、同じ「人類」でも連邦維持派、自治派、軍需企業派が対立している。',
    protects: '民間航路、居住区、連邦の連続性。',
    tactics: '空母を中心とした多機種編隊、情報と補給の優位。',
    // §03 の連邦欄にはヴェイル観の項目が無い。§01「人類にとっては物流と生存線」から転記。
    veilView: '物流と生存線。',
    weakness: '政治的な遅さ。前線の艦長が命令を待てない。',
  },
  {
    id: 'kilrashi',
    name: 'キルラシー帝国',
    code: 'KILRASHI',
    color: '#ff7d86',
    summary: '誓約と血統の軍事帝国',
    stance: '連邦と全面交戦',
    description:
      '高重力惑星出身の捕食性知性体。戦争を単なる資源争いではなく、家系と名誉を刻む儀式として捉える。ただし帝国内にも、拡張を望む軍家と、古い誓約を守る聖職者がいる。',
    tactics: '高速突撃、エースの決闘、恐怖による降伏。',
    veilView: '祖先の試練。無断使用は冒涜。',
    current: '灰冠回廊からヴェガ門へ圧力をかけている。',
  },
  {
    id: 'serecion',
    name: 'セレシオン遊牧圏',
    code: 'ORPHELIAN',
    color: '#7fe3b0',
    summary: '光合成ガス生命の移動都市',
    stance: '武装中立',
    description:
      '巨大な気嚢船と群体的な都市で星雲を渡る、淡い発光を持つ生命体。国家ではなく「季節ごとに移動する合唱圏」で、戦争に加担せず、航路と避難民の輸送で影響力を持つ。',
    tactics: '電磁嵐、欺瞞、救難船団の護衛。',
    veilView: '通過するための気候。所有の概念がない。',
    current: '静穏海の民間航路を維持している。',
  },
  {
    id: 'ordo',
    name: 'オルド地殻知性体',
    code: 'ORDO',
    color: '#d9b977',
    summary: '惑星規模の結晶・鉱物知性',
    stance: '条件付き協力',
    description:
      '惑星内部の結晶ネットワークに宿る、極めて長い時間感覚を持つ知性体。個体ではなく地殻全体が記憶を共有するため、短期的な外交を理解しにくい。採掘権と引き換えに航法データを提供する。',
    tactics: '重装甲、局地的な重力変動、長期封鎖。',
    veilView: '銀河の地層に刻まれた古い応力線。',
    current: '深層採掘帯で双方の採掘船を停止させている。',
  },
  {
    id: 'neurowm',
    name: 'ニューロウム群体',
    code: 'NEUROWM',
    color: '#c9a6ff',
    summary: '分散型の生体ネットワーク',
    stance: '意図不明',
    description:
      '無数の小型個体が、電磁的な巣脈を介して一つの判断を作る文明。個体を失うことを死とみなさず、巣全体の継続を優先するため、他勢力の「降伏」や「人質」が通じない。',
    tactics: '数の飽和、機雷、通信妨害、自己修復機。',
    veilView: '銀河サイズの神経系。接続できるなら接続する。',
    current: '巣脈群に無断で中継器を増設している。',
  },
] as const satisfies readonly VeilFaction[];

export type VeilFactionId = (typeof VEIL_FACTIONS)[number]['id'];

/**
 * 資料表記の勢力id → 既存コードの `Faction` 文字列への対応表。
 *
 * 差異があるのはキルラシーのみで、資料は `kilrashi`（sh）、
 * 既存実装は `kilrathi`（th）。既存ファイルを変更せずに参照できるよう、
 * 変換はこの表に集約する。
 */
export const FACTION_ID_MAP = {
  confed: 'confed',
  kilrashi: 'kilrathi',
  serecion: 'serecion',
  ordo: 'ordo',
  neurowm: 'neurowm',
} as const satisfies Record<VeilFactionId, string>;

/* ------------------------------------------------------------------ *
 * 02 / The Vega theatre + 05 / Situation report — 戦域
 * ------------------------------------------------------------------ */

/** 戦域の所有勢力。共同設備・共同航行圏は 'shared'。 */
export type VeilTheaterOwner = VeilFactionId | 'shared';

/** §05 の「圧力」。灰冠回廊・ラグランジュ裂谷は §05 の表に無いため '不明'。 */
export type VeilPressure = '高' | '極高' | '中' | '不明';

export interface VeilTheater {
  id: string;
  /** 表示名 */
  name: string;
  owner: VeilTheaterOwner;
  /** §05 の「事実」（表に無い戦域は §02 の航路概念図・§04 から転記） */
  fact: string;
  /** §05 の「圧力」 */
  pressure: VeilPressure;
}

/** 戦域8箇所（§02 航路概念図 / §05 戦域別の状態。巣脈群と公証中継所は実装上分割） */
export const VEIL_THEATERS = [
  {
    id: 'orion-port',
    name: 'オリオン港',
    owner: 'confed',
    fact: '連邦の補給・修理拠点。避難民が流入している。',
    pressure: '高',
  },
  {
    id: 'vega-gate',
    name: 'ヴェガ門',
    owner: 'shared',
    fact: '通行権をめぐり連邦とキルラシーが睨み合う。稼働が不安定。',
    pressure: '極高',
  },
  {
    id: 'ashcrown-corridor',
    name: '灰冠回廊',
    owner: 'kilrashi',
    // §05 の表に行が無い。§02「灰冠回廊 キルラシー圏」／§03 キルラシーの現在から転記。
    fact: 'キルラシー圏。灰冠回廊からヴェガ門へ圧力をかけている。',
    pressure: '不明',
  },
  {
    id: 'lagrange-rift',
    name: 'ラグランジュ裂谷',
    owner: 'shared',
    // §05 の表に行が無い。§02「ラグランジュ裂谷 現在の交戦線」／§04 2229 から転記。
    fact: '現在の交戦線。ラグランジュ事故の跡地であり、事故原因は特定されていない。',
    pressure: '不明',
  },
  {
    id: 'quiet-sea',
    name: '静穏海',
    owner: 'serecion',
    fact: 'セレシオンの救難船団が中立回廊を維持している。',
    pressure: '中',
  },
  {
    id: 'deep-mining-belt',
    name: '深層採掘帯',
    owner: 'ordo',
    fact: 'オルドが採掘を停止。未精製資源の価格が急騰している。',
    pressure: '中',
  },
  // §05 の表は「巣脈群・公証中継所」を1行に束ねているが、第6章（巣脈群への侵入）と
  // 第7・8章（公証中継所への搬送・灯台防衛）で別の場所として出撃するため、実装では分割する。
  // 圧力と事実は §05 の同一行から双方へ転記した。
  {
    id: 'hive-veins',
    name: '巣脈群',
    owner: 'neurowm',
    fact: '通信障害が多発。ニューロウムが無断で中継器を増設している。',
    pressure: '不明',
  },
  {
    id: 'notary-relay',
    name: 'ヴェガ門公証中継所',
    owner: 'shared',
    fact: '五者協定の共同設備。中継器増設が認証回線にも影響し、通信障害が出ている。',
    pressure: '不明',
  },
] as const satisfies readonly VeilTheater[];

export type VeilTheaterId = (typeof VEIL_THEATERS)[number]['id'];

/* ------------------------------------------------------------------ *
 * 04 / Recorded history — 年表
 * ------------------------------------------------------------------ */

export interface VeilTimelineEntry {
  /** 西暦 */
  year: number;
  /** 統合暦の年数。基準時点（2312）は 'current' */
  uc: number | 'current';
  title: string;
  /** 見出しの一文 */
  lead: string;
  detail: string;
}

/** 年表8件（§04） */
export const VEIL_TIMELINE = [
  {
    year: 2181,
    uc: 0,
    title: '折路航法の実用化',
    lead: '人類、初めて太陽系の外へ出る。',
    detail:
      '人類は独自の恒星間航法を完成させたが、燃料と計算負荷が大きく、遠征は短期間に限られた。この時代の探査船が後のヴェガ航路の基礎データを持ち帰る。',
  },
  {
    year: 2189,
    uc: 8,
    title: 'ヴェイル・ネットワークの発見',
    lead: '暗黒空間に、自然ではない門が浮かんでいた。',
    detail:
      'ヴェガ近傍で古代中継門が発見される。人類は最初の門を「無人の遺跡」と判断し、解析より先に航路として利用し始めた。',
  },
  {
    year: 2197,
    uc: 16,
    title: '最初の遭遇：キルラシーの警告',
    lead: '「そこから先は、祖先の墓だ」',
    detail:
      '灰冠回廊でキルラシー艦隊と接触。双方の翻訳が完成する前に小競り合いが起き、ヴェイルの使用権をめぐる対立が始まる。',
  },
  {
    year: 2208,
    uc: 27,
    title: '五者通行協定',
    lead: '一つの門を、五つの文明が使う。',
    detail:
      '連邦、キルラシー、セレシオン、オルド、ニューロウムが初めて同じ文書に署名。所有権を決めず、通行料と救難義務だけを定め、公証中継所を共同で維持する不完全な平和だった。',
  },
  {
    year: 2229,
    uc: 48,
    title: 'ラグランジュ事故',
    lead: 'ヴェイルが、乗員の記憶を異なる形で返した。',
    detail:
      '中継門の再起動中に複数艦が消失。帰還した船のログには互いに矛盾する九分間が残った。事故原因は特定されず、各勢力は相手の破壊工作を疑った。',
  },
  {
    year: 2246,
    uc: 65,
    title: '第一次ヴェイル封鎖',
    lead: '平和条約は、戦力の前では紙になる。',
    detail:
      '連邦の軍需企業が事故跡から高効率の門制御核を回収。キルラシーが回収を侵害とみなし、ヴェガ門を封鎖した。辺境の居住区は補給を失い、連邦軍が初めて恒常的に駐留する。',
  },
  {
    year: 2273,
    uc: 92,
    title: '航路戦争',
    lead: '戦争の目的が、勝利から「接続の維持」へ変わる。',
    detail:
      'ニューロウムの中継器増設、オルドの採掘停止、連邦とキルラシーによる通行料の拒否が連鎖し、五勢力の局地戦が同時発生。誰も宣戦布告を出さないまま、民間船だけが戦争を実感する。',
  },
  {
    year: 2312,
    uc: 'current',
    title: 'ヴェガ非常事態',
    lead: '停戦線は残っている。しかし、停戦を信じる艦は少ない。',
    detail:
      '連邦の前進基地オリオン港とヴェガ門の間で衝突が常態化。キルラシーは灰冠回廊から圧力を強め、セレシオンの避難航路だけが双方の艦を通している。五者通行協定は、形式上まだ有効である。',
  },
] as const satisfies readonly VeilTimelineEntry[];

/* ------------------------------------------------------------------ *
 * 05 / Situation report — いま起きていること
 * ------------------------------------------------------------------ */

export interface VeilSituationItem {
  id: string;
  title: string;
  detail: string;
}

/** いま起きていること 4項目（§05） */
export const VEIL_SITUATION = [
  {
    id: 'supply-line',
    title: '補給線が戦場になった',
    detail: '前線の勝敗より、救難艇・燃料・修理部品が届くかどうかが宙域の生存率を決めている。',
  },
  {
    id: 'blurred-lines',
    title: '敵味方の境界がぼやけている',
    detail: '中立船を護衛するために連邦とキルラシーが同じ海域に入り、誤認戦闘の危険が常にある。',
  },
  {
    id: 'treaty-alive',
    title: '協定はまだ破棄されていない',
    detail:
      '誰も協定を信じていないが、破棄すれば全勢力が門を閉じる口実になる。だから形式だけは守られる。',
  },
  {
    id: 'record-mismatch',
    title: '事故の記録が一致しない',
    detail: 'ラグランジュ事故の九分間だけ、五文明の航法ログに共通する空白がある。',
  },
] as const satisfies readonly VeilSituationItem[];

export type VeilSituationId = (typeof VEIL_SITUATION)[number]['id'];

/* ------------------------------------------------------------------ *
 * 06 / Narrative constraints — 物語の原則
 * ------------------------------------------------------------------ */

export interface VeilNarrativeRule {
  id: string;
  title: string;
  detail: string;
}

/**
 * 物語の原則3項目（§06）。
 *
 * ミッション・演出・台詞を追加するときの判断基準として使う。
 * - cost: 撃墜数だけを報酬にしない。補給／時間／避難民／信頼のどれかを必ず動かす。
 *   勝利後の戦況文でも「戦況が軽くなった」表現にしない。
 * - not-monsters: 異星勢力を単一意志の怪物として書かない。同一勢力内に
 *   協定派と強硬派を用意し、無線・台詞で対立が見えるようにする。
 * - mystery-as-texture: ヴェイルの正体を伝承で説明しない。壊れたログ、
 *   異常な航路、矛盾する無線として、出撃中の現象で提示する。
 */
export const VEIL_NARRATIVE_RULES = [
  {
    id: 'cost',
    title: '戦闘には必ず代償を置く',
    detail:
      '撃墜数だけでなく、補給・時間・避難民・信頼のいずれかが変化する。勝っても戦況が軽くならない。',
  },
  {
    id: 'not-monsters',
    title: '異星文明を単純な怪物にしない',
    detail:
      '理解できない生態や価値観は持たせるが、すべての個体に同じ意志を与えない。敵にも協定派・強硬派がいる。',
  },
  {
    id: 'mystery-as-texture',
    title: '謎は現在の手触りで示す',
    detail:
      '古代文明の説明を長い伝承で済ませず、壊れたログ、異常な航路、矛盾する無線など、出撃中の現象として提示する。',
  },
] as const satisfies readonly VeilNarrativeRule[];

export type VeilNarrativeRuleId = (typeof VEIL_NARRATIVE_RULES)[number]['id'];

/* ------------------------------------------------------------------ *
 * 05 / Situation report — プレイヤーが置かれる立場
 * ------------------------------------------------------------------ */

export interface VeilPlayerStanceItem {
  id: string;
  label: string;
  detail: string;
}

/** プレイヤーが置かれる立場 4項目（§05） */
export const VEIL_PLAYER_STANCE = [
  {
    id: 'official-orders',
    label: '公式任務',
    detail: '連邦前進基地の艦載機パイロットとして、護衛・偵察・迎撃・救難を行う。',
  },
  {
    id: 'field-reality',
    label: '現場の現実',
    detail: '命令を完遂すると民間船を見捨てる場合がある。命令違反は、次の補給を失う。',
  },
  {
    id: 'enemy-side',
    label: '敵側の事情',
    detail: 'キルラシーのエースにも、守るべき誓約と帰る場所がある。',
  },
  {
    id: 'mystery',
    label: '謎の扱い',
    detail: 'ヴェイルの正体は答えではなく、通信・航法・記憶を不安定にする現象として現れる。',
  },
] as const satisfies readonly VeilPlayerStanceItem[];

export type VeilPlayerStanceId = (typeof VEIL_PLAYER_STANCE)[number]['id'];

/* ------------------------------------------------------------------ *
 * ヘルパー
 * ------------------------------------------------------------------ */

/** 勢力idから定義を引く。未知idは例外（campaign.ts の campaignNode と同じ流儀）。 */
export function veilFaction(id: VeilFactionId): (typeof VEIL_FACTIONS)[number] {
  const f = VEIL_FACTIONS.find((v) => v.id === id);
  if (!f) throw new Error(`unknown veil faction: ${id}`);
  return f;
}

/** 戦域idから定義を引く。未知idは例外。 */
export function veilTheater(id: VeilTheaterId): (typeof VEIL_THEATERS)[number] {
  const t = VEIL_THEATERS.find((v) => v.id === id);
  if (!t) throw new Error(`unknown veil theater: ${id}`);
  return t;
}
