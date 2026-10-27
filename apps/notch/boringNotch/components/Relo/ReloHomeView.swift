//
//  ReloHomeView.swift
//  Relo
//
//  Relo's main window, opened from the Dock or Finder: whether this Mac is connected, what needs you and what runs,
//  and the ways in (the notch, the Dashboard, Settings, updates). The notch stays the live surface; this window is
//  where someone who opened "the app" lands. Glass, with the notch's motion (docs/internal/product/mac-glass-study).
//

import AppKit
import ReloNotchKit
import SwiftUI

final class ReloHomeWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    static let shared = ReloHomeWindowController()
    /// Set by the app delegate: opens the notch on the screen under the pointer.
    var openNotch: () -> Void = {}
    private let visibility = ReloWindowVisibility()
    /// Whether the window currently holds its SwiftUI tree (dropped on close so nothing animates unseen).
    private var hasContent = false

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1060, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Relo"
        ReloGlass.prepare(window)
        window.toolbarStyle = .unified
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 780, height: 520)
        window.collectionBehavior = [.managed, .participatesInCycle, .fullScreenPrimary]
        window.identifier = NSUserInterfaceItemIdentifier("ReloHomeWindow")
        window.setFrameAutosaveName("ReloHomeWindow")
        super.init(window: window)
        window.delegate = self
        // The actions live in the window's own unified toolbar: the title bar takes clicks there (a SwiftUI row drawn
        // under it does not), and its buttons share the traffic lights' centre line.
        let toolbar = NSToolbar(identifier: "ReloHomeToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static let actions = NSToolbarItem.Identifier("ReloHomeActions")

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.actions] }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.actions] }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard id == Self.actions else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        item.view = NSHostingView(rootView: ReloWindowRoot(visibility: visibility) {
            ReloHomeToolbar(openNotch: { [weak self] in self?.openNotch() }).padding(.trailing, 6)
        })
        item.isBordered = false
        return item
    }

    func show() {
        NSApp.setActivationPolicy(.regular)
        buildContentIfNeeded()
        if window?.isVisible != true { window?.center() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        visibility.refresh(window)
    }

    private func buildContentIfNeeded() {
        guard !hasContent, let window else { return }
        let root = ReloWindowRoot(visibility: visibility) {
            ReloHomeView(openNotch: { [weak self] in self?.openNotch() })
        }
        window.contentView = NSHostingView(rootView: root)
        hasContent = true
    }

    func windowWillClose(_ notification: Notification) {
        // Release the whole animated tree; show() builds it again.
        window?.contentView = NSView()
        hasContent = false
        visibility.refresh(nil)
    }

    func windowDidMiniaturize(_ notification: Notification) { visibility.refresh(window) }
    func windowDidDeminiaturize(_ notification: Notification) { visibility.refresh(window) }
    func windowDidChangeOcclusionState(_ notification: Notification) { visibility.refresh(window) }
}

struct ReloHomeView: View {
    let openNotch: () -> Void
    private let store = ReloNotch.store
    @State private var expandedID: String?
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var signedIn: Bool { [.connecting, .live, .offline].contains(store.connection) }

    var body: some View {
        let mood = ReloOrb.mood(store.presentation)
        ZStack {
            ReloGlassBackdrop(tint: mood == .needsYou ? ReloNotchTheme.signalCoral : ReloNotchTheme.running,
                              second: mood == .clear ? ReloNotchTheme.blue : ReloNotchTheme.azure)
            if signedIn && !(store.isLocal && (store.localStartFailed || store.localStarting)) {
                HStack(alignment: .top, spacing: 20) {
                    aside.frame(width: 340)
                    work.frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 22).padding(.top, 6).padding(.bottom, 22)
            } else if store.isLocal {
                ReloLocalProblemView()
            } else if ReloPendingApproval.shared.pending != nil {
                ReloPendingApprovalPanel()
            } else {
                ReloHomeNeedsSetup()
            }
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                ReloPendingApprovalBanner()
                ReloUpdateBanner()
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            withAnimation(ReloMotion.or(ReloMotion.smooth, reduced: reduceMotion)) { appeared = true }
            ReloUpdater.shared.surfaceNotice()
            // Home counts as a look, like opening the notch.
            store.markLooked()
        }
    }

