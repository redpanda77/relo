//
//  ReloCards.swift
//  Relo
//
//  The iPhone's card anatomy on the Mac (ADR 0013 §7; apps/ios ReloWorkCard, ReloCardTokens, ReloStateStyle):
//  the origin with the state's badge on its right (the state is said once), the title, the status, the plan bar
//  (left out when complete or stepless) and a footer (the plan on the left; the computer and the time, or the answer,
//  on the right). Cards are for work and questions; finished work is a compact row, sessions are rows by computer.
//  Sizes are the Mac's (no Dynamic Type), named as on the iPhone.
//

import Defaults
import ReloCore
import ReloNotchKit
import ReloVoice
import SwiftUI

/// The iPhone's tokens at the Mac's density.
enum ReloCardMetrics {
    static let inset = EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12)
    static let radius: CGFloat = 14
    static let lineGap: CGFloat = 4
    static let itemSpacing: CGFloat = 8
    static let sectionSpacing: CGFloat = 14
    /// Every collapsed card is this tall whatever it carries; opened, it grows to its whole text. The sum of its tallest
    /// collapsed content: insets 18, header 16, title 17, status 14, three line gaps 12, plan bar 4 and its gap 4,
    /// footer 20, plus 3 to spare. Change a part and change this, or the footer is cut.
    static let cardHeight: CGFloat = 108
    /// A finished, quiet or paused row on its grouped surface.
    static let rowHeight: CGFloat = 30
    static let fill = Color.white.opacity(0.06)
    static let border = Color.white.opacity(0.08)
    static let origin = Font.system(size: 10.5)
    static let badge = Font.system(size: 10, weight: .semibold)
    static let title = Font.system(size: 12.5, weight: .semibold)
    static let hero = Font.system(size: 13.5, weight: .semibold)
    static let status = Font.system(size: 11)
    static let meta = Font.system(size: 10)
    static let eyebrow = Font.system(size: 10, weight: .semibold, design: .monospaced)
}

/// The motion vocabulary (ADR 0013 §5): the Dashboard's tokens as Apple springs. No literal springs elsewhere.
enum ReloMotion {
    static let press = Animation.spring(response: 0.18, dampingFraction: 1)
    static let snappy = Animation.spring(response: 0.28, dampingFraction: 0.86)
    static let smooth = Animation.spring(response: 0.35, dampingFraction: 1)
    static let bouncy = Animation.spring(response: 0.42, dampingFraction: 0.72)
    static let base = Animation.easeInOut(duration: 0.26)
    static let fast = Animation.easeOut(duration: 0.18)

    /// The notch opening and closing: one spring for the shape, its corners and every resize while open, so the notch
    /// reads as one object changing shape. Closing settles without a bounce.
    static let notchOpen = Animation.spring(response: 0.42, dampingFraction: 0.82)
    static let notchClose = Animation.spring(response: 0.36, dampingFraction: 1)

    /// What the open notch shows arrives already in place: the growing shape uncovers it and it fades up a beat after
    /// the shape starts; leaving, it goes at once so the shape closes on nothing. Nothing scales from behind the edge.
    static func notchContent(reduced: Bool) -> AnyTransition {
        .asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.24).delay(reduced ? 0 : 0.08)),
                    removal: .opacity.animation(.linear(duration: 0.1)))
    }

    /// The closed notch's wings: gone in the first instants of opening, back once the shape has nearly closed.
    static func notchWings(reduced: Bool) -> AnyTransition {
        .asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.2).delay(reduced ? 0 : 0.22)),
                    removal: .opacity.animation(.linear(duration: 0.1)))
    }

    /// Reduce Motion turns a spring into a short fade.
    static func or(_ animation: Animation, reduced: Bool) -> Animation { reduced ? .easeInOut(duration: 0.18) : animation }
}

/// A page building in (ADR 0013 §5): each element rises 12 pt and fades in on `smooth`, 80 ms after the one before
/// (capped), so a page arrives in reading order; Reduce Motion keeps the fade only.
struct ReloEntrance: ViewModifier {
    let index: Int
    let shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 12)
            .animation(ReloMotion.or(ReloMotion.smooth, reduced: reduceMotion).delay(Double(min(index, 6)) * 0.08), value: shown)
    }
}

