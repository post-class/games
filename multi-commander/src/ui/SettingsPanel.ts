import {
  COCKPIT_STYLES,
  COCKPIT_STYLE_LABEL,
  CONTROL_BINDINGS,
  DIFFICULTIES,
  SFX_CATEGORIES,
  SFX_CATEGORY_LABEL,
  SFX_SOURCE_LABEL,
  SFX_SOURCE_OPTIONS,
  resetSettings,
  settings,
  updateSettings,
  type DifficultyId,
  type SfxCategory,
  type SfxSource,
} from '../app/settings';
import {
  DEFAULT_MUSIC_ASSIGNMENT,
  MUSIC_CHOICES,
  MUSIC_CUES,
  MUSIC_CUE_LABEL,
  musicChoiceLabel,
  type MusicTrackId,
} from '../audio/musicCues';
import { InputManager } from '../app/input';

type Tab = 'game' | 'controls' | 'display' | 'audio';

/**
 * 設定パネルから呼び出し側 (App) へ依頼する試聴。
 *
 * ここで音を鳴らさずコールバックにしているのは、`SettingsPanel` が
 * `audio` 層を import しないため（試聴と本番の再生経路を 1本にする。specs/03 手順 5A-5）。
 * 渡されなかったときは [試聴] ボタンを出さない。
 */
export interface SettingsPanelActions {
  previewMusic?(cue: MusicTrackId): void;
  previewSfx?(category: SfxCategory): void;
}

/**
 * 設定パネル。変更は即時反映・自動保存する。
 * onChange で呼び出し側 (App) に難易度などの再適用を通知する。
 *
 * タブは `ゲーム / 操作 / 表示 / オーディオ` の 4つ（W4）。
 * 見た目の項目は「表示」へ、ゲームパッド振動は「操作」へ集約した（挙動と保存キーは変えない）。
 */
