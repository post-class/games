/**
 * E2Eで使い回すヘルパ。
 *
 * 方針:
 * - 固定待ち（waitForTimeout）は「キーを押し続ける時間」など**意味のある時間**だけに使う
 * - 状態の待ちは必ず `expect.poll` / `waitForFunction` で条件待ちにする（4Hz tick = 250ms周期）
 * - `Math.random()` は使わない（テストを不安定にしない）
 */
import { expect, type ConsoleMessage, type Page } from '@playwright/test';
import { TICK_MS } from './constants.ts';

/** デバッグパネルから読み取った値 */
export interface DebugReadout {
  fps: number;
  /** レンダラ種別（webgl / webgpu / canvas） */
  render: string;
  /** 接続状態（connecting / open / reconnecting / closed / mock） */
  net: string;
  rttMs: number;
  tick: number;
  actors: number;
  drawn: number;
  chunks: number;
  zoom: number;
  /** 自機の位置。クライアントが `pos` 行を出していないときは null */
  pos: { x: number; y: number } | null;
}

export const DEBUG_PANEL = '[data-testid=debug-panel]';
export const HUD_NET = '[data-testid=hud-net]';
export const HUD_CLOCK = '[data-testid=hud-clock]';
/** 起動オーバーレイ。`data-testid` が無いのでIDで拾っている（README参照） */
export const BOOT_OVERLAY = '#boot';

/**
 * ゲームを開き、起動オーバーレイが消える（= welcome受信）まで待つ。
 * `?debug=1` は常に付ける（デバッグパネルが検証の主要な窓口）。
 */
export async function gotoGame(page: Page, params: Record<string, string> = {}): Promise<void> {
  await installWsTap(page);
  const q = new URLSearchParams({ debug: '1', ...params });
  await page.goto(`/?${q.toString()}`);
  await waitForBooted(page);
}

/** 起動オーバーレイが消えて、デバッグパネルに値が入るまで待つ */
export async function waitForBooted(page: Page): Promise<void> {
  // boot は `hidden` クラスが付くだけ（display:none にはならない）ので class を見る
  await page.waitForFunction(
    () => document.querySelector('#boot')?.classList.contains('hidden') === true,
    undefined,
    { timeout: 30_000 },
  );
  // パネルは500msごとにしか更新されないので、1行目が入るまで待つ
  await page.waitForFunction(
    () => (document.querySelector('[data-testid=debug-panel]')?.textContent ?? '').includes('fps'),
    undefined,
    { timeout: 30_000 },
  );
}

function firstNumber(text: string, re: RegExp): number {
  const m = re.exec(text);
  const raw = m?.[1];
  return raw === undefined ? Number.NaN : Number(raw);
}

/** デバッグパネルのテキストを構造化して返す */
export async function readDebug(page: Page): Promise<DebugReadout> {
  const text = (await page.locator(DEBUG_PANEL).textContent()) ?? '';
  const posMatch = /pos\s+(-?[\d.]+)[,\s]+\s*(-?[\d.]+)/.exec(text);
  const px = posMatch?.[1];
  const py = posMatch?.[2];
  return {
    fps: firstNumber(text, /fps\s+(-?[\d.]+)/),
    render: /render\s+(\S+)/.exec(text)?.[1] ?? '',
    net: /net\s+(\S+)/.exec(text)?.[1] ?? '',
    rttMs: firstNumber(text, /net\s+\S+\s+(-?[\d.]+)ms/),
    tick: firstNumber(text, /tick\s+(-?[\d.]+)/),
    actors: firstNumber(text, /actors\s+(-?[\d.]+)/),
    drawn: firstNumber(text, /draw\s+(-?[\d.]+)/),
    chunks: firstNumber(text, /chunks\s+(-?[\d.]+)/),
    zoom: firstNumber(text, /zoom\s+(-?[\d.]+)/),
    pos: px !== undefined && py !== undefined ? { x: Number(px), y: Number(py) } : null,
  };
}

// ---------------------------------------------------------------------------
// WebSocketの盗聴（クライアントに手を入れずに、サーバ真値を検証に使う）
// ---------------------------------------------------------------------------
//
// クライアントは内部状態を window に公開していないため、位置や地形を直接読めない。
// そこで `window.WebSocket` を包んで受信メッセージを覗く。
// これは**テスト側だけの仕込み**（addInitScript）なので、製品コードは一切変わらない。

