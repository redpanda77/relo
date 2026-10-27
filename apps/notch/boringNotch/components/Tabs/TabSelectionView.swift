//
//  TabSelectionView.swift
//  boringNotch
//
//  Created by Hugo Persson on 2024-08-25.
//

import Defaults
import SwiftUI

struct TabModel: Identifiable {
    let id = UUID()
    let label: String
    let icon: String
    let view: NotchViews
}

let tabs = [
    TabModel(label: "Relo", icon: "circle.hexagongrid.fill", view: .relo),
    TabModel(label: "System", icon: "gauge.with.dots.needle.50percent", view: .system),
    TabModel(label: "Usage", icon: "chart.bar.fill", view: .usage),
    TabModel(label: "Music", icon: "music.note.house.fill", view: .home),
    TabModel(label: "Shelf", icon: "tray.fill", view: .shelf)
]

struct TabSelectionView: View {
    @ObservedObject var coordinator = BoringViewCoordinator.shared
    @Namespace var animation
    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs.filter { $0.view != .shelf || Defaults[.boringShelf] }) { tab in
                    TabButton(label: tab.label, icon: tab.icon, selected: coordinator.currentView == tab.view) {
                        if coordinator.currentView != tab.view { ReloCuePlayer.shared.play(.tab) }
                        withAnimation(.smooth) {
                            coordinator.currentView = tab.view
                        }
                    }
                    .frame(height: 26)
                    .foregroundStyle(tab.view == coordinator.currentView ? selectedColor(tab.view) : .gray)
                    .background {
                        if tab.view == coordinator.currentView {
                            Capsule()
                                .fill(coordinator.currentView == tab.view ? Color(nsColor: .secondarySystemFill) : Color.clear)
                                .matchedGeometryEffect(id: "capsule", in: animation)
                        } else {
                            Capsule()
                                .fill(coordinator.currentView == tab.view ? Color(nsColor: .secondarySystemFill) : Color.clear)
                                .matchedGeometryEffect(id: "capsule", in: animation)
                                .hidden()
                        }
                    }
            }
        }
        .clipShape(Capsule())
    }

    /// The System tab takes the attention colour while a measure is under pressure.
    private func selectedColor(_ view: NotchViews) -> Color {
        view == .system && SystemMonitor.shared.focus != .atRest ? ReloNotchTheme.orange : .white
    }
}

#Preview {
    BoringHeader().environmentObject(BoringViewModel())
}
