#!/usr/bin/env node
// T2-6 第1段階: 素材が存在しない confed-01〜confed-12 の肖像を生成する。
// 既存素材（regenerated_portraits）と画風を揃えるため、名鑑の portraitPrompt と同じ
// 「photorealistic cinematic sci-fi concept art / head-and-shoulders / 制服 / 抑えた艦内背景」を踏襲する。
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gamesRoot = '/Users/ryosato/projects/private/games';
const outRoot = path.join(gamesRoot, 'multi-commander/.tmp/portraits/generated');
const workRoot = path.join(gamesRoot, 'multi-commander/.tmp/portraits/work');
const generator = '/Users/ryosato/agents-common/skills/img-gen-gpt/scripts/generate_image.py';
const concurrency = 10;

/** 生成対象。people.ts の confed-01〜confed-12 と 1 対 1 で対応する。 */
const JOBS = [
  {
    id: 'confed-01',
    name: 'Mio Asakura (朝倉 澪)',
    gender: 'female',
    age: 26,
    ethnicity: 'Japanese',
    role: 'carrier fighter squadron leader',
    cue: 'This is the female lead of an epic science-fiction drama: strikingly beautiful in a natural believable Japanese way, luminous clear skin, expressive intelligent eyes, refined balanced features, glossy individually styled dark hair, a subtle self-assured half-smile, magnetic cinematic presence conveying exceptional intellect, courage and quiet authority. Squadron-leader insignia on the collar.',
  },
  {
    id: 'confed-02',
    name: 'Hayato Kamiya (神谷 隼人)',
    gender: 'male',
    age: 28,
    ethnicity: 'Japanese',
    role: 'interceptor flight leader',
    cue: 'This is the male lead of an epic science-fiction drama: exceptionally handsome in a natural believable Japanese way, refined balanced features, expressive intelligent eyes, defined elegant jawline, well-groomed styled dark hair, athletic shoulders, an intense calm gaze with a subtle confident expression, magnetic cinematic presence.',
  },
  {
    id: 'confed-03',
    name: 'Amina Okafor',
    gender: 'female',
    age: 27,
    ethnicity: 'Nigerian (West African)',
    role: 'interceptor pilot',
    cue: 'Deep brown skin, short natural coiled hair, alert focused eyes, calm capable confidence of a front-line interceptor pilot who finds safe routes through minefields.',
  },
  {
    id: 'confed-04',
    name: 'Marcus Johnson',
    gender: 'male',
    age: 22,
    ethnicity: 'African American',
    role: 'light fighter pilot',
    cue: 'Clearly a young man of exactly 22: youthful smooth face, close-cropped hair, bright eager eyes, a trace of nervous energy under fresh discipline. Definitely not middle-aged.',
  },
  {
    id: 'confed-05',
    name: 'Ploy Srisuk',
    gender: 'female',
    age: 21,
    ethnicity: 'Thai (Southeast Asian)',
    role: 'trainee pilot',
    cue: 'Clearly a young woman of exactly 21: youthful soft face, warm light-brown skin, dark hair tied back neatly, wide earnest eyes, a trainee cadet flash on the shoulder, slightly tense posture. Definitely not middle-aged.',
  },
  {
    id: 'confed-06',
    name: 'William Hart',
    gender: 'male',
    age: 57,
    ethnicity: 'White European / North American',
    role: 'ship captain, former search-and-rescue officer',
    cue: 'Clearly a man of exactly 57: weathered lined face, grey-streaked short hair, heavy calm eyes carrying decades of rescue work, captain rank braid on the collar and cuffs, steady paternal authority without aggression.',
  },
  {
    id: 'confed-07',
    name: 'Sophie Laurent',
    gender: 'female',
    age: 39,
    ethnicity: 'French (White European)',
    role: 'navigator and gate-anomaly analyst',
    cue: 'Clearly a woman of exactly 39: mature composed face with fine expression lines, dark brown hair pinned back, sharp analytical eyes, thin navigator visor pushed up on her forehead, the poise of a specialist who predicts unstable gate openings.',
  },
  {
    id: 'confed-08',
    name: 'Kim Seoyeon (김서연)',
    gender: 'female',
    age: 38,
    ethnicity: 'Korean',
    role: 'base defence commander',
    cue: 'Clearly a woman of exactly 38: mature Korean features, hair in a tight low bun, unflinching commanding gaze, senior officer insignia, the hardened calm of someone who rebuilt a defence line twice while protecting a refugee sector.',
  },
  {
    id: 'confed-09',
    name: 'Claire Bennett',
    gender: 'female',
    age: 24,
    ethnicity: 'White British / North American',
    role: 'rescue boat pilot',
    cue: 'Clearly a young woman of exactly 24: fresh youthful face, light freckles, ash-blonde hair in a short practical cut, quick attentive eyes, rescue-service patch on the shoulder, brisk kindness. Definitely not middle-aged.',
  },
  {
    id: 'confed-10',
    name: 'Naoko Kobayashi (小林 直子)',
    gender: 'female',
    age: 34,
    ethnicity: 'Japanese',
    role: 'reconnaissance and electronic warfare officer',
    cue: 'Clearly a woman of exactly 34: composed Japanese features, straight black shoulder-length hair tucked behind one ear, a slim electronic-warfare headset with a single dark monocle lens, quiet precise concentration.',
  },
  {
    id: 'confed-11',
    name: 'Nia Williams',
    gender: 'female',
    age: 41,
    ethnicity: 'African American',
    role: 'carrier air wing staff officer',
    cue: 'Clearly a woman of exactly 41: mature warm dark-brown face with subtle expression lines, hair in neat short locs, steady reassuring gaze, staff-officer aiguillette and clipboard-free empty hands, the settled authority of a logistics planner who kept an air wing flying for forty days.',
  },
  {
    id: 'confed-12',
    name: 'Omar Rahman',
    gender: 'male',
    age: 30,
    ethnicity: 'Arab (Levantine / Gulf)',
    role: 'bomber pilot',
    cue: 'Clearly a man of exactly 30: olive-toned skin, short black hair, a trimmed dark beard, level unhurried eyes, heavy bomber-crew harness straps over the uniform, the deliberate calm of a pilot who opens lanes with minimum damage.',
  },
];

