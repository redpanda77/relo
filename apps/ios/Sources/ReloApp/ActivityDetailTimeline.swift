import ReloCore
import SwiftUI
import UIKit

private extension Color {
    static let techCyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 0xFF / 255)
    static let techViolet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 0xFF / 255)
    static let techHairline = Color.white.opacity(0.10)
}

private extension ShapeStyle where Self == LinearGradient {
    static var techGradient: LinearGradient {
        LinearGradient(colors: [.techCyan, .techViolet], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

// MARK: - Identity strip

/// Source, project, topic, type and time as compact mono chips; then the title, outcome and status.
/// Hold the header to copy the item's ID.
struct ReloIdentityHeader: View {
    let item: InboxItem
    let title: String
    let kind: ReloMessageKind
    let status: String?
    let now: Date

    @Environment(\.dynamicTypeSize) private var typeSize

    private var row: HistoryRow { HistoryRowProjection.row(item, now: now) }
    private var badgeLabel: String { item.kind == .liveActivity ? (row.outcome.label ?? kind.label) : kind.label }

    var body: some View {
        let source = row.source
        VStack(alignment: .leading, spacing: 14) {
            ActivityChipFlow(spacing: 6) {
                chip(source.name, symbol: source.systemImageName, tint: .primary)
                if let project = row.project {
                    chip(project.name, symbol: project.systemImageName, tint: projectColor(project), accent: true)
                }
                if let topic = row.topic { chip(topic, symbol: "number", tint: .reloSecondaryText) }
                chip(row.type, symbol: nil, tint: .reloSecondaryText)
                chip(item.createdAt.formatted(date: .abbreviated, time: .shortened), symbol: "clock", tint: .reloSecondaryText)
            }
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            Text(title)
                .font(.title.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            let line = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
            line {
                if badgeLabel.caseInsensitiveCompare(row.type) != .orderedSame { badge }
                if let status, !status.isEmpty {
                    Text(status).font(.subheadline.monospaced()).foregroundStyle(Color.reloSecondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu {
            Button { UIPasteboard.general.string = item.id } label: { Label("Copy ID", systemImage: "doc.on.doc") }
        }
    }

    private var badge: some View {
        HStack(spacing: 6) {
            Image(systemName: kind.symbol).font(.caption.weight(.bold))
            Text(badgeLabel.uppercased()).font(.caption.monospaced().weight(.bold)).tracking(0.8)
        }
        .foregroundStyle(kind.color)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background { Capsule().fill(kind.color.opacity(0.12)) }
        .overlay { Capsule().strokeBorder(kind.color.opacity(0.35), lineWidth: 0.5) }
        .shadow(color: kind.color.opacity(0.25), radius: 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(badgeLabel)
    }

    private func chip(_ text: String, symbol: String?, tint: Color, accent: Bool = false) -> some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.caption2.weight(.semibold)) }
            Text(text).font(.caption.monospaced()).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background { RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white.opacity(0.04)) }
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(accent ? tint.opacity(0.4) : Color.techHairline, lineWidth: 0.5)
        }
        .accessibilityElement(children: .combine)
    }

    private func projectColor(_ project: InboxProjectIdentity) -> Color {
        guard let slot = project.paletteSlot else { return .reloSecondaryText }
        switch slot % 3 {
        case 0: return .reloInteractive
        case 1: return .reloSignalIndigo
        default: return .reloSignalCoral
        }
    }
}

/// Wraps its children onto as many lines as they need.
private struct ActivityChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        layout(in: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(in: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                                  proposal: ProposedViewSize(width: result.sizes[index].width, height: result.sizes[index].height))
        }
    }

    private func layout(in width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint], sizes: [CGSize]) {
        var origins: [CGPoint] = [], sizes: [CGSize] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            if width.isFinite { size.width = min(size.width, width) }
            sizes.append(size)
            if x > 0, x + size.width > width { x = 0; y += lineHeight + spacing; lineHeight = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + lineHeight), origins, sizes)
    }
}

// MARK: - Mission timeline

/// The card's named steps as a vertical rail: done, the one in progress, and what is still ahead.
/// Without steps it falls back to one progress readout.
struct ReloMissionTimeline: View {
    let item: InboxItem
    let steps: [LiveActivityDisplayPresentation.Step]
    let progress: Double?
    let status: String
    let now: Date

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var revealed = false

