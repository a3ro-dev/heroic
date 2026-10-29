// One Euro filter (Casiez et al. 2012): heavy smoothing when still, light when moving fast.
// This is what keeps the suit from shimmering on a still person without lagging on a fast wave.

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  private x: Float64Array | null = null;
  private dx: Float64Array;
  private t = 0;

  constructor(
    readonly size: number,
    public minCutoff = 1,
    public beta = 4,
    readonly dCutoff = 1,
  ) {
    this.dx = new Float64Array(size);
  }

  reset() {
    this.x = null;
  }

  /** Filters `v` in place. `t` is in seconds. */
  filter(v: ArrayLike<number> & { [i: number]: number }, t: number) {
    if (!this.x || t <= this.t) {
      this.x = Float64Array.from(v);
      this.dx.fill(0);
      this.t = t;
      return v;
    }
    const dt = Math.min(t - this.t, 0.5);
    this.t = t;
    const ad = alpha(this.dCutoff, dt);
    // One shared speed for the whole vector keeps a joint's x/y/z from smoothing differently.
    let speed = 0;
    for (let i = 0; i < this.size; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx[i] += ad * (d - this.dx[i]);
      speed = Math.max(speed, Math.abs(this.dx[i]));
    }
    const a = alpha(this.minCutoff + this.beta * speed, dt);
    for (let i = 0; i < this.size; i++) {
      this.x[i] += a * (v[i] - this.x[i]);
      v[i] = this.x[i];
    }
    return v;
  }
}

/** A bank of per-joint filters so one fast hand doesn't loosen smoothing on the whole body. */
export class JointFilter {
  private filters: OneEuro[];
  constructor(joints: number, dims: number, minCutoff: number, beta: number) {
    this.filters = Array.from({ length: joints }, () => new OneEuro(dims, minCutoff, beta));
  }
  set minCutoff(v: number) {
    for (const f of this.filters) f.minCutoff = v;
  }
  reset() {
    for (const f of this.filters) f.reset();
  }
  filter(points: { x: number; y: number; z: number }[], t: number, dims = 3) {
    const tmp = [0, 0, 0];
    points.forEach((p, i) => {
      const f = this.filters[i];
      if (!f) return;
      tmp[0] = p.x;
      tmp[1] = p.y;
      tmp[2] = p.z;
      f.filter(tmp, t);
      p.x = tmp[0];
      p.y = tmp[1];
      if (dims === 3) p.z = tmp[2];
    });
    return points;
  }
}
