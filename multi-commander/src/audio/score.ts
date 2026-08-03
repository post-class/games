/**
 * BGM の譜面。
 *
 * オシレータだけで鳴らすが、「覚えて帰れる主題」を持たせたいので
 * 旋律を音符として書き下している。自動生成のアルペジオではなく作曲した旋律。
 *
 * 音程は MIDI ノート番号で書く (60 = C4, 69 = A4)。
 * 長さは拍数。休符は note を null にする。
 */

export type Note = { n: number | null; d: number };

export interface Layer {
  /** 音色 */
  wave: OscillatorType;
  /** ローパスのカットオフ (Hz) */
  cutoff: number;
  /** 基準音量 */
  gain: number;
  /** オクターブ移動 */
  octave?: number;
  /** この層が鳴り始める緊張度 (0..1)。省略時は常に鳴る */
  fromIntensity?: number;
  /** 音の長さを拍長に対してどれだけ伸ばすか */
  sustain?: number;
  /** 譜面 (ループする) */
  notes: Note[];
}

export interface Track {
  id: TrackId;
  /** テンポ (BPM) */
  bpm: number;
  /** 緊張度でテンポをどれだけ上げるか (BPM) */
  bpmBoost?: number;
  layers: Layer[];
}

export type TrackId = 'theme' | 'combat' | 'victory' | 'requiem';

// 音名 → MIDI。読みやすさのために使う
const A3 = 57;
const B3 = 59;
const C4 = 60;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const B4 = 71;
const C5 = 72;
const D5 = 74;
const E5 = 76;
const F5 = 77;
const G5 = 79;
const A5 = 81;
const E3 = 52;
const F3 = 53;
const G3 = 55;
const D3 = 50;
const C3 = 48;

const R = null;

/**
 * 主題「タイガーズ・クロー」。A マイナー、ゆったりした行進曲。
 * 上がって落ちる4小節を2度繰り返し、3度目で高い方へ抜ける。
 */
const THEME: Track = {
  id: 'theme',
  bpm: 84,
  layers: [
    {
      wave: 'triangle',
      cutoff: 3200,
      gain: 0.075,
      sustain: 0.95,
      notes: [
        // A: 主題の提示
        { n: A4, d: 1 }, { n: C5, d: 1 }, { n: E5, d: 1.5 }, { n: D5, d: 0.5 },
        { n: C5, d: 2 }, { n: B4, d: 2 },
        { n: A4, d: 1 }, { n: B4, d: 1 }, { n: C5, d: 1.5 }, { n: B4, d: 0.5 },
        { n: A4, d: 3 }, { n: R, d: 1 },
        // A': 同じ形を少し高く
        { n: C5, d: 1 }, { n: E5, d: 1 }, { n: G5, d: 1.5 }, { n: F5, d: 0.5 },
        { n: E5, d: 2 }, { n: D5, d: 2 },
        { n: C5, d: 1 }, { n: D5, d: 1 }, { n: E5, d: 1.5 }, { n: D5, d: 0.5 },
        { n: C5, d: 3 }, { n: R, d: 1 },
        // B: 抜ける
        { n: E5, d: 1.5 }, { n: F5, d: 0.5 }, { n: G5, d: 2 },
        { n: A5, d: 3 }, { n: G5, d: 1 },
        { n: F5, d: 1.5 }, { n: E5, d: 0.5 }, { n: D5, d: 2 },
        { n: C5, d: 2 }, { n: B4, d: 1 }, { n: A4, d: 1 },
        // 締め
        { n: A4, d: 4 },
        { n: R, d: 4 },
      ],
    },
    {
      // 内声。主題を支える3度下の動き
      wave: 'sine',
      cutoff: 1800,
      gain: 0.04,
      sustain: 0.9,
      notes: [
        { n: E4, d: 2 }, { n: A4, d: 2 },
        { n: E4, d: 2 }, { n: G4, d: 2 },
        { n: F4, d: 2 }, { n: E4, d: 2 },
        { n: E4, d: 4 },
        { n: G4, d: 2 }, { n: C5, d: 2 },
        { n: G4, d: 2 }, { n: B4, d: 2 },
        { n: A4, d: 2 }, { n: G4, d: 2 },
        { n: G4, d: 4 },
        { n: B4, d: 2 }, { n: D5, d: 2 },
        { n: C5, d: 4 },
        { n: A4, d: 2 }, { n: F4, d: 2 },
        { n: E4, d: 2 }, { n: E4, d: 2 },
        { n: A4, d: 4 },
        { n: R, d: 4 },
      ],
    },
    {
      wave: 'triangle',
      cutoff: 320,
      gain: 0.15,
      octave: -1,
      sustain: 0.8,
      notes: [
        { n: A3, d: 4 }, { n: A3, d: 4 }, { n: F3, d: 4 }, { n: E3, d: 4 },
        { n: C4, d: 4 }, { n: C4, d: 4 }, { n: A3, d: 4 }, { n: G3, d: 4 },
        { n: E4, d: 4 }, { n: C4, d: 4 }, { n: D4, d: 4 }, { n: E4, d: 4 },
        { n: A3, d: 4 }, { n: R, d: 4 },
      ],
    },
  ],
};

/**
 * 戦闘。同じ A マイナーだが、主題を刻みに崩したもの。
 * 緊張度が上がると層が増える (刻み → 裏打ち → 高音の警笛)。
 */