    private var row: HistoryRow { HistoryRowProjection.row(item, now: now) }
    private var outcome: HistoryRow.Outcome { row.outcome }

    private enum Phase { case done, current, stopped, pending, ended }

    private func phase(_ step: LiveActivityDisplayPresentation.Step) -> Phase {
        if outcome == .done { return .done }
        switch step.state {
        case .complete: return .done
        case .pending: return .pending
        case .current:
            switch outcome {
            case .running: return .current
            case .stopped: return .stopped
            default: return .ended
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            sectionHeader
            if steps.isEmpty { progressReadout } else { rail }
            Rectangle().fill(Color.techHairline).frame(height: 0.5)
            telemetry
        }
        .padding(ReloLayout.cardInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reloCard()
        .overlay(alignment: .top) {
            Rectangle().fill(.techGradient).frame(height: 1).opacity(0.55).padding(.horizontal, 24)
        }
        .onAppear { revealed = true }
    }

    private var sectionHeader: some View {
        HStack {
            Text(steps.isEmpty ? "TELEMETRY" : "MISSION")
                .font(.caption.monospaced().weight(.bold)).tracking(1.4).foregroundStyle(.techGradient)
            Spacer(minLength: 8)
            if !steps.isEmpty {
                let done = steps.filter { phase($0) == .done }.count
                Text("\(done)/\(steps.count)").font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Color.reloSecondaryText)
                    .accessibilityLabel("\(done) of \(steps.count) steps done")
            }
        }
        .accessibilityAddTraits(.isHeader)
    }

    private var rail: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                let phase = phase(step)
                HStack(alignment: .top, spacing: 14) {
                    VStack(spacing: 0) {
                        marker(phase)
                        if index < steps.count - 1 {
                            Rectangle().fill(railFill(from: phase, next: self.phase(steps[index + 1])))
                                .frame(width: 1).frame(maxHeight: .infinity)
                                .scaleEffect(x: 1, y: revealed || reduceMotion ? 1 : 0, anchor: .top)
                                .animation(reduceMotion ? nil : .easeOut(duration: 0.3).delay(0.1 + Double(index) * 0.08), value: revealed)
                        }
                    }
                    .frame(width: 20)
                    stepText(index: index, step: step, phase: phase)
                        .padding(.bottom, index < steps.count - 1 ? 14 : 0)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Step \(index + 1) of \(steps.count), \(step.label), \(stateWord(phase))")
            }
        }
    }

    private func stepText(index: Int, step: LiveActivityDisplayPresentation.Step, phase: Phase) -> some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
        return layout {
            Text(String(format: "%02d", index + 1)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
            Text(step.label)
                .font(.subheadline.weight(phase == .current || phase == .stopped ? .semibold : .regular))
                .foregroundStyle(labelColor(phase))
                .fixedSize(horizontal: false, vertical: true)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 6) }
            Text(stateWord(phase).uppercased()).font(.caption2.monospaced().weight(.semibold)).tracking(0.8)
                .foregroundStyle(tagColor(phase))
        }
        .frame(minHeight: 20, alignment: .top)
    }

    private func stateWord(_ phase: Phase) -> String {
        switch phase {
        case .done: "done"
        case .current: "current"
        case .stopped: "stopped"
        case .pending: "pending"
        case .ended: outcome == .expired ? "expired" : "ended"
        }
    }

    private func labelColor(_ phase: Phase) -> Color {
        switch phase {
        case .pending: .reloSecondaryText
        case .stopped: .reloWarning
        default: .primary
        }
    }

    private func tagColor(_ phase: Phase) -> Color {
        switch phase {
        case .done: outcome == .done ? .reloDone : .techCyan
        case .current: .techViolet
        case .stopped: .reloWarning
        default: Color.reloSecondaryText.opacity(0.7)
        }
    }

    private func railFill(from: Phase, next: Phase) -> AnyShapeStyle {
        if from == .done && (next == .done || next == .current || next == .stopped) {
            return outcome == .done ? AnyShapeStyle(Color.reloDone.opacity(0.6))
                : AnyShapeStyle(LinearGradient(colors: [.techCyan.opacity(0.8), .techViolet.opacity(0.8)], startPoint: .top, endPoint: .bottom))
        }
        return AnyShapeStyle(Color.white.opacity(0.12))
    }

    @ViewBuilder private func marker(_ phase: Phase) -> some View {
        ZStack {
            switch phase {
            case .done:
                Circle().fill(outcome == .done ? AnyShapeStyle(Color.reloDone) : AnyShapeStyle(.techGradient))
                    .shadow(color: (outcome == .done ? Color.reloDone : Color.techCyan).opacity(0.5), radius: 5)
                Image(systemName: "checkmark").font(.system(size: 8, weight: .black)).foregroundStyle(Color.reloCanvas)
            case .current:
                ActivityStepPulse()
                Circle().strokeBorder(.techGradient, lineWidth: 1.5)
                Circle().fill(Color.techViolet).padding(4.5).shadow(color: Color.techViolet.opacity(0.8), radius: 5)
            case .stopped:
                Circle().strokeBorder(Color.reloWarning, lineWidth: 1.5)
                Circle().fill(Color.reloWarning.opacity(0.18))
                Image(systemName: "exclamationmark").font(.system(size: 9, weight: .black)).foregroundStyle(Color.reloWarning)
            case .pending, .ended:
                Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.75)
            }
        }
        .frame(width: 18, height: 18)
        .padding(.top, 1)
        .scaleEffect(revealed || reduceMotion ? 1 : 0.5)
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.65), value: revealed)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var progressReadout: some View {
        if let progress {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(progress, format: .percent.precision(.fractionLength(0)))
                        .font(.system(.largeTitle, design: .monospaced).weight(.semibold)).monospacedDigit()
                        .contentTransition(.numericText(value: progress))
                    Spacer(minLength: 8)
                }
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.07))
                        Capsule().fill(.techGradient).frame(width: max(4, proxy.size.width * min(max(progress, 0), 1)))
                            .shadow(color: Color.techCyan.opacity(0.45), radius: 5)
                    }
                }
                .frame(height: 5)
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: progress)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Progress")
            .accessibilityValue("\(Int((progress * 100).rounded())) percent")
        } else {
            Text(status).font(.subheadline.monospaced()).foregroundStyle(Color.reloSecondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Telemetry

    private var telemetry: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        return layout {
            cell("ELAPSED") { elapsed }
            if let updates = row.updates { cell("UPDATES") { Text("\(updates)") } }
            if let started = row.startedAt {
                cell("STARTED") { Text(started, format: .dateTime.hour().minute().second()) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var elapsed: some View {
        if let duration = row.duration {
            Text(Self.format(duration))
        } else if outcome == .running, let started = row.startedAt, started <= now {
            Text(timerInterval: started...Date.distantFuture, countsDown: false, showsHours: true)
        } else {
            Text("--:--")
        }
    }

    private func cell<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.monospaced().weight(.semibold)).tracking(1.0).foregroundStyle(Color.reloSecondaryText)
            value().font(.callout.monospacedDigit().weight(.medium))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    static func format(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}

/// A slow ring around the current step; static with Reduce Motion.
private struct ActivityStepPulse: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    var body: some View {
        Circle().stroke(Color.techCyan.opacity(reduceMotion ? 0.25 : (expanded ? 0 : 0.6)), lineWidth: 1)
            .scaleEffect(reduceMotion ? 1.35 : (expanded ? 2.0 : 1))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { expanded = true }
            }
    }
}

extension LiveActivityDisplayPresentation {
    /// The card's steps: named ones when the sender supplied them, else rebuilt from the digest's counts.
    func timelineSteps(for item: InboxItem) -> [Step] {
        if case let .steps(items) = visual, !items.isEmpty { return items }
        guard let steps = item.activity?.steps, steps.total > 0 else { return [] }
        return (0..<steps.total).map { index in
            let state: Step.State = index < steps.done ? .complete : index == steps.done ? .current : .pending
            let label = state == .current ? (steps.current ?? "Step \(index + 1)") : "Step \(index + 1)"
            return Step(id: "step-\(index)", label: label, state: state)
        }
    }
}