/// A list building in (ADR 0013 §5): each item rises 8 pt and fades in on `snappy`, 40 ms after the one before (capped
/// at six), so a list arrives top first; Reduce Motion keeps the fade only.
struct ReloListEntrance: ViewModifier {
    let index: Int
    let shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .animation(ReloMotion.or(ReloMotion.snappy, reduced: reduceMotion).delay(Double(min(index, 6)) * 0.04), value: shown)
    }
}

extension View {
    func reloEntrance(_ index: Int, _ shown: Bool) -> some View { modifier(ReloEntrance(index: index, shown: shown)) }
    func reloListEntrance(_ index: Int, _ shown: Bool) -> some View { modifier(ReloListEntrance(index: index, shown: shown)) }
}

/// A name the owner can read: server-sealed names this Mac cannot read yet arrive as ids (c-…, p-…).
enum ReloDisplayName {
    static func readable(_ name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        if name.range(of: #"^[a-z]-[a-z0-9]{10,}$"#, options: .regularExpression) != nil { return nil }
        return name
    }
}

/// The section caption: the title in tracked monospaced caps, the count in the section's color.
struct ReloSectionHeader: View {
    let title: String
    let count: Int
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Text(title.uppercased()).foregroundStyle(ReloNotchTheme.tertiaryText).tracking(1.2)
            Text("\(count)").foregroundStyle(color).contentTransition(.numericText(value: Double(count)))
        }
        .font(ReloCardMetrics.eyebrow)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// An opened card's whole height, from its hidden measuring copy.
private struct ReloCardOpenHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The work card. `hero` is the question's size (Needs you); `expanded` shows the whole text and the plan.
struct ReloWorkCard: View {
    let row: NotchPresentation.Row
    var hero = false
    var expanded = false
    var offline = false
    /// Quiet or paused work: faded while closed, full strength once opened to be read.
    var dimmed = false
    /// Opened inside a row group, which draws the surface: the card adds no fill or border of its own (a second
    /// translucent fill turned it grey).
    var grouped = false
    var toggle: () -> Void = {}
    private let store = ReloNotch.store
    @Default(.reloVoiceButton) private var voiceButton
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The opened card's whole height, measured from a hidden copy, so opening and closing animate one number and the
    /// list below rides the same spring (a frame going from a fixed height to none cannot be interpolated).
    @State private var openHeight = ReloCardMetrics.cardHeight
    /// The opened part stays laid out until closing has finished, so the card shrinks over it instead of losing it.
    @State private var showsDetail = false
    @State private var closing = 0
    /// What the owner opened in the plan, shared by the card and the hidden copy that measures it.
    @State private var planState = ReloPlanState()
    /// The question's text does not fit its three lines: the answer waits until the card is opened.
    @State private var questionCut = false

