import type { AudioManager } from './AudioManager';
import { musicPath, type MusicTrackId } from './musicCues';

/** 曲を切り替えるときのクロスフェード時間。 */
const CROSSFADE_SECONDS = 0.75;
/** 戦況起因の選曲を維持する最低時間。 */
const BATTLE_HOLD_SECONDS = 3;

/** テストでも扱えるよう、HTMLAudioElementから使う最小のインターフェースだけを表す。 */
export interface MusicMedia {
  src: string;
  loop: boolean;
  preload: string;
  volume: number;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'error', listener: () => void): void;
}

interface Playback {
  id: MusicTrackId;
  media: MusicMedia;
  level: number;
  target: number;
  failed: boolean;
}

type MusicOutput = Pick<AudioManager, 'musicNode' | 'connectMusicElement'>;
type MediaFactory = () => MusicMedia;

function browserMedia(): MusicMedia {
  return new Audio();
}

/**
 * MP3 BGMの再生とクロスフェードを担当する。
 * AudioManagerのmusicBusへ接続するので、既存の音量設定がそのまま有効になる。
 */
export class MusicDirector {
  private active?: Playback;
  private fading: Playback[] = [];
  private requested?: MusicTrackId;
  private battleCue?: MusicTrackId;
  private battleCueAt = 0;
  private elapsed = 0;

  constructor(
    private audio: MusicOutput,
    private readonly createMedia: MediaFactory = browserMedia,
  ) {}

  /** 画面遷移など、即時に切り替える曲を指定する。 */
  play(id: MusicTrackId): void {
    this.battleCue = undefined;
    this.request(id);
  }

  /** 戦況で曲を選ぶ。切替後3秒間は現在の戦闘曲を維持する。 */
  playBattle(id: MusicTrackId): void {
    if (this.battleCue === id) return;
    if (this.battleCue !== undefined && this.elapsed - this.battleCueAt < BATTLE_HOLD_SECONDS) return;
    this.battleCue = id;
    this.battleCueAt = this.elapsed;
    this.request(id);
  }

  /** 初回ユーザー操作でAudioContextが有効になった後、要求済みの曲を鳴らす。 */
  start(): void {
    if (this.requested) this.ensurePlayback(this.requested);
  }

  stop(): void {
    this.active?.media.pause();
    for (const playback of this.fading) playback.media.pause();
    this.active = undefined;
    this.fading = [];
    this.requested = undefined;
    this.battleCue = undefined;
  }

  get current(): MusicTrackId | undefined {
    return this.requested;
  }

  /** 毎フレーム: AudioContext準備後の再生開始とクロスフェードを進める。 */
  update(dt: number): void {
    this.elapsed += Math.max(0, dt);
    if (this.requested && !this.active) this.ensurePlayback(this.requested);
    this.fade(this.active, dt);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const playback = this.fading[i];
      this.fade(playback, dt);
      if (playback.level <= 0.001) {
        playback.media.pause();
        this.fading.splice(i, 1);
      }
    }
  }

  private request(id: MusicTrackId): void {
    if (this.requested === id) return;
    this.requested = id;
    this.ensurePlayback(id);
  }

  private ensurePlayback(id: MusicTrackId): void {
    if (
      (this.active?.id === id ||
        (this.active && !this.active.failed && musicPath(this.active.id) === musicPath(id))) ||
      !this.audio.musicNode
    ) return;

    let media: MusicMedia;
    try {
      media = this.createMedia();
      media.src = musicPath(id);
      media.loop = true;
      media.preload = 'auto';
      media.volume = 0;
      if (!this.audio.connectMusicElement(media as unknown as HTMLMediaElement)) return;
    } catch {
      // 古いブラウザや音声出力初期化の失敗では、BGMだけ無音でゲームを続行する。
      return;
    }

    const next: Playback = { id, media, level: 0, target: 1, failed: false };
    media.addEventListener('error', () => {
      next.failed = true;
      next.target = 0;
    });
    if (this.active) {
      this.active.target = 0;
      this.fading.push(this.active);
    }
    this.active = next;
    void media.play().catch(() => {
      next.failed = true;
      next.target = 0;
    });
  }

  private fade(playback: Playback | undefined, dt: number): void {
    if (!playback) return;
    if (playback.failed) {
      playback.level = 0;
      playback.media.volume = 0;
      return;
    }
    const step = Math.min(1, dt / CROSSFADE_SECONDS);
    playback.level =
      playback.target > playback.level
        ? Math.min(playback.target, playback.level + step)
        : Math.max(playback.target, playback.level - step);
    playback.media.volume = Math.max(0, Math.min(1, playback.level));
  }
}
