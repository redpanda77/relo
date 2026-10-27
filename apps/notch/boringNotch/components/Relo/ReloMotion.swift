//
//  ReloMotion.swift
//  Relo for Mac
//
//  One pause signal and one clock for every authored effect, ported from the iPhone's ReloAtmosphere: an effect
//  draws only while someone can see it, and holds its frame otherwise.
//

import AppKit
import Observation
import SwiftUI

/// Set by a window root (or a container) when its animated surface cannot be seen: the window is closed, covered or
/// minimized, or the notch is closed over open-state content. Effects stop drawing and hold their frame.
struct ReloMotionPausedKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var reloMotionPaused: Bool {
        get { self[ReloMotionPausedKey.self] }
        set { self[ReloMotionPausedKey.self] = newValue }
    }
}

/// What pauses motion for the whole app: the displays asleep, the session switched away or locked, Low Power Mode,
/// a hot Mac. Each window adds its own visibility on top through `\.reloMotionPaused`.
@MainActor
@Observable
final class ReloMotionSignal {
    static let shared = ReloMotionSignal()

    private(set) var screensAsleep = false
    private(set) var sessionInactive = false
    private(set) var screenLocked = false
    private(set) var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    private(set) var hot = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue

    /// Nothing animated can be seen, or the Mac asked for less work.
    var paused: Bool { screensAsleep || sessionInactive || screenLocked || lowPower || hot }

    @ObservationIgnored private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    private init() {
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.screensDidSleepNotification) { $0.screensAsleep = true }
        observe(workspace, NSWorkspace.screensDidWakeNotification) { $0.screensAsleep = false }
        observe(workspace, NSWorkspace.sessionDidResignActiveNotification) { $0.sessionInactive = true }
        observe(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { $0.sessionInactive = false }
        let distributed = DistributedNotificationCenter.default()
        observe(distributed, Notification.Name("com.apple.screenIsLocked")) { $0.screenLocked = true }
        observe(distributed, Notification.Name("com.apple.screenIsUnlocked")) { $0.screenLocked = false }
        observe(.default, .NSProcessInfoPowerStateDidChange) { $0.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled }
        observe(.default, ProcessInfo.thermalStateDidChangeNotification) {
            $0.hot = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
        }
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name, _ apply: @escaping @MainActor (ReloMotionSignal) -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if let self { apply(self) } }
        }
        observers.append((center, token))
    }
}

/// An effect's time, shared by every host (SwiftUI's clock below, the Metal layers): it runs while the effect is seen,
/// holds where it stopped when it is not, and goes back to the authored `still` frame when motion is not wanted at all
/// (Reduce Motion, the effect switched off, Low Power Mode, a hot Mac). Time carries on from where it stopped, so nothing
/// jumps when it resumes.
final class ReloMotionTimeline {
    let still: TimeInterval
    /// Time shown when it last stopped, and when it started again (nil while stopped).
    private(set) var held: TimeInterval?
    private(set) var resumedAt: Date?

    init(still: TimeInterval) { self.still = still }

    var running: Bool { resumedAt != nil }

    func time(at date: Date) -> TimeInterval {
        let base = held ?? still
        guard let resumedAt else { return base }
        return base + max(0, date.timeIntervalSince(resumedAt))
    }

    func resume(at date: Date = .now) {
        if resumedAt == nil { resumedAt = date }
    }

    /// Stops: holds this frame when the effect is only out of sight, else returns to the still frame.
    @MainActor
    func stop(holding: Bool, at date: Date = .now) {
        guard resumedAt != nil else { return }
        held = holding && !ReloMotionSignal.shared.lowPower && !ReloMotionSignal.shared.hot ? time(at: date) : nil
        resumedAt = nil
    }
}

/// One clock for every authored effect. It ticks only while the view is on screen, its window can be seen
/// (`\.reloMotionPaused`), the Mac is awake and cool, and the person has not asked for less motion or power; otherwise
/// it holds the frame it last showed (`still` before it first ticks). Time carries on from where it stopped, so nothing
/// jumps when the clock resumes.
/// Appearance is tracked on one container that never changes: on a Group the modifiers went to each copy (ticking and
/// still), whose onAppear and onDisappear raced and could leave the clock stopped for good. A fresh TimelineView starts
/// each time it ticks: one created paused never resumed.
struct ReloMotionClock<Content: View>: View {
    var live = true
    var framesPerSecond: Double = 30
    var still: TimeInterval = 42
    @ViewBuilder let content: (TimeInterval) -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloMotionPaused) private var paused
    @State private var visible = false
    @State private var timeline: ReloMotionTimeline?
    /// Bumped when the timeline starts or stops, so the body reads its new time.
    @State private var generation = 0

    private var signal: ReloMotionSignal { .shared }

    private var ticking: Bool { live && visible && !paused && !signal.paused && !reduceMotion }

    private func time(at date: Date) -> TimeInterval {
        _ = generation
        return timeline?.time(at: date) ?? still
    }

    var body: some View {
        ZStack {
            if ticking {
                TimelineView(.animation(minimumInterval: 1 / framesPerSecond)) { timeline in
                    content(time(at: timeline.date))
                }
            } else {
                content(time(at: .now))
            }
        }
        .onChange(of: ticking, initial: true) { _, now in
            let clock = timeline ?? ReloMotionTimeline(still: still)
            timeline = clock
            if now {
                clock.resume()
            } else {
                // Out of view or asleep: hold this frame. Asked for less motion (or the effect is switched off, or
                // the Mac is saving power): back to the authored still frame.
                clock.stop(holding: live && !reduceMotion)
            }
            generation += 1
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }
}
