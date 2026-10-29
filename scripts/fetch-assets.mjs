// Copies the MediaPipe wasm runtime into public/ and fetches the task models once.
import { cpSync, existsSync, writeFileSync } from "node:fs";

cpSync("node_modules/@mediapipe/tasks-vision/wasm", "public/wasm", { recursive: true });
cpSync("node_modules/@mediapipe/tasks-vision/vision_bundle.cjs", "public/wasm/vision_bundle.cjs");

const base = "https://storage.googleapis.com/mediapipe-models";
const models = {
  "pose_landmarker_full.task": `${base}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
  "face_landmarker.task": `${base}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`,
  "hand_landmarker.task": `${base}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`,
};
for (const [name, url] of Object.entries(models)) {
  const out = `public/models/${name}`;
  if (existsSync(out)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log("fetched", name);
}
