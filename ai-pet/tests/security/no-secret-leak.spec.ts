/**
 * APIキーがクライアント側へ漏れないことの検査。
 * docs/02_ゲーム実装プラン/07_ペットAI設計.md §8 の対策。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT_SRC = join(ROOT, 'packages/client/src');
const CLIENT_DIST = join(ROOT, 'packages/client/dist');
const SHARED_SRC = join(ROOT, 'packages/shared/src');

const FORBIDDEN = [/AZURE_OPENAI/i, /api-key/i, /LLM_MODEL_PET/];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('秘密情報の漏洩防止', () => {
  test('クライアントのソースにAzure関連の文字列が無い', () => {
    const files = walk(CLIENT_SRC).filter((f) => /\.(ts|js|css|html)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(body), `${f} に ${pattern} が含まれています`).toBe(false);
      }
    }
  });

  test('sharedパッケージにAzure関連の文字列が無い（クライアントにバンドルされるため）', () => {
    for (const f of walk(SHARED_SRC).filter((f) => f.endsWith('.ts'))) {
      const body = readFileSync(f, 'utf8');
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(body), `${f} に ${pattern} が含まれています`).toBe(false);
      }
    }
  });

  test('クライアントのソースが process.env を直接参照していない', () => {
    for (const f of walk(CLIENT_SRC).filter((f) => f.endsWith('.ts'))) {
      const body = readFileSync(f, 'utf8');
      expect(/process\.env/.test(body), `${f} が process.env を参照しています`).toBe(false);
    }
  });

  test('vite設定が envPrefix を緩めていない', () => {
    const cfg = readFileSync(join(ROOT, 'packages/client/vite.config.ts'), 'utf8');
    // envPrefix を設定する場合は VITE_ 以外を許可していないか目視レビューが必要
    const m = cfg.match(/envPrefix\s*:/);
    expect(m, 'envPrefix を変更する場合はこのテストを更新し、意図を明記してください').toBeNull();
  });

  test('ビルド成果物にキーが含まれない（distがある場合のみ）', () => {
    const files = walk(CLIENT_DIST).filter((f) => /\.(js|css|html|map)$/.test(f));
    if (files.length === 0) {
      // まだビルドしていない場合はスキップ扱い
      expect(true).toBe(true);
      return;
    }
    const key = process.env['AZURE_OPENAI_API_KEY'];
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      expect(/AZURE_OPENAI/i.test(body), `${f} に AZURE_OPENAI が含まれています`).toBe(false);
      if (key && key.length > 8) {
        expect(body.includes(key), `${f} にAPIキーが含まれています`).toBe(false);
      }
    }
  });
});
