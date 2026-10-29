// Person matte from Robust Video Matting (Lin et al. 2021). It's recurrent: it carries what it
// learned from earlier frames, so edges and hair stay put instead of flickering the way per-frame
// segmentation does. Runs on WebGPU through ONNX Runtime, off the critical path: each frame takes
// the newest finished matte while the next one computes.
import * as ort from "onnxruntime-web";

// the loader is bundled in; only the binary is served from public/
ort.env.wasm.wasmPaths = { wasm: "/ort/ort-wasm-simd-threaded.jsep.wasm" };
ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the webviews don't give

const W = 640; // input width; RVM looks at it at W * RATIO and refines edges back up to W
const RATIO = 0.6;

export type MatteImage = { data: Uint8Array; width: number; height: number };

export class Matte {
  private session?: ort.InferenceSession;
  private rec: ort.Tensor[] = [];
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private src = new Float32Array(0);
  private ratio = new ort.Tensor("float32", new Float32Array([RATIO]), [1]);
  private busy = false;
  latest?: MatteImage;
  ms = 0;

  get ready() {
    return !!this.session;
  }

  /** Loads the model on WebGPU. False when there's no WebGPU; the caller keeps its old mask. */
  async init(): Promise<boolean> {
    if (!("gpu" in navigator)) return false;
    try {
      this.session = await ort.InferenceSession.create("/models/rvm_mobilenetv3_fp32.onnx", {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
        // recurrent state stays on the GPU between frames; only the matte comes back
        preferredOutputLocation: { pha: "cpu", r1o: "gpu-buffer", r2o: "gpu-buffer", r3o: "gpu-buffer", r4o: "gpu-buffer" },
      });
    } catch (e) {
      console.warn("matte unavailable", e);
      return false;
    }
    this.reset();
    return true;
  }

  /** Forget the previous frames, e.g. after switching cameras. */
  reset() {
    for (const t of this.rec) if (t.location === "gpu-buffer") t.dispose();
    const zero = () => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]);
    this.rec = [zero(), zero(), zero(), zero()];
    this.latest = undefined;
  }

  /** Starts a matte for this frame unless one is still running. */
  push(video: HTMLVideoElement) {
    if (!this.session || this.busy || !video.videoWidth) return;
    const h = Math.round((W * video.videoHeight) / video.videoWidth / 16) * 16;
    if (this.canvas.width !== W || this.canvas.height !== h) Object.assign(this.canvas, { width: W, height: h });
    this.ctx.drawImage(video, 0, 0, W, h);
    const px = this.ctx.getImageData(0, 0, W, h).data;
    const n = W * h;
    if (this.src.length !== 3 * n) {
      this.src = new Float32Array(3 * n);
      this.reset(); // state shapes follow the input size
    }
    const s = this.src;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      s[i] = px[j] / 255;
      s[n + i] = px[j + 1] / 255;
      s[2 * n + i] = px[j + 2] / 255;
    }
    this.busy = true;
    const t0 = performance.now();
    const [r1i, r2i, r3i, r4i] = this.rec;
    this.session
      .run({ src: new ort.Tensor("float32", s, [1, 3, h, W]), r1i, r2i, r3i, r4i, downsample_ratio: this.ratio }, ["pha", "r1o", "r2o", "r3o", "r4o"])
      .then((out) => {
        for (const t of this.rec) if (t.location === "gpu-buffer") t.dispose();
        this.rec = [out.r1o, out.r2o, out.r3o, out.r4o];
        const pha = out.pha.data as Float32Array;
        const data = new Uint8Array(n);
        for (let i = 0; i < n; i++) data[i] = pha[i] * 255;
        this.latest = { data, width: W, height: h };
        this.ms += (performance.now() - t0 - this.ms) * 0.1;
      })
      .catch((e) => console.warn("matte frame failed", e))
      .finally(() => (this.busy = false));
  }
}
