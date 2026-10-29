// Talks to the vision worker, keeps hold of the chosen person across frames, and turns their
// landmarks into a smoothed camera-space PersonFrame.
type NormalizedLandmark = { x: number; y: number; z: number; visibility?: number };
import * as THREE from "three";
import type { PersonFrame } from "./avatar";
import type { FromWorker, VisionResult } from "./vision";
import { JointFilter, OneEuro } from "./filters";
import { focal, solveTranslation, toCam, toNdc, unproject, type V3 } from "./geometry";

export interface Candidate {
  kind: "pose" | "face";
  index: number;
  /** normalized image box */
  box: { x0: number; y0: number; x1: number; y1: number };
  cx: number;
  cy: number;
  size: number;
}

export interface TrackResult {
  candidates: Candidate[];
  selected: number; // index into candidates, -1 if nobody
  person?: PersonFrame;
  /** person mask for the selected pose, 0..255, video resolution */
  mask?: { data: Uint8Array; width: number; height: number };
}

const boxOf = (lm: NormalizedLandmark[], ids?: number[]) => {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const i of ids ?? lm.keys()) {
    const p = lm[i];
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
};

export class Tracker {
  private worker = new Worker("/vision.worker.js");
  private wantMask = false;
  readonly timing = { pose: 0, face: 0, hands: 0 };
  private lastT = -1;
  private waiting: ((r: VisionResult | null) => void) | null = null;

  // who we're following
  private target: { cx: number; cy: number } | null = null;
  private locked = false;
  private lostFrames = 0;

  // smoothing, per selected person
  private fWorld = new JointFilter(33, 3, 0.8, 6);
  private fNdc = new JointFilter(33, 2, 0.8, 6);
  private fHand = { L: new JointFilter(21, 3, 1.2, 8), R: new JointFilter(21, 3, 1.2, 8) };
  private fFaceQ = new OneEuro(4, 0.8, 3);
  private fFacePos = new OneEuro(3, 0.8, 4);
  private fT = new OneEuro(3, 0.6, 3);
  private fBlend = new Map<string, OneEuro>();
  private qPrev = new THREE.Quaternion();

