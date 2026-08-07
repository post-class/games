/**
 * 環境変数の読み込み。**サーバ専用**。
 * リポジトリルートの .env を読む（クライアントには絶対に渡さない）。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CLIENT_IDLE_TIMEOUT_MS, DEFAULT_PORT } from '@ai-pet/shared';

function findEnvFile(): string | null {
  // packages/server/src → packages/server → packages → ai-pet → games(リポジトリルート)
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = findEnvFile();
  if (file) {
    process.loadEnvFile(file);
    console.log(`[env] loaded ${file}`);
  } else {
    console.warn('[env] .env が見つかりません（LLM機能は mock で動作します）');
  }
}

loadEnv();

function str(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** LLMの動作モード。mock=固定応答 / fail=常に失敗（フォールバック検証用） */
export type LlmMode = 'real' | 'mock' | 'fail';

function detectLlmMode(): LlmMode {
  const fromArg = process.argv.find((a) => a.startsWith('--llm='))?.split('=')[1];
  const raw = fromArg ?? process.env['LLM_MODE'] ?? '';
  if (raw === 'mock' || raw === 'fail' || raw === 'real') return raw;
  // 接続情報が揃っていなければ自動でmockに落とす
  const ok = str('AZURE_OPENAI_ENDPOINT') !== '' && str('AZURE_OPENAI_API_KEY') !== '';
  return ok ? 'real' : 'mock';
}

export const env = {
  port: num('PORT', DEFAULT_PORT),
  islandId: str('ISLAND_ID', 'main'),
  /**
   * 既定の島seed。
   * `pokomofu-1` は島が分断されておらず橋の建設予定地が生まれなかったため、
   * 橋・井戸・天文台が全部そろう `pokomofu-2` を既定にしている
   * （共同建設は看板機能なので、既定の島に無いのは避けたい）。
   */
  islandSeed: str('ISLAND_SEED', 'pokomofu-2'),
  dbPath: str('DB_PATH', './data/island.db'),

  azureEndpoint: str('AZURE_OPENAI_ENDPOINT'),
  azureApiKey: str('AZURE_OPENAI_API_KEY'),
  azureApiVersion: str('AZURE_OPENAI_API_VERSION', '2025-04-01-preview'),
  petModel: str('LLM_MODEL_PET', 'gpt-5.6-luna'),

  llmMode: detectLlmMode(),
  llmMaxRphPerPlayer: num('LLM_MAX_RPH_PER_PLAYER', 40),
  /**
   * 無音の接続を切るまでの時間（ms）。
   * 回線が不安定な環境向けに延ばせるようにしている（テストでは短くする）。
   */
  clientIdleTimeoutMs: num('CLIENT_IDLE_TIMEOUT_MS', CLIENT_IDLE_TIMEOUT_MS),
  isDev: str('NODE_ENV', 'development') !== 'production',
} as const;

/** ログに出しても安全な形（キーをマスク） */
export function envSummary(): Record<string, string | number | boolean> {
  return {
    port: env.port,
    islandId: env.islandId,
    islandSeed: env.islandSeed,
    llmMode: env.llmMode,
    petModel: env.petModel,
    azureEndpoint: env.azureEndpoint ? env.azureEndpoint.replace(/\/\/[^.]+/, '//***') : '(none)',
    azureApiKey: env.azureApiKey ? `***${env.azureApiKey.slice(-4)}` : '(none)',
    azureApiVersion: env.azureApiVersion,
  };
}