    // MARK: Aside: the orb and what matters now; the computers and their sessions

    private var aside: some View {
        VStack(spacing: 16) {
            stage.reloEntrance(0, appeared)
            sessions.reloEntrance(1, appeared)
        }
    }

    private var stage: some View {
        let presentation = store.presentation
        let mood = ReloOrb.mood(presentation)
        let frozen = presentation.isFrozen(offline: store.connection == .offline, lastUpdated: store.lastUpdated)
        let color = Self.moodColor(mood)
        return VStack(spacing: 10) {
            // The iPhone's deck: the orb in its instrument, the four readouts docked on the gauge ring, sessions in orbit.
            ReloHomeDeck(presentation: presentation, offline: frozen)
                .scaleEffect(appeared ? 1 : 0.9).opacity(appeared ? 1 : 0)
            Text(frozen ? "\(Self.sentence(NotchPresentation.asOf(store.lastUpdated ?? presentation.servedAt))). Relo is offline, so this may be out of date." : subline(presentation))
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.62))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 6)
        }
        .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 18)
        .frame(maxWidth: .infinity)
        .background {
            ReloStateWash(color: color, strength: mood == .clear ? 0.5 : 0.85, urgent: mood == .needsYou)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .reloGlass(radius: 22)
        .animation(ReloMotion.base, value: mood)
    }

    private static func sentence(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// One plain sentence under the headline: what leads, and whether anything waits on the owner.
    private func subline(_ presentation: NotchPresentation) -> String {
        let counts = presentation.counts
        let running = counts.running
        if counts.needsYou > 0 {
            let others = running > 0 ? (running == 1 ? " One more is running." : " \(running) more are running.") : ""
            return (counts.needsYou == 1 ? "A question is waiting for you." : "Questions are waiting for you.") + others
        }
        if let focus = presentation.focus, focus.tone.isMoving, let title = ReloDisplayName.readable(focus.title) {
            if let done = focus.stepsDone, let total = focus.stepsTotal, total > 0, done < total {
                // The server's own step position, as the iPhone's "Step 2 of 5".
                let step = focus.currentIndex ?? (focus.currentStep == nil ? nil : done + 1)
                return step.map { "\(title) is on step \($0) of \(total). Nothing needs you." } ?? "\(title) is running (\(done) of \(total) done). Nothing needs you."
            }
            return "\(title) is running. Nothing needs you."
        }
        return "Work from your sessions and scripts shows up here and in the notch."
    }

    private var sessions: some View {
        let presentation = store.presentation
        let machines = presentation.shownMachines
        // The sessions of the computers listed below, so the header and the rows agree.
        let live = machines.reduce(0) { $0 + $1.sessions.count }
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                ReloGlassSectionHeader(title: "Sessions", count: live, color: ReloDeckTheme.sessions)
                if !machines.isEmpty {
                    Text(machines.count == 1 ? "1 computer" : "\(machines.count) computers")
                        .font(.system(size: 11)).foregroundStyle(.white.opacity(0.4))
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 6)
            if machines.isEmpty {
                Text("No session is open right now.")
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.45))
                    .padding(.horizontal, 12).padding(.vertical, 8)
            } else {
                VStack(spacing: 10) {
                    ForEach(machines.prefix(5)) { ReloHomeMachineRow(machine: $0) }
                }
                .padding(.horizontal, 6)
            }
            Spacer(minLength: 8)
            if store.isLocal {
                Label(LocalMode.onThisMac, systemImage: "laptopcomputer")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.38))
                    .padding(.horizontal, 12)
            } else if let host = store.serverOrigin?.host() {
                Label(host, systemImage: "lock.fill")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.38))
                    .padding(.horizontal, 12)
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .reloGlass(radius: 22)
    }

    static func moodColor(_ mood: ReloOrb.Mood) -> Color {
        switch mood {
        case .needsYou: ReloNotchTheme.signalCoral
        case .running: ReloNotchTheme.azure
        case .clear: ReloNotchTheme.blue
        }
    }

    // MARK: Work: the notch's sections, one column, answerable here

    @ViewBuilder
    private var work: some View {
        let presentation = store.presentation
        let offline = store.connection == .offline
        let sections = presentation.sections.filter { !$0.isFolded && !$0.rows.isEmpty }
        // Plain notices (`relo notify`) when no iPhone gets them: this Mac is where they show.
        let notices = store.showsNotices ? store.notices : []
        if sections.isEmpty && notices.isEmpty {
            VStack(spacing: 8) {
                Text("Nothing needs you").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                Text("Work from your sessions and scripts shows up here and in the notch, live.")
                    .font(.system(size: 12.5)).foregroundStyle(ReloNotchTheme.secondaryText).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let recap = presentation.sinceYouLooked {
                        Label("Since you looked: \(recap)", systemImage: "clock.arrow.circlepath")
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.7))
                            .padding(.horizontal, 13).padding(.vertical, 7)
                            .reloGlass(radius: 999)
                    }
                    if !store.waitingComputers.isEmpty && !store.isLocal {
                        ReloWaitingComputers(computers: store.waitingComputers,
                                             approve: { id in Task { await store.approveComputer(id: id) } },
                                             decline: { id in store.declineComputer(id: id) })
                    }
                    if presentation.hasUnreadable && !store.isLocal && store.waitingComputers.isEmpty {
                        Label("Approve this Mac on your iPhone to read private work", systemImage: "lock.fill")
                            .font(.system(size: 11.5, weight: .medium)).foregroundStyle(ReloNotchTheme.warning)
                            .padding(.horizontal, 13).padding(.vertical, 7)
                            .reloGlass(radius: 999, tint: ReloNotchTheme.warning)
                    }
                    ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                        VStack(alignment: .leading, spacing: 10) {
                            ReloGlassSectionHeader(title: section.title, count: section.rows.count,
                                                   color: ReloNotchTheme.color(Self.tone(section)).reloLight(0.25))
                            if section.kind == .recent {
                                ReloCardGroup(items: Array(section.rows.prefix(6))) { row in
                                    if expandedID == row.id { card(row, offline: offline) } else { ReloCompactRow(row: row) { toggle(row.id) } }
                                }
                                .reloGlass(radius: ReloCardMetrics.radius)
                            } else {
                                ForEach(section.rows.prefix(8)) { row in
                                    card(row, hero: section.kind == .needsYou, offline: offline)
                                }
                            }
                        }
                        .reloEntrance(index + 2, appeared)
                    }
                    if !notices.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ReloGlassSectionHeader(title: "Recent notices", count: notices.count, color: ReloNotchTheme.secondaryText)
                            ReloCardGroup(items: notices) { ReloNoticeRow(notice: $0) }
                                .reloGlass(radius: ReloCardMetrics.radius)
                        }
                        .reloEntrance(sections.count + 2, appeared)
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(.top, 4)
                .padding(.bottom, 12)
                .animation(ReloMotion.snappy, value: presentation)
                .animation(ReloMotion.snappy, value: notices)
            }
            .scrollIndicators(.never)
        }
    }

    /// A card on glass: the state's light rising from its bottom edge while it moves or waits on the owner, and the
    /// notch's beams when a step finishes (once) or while a question waits (repeating).
    private func card(_ row: NotchPresentation.Row, hero: Bool = false, offline: Bool) -> some View {
        let color = ReloNotchTheme.color(row.tone)
        let lit = row.tone.isMoving || row.tone == .needsYou || row.tone == .yourTurn
        return ReloWorkCard(row: row, hero: hero, expanded: expandedID == row.id, offline: offline) { toggle(row.id) }
            .background {
                if lit {
                    ReloStateWash(color: color, strength: row.tone == .needsYou ? 1 : 0.7, urgent: row.tone == .needsYou)
                        .clipShape(RoundedRectangle(cornerRadius: ReloCardMetrics.radius, style: .continuous))
                }
            }
            .reloGlass(radius: ReloCardMetrics.radius, tint: row.tone == .needsYou ? color : nil)
            .overlay {
                ReloEdgeBeams(color: color, radius: ReloCardMetrics.radius, repeating: row.questionPending,
                              trigger: row.stepsDone ?? 0)
            }
            .transition(.opacity.combined(with: .offset(y: 8)))
    }

    private func toggle(_ id: String) {
        withAnimation(ReloMotion.or(ReloMotion.snappy, reduced: reduceMotion)) { expandedID = expandedID == id ? nil : id }
    }

    static func tone(_ section: NotchPresentation.Section) -> NotchPresentation.Tone {
        switch section.kind {
        case .needsYou: .needsYou
        case .waitingOnYou: .yourTurn
        case .running: .working
        case .recent: .done
        case .quiet: .quiet
        case .paused: .paused
        }
    }
}

