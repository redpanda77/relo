//! Battery from `GetSystemPowerStatus` (the Mac reads IOPS). `None` on a desktop PC without a battery.

/// (level 0..1, charging) from the raw fields: `flag` bit 128 = no battery, bit 8 = charging; 255 = unknown.
pub fn interpret(flag: u8, percent: u8) -> Option<(f64, bool)> {
    if flag == 255 || flag & 128 != 0 || percent > 100 {
        return None;
    }
    Some((percent as f64 / 100.0, flag & 8 != 0))
}

#[cfg(windows)]
pub fn battery() -> Option<(f64, bool)> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).ok()? };
    interpret(s.BatteryFlag, s.BatteryLifePercent)
}

#[cfg(not(windows))]
pub fn battery() -> Option<(f64, bool)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_power_status_flags() {
        assert_eq!(interpret(1, 80), Some((0.8, false)));
        assert_eq!(interpret(9, 55), Some((0.55, true)));
        assert_eq!(interpret(128, 100), None);
        assert_eq!(interpret(255, 255), None);
        assert_eq!(interpret(1, 255), None);
    }
}