/** ページ内に溜めるサーバ真値 */
export interface WsTapState {
  seed: string | null;
  islandId: string | null;
  selfId: number | null;
  /** サーバが送ってきた生存アクターの位置（自分も他人も含む） */
  actors: Record<number, { x: number; y: number }>;
  /** "cx,cy" → 地形RLEを文字列化したもの */
  chunks: Record<string, string>;
  /** 直近に受け取った delta / snapshot の tick */
  lastTick: number;
  /** welcome を受けた回数（再接続の検証に使う） */
  welcomeCount: number;
}

const EMPTY_TAP: WsTapState = {
  seed: null,
  islandId: null,
  selfId: null,
  actors: {},
  chunks: {},
  lastTick: 0,
  welcomeCount: 0,
};

export async function installWsTap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Tap {
      seed: string | null;
      islandId: string | null;
      selfId: number | null;
      actors: Record<number, { x: number; y: number }>;
      chunks: Record<string, string>;
      lastTick: number;
      welcomeCount: number;
    }
    const holder = window as unknown as { __e2eTap?: Tap };
    if (holder.__e2eTap) return;
    const tap: Tap = {
      seed: null,
      islandId: null,
      selfId: null,
      actors: {},
      chunks: {},
      lastTick: 0,
      welcomeCount: 0,
    };
    holder.__e2eTap = tap;

    const handle = (raw: string): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const t = msg['t'];
      if (t === 'welcome') {
        tap.welcomeCount++;
        tap.seed = String(msg['seed']);
        tap.islandId = String(msg['islandId']);
        const you = msg['you'] as { i: number; x: number; y: number };
        tap.selfId = you.i;
        // 再接続では別のentityIdになることがあるので、古い自機は残さない
        tap.actors = { [you.i]: { x: you.x, y: you.y } };
      } else if (t === 'chunk') {
        const cx = Number(msg['cx']);
        const cy = Number(msg['cy']);
        const terrain = msg['terrain'] as number[];
        tap.chunks[`${cx},${cy}`] = terrain.join(',');
      } else if (t === 'snapshot') {
        tap.lastTick = Number(msg['tick']);
        const actors = msg['actors'] as { i: number; x: number; y: number }[];
        tap.actors = {};
        for (const a of actors) tap.actors[a.i] = { x: a.x, y: a.y };
      } else if (t === 'delta') {
        tap.lastTick = Number(msg['tick']);
        const add = (msg['add'] ?? []) as { i: number; x: number; y: number }[];
        const upd = (msg['upd'] ?? []) as { i: number; x?: number; y?: number }[];
        const rm = (msg['rm'] ?? []) as number[];
        for (const a of add) tap.actors[a.i] = { x: a.x, y: a.y };
        for (const u of upd) {
          const prev = tap.actors[u.i] ?? { x: 0, y: 0 };
          tap.actors[u.i] = { x: u.x ?? prev.x, y: u.y ?? prev.y };
        }
        for (const i of rm) delete tap.actors[i];
      }
    };

    // 強制切断のために、作られたソケットも覚えておく
    const socketHolder = window as unknown as { __e2eSockets?: WebSocket[] };
    socketHolder.__e2eSockets = [];

    const Original = window.WebSocket;
    class TappedWebSocket extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        socketHolder.__e2eSockets?.push(this);
        this.addEventListener('message', (ev: MessageEvent) => handle(String(ev.data)));
      }
    }
    window.WebSocket = TappedWebSocket as unknown as typeof WebSocket;
  });
}

/** ページ内に溜まったサーバ真値を読む */
export async function readTap(page: Page): Promise<WsTapState> {
  const raw = await page.evaluate(() => {
    const holder = window as unknown as { __e2eTap?: unknown };
    return holder.__e2eTap ?? null;
  });
  return (raw as WsTapState | null) ?? { ...EMPTY_TAP };
}

/**
 * 開いているWSを強制的に閉じる（サーバ側から切られた状況の再現）。
 *
 * 補足: Chromium の `context.setOffline(true)` は**既存のWS接続を切らない**（新規接続だけを止める）。
 * そのため「切断 → 再接続」を検証するには、ここで明示的に閉じる必要がある。
 * クライアントの `GameSocket.close()` は使わない（`closedByUser` が立って再接続しなくなるため）。
 *
 * **ゲームの `/ws` だけを閉じる**。ViteのHMRソケットを閉じると、
 * Viteクライアントが `location.reload()` を仕掛けてページごと巻き戻ってしまう。
 *
 * @returns 閉じたソケットの数
 */
