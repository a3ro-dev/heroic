//! Virtual camera output. The webview sends rendered RGBA frames; we convert them to
//! NV12 and hand them to the platform's virtual camera sink.
//! - Windows: the OBS Virtual Camera shared-memory queue (OBS Studio must be installed;
//!   meeting apps then list "OBS Virtual Camera").
//! - Linux: a v4l2loopback device (`sudo modprobe v4l2loopback exclusive_caps=1`).
//! - macOS: not yet; needs a CoreMediaIO camera extension.

/// Converts bottom-up RGBA (what WebGL readPixels returns) into top-down NV12, BT.601 limited range.
pub fn rgba_to_nv12(rgba: &[u8], w: usize, h: usize, out: &mut Vec<u8>) {
    out.resize(w * h * 3 / 2, 0);
    let (y_plane, uv_plane) = out.split_at_mut(w * h);
    for y in 0..h {
        let src = &rgba[(h - 1 - y) * w * 4..][..w * 4];
        let dst = &mut y_plane[y * w..][..w];
        for x in 0..w {
            let (r, g, b) = (src[x * 4] as i32, src[x * 4 + 1] as i32, src[x * 4 + 2] as i32);
            dst[x] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8;
        }
    }
    for y in (0..h).step_by(2) {
        let src = &rgba[(h - 1 - y) * w * 4..][..w * 4];
        let dst = &mut uv_plane[y / 2 * w..][..w];
        for x in (0..w).step_by(2) {
            let (r, g, b) = (src[x * 4] as i32, src[x * 4 + 1] as i32, src[x * 4 + 2] as i32);
            dst[x] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
            dst[x + 1] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
        }
    }
}

#[cfg(windows)]
pub use win::Sink;