  init(onProgress: (msg: string) => void) {
    return new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "progress") onProgress(m.msg);
        else if (m.type === "ready") resolve();
        else if (m.type === "error") {
          if (this.waiting) this.finish(null);
          else reject(new Error(m.msg));
          console.error("vision:", m.msg);
        } else if (m.type === "result") this.finish(m.result);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || "The vision worker failed to start."));
      // the worker resolves models relative to the page, which is tauri://… or http://… depending on platform
      this.worker.postMessage({ type: "init", base: location.origin });
    });
  }

  private finish(r: VisionResult | null) {
    const w = this.waiting;
    this.waiting = null;
    w?.(r);
  }

  get busy() {
    return !!this.waiting;
  }

  /** 0 = loose and responsive, 1 = very steady. */
  set stability(s: number) {
    const c = 2.4 - s * 2.1; // min cutoff Hz
    this.fWorld.minCutoff = c;
    this.fNdc.minCutoff = c;
    this.fHand.L.minCutoff = c * 1.4;
    this.fHand.R.minCutoff = c * 1.4;
    this.fFaceQ.minCutoff = c;
    this.fFacePos.minCutoff = c;
    this.fT.minCutoff = c * 0.75;
  }

  setMask(on: boolean) {
    this.wantMask = on;
    this.worker.postMessage({ type: "mask", on });
  }

  /** Lock onto whoever is under this normalized image point. */
  select(u: number, v: number, candidates: Candidate[]) {
    let best: Candidate | undefined, bestD = Infinity;
    for (const c of candidates) {
      const inside = u >= c.box.x0 && u <= c.box.x1 && v >= c.box.y0 && v <= c.box.y1;
      const d = Math.hypot(c.cx - u, c.cy - v) - (inside ? 1 : 0);
      if (d < bestD) (bestD = d), (best = c);
    }
    if (!best) return;
    this.target = { cx: best.cx, cy: best.cy };
    this.locked = true;
    this.resetFilters();
  }

  unlock() {
    this.locked = false;
  }

  private resetFilters() {
    this.fWorld.reset();
    this.fNdc.reset();
    this.fHand.L.reset();
    this.fHand.R.reset();
    this.fFaceQ.reset();
    this.fFacePos.reset();
    this.fT.reset();
    this.fBlend.clear();
  }

  /** Sends one frame to the worker. Resolves with the tracked person for exactly that frame. */
  async track(bitmap: ImageBitmap, nowMs: number, aspect: number): Promise<TrackResult | null> {
    if (nowMs <= this.lastT) nowMs = this.lastT + 1; // MediaPipe needs strictly increasing timestamps
    this.lastT = nowMs;
    const r = await new Promise<VisionResult | null>((resolve) => {
      this.waiting = resolve;
      this.worker.postMessage({ type: "frame", bitmap, t: nowMs }, [bitmap]);
    });
    if (!r) return null;
    for (const k of ["pose", "face", "hands"] as const) this.timing[k] += (r.ms[k] - this.timing[k]) * 0.1;
    return this.process(r, nowMs / 1000, aspect);
  }

  private process(r: VisionResult, t: number, aspect: number): TrackResult {
    const pose = { landmarks: r.pose.landmarks, worldLandmarks: r.pose.world };
    const face = r.face;
    const hands = r.hands;

    // Candidates: every body, plus faces that don't belong to a detected body.
    const candidates: Candidate[] = pose.landmarks.map((lm, index) => {
      const box = boxOf(lm, [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]);
      return { kind: "pose", index, box, cx: (lm[11].x + lm[12].x) / 2, cy: (lm[0].y + lm[11].y + lm[12].y) / 3,
               size: Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y) * 2.5 };
    });
    const faceOwner = face.faceLandmarks.map((flm) => {
      let best = -1, bestD = 0.12;
      pose.landmarks.forEach((lm, i) => {
        const d = Math.hypot(lm[0].x - flm[1].x, lm[0].y - flm[1].y);
        if (d < bestD) (bestD = d), (best = i);
      });
      return best;
    });
    face.faceLandmarks.forEach((lm, index) => {
      if (faceOwner[index] >= 0) return;
      const box = boxOf(lm);
      candidates.push({ kind: "face", index, box, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2,
                        size: Math.max(box.x1 - box.x0, box.y1 - box.y0) * 2 });
    });

    // Follow the same person: nearest to where they were last frame.
    let selected = -1;
    if (this.target) {
      let bestD = 0.18;
      candidates.forEach((c, i) => {
        const d = Math.hypot(c.cx - this.target!.cx, c.cy - this.target!.cy);
        if (d < bestD) (bestD = d), (selected = i);
      });
    }
    if (selected < 0) {
      this.lostFrames++;
      if ((!this.locked || this.lostFrames > 90) && candidates.length) {
        selected = candidates.reduce((b, c, i) => (c.size > candidates[b].size ? i : b), 0);
        this.locked = false;
        this.resetFilters();
      }
    }
    if (selected < 0) return { candidates, selected };
    this.lostFrames = 0;
    const sel = candidates[selected];
    this.target = { cx: sel.cx, cy: sel.cy };

    const person: PersonFrame = { hands: {} };
    let mask: TrackResult["mask"];
    const poseIdx = sel.kind === "pose" ? sel.index : -1;
    const faceIdx = sel.kind === "face" ? sel.index : faceOwner.indexOf(poseIdx);

    if (poseIdx >= 0) {
      const lm = pose.landmarks[poseIdx].map((p) => ({ ...p }));
      const world = pose.worldLandmarks[poseIdx].map((p) => toCam(p));
      this.fWorld.filter(world, t);
      this.fNdc.filter(lm as V3[], t, 2);
      const vis = lm.map((p) => p.visibility ?? 0);
      const ndc = lm.map((p) => toNdc(p.x, p.y));
      // Torso and head points anchor the solve; limbs move too much relative to the hips.
      const anchorIds = new Set([0, 2, 5, 7, 8, 11, 12, 23, 24]);
      const T = solveTranslation(world, ndc, vis.map((w, i) => (anchorIds.has(i) && w > 0.6 ? w : 0)), aspect);
      if (T) {
        const tt = [T.x, T.y, T.z];
        this.fT.filter(tt, t);
        person.T = { x: tt[0], y: tt[1], z: tt[2] };
        person.world = world;
        person.vis = vis;
      }

      // Hands: whichever detected hand sits on this body's wrist.
      hands.landmarks.forEach((hlm, hi) => {
        for (const [side, wr] of [["L", 15], ["R", 16]] as const) {
          if (Math.hypot(hlm[0].x - lm[wr].x, hlm[0].y - lm[wr].y) < 0.08 && !person.hands[side]) {
            const pts = hands.worldLandmarks[hi].map((p) => toCam(p));
            person.hands[side] = this.fHand[side].filter(pts, t);
            return;
          }
        }
      });

      if (this.wantMask) mask = r.masks[poseIdx] ?? undefined;
    }

    if (faceIdx >= 0) {
      const mat = face.facialTransformationMatrixes[faceIdx];
      if (mat) {
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(mat.data));
        if (q.dot(this.qPrev) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // stay on one hemisphere for filtering
        const arr = [q.x, q.y, q.z, q.w];
        this.fFaceQ.filter(arr, t);
        person.faceQ = new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]).normalize();
        this.qPrev.copy(person.faceQ);
      }
      const blend = new Map<string, number>();
      for (const c of face.faceBlendshapes[faceIdx]?.categories ?? []) {
        let f = this.fBlend.get(c.categoryName);
        if (!f) this.fBlend.set(c.categoryName, (f = new OneEuro(1, 1.5, 2)));
        blend.set(c.categoryName, f.filter([c.score], t)[0]);
      }
      person.blend = blend;

      if (poseIdx < 0) {
        // Face only: depth from the face's width (≈15 cm cheek to cheek), measured in 3D so turning
        // the head doesn't make the hero jump forward.
        const flm = face.faceLandmarks[faceIdx];
        const a = flm[234], b = flm[454];
        const w = Math.hypot(a.x - b.x, a.z - b.z) * 2; // NDC units
        const z = -((focal() / aspect) * 0.15) / Math.max(w, 1e-3) - 0.04;
        const c = unproject(toNdc((a.x + b.x) / 2, (a.y + b.y) / 2), z, aspect);
        const arr = [c.x, c.y, c.z];
        this.fFacePos.filter(arr, t);
        person.faceCenter = { x: arr[0], y: arr[1], z: arr[2] };
      }
    }

    return { candidates, selected, person, mask };
  }
}