function promptFor(job) {
  const genderCue =
    job.gender === 'male'
      ? 'MALE PRESENTATION. Must be unmistakably male-presenting: masculine face, bone structure, shoulders and body proportions. Do not depict a woman or feminine styling.'
      : 'FEMALE PRESENTATION. Must be unmistakably female-presenting: feminine face and body proportions. Do not depict a man, beard, or masculine styling.';
  return (
    `Create one single-character portrait for a sci-fi game dossier, vertical 3:4 framing, with no text. ` +
    `Character name: ${job.name}. Faction: アウレリア連邦 (Aurelia Confederation, human space navy). Role: ${job.role}. ` +
    `MANDATORY IDENTITY — do not omit or alter: exact age ${job.age} years old; ${genderCue}; human ethnicity/background: ${job.ethnicity}. ` +
    `Depict precisely that age, ethnicity and gender — not older, not younger, not a different ethnicity. ` +
    `${job.cue} ` +
    `The character must be fashionable, stylish, distinctive and visually striking: a sophisticated custom navy-blue-and-charcoal military sci-fi uniform with individual design details, subtle gold or bronze trim, a small winged confederation badge, refined grooming and a memorable face. ` +
    `Framing: head-and-shoulders, upper body only, facing the viewer straight on or turned very slightly to one side, face clearly visible and well lit, calm capable expression, eyes toward the viewer. ` +
    `Background: a restrained dim warship interior or bridge with soft depth-of-field, no bright clutter. ` +
    `Photorealistic cinematic sci-fi concept art, dramatic but soft key lighting, muted desaturated palette. ` +
    `No text, no labels, no logos, no borders, no watermark, no duplicate people, no collage, no split panels, no weapons.`
  );
}

await mkdir(outRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });

async function generate(job) {
  const jobRoot = path.join(workRoot, job.id);
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true });
  const args = [
    'run', 'python', generator,
    '--operation', 'generate',
    '--model', 'gpt-image-2',
    '--quality', 'high',
    '--size', '1024x1536',
    '--output-format', 'png',
    '--background', 'opaque',
    '--prompt', promptFor(job),
    '--output-dir', jobRoot,
  ];
  const { stdout, stderr } = await execFileAsync('uv', args, {
    cwd: gamesRoot,
    maxBuffer: 1024 * 1024 * 8,
    env: { ...process.env, UV_CACHE_DIR: path.join(gamesRoot, '.uv_cache') },
  });
  const result = JSON.parse(stdout);
  if (result.status !== 'ok' || !result.saved_images?.[0]?.path) {
    throw new Error(`${job.id}: ${result.message || stderr || '画像生成に失敗しました。'}`);
  }
  const dest = path.join(outRoot, `${job.id}.png`);
  await rm(dest, { force: true });
  await rename(result.saved_images[0].path, dest);
  return { id: job.id, dest, estimatedCost: result.estimated_cost };
}

const completed = [];
const failures = [];
let next = 0;
async function worker(n) {
  while (next < JOBS.length) {
    const job = JOBS[next++];
    process.stdout.write(`[${n}] start ${job.id} ${job.name}\n`);
    try {
      completed.push(await generate(job));
      process.stdout.write(`[${n}] complete ${job.id}\n`);
    } catch (error) {
      const detail = error?.stderr || error?.stdout || error?.message || String(error);
      failures.push({ id: job.id, message: String(detail).slice(0, 800) });
      process.stderr.write(`[${n}] failed ${job.id}: ${String(detail).slice(0, 800)}\n`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, JOBS.length) }, (_, i) => worker(i + 1)));
await writeFile(
  path.join(workRoot, 'result.json'),
  JSON.stringify({ total: JOBS.length, completed, failures }, null, 2),
);
process.stdout.write(`Completed ${completed.length}/${JOBS.length}. Failures: ${failures.length}\n`);
if (failures.length) process.exitCode = 1;