/// One notice in the Recent notices list: where it came from, its title and first line, and when.
struct ReloNoticeRow: View {
    let notice: MacNotice

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "bell")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ReloNotchTheme.running.reloLight(0.3))
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(ReloDisplayName.readable(notice.title) ?? notice.title)
                    .font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white).lineLimit(2)
                if let summary = notice.summary {
                    Text(summary).font(ReloCardMetrics.status).foregroundStyle(ReloNotchTheme.secondaryText).lineLimit(2)
                }
                if let source = ReloDisplayName.readable(notice.source) {
                    Text(source).font(ReloCardMetrics.meta).foregroundStyle(ReloNotchTheme.tertiaryText).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(notice.createdAt, style: .time)
                .font(ReloCardMetrics.meta.monospacedDigit()).foregroundStyle(ReloNotchTheme.tertiaryText)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }
}

/// The orb on its stage: a halo in its colour, one satellite circling per live card or session, and rings going out
/// while something needs the owner (the closed notch's orbit, large).
/// One computer in the main window, as the iPhone's Sessions card: a header (its tile with the lead dot, its name, a
/// summary, a chip per harness), then a row per session (its harness, its name, its phase).
struct ReloHomeMachineRow: View {
    let machine: NotchPresentation.Machine
    /// Rows shown before "N more".
    private let shown = 4

