//
//  ReloUsageMomentSettings.swift
//  Relo Notch
//
//  Settings > Usage: which plan-usage moments the closed notch plays (ReloUsageMoments). Muted accounts play none.
//

import Defaults
import SwiftUI

struct ReloUsageMomentSettings: View {
    @Default(.usageMomentLimits) private var limits
    @Default(.usageMomentResets) private var resets

    var body: some View {
        ReloGlassGroup(title: "Notch") {
            Toggle(isOn: $limits) { ReloGlassLabel(title: "At 80% and when a plan runs out", detail: "A short line under the notch") }
                .reloGlassRow()
            ReloGlassDivider()
            Toggle(isOn: $resets) { ReloGlassLabel(title: "When a window resets", detail: "A short line under the notch") }
                .reloGlassRow()
        }
    }
}
