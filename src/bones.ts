// Maps arbitrary skeleton bone names onto humanoid slots. Covers Mixamo, 3ds Max Biped,
// XPS, Rigify/CloudRig DEF bones and most game rips. Pure so it can be unit tested.

export type Side = "L" | "R";
export const FINGERS = ["thumb", "index", "middle", "ring", "pinky"] as const;
export type Finger = (typeof FINGERS)[number];

export interface BoneInfo {
  name: string;
  parent: number; // index into the same list, -1 for roots
}

export interface SideMap {
  shoulder?: number;
  upperArm?: number;
  foreArm?: number;
  hand?: number;
  upLeg?: number;
  leg?: number;
  foot?: number;
  toe?: number;
  fingers: Partial<Record<Finger, number[]>>;
  /** twist/roll helpers that should follow a limb instead of staying at rest */
  followers: { bone: number; slot: "upperArm" | "foreArm" | "upLeg" | "leg" }[];
}

export interface BoneMap {
  hips?: number;
  spine: number[]; // hips (exclusive) → neck (exclusive), root first
  neck?: number;
  head?: number;
  jaw?: number;
  L: SideMap;
  R: SideMap;
}

/** "DEF-UpperArm_1.L" → { side: "L", core: "def upper arm 1" } */
export function parseName(raw: string): { side?: Side; tokens: string[]; core: string } {
  const spaced = raw
    .replace(/^mixamorig\d*:?/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  let tokens = spaced.split(/[^a-z0-9]+/).filter(Boolean);
  let side: Side | undefined;
  const out: string[] = [];
  for (const t of tokens) {
    if (t === "l" || t === "left" || t === "lft") side ??= "L";
    else if (t === "r" || t === "right" || t === "rgt") side ??= "R";
    else if (/^(left|right)./.test(t)) {
      side ??= t.startsWith("left") ? "L" : "R";
      out.push(t.replace(/^(left|right)/, ""));
    } else if (/^[lr](thigh|up|upper|fore|calf|clavicle|hand|foot|toe|finger)/.test(t)) {
      // biped glues the side: "RThighTwist", "LUpArmTwist"
      side ??= t[0] === "l" ? "L" : "R";
      out.push(t.slice(1));
    } else out.push(t);
  }
  tokens = out;
  return { side, tokens, core: tokens.join(" ") };
}

const NOT_MAIN = /twist|roll|(^| )end$|nub|helper|(^| )(ik|pole|target)( |$)|carpal|meta/;

export function mapBones(bones: BoneInfo[]): BoneMap {
  const depth = bones.map(() => 0);
  bones.forEach((b, i) => {
    let d = 0;
    for (let p = b.parent; p >= 0; p = bones[p].parent) d++;
    depth[i] = d;
  });
  const parsed = bones.map((b) => parseName(b.name));
  const isAncestor = (a: number, b: number) => {
    for (let p = bones[b].parent; p >= 0; p = bones[p].parent) if (p === a) return true;
    return false;
  };

  const pick = (re: RegExp, side?: Side, under?: number, allowHelpers = false) => {
    let best: number | undefined;
    parsed.forEach((p, i) => {
      if (p.side !== side) return;
      if (!allowHelpers && NOT_MAIN.test(p.core)) return;
      if (!re.test(p.core)) return;
      if (under !== undefined && !isAncestor(under, i)) return;
      if (best === undefined || depth[i] < depth[best]) best = i;
    });
    return best;
  };

  const sideMap = (s: Side): SideMap => {
    const shoulder = pick(/clavicle|collar|shoulder( 1)?$/, s);
    const upperArm = pick(/upper ?arm|up ?arm|shoulder 2|(^| )arm( 1)?$/, s);
    const foreArm = pick(/fore ?arm|elbow|lower ?arm/, s, upperArm);
    const hand = pick(/(^| )hand( 1)?$|wrist|^hand/, s, foreArm);
    const upLeg = pick(/thigh|up ?leg|upper ?leg/, s);
    const leg = pick(/calf|knee|shin|lower ?leg|(^| )leg( 1)?$/, s, upLeg);
    const foot = pick(/foot|ankle/, s, leg);
    const toe = pick(/toe/, s, foot);

    const fingers: SideMap["fingers"] = {};
    if (hand !== undefined) {
      const under = parsed
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => p.side === s && isAncestor(hand, i) && !/end$|nub|carpal|meta/.test(p.core));
      const zeroBased = under.some(({ p }) => /finger ?0/.test(p.core));
      for (const { p, i } of under) {
        let f: Finger | undefined = FINGERS.find((n) => p.tokens.includes(n) || p.core.includes(n));
        if (!f && p.core.includes("little")) f = "pinky";
        if (!f) {
          const m = p.core.match(/finger ?(\d)/);
          if (m) f = FINGERS[Number(m[1]) - (zeroBased ? 0 : 1)];
        }
        if (f) (fingers[f] ??= []).push(i);
      }
      for (const f of FINGERS) {
        fingers[f]?.sort((a, b) => depth[a] - depth[b]);
        if (fingers[f]) fingers[f] = fingers[f]!.slice(0, 3);
      }
    }

    const followers: SideMap["followers"] = [];
    parsed.forEach((p, i) => {
      if (p.side !== s || !/twist|roll/.test(p.core) || /end$/.test(p.core)) return;
      const slot = /fore|lower|elbow/.test(p.core)
        ? "foreArm"
        : /arm|upper|shoulder/.test(p.core)
          ? "upperArm"
          : /calf|knee|shin/.test(p.core)
            ? "leg"
            : /thigh|leg/.test(p.core)
              ? "upLeg"
              : undefined;
      if (slot) followers.push({ bone: i, slot });
    });
    return { shoulder, upperArm, foreArm, hand, upLeg, leg, foot, toe, fingers, followers };
  };

  const hips = pick(/hips?$|pelvis/) ?? pick(/hips?|pelvis|root/);
  const neck = pick(/neck/);
  let head = pick(/(^| )head$/);
  if (head === undefined && neck !== undefined) {
    // XPS-style: "head neck lower" → "head neck upper" with no separate head bone
    let deepest = neck;
    parsed.forEach((p, i) => {
      if (p.side === undefined && /neck/.test(p.core) && isAncestor(neck, i) && depth[i] > depth[deepest]) deepest = i;
    });
    head = deepest;
  }
  const jaw = head !== undefined ? pick(/jaw$/, undefined, head) : undefined;

  const spine: number[] = [];
  const top = neck ?? head;
  if (top !== undefined && hips !== undefined) {
    for (let p = bones[top].parent; p >= 0 && p !== hips; p = bones[p].parent) spine.unshift(p);
  }
  return { hips, spine, neck: neck === head ? undefined : neck, head, jaw, L: sideMap("L"), R: sideMap("R") };
}