    /// Collapsed, every card has one shape: origin, one title line, one status line, then the plan bar and the footer
    /// pinned to the bottom, all inside `cardHeight` (longer text is cut to its line). Opened, the whole text, what the
    /// round delivered and every plan step.
    var body: some View {
        content(open: expanded, detail: showsDetail || expanded)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(minHeight: expanded ? max(openHeight, ReloCardMetrics.cardHeight) : ReloCardMetrics.cardHeight,
                   maxHeight: !expanded && showsQuestion ? .infinity : (expanded ? max(openHeight, ReloCardMetrics.cardHeight) : ReloCardMetrics.cardHeight),
                   alignment: .top)
            .background(alignment: .top) {
                // Measured only while open (always measuring every card's hidden copy cost about 5% CPU); the height
                // stays cached after the first opening.
                if expanded || showsDetail {
                    content(open: true, detail: true)
                        .fixedSize(horizontal: false, vertical: true)
                        .background(GeometryReader { Color.clear.preference(key: ReloCardOpenHeight.self, value: $0.size.height) })
                        .hidden()
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .onPreferenceChange(ReloCardOpenHeight.self) { height in
                guard height > 0, abs(height - openHeight) > 0.5 else { return }
                withAnimation(ReloMotion.or(ReloMotion.snappy, reduced: reduceMotion)) { openHeight = height }
            }
            .onAppear { showsDetail = expanded }
            .onChange(of: expanded) { _, open in
                closing += 1
                if open { showsDetail = true; return }
                let token = closing
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { if closing == token { showsDetail = false } }
            }
            .clipShape(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous))
            .background {
                if !grouped {
                let color = ReloNotchTheme.color(row.tone)
                RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous)
                    .fill(row.tone == .needsYou
                          ? AnyShapeStyle(LinearGradient(colors: [color.opacity(0.12), color.opacity(0.03)], startPoint: .top, endPoint: .bottom))
                          : AnyShapeStyle(ReloCardMetrics.fill))
                    .overlay(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous)
                        .strokeBorder(row.tone == .needsYou ? color.opacity(0.32) : ReloCardMetrics.border))
                }
            }
            .opacity(dimmed && !expanded ? 0.6 : 1)
            .contentShape(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous))
            .onTapGesture(perform: toggle)
            .animation(ReloMotion.base, value: row.tone)
    }

    /// The card's text: `open` lets the title and status wrap; `detail` lays out what the round delivered and the plan
    /// under the footer (it fades with `expanded`, and the card's height reveals or hides it).
    private func content(open: Bool, detail: Bool) -> some View {
        let color = ReloNotchTheme.color(row.tone)
        let insets = ReloCardMetrics.inset.top + ReloCardMetrics.inset.bottom
        return VStack(alignment: .leading, spacing: 0) {
            // The collapsed card's whole shape, at least `cardHeight` tall whatever lies under it, so the plan bar and
            // the footer stay pinned to the same place while the card opens or closes over its detail.
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: ReloCardMetrics.lineGap) {
                    header(color)
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        if row.unreadable {
                            Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(ReloNotchTheme.yellow)
                        }
                        // The text re-wraps at once, unanimated, while the card's height animates around it: a line limit
                        // animated in place sends words flying, and a cross-fade between two copies flashed the title.
                        Text(ReloDisplayName.readable(row.title) ?? LocalMode.untitled(local: ReloNotch.store.isLocal))
                            .font(hero ? ReloCardMetrics.hero : ReloCardMetrics.title)
                            .foregroundStyle(row.unreadable ? ReloNotchTheme.secondaryText : .white)
                            .lineLimit(open ? nil : 1)
                            .fixedSize(horizontal: false, vertical: true)
                            .transaction { $0.animation = nil }
                    }
                    if showsQuestion, let question {
                        // The question in up to three lines, and the card grows to hold them; the answer waits until it is all there.
                        ReloQuestionText(text: question.prompt, open: open, cut: $questionCut)
                    } else if let text = bodyText {
                        Text(text)
                            .font(ReloCardMetrics.status)
                            .foregroundStyle(ReloNotchTheme.secondaryText)
                            .lineLimit(open ? nil : 1)
                            .fixedSize(horizontal: false, vertical: true)
                            .transaction { $0.animation = nil }
                    }
                }
                Spacer(minLength: ReloCardMetrics.lineGap)
                VStack(alignment: .leading, spacing: ReloCardMetrics.lineGap) {
                    if showsBar, let bar = row.bar {
                        // Only the current step's name shimmers (the Round Deck study): the bar stays still.
                        ReloStepsBar(bar: bar, color: color)
                    }
                    footer(color)
                }
            }
            .frame(minHeight: ReloCardMetrics.cardHeight - insets, alignment: .topLeading)
            if detail {
                VStack(alignment: .leading, spacing: ReloCardMetrics.lineGap) {
                    // A deck carries each round's outcome on its slab; a single round says it here.
                    if let outcome = row.roundOutcome, outcome != row.status, row.outline?.hasRoundSections != true {
                        Text(outcome).font(ReloCardMetrics.status).foregroundStyle(ReloNotchTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ReloPlanSteps(row: row, color: color, state: $planState)
                        .padding(.top, 10)
                        .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5) }
                        .padding(.top, 4)
                }
                .padding(.top, ReloCardMetrics.lineGap)
                .opacity(expanded ? 1 : 0)
                .offset(y: expanded || reduceMotion ? 0 : -6)
            }
        }
        .padding(ReloCardMetrics.inset)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// Origin on the left, the state's one badge on the right.
    private func header(_ color: Color) -> some View {
        HStack(spacing: 6) {
            ReloCardOrigin(row: row)
            Spacer(minLength: 6)
            if voiceButton, let line = SpokenLine.text(for: row, prompt: question.flatMap { $0.isReadable ? $0.prompt : nil }, quiet: row.quietLine) {
                ReloPlayButton(id: "\(row.id)|\(line)", text: line)
            }
            ReloStateBadge(symbol: ReloNotchTheme.symbol(row.tone),
                           label: badge, color: color, live: row.tone == .working && !showsBar)
        }
    }

    /// The plan (or what was asked) on the left; the computer and the time, or the answer, on the right.
    @ViewBuilder
    private func footer(_ color: Color) -> some View {
        HStack(alignment: .center, spacing: 8) {
            if let plan = planCaption {
                Text(plan).lineLimit(1)
            } else if row.questionPending {
                Text(row.declaredAt, style: .time).monospacedDigit()
            }
            Spacer(minLength: 6)
            if row.questionPending, !canAnswerHere {
                ReloReadOnPhoneLine()
            } else if row.questionPending, questionCut, !expanded {
                // Never an answer button next to half a question.
                Label("Open to read it all", systemImage: "chevron.down")
                    .font(.system(size: 11)).foregroundStyle(ReloNotchTheme.secondaryText).lineLimit(1)
            } else if let notificationID = row.notificationID, row.questionPending {
                ReloAnswerBar(notificationID: notificationID, question: question, offline: offline)
            } else {
                trailingFacts
            }
        }
        .font(ReloCardMetrics.meta)
        .foregroundStyle(ReloNotchTheme.tertiaryText)
        // The answer pills' height, so a card with a question is no taller than one without.
        .frame(height: 20)
    }

    @ViewBuilder
    private var trailingFacts: some View {
        if offline {
            // Offline the clock is re-read now and then: past the server's `refreshAt` the card stops looking live.
            TimelineView(.periodic(from: .now, by: 20)) { context in
                facts(frozen: store.presentation.isFrozen(offline: true, lastUpdated: store.lastUpdated, now: context.date))
            }
        } else {
            facts(frozen: false)
        }
    }

    private func facts(frozen: Bool) -> some View {
        HStack(spacing: 6) {
            if let symbol = row.computerSymbol { Image(systemName: symbol) }
            if frozen {
                // Old data never ticks: a timer would keep counting for work nobody has heard from.
                Text(NotchPresentation.asOf(store.lastUpdated ?? store.presentation.servedAt))
            } else if row.tone.isMoving, Date().timeIntervalSince(row.startedAt) < 3600 {
                Text(row.startedAt, style: .timer).monospacedDigit()
            } else if row.tone.isMoving {
                Text("since \(row.startedAt.formatted(date: .omitted, time: .shortened))")
            } else {
                // When it last moved, by the server's evidence, not when the card was last declared.
                Text(row.movedAt, style: .time).monospacedDigit()
            }
        }
    }

    private var badge: String {
        guard let label = row.chip?.label.lowercased(), let first = label.first else { return ReloNotchTheme.label(row.tone) }
        return first.uppercased() + label.dropFirst()
    }

    /// The plan bar says something only while there is still a plan to go.
    private var showsBar: Bool {
        guard let total = row.stepsTotal, total > 0, !row.questionPending else { return false }
        return (row.stepsDone ?? 0) < total && row.tone.isMoving
    }

    /// The plan only (the state is the badge's), as the iPhone words it: "Step 3 of 5 · Run the tests".
    private var planCaption: String? {
        guard !row.questionPending else { return nil }
        return row.planLine
    }

    /// A pending question that this Mac can read shows as the question, in up to three lines.
    private var showsQuestion: Bool {
        guard !row.unreadable, row.questionPending, let question else { return false }
        return question.isReadable
    }

    private var bodyText: String? {
        if row.unreadable { return ReloLocked.line(row) }
        if let question, question.isReadable { return question.prompt }
        return row.statusLine
    }

    private var canAnswerHere: Bool { QuestionReadability.canAnswerHere(rowUnreadable: row.unreadable, question: question) }

    private var question: ReloNotchStore.Question? {
        row.notificationID.flatMap { store.questions[$0] }
    }
}

