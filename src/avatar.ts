// Drives a loaded glTF hero from a tracked person. Works on any humanoid rig: every bone is
// rotated by the *change* from its own rest pose, so A-pose, T-pose, Biped and Rigify all retarget
// the same way without per-model offsets.
import * as THREE from "three";
import { FINGERS, mapBones, type BoneMap, type Finger, type Side, type SideMap } from "./bones";
import type { V3 } from "./geometry";

/** One tracked person, already smoothed, in camera space (metres, three.js axes). */
export interface PersonFrame {
  /** 33 pose world landmarks (hip-centred), camera axes */
  world?: V3[];
  vis?: number[];
  /** camera-space translation of the pose's hip origin */
  T?: V3;
  /** head rotation from the face mesh, camera space */
  faceQ?: THREE.Quaternion;
  /** camera-space head centre, used when only the face is visible */
  faceCenter?: V3;
  blend?: Map<string, number>;
  hands: Partial<Record<Side, V3[]>>;
}

const POSE = { L: { sh: 11, el: 13, wr: 15, pinky: 17, index: 19, hip: 23, knee: 25, ankle: 27, toe: 31 },
               R: { sh: 12, el: 14, wr: 16, pinky: 18, index: 20, hip: 24, knee: 26, ankle: 28, toe: 32 } };
const HAND_CHAINS: Record<Finger, number[]> = {
  thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20],
};

