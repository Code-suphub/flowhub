//! Keep pointer selection, screen geometry, and panel placement in AppKit points.
use objc2::MainThreadMarker;
use serde_json::{json, Value};
use objc2_app_kit::{NSEvent, NSPanel, NSScreen};
use objc2_foundation::{NSPoint, NSRect, NSSize};

fn screen_at_pointer(frames: &[NSRect], pointer: NSPoint) -> Option<usize> {
    frames.iter().position(|frame| {
        pointer.x >= frame.origin.x && pointer.x < frame.origin.x + frame.size.width
            && pointer.y >= frame.origin.y && pointer.y < frame.origin.y + frame.size.height
    })
}

fn centered_origin(bounds: NSRect, size: NSSize) -> NSPoint {
    NSPoint::new(
        bounds.origin.x + ((bounds.size.width - size.width) / 2.0).max(0.0),
        bounds.origin.y + ((bounds.size.height - size.height) / 2.0).max(0.0),
    )
}

fn rect_json(rect: NSRect) -> Value {
    json!({"x": rect.origin.x, "y": rect.origin.y, "width": rect.size.width, "height": rect.size.height})
}

pub(super) fn position_at_pointer(panel: &NSPanel, mtm: MainThreadMarker) -> Value {
    let pointer = NSEvent::mouseLocation();
    let screens = NSScreen::screens(mtm);
    let frames: Vec<_> = screens.iter().map(|screen| screen.frame()).collect();
    let index = screen_at_pointer(&frames, pointer);
    let screen = index.map(|index| screens.objectAtIndex(index))
        .or_else(|| panel.screen())
        .or_else(|| screens.firstObject());
    let Some(screen) = screen else {
        eprintln!("[flowhub-tauri] launcher-position: no screens available");
        return json!({"status": "no-screens", "screenCount": 0});
    };
    let before = panel.frame();
    let bounds = screen.visibleFrame();
    let origin = centered_origin(bounds, before.size);
    panel.setFrameOrigin(origin);
    eprintln!(
        "[flowhub-tauri] launcher-position pointer={pointer:?} screenIndex={index:?} screen={:?} visible={bounds:?} scale={} before={before:?} after={:?}",
        screen.frame(), screen.backingScaleFactor(), panel.frame()
    );
    json!({
        "status": "positioned",
        "coordinateSystem": "appkit-points",
        "pointer": {"x": pointer.x, "y": pointer.y},
        "screenCount": frames.len(),
        "pointerScreenIndex": index,
        "selection": if index.is_some() { "pointer" } else { "fallback" },
        "screens": frames.into_iter().map(rect_json).collect::<Vec<_>>(),
        "target": rect_json(screen.frame()),
        "visibleFrame": rect_json(bounds),
        "scale": screen.backingScaleFactor(),
        "before": rect_json(before),
        "after": rect_json(panel.frame())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }
    #[test]
    fn selects_pointer_screen_with_negative_and_vertical_origins() {
        let frames = [rect(0., 0., 1440., 900.), rect(-1920., 0., 1920., 1080.), rect(0., 900., 2560., 1440.)];
        assert_eq!(screen_at_pointer(&frames, NSPoint::new(-500., 400.)), Some(1));
        assert_eq!(screen_at_pointer(&frames, NSPoint::new(500., 1200.)), Some(2));
        assert_eq!(screen_at_pointer(&frames, NSPoint::new(0., 500.)), Some(0));
        assert_eq!(screen_at_pointer(&frames, NSPoint::new(-3000., 500.)), None);
    }
    #[test]
    fn centers_in_visible_points_without_mixing_display_scales() {
        assert_eq!(centered_origin(rect(-1920., 40., 1920., 1016.), NSSize::new(620., 520.)), NSPoint::new(-1270., 288.));
        assert_eq!(centered_origin(rect(0., 900., 1440., 876.), NSSize::new(620., 520.)), NSPoint::new(410., 1078.));
        assert_eq!(centered_origin(rect(100., 200., 400., 300.), NSSize::new(620., 520.)), NSPoint::new(100., 200.));
    }
}