extension NotchPresentation {
    /// The computers the surfaces list, in the server's order: unnamed ones are left out, except on Relo on this Mac, where
    /// every session is this Mac's.
    @MainActor
    var shownMachines: [Machine] { machines(unnamedAs: ReloNotch.store.isLocal ? "This Mac" : nil) }
}

/// What a card this Mac could not open says: the server's own reason when the opener gave one (its status), else the
/// general line. Never an instruction that may not apply ("Approve this Mac on your iPhone" for a local card).
@MainActor
enum ReloLocked {
    static func line(_ row: NotchPresentation.Row) -> String {
        if let reason = row.status?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty { return reason }
        return LocalMode.unreadable(local: ReloNotch.store.isLocal)
    }
}

private struct ReloQuestionShownHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct ReloQuestionFullHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// A question: up to three lines (the whole text once `open`), and it says whether three lines cut it, by measuring the
/// whole text against three lines of it.
struct ReloQuestionText: View {
    let text: String
    let open: Bool
    @Binding var cut: Bool
    static let lines = 3
    @State private var shown: CGFloat = 0
    @State private var full: CGFloat = 0

    var body: some View {
        Text(text)
            .font(ReloCardMetrics.status)
            .foregroundStyle(ReloNotchTheme.secondaryText)
            .lineLimit(open ? nil : Self.lines)
            .fixedSize(horizontal: false, vertical: true)
            // Re-wraps at once while the card's height animates (an animated line limit sends words flying).
            .transaction { $0.animation = nil }
            // Measured from two hidden copies (three lines, and whole), not from the shown text: opened, the shown
            // text is whole, and closing flashed the answer buttons until it measured cut again.
            .background(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    Text(text)
                        .font(ReloCardMetrics.status)
                        .lineLimit(Self.lines)
                        .fixedSize(horizontal: false, vertical: true)
                        .background(GeometryReader { Color.clear.preference(key: ReloQuestionShownHeight.self, value: $0.size.height) })
                    Text(text)
                        .font(ReloCardMetrics.status)
                        .fixedSize(horizontal: false, vertical: true)
                        .background(GeometryReader { Color.clear.preference(key: ReloQuestionFullHeight.self, value: $0.size.height) })
                }
                .hidden()
                .accessibilityHidden(true)
            }
            .onPreferenceChange(ReloQuestionShownHeight.self) { shown = $0; update() }
            .onPreferenceChange(ReloQuestionFullHeight.self) { full = $0; update() }
            .onChange(of: text) { _, _ in update() }
    }

    private func update() {
        let isCut = full > shown + 1
        if isCut != cut { cut = isCut }
    }
}

