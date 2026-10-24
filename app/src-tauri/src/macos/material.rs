//! Native, behind-window glass. CSS supplies only tint and edge highlights;
//! NSVisualEffectView samples the desktop and honors Reduce transparency.
use tauri::WebviewWindow;
use window_vibrancy::{clear_vibrancy, apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[derive(Clone, Copy)]
pub(crate) enum Surface { Launcher, Settings, Menu, Compact, Dock, PluginPanel }

impl Surface {
    fn appearance(self) -> (NSVisualEffectMaterial, NSVisualEffectState, f64) {
        match self {
            Self::Launcher => (NSVisualEffectMaterial::HudWindow, NSVisualEffectState::Active, 20.0),
            Self::Settings => (NSVisualEffectMaterial::Sidebar, NSVisualEffectState::FollowsWindowActiveState, 0.0),
            Self::Menu => (NSVisualEffectMaterial::Popover, NSVisualEffectState::Active, 18.0),
            Self::Compact => (NSVisualEffectMaterial::HudWindow, NSVisualEffectState::Active, 18.0),
            Self::Dock => (NSVisualEffectMaterial::HudWindow, NSVisualEffectState::Active, 30.0),
            Self::PluginPanel => (NSVisualEffectMaterial::Popover, NSVisualEffectState::Active, 24.0),
        }
    }
}

/// Run synchronously on AppKit's thread so compact transitions and rollback
/// restore the material together with the geometry, before publishing mode.
pub(crate) fn set(window: &WebviewWindow, surface: Option<Surface>) -> Result<(), String> {
    let native = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        // clear_vibrancy is idempotent. In particular, returning to the full
        // canvas must remove the compact view instead of frosting its desktop.
        let result = clear_vibrancy(&native).and_then(|_| {
            if let Some(surface) = surface {
                let (material, state, radius) = surface.appearance();
                apply_vibrancy(&native, material, Some(state), Some(radius))
            } else { Ok(()) }
        }).map_err(|error| error.to_string());
        let _ = tx.send(result);
    }).map_err(|error| error.to_string())?;
    rx.recv().map_err(|_| "原生窗口材质更新中断".to_string())?
}

pub(crate) fn page_ready(window: &WebviewWindow) {
    let result = match window.label() {
        "main" => set(window, Some(Surface::Launcher)),
        "settings" => set(window, Some(Surface::Settings)),
        "plugin-dock" => set(window, Some(Surface::Dock)),
        "plugin-panel" => set(window, Some(Surface::PluginPanel)),
        "menu-bar-panel" => set(window, Some(Surface::Menu)),
        "plugin-canvas" => crate::plugin::canvas::sync_window_material(window),
        _ => return,
    };
    if let Err(error) = &result { eprintln!("[flowhub-tauri] 原生窗口材质：{error}"); }
    // Only expose translucent CSS after the native layer has been installed.
    // Other platforms and failed native effects retain solid, readable panes.
    let available = if result.is_ok() { "true" } else { "false" };
    let _ = window.eval(format!("document.documentElement.dataset.nativeWindow = 'macos'; document.documentElement.dataset.nativeGlass = '{available}';"));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn floating_surfaces_stay_active_while_settings_follow_window_focus() {
        for surface in [Surface::Launcher, Surface::Menu, Surface::Compact] {
            let (_, state, radius) = surface.appearance();
            assert!(matches!(state, NSVisualEffectState::Active));
            assert!(radius >= 18.0);
        }
        assert!(matches!(Surface::Settings.appearance().1, NSVisualEffectState::FollowsWindowActiveState));
    }
}
