//
//  ReloUsageRail.swift
//  Relo Notch
//
//  The optional usage side rail: the notch turned sideways on a screen edge, one ring per plan account. This file
//  holds the state (ReloUsageRailModel), the panel and the controller that creates, positions and hides it. The
//  drawing is ReloUsageRailView. Off by default (`usageRail`).
//
//  Click-through: the panel is as small as what it shows (a 15 pt strip when tucked, the rail's width when open, the
//  card's width too while a ring is hovered) and ignores the mouse altogether; it never becomes key.
//
//  The window mechanics (a non-activating borderless panel, a plain container view holding the hosting view, the
//  edge-anchored frame rebuilt on screen changes, and hover read from the cursor by a polling timer plus global and
//  local mouse-moved monitors) follow codenotch (Notch/NotchPanel.swift, NotchWindowController.swift,
//  NotchHostingView.swift), MIT License, Copyright (c) 2026 Vinz.
//

import AppKit
import Combine
import Defaults
import Observation
import os
import ReloNotchKit
import SwiftUI

enum ReloUsageRailLevel { case tucked, compact }

@MainActor
@Observable
final class ReloUsageRailModel {
    static let cardWidth: CGFloat = 214
    static let cardHeight: CGFloat = 172
    static let cardGap: CGFloat = 8
    static let curl: CGFloat = 12
    static let tuckedWidth: CGFloat = 5
    static let tuckedHit: CGFloat = 10

    /// The accounts to show (connected and not hidden; one without a reading yet shows an empty ring).
    private(set) var accounts: [UsageAccount] = []
    private(set) var always = false
    private(set) var rightEdge = true
    private(set) var pointerInside = false
    private(set) var hoveredID: String?

    @ObservationIgnored var onLayout: (() -> Void)?
    @ObservationIgnored private var foldTask: Task<Void, Never>?

    /// Always compact at rest; "On hover" tucks to a strip until the pointer comes. The details are the card.
    var level: ReloUsageRailLevel { always || pointerInside ? .compact : .tucked }

    var bodyWidth: CGFloat { level == .tucked ? Self.tuckedWidth : 36 }

    var rowHeight: CGFloat { level == .tucked ? 14 : 26 }

    /// A row plus the 12 pt gap, split so the hover area has no dead strip between rings.
    var slot: CGFloat { rowHeight + 12 }
    var railHeight: CGFloat { 2 * Self.curl + 16 + CGFloat(accounts.count) * slot }

    var hoveredIndex: Int? { accounts.firstIndex { $0.id == hoveredID } }
    var cardShown: Bool { level != .tucked && hoveredIndex != nil }

    var panelSize: CGSize {
        let width = level == .tucked ? Self.tuckedWidth + Self.tuckedHit
            : bodyWidth + (cardShown ? Self.cardGap + Self.cardWidth : 0)
        return CGSize(width: width, height: max(railHeight, cardShown ? Self.cardHeight : 0))
    }

    /// Where the card's top sits in the panel: centred on the hovered ring, kept inside.
    var cardTop: CGFloat {
        guard let index = hoveredIndex else { return 0 }
        let height = panelSize.height
        let railTop = (height - railHeight) / 2
        let centre = railTop + Self.curl + 8 + CGFloat(index) * slot + slot / 2
        return min(max(centre - Self.cardHeight / 2, 0), max(0, height - Self.cardHeight))
    }

    func apply(accounts: [UsageAccount], always: Bool, rightEdge: Bool) {
        let changed = self.accounts != accounts || self.always != always || self.rightEdge != rightEdge
        self.accounts = accounts
        self.always = always
        self.rightEdge = rightEdge
        if hoveredID != nil, hoveredIndex == nil { hoveredID = nil }
        if changed { relayout() }
    }

    /// The pointer touched or left the panel's frame (its own tracking area).
    func pointer(_ inside: Bool) {
        foldTask?.cancel()
        if inside {
            if !pointerInside { Task { await ReloNotch.usage.refreshBecauseLooking() } }
            guard !pointerInside else { return }
            pointerInside = true
            relayout()
        } else {
            foldTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(300))
                guard let self, !Task.isCancelled else { return }
                self.pointerInside = false
                self.hoveredID = nil
                self.relayout()
            }
        }
    }

    /// The ring under the pointer. Gaps between rings, the curls and the way to the card keep the current one, so
    /// the card moves from ring to ring instead of closing and opening again; leaving the rail clears it (pointer).
    func hover(_ id: String) {
        guard level != .tucked, hoveredID != id else { return }
        let opening = hoveredID == nil
        hoveredID = id
        if opening { relayout() }
    }

    private func relayout() {
        onLayout?()
    }
}

/// A panel that never takes focus and never takes the mouse: hover is read from the cursor position (see RailSlot),
/// as codenotch does, because a tracking area on a non-activating panel is unreliable.
private final class RailPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .mainMenu + 2 // under the notch window (+3), over the menu bar's own windows
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        alphaValue = 1
        isMovable = false
        isMovableByWindowBackground = false
        isFloatingPanel = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        ignoresMouseEvents = true
        appearance = NSAppearance(named: .darkAqua)
    }
}

