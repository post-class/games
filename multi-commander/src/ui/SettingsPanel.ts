import { DIFFICULTIES, resetSettings, settings, updateSettings, type DifficultyId } from '../app/settings';

type Tab = 'game' | 'controls' | 'audio';

const KEY_HELP: Array<[string, string]> = [
  ['機首操縦', '↑↓←→ / マウス'],
  ['ロール', 'Q / E'],
  ['スロットル', '] [ / ホイール / 1-9 / 0'],
  ['全速 / 停止', '` / Backspace'],
  ['アフターバーナー', 'Tab (押しっぱなし)'],
  ['主砲', 'Space / 左クリック'],
  ['ミサイル', 'Enter / 右クリック'],
  ['副兵装切替', 'X'],
  ['フレア', 'G'],
  ['ターゲット 次/最至近/正面', 'T / R / Y'],
  ['オートパイロット', 'A'],
  ['通信メニュー', 'C (数字で選択)'],
  ['被害状況', 'D'],
  ['視点切替', 'F'],
  ['マウス操縦 ON/OFF', 'M'],
  ['ポーズ', 'Esc'],
];

/**
 * 設定パネル。変更は即時反映・自動保存する。
 * onChange で呼び出し側 (App) に難易度などの再適用を通知する。
 */
export function buildSettingsPanel(onChange: () => void): HTMLElement {
  const root = document.createElement('div');
  root.className = 'mc-panel';

  const tabs = document.createElement('div');
  tabs.className = 'mc-tabs';
  const body = document.createElement('div');

  let tab: Tab = 'game';

  const render = () => {
    tabs.innerHTML = '';
    for (const [id, label] of [
      ['game', 'ゲーム'],
      ['controls', '操作'],
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

    body.innerHTML = '';
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
            `被ダメ ×${DIFFICULTIES[settings.difficulty].playerDamageTaken} ／ ` +
            `同時攻撃 ${DIFFICULTIES[settings.difficulty].maxAttackers} 機まで`,
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
        rangeRow('無線ログの表示時間', settings.radioDuration, 4, 20, 1, (v) =>
          updateSettings({ radioDuration: v }),
        ),
      );
      const keys = document.createElement('div');
      keys.className = 'block';
      keys.innerHTML =
        '<h3>キー一覧</h3><div class="mc-keys">' +
        KEY_HELP.map(([k, v]) => `<div><span class="k">${k}</span><span>${v}</span></div>`).join('') +
        '</div>';
      body.appendChild(keys);
    } else {
      body.append(
        rangeRow('マスター音量', settings.volumeMaster, 0, 1, 0.05, (v) =>
          updateSettings({ volumeMaster: v }),
        ),
        rangeRow('BGM 音量', settings.volumeMusic, 0, 1, 0.05, (v) =>
          updateSettings({ volumeMusic: v }),
        ),
        rangeRow('効果音 音量', settings.volumeSfx, 0, 1, 0.05, (v) =>
          updateSettings({ volumeSfx: v }),
        ),
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

function toggleRow(label: string, value: boolean, onSet: (v: boolean) => void): HTMLElement {
  const { root, ctl } = row(label);
  const btn = document.createElement('button');
  btn.textContent = value ? 'ON' : 'OFF';
  btn.addEventListener('click', () => onSet(!value));
  ctl.appendChild(btn);
  return root;
}

function cycleRow<T extends string>(
  label: string,
  options: Array<{ value: T; label: string }>,
  value: T,
  onSet: (v: T) => void,
): HTMLElement {
  const { root, ctl } = row(label);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const prev = document.createElement('button');
  prev.textContent = '◀';
  prev.addEventListener('click', () =>
    onSet(options[(idx - 1 + options.length) % options.length].value),
  );
  const cur = document.createElement('span');
  cur.className = 'val';
  cur.style.minWidth = '9em';
  cur.style.textAlign = 'center';
  cur.textContent = options[idx].label;
  const next = document.createElement('button');
  next.textContent = '▶';
  next.addEventListener('click', () => onSet(options[(idx + 1) % options.length].value));
  ctl.append(prev, cur, next);
  return root;
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
  ctl.append(input, val);
  return root;
}

function note(text: string): HTMLElement {
  const n = document.createElement('div');
  n.className = 'mc-setting';
  n.innerHTML = `<span class="dim">${text}</span><span></span>`;
  return n;
}
