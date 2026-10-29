# Heroic

Put on a superhero in your webcam. Heroic tracks your body, hands and face, fits a rigged 3D hero over you, paints you out of the picture wherever the suit doesn't cover you, and sends the result to Meet, Zoom or Teams as a camera.

Heroes included: **Hulk**, **Infinity Ultron**, **Ultron Prime**. You can load your own rigged `.glb` from the hero rail.

## Using it

1. Open Heroic and let it use your camera.
2. Pick a hero from the rail at the bottom. If more than one person is in frame, tap the one who should wear it.
3. Press **Go live**, then choose the virtual camera in your call app.

Audio isn't touched. Only the video changes.

### Virtual camera, per platform

| Platform | What you need | Camera name in call apps |
| --- | --- | --- |
| Windows | [OBS Studio](https://obsproject.com) installed once (you never need to open it) | OBS Virtual Camera |
| Linux | `sudo modprobe v4l2loopback exclusive_caps=1 card_label=Heroic` | Heroic |
| macOS | Not yet. The preview works; sending to calls needs a CoreMediaIO extension. | |
| Android | Preview only for now. | |

Close OBS's own virtual camera before going live; only one app can feed it at a time.

On Android, grab `heroic-android.apk` from the [android-nightly release](https://github.com/a3ro-dev/heroic/releases/tag/android-nightly) once. After that the app checks for a newer build each time it opens (Settings → Updates) and asks before installing.

## Settings worth knowing

- **Vanish behind the hero** (on by default). Heroic learns what your room looks like as you move and uses it to paint you out around the suit. If you want it clean from the first second, use **Show it the empty room** and step out of frame for five seconds.
- **Cover my head** grows a hero head that's smaller than yours, so your real head never pokes out around it.
- **Steadiness** trades responsiveness for calm. Higher is steadier.
- **Suit size** scales the hero against your shoulders.

## How it works

- **Tracking**: MediaPipe pose, face and hand landmarkers on the GPU (WebGL), spread across frames so no frame carries the whole load. One Euro filters keep a still person still without making fast moves lag.
- **Fitting**: every bone is rotated by how far it should move from its *own* rest pose, so T-pose, A-pose, 3ds Max Biped, XPS, Rigify/CloudRig and Mixamo rigs all retarget without per-model tuning. The body's position comes from a least-squares solve of the 3D landmarks against where the camera sees them; the head and jaw follow the face mesh and its blendshapes.
- **Vanishing**: a background plate learns itself on the GPU from pixels the person isn't covering, holes it has never seen are filled with a push-pull mip pyramid, and the dilated person mask swaps you for it.
- **Shell**: Tauri 2 (Rust). The Rust side converts frames to NV12 and writes them into the OBS virtual camera's shared-memory queue on Windows, or a v4l2loopback device on Linux.

## Building

```bash
npm ci
npm run tauri dev
```

Installers for Windows (MSI and NSIS), Linux (deb, rpm, AppImage), macOS (dmg) and Android (APK) are built by GitHub Actions on every push. Tag a `v*` release to publish them.

### Rebuilding the heroes

The `.glb` files in `public/heroes` come from the source `.blend` files, which aren't in the repo. To rebuild them, put the `.blend` files and their unzipped `textures/` folder in one directory and run:

```bash
BLENDER=/path/to/blender HERO_SRC=/path/to/that/folder npm run heroes
```

`tools/export_hero.py` reduces control rigs to their deform bones, rebuilds custom shaders as plain PBR so glTF picks the right maps, and relinks textures that point at someone else's drive. `gltf-transform` then shrinks the textures to 2K WebP and compresses the meshes.

## Known limits

- Tracking runs at roughly 25 to 30 fps on a laptop RTX 4050, because WebGL inference spends most of its time in small dispatches and sync points. Native inference (ONNX Runtime with DirectML, or the NPU) would be the way to a steady 60.
- The painted-out area is soft until you've moved a little, unless you show it the empty room first.
- Capes and long coats hang straight down in front of a desk.

The hero models are purchased assets and are for personal use only. Don't redistribute them.
