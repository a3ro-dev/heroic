// Rebuilds public/heroes/*.glb from the purchased .blend sources.
//   BLENDER=path/to/blender HERO_SRC=dir/with/blends node tools/build_heroes.mjs
// HERO_SRC must also hold the unzipped textures/ folder the Hulk file links to.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const blender = process.env.BLENDER ?? "blender";
const src = process.env.HERO_SRC ?? ".";
const sources = { hulk: "Hulk_BND_RIG.blend", "infinity-ultron": "Infinity+Ultron.blend", "ultron-prime": "ultron+xps.blend", "spider-man": "tasm1rig.blend" };
const raw = join(tmpdir(), "heroic-raw");
mkdirSync(raw, { recursive: true });
mkdirSync("public/heroes", { recursive: true });

for (const [id, file] of Object.entries(sources)) {
  if (process.argv[2] && process.argv[2] !== id) continue;
  const tmp = join(raw, `${id}.glb`);
  execFileSync(blender, ["-b", join(src, file), "--python", "tools/export_hero.py", "--", tmp, "LOD1"], { stdio: "inherit" });
  execFileSync("npx", ["gltf-transform", "optimize", tmp, `public/heroes/${id}.glb`,
    "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", "2048", "--simplify", "false"],
    { stdio: "inherit", shell: true });
}
