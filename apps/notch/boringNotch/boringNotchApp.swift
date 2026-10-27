//
//  boringNotchApp.swift
//  boringNotchApp
//
//  Created by Harsh Vardhan  Goswami  on 02/08/24.
//

import Combine
import Defaults
import KeyboardShortcuts
import LaunchAtLogin
import ReloNotchKit
import SwiftUI

@main
struct DynamicNotchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Default(.menubarIcon) var showMenuBarIcon
    @Environment(\.openWindow) var openWindow

    var body: some Scene {
        MenuBarExtra(isInserted: $showMenuBarIcon) {
            Button("Open in Notch") {
                appDelegate.openRelo()
            }
            Button("Open Relo") {
                ReloHomeWindowController.shared.show()
            }
            ReloMenuItems()
            Divider()
            Button("Settings…") {
                DispatchQueue.main.async {
                    SettingsWindowController.shared.showWindow()
                }
            }
            .keyboardShortcut(KeyEquivalent(","), modifiers: .command)
            if ReloUpdater.shared.started {
                ReloUpdateMenuItem()
                Button("Check for Updates…") { ReloUpdater.shared.checkForUpdates() }
            }
            Divider()
            Button("Restart Relo") {
                ApplicationRelauncher.restart()
            }
            Button("Quit Relo", role: .destructive) {
                NSApplication.shared.terminate(self)
            }
            .keyboardShortcut(KeyEquivalent("Q"), modifiers: .command)
        } label: {
            ReloMenuBarIcon()
        }
    }
}

/// The menu bar icon follows Relo: something needs you, offline, signed out, or connected.
struct ReloMenuBarIcon: View {
    private let store = ReloNotch.store

    var body: some View {
        Image(systemName: symbol)
            .accessibilityLabel("Relo")
    }

    private var symbol: String {
        if store.presentation.needsYouCount > 0 { return "exclamationmark.circle.fill" }
        switch store.connection {
        case .offline: return LocalMode.offlineSymbol(local: store.isLocal)
        case .signedOut, .needsSignIn, .starting, .signingIn: return "circle.hexagongrid"
        case .connecting, .live: return "circle.hexagongrid.fill"
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem?
    var windows: [String: NSWindow] = [:] // UUID -> NSWindow
    var viewModels: [String: BoringViewModel] = [:] // UUID -> BoringViewModel
    var window: NSWindow?
    let vm: BoringViewModel = .init()
    @ObservedObject var coordinator = BoringViewCoordinator.shared
    var quickShareService = QuickShareService.shared
    var timer: Timer?
    var closeNotchTask: Task<Void, Never>?
    private var previousScreens: [NSScreen]?
    private var onboardingWindowController: NSWindowController?
    private var screenLockedObserver: Any?
    private var screenUnlockedObserver: Any?
    private var isScreenLocked: Bool = false
    private var windowScreenDidChangeObserver: Any?
    private var mouseUpMonitor: Any?
    private var dragDetectors: [String: DragDetector] = [:] // UUID -> DragDetector

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    /// A click on the Dock icon (or opening Relo again from Finder) brings up the main window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if onboardingWindowController?.window?.isVisible == true {
            onboardingWindowController?.window?.makeKeyAndOrderFront(nil)
        } else {
            ReloHomeWindowController.shared.show()
        }
        return true
    }

    /// Quitting plays its sound first (at most 2 s), when interface sounds are on.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard Defaults[.reloSounds], Defaults[.reloInterfaceSounds], !ReloMoments.quiet else { return .terminateNow }
        let length = min(ReloCuePlayer.shared.duration(.quit), 2)
        guard length > 0 else { return .terminateNow }
        ReloCuePlayer.shared.play(.quit)
        DispatchQueue.main.asyncAfter(deadline: .now() + length) { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        ReloUsageRail.shared.uninstall()
        NotificationCenter.default.removeObserver(self)
        if let observer = screenLockedObserver {
            DistributedNotificationCenter.default().removeObserver(observer)
            screenLockedObserver = nil
        }
        if let observer = screenUnlockedObserver {
            DistributedNotificationCenter.default().removeObserver(observer)
            screenUnlockedObserver = nil
        }
        MainActor.assumeIsolated { ReloNotch.usage.stop() }
        MusicManager.shared.destroy()
        cleanupDragDetectors()
        cleanupWindows()
    }

