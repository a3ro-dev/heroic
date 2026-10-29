import "./style.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createIcons, Plus, ScanLine, Settings2, X } from "lucide";
import { HEROES, type Hero } from "./heroes";
import { Matte } from "./matte";
import { Stage } from "./stage";
import { Tracker, type Candidate, type TrackResult } from "./tracker";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const stageEl = $("stage");
const view = $("view");
const people = $("people");
const statusEl = $("status");
const toastEl = $("toast");
const isAndroid = /Android/i.test(navigator.userAgent);
const canLive = isTauri() && !isAndroid;

createIcons({ icons: { Plus, ScanLine, Settings2, X } });

// ---------- settings, remembered between runs ----------

const prefs = {
  hero: "hulk",
  camera: "",
  mirror: true,
  stability: 0.6,
  build: 1.08,
  coverHead: true,
  vanish: true,
  hd: false,
  ...JSON.parse(localStorage.getItem("heroic.prefs") ?? "{}"),
};
const save = () => localStorage.setItem("heroic.prefs", JSON.stringify(prefs));

let toastTimer = 0;
function toast(msg: string, ms = 4200) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), ms);
}

// ---------- boot ----------

const stage = new Stage(video);
view.append(stage.canvas);
const tracker = new Tracker();
const matte = new Matte();

function bootStep(msg: string) {
  $("boot-step").textContent = msg;
}

function bootFail(msg: string) {
  $("boot-error").hidden = false;
  $("boot-error-text").textContent = msg;
  $("boot-step").hidden = true;
}

// ?src=/test/clip.mp4 swaps the webcam for a looping file: handy for testing without a camera
const testSrc = new URLSearchParams(location.search).get("src");

async function startCamera() {
  if (testSrc) {
    video.src = testSrc;
    video.loop = true;
    await video.play();
    stage.resize(video.videoWidth, video.videoHeight);
    return;
  }
  video.srcObject && (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: prefs.camera ? { exact: prefs.camera } : undefined,
      facingMode: prefs.camera ? undefined : "user",
      width: { ideal: prefs.hd ? 1920 : 1280 },
      height: { ideal: prefs.hd ? 1080 : 720 },
      frameRate: { ideal: 60 },
    },
  });
  video.srcObject = stream;
  await video.play();
  stage.resetPlate();
  stage.resize(video.videoWidth, video.videoHeight);
  await listCameras();
}

function cameraError(e: unknown) {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError") return "Camera access is turned off for Heroic. Allow it in your system privacy settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Plug one in or pick another device, then try again.";
  if (name === "NotReadableError") return "Another app is holding the camera. Close it, then try again.";
  return `The camera didn't start (${(e as Error)?.message ?? e}).`;
}

async function listCameras() {
  const sel = $<HTMLSelectElement>("camera");
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const current = (video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId;
  sel.replaceChildren(
    ...devices
      // never offer our own output as an input; that would loop forever
      .filter((d) => !/obs virtual|heroic/i.test(d.label))
      .map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId, false, d.deviceId === current)),
  );
}

let booted = false;
async function boot() {
  $("boot-error").hidden = true;
  $("boot-step").hidden = false;
  try {
    bootStep("Starting the camera");
    await startCamera();
  } catch (e) {
    return bootFail(cameraError(e));
  }
  try {
    await tracker.init(bootStep);
    tracker.stability = prefs.stability;
    bootStep("Loading the person matte");
    if (await matte.init()) await tracker.setMask(false); // the matte replaces the body model's mask
    bootStep("Fitting the suit");
    await wear(HEROES.find((h) => h.id === prefs.hero) ?? HEROES[0]);
  } catch (e) {
    console.error(e);
    return bootFail(`Something failed while loading: ${(e as Error).message}`);
  }
  $("boot").classList.add("done");
  booted = true;
  loop();
}
$("boot-retry").onclick = boot;

// ---------- heroes ----------