export function buildSettingsPanel(
  onChange: () => void,
  actions?: SettingsPanelActions,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'mc-panel';

  const tabs = document.createElement('div');
  tabs.className = 'mc-tabs';
  const body = document.createElement('div');

  let tab: Tab = 'game';

  const render = () => {
    // 子を捨てるのは `replaceChildren()` で行う（`innerHTML = ''` と違い、
    // 要素を作り直したことが DOM の構造として明確になる）
    tabs.replaceChildren();
    for (const [id, label] of [
      ['game', 'ゲーム'],
      ['controls', '操作'],
      ['display', '表示'],
      ['audio', 'オーディオ'],
    ] as Array<[Tab, string]>) {
      const t = document.createElement('div');
      t.className = `mc-tab${tab === id ? ' sel' : ''}`;
      t.textContent = label;
      t.addEventListener('click', () => {
        tab = id;
        render();
      });
      tabs.appendChild(t);
    }

    body.replaceChildren();
    if (tab === 'game') {
      body.append(
        cycleRow(
          '難易度',
          (['easy', 'normal', 'hard'] as DifficultyId[]).map((d) => ({
            value: d,
            label: DIFFICULTIES[d].label,
          })),
          settings.difficulty,
          (v) => {
            updateSettings({ difficulty: v });
            onChange();
            render();
          },
        ),
        toggleRow('照準アシスト (リード表示を強調)', settings.aimAssist, (v) => {
          updateSettings({ aimAssist: v });
          render();
        }),
        toggleRow('高度な操作を有効化 (飛行モード切替 Z)', settings.advanced, (v) => {
          updateSettings({ advanced: v });
          render();
        }),
        note(
          `敵技量 ${Math.round(DIFFICULTIES[settings.difficulty].enemySkill * 100)}% ／ ` +
            `敵速度 ${Math.round(DIFFICULTIES[settings.difficulty].enemySpeedScale * 100)}% ／ ` +
            `被ダメ ×${DIFFICULTIES[settings.difficulty].playerDamageTaken} ／ ` +
            `同時攻撃 ${DIFFICULTIES[settings.difficulty].maxAttackers} 機まで ／ ` +
            `主砲弾速 ${Math.round(DIFFICULTIES[settings.difficulty].playerGunSpeedScale * 100)}% ／ ` +
            `ミサイル搭載 ${Math.round(DIFFICULTIES[settings.difficulty].playerMissileCountScale * 100)}%`,
        ),
      );
    } else if (tab === 'controls') {
      body.append(
        toggleRow('マウス操縦', settings.mouseFlight, (v) => {
          updateSettings({ mouseFlight: v });
          onChange();
          render();
        }),
        rangeRow('マウス感度', settings.mouseSensitivity, 0.3, 2.5, 0.1, (v) => {
          updateSettings({ mouseSensitivity: v });
        }),
        toggleRow('上下反転 (Y 軸)', settings.invertY, (v) => {
          updateSettings({ invertY: v });
          render();
        }),
        toggleRow('ゲームパッドのアナログスロットル', settings.gamepadThrottle, (v) => {
          updateSettings({ gamepadThrottle: v });
          render();
        }),
        rangeRow('ゲームパッド デッドゾーン', settings.gamepadDeadzone, 0, 0.4, 0.01, (v) =>
          updateSettings({ gamepadDeadzone: v }),
        ),
        rangeRow('ゲームパッド感度', settings.gamepadSensitivity, 0.3, 2.5, 0.1, (v) =>
          updateSettings({ gamepadSensitivity: v }),
        ),
        // オーディオタブから移動（見た目でも音でもないので操作へ。方針書 §5）
        toggleRow('ゲームパッド振動', settings.gamepadRumble, (v) => {
          updateSettings({ gamepadRumble: v });
          render();
        }),
      );
      if (settings.advanced) {
        body.append(
          cycleRow(
            '飛行モード',
            [
              { value: 'wc' as const, label: 'WC (機首追従)' },
              { value: 'newton' as const, label: 'Newton (純慣性)' },
            ],
            settings.flightMode,
            (v) => {
              updateSettings({ flightMode: v });
              render();
            },
          ),
        );
      }
      body.append(
        // W7-3: ミサイルロックの方式
        cycleRow(
          'ミサイルロック',
          [
            { value: 'auto' as const, label: '自動' },
            { value: 'manual' as const, label: '手動' },
          ],
          settings.missileLock,
          (v) => {
            updateSettings({ missileLock: v });
            render();
          },
        ),
        note(
          `手動では ${InputManager.keyLabel(settings.keyBindings.manualLock)} を押した目標だけロックします`,
        ),
        toggleRow('自動水平 (ロール補助)', settings.autoLevel, (v) => {
          updateSettings({ autoLevel: v });
          render();
        }),
        toggleRow('旋回補助 (目標へ微補正)', settings.turnAssist, (v) => {
          updateSettings({ turnAssist: v });
          render();
        }),
        toggleRow('被弾時の時間減速', settings.timeSlowAssist, (v) => {
          updateSettings({ timeSlowAssist: v });
          render();
        }),
      );
      body.appendChild(bindingPanel(render));
    } else if (tab === 'display') {
      // コクピットの表示方法（W4）。選択肢とラベルは settings 側の表から作る
      body.append(
        cycleRow(
          'コクピット表示',
          COCKPIT_STYLES.map((s) => ({ value: s, label: COCKPIT_STYLE_LABEL[s] })),
          settings.cockpitStyle,
          (v) => {
            updateSettings({ cockpitStyle: v });
            onChange();
            render();
          },
        ),
      );
      // ガラスを出す表示方法のときだけ濃さを触れるようにする
      if (settings.cockpitStyle === 'full' || settings.cockpitStyle === 'glass') {
        body.appendChild(
          rangeRow('ガラスの映り込み', settings.glassOpacity, 0, 1, 0.05, (v) => {
            updateSettings({ glassOpacity: v });
          }),
        );
      }
      body.append(
        rangeRow('被弾カメラ揺れ', settings.cameraShake, 0, 1, 0.05, (v) =>
          updateSettings({ cameraShake: v }),
        ),
        rangeRow('追尾視点の遅延', settings.cameraFollowLag, 0, 1, 0.05, (v) =>
          updateSettings({ cameraFollowLag: v }),
        ),
        rangeRow('アフターバーナー画角', settings.cameraFovKick, 0, 1, 0.05, (v) =>
          updateSettings({ cameraFovKick: v }),
        ),
        toggleRow('ブルーム (発光のにじみ)', settings.bloom, (v) => {
          updateSettings({ bloom: v });
          onChange();
          render();
        }),
        toggleRow('閃光を抑える', settings.reducedFlashes, (v) => {
          updateSettings({ reducedFlashes: v });
          render();
        }),
        toggleRow('色覚サポート配色', settings.colorblindMode, (v) => {
          updateSettings({ colorblindMode: v });
          onChange();
          render();
        }),
        rangeRow('無線字幕サイズ', settings.subtitleScale, 0.8, 1.8, 0.1, (v) =>
          updateSettings({ subtitleScale: v }),
        ),
        rangeRow('無線ログの表示時間', settings.radioDuration, 4, 20, 1, (v) =>
          updateSettings({ radioDuration: v }),
        ),
        note(
          'コクピット表示: 風防のガラスは奥の敵機を隠しません。視界を最大にしたいときは「計器盤のみ」。',
        ),
      );
    } else {
      body.append(
        block('音量', [
          rangeRow('マスター音量', settings.volumeMaster, 0, 1, 0.05, (v) =>
            updateSettings({ volumeMaster: v }),
          ),
          rangeRow('BGM 音量', settings.volumeMusic, 0, 1, 0.05, (v) =>
            updateSettings({ volumeMusic: v }),
          ),
          rangeRow('効果音 音量', settings.volumeSfx, 0, 1, 0.05, (v) =>
            updateSettings({ volumeSfx: v }),
          ),
        ]),
        musicBlock(actions, render),
        sfxBlock(actions, render),
      );
    }

    const reset = document.createElement('div');
    reset.className = 'mc-setting';
    const lbl = document.createElement('span');
    lbl.textContent = '初期設定に戻す';
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const btn = document.createElement('button');
    btn.textContent = 'リセット';
    btn.addEventListener('click', () => {
      resetSettings();
      onChange();
      render();
    });
    ctl.appendChild(btn);
    reset.append(lbl, ctl);
    body.appendChild(reset);
  };

  render();
  root.append(tabs, body);
  return root;
}

