// Camera-space geometry shared by tracking and the stage. Pure math, no three.js, so it can be tested.
// Camera space: x right, y up, z toward the viewer, camera at the origin looking down -z.

export type V3 = { x: number; y: number; z: number };

/** Vertical field of view the render camera and every solve below assume. Typical laptop webcam. */
export const FOV_Y_DEG = 50;
export const focal = (fovDeg = FOV_Y_DEG) => 1 / Math.tan((fovDeg * Math.PI) / 360);

/** MediaPipe world landmark (x right, y down, z away) → camera axes. */
export const toCam = (p: V3): V3 => ({ x: p.x, y: -p.y, z: -p.z });

/** Normalized image coords (0..1, y down) → NDC (-1..1, y up). */
export const toNdc = (u: number, v: number) => ({ x: u * 2 - 1, y: 1 - v * 2 });

/**
 * Finds the translation T that puts hip-centred metric points P (camera axes) where the
 * camera sees them: project(P_i + T) ≈ ndc_i. Linear least squares, weighted by visibility.
 */
export function solveTranslation(
  world: V3[],
  ndc: { x: number; y: number }[],
  weights: number[],
  aspect: number,
  f = focal(),
): V3 | null {
  // Rows: tx + a·tz = -a·Pz - Px  and  ty + b·tz = -b·Pz - Py, with a = x·aspect/f, b = y/f.
  let s11 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, r1 = 0, r2 = 0, r3 = 0, n = 0;
  for (let i = 0; i < world.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    const P = world[i];
    const a = (ndc[i].x * aspect) / f;
    const b = ndc[i].y / f;
    const ra = -a * P.z - P.x;
    const rb = -b * P.z - P.y;
    s11 += w;
    s13 += w * a;
    s22 += w;
    s23 += w * b;
    s33 += w * (a * a + b * b);
    r1 += w * ra;
    r2 += w * rb;
    r3 += w * (a * ra + b * rb);
    n++;
  }
  if (n < 3) return null;
  // Normal equations [[s11,0,s13],[0,s22,s23],[s13,s23,s33]] t = r; eliminate tx and ty.
  const denom = s33 - (s13 * s13) / s11 - (s23 * s23) / s22;
  if (Math.abs(denom) < 1e-9) return null;
  const tz = (r3 - (s13 * r1) / s11 - (s23 * r2) / s22) / denom;
  const tx = (r1 - s13 * tz) / s11;
  const ty = (r2 - s23 * tz) / s22;
  return tz < 0 ? { x: tx, y: ty, z: tz } : null;
}

/** Back-projects an NDC point at camera depth z (negative). */
export function unproject(ndc: { x: number; y: number }, z: number, aspect: number, f = focal()): V3 {
  return { x: (ndc.x * -z * aspect) / f, y: (ndc.y * -z) / f, z };
}