/// Where the answer bar would be, for a question this Mac cannot read: no buttons, only where to answer.
struct ReloReadOnPhoneLine: View {
    var body: some View {
        Label(QuestionReadability.line, systemImage: "iphone")
            .font(.system(size: 11))
            .foregroundStyle(ReloNotchTheme.secondaryText)
            .lineLimit(1)
    }
}

/// Says the card's line on this Mac: play while silent, a spinner while the line renders, stop while it speaks.
struct ReloPlayButton: View {
    let id: String
    let text: String
    private let voice = ReloNotch.voice

    var body: some View {
        let active = voice.isActive(id)
        Button { voice.toggle(id: id, text: text) } label: {
            Group {
                if voice.phase == .preparing(id) {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: active ? "stop.fill" : "play.fill").font(.system(size: 8, weight: .bold))
                }
            }
            .frame(width: 16, height: 16)
            .background(Circle().fill(.white.opacity(active ? 0.18 : 0.08)))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? .white : ReloNotchTheme.secondaryText)
        .help(active ? "Stop" : "Say this card")
        .accessibilityLabel(active ? "Stop speaking" : "Say this card")
    }
}

/// The state's one badge: symbol and label in its color; running work carries the same travelling light as its bar.
struct ReloStateBadge: View {
    let symbol: String
    let label: String
    let color: Color
    var live = false

    var body: some View {
        let content = HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 9, weight: .bold))
            Text(label)
        }
        .font(ReloCardMetrics.badge)
        content
            .foregroundStyle(color)
            .overlay { ReloLiveSweep(active: live, mask: AnyView(content.foregroundStyle(.white)), maskKey: "\(symbol)|\(label)") }
            .fixedSize()
    }
}

/// Finished work, as History shows it: one line, the state's symbol, the title, the project, the time.
struct ReloCompactRow: View {
    let row: NotchPresentation.Row
    var toggle: () -> Void = {}