export async function forceDisconnect(page: Page): Promise<number> {
  return page.evaluate(() => {
    const holder = window as unknown as { __e2eSockets?: WebSocket[] };
    const list = holder.__e2eSockets ?? [];
    let closed = 0;
    for (const ws of list) {
      if (!ws.url.includes('/ws')) continue;
      if (ws.readyState === 0 || ws.readyState === 1) {
        ws.close();
        closed++;
      }
    }
    return closed;
  });
}

/** タップが見ている生存アクターIDの一覧 */
export function actorIds(tap: WsTapState): number[] {
  return Object.keys(tap.actors).map(Number);
}

/**
 * 自機の位置（サーバ真値）を返す。
 * デバッグパネルに `pos` 行があればそれを優先する（描画側の予測位置を見たいとき用）。
 */
export async function selfPos(page: Page): Promise<{ x: number; y: number } | null> {
  const panel = (await readDebug(page)).pos;
  if (panel) return panel;
  const tap = await readTap(page);
  return tap.selfId === null ? null : tap.actors[tap.selfId] ?? null;
}

/** タップから特定アクターの位置を取る（相手の同期を確認するのに使う） */
export async function actorPos(
  page: Page,
  id: number,
): Promise<{ x: number; y: number } | null> {
  return (await readTap(page)).actors[id] ?? null;
}

/** 2点の距離 */
export function dist(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): number {
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 受信した地形チャンクのハッシュ。
 * 「リロードしても同じ島か」「2人が同じ島を見ているか」の判定に使う（決定論）。
 * 引数の座標リストを指定すると、そのチャンクだけを対象にする（受信済みチャンクが違っても比較できる）。
 */
export function chunkHash(chunks: Record<string, string>, keys?: readonly string[]): string {
  const target = (keys ?? Object.keys(chunks)).slice().sort();
  let h = 0x811c9dc5;
  for (const k of target) {
    const s = `${k}=${chunks[k] ?? ''};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * **サーバから届いた** tick が n 以上になるまで待つ。
 *
 * 注意: デバッグパネルの `tick` は切断中もクライアント側で進む（main.ts が1秒ごとに +4 する）。
 * 「サーバが動いているか」を見たいときは必ずこちら（WSタップ）を使う。
 */
export async function waitForTick(page: Page, n: number, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => (await readTap(page)).lastTick, { timeout, intervals: [250, 250, 500, 1000] })
    .toBeGreaterThanOrEqual(n);
}

/** 現在のサーバtickから n tick ぶん進むまで待つ */
export async function advanceTicks(page: Page, n: number): Promise<void> {
  const from = (await readTap(page)).lastTick;
  await waitForTick(page, from + n);
}

/** キーを ms ミリ秒だけ押し続ける（例: `walk(page, 'KeyD', 1200)`） */
export async function walk(page: Page, key: string, ms: number): Promise<void> {
  // クリックすると「クリック移動」になってしまうので、キー入力だけで動かす
  // （InputController は window に keydown を張っているのでフォーカスは body でよい）
  await page.keyboard.down(key);
  // 「押し続ける時間」そのものなので固定待ちが正しい
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  // 停止がサーバへ届き、次のdeltaが返るまで待つ
  await page.waitForTimeout(TICK_MS * 3);
}

/** ホイールを1段ぶん回す（dir>0 で寄る）。InputController のしきい値は40 */
export async function wheelZoom(page: Page, dir: number): Promise<void> {
  const box = await page.locator('#game').boundingBox();
  const cx = box ? box.x + box.width / 2 : 640;
  const cy = box ? box.y + box.height / 2 : 360;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, dir > 0 ? -60 : 60);
}

/** ゲーム画面（canvas）のスクリーンショットを撮る */
export async function shotCanvas(page: Page): Promise<Buffer> {
  return page.locator('canvas').first().screenshot();
}

/**
 * コンソールエラーとページ内例外を集める。
 * 失敗時に中身を出せるように、返り値の配列をそのままアサートに使う。
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return errors;
}

/**
 * 無視してよいコンソールエラーを落とす。
 * オフライン化したときのWS失敗は**テストが意図して起こしたもの**なので数えない。
 */
export function meaningfulErrors(errors: readonly string[]): string[] {
  return errors.filter(
    (e) =>
      !/WebSocket/i.test(e) &&
      !/ERR_INTERNET_DISCONNECTED/.test(e) &&
      !/ERR_NETWORK_CHANGED/.test(e) &&
      !/Failed to load resource/i.test(e),
  );
}