    @MainActor
    func onScreenLocked(_ notification: Notification) {
        isScreenLocked = true
        if !Defaults[.showOnLockScreen] {
            // Hide, never destroy: a window torn down at lock had to be rebuilt at unlock, and a
            // display still waking left no screen to rebuild on (the notch never came back).
            allNotchWindows.forEach { $0.orderOut(nil) }
        } else {
            enableSkyLightOnAllWindows()
        }
    }

    @MainActor
    func onScreenUnlocked(_ notification: Notification) {
        isScreenLocked = false
        if !Defaults[.showOnLockScreen] {
            recoverWindows()
        } else {
            disableSkyLightOnAllWindows()
        }
    }

    private var allNotchWindows: [NSWindow] {
        Defaults[.showOnAllDisplays] ? Array(windows.values) : [window].compactMap { $0 }
    }

    private var recoveryTask: Task<Void, Never>?

    /// Puts the notch back after unlock, wake or a display reconnecting: rebuild now, then check again
    /// while displays finish waking (`NSScreen` can be empty or stale for a moment).
    @MainActor
    func recoverWindows() {
        recoveryTask?.cancel()
        rebuildWindows()
        recoveryTask = Task { @MainActor [weak self] in
            for delay in [1.0, 3.0] {
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled, !self.isScreenLocked else { return }
                let visible = self.allNotchWindows.contains { $0.isVisible && $0.alphaValue > 0 }
                if !visible || NSScreen.screens.count != (self.previousScreens?.count ?? 0) { self.rebuildWindows() }
            }
        }
    }

    @MainActor
    private func rebuildWindows() {
        guard !NSScreen.screens.isEmpty else { return }
        cleanupWindows()
        adjustWindowPosition(changeAlpha: true)
        setupDragDetectors()
        previousScreens = NSScreen.screens
    }
    
    @MainActor
    private func enableSkyLightOnAllWindows() {
        if Defaults[.showOnAllDisplays] {
            windows.values.forEach { window in
                if let skyWindow = window as? BoringNotchSkyLightWindow {
                    skyWindow.enableSkyLight()
                }
            }
        } else {
            if let skyWindow = window as? BoringNotchSkyLightWindow {
                skyWindow.enableSkyLight()
            }
        }
    }
    
    @MainActor
    private func disableSkyLightOnAllWindows() {
        // Delay disabling SkyLight to avoid flicker during unlock transition
        Task {
            try? await Task.sleep(for: .milliseconds(150))
            await MainActor.run {
                if Defaults[.showOnAllDisplays] {
                    self.windows.values.forEach { window in
                        if let skyWindow = window as? BoringNotchSkyLightWindow {
                            skyWindow.disableSkyLight()
                        }
                    }
                } else {
                    if let skyWindow = self.window as? BoringNotchSkyLightWindow {
                        skyWindow.disableSkyLight()
                    }
                }
            }
        }
    }

    private func cleanupWindows(shouldInvert: Bool = false) {
        let shouldCleanupMulti = shouldInvert ? !Defaults[.showOnAllDisplays] : Defaults[.showOnAllDisplays]
        
        if shouldCleanupMulti {
            windows.values.forEach { window in
                window.close()
                NotchSpaceManager.shared.notchSpace.windows.remove(window)
            }
            windows.removeAll()
            viewModels.removeAll()
        } else if let window = window {
            window.close()
            NotchSpaceManager.shared.notchSpace.windows.remove(window)
            if let obs = windowScreenDidChangeObserver {
                NotificationCenter.default.removeObserver(obs)
                windowScreenDidChangeObserver = nil
            }
            self.window = nil
        }
    }