function row(label: string): { root: HTMLElement; ctl: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'mc-setting';
  const l = document.createElement('span');
  l.textContent = label;
  const ctl = document.createElement('div');
  ctl.className = 'ctl';
  root.append(l, ctl);
  return { root, ctl };
}

/**
 * 見出し付きのセクション。
 * 行数が増えると縦に長くなるので、意味のまとまりごとに `.block` で区切る
 * （見出しの書式は既存の `.mc-panel .block h3` に合わせる。文字を大きくしない）。
 */
function block(title: string, rows: HTMLElement[], gridClass?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'block';
  const h = document.createElement('h3');
  h.textContent = title;
  el.appendChild(h);
  if (gridClass) {
    // 広い画面では複数列に畳んで縦を短くする（狭い画面では CSS 側で 1列に戻る）
    const grid = document.createElement('div');
    grid.className = gridClass;
    grid.append(...rows);
    el.appendChild(grid);
  } else {
    el.append(...rows);
  }
  return el;
}

/** 場面ごとの BGM（W5-A）。11 場面 × ランダム + 曲10本 + 無音。 */
function musicBlock(actions: SettingsPanelActions | undefined, onRender: () => void): HTMLElement {
  const options = MUSIC_CHOICES.map((c) => ({ value: c, label: musicChoiceLabel(c) }));
  const rows = MUSIC_CUES.map((cue) => {
    const current = settings.musicAssignment[cue] ?? DEFAULT_MUSIC_ASSIGNMENT[cue];
    const { root, ctl } = row(MUSIC_CUE_LABEL[cue]);
    ctl.append(
      ...cycleControls(options, current, (v) => {
        updateSettings({ musicAssignment: { ...settings.musicAssignment, [cue]: v } });
        onRender();
      }),
    );
    if (actions?.previewMusic) {
      ctl.appendChild(previewButton(() => actions.previewMusic?.(cue)));
    }
    return root;
  });
  const desc = note(
    '戦闘中の曲は近くの敵の数で切り替わります（哨戒 0 / 緊張 1 / 戦闘 2〜3 / 激戦 4機以上）。' +
      '「ランダム」はその場面に入るたび候補から選び直します（直前と同じ曲は避けます）。曲名を選ぶと固定できます。',
  );
  // 2列グリッドの中でも説明は 1行ぶん全幅で読ませる
  desc.classList.add('mc-setting-wide');
  rows.push(desc);
  return block('BGM', rows, 'mc-setting-grid');
}

/** 効果音のカテゴリ設定（W5-B）。音源は `SFX_SOURCE_OPTIONS` から作る。 */
function sfxBlock(actions: SettingsPanelActions | undefined, onRender: () => void): HTMLElement {
  const rows = SFX_CATEGORIES.map((category) => {
    const current = settings.sfx[category];
    const { root, ctl } = row(SFX_CATEGORY_LABEL[category]);
    ctl.append(
      ...cycleControls(
        SFX_SOURCE_OPTIONS[category].map((s) => ({ value: s, label: SFX_SOURCE_LABEL[s] })),
        current.source,
        (v: SfxSource) => {
          updateSettings({
            sfx: { ...settings.sfx, [category]: { ...current, source: v } },
          });
          onRender();
        },
        '5em',
      ),
      ...rangeControls(current.gain, 0, 1, 0.05, (v) => {
        updateSettings({ sfx: { ...settings.sfx, [category]: { ...current, gain: v } } });
      }),
    );
    if (actions?.previewSfx) {
      ctl.appendChild(previewButton(() => actions.previewSfx?.(category)));
    }
    return root;
  });
  rows.push(
    note(
      '「実音声」は同梱の録音、「合成音」はゲーム内で作る音です。「控えめ」は音量と長さを抑えます。',
    ),
  );
  return block('効果音', rows);
}