    var body: some View {
        let color = ReloNotchTheme.color(row.tone)
        HStack(spacing: 8) {
            Image(systemName: ReloNotchTheme.symbol(row.tone))
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 16, height: 16)
                .background(Circle().fill(color.opacity(0.15)))
            Text(ReloDisplayName.readable(row.title) ?? LocalMode.untitled(local: ReloNotch.store.isLocal))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(row.unreadable ? ReloNotchTheme.secondaryText : .white)
                .lineLimit(1)
            if let project = ReloDisplayName.readable(row.project) {
                Text(project).font(ReloCardMetrics.meta).foregroundStyle(ReloNotchTheme.tertiaryText).lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(row.movedAt, style: .time)
                .font(ReloCardMetrics.meta.monospacedDigit())
                .foregroundStyle(ReloNotchTheme.tertiaryText)
        }
        .padding(.horizontal, 12)
        .frame(height: ReloCardMetrics.rowHeight)
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
    }
}

/// Rows grouped on one surface with hairlines between them (the iPhone's CardGroup).
struct ReloCardGroup<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).padding(.leading, 12) }
                row(item)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous))
        .background(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous).fill(ReloCardMetrics.fill))
        .overlay(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous).strokeBorder(ReloCardMetrics.border))
    }
}

/// One computer at work: a tile with its symbol (violet working, coral only waiting), its name, one chip per harness with its working count in violet
/// and its waiting count in coral, then the moving waveform and what it is doing. A working row carries a faint violet
/// sweep; a computer with nothing working or waiting dims and says Idle.
struct ReloMachineRow: View {
    let machine: NotchPresentation.Machine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let working = machine.working > 0
        let idle = machine.isIdle
        let tint = working ? ReloNotchTheme.running : ReloNotchTheme.secondaryText
        HStack(spacing: 8) {
            Image(systemName: machine.symbol ?? "laptopcomputer")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(working || idle ? tint : ReloNotchTheme.signalCoral)
                .frame(width: 20, height: 20)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(idle ? Color.white.opacity(0.06) : (working ? ReloNotchTheme.running : ReloNotchTheme.signalCoral).opacity(0.16)))
            Text(machine.name)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            ForEach(machine.harnesses.prefix(4)) { harness in
                chip(harness)
            }
            Spacer(minLength: 6)
            if working {
                Image(systemName: "waveform")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ReloNotchTheme.running)
                    .symbolEffect(.variableColor.iterative, options: .repeating, isActive: !reduceMotion)
            }
            Text(summary).font(ReloCardMetrics.meta).foregroundStyle(ReloNotchTheme.secondaryText.opacity(0.9)).lineLimit(1)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .overlay { ReloLiveSweep(active: working, tint: ReloNotchTheme.running).opacity(0.3) }
        .opacity(idle ? 0.55 : 1)
        .animation(ReloMotion.base, value: machine)
    }

    /// The harness's mark, then its working count in violet and its waiting count in coral (an idle harness: its mark).
    private func chip(_ harness: NotchPresentation.Machine.Harness) -> some View {
        HStack(spacing: 3) {
            ReloSourceMark(name: harness.source, size: 11)
            if harness.working > 0 { count(harness.working, ReloNotchTheme.running) }
            if harness.waiting > 0 { count(harness.waiting, ReloNotchTheme.signalCoral) }
        }
        .padding(.leading, 3)
        .padding(.trailing, harness.working + harness.waiting > 0 ? 6 : 3)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(harness.working == 0 && harness.waiting > 0 ? ReloNotchTheme.signalCoral.opacity(0.12) : Color.white.opacity(0.06)))
        .help(Self.tooltip(harness))
    }

    static func tooltip(_ harness: NotchPresentation.Machine.Harness) -> String {
        var text = "\(harness.source): \(harness.working) working, \(harness.waiting) waiting"
        if harness.idle > 0 { text += ", \(harness.idle) idle" }
        if harness.untracked > 0 { text += ", \(harness.untracked) not tracked: turn on Relo's hooks to see activity" }
        return text
    }

    private func count(_ value: Int, _ color: Color) -> some View {
        Text("\(value)").font(.system(size: 10, weight: .semibold).monospacedDigit()).foregroundStyle(color)
            .contentTransition(.numericText(value: Double(value)))
    }

    private var summary: String {
        let parts = [machine.working > 0 ? "\(machine.working) working" : nil, machine.waiting > 0 ? "\(machine.waiting) waiting" : nil]
            .compactMap { $0 }
        if parts.isEmpty { return machine.untracked > 0 ? "" : "Idle" }
        return parts.joined(separator: " · ")
    }
}
