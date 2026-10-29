// Makes the wearer disappear, live, on the GPU:
//  1. a clean plate that teaches itself: every frame, pixels not covered by the person blend into a
//     background model, so the room behind you fills in as you move;
//  2. push-pull hole filling: anything the camera has never seen is filled from its surroundings
//     through a mip pyramid (about 20 tiny passes);
//  3. the composite swaps the person for that plate, with grain so it doesn't look frozen.
import * as THREE from "three";

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Grow and soften the person mask so hair, edges and fast motion never leave a halo. Runs once per
// frame at quarter resolution; every other pass reads the result with a single bilinear tap.
const DILATE = /* glsl */ `
  uniform sampler2D mask;
  uniform vec2 maskTexel;
  uniform vec4 box; // x0, y0, x1, y1 in mask uv: only the chosen person vanishes
  varying vec2 vUv;
  void main() {
    vec2 muv = vec2(vUv.x, 1.0 - vUv.y); // mask rows arrive top first
    vec2 out2 = max(box.xy - muv, muv - box.zw);
    float inBox = 1.0 - smoothstep(0.0, 0.04, max(out2.x, out2.y));
    float m = 0.0;
    for (int i = -2; i <= 2; i++)
      for (int j = -2; j <= 2; j++)
        m = max(m, texture2D(mask, muv + vec2(float(i), float(j)) * maskTexel * 5.0).r);
    // hair and fast motion fall just outside the model's mask, so lean generous
    gl_FragColor = vec4(smoothstep(0.08, 0.45, m) * inBox, 0.0, 0.0, 1.0);
  }
`;

const MASK_FN = /* glsl */ `
  uniform sampler2D person;
  uniform float hasMask;
  float personAt(vec2 uv) { return hasMask > 0.5 ? texture2D(person, uv).r : 0.0; }
`;

const LEARN = /* glsl */ `
  uniform sampler2D cam;
  uniform sampler2D prev;
  uniform float rate;
  varying vec2 vUv;
  ${MASK_FN}
  void main() {
    vec4 p = texture2D(prev, vUv);
    vec3 c = texture2D(cam, vUv).rgb;
    float visible = 1.0 - personAt(vUv);
    // never seen before: take it whole; afterwards drift slowly so lighting changes follow
    float k = (p.a < 0.5 ? 1.0 : rate) * visible;
    gl_FragColor = vec4(mix(p.rgb, c, k), max(p.a, step(0.5, visible)));
  }
`;

const PREMULT = /* glsl */ `
  uniform sampler2D src;
  varying vec2 vUv;
  void main() { vec4 c = texture2D(src, vUv); gl_FragColor = vec4(c.rgb * c.a, c.a); }
`;

// Bilinear sampling at half resolution averages 2x2 premultiplied texels in one tap.
const DOWN = /* glsl */ `
  uniform sampler2D src;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(src, vUv); }
`;

const UP = /* glsl */ `
  uniform sampler2D coarse;
  uniform sampler2D fine;
  varying vec2 vUv;
  void main() {
    vec4 f = texture2D(fine, vUv);
    vec3 filled = texture2D(coarse, vUv).rgb;
    vec3 known = f.rgb / max(f.a, 1e-4);
    gl_FragColor = vec4(mix(filled, known, clamp(f.a * 1.5, 0.0, 1.0)), 1.0);
  }
`;

const COARSEST = /* glsl */ `
  uniform sampler2D src;
  varying vec2 vUv;
  void main() { vec4 c = texture2D(src, vUv); gl_FragColor = vec4(c.a > 1e-4 ? c.rgb / c.a : vec3(0.5), 1.0); }
`;

export const COMPOSITE = /* glsl */ `
  uniform sampler2D cam;
  uniform sampler2D plate;
  uniform float vanish;
  uniform float seed;
  varying vec2 vUv;
  ${MASK_FN}
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
  void main() {
    vec4 c = texture2D(cam, vUv);
    if (vanish > 0.0) {
      float m = personAt(vUv) * vanish;
      vec3 bg = texture2D(plate, vUv).rgb;
      bg += (hash(gl_FragCoord.xy) - 0.5) * 0.02; // webcam-like grain over the painted area
      c.rgb = mix(c.rgb, bg, m);
    }
    gl_FragColor = c;
    #include <colorspace_fragment>
  }
`;