    var body: some View {
        let rows = Array(machine.sessions.prefix(shown))
        VStack(spacing: 0) {
            header
                .overlay(alignment: .bottom) {
                    if !rows.isEmpty { Rectangle().fill(.white.opacity(0.08)).frame(height: 0.5) }
                }
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, session in
                ReloHomeSessionRow(session: session)
                    .overlay(alignment: .top) {
                        if index > 0 { Rectangle().fill(.white.opacity(0.07)).frame(height: 0.5).padding(.leading, 40) }
                    }
            }
            if machine.sessions.count > shown {
                Text("\(machine.sessions.count - shown) more")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.42))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 12).frame(minHeight: 30)
                    .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.07)).frame(height: 0.5).padding(.leading, 40) }
            }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.09), lineWidth: 0.5))
        .opacity(machine.isIdle ? 0.6 : 1)
        .animation(ReloMotion.base, value: machine)
    }

    /// The machine's most urgent phase: needs you, your turn, working; nil when idle (a dim dot, no glow).
    private var dot: Color? {
        if machine.sessions.contains(where: { $0.phase == .waiting && $0.waitingFor == "input" }) { return ReloDeckTheme.orange }
        if machine.waiting > 0 { return ReloDeckTheme.amber }
        if machine.working > 0 { return ReloDeckTheme.sessions }
        return nil
    }

    /// "2 sessions · running", "3 sessions · 1 needs you", "1 session · your turn", "Idle".
    private var summary: String {
        let count = machine.sessions.count
        let sessions = "\(count) \(count == 1 ? "session" : "sessions")"
        let needs = machine.sessions.filter { $0.phase == .waiting && $0.waitingFor == "input" }.count
        if needs > 0 { return "\(sessions) · \(needs) \(needs == 1 ? "needs" : "need") you" }
        if machine.waiting > 0 { return "\(sessions) · your turn" }
        if machine.working > 0 { return "\(sessions) · running" }
        return machine.isIdle ? "Idle" : sessions
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: machine.symbol ?? "laptopcomputer")
                .font(.system(size: 14, weight: .light)).foregroundStyle(Color(red: 0xD3 / 255, green: 0xD8 / 255, blue: 0xE2 / 255))
                .frame(width: 28, height: 28)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.white.opacity(0.14), lineWidth: 0.5))
                .overlay(alignment: .topTrailing) {
                    Circle().fill(dot ?? .white.opacity(0.3)).frame(width: 7, height: 7)
                        .shadow(color: dot ?? .clear, radius: dot == nil ? 0 : 3)
                        .offset(x: 2, y: -2)
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(machine.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(1).truncationMode(.middle)
                Text(summary).font(.system(size: 11)).foregroundStyle(.white.opacity(0.42)).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(machine.harnesses.prefix(3)) { harness in
                HStack(spacing: 4) {
                    ReloSourceMark(name: harness.source, size: 10)
                    Text("\(harness.total)").font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color(red: 0xC9 / 255, green: 0xCF / 255, blue: 0xDB / 255))
                }
                .padding(.horizontal, 6).frame(height: 20)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}

/// A session in its computer's card: its harness, its name, and its phase as a chip (a wave while it works).
struct ReloHomeSessionRow: View {
    let session: NotchPresentation.Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloMotionPaused) private var motionPaused

    private var chip: (label: String, tint: Color) {
        switch session.phase {
        case .working?: ("Working", ReloDeckTheme.sessions)
        case .waiting?: session.waitingFor == "input" ? ("Needs you", ReloDeckTheme.orange) : ("Your turn", ReloDeckTheme.amber)
        case .idle?: ("Idle", ReloDeckTheme.slate)
        default: ("Seen \(session.lastSeenAt.formatted(.relative(presentation: .numeric, unitsStyle: .narrow)))", ReloDeckTheme.slate)
        }
    }

    var body: some View {
        let working = session.phase == .working
        let chip = chip
        HStack(spacing: 9) {
            ReloSourceMark(name: session.source ?? "Agent", size: 10)
                .frame(width: 20, height: 20)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text(ReloDisplayName.readable(session.title) ?? ReloDisplayName.readable(session.project) ?? "Session")
                .font(.system(size: 12.5, weight: .medium)).foregroundStyle(Color(red: 0xE9 / 255, green: 0xEC / 255, blue: 0xF2 / 255))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                if working {
                    Image(systemName: "waveform")
                        .symbolEffect(.variableColor.iterative, options: .repeating, isActive: !reduceMotion && !motionPaused && !ReloMotionSignal.shared.paused)
                }
                Text(chip.label.uppercased()).lineLimit(1)
            }
            .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(chip.tint)
            .padding(.horizontal, 7).frame(height: 19)
            .background(chip.tint.opacity(0.15), in: Capsule())
            .overlay(Capsule().strokeBorder(chip.tint.opacity(0.3), lineWidth: 0.75))
            .fixedSize()
        }
        .padding(.horizontal, 10).frame(minHeight: 40)
        .accessibilityElement(children: .combine)
    }
}

