#!/usr/bin/env node
// T2-6 第1段階: 人物名簿 76 名ぶんの肖像を public/art/tex/face-<id>-<表情>.jpg として配置する。
// 表情差分はまだ作り分けないため、5 表情すべてに同じ画像を書き出す（TODO(T2-6b)）。
import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repo = '/Users/ryosato/projects/private/games/multi-commander';
const specPortraits = path.join(repo, '00_initila_constructions/05_story_改善/spec/assets/characters/regenerated_portraits');
const generated = path.join(repo, '.tmp/portraits/generated');
const texDir = path.join(repo, 'public/art/tex');
const EXPRESSIONS = ['neutral', 'talk', 'grin', 'grim', 'strain'];

const pad = (n) => String(n).padStart(2, '0');

/** 実装 id → 元画像。crop は元画像の寸法に合わせた「上部の正方形」。 */
const MAP = [];
// confed-01〜12: 素材が無いので今回生成した 1024x1536。
for (let i = 1; i <= 12; i += 1) {
  MAP.push({ id: `confed-${pad(i)}`, src: path.join(generated, `confed-${pad(i)}.png`), crop: '992x992+16+0' });
}
// confed-13〜32 ← 素材 confed-01〜20（名鑑最終名簿の先頭20名。順番どおり1対1）。
for (let i = 13; i <= 32; i += 1) {
  MAP.push({ id: `confed-${pad(i)}`, src: path.join(specPortraits, `confed-${pad(i - 12)}.png`), crop: '736x736+16+0' });
}
// confed-33〜36 ← 名鑑追加分から個別に対応（人名で確認済み）。
for (const [id, srcNo] of [['confed-33', 23], ['confed-34', 21], ['confed-35', 29], ['confed-36', 31]]) {
  MAP.push({ id, src: path.join(specPortraits, `confed-${pad(srcNo)}.png`), crop: '736x736+16+0' });
}
// 非人類 40 名は id がそのまま一致する。
for (const faction of ['kilrashi', 'serecion', 'ordo', 'neurowm']) {
  for (let i = 1; i <= 10; i += 1) {
    const id = `${faction}-${pad(i)}`;
    MAP.push({ id, src: path.join(specPortraits, `${id}.png`), crop: '736x736+16+0' });
  }
}

const before = new Set(await readdir(texDir));
let written = 0;
const failures = [];

async function place(entry) {
  const outputs = EXPRESSIONS.map((exp) => path.join(texDir, `face-${entry.id}-${exp}.jpg`));
  // 1 回の magick 呼び出しで同じ画像を 5 ファイルへ書き出す。
  const args = [entry.src, '-crop', entry.crop, '+repage', '-resize', '384x384', '-strip', '-quality', '82'];
  for (const out of outputs) {
    await execFileAsync('magick', [...args, out]);
    written += 1;
  }
}

await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (;;) {
      const entry = MAP.shift();
      if (!entry) return;
      try {
        await place(entry);
      } catch (error) {
        failures.push({ id: entry.id, message: String(error?.stderr || error?.message).slice(0, 300) });
      }
    }
  }),
);

const after = await readdir(texDir);
const added = after.filter((f) => !before.has(f));
await writeFile(
  path.join(repo, '.tmp/portraits/deploy-result.json'),
  JSON.stringify({ written, added: added.length, failures }, null, 2),
);
process.stdout.write(`written=${written} newFiles=${added.length} failures=${failures.length}\n`);
if (failures.length) {
  process.stdout.write(JSON.stringify(failures, null, 2) + '\n');
  process.exitCode = 1;
}
