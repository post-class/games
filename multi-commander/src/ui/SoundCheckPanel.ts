import { MUSIC_TRACKS, type MusicTrackId } from '../audio/musicCues';

export interface SoundCheckActions {
  playMusic: (track: MusicTrackId) => void;
  playVoice: (tone: 'friendly' | 'enemy' | 'command', speaker: string, text: string) => void;
}

/**
 * BGM と合成無線を人間が実際に聴き比べるための小さな試聴パネル。
 * 音量・帯域・抑揚の確認は自動テストでは代替できないため、ゲーム内から
 * 同じ出力経路を使って確認できるようにする。
 */
export function buildSoundCheckPanel(actions: SoundCheckActions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'block mc-sound-check';

  const title = document.createElement('h3');
  title.textContent = 'サウンドチェック';
  root.appendChild(title);

  const help = document.createElement('div');
  help.className = 'dim';
  help.textContent = '各曲を十数秒ずつ聴き、音量の飛び・耳に刺さる音・無線の聞き取りやすさを確認してください。';
  root.appendChild(help);

  const music = document.createElement('div');
  music.className = 'mc-sound-check-grid';
  const labels: Partial<Record<MusicTrackId, string>> = {
    title: 'タイトル',
    hub: '母艦',
    briefing: 'ブリーフィング',
    patrol: '哨戒',
    tension: '緊張',
    combat: '戦闘',
    intenseCombat: '激戦',
    boss: '宿敵',
    victory: '勝利',
    defeat: '敗北',
  };
  (Object.keys(MUSIC_TRACKS) as Array<keyof typeof MUSIC_TRACKS>).forEach((track) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = labels[track] ?? track;
    button.addEventListener('click', () => actions.playMusic(track));
    music.appendChild(button);
  });
  root.appendChild(music);

  const voice = document.createElement('div');
  voice.className = 'mc-sound-check-grid';
  const samples: Array<{ tone: 'friendly' | 'enemy' | 'command'; speaker: string; label: string; text: string }> = [
    { tone: 'friendly', speaker: 'Sable', label: '僚機の声', text: 'こちらセーブル。帰投経路を確保した。' },
    { tone: 'enemy', speaker: 'Ralgha', label: '宿敵の声', text: 'また会ったな。今度は逃がさない。' },
    { tone: 'command', speaker: 'Claw', label: '母艦の声', text: '全機、隊形を維持して帰投せよ。' },
  ];
  samples.forEach((sample) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = sample.label;
    button.addEventListener('click', () => actions.playVoice(sample.tone, sample.speaker, sample.text));
    voice.appendChild(button);
  });
  root.appendChild(voice);
  return root;
}
