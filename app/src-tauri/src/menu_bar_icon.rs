/// A transparent, monochrome version of FlowHub's F-and-dot mark.
/// macOS template images use alpha as a mask, so the application icon's
/// opaque rounded background must not be included here.
pub(crate) fn image() -> tauri::image::Image<'static> {
    const SIZE: usize = 36; // 18 pt at Retina resolution.
    const SAMPLES: usize = 4;
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut covered = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = (x as f64 + (sx as f64 + 0.5) / SAMPLES as f64) / 2.0;
                    let py = (y as f64 + (sy as f64 + 0.5) / SAMPLES as f64) / 2.0;
                    let stem = (3.5..6.5).contains(&px) && (2.0..16.0).contains(&py);
                    let top = (3.5..14.5).contains(&px) && (2.0..5.0).contains(&py);
                    let middle = (3.5..12.5).contains(&px) && (7.5..10.5).contains(&py);
                    let dot = (px - 14.5).powi(2) + (py - 14.5).powi(2) <= 1.5_f64.powi(2);
                    if stem || top || middle || dot {
                        covered += 1;
                    }
                }
            }
            rgba[(y * SIZE + x) * 4 + 3] = (covered * 255 / (SAMPLES * SAMPLES)) as u8;
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}
