#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const htmlPath = path.join(root, '登場人物_人物名鑑.html');
const workRoot = path.resolve(root, '../../../../.tmp/character_regeneration');
const pairRoot = path.join(root, 'assets/characters/regenerated_pair');
const portraitRoot = path.join(root, 'assets/characters/regenerated_portraits');
const hobbyRoot = path.join(root, 'assets/characters/regenerated_hobbies');
const generator = '/Users/ryosato/agents-common/skills/img-gen-gpt/scripts/generate_image.py';
const concurrency = Number(process.env.MAX_CONCURRENCY || 10);

const html = await readFile(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
if (!script) throw new Error('名鑑HTML内のスクリプトを見つけられません。');

const inert = { innerHTML: '', textContent: '', addEventListener() {}, close() {}, showModal() {} };
const document = { getElementById: () => inert, querySelectorAll: () => [], querySelector: () => inert };
const createManifest = new Function('document', 'console', `${script}\nreturn factions.flatMap((faction) => faction.people.map((person, index) => ({ id: faction.id + '-' + String(index + 1).padStart(2, '0'), faction: faction.name, name: person[0], role: person[3], factionId: faction.id, index, prompt: portraitPrompt(person, faction, index) })));`);
const allManifest = createManifest(document, { log() {}, warn() {}, error() {} });
const requestedIds = process.env.CHARACTER_IDS?.split(',').filter(Boolean);
const excludedIds = new Set((process.env.EXCLUDE_IDS || '').split(',').filter(Boolean));
const manifest = (requestedIds?.length ? allManifest.filter((job) => requestedIds.includes(job.id)) : allManifest)
  .filter((job) => !excludedIds.has(job.id));
if (!manifest.length) throw new Error('対象となる生成ジョブがありません。');

await Promise.all([workRoot, pairRoot, portraitRoot, hobbyRoot].map((dir) => mkdir(dir, { recursive: true })));
await writeFile(path.join(workRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

async function generate(job) {
  const jobRoot = path.join(workRoot, job.id);
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true });
  // 直前の生成結果ではなく、更新前に確定していた人物肖像だけを参照画像にする。
  const nonhumanStarts = { kilrashi: 0, serecion: 5, ordo: 10, neurowm: 15 };
  const genderOrder = ['male', 'male', 'female', 'male', 'female', 'male', 'female', 'male', 'female', 'female'];
  const source = job.factionId === 'confed'
    ? path.join(root, 'assets/characters/human_reset_portraits', job.index < 10 ? `jp-female-${String(job.index).padStart(2, '0')}.png` : job.index < 20 ? `jp-male-${String(job.index - 10).padStart(2, '0')}.png` : job.index < 28 ? `other-male-${String(job.index - 20).padStart(2, '0')}.png` : `other-female-${String(job.index - 28).padStart(2, '0')}.png`)
    : path.join(root, 'assets/characters/nonhuman_candidate_portraits', `${genderOrder[job.index]}-${String(nonhumanStarts[job.factionId] + genderOrder.slice(0, job.index + 1).filter((gender) => gender === genderOrder[job.index]).length - 1).padStart(2, '0')}.png`);
  const args = [
    'run', 'python', generator,
    '--operation', 'edit',
    '--model', 'gpt-image-2',
    '--quality', 'high',
    '--size', '1536x1024',
    '--output-format', 'png',
    '--background', 'opaque',
    '--input-fidelity', 'high',
    '--input-images', source,
    '--prompt', job.prompt,
    '--output-dir', jobRoot,
  ];
  const { stdout, stderr } = await execFileAsync('uv', args, { cwd: path.resolve(root, '../../../..'), maxBuffer: 1024 * 1024 * 4, env: { ...process.env, UV_CACHE_DIR: path.resolve(root, '../../../../.uv_cache') } });
  const result = JSON.parse(stdout);
  if (result.status !== 'ok' || !result.saved_images?.[0]?.path) {
    throw new Error(`${job.id}: ${result.message || stderr || '画像生成に失敗しました。'}`);
  }
  const pair = path.join(pairRoot, `${job.id}.png`);
  const portrait = path.join(portraitRoot, `${job.id}.png`);
  const hobby = path.join(hobbyRoot, `${job.id}.png`);
  await rm(pair, { force: true });
  await rename(result.saved_images[0].path, pair);
  await execFileAsync('magick', [pair, '-crop', '50%x100%+0+0', '+repage', portrait]);
  await execFileAsync('magick', [pair, '-crop', '50%x100%+768+0', '+repage', hobby]);
  return { id: job.id, pair, portrait, hobby, estimatedCost: result.estimated_cost };
}

const completed = [];
const failures = [];
let next = 0;
async function worker(workerNumber) {
  while (next < manifest.length) {
    const job = manifest[next++];
    process.stdout.write(`[${workerNumber}] start ${job.id} ${job.name}\n`);
    try {
      completed.push(await generate(job));
      process.stdout.write(`[${workerNumber}] complete ${job.id}\n`);
    } catch (error) {
      const detail = error?.stderr || error?.stdout || error?.message || String(error);
      failures.push({ id: job.id, message: String(detail) });
      process.stderr.write(`[${workerNumber}] failed ${job.id}: ${detail}\n`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, manifest.length) }, (_, index) => worker(index + 1)));
await writeFile(path.join(workRoot, 'result.json'), JSON.stringify({ total: manifest.length, completed, failures }, null, 2));
if (failures.length) {
  process.stderr.write(`Completed ${completed.length}/${manifest.length}; ${failures.length} failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Completed ${completed.length}/${manifest.length}.\n`);
}
