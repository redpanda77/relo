//! Pure geometry for incoming drags: where the drag region is (DragDetector's `notchRegion`) and which part of
//! the shelf a point is over (the share tile or the shelf panel). All rects are [x, y, w, h] in physical px,
//! relative to the notch window.

use serde::Serialize;

pub type Rect = [f64; 4];

/// The open notch's width and minimum height in logical px (geometry.ts OPEN_BASE) and the window's width.
pub const OPEN_W: f64 = 640.0;
pub const OPEN_H: f64 = 220.0;
pub const WINDOW_W: f64 = 680.0;
/// Slack around the closed notch, logical px (the pointer loop uses the same).
pub const PAD: f64 = 10.0;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Zone {
    /// Dropping adds to the shelf.
    Shelf,
    /// Dropping shares through the Windows share sheet.
    Share,
}

/// Where a drag must be for the notch to react. Without expanded detection it is the notch itself (the hot rect:
/// the closed pill, or the open panel); with it, the whole area an open notch would take, so the notch opens
/// before the file reaches it (the Mac's `expandedDragDetection`).
pub fn drag_region(hot: Option<Rect>, expanded: bool, scale: f64) -> Option<Rect> {
    let pad = PAD * scale;
    let hot = hot.map(|r| [r[0] - pad, r[1] - pad, r[2] + 2.0 * pad, r[3] + 2.0 * pad]);
    if !expanded {
        return hot;
    }
    let x = (WINDOW_W - OPEN_W) / 2.0 * scale;
    let open = [x, 0.0, OPEN_W * scale, OPEN_H * scale];
    Some(match hot {
        None => open,
        Some(h) => {
            let (x0, y0) = (h[0].min(open[0]), h[1].min(open[1]));
            let (x1, y1) = ((h[0] + h[2]).max(open[0] + open[2]), (h[1] + h[3]).max(open[1] + open[3]));
            [x0, y0, x1 - x0, y1 - y0]
        }
    })
}

pub fn contains(r: Rect, x: f64, y: f64) -> bool {
    x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
}

pub fn zone_at(share: Option<Rect>, x: f64, y: f64) -> Zone {
    match share {
        Some(r) if contains(r, x, y) => Zone::Share,
        _ => Zone::Shelf,
    }
}

/// Whether a button-down drag has moved far enough from where it started to be a drag (physical px).
pub fn moved_enough(from: (i32, i32), to: (i32, i32), threshold: i32) -> bool {
    (to.0 - from.0).abs().max((to.1 - from.1).abs()) > threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_expanded_detection_the_region_is_the_padded_notch() {
        let r = drag_region(Some([247.0, 0.0, 185.0, 32.0]), false, 1.0).unwrap();
        assert_eq!(r, [237.0, -10.0, 205.0, 52.0]);
        assert_eq!(drag_region(None, false, 1.0), None);
    }

    #[test]
    fn expanded_detection_covers_the_open_notch_area() {
        let r = drag_region(Some([247.0, 0.0, 185.0, 32.0]), true, 1.0).unwrap();
        assert!(contains(r, 100.0, 200.0), "inside where the open notch would be");
        assert!(contains(r, 340.0, 5.0));
        assert!(!contains(r, 5.0, 100.0), "left of the open notch");
        assert!(!contains(r, 340.0, 300.0), "below it");
        // known even before the page reports its hot rect
        assert!(drag_region(None, true, 1.0).is_some());
    }

    #[test]
    fn region_scales_with_dpi() {
        let r = drag_region(None, true, 1.5).unwrap();
        assert_eq!(r, [30.0, 0.0, 960.0, 330.0]);
    }

    #[test]
    fn the_open_notch_stays_inside_the_region_when_taller() {
        // a 430 px tall open notch (hot rect) is not cut off by the 220 px minimum
        let r = drag_region(Some([20.0, 0.0, 640.0, 430.0]), true, 1.0).unwrap();
        assert!(contains(r, 340.0, 420.0));
    }

    #[test]
    fn zones() {
        let share = Some([40.0, 40.0, 100.0, 100.0]);
        assert_eq!(zone_at(share, 50.0, 50.0), Zone::Share);
        assert_eq!(zone_at(share, 150.0, 50.0), Zone::Shelf);
        assert_eq!(zone_at(None, 50.0, 50.0), Zone::Shelf);
    }

    #[test]
    fn a_click_is_not_a_drag() {
        assert!(!moved_enough((10, 10), (12, 11), 4));
        assert!(moved_enough((10, 10), (10, 16), 4));
    }
}
