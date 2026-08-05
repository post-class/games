/** ゲーム内で使うMP3 BGMの識別子と、public配下のファイル対応。 */
export const MUSIC_TRACKS = {
  title: '/audio/music/01-title-space-fighter-loop.mp3',
  hub: '/audio/music/06-briefing-echoes-of-time.mp3',
  briefing: '/audio/music/10-investigation-investigations.mp3',
  patrol: '/audio/music/05-patrol-crypto.mp3',
  tension: '/audio/music/07-tension-unseen-horrors.mp3',
  combat: '/audio/music/02-combat-five-armies.mp3',
  intenseCombat: '/audio/music/03-combat-impact-moderato.mp3',
  boss: '/audio/music/09-boss-black-vortex.mp3',
  victory: '/audio/music/04-combat-rising-game.mp3',
  defeat: '/audio/music/08-danger-gathering-darkness.mp3',
} as const;

/** 宿敵は既存のボス曲を別キューとして扱い、演出の保持時間を独立させる。 */
export type MusicTrackId = keyof typeof MUSIC_TRACKS | 'nemesis';

export function musicPath(id: MusicTrackId): string {
  return id === 'nemesis' ? MUSIC_TRACKS.boss : MUSIC_TRACKS[id];
}

/** 近距離の敵編隊から、その時点で最も優先する戦闘曲を決める。 */
export function combatMusicCue(nearHostiles: number, aceNearby: boolean): MusicTrackId {
  if (aceNearby) return 'boss';
  if (nearHostiles >= 4) return 'intenseCombat';
  if (nearHostiles >= 2) return 'combat';
  if (nearHostiles === 1) return 'tension';
  return 'patrol';
}