const COMBAT: Track = {
  id: 'combat',
  bpm: 116,
  bpmBoost: 26,
  layers: [
    {
      // 低音の刻み。常に鳴る
      wave: 'square',
      cutoff: 260,
      gain: 0.12,
      octave: -1,
      sustain: 0.45,
      notes: [
        { n: A3, d: 0.5 }, { n: A3, d: 0.5 }, { n: A3, d: 0.5 }, { n: C4, d: 0.5 },
        { n: A3, d: 0.5 }, { n: A3, d: 0.5 }, { n: G3, d: 0.5 }, { n: A3, d: 0.5 },
        { n: F3, d: 0.5 }, { n: F3, d: 0.5 }, { n: F3, d: 0.5 }, { n: A3, d: 0.5 },
        { n: E3, d: 0.5 }, { n: E3, d: 0.5 }, { n: G3, d: 0.5 }, { n: E3, d: 0.5 },
      ],
    },
    {
      // 主旋律。主題の断片を速く弾く
      wave: 'sawtooth',
      cutoff: 1500,
      gain: 0.05,
      sustain: 0.7,
      fromIntensity: 0.3,
      notes: [
        { n: A4, d: 0.5 }, { n: C5, d: 0.5 }, { n: E5, d: 1 },
        { n: D5, d: 0.5 }, { n: C5, d: 0.5 }, { n: B4, d: 1 },
        { n: A4, d: 0.5 }, { n: B4, d: 0.5 }, { n: C5, d: 1 },
        { n: B4, d: 1 }, { n: A4, d: 1 },
        { n: F4, d: 0.5 }, { n: A4, d: 0.5 }, { n: C5, d: 1 },
        { n: B4, d: 0.5 }, { n: A4, d: 0.5 }, { n: G4, d: 1 },
        { n: E4, d: 0.5 }, { n: G4, d: 0.5 }, { n: B4, d: 1 },
        { n: A4, d: 2 },
      ],
    },
    {
      // 裏打ち。中盤から
      wave: 'square',
      cutoff: 900,
      gain: 0.025,
      sustain: 0.25,
      fromIntensity: 0.5,
      notes: [
        { n: R, d: 0.5 }, { n: E5, d: 0.5 }, { n: R, d: 0.5 }, { n: E5, d: 0.5 },
        { n: R, d: 0.5 }, { n: E5, d: 0.5 }, { n: R, d: 0.5 }, { n: D5, d: 0.5 },
      ],
    },
    {
      // 高音の警笛。乱戦のときだけ
      wave: 'triangle',
      cutoff: 4000,
      gain: 0.035,
      sustain: 1.4,
      fromIntensity: 0.78,
      notes: [
        { n: A5, d: 2 }, { n: G5, d: 2 },
        { n: F5, d: 2 }, { n: E5, d: 2 },
        { n: R, d: 8 },
      ],
    },
  ],
};

/** 勝利。主題を長調 (A メジャー方向) に開いた短いファンファーレ */
const VICTORY: Track = {
  id: 'victory',
  bpm: 104,
  layers: [
    {
      wave: 'triangle',
      cutoff: 3600,
      gain: 0.085,
      sustain: 0.95,
      notes: [
        { n: A4, d: 0.5 }, { n: C5 + 1, d: 0.5 }, { n: E5, d: 1 }, { n: A5, d: 2 },
        { n: G5, d: 1 }, { n: E5, d: 1 }, { n: C5 + 1, d: 2 },
        { n: D5, d: 1 }, { n: E5, d: 1 }, { n: F5 + 1, d: 2 },
        { n: E5, d: 4 },
        { n: R, d: 4 },
      ],
    },
    {
      wave: 'sine',
      cutoff: 2000,
      gain: 0.045,
      sustain: 0.9,
      notes: [
        { n: E4, d: 2 }, { n: A4, d: 2 },
        { n: C5 + 1, d: 2 }, { n: A4, d: 2 },
        { n: B4, d: 2 }, { n: C5 + 1, d: 2 },
        { n: B4, d: 4 },
        { n: R, d: 4 },
      ],
    },
    {
      wave: 'triangle',
      cutoff: 340,
      gain: 0.16,
      octave: -1,
      sustain: 0.8,
      notes: [
        { n: A3, d: 4 }, { n: A3, d: 4 }, { n: D4, d: 4 }, { n: E4, d: 4 }, { n: A3, d: 4 },
      ],
    },
  ],
};

/** 追悼。主題を引き伸ばして低くしたもの。旋律は同じ形なので繋がって聞こえる */
const REQUIEM: Track = {
  id: 'requiem',
  bpm: 54,
  layers: [
    {
      wave: 'sine',
      cutoff: 1400,
      gain: 0.08,
      sustain: 1.0,
      notes: [
        { n: A4, d: 2 }, { n: C5, d: 2 },
        { n: B4, d: 3 }, { n: A4, d: 1 },
        { n: G4, d: 2 }, { n: F4, d: 2 },
        { n: E4, d: 4 },
        { n: F4, d: 2 }, { n: E4, d: 2 },
        { n: D4, d: 3 }, { n: C4, d: 1 },
        { n: B3, d: 4 },
        { n: A3, d: 4 },
        { n: R, d: 4 },
      ],
    },
    {
      wave: 'triangle',
      cutoff: 280,
      gain: 0.13,
      octave: -1,
      sustain: 1.0,
      notes: [
        { n: A3, d: 4 }, { n: F3, d: 4 }, { n: C3, d: 4 }, { n: E3, d: 4 },
        { n: D3, d: 4 }, { n: A3, d: 4 }, { n: E3, d: 4 }, { n: A3, d: 4 },
        { n: R, d: 4 },
      ],
    },
  ],
};

export const TRACKS: Record<TrackId, Track> = {
  theme: THEME,
  combat: COMBAT,
  victory: VICTORY,
  requiem: REQUIEM,
};

/** MIDI ノート番号 → 周波数 */
export function midiToHz(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}