const heroList = $("heroes");
function renderHeroes(active: string) {
  heroList.replaceChildren(
    ...HEROES.map((h) => {
      const li = document.createElement("li");
      li.className = "hero-card";
      li.role = "option";
      li.tabIndex = 0;
      li.dataset.id = h.id;
      li.style.setProperty("--accent", h.accent);
      li.setAttribute("aria-selected", String(h.id === active));
      li.innerHTML = `<span class="dot"></span><span class="hero-name"></span><span class="hero-note"></span>`;
      li.querySelector(".hero-name")!.textContent = h.name;
      li.querySelector(".hero-note")!.textContent = h.note;
      li.onclick = () => wear(h);
      li.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), wear(h));
      return li;
    }),
  );
}

let wearing = "";
async function wear(h: Hero) {
  const card = heroList.querySelector<HTMLElement>(`[data-id="${h.id}"]`);
  card?.setAttribute("aria-busy", "true");
  try {
    const a = await stage.loadHero(h.url);
    a.opts = { build: prefs.build, coverHead: prefs.coverHead };
    wearing = h.name;
    if (!h.id.startsWith("custom:")) {
      prefs.hero = h.id;
      save();
    }
    renderHeroes(h.id);
    sweep();
  } catch (e) {
    console.error(e);
    toast(`Couldn't put on ${h.name}: ${(e as Error).message}`);
    card?.removeAttribute("aria-busy");
  }
}

$<HTMLInputElement>("add-hero").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  await wear({ id: `custom:${file.name}`, name: file.name.replace(/\.(glb|gltf)$/i, ""), note: "", accent: "#f2f0ec", url });
  (e.target as HTMLInputElement).value = "";
};

// ---------- people on stage ----------

/** Where the video is drawn inside the stage (object-fit: contain). */
function videoRect() {
  const r = view.getBoundingClientRect();
  const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
  const w = video.videoWidth * s, h = video.videoHeight * s;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}

let lastResult: TrackResult | null = null;
const boxes: HTMLElement[] = [];

function drawPeople(res: TrackResult) {
  const vr = videoRect();
  Object.assign(people.style, { left: `${vr.x}px`, top: `${vr.y}px`, width: `${vr.w}px`, height: `${vr.h}px` });
  res.candidates.forEach((c, i) => {
    let el = boxes[i];
    if (!el) {
      el = document.createElement("div");
      el.className = "person";
      el.innerHTML = "<i></i><i></i><i></i><i></i><b></b>";
      el.onclick = () => lastResult && tracker.select(...centerOf(lastResult.candidates[i]), lastResult.candidates);
      people.append(el);
      boxes[i] = el;
    }
    const pad = 0.03;
    const x0 = Math.max(0, c.box.x0 - pad), y0 = Math.max(0, c.box.y0 - pad);
    const x1 = Math.min(1, c.box.x1 + pad), y1 = Math.min(1, c.box.y1 + pad * 2);
    el.style.transform = `translate(${x0 * vr.w}px, ${y0 * vr.h}px)`;
    el.style.width = `${(x1 - x0) * vr.w}px`;
    el.style.height = `${(y1 - y0) * vr.h}px`;
    el.hidden = false;
    const chosen = i === res.selected;
    el.classList.toggle("chosen", chosen);
    el.querySelector("b")!.textContent = chosen ? wearing : `Put ${wearing} on this person`;
  });
  for (let i = res.candidates.length; i < boxes.length; i++) boxes[i].hidden = true;

  const n = res.candidates.length;
  statusEl.textContent =
    res.selected < 0 ? (n ? "Tap someone to suit them up" : "Looking for you")
    : `${res.candidates[res.selected].kind === "face" ? "Face" : "Body"} · ${fps.toFixed(0)} fps${n > 1 ? ` · ${n} people` : ""}`;
}

const centerOf = (c: Candidate): [number, number] => [c.cx, c.cy];

// tapping empty space also picks the nearest person
stageEl.addEventListener("click", (e) => {
  if (!lastResult?.candidates.length || (e.target as HTMLElement).closest(".person")) return;
  const vr = videoRect();
  let u = (e.clientX - vr.x) / vr.w;
  const v = (e.clientY - vr.y) / vr.h;
  if (prefs.mirror) u = 1 - u;
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  tracker.select(u, v, lastResult.candidates);
});

