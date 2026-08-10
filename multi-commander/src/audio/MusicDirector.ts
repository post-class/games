import type { AudioManager } from './AudioManager';
import { musicChoice, resolveMusicPath, type MusicTrackId } from './musicCues';

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
  /** 実際に鳴らしているファイル。`'random'` の場面は抽選結果をここで固定する。 */
  path: string;
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
    // 設定でこの場面を「無音」にしている（W5-A）。鳴っている曲は落とす。
    // requested は更新済みなので、別の場面へ移れば普通に鳴り出す。
    if (musicChoice(id) === 'silent') {
      if (this.active) {
        this.active.target = 0;
        this.fading.push(this.active);
        this.active = undefined;
      }
      return;
    }
    // 同じ場面の再要求では鳴らし直さない（`'random'` の抽選もし直さない）。
    if (this.active?.id === id || !this.audio.musicNode) return;

    // 抽選はここで 1 回だけ。以降の比較・再生は確定したパスを使う。
    const path = resolveMusicPath(id, this.active && !this.active.failed ? this.active.path : undefined);
    if (path === '') return;
    // 別の場面だが同じ曲になった場合（例: ボス→宿敵）は、二重にクロスフェードしない。
    if (this.active && !this.active.failed && this.active.path === path) {
      this.active.id = id;
      return;
    }

    let media: MusicMedia;
    try {
      media = this.createMedia();
      media.src = path;
      media.loop = true;
      media.preload = 'auto';
      media.volume = 0;
      if (!this.audio.connectMusicElement(media as unknown as HTMLMediaElement)) return;
    } catch {
      // 古いブラウザや音声出力初期化の失敗では、BGMだけ無音でゲームを続行する。
      return;
    }

    const next: Playback = { id, path, media, level: 0, target: 1, failed: false };
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
