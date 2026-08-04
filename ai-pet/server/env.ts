import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * リポジトリ直下の .env を自前でパースする（dotenv を入れない）。
 * APIキーはこのプロセスだけが読み、ブラウザには一切渡さない。
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// process.env を優先し、なければ .env を見る（CI やコンテナで差し替えられるように）。
const fileEnv = { ...parseEnvFile(resolve(REPO_ROOT, '.env')), ...parseEnvFile(resolve(here, '..', '.env')) };

function get(key: string, fallback = ''): string {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}

export const env = {
  repoRoot: REPO_ROOT,
  appRoot: resolve(here, '..'),
  port: Number(get('AI_PET_PORT', '8787')),
  dbPath: get('AI_PET_DB', resolve(here, '..', 'data', 'ai-pet.sqlite')),
  sessionSecret: get('AI_PET_SESSION_SECRET', 'ai-pet-dev-secret-change-me'),
  azure: {
    endpoint: get('AZURE_OPENAI_ENDPOINT'),
    apiKey: get('AZURE_OPENAI_API_KEY'),
    apiVersion: get('AZURE_OPENAI_API_VERSION', '2025-04-01-preview'),
    deployment: get('LLM_MODEL_PET', 'gpt-5.6-luna'),
  },
  /** 自律思考（LLM）の最短間隔。開発中に短くできるよう外出し。 */
  thinkIntervalMs: Number(get('AI_PET_THINK_INTERVAL_MS', String(90_000))),
  /** ペット同士の交流を試みる最短間隔。 */
  encounterIntervalMs: Number(get('AI_PET_ENCOUNTER_INTERVAL_MS', String(3 * 60 * 60 * 1000))),
};

export function hasLlm(): boolean {
  return Boolean(env.azure.endpoint && env.azure.apiKey);
}