export class Vanish {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private bg: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private pyramid: THREE.WebGLRenderTarget[] = [];
  private filled: THREE.WebGLRenderTarget[] = [];
  private learn: THREE.ShaderMaterial;
  private premult: THREE.ShaderMaterial;
  private down: THREE.ShaderMaterial;
  private up: THREE.ShaderMaterial;
  private coarsest: THREE.ShaderMaterial;
  private dilate: THREE.ShaderMaterial;
  private personRT = this.rt(1, 1);
  private flip = 0;
  private w = 0;
  private h = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private maskUniforms: { mask: THREE.IUniform; maskTexel: THREE.IUniform; hasMask: THREE.IUniform; box: THREE.IUniform },
    camTex: THREE.Texture,
  ) {
    const mk = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.dilate = mk(DILATE, { mask: maskUniforms.mask, maskTexel: maskUniforms.maskTexel, box: maskUniforms.box });
    this.learn = mk(LEARN, { cam: { value: camTex }, prev: { value: null }, rate: { value: 0.05 }, person: { value: this.personRT.texture }, hasMask: maskUniforms.hasMask });
    this.premult = mk(PREMULT, { src: { value: null } });
    this.down = mk(DOWN, { src: { value: null } });
    this.up = mk(UP, { coarse: { value: null }, fine: { value: null } });
    this.coarsest = mk(COARSEST, { src: { value: null } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.learn);
    this.scene.add(this.quad);
    this.bg = [this.rt(1, 1), this.rt(1, 1)];
  }

  private rt(w: number, h: number) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
  }

  private resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    for (const t of [...this.bg, ...this.pyramid, ...this.filled, this.personRT]) t.dispose();
    this.bg = [this.rt(w, h), this.rt(w, h)];
    this.personRT = this.rt(Math.ceil(w / 4), Math.ceil(h / 4));
    this.learn.uniforms.person.value = this.personRT.texture;
    this.pyramid = [];
    this.filled = [];
    for (let lw = w, lh = h; ; lw = Math.ceil(lw / 2), lh = Math.ceil(lh / 2)) {
      this.pyramid.push(this.rt(lw, lh));
      this.filled.push(this.rt(lw, lh));
      if (lw <= 2 && lh <= 2) break;
    }
    this.clear();
  }

  /** Forget the learned room, e.g. after switching cameras. */
  clear() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setClearColor(0x000000, 0);
    for (const t of this.bg) {
      r.setRenderTarget(t);
      r.clear();
    }
    r.setRenderTarget(prev);
  }

  /** Seeds the plate with a frame known to be empty of people. */
  seed(tex: THREE.Texture) {
    const u = this.learn.uniforms;
    const [cam, hasMask] = [u.cam.value, u.hasMask.value];
    u.hasMask.value = 0;
    u.cam.value = tex;
    u.rate.value = 1;
    this.update();
    u.hasMask.value = hasMask;
    u.cam.value = cam;
    u.rate.value = 0.05;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  /** The dilated person mask from the last update, for the final composite. */
  get personTexture() {
    return this.personRT.texture;
  }

  /** Learns from the current frame and returns the filled clean plate. */
  update(): THREE.Texture {
    const tex = this.learn.uniforms.cam.value as THREE.Texture;
    const img = tex.image as { videoWidth?: number; width: number; videoHeight?: number; height: number };
    this.resize(img.videoWidth || img.width, img.videoHeight || img.height);
    const prevTarget = this.renderer.getRenderTarget();
    if (this.maskUniforms.hasMask.value) this.pass(this.dilate, this.personRT);

    const src = this.bg[this.flip], dst = this.bg[1 - this.flip];
    this.flip = 1 - this.flip;
    this.learn.uniforms.prev.value = src.texture;
    this.pass(this.learn, dst);

    this.premult.uniforms.src.value = dst.texture;
    this.pass(this.premult, this.pyramid[0]);
    for (let i = 1; i < this.pyramid.length; i++) {
      this.down.uniforms.src.value = this.pyramid[i - 1].texture;
      this.pass(this.down, this.pyramid[i]);
    }
    const last = this.pyramid.length - 1;
    this.coarsest.uniforms.src.value = this.pyramid[last].texture;
    this.pass(this.coarsest, this.filled[last]);
    for (let i = last - 1; i >= 0; i--) {
      this.up.uniforms.coarse.value = this.filled[i + 1].texture;
      this.up.uniforms.fine.value = this.pyramid[i].texture;
      this.pass(this.up, this.filled[i]);
    }
    this.renderer.setRenderTarget(prevTarget);
    return this.filled[0].texture;
  }
}
