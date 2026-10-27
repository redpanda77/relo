//
//  ReloUpdater.swift
//  Relo Notch
//
//  Updates (Sparkle). A remote install's feed is <server>/mac/appcast.xml, made at deploy from the build that server
//  serves; a local install (or a loopback server, which hands out no Mac app) uses the public release feed
//  (RELOAPIOrigin + /mac/appcast.xml). Both are signed with the deploy's EdDSA key (SUPublicEDKey). Sparkle checks
//  hourly and, with "Install updates automatically" on (the default), downloads in the background; a waiting update is
//  announced in the notch and the menu bar (Sparkle's gentle reminders, never its window) with Restart now or Later,
//  and installs at quit otherwise. A check the owner starts keeps Sparkle's own window. A build without a public key,
//  or a Mac with no feed yet, never checks.
//

import Combine
import Foundation
import OSLog
import ReloNotchKit
import Sparkle
import SwiftUI

@MainActor
final class ReloUpdater: NSObject, ObservableObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    static let shared = ReloUpdater()

    @Published private(set) var canCheck = false
    @Published private(set) var started = false
    /// An update that is waiting for the owner (ready to install, or found and not yet downloaded).
    struct Waiting: Equatable {
        let version: String
        let critical: Bool
        let downloaded: Bool
        static func == (a: Waiting, b: Waiting) -> Bool { a.version == b.version && a.critical == b.critical && a.downloaded == b.downloaded }
    }
    /// A one-line message after an update, shown a few seconds from the first time the notch or window opens.
    struct Notice: Equatable { let text: String }

    @Published private(set) var waiting: Waiting?
    @Published private(set) var notice: Notice?
    private var installNow: (() -> Void)?
    private var noticeTask: Task<Void, Never>?
    /// The "Updated to …" line, waiting for the first time the notch or the window is on screen.
    private var updatedText: String?
    private var snoozeTask: Task<Void, Never>?
    private static let snoozeVersionKey = "relo.update.snoozedVersion"
    private static let snoozeUntilKey = "relo.update.snoozedUntil"
    private static let launchedKey = "relo.lastLaunchedVersion"
    private var controller: SPUStandardUpdaterController?
    private static let log = Logger(subsystem: "relo.notch", category: "update")
    private var watch: AnyCancellable?

    /// The app's version as people read it everywhere: "Version 0.1.1", never with the build.
    static var versionLine: String { UpdatePolicy.versionText(shortVersion) }

    private var hasKey: Bool {
        !((Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String) ?? "").trimmingCharacters(in: .whitespaces).isEmpty
    }

    func start() {
        guard controller == nil, hasKey else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
        self.controller = controller
        started = true
        noteLaunchedVersion()
        watch = controller.updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main).sink { [weak self] in self?.canCheck = $0 }
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }

    /// The app's short version, for "Updated to 0.1.2".
    static var shortVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }

    // MARK: Waiting update

    /// The waiting update, unless the owner chose Later for it today.
    var visibleUpdate: Waiting? {
        guard let waiting else { return nil }
        let defaults = UserDefaults.standard
        let snoozed = UpdatePolicy.isSnoozed(version: waiting.version, snoozedVersion: defaults.string(forKey: Self.snoozeVersionKey),
                                             until: defaults.object(forKey: Self.snoozeUntilKey) as? Date, now: Date())
        return snoozed ? nil : waiting
    }

    #if DEBUG
    /// The click probe's view of the banner: an update waiting, and how many times Restart now ran.
    private(set) var probeRestarts = 0
    func probeWaiting(_ waiting: Waiting?) { self.waiting = waiting }
    #endif

    func restartNow() {
        #if DEBUG
        probeRestarts += 1
        #endif
        // Without the block (a reminder of an update found earlier), Sparkle's own window offers the install.
        Self.log.notice("restart now: \(self.installNow == nil ? "sparkle window" : "install", privacy: .public)")
        if let installNow { installNow() } else { controller?.checkForUpdates(nil) }
    }

    /// Hides the reminder until tomorrow; it comes back by itself.
    func later() {
        guard let waiting else { return }
        let until = UpdatePolicy.snoozedUntil(from: Date())
        UserDefaults.standard.set(waiting.version, forKey: Self.snoozeVersionKey)
        UserDefaults.standard.set(until, forKey: Self.snoozeUntilKey)
        objectWillChange.send()
        snoozeTask?.cancel()
        snoozeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(UpdatePolicy.snoozeInterval + 1))
            guard !Task.isCancelled else { return }
            self?.objectWillChange.send()
        }
    }

    private func wait(for item: SUAppcastItem, downloaded: Bool) {
        waiting = Waiting(version: item.displayVersionString, critical: item.isCriticalUpdate, downloaded: downloaded)
    }

    // MARK: After an update

    typealias AgentsRefresh = UpdatePolicy.AgentsRefresh

    /// The first launch of a new version: a one-line moment ("agents refreshed" only in local mode, once it ran). It
    /// waits for the first time the notch or the window opens, then shows for a few seconds; one already showing is
    /// updated in place.
    func announceUpdated(agents: AgentsRefresh) {
        let text = UpdatePolicy.updatedLine(version: Self.shortVersion, agents: agents)
        if notice != nil { show(text) } else { updatedText = text }
    }

    /// The notch or the main window is on screen: show the waiting "Updated to …" line, once.
    func surfaceNotice() {
        guard let text = updatedText else { return }
        updatedText = nil
        show(text)
    }

    /// A short line in the notch and the main window (the same moment "Updated to …" uses).
    func announce(_ text: String) { show(text) }

    private func show(_ text: String) {
        notice = Notice(text: text)
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    /// Outside local mode (which does it with its agent refresh), the first launch of a new version.
    private func noteLaunchedVersion() {
        guard !ReloLocalMode.isOn else { return }
        let now = ReloLocalMode.releaseKey
        let last = UserDefaults.standard.string(forKey: Self.launchedKey)
        UserDefaults.standard.set(now, forKey: Self.launchedKey)
        if last != nil, last != now { announceUpdated(agents: .notApplicable) }
    }

    var installsAutomatically: Bool {
        get { controller?.updater.automaticallyDownloadsUpdates ?? true }
        set {
            objectWillChange.send()
            controller?.updater.automaticallyDownloadsUpdates = newValue
        }
    }

    // MARK: SPUUpdaterDelegate

    /// The feed: the public release feed for a local install, else the signed-in server's; nil (no check) without one.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        MainActor.assumeIsolated {
            let release = (Bundle.main.object(forInfoDictionaryKey: "RELOAPIOrigin") as? String).flatMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }
            return UpdatePolicy.appcastURL(serverOrigin: ReloNotch.store.serverOrigin, releaseOrigin: release?.host == nil ? nil : release,
                                           localMode: ReloLocalMode.isOn)?.absoluteString
        }
    }

    /// A downloaded update that installs at quit: keep the block that installs it now, and say it is ready.
    /// True keeps Sparkle's update driver alive: the block reaches the installer only through it, and false aborts it
    /// (the block then does nothing, so Restart now did nothing). The prepared installer still installs at quit.
    nonisolated func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                             immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        nonisolated(unsafe) let block = immediateInstallHandler
        MainActor.assumeIsolated {
            installNow = { block() }
            wait(for: item, downloaded: true)
        }
        return true
    }

    // MARK: SPUStandardUserDriverDelegate (gentle reminders: the notch announces, never Sparkle's window)

    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    nonisolated func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool { false }

    nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        guard !state.userInitiated else { return }
        MainActor.assumeIsolated { wait(for: update, downloaded: state.stage != .notDownloaded) }
    }

    /// The owner opened Sparkle's own window: the reminder has done its job.
    nonisolated func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
        MainActor.assumeIsolated { waiting = nil; installNow = nil }
    }
}