/// The panel's content view: it holds the hosting view and nothing else, so SwiftUI is not the content view and its
/// ideal size never drives the window (codenotch's NotchContainerView). It claims no mouse point.
private final class RailContainerView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// One screen's rail: its panel and model. The frame grows at once and shrinks after the content has folded.
@MainActor
private final class RailSlot {
    let uuid: String
    let model = ReloUsageRailModel()
    let panel: RailPanel
    private let host: NSHostingView<ReloUsageRailView>
    private var shrink: DispatchWorkItem?
    private var pointerWasInside = false

    init(uuid: String) {
        self.uuid = uuid
        panel = RailPanel(contentRect: NSRect(x: 0, y: 0, width: 15, height: 100))
        host = NSHostingView(rootView: ReloUsageRailView(model: model))
        host.sizingOptions = []
        let container = RailContainerView(frame: NSRect(x: 0, y: 0, width: 15, height: 100))
        container.autoresizesSubviews = true
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        panel.contentView = container
        model.onLayout = { [weak self] in self?.layout() }
    }

    var screen: NSScreen? { NSScreen.screens.first { $0.displayUUID == uuid } }

    /// The rail's panel rect for a size: flush to the screen's edge (the full frame, not the visible one, so it sits
    /// against the bezel under the menu bar's height too), centred vertically. AppKit coordinates, y up.
    private func rect(for size: CGSize, on screen: NSScreen) -> NSRect {
        let frame = screen.frame
        let x = model.rightEdge ? frame.maxX - size.width : frame.minX
        return NSRect(x: x, y: (frame.midY - size.height / 2).rounded(), width: size.width, height: size.height)
    }

    func layout() {
        guard let screen else { return }
        shrink?.cancel()
        let target = model.panelSize
        let current = panel.isVisible ? panel.frame.size : .zero
        let union = CGSize(width: max(target.width, current.width), height: max(target.height, current.height))
        place(union, on: screen)
        if union != target {
            let work = DispatchWorkItem { [weak self] in
                guard let self, let screen = self.screen else { return }
                self.place(self.model.panelSize, on: screen)
            }
            shrink = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
        }
    }

    private func place(_ size: CGSize, on screen: NSScreen) {
        let rect = rect(for: size, on: screen)
        if panel.frame != rect { panel.setFrame(rect, display: true) }
    }

    func show() {
        layout()
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func hide() {
        shrink?.cancel()
        pointerWasInside = false
        model.pointer(false)
        if panel.isVisible { panel.orderOut(nil) }
    }

    func close() {
        shrink?.cancel()
        panel.orderOut(nil)
        panel.contentView = nil
        panel.close()
    }

    /// Reads the cursor against the rail's own geometry (not the panel frame, which lags the content while it
    /// shrinks): inside the rail strip or the open card is "pointer inside"; the ring under it is the hovered one.
    func track(_ mouse: NSPoint) {
        guard panel.isVisible, let screen else { return }
        let size = model.panelSize
        let area = rect(for: size, on: screen)
        let rightEdge = model.rightEdge
        var inside = false
        var hovered: Int?
        if area.contains(mouse) {
            let bodyWidth = model.level == .tucked ? size.width : model.bodyWidth
            // The rail plus the gap before the card: crossing it to reach the card is still the rail.
            let reach = bodyWidth + (model.cardShown ? ReloUsageRailModel.cardGap : 0)
            let onRail = rightEdge ? mouse.x >= area.maxX - reach : mouse.x <= area.minX + reach
            let yDown = area.maxY - mouse.y
            let railTop = (size.height - model.railHeight) / 2
            let relative = yDown - railTop - ReloUsageRailModel.curl - 8
            if onRail {
                inside = yDown >= railTop && yDown <= railTop + model.railHeight
                if inside, model.level != .tucked, relative >= 0 {
                    let index = Int(relative / model.slot)
                    if index < model.accounts.count { hovered = index }
                }
            }
            if !inside, model.cardShown {
                let top = model.cardTop
                inside = yDown >= top && yDown <= top + ReloUsageRailModel.cardHeight
            }
        }
        if inside != pointerWasInside {
            pointerWasInside = inside
            model.pointer(inside)
        }
        if inside, let hovered, model.accounts.indices.contains(hovered) {
            model.hover(model.accounts[hovered].id)
        }
    }
}

@MainActor
final class ReloUsageRail {
    static let shared = ReloUsageRail()

    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.relo.notch", category: "UsageRail")
    private var slots: [String: RailSlot] = [:]
    private var cancellables = Set<AnyCancellable>()
    private var timer: Timer?
    private var cursorTimer: Timer?
    private var monitors: [Any] = []
    private var installed = false
    private var lastReason = ""