/// A status dot that breathes a ring outward while live.
struct ReloLiveDot: View {
    let color: Color
    var live = true

    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .background {
                ReloLoopView(key: color, live: live) { root, size in
                    let ring = CALayer()
                    ring.frame = CGRect(origin: .zero, size: size)
                    ring.cornerRadius = size.width / 2
                    ring.backgroundColor = ReloLoop.cgColor(color)
                    ring.add(ReloLoop.animation("transform.scale", period: 2.4) { 1 + 1.4 * ReloEase.ripple($0, 2.4) }, forKey: "scale")
                    ring.add(ReloLoop.animation("opacity", period: 2.4) { 0.55 * (1 - ReloEase.ripple($0, 2.4)) }, forKey: "opacity")
                    root.addSublayer(ring)
                }
                .frame(width: 7, height: 7)
            }
    }
}

/// Signed out: the same two choices as the notch's signed-out panel (try Relo on this Mac, or sign in), with a line of
/// progress while the stored login is read or a sign-in runs. The window never hides itself: setup is the owner's call.
struct ReloHomeNeedsSetup: View {
    private let store = ReloNotch.store

    private var starting: Bool { store.connection == .starting }
    private var signingIn: Bool { store.connection == .signingIn }
    private var again: Bool { store.connection == .needsSignIn }
    private var localFirst: Bool { ReloLocalMode.canRunHere && !again }

    private var title: String {
        if starting { return "Starting Relo…" }
        return again ? "Sign in to Relo again" : "Choose how to start"
    }

