// MediaPipe runs here, on its own GPU context, so a slow inference never stalls drawing or the UI.
// Plain classic worker on purpose: MediaPipe loads its wasm glue with importScripts.
/* global importScripts */
var exports = {};
importScripts("wasm/vision_bundle.cjs");
const { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } = exports;

let pose, face, hands;
let wantMask = false;
let frame = 0;
let lastHands = { landmarks: [], worldLandmarks: [] };
const post = (m, transfer = []) => self.postMessage(m, transfer);

async function create(make) {
  try {
    return await make("GPU");
  } catch (e) {
    console.warn("GPU delegate failed, using CPU", e);
    return make("CPU");
  }
}

async function init(base) {
  post({ type: "progress", msg: "Loading vision runtime" });
  const files = await FilesetResolver.forVisionTasks(`${base}/wasm`);
  post({ type: "progress", msg: "Loading body tracker" });
  pose = await create((delegate) =>
    PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}/models/pose_landmarker_full.task`, delegate },
      runningMode: "VIDEO",
      numPoses: 2,
      outputSegmentationMasks: wantMask,
    }),
  );
  post({ type: "progress", msg: "Loading face tracker" });
  face = await create((delegate) =>
    FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}/models/face_landmarker.task`, delegate },
      runningMode: "VIDEO",
      numFaces: 2,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    }),
  );
  post({ type: "progress", msg: "Loading hand tracker" });
  hands = await create((delegate) =>
    HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}/models/hand_landmarker.task`, delegate },
      runningMode: "VIDEO",
      numHands: 2,
    }),
  );
  post({ type: "ready" });
}

function detect(bitmap, t) {
  const t0 = performance.now();
  const p = pose.detectForVideo(bitmap, t);
  const t1 = performance.now();
  const f = face.detectForVideo(bitmap, t);
  const t2 = performance.now();
  // Hands cost as much as body and face together; every other frame is plenty once filtered.
  if (frame++ & 1) lastHands = hands.detectForVideo(bitmap, t);
  const t3 = performance.now();
  bitmap.close();

  const masks = (p.segmentationMasks || []).map((m) => {
    const out = wantMask ? { data: m.getAsUint8Array().slice(), width: m.width, height: m.height } : null;
    m.close();
    return out;
  });
  const result = {
    pose: {
      landmarks: p.landmarks.map((l) => l.map(({ x, y, z, visibility }) => ({ x, y, z, visibility: visibility ?? 0 }))),
      world: p.worldLandmarks.map((l) => l.map(({ x, y, z }) => ({ x, y, z }))),
    },
    face: {
      faceLandmarks: f.faceLandmarks,
      faceBlendshapes: f.faceBlendshapes,
      facialTransformationMatrixes: f.facialTransformationMatrixes,
    },
    hands: { landmarks: lastHands.landmarks, worldLandmarks: lastHands.worldLandmarks },
    masks,
    ms: { pose: t1 - t0, face: t2 - t1, hands: t3 - t2 },
  };
  post({ type: "result", t, result }, masks.flatMap((m) => (m ? [m.data.buffer] : [])));
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") await init(m.base);
    else if (m.type === "mask") {
      wantMask = m.on;
      if (pose) await pose.setOptions({ outputSegmentationMasks: m.on });
    } else if (m.type === "frame") detect(m.bitmap, m.t);
  } catch (err) {
    if (m.type === "frame") m.bitmap.close();
    post({ type: "error", msg: String((err && err.message) || err) });
  }
};