const v = (p: V3, out = new THREE.Vector3()) => out.set(p.x, p.y, p.z);
const mid = (a: V3, b: V3) => new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
const sub = (a: V3, b: V3) => new THREE.Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
const smooth01 = (x: number, lo: number, hi: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Orthonormal frame from a left-pointing axis and an up-ish axis; z faces the viewer. */
function basis(x: THREE.Vector3, up: THREE.Vector3, out = new THREE.Quaternion()) {
  const X = x.clone().normalize();
  const Z = new THREE.Vector3().crossVectors(X, up).normalize();
  const Y = new THREE.Vector3().crossVectors(Z, X);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

/** Hand frame: y along the palm, x from pinky to index. */
function handBasis(wrist: THREE.Vector3, index: THREE.Vector3, pinky: THREE.Vector3, middle: THREE.Vector3) {
  const Y = middle.clone().sub(wrist).normalize();
  const X = index.clone().sub(pinky);
  X.sub(Y.clone().multiplyScalar(X.dot(Y))).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

interface Rest {
  q: THREE.Quaternion; // world rotation at rest
  p: THREE.Vector3; // world position at rest
  local: { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 };
}

export interface AvatarOptions {
  /** overall size relative to the person, 1 = matched shoulders */
  build: number;
  /** grow the hero's head when it is smaller than the wearer's, so the real face never peeks out */
  coverHead: boolean;
}

export class Avatar {
  readonly root = new THREE.Group();
  readonly map: BoneMap;
  private bones: THREE.Object3D[];
  private rest = new Map<THREE.Object3D, Rest>();
  private restTorso: THREE.Quaternion;
  private restChest: THREE.Quaternion;
  private restHands: Partial<Record<Side, THREE.Quaternion>> = {};
  private shoulderWidth: number;
  private headWidth = 0;
  private headCenterLocal = new THREE.Vector3();
  private morphs: { mesh: THREE.Mesh; index: Map<string, number> }[] = [];
  private scale = 0;
  private legShow: Record<Side, number> = { L: 0, R: 0 };
  private held = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  private heldAt = 0;
  opts: AvatarOptions = { build: 1.08, coverHead: true };

  constructor(readonly model: THREE.Object3D) {
    this.root.add(model);
    this.root.updateMatrixWorld(true);

    const skinned: THREE.SkinnedMesh[] = [];
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
      if ((o as THREE.Mesh).isMesh) {
        o.frustumCulled = false; // skinned bounds don't follow the pose
        o.castShadow = false;
      }
      this.rest.set(o, {
        q: o.getWorldQuaternion(new THREE.Quaternion()),
        p: o.getWorldPosition(new THREE.Vector3()),
        local: { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() },
      });
    });
    this.bones = [...new Set(skinned.flatMap((m) => m.skeleton.bones))];
    const index = new Map(this.bones.map((b, i) => [b, i]));
    this.map = mapBones(
      this.bones.map((b) => ({ name: (b.userData.name as string) ?? b.name, parent: b.parent ? index.get(b.parent) ?? -1 : -1 })),
    );

    const m = this.map;
    const P = (i?: number) => (i === undefined ? undefined : this.rest.get(this.bones[i])!.p);
    const lArm = P(m.L.upperArm), rArm = P(m.R.upperArm), lLeg = P(m.L.upLeg), rLeg = P(m.R.upLeg);
    if (!lArm || !rArm) throw new Error("This model has no arms I can find.");
    const hipL = lLeg ?? lArm, hipR = rLeg ?? rArm;
    const up = sub(mid(lArm, rArm), lLeg && rLeg ? mid(hipL, hipR) : P(m.hips) ?? new THREE.Vector3());
    this.restTorso = basis(sub(hipL, hipR), up);
    this.restChest = basis(sub(lArm, rArm), up);
    this.shoulderWidth = lArm.distanceTo(rArm);

    for (const s of ["L", "R"] as const) {
      const f = m[s].fingers;
      const hand = P(m[s].hand), idx = P(f.index?.[0]), pnk = P(f.pinky?.[0] ?? f.ring?.[0]), mdl = P(f.middle?.[0]);
      if (hand && idx && pnk) this.restHands[s] = handBasis(hand, idx, pnk, mdl ?? idx.clone().add(pnk).multiplyScalar(0.5));
    }

    // Armour and pads hung off the collarbone along the arm (game rigs do this) would stay sticking
    // out in T-pose when the arm drops. Let anything pointing down the upper arm follow it.
    for (const sd of ["L", "R"] as const) {
      const sm = m[sd];
      const sh = this.bone(sm.shoulder), ua = this.bone(sm.upperArm);
      if (!sh || !ua) continue;
      const armDir = this.aimPoint(ua, this.bone(sm.foreArm)).clone().sub(this.rest.get(ua)!.p).normalize();
      const taken = new Set([ua, ...sm.followers.map((f) => this.bones[f.bone])]);
      for (const child of sh.children) {
        const i = this.bones.indexOf(child);
        if (i < 0 || taken.has(child)) continue;
        const dir = this.aimPoint(child).clone().sub(this.rest.get(child)!.p).normalize();
        if (dir.dot(armDir) > Math.cos((40 * Math.PI) / 180)) sm.followers.push({ bone: i, slot: "upperArm" });
      }
    }

    this.measureHead(skinned);
    for (const mesh of skinned) {
      if (mesh.morphTargetDictionary) {
        const idx = new Map<string, number>();
        for (const [k, i] of Object.entries(mesh.morphTargetDictionary)) idx.set(normMorph(k), i);
        this.morphs.push({ mesh, index: idx });
      }
    }
  }

  /** Bounding box of vertices that mostly follow the head: its width and centre. */
  private measureHead(meshes: THREE.SkinnedMesh[]) {
    const head = this.bone(this.map.head);
    if (!head) return;
    const under = new Set<THREE.Object3D>();
    head.traverse((o) => under.add(o));
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(this.restTorso);
    const box = new THREE.Box3();
    let lo = Infinity, hi = -Infinity;
    const p = new THREE.Vector3();
    for (const mesh of meshes) {
      const pos = mesh.geometry.getAttribute("position");
      const si = mesh.geometry.getAttribute("skinIndex");
      const sw = mesh.geometry.getAttribute("skinWeight");
      if (!si || !sw) continue;
      const headIdx = new Set(mesh.skeleton.bones.map((b, i) => (under.has(b) ? i : -1)).filter((i) => i >= 0));
      for (let i = 0; i < pos.count; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (headIdx.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
        if (w < 0.6) continue;
        mesh.localToWorld(p.fromBufferAttribute(pos, i));
        box.expandByPoint(p);
        const d = p.dot(axis);
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
    }
    if (box.isEmpty()) return;
    this.headWidth = hi - lo;
    head.worldToLocal(box.getCenter(this.headCenterLocal));
  }

  private bone(i?: number) {
    return i === undefined ? undefined : this.bones[i];
  }

  private worldQ(o: THREE.Object3D) {
    return o.getWorldQuaternion(new THREE.Quaternion());
  }

  /** How far a bone has rotated from rest, in world space. */
  private delta(o: THREE.Object3D) {
    return this.worldQ(o).multiply(this.rest.get(o)!.q.clone().invert());
  }

  /** Sets a bone's world rotation to `delta · rest`, keeping its parent untouched. */
  private orient(o: THREE.Object3D | undefined, delta: THREE.Quaternion, weight = 1) {
    if (!o?.parent) return;
    const want = delta.clone().multiply(this.rest.get(o)!.q);
    const local = this.worldQ(o.parent).invert().multiply(want);
    if (weight < 1) o.quaternion.copy(this.rest.get(o)!.local.q).slerp(local, weight);
    else o.quaternion.copy(local);
    o.updateMatrixWorld(true);
  }

  /** Rest-pose point a bone points at: its chain child, else any child, else straight on. */
  private aimPoint(o: THREE.Object3D, next?: THREE.Object3D) {
    const r = this.rest.get(o)!.p;
    const c = next ?? o.children.find((ch) => this.rest.has(ch) && this.rest.get(ch)!.p.distanceTo(r) > 1e-5);
    if (c) return this.rest.get(c)!.p;
    const pr = o.parent && this.rest.get(o.parent);
    return pr ? r.clone().multiplyScalar(2).sub(pr.p) : r.clone().add(new THREE.Vector3(0, 0.1, 0));
  }

  /** Swings a bone so its rest direction (towards `next`) lines up with `dir`. */
  private aim(o: THREE.Object3D | undefined, dir: THREE.Vector3, weight = 1, next?: THREE.Object3D) {
    if (!o?.parent || dir.lengthSq() < 1e-10) return;
    const parentDelta = this.delta(o.parent);
    const rest = this.rest.get(o)!;
    const cur = this.aimPoint(o, next).clone().sub(rest.p).normalize().applyQuaternion(parentDelta);
    const swing = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    if (weight < 1) swing.slerp(new THREE.Quaternion(), 1 - weight);
    this.orient(o, swing.multiply(parentDelta));
  }

  private resetPose() {
    for (const b of this.bones) {
      const l = this.rest.get(b)!.local;
      b.position.copy(l.p);
      b.quaternion.copy(l.q);
      b.scale.copy(l.s);
    }
    this.model.updateMatrixWorld(true);
  }

  update(f: PersonFrame) {
    const m = this.map;
    this.resetPose();
    const W = f.world, vis = f.vis ?? [];
    const seen = (i: number) => smooth01(vis[i] ?? 0, 0.35, 0.7);

    // Torso: hips and chest frames from the person, spine bones blended between them.
    let dHips = new THREE.Quaternion(), dChest = new THREE.Quaternion();
    if (W) {
      const xs = sub(W[11], W[12]);
      const up = sub(mid(W[11], W[12]), mid(W[23], W[24]));
      dChest = basis(xs, up).multiply(this.restChest.clone().invert());
      const hipX = seen(23) * seen(24) > 0.5 ? sub(W[23], W[24]) : new THREE.Vector3(xs.x, 0, xs.z);
      const hipUp = seen(23) * seen(24) > 0.5 ? up : new THREE.Vector3(0, 1, 0);
      dHips = basis(hipX, hipUp).multiply(this.restTorso.clone().invert());
    }
    let dHead = dChest.clone();
    if (f.faceQ) dHead = f.faceQ.clone().multiply(this.restTorso.clone().invert());
    else if (W && seen(7) * seen(8) > 0.3) {
      const x = sub(W[7], W[8]);
      const fwd = sub(W[0], mid(W[7], W[8]));
      const up = new THREE.Vector3().crossVectors(fwd, x);
      dHead = basis(x, up).multiply(this.restTorso.clone().invert());
    }
    if (!W && f.faceQ) {
      // Face only: keep the body upright but let it turn a little with the head.
      const yaw = new THREE.Euler().setFromQuaternion(dHead, "YXZ").y;
      dHips = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * 0.25);
      dChest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * 0.4);
    }

    this.orient(this.bone(m.hips), dHips);
    m.spine.forEach((b, i) => this.orient(this.bones[b], dHips.clone().slerp(dChest, (i + 1) / m.spine.length)));
    if (!m.spine.length) this.orient(this.bone(m.hips), dChest);
    this.orient(this.bone(m.neck), dChest.clone().slerp(dHead, 0.45));
    this.orient(this.bone(m.head), dHead);
    const jawOpen = f.blend?.get("jawOpen") ?? 0;
    const jaw = this.bone(m.jaw);
    if (jaw) {
      const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(this.restTorso);
      this.orient(jaw, dHead.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, jawOpen * 0.4)));
    }

    for (const s of ["L", "R"] as const) this.limbs(s, m[s], f);

    this.place(f);
    this.applyMorphs(f.blend);
    this.ease();
  }

  /** Eases every bone toward this frame's pose, so 15-30 Hz tracking reads as smooth motion at
   *  display rate instead of stepping. About 30 ms of lag; snaps after a gap. */
  private ease() {
    const now = performance.now();
    const dt = (now - this.heldAt) / 1000;
    this.heldAt = now;
    const a = dt > 0.25 ? 1 : 1 - Math.exp(-dt * 30);
    for (const o of [this.root, ...this.bones]) {
      let h = this.held.get(o);
      if (!h) this.held.set(o, (h = { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
      h.p.lerp(o.position, a);
      h.q.slerp(o.quaternion, a);
      h.s.lerp(o.scale, a);
      o.position.copy(h.p);
      o.quaternion.copy(h.q);
      o.scale.copy(h.s);
    }
    this.root.updateMatrixWorld(true);
  }

  private limbs(s: Side, sm: SideMap, f: PersonFrame) {
    const W = f.world, vis = f.vis ?? [];
    const seen = (i: number) => smooth01(vis[i] ?? 0, 0.35, 0.7);
    const L = POSE[s];
    const out = s === "L" ? 1 : -1;
    const B = (i?: number) => this.bone(i);

    // Arms: follow the person when seen, otherwise hang relaxed instead of sticking out in T-pose.
    const relaxedUpper = new THREE.Vector3(0.18 * out, -1, 0.05);
    const relaxedFore = new THREE.Vector3(0.05 * out, -0.55, 0.85);
    if (W) {
      this.aim(B(sm.shoulder), sub(W[L.sh], mid(W[11], W[12])), 0.5, B(sm.upperArm));
      this.aim(B(sm.upperArm), relaxedUpper.clone().lerp(sub(W[L.el], W[L.sh]).normalize(), seen(L.el)), 1, B(sm.foreArm));
      this.aim(B(sm.foreArm), relaxedFore.clone().lerp(sub(W[L.wr], W[L.el]).normalize(), seen(L.wr)), 1, B(sm.hand));
    } else {
      this.aim(B(sm.upperArm), relaxedUpper, 1, B(sm.foreArm));
      this.aim(B(sm.foreArm), relaxedFore, 1, B(sm.hand));
    }

    const hand = B(sm.hand);
    const H = f.hands[s];
    const rest = this.restHands[s];
    if (hand && rest) {
      let target: THREE.Quaternion | undefined;
      if (H) target = handBasis(v(H[0]), v(H[5]), v(H[17]), v(H[9]));
      else if (W && seen(L.wr) * seen(L.index) > 0.5) {
        const idx = v(W[L.index]), pnk = v(W[L.pinky]);
        target = handBasis(v(W[L.wr]), idx, pnk, idx.clone().add(pnk).multiplyScalar(0.5));
      }
      if (target) this.orient(hand, target.multiply(rest.clone().invert()));
    }
    if (H) {
      for (const fn of FINGERS) {
        const chain = sm.fingers[fn];
        if (!chain) continue;
        const lm = HAND_CHAINS[fn];
        chain.forEach((b, k) => {
          if (k + 1 >= lm.length) return;
          this.aim(this.bones[b], sub(H[lm[k + 1]], H[lm[k]]), 1, this.bone(chain[k + 1]));
        });
      }
    }

    if (W) {
      this.aim(B(sm.upLeg), sub(W[L.knee], W[L.hip]), seen(L.knee), B(sm.leg));
      this.aim(B(sm.leg), sub(W[L.ankle], W[L.knee]), seen(L.ankle) * seen(L.knee), B(sm.foot));
    }
    // Sitting at a desk: knees out of view. Fold the legs into the hips rather than letting
    // standing legs dangle in front of the desk.
    const legsSeen = W && seen(L.knee) * seen(L.ankle) > 0.5 ? 1 : 0;
    this.legShow[s] += (legsSeen - this.legShow[s]) * 0.12;
    const upLeg = B(sm.upLeg);
    if (upLeg && this.legShow[s] < 0.999) {
      upLeg.scale.multiplyScalar(Math.max(0.001, this.legShow[s]));
      upLeg.updateMatrixWorld(true);
    }

    for (const fl of sm.followers) {
      const lead = B(sm[fl.slot]);
      if (lead) this.orient(this.bones[fl.bone], this.delta(lead));
    }
  }

  /** Scales and moves the hero so its shoulders and head land on the person's. */
  private place(f: PersonFrame) {
    const m = this.map;
    const W = f.world;
    const lA = this.bone(m.L.upperArm)!, rA = this.bone(m.R.upperArm)!;
    if (W && f.T) {
      const target = this.opts.build * new THREE.Vector3().subVectors(v(W[11]), v(W[12])).length() / this.shoulderWidth;
      this.scale = this.scale ? this.scale + (target - this.scale) * 0.15 : target;
    } else if (!this.scale) {
      this.scale = (0.4 * this.opts.build) / this.shoulderWidth;
    }
    this.root.scale.setScalar(this.scale);
    this.root.updateMatrixWorld(true);

    const head = this.bone(m.head);
    const headScale = this.opts.coverHead && this.headWidth
      ? Math.min(1.5, Math.max(1, (0.44 * this.shoulderWidth) / this.headWidth))
      : 1;
    if (head && headScale !== 1) {
      head.scale.multiplyScalar(headScale);
      head.updateMatrixWorld(true);
    }

    const headCenter = () => (head ? head.localToWorld(this.headCenterLocal.clone()) : undefined);
    if (W && f.T) {
      // Anchor at the shoulders (what a webcam sees), then stretch the neck so the faces line up.
      const want = v(f.T).add(mid(W[11], W[12]));
      const have = mid(lA.getWorldPosition(new THREE.Vector3()), rA.getWorldPosition(new THREE.Vector3()));
      this.root.position.add(want.sub(have));
      this.root.updateMatrixWorld(true);
      const hc = headCenter();
      if (head?.parent && hc && (f.vis?.[7] ?? 0) + (f.vis?.[8] ?? 0) > 1) {
        const target = v(f.T).add(mid(W[7], W[8]));
        const a = head.parent.worldToLocal(hc.clone());
        const b = head.parent.worldToLocal(target);
        const shift = b.sub(a);
        const maxShift = this.rest.get(head)!.local.p.length() * 0.35;
        if (shift.length() > maxShift) shift.setLength(maxShift);
        head.position.add(shift);
        head.updateMatrixWorld(true);
      }
    } else if (f.faceCenter) {
      const hc = headCenter() ?? mid(lA.getWorldPosition(new THREE.Vector3()), rA.getWorldPosition(new THREE.Vector3()));
      this.root.position.add(v(f.faceCenter).sub(hc));
      this.root.updateMatrixWorld(true);
    }
  }

  private applyMorphs(blend?: Map<string, number>) {
    if (!blend) return;
    for (const { mesh, index } of this.morphs) {
      const inf = mesh.morphTargetInfluences;
      if (!inf) continue;
      for (const [name, val] of blend) {
        const i = index.get(normMorph(name));
        if (i !== undefined) inf[i] = val;
      }
    }
  }
}

/** ARKit-style names compared loosely: "eyeBlink_L", "EyeBlinkLeft", "eye_blink_left" all match. */
function normMorph(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/(left|l)$/, "left")
    .replace(/(right|r)$/, "right");
}