    private func cleanupDragDetectors() {
        dragDetectors.values.forEach { detector in
            detector.stopMonitoring()
        }
        dragDetectors.removeAll()
    }

    private func setupDragDetectors() {
        cleanupDragDetectors()

        guard Defaults[.expandedDragDetection] else { return }

        if Defaults[.showOnAllDisplays] {
            for screen in NSScreen.screens {
                setupDragDetectorForScreen(screen)
            }
        } else {
            let preferredScreen: NSScreen? = window?.screen
                ?? NSScreen.screen(withUUID: coordinator.selectedScreenUUID)
                ?? NSScreen.main

            if let screen = preferredScreen {
                setupDragDetectorForScreen(screen)
            }
        }
    }

    private func setupDragDetectorForScreen(_ screen: NSScreen) {
        guard let uuid = screen.displayUUID else { return }
        
        let screenFrame = screen.frame
        let notchHeight = openNotchSize.height
        let notchWidth = openNotchSize.width
        
        // Create notch region at the top-center of the screen where an open notch would occupy
        let notchRegion = CGRect(
            x: screenFrame.midX - notchWidth / 2,
            y: screenFrame.maxY - notchHeight,
            width: notchWidth,
            height: notchHeight
        )
        
        let detector = DragDetector(notchRegion: notchRegion)
        
        detector.onDragEntersNotchRegion = { [weak self] in
            Task { @MainActor in
                self?.handleDragEntersNotchRegion(onScreen: screen)
            }
        }
        
        dragDetectors[uuid] = detector
        detector.startMonitoring()
    }

    private func handleDragEntersNotchRegion(onScreen screen: NSScreen) {
        guard let uuid = screen.displayUUID else { return }
        
        if Defaults[.showOnAllDisplays], let viewModel = viewModels[uuid] {
            viewModel.open()
            coordinator.currentView = .shelf
        } else if !Defaults[.showOnAllDisplays], let windowScreen = window?.screen, screen == windowScreen {
            vm.open()
            coordinator.currentView = .shelf
        }
    }

