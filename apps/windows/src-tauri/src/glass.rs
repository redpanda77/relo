//! Desktop blur behind the Home and Settings windows (Mac: ReloGlass.swift, an `NSVisualEffectView` of material `hudWindow`
//! with the tint rgb(.03, .035, .07) at .6 over it).
//!
//! Windows: Acrylic (blur-behind plus the same tint) through tauri's window effects, which wrap the `window-vibrancy` crate;
//! Mica when Acrylic is refused. The webview is made transparent so the effect shows through wherever the page paints
//! `transparent` (the glass tint CSS belongs to the page); a page that paints an opaque background looks as before.
//! The notch window is not touched: the Mac draws no blur behind the notch either (its glass lives inside the SwiftUI views).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

/// ReloGlass tint, rgb(.03, .035, .07) at .6, as 8-bit RGBA.
pub const TINT: (u8, u8, u8, u8) = (8, 9, 18, 153);

const WINDOWS: [&str; 2] = ["home", "settings"];

static ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
fn to_u8(v: f64) -> u8 {
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Whether a backdrop effect was applied to the Home and Settings windows (the page reads it to switch its tint on).
#[tauri::command]
pub fn glass_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Call once from setup.
pub fn init(app: &AppHandle) {
    use tauri::window::{Color, Effect, EffectsBuilder};
    let mut any = false;
    for label in WINDOWS {
        let Some(w) = app.get_webview_window(label) else { continue };
        let _ = w.set_background_color(Some(Color(0, 0, 0, 0)));
        let acrylic = EffectsBuilder::new().effect(Effect::Acrylic).color(Color(TINT.0, TINT.1, TINT.2, TINT.3)).build();
        let ok = w.set_effects(acrylic).is_ok() || w.set_effects(EffectsBuilder::new().effect(Effect::Mica).build()).is_ok();
        if !ok {
            eprintln!("relo: no backdrop effect for the {label} window; it stays opaque");
            let _ = w.set_background_color(None);
        }
        any |= ok;
    }
    ACTIVE.store(any, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tint_is_the_macs_glass_tint() {
        assert_eq!((to_u8(0.03), to_u8(0.035), to_u8(0.07), to_u8(0.6)), TINT);
    }
}
