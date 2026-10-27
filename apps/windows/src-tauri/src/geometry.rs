//! Pure geometry for the notch window: placement on a monitor and cursor hit-testing.

pub const WIN_W_LOGICAL: f64 = 680.0;
pub const WIN_H_LOGICAL: f64 = 450.0;
/// Slack (logical px) so a cursor sampled on a timer counts as arrived slightly early.
pub const HOT_PAD_LOGICAL: f64 = 10.0;
/// Extra slack (logical px) before an already-hovered cursor counts as having left.
pub const HYSTERESIS_LOGICAL: f64 = 6.0;

/// [x, y, w, h] in physical px, relative to the window.
pub type Rect = [f64; 4];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Top-centre of the monitor's FULL rect (not the work area). Size is pinned from this monitor's scale.
pub fn placement(mon_x: i32, mon_y: i32, mon_w: u32, mon_h: u32, scale: f64) -> Placement {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let w = ((WIN_W_LOGICAL * scale).round() as u32).min(mon_w).max(1);
    let h = ((WIN_H_LOGICAL * scale).round() as u32).min(mon_h).max(1);
    Placement { x: mon_x + (mon_w as i32 - w as i32) / 2, y: mon_y, w, h }
}

pub fn contains(r: Rect, px: f64, py: f64, pad: f64) -> bool {
    px >= r[0] - pad && px < r[0] + r[2] + pad && py >= r[1] - pad && py < r[1] + r[3] + pad
}

/// Whether the cursor (window-relative physical px) counts as over the notch. Entering uses the padding,
/// leaving needs the padding plus hysteresis, so the edge does not flicker.
pub fn next_inside(hot: Option<Rect>, was_inside: bool, lx: f64, ly: f64, win: (f64, f64), scale: f64) -> bool {
    let in_window = lx >= 0.0 && ly >= 0.0 && lx < win.0 && ly < win.1;
    let Some(r) = hot else { return false };
    if !in_window {
        return false;
    }
    let pad = HOT_PAD_LOGICAL * scale + if was_inside { HYSTERESIS_LOGICAL * scale } else { 0.0 };
    contains(r, lx, ly, pad)
}

/// Poll fast only while the cursor is over the window.
pub fn poll_interval_ms(cursor_in_window: bool) -> u64 {
    if cursor_in_window {
        16
    } else {
        100
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centres_on_the_full_rect_at_the_top() {
        let p = placement(0, 0, 1920, 1080, 1.0);
        assert_eq!(p, Placement { x: 620, y: 0, w: 680, h: 450 });
    }

    #[test]
    fn scales_and_honours_monitor_origin() {
        let p = placement(-2560, 100, 2560, 1440, 1.5);
        assert_eq!((p.w, p.h), (1020, 675));
        assert_eq!(p.x, -2560 + (2560 - 1020) / 2);
        assert_eq!(p.y, 100);
    }

    #[test]
    fn never_exceeds_the_monitor_and_survives_bad_scale() {
        let p = placement(0, 0, 400, 300, 1.0);
        assert_eq!((p.w, p.h), (400, 300));
        assert_eq!(placement(0, 0, 1920, 1080, f64::NAN).w, 680);
    }

    #[test]
    fn hit_test_pads_and_has_hysteresis() {
        let hot = Some([247.0, 0.0, 185.0, 32.0]);
        let win = (680.0, 450.0);
        // 8px left of the notch: inside the 10px entry pad
        assert!(next_inside(hot, false, 239.0, 10.0, win, 1.0));
        // 13px left: outside entry pad, but a hovered cursor survives (10 + 6)
        assert!(!next_inside(hot, false, 234.0, 10.0, win, 1.0));
        assert!(next_inside(hot, true, 234.0, 10.0, win, 1.0));
        // far away: gone either way
        assert!(!next_inside(hot, true, 100.0, 10.0, win, 1.0));
    }

    #[test]
    fn no_hot_rect_or_outside_window_is_click_through() {
        assert!(!next_inside(None, true, 300.0, 5.0, (680.0, 450.0), 1.0));
        assert!(!next_inside(Some([0.0, 0.0, 680.0, 450.0]), true, 700.0, 5.0, (680.0, 450.0), 1.0));
    }

    #[test]
    fn pad_scales_with_dpi() {
        let hot = Some([300.0, 0.0, 278.0, 48.0]);
        // 15 physical px left at 1.5x = 10 logical px: inside
        assert!(next_inside(hot, false, 285.0, 5.0, (1020.0, 675.0), 1.5));
        assert!(!next_inside(hot, false, 284.0, 5.0, (1020.0, 675.0), 1.5));
    }

    #[test]
    fn poll_rates() {
        assert_eq!(poll_interval_ms(true), 16);
        assert_eq!(poll_interval_ms(false), 100);
    }
}
