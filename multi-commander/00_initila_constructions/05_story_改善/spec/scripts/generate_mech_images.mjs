import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const skillScript = '/Users/ryosato/agents-common/skills/img-gen-gpt/scripts/generate_image.py';
const outputDir = path.join(root, 'multi-commander/00_initila_constructions/05_story_改善/spec/assets/mechs');
const common = 'Premium cinematic science-fiction hard-surface concept art for a Wing Commander-style space combat game dossier. One single flying spacecraft only, three-quarter front view, centered in a clean atmospheric hangar or deep space backdrop, 1536x1024 landscape composition. The vehicle must be entirely flight-capable: fighter, bomber, corvette, carrier, transport, reconnaissance craft, or other spacecraft. Absolutely no humanoid robot, no bipedal walker, no ground vehicle, no legs, no arms, no human-shaped silhouette, no people, no pilots. Strong readable aerospace silhouette, realistic material detail, dramatic but controlled studio lighting, no text, no letters, no logos, no emblems, no watermark, no UI, no collage, no duplicate vehicle.';

const mechs = [
  ['confed-01', 'Aurelia Federation F-54 Hornet light fighter, based directly on the game implementation. Compact arrow-shaped navy gray aerospace fighter, blue accent panels, twin laser cannon mounts, two dumbfire missiles, extremely agile high-speed patrol interceptor.'],
  ['confed-02', 'Aurelia Federation F-38 Scimitar medium fighter, based directly on the game implementation. Stable broad delta-wing navy-gray fighter, muted green accent panels, two mass driver cannons and three missiles, solid medium armor.'],
  ['confed-03', 'Aurelia Federation F-44 Raptor heavy fighter, based directly on the game implementation. Large twin-boom heavy space fighter, steel gray hull, restrained brown accents, two laser cannons plus two neutron cannons, six missiles, unmistakably heavy and durable.'],
  ['confed-04', 'Aurelia Federation F-44A Rapier II super fighter, based directly on the game implementation. Sleek silver-blue delta-wing space superiority fighter, navy accents, twin laser and twin mass driver cannon mounts, five missiles, fastest elite interceptor silhouette.'],
  ['confed-05', 'Aurelia Federation Drayman-class transport, based directly on the game implementation. Very large utilitarian civilian-military cargo spacecraft, long modular hauler hull, gray industrial plating, one dorsal laser turret, wide engine block, slow durable logistics vessel.'],
  ['confed-06', 'Aurelia Federation TCS Tiger’s Claw carrier, based directly on the game implementation. Huge capital spaceship aircraft carrier, dark gray warship hull, broad flight deck and launch bays, three neutron cannon turrets, blue engine exhaust, unmistakably a command carrier and mother ship.'],
  ['kilrashi-01', 'Kilrashi Empire Lionfang command interceptor. Crimson and brass predator-inspired aerospace fighter, sharp mane-like fin crest, powerful forward armor, regal aggressive silhouette.'],
  ['kilrashi-02', 'Kilrashi Empire Ursus Bastion armored gunship. Massive bear-inspired heavy space gunship, dark iron plate armor, broad armored hull, dorsal fortress shield, twin heavy cannons.'],
  ['kilrashi-03', 'Kilrashi Empire Greyhowl pursuit fighter. Silver-gray wolf-inspired sleek fighter, swept ears-like sensor fins, agile tail stabilizer, hunting silhouette.'],
  ['kilrashi-04', 'Kilrashi Empire Vulpes Mirage electronic warfare craft. Russet red and black lightweight aircraft, fox-like swept fins, delicate antenna arrays, deceptive elegant profile.'],
  ['kilrashi-05', 'Kilrashi Empire Boarbreaker torpedo bomber. Stocky tusk-inspired armored strike bomber, heavy frontal plow armor, paired torpedo bays, ram thrusters, brutal silhouette.'],
  ['kilrashi-06', 'Kilrashi Empire Osprey Talon dive striker. Owl-inspired black and gold aerospace craft, articulated feather-like airbrakes, precise long lance weapon.'],
  ['serecion-01', 'Serecion Drift Auroral Lattice guardian fighter. Teal vapor-energy flight craft held in a refined metallic lattice hull, controlled glow only inside transparent wings, no humanoid form.'],
  ['serecion-02', 'Serecion Drift Prism Veil interceptor. Sleek manta-like energy spacecraft, pearl white shell, violet ion filaments contained beneath glass panels, graceful fast silhouette.'],
  ['serecion-03', 'Serecion Drift Chorus Ark escort carrier. Organic-smooth flying starship with a broad flight deck, pale cyan hull, carefully controlled luminous wave rings, defensive rescue architecture.'],
  ['serecion-04', 'Serecion Drift Miststep scout fighter. Compact fog-mantled flying spacecraft, emerald vapor thrusters, thin crescent wings, elegant non-humanoid silhouette.'],
  ['serecion-05', 'Serecion Drift Thunderweave artillery craft. Broad-winged energy bomber, blue-white contained electrical arcs woven through insulated armor ribs, disciplined technical design.'],
  ['serecion-06', 'Serecion Drift Halcyon refugee transport escort. Rounded protective civilian convoy ship, glowing amber barrier membrane around its hull, peaceful but resilient silhouette.'],
  ['ordo-01', 'Ordo Concord Basalt Regent command cruiser. Matte basalt and bronze mineral-armored command spaceship, layered geological plates, no glow, ancient dignified construction.'],
  ['ordo-02', 'Ordo Concord Tidal Spur fast interceptor. Aquatic-inspired space fighter, pearlescent blue fins and sealed gill-like vents, elegant hydrodynamic armor, no glow.'],
  ['ordo-03', 'Ordo Concord Carapace Ward fortress corvette. Low broad crab-inspired armored spacecraft, blue segmented ceramic shell, multiple stabilizer fins, no ground vehicle legs, no glow.'],
  ['ordo-04', 'Ordo Concord Strata Lance siege frigate. Tall mineral-armored artillery spaceship, matte sandstone and dark stone plating, long geological drill-lance fixed to the bow, no glow.'],
  ['ordo-05', 'Ordo Concord Membrane Glider aerial scout. Dark folded membrane-wing spacecraft, organic but engineered silhouette, stealthy and completely flight-capable.'],
  ['ordo-06', 'Ordo Concord Ironroot heavy cargo tug. Compact dense mining and evacuation spacecraft, rough layered rock armor, gravitic anchor emitters, no humanoid form, no glow.'],
  ['neurowm-01', 'Neurowm Swarm Crown Protocol command carrier. Elegant porcelain-white automated aircraft carrier, matte ceramic outer shell, broad launch bays and central command bridge, no glow.'],
  ['neurowm-02', 'Neurowm Swarm Origin Mercy rescue shuttle. Graceful pearl-gray and navy medical spacecraft, transparent diagnostic panels, folded rescue drones, no glow.'],
  ['neurowm-03', 'Neurowm Swarm Glass Mandible scout drone fighter. Lean graphite reconnaissance spacecraft, long articulated sensor booms, multiple optical lenses without emission, no glow.'],
  ['neurowm-04', 'Neurowm Swarm Borrowed Sky communication relay ship. Elegant satin silver communications spacecraft, clean antenna crown, semi-transparent but non-luminous polymer panels, no glow.'],
  ['neurowm-05', 'Neurowm Swarm Red Pulse defense corvette. Heavy matte black automated defense spacecraft, broad armored hull, shielded relay antenna, no glow.'],
  ['neurowm-06', 'Neurowm Swarm Many Feet precision repair tender. Small central repair mothership surrounded by several matte maintenance drones, all flying spacecraft, no humanoid form, no glow.']
];