/** The suit-up moment: one line sweeps down over the wearer. */
function sweep() {
  const scan = $("scan");
  const c = lastResult?.candidates[lastResult.selected];
  const vr = videoRect();
  const box = c?.box ?? { x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.95 };
  const left = prefs.mirror ? 1 - box.x1 : box.x0;
  Object.assign(scan.style, {
    left: `${vr.x + left * vr.w}px`,
    width: `${(box.x1 - box.x0) * vr.w}px`,
    top: `${vr.y}px`,
  });
  scan.style.setProperty("--from", `${box.y0 * vr.h - 90}px`);
  scan.style.setProperty("--to", `${box.y1 * vr.h}px`);
  scan.classList.remove("run");
  void scan.offsetWidth;
  scan.classList.add("run");
}

// ---------- the loop ----------
// Drawing runs on every camera frame (up to 60 fps). Tracking runs in the worker at its own pace on
// the newest frame; the hero is posed from the latest smoothed result.

let fps = 0;
let lastFrameAt = performance.now();
const stats = { track: 0, render: 0 };
(window as unknown as { heroic: unknown }).heroic = { stats, tracker, stage, matte };

/** Generous region around the chosen person, so a whole-frame matte only removes them. */
function personBox(c?: Candidate) {
  if (!c) return undefined;
  const w = c.box.x1 - c.box.x0, h = c.box.y1 - c.box.y0;
  return { x0: c.box.x0 - w * 0.6, x1: c.box.x1 + w * 0.6, y0: c.box.y0 - h * 0.6, y1: 2 };
}

function draw() {
  const now = performance.now();
  fps += (1000 / Math.max(now - lastFrameAt, 1) - fps) * 0.1;
  lastFrameAt = now;
  try {
    const res = tracker.track(video, now);
    stats.track += (performance.now() - now - stats.track) * 0.1;
    lastResult = res;
    stage.empty = res.candidates.length === 0;
    if (matte.ready) {
      if (stage.vanish) matte.push(video);
      stage.setMask(res.selected >= 0 ? matte.latest : undefined, res.candidates.length > 1 ? personBox(res.candidates[res.selected]) : undefined);
    } else stage.setMask(res.selected >= 0 ? res.mask : undefined);
    drawPeople(res);
  } catch (e) {
    console.error(e);
  }
  const r0 = performance.now();
  stage.render(lastResult?.person);
  stats.render += (performance.now() - r0 - stats.render) * 0.1;
  if (live) sendFrame(now);
}

// One draw per new camera frame. requestVideoFrameCallback where the webview has it; otherwise poll.
type RVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
let lastVideoTime = -1;
function loop() {
  const v = video as RVFC;
  if (v.requestVideoFrameCallback && !document.hidden) {
    v.requestVideoFrameCallback(() => {
      draw();
      loop();
    });
    return;
  }
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    draw();
  }
  // rAF stops for hidden pages; timers keep the virtual camera fed while a call app is in front
  if (document.hidden) setTimeout(loop, 1000 / 60);
  else requestAnimationFrame(loop);
}
document.addEventListener("visibilitychange", () => document.hidden && loop());

if (import.meta.env.DEV && testSrc) {
  setInterval(() => {
    const t = tracker.timing;
    const gl = stage.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?";
    const body = `${String(gpu).slice(0, 50)} | fps ${fps.toFixed(1)} track ${stats.track.toFixed(1)}ms render ${stats.render.toFixed(1)}ms | pose ${t.pose.toFixed(1)} face ${t.face.toFixed(1)} hands ${t.hands.toFixed(1)}`;
    fetch("/__stats", { method: "POST", body }).catch(() => {});
  }, 3000);
}

// ---------- virtual camera ----------

let live = false;
let sending = false;
let lastSent = 0;
let liveSize = "";
const liveBtn = $<HTMLButtonElement>("live");

async function sendFrame(now: number) {
  if (sending || now - lastSent < 1000 / 30) return;
  const px = stage.readPixels();
  const size = `${px.width}x${px.height}`;
  sending = true;
  lastSent = now;
  try {
    if (size !== liveSize) {
      await invoke("vcam_start", { width: px.width, height: px.height, fps: 30 });
      liveSize = size;
    }
    await invoke("vcam_frame", px.data);
  } catch (e) {
    setLive(false);
    toast(String(e), 7000);
  } finally {
    sending = false;
  }
}

