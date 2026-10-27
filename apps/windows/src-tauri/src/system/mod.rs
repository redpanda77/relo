//! The System tab's data: the PC's vitals, sampled on demand while the tab is on screen (nothing runs while it is
//! closed, as on the Mac). One command, `system_sample`, returns the whole sample; rates and the CPU delta come
//! from the state kept between calls. Mac source: components/System/SystemMonitor.swift.

mod calc;
mod power;
mod thermal;

use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, MemoryRefreshKind, Networks, System};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// 0..1
    pub cpu: f64,
    pub cores: Vec<f64>,
    pub memory_used: u64,
    pub memory_total: u64,
    pub storage_free: u64,
    pub storage_total: u64,
    pub down_bytes_per_second: f64,
    pub up_bytes_per_second: f64,
    /// 0..1; None on a PC without a battery.
    pub battery: Option<f64>,
    pub charging: bool,
    /// "nominal" | "fair" | "serious" | "critical", from the thermal passive-cooling limit (thermal.rs); nominal without a thermal zone.
    pub thermal: &'static str,
}

struct Sampler {
    sys: System,
    last_net: Option<(u64, u64, Instant)>,
    storage: Option<(u64, u64)>,
    storage_at: Option<Instant>,
    thermal: &'static str,
    thermal_at: Option<Instant>,
    sample: Sample,
}

static SAMPLER: Mutex<Option<Sampler>> = Mutex::new(None);

fn network_totals() -> (u64, u64) {
    let nets = Networks::new_with_refreshed_list();
    nets.iter()
        .filter(|(name, _)| calc::is_physical(name))
        .fold((0, 0), |(d, u), (_, n)| (d + n.total_received(), u + n.total_transmitted()))
}

fn storage() -> Option<(u64, u64)> {
    let disks = Disks::new_with_refreshed_list();
    let drives: Vec<(String, u64, u64)> =
        disks.iter().map(|d| (d.mount_point().to_string_lossy().into_owned(), d.total_space(), d.available_space())).collect();
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    calc::pick_storage(&system, &drives)
}

impl Sampler {
    fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        Sampler { sys, last_net: None, storage: None, storage_at: None, thermal: "nominal", thermal_at: None, sample: Sample { thermal: "nominal", ..Default::default() } }
    }

    fn tick(&mut self) -> Sample {
        let mut next = self.sample.clone();
        self.sys.refresh_cpu_usage();
        let cores: Vec<f64> = self.sys.cpus().iter().map(|c| calc::unit(c.cpu_usage())).collect();
        if !cores.is_empty() {
            next.cpu = calc::overall(&cores);
            next.cores = cores;
        }
        self.sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        next.memory_total = self.sys.total_memory();
        next.memory_used = self.sys.used_memory();
        // Storage changes slowly: every 30 s.
        if self.storage_at.is_none_or(|t| t.elapsed().as_secs() >= 30) {
            self.storage_at = Some(Instant::now());
            self.storage = storage();
        }
        if let Some((free, total)) = self.storage {
            next.storage_free = free;
            next.storage_total = total;
        }
        let (down, up) = network_totals();
        let now = Instant::now();
        if let Some((d0, u0, at)) = self.last_net {
            let e = now.duration_since(at);
            next.down_bytes_per_second = calc::rate(down, d0, e);
            next.up_bytes_per_second = calc::rate(up, u0, e);
        }
        self.last_net = Some((down, up, now));
        let b = power::battery();
        next.battery = b.map(|x| x.0);
        next.charging = b.is_some_and(|x| x.1);
        // Thermal passive-cooling limit (thermal.rs), read at most every 10 s: the counter query is not free.
        if self.thermal_at.is_none_or(|t| t.elapsed().as_secs() >= 10) {
            self.thermal_at = Some(Instant::now());
            self.thermal = thermal::read();
        }
        next.thermal = self.thermal;
        self.sample = next.clone();
        next
    }
}

/// One reading. The page calls this every 2 s while the System tab is visible.
#[tauri::command]
pub async fn system_sample() -> Sample {
    tauri::async_runtime::spawn_blocking(|| {
        let mut g = SAMPLER.lock().unwrap();
        g.get_or_insert_with(Sampler::new).tick()
    })
    .await
    .unwrap_or_default()
}

/// The tab hid: forget the network baseline so the first reading after a pause does not average the whole gap.
#[tauri::command]
pub fn system_stop() {
    if let Some(s) = SAMPLER.lock().unwrap().as_mut() {
        s.last_net = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_sample_is_in_range() {
        let mut s = Sampler::new();
        s.tick();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let a = s.tick();
        assert!((0.0..=1.0).contains(&a.cpu));
        assert!(!a.cores.is_empty());
        assert!(a.memory_total > 0 && a.memory_used <= a.memory_total);
        assert!(a.storage_total > 0 && a.storage_free <= a.storage_total);
        assert!(a.battery.is_none_or(|b| (0.0..=1.0).contains(&b)));
    }
}
