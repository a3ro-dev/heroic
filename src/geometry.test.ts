import { test } from "node:test";
import assert from "node:assert/strict";
import { focal, solveTranslation, unproject, type V3 } from "./geometry.ts";

test("recovers where a body sits in front of the camera", () => {
  const aspect = 16 / 9;
  const f = focal();
  const T = { x: 0.12, y: -0.3, z: -1.4 };
  const body: V3[] = [
    { x: 0.18, y: 0.5, z: 0.02 },
    { x: -0.18, y: 0.5, z: 0.0 },
    { x: 0.1, y: 0, z: 0 },
    { x: -0.1, y: 0, z: 0.01 },
    { x: 0, y: 0.68, z: 0.08 },
    { x: 0.3, y: 0.25, z: 0.1 },
  ];
  const ndc = body.map((p) => {
    const c = { x: p.x + T.x, y: p.y + T.y, z: p.z + T.z };
    return { x: (f / aspect) * (c.x / -c.z), y: f * (c.y / -c.z) };
  });
  const got = solveTranslation(body, ndc, body.map(() => 1), aspect)!;
  for (const k of ["x", "y", "z"] as const) assert.ok(Math.abs(got[k] - T[k]) < 1e-6, `${k}: ${got[k]} vs ${T[k]}`);
});

test("needs three visible points", () => {
  const p = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }];
  assert.equal(solveTranslation(p, [{ x: 0, y: 0 }, { x: 0.1, y: 0 }], [1, 1], 1), null);
});

test("unproject inverts projection", () => {
  const p = unproject({ x: 0.5, y: -0.25 }, -2, 1.5);
  const f = focal();
  assert.ok(Math.abs((f / 1.5) * (p.x / 2) - 0.5) < 1e-9);
  assert.ok(Math.abs(f * (p.y / 2) + 0.25) < 1e-9);
});
