//
//  ReloNotchDemo.swift
//  Relo
//
//  The onboarding's live example of what Relo does, at the top of a small screen: the closed notch opens into a card,
//  a plan moves step by step, the agent asks for an approval, the work finishes, and the notch closes again. The
//  card's content shows only once the notch has finished opening and leaves before it closes. It loops while the
//  onboarding is open; with Reduce Motion it shows the running card, still.
//

import ReloCore
import ReloNotchKit
import SwiftUI

struct ReloNotchDemo: View {
    private enum Phase { case planning, testing, asking, done }

    @State private var expanded = false
    @State private var contentShown = false
    @State private var phase: Phase = .planning
    /// When the current phase began: the clock the expansion's light and bar run on, as in the real notch.
    @State private var phaseAt = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let closed = CGSize(width: 184, height: 30)
    private static let openWidth: CGFloat = 392
    private static let bezel: CGFloat = 8

    private var openHeight: CGFloat { phase == .asking ? 128 : 116 }

    /// The real expansion's kind for the phase: its light, its badge's arrival and its bar.
    private var kind: ReloOpenKind {
        switch phase {
        case .planning, .testing: .running
        case .asking: .needs
        case .done: .done
        }
    }

    private var tone: NotchPresentation.Tone {
        switch phase {
        case .planning, .testing: .working
        case .asking: .needsYou
        case .done: .done
        }
    }

    private var stepsDone: Int {
        switch phase {
        case .planning: 2
        case .testing: 3
        case .asking: 4
        case .done: 5
        }
    }

    private var status: String {
        switch phase {
        case .planning: "Writing the migration · Step 3 of 5"
        case .testing: "Running the tests · Step 4 of 5"
        case .asking: "Deploy to production?"
        case .done: "Shipped in 6 min"
        }
    }

    var body: some View {
        screen
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("An example of a Relo card in the notch")
            .task { await loop() }
    }

    /// The top of a Mac screen: a dark bezel the notch hangs from, over a dim desktop.
    private var screen: some View {
        ZStack(alignment: .top) {
            UnevenRoundedRectangle(topLeadingRadius: 14, topTrailingRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [.black.opacity(0.55), .black.opacity(0.15)], startPoint: .top, endPoint: .bottom))
            Rectangle().fill(.black).frame(height: Self.bezel)
            notch.padding(.top, Self.bezel)
        }
        .frame(width: 460, height: 152)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 14, topTrailingRadius: 14, style: .continuous))
        .overlay(
            UnevenRoundedRectangle(topLeadingRadius: 14, topTrailingRadius: 14, style: .continuous)
                .strokeBorder(.white.opacity(0.1))
        )
        .mask(LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom))
    }

    private var notch: some View {
        let size = expanded ? CGSize(width: Self.openWidth, height: openHeight) : Self.closed
        return ZStack(alignment: .top) {
            NotchShape(topCornerRadius: expanded ? 10 : 6, bottomCornerRadius: expanded ? 24 : 11)
                .fill(.black)
                .frame(width: size.width, height: size.height)
                .shadow(color: ReloNotchTheme.color(tone).opacity(expanded ? 0.45 : 0), radius: 28, y: 10)
            if contentShown {
                // The real expansion's light, rising from the bottom edge in the phase's colour.
                ReloOpenLight(kind: kind, openedAt: phaseAt, bottomRadius: 24)
                    .frame(width: size.width, height: size.height)
                    .clipShape(NotchShape(topCornerRadius: 10, bottomCornerRadius: 24))
                    .transition(.opacity)
            }
            if contentShown {
                card
                    .padding(.horizontal, 24)
                    .padding(.top, 32)
                    .frame(width: Self.openWidth, alignment: .leading)
                    .transition(.opacity)
            } else if !expanded {
                closedWings.transition(.opacity)
            }
        }
        .frame(width: Self.openWidth, height: 128, alignment: .top)
    }

    /// The closed notch's Relo: a running dot on one side, the plan's count on the other.
    private var closedWings: some View {
        HStack {
            Circle().fill(ReloNotchTheme.running).frame(width: 7, height: 7)
            Spacer()
            Text("3/5").font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.7))
        }
        .padding(.horizontal, 16)
        .frame(width: Self.closed.width, height: Self.closed.height)
    }

    /// The expanded notch's anatomy (ReloExpandedCard): the origin and the state's badge, the title, what it does or
    /// asks, then the plan bar or the answer. No mark on the left; a finish is said by the word and the mint bar.
    private var card: some View {
        let color = ReloNotchTheme.color(tone)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("billing").font(ReloCardMetrics.origin).fontWeight(.semibold).foregroundStyle(ReloNotchTheme.secondaryText)
                Spacer(minLength: 6)
                if phase == .done {
                    Text(ReloNotchTheme.label(tone)).font(ReloCardMetrics.badge).foregroundStyle(color)
                } else {
                    ReloStateBadge(symbol: ReloNotchTheme.symbol(tone), label: ReloNotchTheme.label(tone), color: color)
                }
            }
            Text("Ship the billing release")
                .font(ReloCardMetrics.hero)
                .foregroundStyle(.white)
            Text(status)
                .font(ReloCardMetrics.status)
                .foregroundStyle(ReloNotchTheme.secondaryText)
                .contentTransition(.opacity)
            Group {
                if phase == .asking {
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        pill("Yes", filled: true)
                        pill("No", filled: false)
                    }
                } else {
                    ReloLightBar(segments: PlanBar.make(done: stepsDone, total: 5, current: stepsDone + 1, fill: 0.45).segments,
                                 kind: kind, openedAt: phaseAt)
                }
            }
            .padding(.top, 6)
            .transition(.opacity)
        }
        .animation(.easeInOut(duration: 0.25), value: phase)
    }

    private func pill(_ label: String, filled: Bool) -> some View {
        Text(label)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(filled ? .black : .white.opacity(0.85))
            .padding(.horizontal, 13).padding(.vertical, 5)
            .background(Capsule().fill(filled ? ReloNotchTheme.signalCoral : .white.opacity(0.12)))
    }

    private func loop() async {
        if reduceMotion {
            phase = .testing; phaseAt = Date(); expanded = true; contentShown = true
            return
        }
        let spring = ReloMotion.smooth
        while !Task.isCancelled {
            phase = .planning
            phaseAt = Date()
            try? await Task.sleep(for: .seconds(1.3))
            withAnimation(spring) { expanded = true }
            try? await Task.sleep(for: .seconds(0.42))     // the notch finishes opening first
            withAnimation(.easeOut(duration: 0.22)) { contentShown = true }
            for next in [Phase.testing, .asking, .done] {
                try? await Task.sleep(for: .seconds(next == .done ? 2.6 : 2.0))
                withAnimation(spring) { phase = next }
                phaseAt = Date()
            }
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation(.easeIn(duration: 0.15)) { contentShown = false }  // the content leaves before it closes
            try? await Task.sleep(for: .seconds(0.16))
            withAnimation(spring) { expanded = false }
        }
    }
}
