//! Thermal state for the System tab's "Warm" / "Hot" / "Too hot" chip (Mac: `ProcessInfo.thermalState`).
//!
//! Windows has no thermal state API. The closest signal that needs no driver and no admin rights is the performance counter
//! `\Thermal Zone Information(*)\% Passive Limit`: the share of full speed the OS lets the processor run at because of
//! thermal passive cooling (100 = not throttled). The lowest zone decides. A PC that exposes no thermal zone (many desktops
//! and virtual machines) reads "nominal", which hides the chip, as on a cool Mac.

/// Maps the lowest passive limit (percent of full speed) to the Mac's four states.
pub fn state_for_passive_limit(min_percent: f64) -> &'static str {
    if !min_percent.is_finite() || min_percent >= 100.0 {
        "nominal"
    } else if min_percent >= 80.0 {
        "fair"
    } else if min_percent >= 50.0 {
        "serious"
    } else {
        "critical"
    }
}

/// The lowest value of a set of readings, if any.
pub fn lowest(values: &[f64]) -> Option<f64> {
    values.iter().copied().filter(|v| v.is_finite()).fold(None, |m, v| Some(m.map_or(v, |m: f64| m.min(v))))
}

#[cfg(windows)]
pub fn read() -> &'static str {
    match passive_limits() {
        Some(v) => lowest(&v).map(state_for_passive_limit).unwrap_or("nominal"),
        None => "nominal",
    }
}

#[cfg(not(windows))]
pub fn read() -> &'static str {
    "nominal"
}

/// Every thermal zone's `% Passive Limit`, or None when the counter does not exist on this PC.
#[cfg(windows)]
pub fn passive_limits() -> Option<Vec<f64>> {
    use windows::core::w;
    use windows::Win32::System::Performance::*;
    unsafe {
        let mut query = PDH_HQUERY::default();
        if PdhOpenQueryW(None, 0, &mut query) != 0 {
            return None;
        }
        let out = (|| {
            let mut counter = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(query, w!(r"\Thermal Zone Information(*)\% Passive Limit"), 0, &mut counter) != 0 {
                return None;
            }
            if PdhCollectQueryData(query) != 0 {
                return None;
            }
            let (mut size, mut count) = (0u32, 0u32);
            // PDH_MORE_DATA reports the buffer size; anything else means there is nothing to read.
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                return None;
            }
            let values: Vec<f64> = (0..count as usize)
                .filter_map(|i| {
                    let item = &*items.add(i);
                    (item.FmtValue.CStatus == 0).then(|| item.FmtValue.Anonymous.doubleValue)
                })
                .collect();
            (!values.is_empty()).then_some(values)
        })();
        let _ = PdhCloseQuery(query);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_limit_maps_to_the_macs_states() {
        assert_eq!(state_for_passive_limit(100.0), "nominal");
        assert_eq!(state_for_passive_limit(f64::NAN), "nominal");
        assert_eq!(state_for_passive_limit(99.0), "fair");
        assert_eq!(state_for_passive_limit(80.0), "fair");
        assert_eq!(state_for_passive_limit(79.0), "serious");
        assert_eq!(state_for_passive_limit(50.0), "serious");
        assert_eq!(state_for_passive_limit(49.0), "critical");
        assert_eq!(state_for_passive_limit(0.0), "critical");
    }

    #[test]
    fn the_lowest_zone_decides() {
        assert_eq!(lowest(&[100.0, 70.0, 90.0]), Some(70.0));
        assert_eq!(lowest(&[f64::NAN, 95.0]), Some(95.0));
        assert_eq!(lowest(&[]), None);
    }

    #[test]
    fn reading_never_panics_and_is_a_known_state() {
        assert!(["nominal", "fair", "serious", "critical"].contains(&read()));
    }
}
