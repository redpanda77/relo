//! The System tab's pure arithmetic (no OS calls), so it is unit-tested: rates, averages, which drive and which
//! network interfaces count. Mirrors SystemMonitor.swift (apps/notch/boringNotch/components/System).

use std::time::Duration;

/// Per-core loads (0..1) and their mean, which is the CPU ring.
pub fn overall(cores: &[f64]) -> f64 {
    if cores.is_empty() {
        0.0
    } else {
        cores.iter().sum::<f64>() / cores.len() as f64
    }
}

/// `sysinfo` reports 0..100; the tab draws 0..1.
pub fn unit(percent: f32) -> f64 {
    (percent as f64 / 100.0).clamp(0.0, 1.0)
}

/// Bytes per second between two cumulative counters. The interval has a 0.5 s floor (as on the Mac) so two
/// close samples do not spike, and a counter that went backwards (interface reset) wraps like the Mac's `&-`.
pub fn rate(now: u64, before: u64, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64().max(0.5);
    now.wrapping_sub(before) as f64 / seconds
}

/// Physical links only: the Mac counts `en*` and `pdp_ip*`, not loopback or virtual interfaces.
pub fn is_physical(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const VIRTUAL: [&str; 12] = [
        "loopback", "vethernet", "vmware", "virtualbox", "vbox", "hyper-v", "isatap", "teredo", "wsl", "pseudo", "tunnel", "bluetooth",
    ];
    !n.is_empty() && !VIRTUAL.iter().any(|v| n.contains(v))
}

/// The volume the tab reports: the system drive (the Mac reads "/"), else the biggest one.
/// Each entry is (mount point, total, available). Returns (free, total).
pub fn pick_storage(system_drive: &str, drives: &[(String, u64, u64)]) -> Option<(u64, u64)> {
    let want = system_drive.trim_end_matches(['\\', '/']).to_ascii_uppercase();
    let found = drives.iter().find(|(m, t, _)| *t > 0 && m.trim_end_matches(['\\', '/']).to_ascii_uppercase() == want);
    let best = found.or_else(|| drives.iter().filter(|(_, t, _)| *t > 0).max_by_key(|(_, t, _)| *t));
    best.map(|(_, total, free)| ((*free).min(*total), *total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_is_the_mean_of_the_cores() {
        assert_eq!(overall(&[]), 0.0);
        assert!((overall(&[0.2, 0.4, 0.6, 0.8]) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn unit_clamps() {
        assert_eq!(unit(150.0), 1.0);
        assert_eq!(unit(-3.0), 0.0);
        assert!((unit(42.0) - 0.42).abs() < 1e-6);
    }

    #[test]
    fn rate_has_a_half_second_floor_and_wraps() {
        assert_eq!(rate(3000, 1000, Duration::from_secs(2)), 1000.0);
        assert_eq!(rate(1500, 1000, Duration::from_millis(100)), 1000.0);
        assert!(rate(10, u64::MAX - 9, Duration::from_secs(1)) < 100.0);
    }

    #[test]
    fn only_physical_interfaces_count() {
        assert!(is_physical("Ethernet"));
        assert!(is_physical("Wi-Fi"));
        assert!(!is_physical("Loopback Pseudo-Interface 1"));
        assert!(!is_physical("vEthernet (Default Switch)"));
        assert!(!is_physical("VMware Network Adapter VMnet1"));
        assert!(!is_physical(""));
    }

    #[test]
    fn storage_prefers_the_system_drive() {
        let d = vec![("D:\\".to_string(), 2000, 1500), ("C:\\".to_string(), 1000, 400), ("E:\\".to_string(), 0, 0)];
        assert_eq!(pick_storage("C:", &d), Some((400, 1000)));
        assert_eq!(pick_storage("Z:", &d), Some((1500, 2000)));
        assert_eq!(pick_storage("C:", &[]), None);
        assert_eq!(pick_storage("C:", &[("C:\\".into(), 100, 500)]), Some((100, 100)));
    }
}
