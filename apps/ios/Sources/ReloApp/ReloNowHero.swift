import ReloCore
import SwiftUI

/// Today's signal as a holographic status HUD: a reticle with one progress ring per running
/// task, the most urgent live number in the middle, and three telemetry readouts under it.
/// Its height never changes with the numbers it shows.
struct ReloNowHero: View {
    let summary: InboxTodaySummary
    /// Requests awaiting a response; `nil` while they are being checked.
    let needsYou: Int?
    /// The running tasks, with their reported progress.
    let tasks: [ReloHoloTask]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var running: Int { tasks.count }

    private var state: ReloSignalState {
        if let needsYou, needsYou > 0 { return .needsYou }
        return running > 0 ? .running : .clear
    }

    private var telemetry: [ReloHoloHUD.Telemetry] {
        // The third cell shows whichever of running / needs-you the centre is not showing.
        let third: ReloHoloHUD.Telemetry = state == .needsYou
            ? .init(label: "RUNNING", value: running.formatted())
            : .init(label: "NEEDS YOU", value: needsYou.map { $0.formatted() } ?? "--")
        return [.init(label: "TODAY", value: summary.total.formatted()),
                .init(label: "DONE", value: summary.finished.formatted()), third]
    }

    var body: some View {
        VStack(spacing: 6) {
            ReloHoloHUD(state: state, tasks: tasks,
                        readout: state == .needsYou ? (needsYou ?? 0) : running,
                        readoutLabel: ReloHoloTheme.label(for: state), telemetry: telemetry)
            Text(headline)
                .font(.title3.weight(.semibold))
                .contentTransition(.interpolate)
                .animation(reduceMotion ? nil : .smooth(duration: 0.4), value: headline)
            Text(detail)
                .font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 8)
        .animation(reduceMotion ? nil : .smooth(duration: 0.5), value: summary.total)
        .sensoryFeedback(.impact(weight: .light), trigger: summary.total) { old, new in new > old }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Today")
        .accessibilityValue("\(summary.total) items today, \(summary.finished) done. \(headline). \(detail)")
    }

    private var headline: String {
        guard let needsYou else { return "Checking requests…" }
        if needsYou > 0 { return needsYou == 1 ? "1 request needs you" : "\(needsYou) requests need you" }
        if running > 0 { return running == 1 ? "1 task running" : "\(running) tasks running" }
        return "All clear"
    }

    private var detail: String {
        var parts: [String] = []
        if summary.notifications > 0 {
            parts.append(summary.notifications == 1 ? "1 notification" : "\(summary.notifications) notifications")
        }
        if summary.liveActivities > 0 {
            parts.append(summary.liveActivities == 1 ? "1 Live Activity" : "\(summary.liveActivities) Live Activities")
        }
        // Running work is the HUD's RUNNING readout; counting it again here could disagree with it.
        return parts.isEmpty ? "New requests from your agents arrive here." : parts.joined(separator: " · ")
    }
}