// MARK: - Notch banner and menu item

/// A quiet line at the foot of the open notch: an update waiting (Restart now, Later) or the moment after one.
struct ReloUpdateBanner: View {
    @ObservedObject private var updater = ReloUpdater.shared

    var body: some View {
        if let update = updater.visibleUpdate {
            HStack(spacing: 10) {
                Image(systemName: update.critical ? "exclamationmark.arrow.circlepath" : "arrow.down.circle")
                    .foregroundStyle(update.critical ? ReloNotchTheme.warning : ReloNotchTheme.cyan)
                Text(update.critical ? "Important update" : update.downloaded ? "Relo \(update.version) is ready" : "Relo \(update.version) is available")
                    .font(.callout.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                Button("Later") { updater.later() }.buttonStyle(ReloPillButtonStyle(prominent: false))
                Button(update.downloaded ? "Restart now" : "Update") { updater.restartNow() }.buttonStyle(ReloPillButtonStyle(prominent: true))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.black.opacity(0.85), in: Capsule())
            .padding(.horizontal, 12).padding(.bottom, 6)
        } else if let notice = updater.notice {
            Text(notice.text)
                .font(.callout.weight(.medium)).foregroundStyle(ReloNotchTheme.ice).lineLimit(2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
                .transition(.opacity)
        }
    }
}

/// The menu bar line while an update waits.
struct ReloUpdateMenuItem: View {
    @ObservedObject private var updater = ReloUpdater.shared

    var body: some View {
        if let update = updater.waiting {
            Button(update.downloaded ? "Restart to update to \(update.version)" : "Update to \(update.version)…") { updater.restartNow() }
        }
    }
}