async function setLive(on: boolean) {
  live = on;
  liveBtn.setAttribute("aria-pressed", String(on));
  liveBtn.querySelector(".live-label")!.textContent = on ? "Live" : "Go live";
  if (!on) {
    liveSize = "";
    await invoke("vcam_stop").catch(() => {});
  } else {
    toast(
      navigator.userAgent.includes("Windows")
        ? "You're live. In Meet or Zoom, pick “OBS Virtual Camera”."
        : "You're live. In your call app, pick the Heroic loopback camera.",
    );
  }
}

liveBtn.hidden = !canLive;
liveBtn.onclick = () => setLive(!live);
$("vcam-text").innerHTML = isAndroid
  ? "On Android the preview stays in this app. Calls can't see it yet."
  : navigator.userAgent.includes("Windows")
    ? "Heroic sends its picture through the OBS virtual camera, so install <code>OBS Studio</code> once (you never need to open it). Press Go live, then choose <code>OBS Virtual Camera</code> in Meet, Zoom or Teams."
    : navigator.userAgent.includes("Linux")
      ? "Load the loopback driver once with <code>sudo modprobe v4l2loopback exclusive_caps=1 card_label=Heroic</code>, press Go live, then pick Heroic in your call app."
      : "Virtual camera output isn't available on macOS yet. The preview works.";

// ---------- settings sheet ----------

const sheet = $("settings");
const openBtn = $("open-settings");
function setSheet(open: boolean) {
  sheet.hidden = !open;
  openBtn.setAttribute("aria-expanded", String(open));
  if (open) $("close-settings").focus();
  else openBtn.focus();
}
openBtn.onclick = () => setSheet(sheet.hidden);
$("close-settings").onclick = () => setSheet(false);
addEventListener("keydown", (e) => e.key === "Escape" && !sheet.hidden && setSheet(false));

const camSel = $<HTMLSelectElement>("camera");
camSel.onchange = async () => {
  prefs.camera = camSel.value;
  save();
  try {
    await startCamera();
  } catch (e) {
    toast(cameraError(e));
  }
};

function bindToggle(id: string, key: "mirror" | "coverHead" | "vanish" | "hd", apply: (v: boolean) => void) {
  const el = $<HTMLInputElement>(id);
  el.checked = prefs[key];
  el.onchange = () => {
    prefs[key] = el.checked;
    save();
    apply(el.checked);
  };
  apply(prefs[key]);
}

function bindRange(id: string, key: "stability" | "build", fmt: (v: number) => string, apply: (v: number) => void) {
  const el = $<HTMLInputElement>(id);
  const out = $(`${id}-out`);
  el.value = String(prefs[key]);
  const update = () => {
    const v = Number(el.value);
    out.textContent = fmt(v);
    prefs[key] = v;
    apply(v);
  };
  el.oninput = update;
  el.onchange = save;
  update();
}

bindToggle("mirror", "mirror", (v) => stageEl.classList.toggle("mirrored", v));
bindToggle("cover-head", "coverHead", (v) => stage.hero && (stage.hero.opts.coverHead = v));
bindRange("stability", "stability", (v) => `${Math.round(v * 100)}%`, (v) => (tracker.stability = v));
bindRange("build", "build", (v) => `${Math.round(v * 100)}%`, (v) => stage.hero && (stage.hero.opts.build = v));

bindToggle("vanish", "vanish", (v) => {
  stage.vanish = v;
  tracker.setMask(v && !matte.ready).catch((e) => toast(`Couldn't start the person mask: ${e.message}`));
});
bindToggle("hd", "hd", () => booted && startCamera().catch((e) => toast(cameraError(e))));

const plateBtn = $<HTMLButtonElement>("plate");
plateBtn.onclick = () => {
  plateBtn.disabled = true;
  let left = 5;
  const label = $("plate-label");
  const tick = () => {
    if (left === 0) {
      stage.capturePlate();
      label.textContent = "Show it the room again";
      plateBtn.disabled = false;
      toast("Got the room. You'll vanish cleanly from the first frame now.");
      return;
    }
    label.textContent = `Step out of frame… ${left}`;
    left--;
    setTimeout(tick, 1000);
  };
  tick();
};

addEventListener("resize", () => lastResult && drawPeople(lastResult));

renderHeroes(prefs.hero);
boot();
