import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapBones, parseName, type BoneInfo } from "./bones.ts";

// Reads the skin joints straight out of a shipped GLB's JSON chunk.
function skeleton(file: string): BoneInfo[] {
  const buf = readFileSync(file);
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
  const joints: number[] = json.skins[0].joints;
  const parentOf = new Map<number, number>();
  json.nodes.forEach((n: { children?: number[] }, i: number) => n.children?.forEach((c) => parentOf.set(c, i)));
  return joints.map((j) => {
    let p = parentOf.get(j);
    while (p !== undefined && !joints.includes(p)) p = parentOf.get(p);
    return { name: json.nodes[j].name, parent: p === undefined ? -1 : joints.indexOf(p) };
  });
}

const names = (bones: BoneInfo[], ids: (number | undefined)[]) => ids.map((i) => (i === undefined ? "-" : bones[i].name));

test("side and core parsing", () => {
  assert.deepEqual(parseName("DEF-UpperArm_1.L"), { side: "L", tokens: ["def", "upper", "arm", "1"], core: "def upper arm 1" });
  assert.equal(parseName("Bip001 RThighTwist").side, "R");
  assert.equal(parseName("mixamorig:LeftForeArm").core, "fore arm");
  assert.equal(parseName("arm left finger 2a").side, "L");
});

for (const [file, expect] of Object.entries({
  "public/heroes/hulk.glb": ["DEF-Hips", "DEF-Neck", "DEF-Head", "DEF-Jaw", "DEF-UpperArm_1.L", "DEF-Forearm_1.L", "DEF-Hand.L", "DEF-Thigh_1.R", "DEF-Knee_1.R", "DEF-Foot.R"],
  "public/heroes/infinity-ultron.glb": ["Bip001 Pelvis", "Bip001 Neck", "Bip001 Head", "-", "Bip001 L UpperArm", "Bip001 L Forearm", "Bip001 L Hand", "Bip001 R Thigh", "Bip001 R Calf", "Bip001 R Foot"],
  "public/heroes/ultron-prime.glb": ["root hips", "head neck lower", "head neck upper", "head jaw", "arm left shoulder 2", "arm left elbow", "arm left wrist", "leg right thigh", "leg right knee", "leg right ankle"],
})) {
  test(`maps ${file}`, () => {
    const bones = skeleton(file);
    const m = mapBones(bones);
    assert.deepEqual(names(bones, [m.hips, m.neck, m.head, m.jaw, m.L.upperArm, m.L.foreArm, m.L.hand, m.R.upLeg, m.R.leg, m.R.foot]), expect);
    assert.ok(m.spine.length >= 1, "has a spine chain");
    for (const s of ["L", "R"] as const) {
      for (const f of ["thumb", "index", "middle", "ring", "pinky"] as const) {
        assert.ok((m[s].fingers[f]?.length ?? 0) >= 2, `${s} ${f} has segments`);
      }
    }
  });
}
