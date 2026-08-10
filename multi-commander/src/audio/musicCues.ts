/**
 * BGM の「場面」と「曲ファイル」の対応。
 *
 * 07_更なる改善 W5-A で、場面キュー (`MusicTrackId`) と曲ファイル (`MusicFileId`) を
 * **別の型に分けた**。以前は 1つの表が両方を兼ねていたため、
 * 「この場面では別の曲を鳴らす」を表現できなかった。
 *
 * 設定からの差し替えは `setMusicAssignment()` で受ける。
 * ここは純関数の層に保ち、`app/settings` を import しない
 * （テストから場面と曲の対応だけを検証できるようにするため）。
 */

/** 同梱している曲ファイル。値は public 配下のパス。 */
export const MUSIC_FILES = {
  'title-space-fighter': '/audio/music/01-title-space-fighter-loop.mp3',
  'combat-five-armies': '/audio/music/02-combat-five-armies.mp3',
  'combat-impact-moderato': '/audio/music/03-combat-impact-moderato.mp3',
  'combat-rising-game': '/audio/music/04-combat-rising-game.mp3',
  'patrol-crypto': '/audio/music/05-patrol-crypto.mp3',
  'briefing-echoes-of-time': '/audio/music/06-briefing-echoes-of-time.mp3',
  'tension-unseen-horrors': '/audio/music/07-tension-unseen-horrors.mp3',
  'danger-gathering-darkness': '/audio/music/08-danger-gathering-darkness.mp3',
  'boss-black-vortex': '/audio/music/09-boss-black-vortex.mp3',
  'investigation-investigations': '/audio/music/10-investigation-investigations.mp3',
} as const;

export type MusicFileId = keyof typeof MUSIC_FILES;

/** 場面に割り当てられる選択肢。`'silent'` はその場面で鳴らさない。 */
export type MusicChoice = MusicFileId | 'silent';

/**
 * 場面キュー。曲ではなく「どういう場面か」を表す。
 * `nemesis` は宿敵の演出用で、既定では boss と同じ曲を鳴らすが**別の場面として選べる**。
 */
export const MUSIC_CUES = [
  'title',
  'hub',
  'briefing',
  'patrol',
  'tension',
  'combat',
  'intenseCombat',
  'boss',
  'nemesis',
  'victory',
  'defeat',
] as const;

export type MusicTrackId = (typeof MUSIC_CUES)[number];

/** 場面 → 曲の既定対応。W5-A 以前の聞こえ方をそのまま写したもの。 */
export const DEFAULT_MUSIC_ASSIGNMENT: Record<MusicTrackId, MusicChoice> = {
  title: 'title-space-fighter',
  hub: 'briefing-echoes-of-time',
  briefing: 'investigation-investigations',
  patrol: 'patrol-crypto',
  tension: 'tension-unseen-horrors',
  combat: 'combat-five-armies',
  intenseCombat: 'combat-impact-moderato',
  boss: 'boss-black-vortex',
  // 従来 musicPath() が nemesis を boss へ落としていたのと同じ結果になる
  nemesis: 'boss-black-vortex',
  victory: 'combat-rising-game',
  defeat: 'danger-gathering-darkness',
};

/** 場面の表示名。設定画面と試聴パネルが同じ文字列を使う。 */
export const MUSIC_CUE_LABEL: Record<MusicTrackId, string> = {
  title: 'タイトル',
  hub: '母艦（艦内）',
  briefing: 'ブリーフィング',
  patrol: '哨戒（敵なし）',
  tension: '緊張（敵1機）',
  combat: '戦闘（敵2〜3機）',
  intenseCombat: '激戦（敵4機以上）',
  boss: 'ボス・エース',
  nemesis: '宿敵の演出',
  victory: '勝利',
  defeat: '敗北',
};

/** 曲の表示名。番号を前置して並び順が分かるようにする。 */
export const MUSIC_FILE_LABEL: Record<MusicFileId, string> = {
  'title-space-fighter': '01 Space Fighter',
  'combat-five-armies': '02 Five Armies',
  'combat-impact-moderato': '03 Impact Moderato',
  'combat-rising-game': '04 Rising Game',
  'patrol-crypto': '05 Crypto',
  'briefing-echoes-of-time': '06 Echoes of Time',
  'tension-unseen-horrors': '07 Unseen Horrors',
  'danger-gathering-darkness': '08 Gathering Darkness',
  'boss-black-vortex': '09 Black Vortex',
  'investigation-investigations': '10 Investigations',
};

/** 設定画面に出す選択肢の順番。曲10本 + 無音。 */
export const MUSIC_CHOICES: MusicChoice[] = [
  ...(Object.keys(MUSIC_FILES) as MusicFileId[]),
  'silent',
];

export function isMusicCue(value: unknown): value is MusicTrackId {
  return typeof value === 'string' && (MUSIC_CUES as readonly string[]).includes(value);
}

export function isMusicChoice(value: unknown): value is MusicChoice {
  if (value === 'silent') return true;
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MUSIC_FILES, value);
}

/** 選択肢の表示名（無音を含む）。 */
export function musicChoiceLabel(choice: MusicChoice): string {
  return choice === 'silent' ? '無音' : MUSIC_FILE_LABEL[choice];
}

let assignment: Record<MusicTrackId, MusicChoice> = { ...DEFAULT_MUSIC_ASSIGNMENT };

/**
 * 場面 → 曲の対応を上書きする（設定から呼ぶ）。
 *
 * 未知の場面キー・未知の曲 id は無視して既定を保つ。
 * 壊れた保存データで全場面が無音になると「音が出ない不具合」に見えるため、
 * ここで必ず既定へ落とす。
 */
export function setMusicAssignment(next: Partial<Record<string, unknown>> | undefined): void {
  const merged: Record<MusicTrackId, MusicChoice> = { ...DEFAULT_MUSIC_ASSIGNMENT };
  if (next) {
    for (const [cue, choice] of Object.entries(next)) {
      if (isMusicCue(cue) && isMusicChoice(choice)) merged[cue] = choice;
    }
  }
  assignment = merged;
}

/** 現在の割り当て（設定画面の表示用）。 */
export function musicAssignment(): Readonly<Record<MusicTrackId, MusicChoice>> {
  return assignment;
}

/** 場面に割り当てられている曲。 */
export function musicChoice(id: MusicTrackId): MusicChoice {
  return assignment[id] ?? DEFAULT_MUSIC_ASSIGNMENT[id];
}

/** 場面に対応する曲のパス。`'silent'` を選んだ場面は空文字を返す。 */
export function musicPath(id: MusicTrackId): string {
  const choice = musicChoice(id);
  return choice === 'silent' ? '' : MUSIC_FILES[choice];
}

/** 近距離の敵編隊から、その時点で最も優先する戦闘曲を決める。 */
export function combatMusicCue(nearHostiles: number, aceNearby: boolean): MusicTrackId {
  if (aceNearby) return 'boss';
  if (nearHostiles >= 4) return 'intenseCombat';
  if (nearHostiles >= 2) return 'combat';
  if (nearHostiles === 1) return 'tension';
  return 'patrol';
}
