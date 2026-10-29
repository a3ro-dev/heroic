mod vcam;

use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::State;

#[derive(Default)]
struct Cam {
    sink: Option<(vcam::Sink, u32, u32)>,
    nv12: Vec<u8>,
}

#[tauri::command]
fn vcam_start(cam: State<'_, Mutex<Cam>>, width: u32, height: u32, fps: u32) -> Result<(), String> {
    let mut cam = cam.lock().unwrap();
    cam.sink = None; // close the old queue before opening a new one with the same name
    cam.sink = Some((vcam::Sink::open(width, height, fps)?, width, height));
    Ok(())
}

#[tauri::command]
fn vcam_stop(cam: State<'_, Mutex<Cam>>) {
    cam.lock().unwrap().sink = None;
}

/// Body: raw bottom-up RGBA bytes of the size given to `vcam_start`.
#[tauri::command]
fn vcam_frame(cam: State<'_, Mutex<Cam>>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("expected a raw RGBA body".into());
    };
    let cam = &mut *cam.lock().unwrap();
    let Some((sink, w, h)) = cam.sink.as_mut() else { return Ok(()) };
    let (w, h) = (*w as usize, *h as usize);
    if rgba.len() != w * h * 4 {
        return Err(format!("frame is {} bytes, expected {}", rgba.len(), w * h * 4));
    }
    vcam::rgba_to_nv12(rgba, w, h, &mut cam.nv12);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
    sink.write(&cam.nv12, ts);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Cam::default()))
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                // WebKitGTK ships with getUserMedia off and no permission UI.
                w.with_webview(|wv| {
                    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                    let wv = wv.inner();
                    if let Some(s) = WebViewExt::settings(&wv) {
                        s.set_enable_media_stream(true);
                        s.set_enable_webgl(true);
                    }
                    wv.connect_permission_request(|_, req| {
                        req.allow();
                        true
                    });
                })?;
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![vcam_start, vcam_stop, vcam_frame])
        .run(tauri::generate_context!())
        .expect("error while running Heroic");
}