    /// Starts observing the settings, the accounts, full-screen apps and screen changes. Called once at launch.
    func install() {
        guard !installed else { return }
        installed = true
        let keys: [AnyPublisher<Void, Never>] = [
            Defaults.publisher(.usageRail).map { _ in }.eraseToAnyPublisher(),
            Defaults.publisher(.usageRailEdge).map { _ in }.eraseToAnyPublisher(),
            Defaults.publisher(.usageHiddenAccounts).map { _ in }.eraseToAnyPublisher(),
            Defaults.publisher(.showOnAllDisplays).map { _ in }.eraseToAnyPublisher(),
            Defaults.publisher(.reloQuietInFullScreen).map { _ in }.eraseToAnyPublisher(),
            FullscreenMediaDetector.shared.$fullscreenStatus.map { _ in }.eraseToAnyPublisher(),
            NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
                .map { _ in }.eraseToAnyPublisher(),
            NotificationCenter.default.publisher(for: NSWorkspace.activeSpaceDidChangeNotification)
                .map { _ in }.eraseToAnyPublisher(),
        ]
        Publishers.MergeMany(keys)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.update() }
            .store(in: &cancellables)
        // Windows that reset are dropped as time passes; also re-asserts the panels in case the system dropped one.
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.update() }
        }
        startCursorTracking()
        observeAccounts()
        log.debug("install: usageRail=\(Defaults[.usageRail], privacy: .public), accounts=\(ReloNotch.usage.accounts.count)")
        update()
    }

    func uninstall() {
        cancellables.removeAll()
        timer?.invalidate()
        timer = nil
        stopCursorTracking()
        slots.values.forEach { $0.close() }
        slots.removeAll()
        installed = false
    }

    /// Hover is read from the cursor, as codenotch does: a polling timer (catches a still pointer and a rail that
    /// grew under it) plus global and local mouse-moved monitors (prompt, and they work for a non-activating panel).
    private func startCursorTracking() {
        let tick: () -> Void = { [weak self] in
            MainActor.assumeIsolated { self?.trackCursor() }
        }
        let poll = Timer(timeInterval: 0.25, repeats: true) { _ in tick() }
        RunLoop.main.add(poll, forMode: .common)
        cursorTimer = poll
        let events: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: events, handler: { _ in tick() }) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: events, handler: { event in tick(); return event }) {
            monitors.append(local)
        }
    }

    private func stopCursorTracking() {
        cursorTimer?.invalidate()
        cursorTimer = nil
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors.removeAll()
    }

    private func trackCursor() {
        guard !slots.isEmpty else { return }
        let mouse = NSEvent.mouseLocation
        slots.values.forEach { $0.track(mouse) }
    }

    private func observeAccounts() {
        withObservationTracking {
            _ = ReloNotch.usage.accounts
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.installed else { return }
                self.update()
                self.observeAccounts()
            }
        }
    }

    private func note(_ reason: String) {
        guard reason != lastReason else { return }
        lastReason = reason
        log.debug("rail: \(reason, privacy: .public)")
    }

    private func update() {
        guard installed else { return }
        let setting = Defaults[.usageRail]
        guard setting == "hover" || setting == "always" else {
            note("hidden: setting is \(setting)")
            return tearDown()
        }
        let now = Date()
        let hidden = Defaults[.usageHiddenAccounts]
        let all = ReloNotch.usage.accounts
        // An account without a reading yet keeps its ring as an empty track, so a rail turned on is there at once.
        let accounts = all.filter { $0.connected && !hidden.contains($0.id) }.map { $0.live(now: now) }
        let screens = Defaults[.showOnAllDisplays] ? NSScreen.screens : Array(NSScreen.screens.prefix(1))
        let wanted = Set(screens.compactMap(\.displayUUID))
        for uuid in slots.keys where !wanted.contains(uuid) {
            slots[uuid]?.close()
            slots[uuid] = nil
        }
        var shown = 0
        var reasons: [String] = []
        for screen in screens {
            guard let uuid = screen.displayUUID else { reasons.append("screen without a display id"); continue }
            let fullScreen = Defaults[.reloQuietInFullScreen] && FullscreenMediaDetector.shared.fullscreenStatus[uuid] == true
            if accounts.isEmpty || fullScreen {
                reasons.append(accounts.isEmpty
                    ? "no connected, unhidden accounts (\(all.count) known, \(hidden.count) hidden)"
                    : "a full-screen app is in front")
                slots[uuid]?.hide()
                continue
            }
            let slot = slots[uuid] ?? RailSlot(uuid: uuid)
            let opening = slots[uuid] == nil || !slot.panel.isVisible
            slots[uuid] = slot
            slot.model.apply(accounts: accounts, always: setting == "always", rightEdge: Defaults[.usageRailEdge] != "left")
            slot.show()
            shown += 1
            if opening && setting == "always" { Task { await ReloNotch.usage.refreshBecauseLooking() } }
        }
        if shown > 0 {
            note("shown: \(setting), \(accounts.count) accounts on \(shown) screen(s), edge \(Defaults[.usageRailEdge])")
        } else {
            note("hidden: " + (reasons.isEmpty ? "no screens" : reasons.joined(separator: "; ")))
        }
    }

    private func tearDown() {
        slots.values.forEach { $0.close() }
        slots.removeAll()
    }
}