#[cfg(windows)]
mod win {
    use std::ptr::null;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
        PAGE_READWRITE, UnmapViewOfFile,
    };

    // Mirrors `struct queue_header` in obs-studio/plugins/win-dshow/shared-memory-queue.c.
    #[repr(C)]
    struct Header {
        write_idx: AtomicU32,
        read_idx: AtomicU32,
        state: AtomicU32,
        offsets: [u32; 3],
        kind: u32,
        cx: u32,
        cy: u32,
        interval: u64,
        reserved: [u32; 8],
    }
    const STATE_STARTING: u32 = 1;
    const STATE_READY: u32 = 2;
    const STATE_STOPPING: u32 = 3;
    const FRAME_HEADER: usize = 32;

    fn align32(n: usize) -> usize {
        (n + 31) & !31
    }

    pub struct Sink {
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
        frame_size: usize,
    }
    unsafe impl Send for Sink {}

    impl Sink {
        pub fn open(w: u32, h: u32, fps: u32) -> Result<Self, String> {
            let frame_size = (w * h * 3 / 2) as usize;
            let mut offsets = [0u32; 3];
            let mut size = align32(size_of::<Header>());
            for o in &mut offsets {
                *o = size as u32;
                size = align32(size + frame_size + FRAME_HEADER);
            }
            let name: Vec<u16> = "OBSVirtualCamVideo\0".encode_utf16().collect();
            unsafe {
                let handle = CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    null(),
                    PAGE_READWRITE,
                    0,
                    size as u32,
                    name.as_ptr(),
                );
                if handle.is_null() {
                    return Err("Couldn't create the OBS virtual camera queue. Is OBS's own virtual camera running?".into());
                }
                let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0);
                if view.Value.is_null() {
                    CloseHandle(handle);
                    return Err("Couldn't map the OBS virtual camera queue.".into());
                }
                view.Value.cast::<Header>().write(Header {
                    write_idx: AtomicU32::new(0),
                    read_idx: AtomicU32::new(0),
                    state: AtomicU32::new(STATE_STARTING),
                    offsets,
                    kind: 0,
                    cx: w,
                    cy: h,
                    interval: 10_000_000 / fps.max(1) as u64,
                    reserved: [0; 8],
                });
                Ok(Sink { handle, view, frame_size })
            }
        }

        pub fn write(&mut self, nv12: &[u8], timestamp_ns: u64) {
            unsafe {
                let base = self.view.Value.cast::<u8>();
                let hdr = &*base.cast::<Header>();
                let inc = hdr.write_idx.fetch_add(1, Ordering::SeqCst) + 1;
                let off = hdr.offsets[(inc % 3) as usize] as usize;
                base.add(off).cast::<u64>().write_unaligned(timestamp_ns);
                let n = nv12.len().min(self.frame_size);
                std::ptr::copy_nonoverlapping(nv12.as_ptr(), base.add(off + FRAME_HEADER), n);
                hdr.read_idx.store(inc, Ordering::SeqCst);
                hdr.state.store(STATE_READY, Ordering::SeqCst);
            }
        }
    }

    impl Drop for Sink {
        fn drop(&mut self) {
            unsafe {
                (*self.view.Value.cast::<Header>()).state.store(STATE_STOPPING, Ordering::SeqCst);
                UnmapViewOfFile(self.view);
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::Sink;

#[cfg(target_os = "linux")]
mod linux {
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::os::fd::AsRawFd;

    #[repr(C)]
    struct PixFormat {
        width: u32,
        height: u32,
        pixelformat: u32,
        field: u32,
        bytesperline: u32,
        sizeimage: u32,
        colorspace: u32,
        private: u32,
        flags: u32,
        ycbcr_enc: u32,
        quantization: u32,
        xfer_func: u32,
    }
    // struct v4l2_format: u32 type + 8-aligned 200-byte union.
    #[repr(C)]
    struct Format {
        kind: u32,
        _pad: u32,
        pix: PixFormat,
        _rest: [u8; 200 - size_of::<PixFormat>()],
    }
    const VIDIOC_S_FMT: libc::c_ulong = 0xC0D0_5605;
    const BUF_TYPE_VIDEO_OUTPUT: u32 = 2;
    const FIELD_NONE: u32 = 1;
    const COLORSPACE_SMPTE170M: u32 = 1;

    pub struct Sink {
        dev: File,
    }

    fn find_loopback() -> Option<String> {
        let mut entries: Vec<_> = std::fs::read_dir("/sys/class/video4linux").ok()?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        entries.into_iter().find_map(|e| {
            let name = std::fs::read_to_string(e.path().join("name")).unwrap_or_default().to_lowercase();
            (name.contains("loopback") || name.contains("dummy") || name.contains("virtual"))
                .then(|| format!("/dev/{}", e.file_name().to_string_lossy()))
        })
    }

    impl Sink {
        pub fn open(w: u32, h: u32, _fps: u32) -> Result<Self, String> {
            let path = find_loopback().ok_or(
                "No v4l2loopback device found. Run: sudo modprobe v4l2loopback exclusive_caps=1 card_label=Heroic",
            )?;
            let dev = OpenOptions::new().write(true).open(&path).map_err(|e| format!("{path}: {e}"))?;
            let mut fmt = Format {
                kind: BUF_TYPE_VIDEO_OUTPUT,
                _pad: 0,
                pix: PixFormat {
                    width: w,
                    height: h,
                    pixelformat: u32::from_le_bytes(*b"NV12"),
                    field: FIELD_NONE,
                    bytesperline: w,
                    sizeimage: w * h * 3 / 2,
                    colorspace: COLORSPACE_SMPTE170M,
                    private: 0,
                    flags: 0,
                    ycbcr_enc: 0,
                    quantization: 0,
                    xfer_func: 0,
                },
                _rest: [0; 200 - size_of::<PixFormat>()],
            };
            if unsafe { libc::ioctl(dev.as_raw_fd(), VIDIOC_S_FMT as _, &mut fmt) } < 0 {
                return Err(format!("{path}: setting the format failed: {}", std::io::Error::last_os_error()));
            }
            Ok(Sink { dev })
        }

        pub fn write(&mut self, nv12: &[u8], _timestamp_ns: u64) {
            let _ = self.dev.write_all(nv12);
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub struct Sink;

#[cfg(not(any(windows, target_os = "linux")))]
impl Sink {
    pub fn open(_w: u32, _h: u32, _fps: u32) -> Result<Self, String> {
        Err("Virtual camera output isn't available on this platform yet.".into())
    }
    pub fn write(&mut self, _nv12: &[u8], _timestamp_ns: u64) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_and_black_map_to_studio_range_and_flip_rows() {
        // 2x2 image, bottom row (first in buffer) white, top row black.
        let rgba = [255u8, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255];
        let mut out = Vec::new();
        rgba_to_nv12(&rgba, 2, 2, &mut out);
        assert_eq!(&out[..4], &[16, 16, 235, 235]);
        assert_eq!(&out[4..], &[128, 128]);
    }
}
