//
//  SettingsWindowController.swift
//  boringNotch
//
//  Created by Alexander on 2025-06-14.
//

import AppKit
import SwiftUI
import Defaults

class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()
    private let visibility = ReloWindowVisibility()
    /// Whether the window currently holds its SwiftUI tree (dropped on close so nothing animates unseen).
    private var hasContent = false
    
    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        
        super.init(window: window)
        
        setupWindow()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    private func setupWindow() {
        guard let window = window else { return }
        
        window.title = "Relo Settings"
        // Glass, as Relo's main window: the desktop blurred through it, the sidebar under the traffic lights.
        ReloGlass.prepare(window)
        window.isMovableByWindowBackground = true
        
        // Make it behave like a regular app window with proper Spaces support
        window.collectionBehavior = [.managed, .participatesInCycle, .fullScreenAuxiliary]
        
        // Ensure proper window behavior
        window.hidesOnDeactivate = false
        window.isExcludedFromWindowsMenu = false
        
        // Configure window to be a standard document-style window
        window.isRestorable = true
        window.identifier = NSUserInterfaceItemIdentifier("ReloNotchSettingsWindow")
        
        // Handle window closing
        window.delegate = self
    }
    
    /// The page Settings opens on, asked for by `showWindow(page:)` before its view exists.
    static var requestedPage: String?
    static let showPage = Notification.Name("ReloSettingsShowPage")

    /// Opens Settings on one of its pages ("Agents"), from the notch or the onboarding.
    func showWindow(page: String) {
        Self.requestedPage = page
        showWindow()
        NotificationCenter.default.post(name: Self.showPage, object: page)
    }

    /// The SwiftUI content is built when the window opens and released when it closes.
    private func buildContentIfNeeded() {
        guard !hasContent, let window else { return }
        // SettingsView reads the requested page once when built; it is cleared so the next plain open starts on Relo.
        let page = Self.requestedPage
        Self.requestedPage = nil
        let root = ReloWindowRoot(visibility: visibility) { SettingsView(page: page) }
        window.contentView = NSHostingView(rootView: root)
        hasContent = true
    }

    func showWindow() {
        // Set app to regular mode first
        NSApp.setActivationPolicy(.regular)
        buildContentIfNeeded()
        defer { visibility.refresh(window) }
        
        // If window is already visible, bring it to front properly
        if window?.isVisible == true {
            NSApp.activate(ignoringOtherApps: true)
            window?.orderFrontRegardless()
            window?.makeKeyAndOrderFront(nil)
            return
        }
        
        // Show the window with proper ordering
        window?.orderFrontRegardless()
        window?.makeKeyAndOrderFront(nil)
        window?.center()
        
        // Activate the app and ensure window gets focus
        NSApp.activate(ignoringOtherApps: true)
        
        // Force window to front after activation
        DispatchQueue.main.async { [weak self] in
            self?.window?.makeKeyAndOrderFront(nil)
        }
    }
    
    override func close() {
        super.close()
        relinquishFocus()
    }
    
    private func relinquishFocus() {
        window?.orderOut(nil)
        // Relo is a Dock app: closing Settings keeps its Dock icon.
    }
}

extension SettingsWindowController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        relinquishFocus()
        // Release the whole animated tree; showWindow() builds it again.
        window?.contentView = NSView()
        hasContent = false
        visibility.refresh(nil)
    }

    func windowDidMiniaturize(_ notification: Notification) { visibility.refresh(window) }
    func windowDidDeminiaturize(_ notification: Notification) { visibility.refresh(window) }
    func windowDidChangeOcclusionState(_ notification: Notification) { visibility.refresh(window) }
    
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        return true
    }
    
    func windowDidBecomeKey(_ notification: Notification) {
        // Ensure app is in regular mode when window becomes key
        NSApp.setActivationPolicy(.regular)
    }
    
    func windowDidResignKey(_ notification: Notification) {
    }
    
}
