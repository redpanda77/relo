//
//  ReloUsageRailSettings.swift
//  Relo Notch
//
//  Settings > Usage > Side rail: whether the usage rail sits on a screen edge, and on which side. It rests compact.
//  Changes apply live (ReloUsageRail observes the keys).
//

import Defaults
import SwiftUI

struct ReloUsageRailSettings: View {
    @Default(.usageRail) private var rail
    @Default(.usageRailEdge) private var edge

    var body: some View {
        ReloGlassGroup(title: "Side rail", footer: "A slim strip on the screen edge with one ring per account.") {
            row("Side rail", selection: $rail) {
                Text("Off").tag("off")
                Text("On hover").tag("hover")
                Text("Always").tag("always")
            }
            ReloGlassDivider()
            row("Edge", selection: $edge) {
                Text("Left").tag("left")
                Text("Right").tag("right")
            }
            .disabled(rail == "off")
        }
    }

    private func row<Content: View>(_ title: String, selection: Binding<String>, @ViewBuilder _ options: () -> Content) -> some View {
        HStack(spacing: 12) {
            ReloGlassLabel(title: title)
            Spacer(minLength: 8)
            Picker(title, selection: selection) { options() }
                .pickerStyle(.segmented).labelsHidden().fixedSize()
        }
        .reloGlassRow()
    }
}