    private var line: String {
        if starting { return "One moment." }
        if signingIn { return "Finish signing in in your browser." }
        if let problem = store.problem { return problem }
        // A server was chosen but no sign-in finished: Relo on this Mac is not blocked behind it.
        if ReloLocalMode.canRunHere, store.originChosen, !again { return PendingApproval.signInLater }
        return ReloLocalMode.canRunHere ? "Try Relo on this Mac now, or sign in to see your agents on your iPhone too."
            : "Sign in to see your agents here and on your iPhone."
    }

    var body: some View {
        VStack(spacing: 18) {
            ReloOrb(mood: .clear).frame(width: 110, height: 110)
            VStack(spacing: 4) {
                Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                Text(line)
                    .font(.system(size: 12.5))
                    .foregroundStyle(store.problem != nil && !signingIn && !starting ? ReloNotchTheme.warning : ReloNotchTheme.secondaryText)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            if !starting {
                HStack(spacing: 10) {
                    if localFirst { tryHere }
                    ReloNotchChoice(icon: "person.crop.circle", title: signingIn ? "Signing in…" : "Sign in",
                                    detail: signingIn ? "Waiting for your browser" : "With your Relo account",
                                    prominent: !localFirst, busy: signingIn) {
                        if !signingIn { ReloLocalMode.signInOrSetUp() }
                    }
                    if ReloLocalMode.canRunHere && !localFirst { tryHere }
                }
                .frame(maxWidth: 480)
                if signingIn {
                    Button("Cancel") { store.cancelSignIn() }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ReloNotchTheme.secondaryText).underline()
                        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                } else {
                    Button("Can't sign in?") { ReloLocalMode.cantSignIn() }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ReloNotchTheme.secondaryText).underline()
                        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                }
            }
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var tryHere: some View {
        ReloNotchChoice(icon: "laptopcomputer", title: "Try it on this Mac", detail: "No account needed",
                        prominent: localFirst) { ReloLocalMode.runHere() }
    }
}

/// The main window's toolbar row, hosted in the window's own toolbar so its buttons take clicks and sit on the traffic
/// lights' centre line: the connection, then the ways out (the notch, the Dashboard, updates, Settings).
struct ReloHomeToolbar: View {
    let openNotch: () -> Void
    private let store = ReloNotch.store

    var body: some View {
        HStack(spacing: 10) {
            syncChip
            Button(action: openNotch) {
                HStack(spacing: 7) {
                    Image(systemName: "rectangle.topthird.inset.filled").font(.system(size: 12, weight: .medium))
                    Text("Open in Notch")
                    Text("⌘⇧I").foregroundStyle(.white.opacity(0.45)).fontWeight(.medium)
                }
            }
            .buttonStyle(ReloGlassButtonStyle())
            .help("Open in Notch (⌘⇧I)")
            if !store.isLocal, let url = store.dashboardURL { iconButton("safari", "Open the Dashboard") { NSWorkspace.shared.open(url) } }
            if ReloUpdater.shared.started { iconButton("arrow.down.circle", "Check for Updates…") { ReloUpdater.shared.checkForUpdates() } }
            iconButton("gearshape", "Settings") { SettingsWindowController.shared.showWindow() }
        }
        .fixedSize()
    }

    @ViewBuilder
    private var syncChip: some View {
        let offline = store.connection == .offline
        let local = store.isLocal
        HStack(spacing: 7) {
            if offline {
                Image(systemName: LocalMode.offlineSymbol(local: local)).foregroundStyle(ReloNotchTheme.warning)
            } else {
                ReloLiveDot(color: ReloNotchTheme.done, live: store.lastUpdated != nil)
            }
            if let updated = store.lastUpdated {
                Text(offline ? "\(LocalMode.offlineLabel(local: local)) · as of \(updated.formatted(date: .omitted, time: .shortened))"
                             : "Live · \(updated.formatted(date: .omitted, time: .shortened))")
            } else {
                Text(offline ? LocalMode.offlineLabel(local: local) : (local ? LocalMode.starting : "Connecting"))
            }
        }
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .foregroundStyle(.white.opacity(0.7))
        .padding(.horizontal, 12).padding(.vertical, 7)
        .reloGlass(radius: 999)
    }

    private func iconButton(_ symbol: String, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.86))
                .frame(width: 32, height: 32)
                .reloGlass(radius: 16)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}