    private func createBoringNotchWindow(for screen: NSScreen, with viewModel: BoringViewModel) -> NSWindow {
        let rect = NSRect(x: 0, y: 0, width: windowSize.width, height: windowSize.height)
        let styleMask: NSWindow.StyleMask = [.borderless, .nonactivatingPanel, .utilityWindow, .hudWindow]
        
        let window = BoringNotchSkyLightWindow(contentRect: rect, styleMask: styleMask, backing: .buffered, defer: false)
        
        // Enable SkyLight only when screen is locked
        if isScreenLocked {
            window.enableSkyLight()
        } else {
            window.disableSkyLight()
        }

        let hosting = NSHostingView(
            rootView: ContentView()
                .environmentObject(viewModel)
        )
        // The window has a fixed frame: without this, every SwiftUI update (each animation tick) recomputes the
        // hosting view's intrinsic and min/max sizes and lays out the whole window.
        hosting.sizingOptions = []
        window.contentView = hosting

        window.orderFrontRegardless()
        NotchSpaceManager.shared.notchSpace.windows.insert(window)

        // Observe when the window's screen changes so we can update drag detectors
        windowScreenDidChangeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeScreenNotification,
            object: window,
            queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.setupDragDetectors()
                }
        }
        return window
    }

    @MainActor
    private func positionWindow(_ window: NSWindow, on screen: NSScreen, changeAlpha: Bool = false) {
        if changeAlpha {
            window.alphaValue = 0
        }

        let screenFrame = screen.frame
        window.setFrameOrigin(
            NSPoint(
                x: screenFrame.origin.x + (screenFrame.width / 2) - window.frame.width / 2,
                y: screenFrame.origin.y + screenFrame.height - window.frame.height
            ))
        window.alphaValue = 1
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if ReloSnapshot.runIfRequested() { exit(0) }
        #endif
        // The unsandboxed build's first launch: bring Relo's settings over from the old container before they are read.
        ReloNotchStore.migrateLegacyDefaults()
        ReloNotch.store.localPortProvider = { ReloServerService.shared.server.port() }
        // A sign-in that waits for the server's approval: Relo works on this Mac meanwhile and moves by itself (set before start).
        ReloPendingApproval.shared.install()
        ReloNotch.store.start(leaveLocal: { _ = await ReloLocalMode.connectToServerInstead(ignoringProblems: true) })
        ReloLocalMode.onLaunch()
        ReloUsageMoments.install()
        ReloNotch.usage.start()
        ReloUsageRail.shared.install()
        // Server mode heals here (local mode does it once its server answers, inside onLaunch).
        if !ReloLocalMode.isOn { ReloLaunchHealing.onLaunch() }
        // The Relo voice downloads on its own (unmetered networks only) and its first render after an install or an
        // update, which sets up the GPU, happens here once. Spoken: right away, so "Relo is ready" and the first
        // update are not waiting on it. Sound only: after 30 s, off the owner's way.
        if Defaults[.reloVoiceButton] {
            if ReloVoiceMode.current.speaks {
                ReloNotch.voice.start()
            } else {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(30))
                    if Defaults[.reloVoiceButton] { ReloNotch.voice.start() }
                }
            }
        }
        // Relo is a Dock app: its main window is where opening "the app" lands; the notch stays the live surface.
        NSApp.setActivationPolicy(.regular)
        ReloHomeWindowController.shared.openNotch = { [weak self] in self?.openRelo() }
        // After sleep or a network change, read Relo's Now at once instead of at the next tick.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in ReloNotch.store.refreshNow() }
        }
        // Displays wake after the Mac: put the notch back then, and after a user switch.
        for name in [NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, !self.isScreenLocked else { return }
                    self.recoverWindows()
                }
            }
        }
        // A drag that ends in another app never tells the notch it left: clear the drop targets on
        // that mouse-up so the drop overlay or an opened shelf is not stuck.
        mouseUpMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                for model in [self.vm] + Array(self.viewModels.values) where model.anyDropZoneTargeting {
                    model.dragDetectorTargeting = false
                    model.generalDropTargeting = false
                    model.dropZoneTargeting = false
                }
            }
        }

        // A Mac that is not set up (a reinstall keeps the "onboarded" flag, a login that was removed) gets the
        // onboarding wherever the main window would have asked it to sign in.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(showOnboardingForSetup(_:)),
            name: .reloNeedsSetup,
            object: nil
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenConfigurationDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )

        NotificationCenter.default.addObserver(
            forName: Notification.Name.selectedScreenChanged, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in
                self?.adjustWindowPosition(changeAlpha: true)
                self?.setupDragDetectors()
            }
        }

        NotificationCenter.default.addObserver(
            forName: Notification.Name.notchHeightChanged, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in
                self?.adjustWindowPosition()
                self?.setupDragDetectors()
            }
        }

        NotificationCenter.default.addObserver(
            forName: Notification.Name.automaticallySwitchDisplayChanged, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self = self, let window = self.window else { return }
            Task { @MainActor in
                window.alphaValue = self.coordinator.selectedScreenUUID == self.coordinator.preferredScreenUUID ? 1 : 0
            }
        }

        NotificationCenter.default.addObserver(
            forName: Notification.Name.showOnAllDisplaysChanged, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.cleanupWindows(shouldInvert: true)
                self.adjustWindowPosition(changeAlpha: true)
                self.setupDragDetectors()
            }
        }

        NotificationCenter.default.addObserver(
            forName: Notification.Name.expandedDragDetectionChanged, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in
                self?.setupDragDetectors()
            }
        }

        // Use closure-based observers for DistributedNotificationCenter and keep tokens for removal
        screenLockedObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(rawValue: "com.apple.screenIsLocked"),
            object: nil, queue: .main) { [weak self] notification in
                Task { @MainActor in
                    self?.onScreenLocked(notification)
                }
        }

        screenUnlockedObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(rawValue: "com.apple.screenIsUnlocked"),
            object: nil, queue: .main) { [weak self] notification in
                Task { @MainActor in
                    self?.onScreenUnlocked(notification)
                }
        }

        KeyboardShortcuts.onKeyDown(for: .toggleSneakPeek) { [weak self] in
            guard let self = self else { return }
            if Defaults[.sneakPeekStyles] == .inline {
                let newStatus = !self.coordinator.expandingView.show
                self.coordinator.toggleExpandingView(status: newStatus, type: .music)
            } else {
                self.coordinator.toggleSneakPeek(
                    status: !self.coordinator.sneakPeek.show,
                    type: .music,
                    duration: 3.0
                )
            }
        }

        KeyboardShortcuts.onKeyDown(for: .toggleNotchOpen) { [weak self] in
            Task { [weak self] in
                guard let self = self else { return }

                let mouseLocation = NSEvent.mouseLocation

                var viewModel = self.vm

                if Defaults[.showOnAllDisplays] {
                    for screen in NSScreen.screens {
                        if screen.frame.contains(mouseLocation) {
                            if let uuid = screen.displayUUID, let screenViewModel = self.viewModels[uuid] {
                                viewModel = screenViewModel
                                break
                            }
                        }
                    }
                }

                self.closeNotchTask?.cancel()
                self.closeNotchTask = nil

                switch viewModel.notchState {
                case .closed:
                    await MainActor.run {
                        viewModel.open()
                    }

                    let task = Task { [weak viewModel] in
                        do {
                            try await Task.sleep(for: .seconds(3))
                            await MainActor.run {
                                // Opened by the shortcut: close after 3 s unless the pointer is on it.
                                guard let viewModel, !viewModel.cursorIsOverNotch() else { return }
                                viewModel.close()
                            }
                        } catch { }
                    }
                    self.closeNotchTask = task
                case .open:
                    await MainActor.run {
                        viewModel.close()
                    }
                }
            }
        }

        if !Defaults[.showOnAllDisplays] {
            let viewModel = self.vm
            let window = createBoringNotchWindow(
                for: NSScreen.main ?? NSScreen.screens.first!, with: viewModel)
            self.window = window
            adjustWindowPosition(changeAlpha: true)
        } else {
            adjustWindowPosition(changeAlpha: true)
        }

        setupDragDetectors()
        // The notch is created: what is not needed for the first draw starts after it, and the draw is timed.
        DispatchQueue.main.async {
            LaunchClock.mark("first notch draw")
            ReloMoments.shared.start()
            ReloUpdater.shared.start()
        }

        if coordinator.firstLaunch {
            DispatchQueue.main.async {
                self.showOnboardingWindow()
            }
        } else if !LaunchAtLogin.wasLaunchedAtLogin
            && !(MusicManager.shared.isNowPlayingDeprecated && Defaults[.mediaController] == .nowPlaying)
        {
            // Opened from the Dock, Finder or Spotlight: the main window and the launch sound. Started at login:
            // quietly, notch only.
            DispatchQueue.main.async {
                ReloCuePlayer.shared.play(.launch)
                ReloHomeWindowController.shared.show()
            }
        } else if MusicManager.shared.isNowPlayingDeprecated
            && Defaults[.mediaController] == .nowPlaying
        {
            DispatchQueue.main.async {
                self.showOnboardingWindow(step: .musicPermission)
            }
        }

        previousScreens = NSScreen.screens
    }

    /// Opens the notch on Relo's tab, on the display under the pointer when the notch is on every display.
    /// Opened from the menu, it closes again after a few seconds unless the pointer is on it.
    @MainActor
    func openRelo() {
        var viewModel = vm
        if Defaults[.showOnAllDisplays] {
            let mouseLocation = NSEvent.mouseLocation
            let screen = NSScreen.screens.first { $0.frame.contains(mouseLocation) } ?? NSScreen.main
            if let uuid = screen?.displayUUID, let screenViewModel = viewModels[uuid] {
                viewModel = screenViewModel
            }
        }
        closeNotchTask?.cancel()
        coordinator.currentView = .relo
        viewModel.open()
        closeNotchTask = Task { [weak viewModel] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let viewModel, !viewModel.cursorIsOverNotch() else { return }
                viewModel.close()
            }
        }
    }

    func deviceHasNotch() -> Bool {
        if #available(macOS 12.0, *) {
            for screen in NSScreen.screens {
                if screen.safeAreaInsets.top > 0 {
                    return true
                }
            }
        }
        return false
    }

    @objc func screenConfigurationDidChange() {
        let currentScreens = NSScreen.screens

        let screensChanged =
            currentScreens.count != previousScreens?.count
            || Set(currentScreens.compactMap { $0.displayUUID })
                != Set(previousScreens?.compactMap { $0.displayUUID } ?? [])
            || Set(currentScreens.map { $0.frame }) != Set(previousScreens?.map { $0.frame } ?? [])

        previousScreens = currentScreens

        if screensChanged {
            DispatchQueue.main.async { [weak self] in
                self?.cleanupWindows()
                self?.adjustWindowPosition()
                self?.setupDragDetectors()
            }
        }
    }

    @objc func adjustWindowPosition(changeAlpha: Bool = false) {
        if Defaults[.showOnAllDisplays] {
            let currentScreenUUIDs = Set(NSScreen.screens.compactMap { $0.displayUUID })

            // Remove windows for screens that no longer exist
            for uuid in windows.keys where !currentScreenUUIDs.contains(uuid) {
                if let window = windows[uuid] {
                    window.close()
                    NotchSpaceManager.shared.notchSpace.windows.remove(window)
                    windows.removeValue(forKey: uuid)
                    viewModels.removeValue(forKey: uuid)
                }
            }

            // Create or update windows for all screens
            for screen in NSScreen.screens {
                guard let uuid = screen.displayUUID else { continue }
                
                if windows[uuid] == nil {
                    let viewModel = BoringViewModel(screenUUID: uuid)
                    let window = createBoringNotchWindow(for: screen, with: viewModel)

                    windows[uuid] = window
                    viewModels[uuid] = viewModel
                }

                if let window = windows[uuid], let viewModel = viewModels[uuid] {
                    positionWindow(window, on: screen, changeAlpha: changeAlpha)

                    if viewModel.notchState == .closed {
                        viewModel.close()
                    }
                }
            }
        } else {
            let selectedScreen: NSScreen

            if let preferredScreen = NSScreen.screen(withUUID: coordinator.preferredScreenUUID ?? "") {
                coordinator.selectedScreenUUID = coordinator.preferredScreenUUID ?? ""
                selectedScreen = preferredScreen
            } else if Defaults[.automaticallySwitchDisplay], let mainScreen = NSScreen.main,
                      let mainUUID = mainScreen.displayUUID {
                coordinator.selectedScreenUUID = mainUUID
                selectedScreen = mainScreen
            } else if let fallback = NSScreen.main ?? NSScreen.screens.first, let uuid = fallback.displayUUID {
                // The chosen display is gone (asleep, unplugged): show on the one there is, never nowhere.
                coordinator.selectedScreenUUID = uuid
                selectedScreen = fallback
            } else {
                if let window = window {
                    window.alphaValue = 0
                }
                return
            }

            vm.screenUUID = selectedScreen.displayUUID
            vm.notchSize = getClosedNotchSize(screenUUID: selectedScreen.displayUUID)
            // A notch drawn on a screen without one leaves the MacBook's real notch plain: say where it went.
            let placed = "\(String((selectedScreen.displayUUID ?? "none").prefix(8))) \(selectedScreen.safeAreaInsets.top > 0 ? "with a notch" : "without a notch")"
            ReloNotch.wingsLog.notice("notch placed on screen \(placed, privacy: .public) of \(NSScreen.screens.count)")

            if window == nil {
                window = createBoringNotchWindow(for: selectedScreen, with: vm)
            }

            if let window = window {
                positionWindow(window, on: selectedScreen, changeAlpha: changeAlpha)

                if vm.notchState == .closed {
                    vm.close()
                }
            }
        }
    }

    @objc func togglePopover(_ sender: Any?) {
        if window?.isVisible == true {
            window?.orderOut(nil)
        } else {
            window?.orderFrontRegardless()
        }
    }

    @objc func showMenu() {
        statusItem?.menu?.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    @objc func quitAction() {
        NSApplication.shared.terminate(self)
    }

    /// Sign in with no server chosen: a Mac that was set up before opens straight on the server screen ("server" as the
    /// notification's object says so; "hello" asks for the whole first run); a first launch gets the full Hello.
    @objc private func showOnboardingForSetup(_ note: Notification) {
        let asked = note.object as? String
        let startAtServer = asked == "server" || (asked != "hello" && !BoringViewCoordinator.shared.firstLaunch)
        showOnboardingWindow(startAt: startAtServer ? .server : nil)
    }

    private func showOnboardingWindow(step: OnboardingStep = .welcome, startAt: ReloOnboardingProgress.Screen? = nil) {
        // A closed onboarding starts afresh (its flow resumes from what was saved).
        if onboardingWindowController?.window?.isVisible != true { onboardingWindowController = nil }
        if onboardingWindowController == nil {
            // A setup that quit half way leaves no background server running behind the onboarding.
            Task { @MainActor in await ReloOnboardingProgress.cleanUpHalfSetup() }
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 680),
                styleMask: [.titled, .closable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.center()
            window.title = "Welcome to Relo"
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.contentView = NSHostingView(
                rootView: OnboardingView(
                    step: step,
                    startAt: startAt,
                    // The window has shrunk into the notch: Relo stays there and in the menu bar.
                    onFinish: {
                        window.orderOut(nil)
                        window.close()
                    },
                    onOpenSettings: {
                        window.close()
                        SettingsWindowController.shared.showWindow()
                    }
                ))
            window.isRestorable = false
            window.identifier = NSUserInterfaceItemIdentifier(OnboardingWindow.identifier)

            onboardingWindowController = NSWindowController(window: window)
        }

        NSApp.activate(ignoringOtherApps: true)
        onboardingWindowController?.window?.makeKeyAndOrderFront(nil)
        onboardingWindowController?.window?.orderFrontRegardless()
    }
}

extension Notification.Name {
    static let selectedScreenChanged = Notification.Name("SelectedScreenChanged")
    static let reloNeedsSetup = Notification.Name("ReloNeedsSetup")
    static let notchHeightChanged = Notification.Name("NotchHeightChanged")
    static let showOnAllDisplaysChanged = Notification.Name("showOnAllDisplaysChanged")
    static let automaticallySwitchDisplayChanged = Notification.Name("automaticallySwitchDisplayChanged")
    static let expandedDragDetectionChanged = Notification.Name("expandedDragDetectionChanged")
}

extension CGRect: @retroactive Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(origin.x)
        hasher.combine(origin.y)
        hasher.combine(size.width)
        hasher.combine(size.height)
    }

    public static func == (lhs: CGRect, rhs: CGRect) -> Bool {
        return lhs.origin == rhs.origin && lhs.size == rhs.size
    }
}
