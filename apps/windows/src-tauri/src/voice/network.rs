// Whether the connection may carry a 100 MB download on its own. The Mac asks NWPathMonitor (not expensive, not constrained);
// Windows asks the connection profile's cost (Windows.Networking.Connectivity): "metered" in Settings makes it Variable, a
// data plan makes it Fixed, and roaming or a data limit nearly reached count as metered too.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    Offline,
    Metered,
    Unmetered,
}

pub trait NetworkProbe: Send + Sync {
    fn status(&self) -> Network;
}

pub struct SystemNetwork;

impl NetworkProbe for SystemNetwork {
    #[cfg(windows)]
    fn status(&self) -> Network {
        use windows::Networking::Connectivity::{NetworkConnectivityLevel, NetworkCostType, NetworkInformation};
        super::com_init();
        let Ok(profile) = NetworkInformation::GetInternetConnectionProfile() else {
            return Network::Offline;
        };
        match profile.GetNetworkConnectivityLevel() {
            Ok(NetworkConnectivityLevel::InternetAccess) => {}
            _ => return Network::Offline,
        }
        let Ok(cost) = profile.GetConnectionCost() else {
            // Cost unknown: do not hold the voice back for it.
            return Network::Unmetered;
        };
        let metered = matches!(cost.NetworkCostType(), Ok(NetworkCostType::Fixed | NetworkCostType::Variable))
            || cost.Roaming().unwrap_or(false)
            || cost.OverDataLimit().unwrap_or(false)
            || cost.ApproachingDataLimit().unwrap_or(false);
        if metered {
            Network::Metered
        } else {
            Network::Unmetered
        }
    }

    #[cfg(not(windows))]
    fn status(&self) -> Network {
        Network::Unmetered
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn the_connection_profile_can_be_read() {
        // Any answer is fine (CI may be offline); it must not panic or hang.
        let _ = SystemNetwork.status();
    }
}
