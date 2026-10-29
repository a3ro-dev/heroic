// The GPU side: draws the camera feed (optionally with the wearer painted out using a clean
// background plate), lights the hero to match the room, and hands frames to the virtual camera.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Avatar, type PersonFrame } from "./avatar";
import { FOV_Y_DEG } from "./geometry";
import { COMPOSITE, Vanish } from "./vanish";

const BG_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV_Y_DEG, 16 / 9, 0.05, 50);
  private bgScene = new THREE.Scene();
  private bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bg: THREE.ShaderMaterial;
  private camTex: THREE.VideoTexture;
  private maskTex: THREE.DataTexture | null = null;
  private maskUniforms: { mask: THREE.IUniform; maskTexel: THREE.IUniform; hasMask: THREE.IUniform };
  private vanishFx: Vanish;
  private lastMask: Uint8Array | null = null;
  private hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
  private key = new THREE.DirectionalLight(0xffffff, 1.6);
  private avatar: Avatar | null = null;
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  private frame = 0;
  private readBuf: Uint8Array | null = null;
  /** paint the wearer out of the picture */
  vanish = true;
  /** set when tracking sees nobody, so the whole frame is safe to learn as background */
  empty = false;
  /** 0..1, fades the hero in when a suit is applied */
  reveal = 1;

  constructor(private video: HTMLVideoElement) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.autoClear = false;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    this.scene.add(this.hemi, this.key, this.key.target);
    this.key.position.set(1, 2, 2);

    this.camTex = new THREE.VideoTexture(video);
    this.camTex.colorSpace = THREE.SRGBColorSpace;
    const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    dummy.needsUpdate = true;
    this.maskUniforms = { mask: { value: dummy }, maskTexel: { value: new THREE.Vector2(1 / 640, 1 / 480) }, hasMask: { value: 0 } };
    this.vanishFx = new Vanish(this.renderer, this.maskUniforms, this.camTex);
    this.bg = new THREE.ShaderMaterial({
      vertexShader: BG_VERT,
      fragmentShader: COMPOSITE,
      uniforms: { cam: { value: this.camTex }, plate: { value: dummy }, vanish: { value: 0 }, seed: { value: 0 }, person: { value: dummy }, hasMask: this.maskUniforms.hasMask },
      depthTest: false,
      depthWrite: false,
    });
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bg));
    this.probe.canvas.width = 8;
    this.probe.canvas.height = 6;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

  }

  async loadHero(url: string, opts?: Avatar["opts"]) {
    const gltf = await this.loader.loadAsync(url);
    const next = new Avatar(gltf.scene);
    if (opts) next.opts = opts;
    gltf.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && "envMapIntensity" in m) m.envMapIntensity = 1;
    });
    if (this.avatar) {
      this.scene.remove(this.avatar.root);
      dispose(this.avatar.root);
    }
    this.avatar = next;
    next.root.visible = false;
    this.scene.add(next.root);
    this.reveal = 0;
    return next;
  }

  get hero() {
    return this.avatar;
  }

  /** Teaches the plate the room in one go from a frame with nobody in it. */
  capturePlate() {
    const c = document.createElement("canvas");
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    c.getContext("2d")!.drawImage(this.video, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.vanishFx.seed(tex);
    tex.dispose();
  }

  /** Forget the learned room (after switching cameras). */
  resetPlate() {
    this.vanishFx.clear();
  }

  setMask(mask?: { data: Uint8Array; width: number; height: number }) {
    if (!mask) {
      this.maskUniforms.hasMask.value = 0;
      return;
    }
    if (!this.maskTex || this.maskTex.image.width !== mask.width || this.maskTex.image.height !== mask.height) {
      this.maskTex?.dispose();
      this.maskTex = new THREE.DataTexture(new Uint8Array(mask.width * mask.height), mask.width, mask.height, THREE.RedFormat);
      this.maskTex.magFilter = this.maskTex.minFilter = THREE.LinearFilter;
      this.maskUniforms.mask.value = this.maskTex;
      this.maskUniforms.maskTexel.value.set(1 / mask.width, 1 / mask.height);
    }
    if (mask.data !== this.lastMask) {
      (this.maskTex.image.data as Uint8Array).set(mask.data);
      this.maskTex.needsUpdate = true;
      this.lastMask = mask.data;
    }
    this.maskUniforms.hasMask.value = 1;
  }

  /** Matches the hero's lighting to the room: overall colour, brightness and which side is lit. */
  private matchLighting() {
    const ctx = this.probe;
    ctx.drawImage(this.video, 0, 0, 8, 6);
    const d = ctx.getImageData(0, 0, 8, 6).data;
    let r = 0, g = 0, b = 0, left = 0, right = 0, top = 0;
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        const l = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        if (x < 3) left += l;
        if (x > 4) right += l;
        if (y < 2) top += l;
      }
    const n = 48 * 255;
    const avg = new THREE.Color(r / n, g / n, b / n);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n;
    const k = 0.15; // ease towards the new reading so lighting never flickers
    this.hemi.color.lerp(avg.clone().multiplyScalar(1.4).addScalar(0.15), k);
    this.hemi.groundColor.lerp(avg.clone().multiplyScalar(0.35), k);
    this.hemi.intensity += (0.5 + lum * 1.5 - this.hemi.intensity) * k;
    this.key.intensity += (0.6 + lum * 2.2 - this.key.intensity) * k;
    this.scene.environmentIntensity += (0.25 + lum * 0.8 - this.scene.environmentIntensity) * k;
    // the image is unmirrored: brighter on image-left means light from the camera's left (-x)
    const side = (right - left) / (right + left + 1e-3);
    const want = new THREE.Vector3(side * 3, 1.5 + (top / (16 * 255)) * 1.5, 2);
    this.key.position.lerp(want, k);
  }

  render(person: PersonFrame | undefined) {
    if (this.frame++ % 10 === 0 && this.video.readyState >= 2) this.matchLighting();
    const a = this.avatar;
    if (a) {
      if (person && (person.world || person.faceCenter)) {
        a.update(person);
        a.root.visible = true;
        this.reveal = Math.min(1, this.reveal + 0.06);
      } else {
        this.reveal = Math.max(0, this.reveal - 0.08);
        a.root.visible = this.reveal > 0;
      }
      setOpacity(a.root, this.reveal);
    }
    // Learn the room only when we know where people are: with their mask, or when nobody is in frame.
    if (this.vanish && (this.maskUniforms.hasMask.value || this.empty)) {
      this.bg.uniforms.plate.value = this.vanishFx.update();
      this.bg.uniforms.person.value = this.vanishFx.personTexture;
      this.bg.uniforms.seed.value = (this.frame % 64) * 1.37;
    }
    this.bg.uniforms.vanish.value = this.vanish && this.maskUniforms.hasMask.value ? 1 : 0;
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCam);
    this.renderer.render(this.scene, this.camera);
  }

  /** Bottom-up RGBA of the frame just drawn. Call straight after render(). */
  readPixels() {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!this.readBuf || this.readBuf.length !== w * h * 4) this.readBuf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf);
    return { data: this.readBuf, width: w, height: h };
  }
}

function setOpacity(root: THREE.Object3D, t: number) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (!m) return;
    m.userData.baseOpacity ??= m.opacity;
    m.userData.baseTransparent ??= m.transparent;
    const transparent = t < 1 || m.userData.baseTransparent;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.needsUpdate = true;
    }
    m.opacity = m.userData.baseOpacity * t;
  });
}

function dispose(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}