/** [試聴] ボタン。`actions` を渡さないときは呼ばれない（ボタン自体を出さない）。 */
function previewButton(onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mc-preview';
  btn.textContent = '試聴';
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * キー割り当ての一覧。
 * ボタンを押してから次のキー入力を捕まえるため、ゲーム側の入力処理より先に
 * capture フェーズでイベントを止める。設定画面を開いたままでも誤発射しない。
 */
function bindingPanel(onRender: () => void): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'block mc-bindings';
  const title = document.createElement('h3');
  title.textContent = 'キー割り当て';
  panel.appendChild(title);

  const help = document.createElement('div');
  help.className = 'dim mc-binding-help';
  help.textContent = '変更したい項目のボタンを押し、割り当てるキーを入力。Esc で取消。';
  panel.appendChild(help);

  for (const { id, label } of CONTROL_BINDINGS) {
    const { root, ctl } = row(label);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = InputManager.keyLabel(settings.keyBindings[id]);
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = '入力待ち…';
      const onKey = (ev: KeyboardEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        if (ev.code === 'Escape') {
          onRender();
          return;
        }
        const keyBindings = { ...settings.keyBindings, [id]: ev.code };
        updateSettings({ keyBindings });
        onRender();
      };
      window.addEventListener('keydown', onKey, true);
    });
    ctl.appendChild(button);
    root.classList.add('mc-binding-row');
    panel.appendChild(root);
  }

  const pad = document.createElement('div');
  pad.className = 'dim mc-binding-help';
  pad.textContent =
    'ゲームパッド: 左スティック=機首、RT=主砲、A/LT=ミサイル、LB/RB=ロール、右スティック縦=スロットル。';
  panel.appendChild(pad);
  return panel;
}

function toggleRow(label: string, value: boolean, onSet: (v: boolean) => void): HTMLElement {
  const { root, ctl } = row(label);
  const btn = document.createElement('button');
  btn.textContent = value ? 'ON' : 'OFF';
  btn.addEventListener('click', () => onSet(!value));
  ctl.appendChild(btn);
  return root;
}

/** ◀ 値 ▶ の3点セット。1行に他の操作（音量スライダ・試聴）も並べるので部品で返す。 */
function cycleControls<T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
  onSet: (v: T) => void,
  minWidth = '9em',
): HTMLElement[] {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const prev = document.createElement('button');
  prev.textContent = '◀';
  prev.addEventListener('click', () =>
    onSet(options[(idx - 1 + options.length) % options.length].value),
  );
  const cur = document.createElement('span');
  cur.className = 'val';
  cur.style.minWidth = minWidth;
  cur.style.textAlign = 'center';
  cur.textContent = options[idx].label;
  const next = document.createElement('button');
  next.textContent = '▶';
  next.addEventListener('click', () => onSet(options[(idx + 1) % options.length].value));
  return [prev, cur, next];
}

function cycleRow<T extends string>(
  label: string,
  options: Array<{ value: T; label: string }>,
  value: T,
  onSet: (v: T) => void,
): HTMLElement {
  const { root, ctl } = row(label);
  ctl.append(...cycleControls(options, value, onSet));
  return root;
}

/** スライダと現在値。`cycleControls` と同じ理由で部品で返す。 */
function rangeControls(
  value: number,
  min: number,
  max: number,
  step: number,
  onSet: (v: number) => void,
): HTMLElement[] {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = document.createElement('span');
  val.className = 'val';
  const fmt = (v: number) =>
    max <= 1 ? `${Math.round(v * 100)}%` : step >= 1 ? `${v.toFixed(0)}s` : v.toFixed(1);
  val.textContent = fmt(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    onSet(v);
  });
  return [input, val];
}

function rangeRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onSet: (v: number) => void,
): HTMLElement {
  const { root, ctl } = row(label);
  ctl.append(...rangeControls(value, min, max, step, onSet));
  return root;
}

function note(text: string): HTMLElement {
  const n = document.createElement('div');
  n.className = 'mc-setting';
  n.innerHTML = `<span class="dim">${text}</span><span></span>`;
  return n;
}