const requestedSlugs = new Set(process.argv.slice(2));
const selectedMechs = requestedSlugs.size ? mechs.filter(([slug]) => requestedSlugs.has(slug)) : mechs;
if (requestedSlugs.size && selectedMechs.length !== requestedSlugs.size) {
  throw new Error(`Unknown mech slug: ${[...requestedSlugs].filter((slug) => !mechs.some(([id]) => id === slug)).join(', ')}`);
}

await mkdir(outputDir, { recursive: true });
const concurrency = 10;
let cursor = 0;
let failed = false;

function run([slug, description]) {
  return new Promise((resolve) => {
    const tempDir = path.join(root, '.tmp', 'mech-image-generation', slug);
    const child = spawn('uv', ['run', 'python', skillScript,
      '--operation', 'generate', '--model', 'gpt-image-1-mini', '--quality', 'medium', '--size', '1536x1024',
      '--output-format', 'png', '--background', 'opaque', '--env-file', path.join(root, '.env'), '--output-dir', tempDir,
      '--prompt', `${common} ${description}`
    ], { cwd: root, env: { ...process.env, UV_CACHE_DIR: path.join(root, '.uv_cache') } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', async (code) => {
      try {
        const result = JSON.parse(stdout);
        if (code !== 0 || result.status !== 'ok' || !result.saved_images?.[0]?.path) throw new Error(result.message || stderr || `exit ${code}`);
        const source = result.saved_images[0].path;
        const target = path.join(outputDir, `${slug}.png`);
        const { rename } = await import('node:fs/promises');
        await rename(source, target);
        console.log(JSON.stringify({ slug, status: 'ok', target, estimated_cost: result.estimated_cost?.total_usd }));
      } catch (error) {
        failed = true;
        console.error(JSON.stringify({ slug, status: 'error', message: String(error.message || error) }));
      }
      resolve();
    });
  });
}

async function worker() {
  while (cursor < selectedMechs.length) {
    const item = selectedMechs[cursor++];
    await run(item);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
if (failed) process.exitCode = 1;
