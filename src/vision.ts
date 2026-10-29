// Messages between the page and public/vision.worker.js (a classic worker, so MediaPipe can
// importScripts its wasm loader the same way in dev, in the bundle and inside Tauri).
import type { FaceLandmarkerResult, HandLandmarkerResult } from "@mediapipe/tasks-vision";

export type ToWorker =
  | { type: "init"; base: string }
  | { type: "frame"; bitmap: ImageBitmap; t: number }
  | { type: "mask"; on: boolean };

export interface VisionResult {
  pose: { landmarks: { x: number; y: number; z: number; visibility: number }[][]; world: { x: number; y: number; z: number }[][] };
  face: Pick<FaceLandmarkerResult, "faceLandmarks" | "faceBlendshapes" | "facialTransformationMatrixes">;
  hands: Pick<HandLandmarkerResult, "landmarks" | "worldLandmarks">;
  masks: ({ data: Uint8Array; width: number; height: number } | null)[];
  ms: { pose: number; face: number; hands: number };
}

export type FromWorker =
  | { type: "progress"; msg: string }
  | { type: "ready" }
  | { type: "error"; msg: string }
  | { type: "result"; t: number; result: VisionResult };

