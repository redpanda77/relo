import AppKit
import AuthenticationServices
import ReloCore

/// The Relo sign-in page in a system web sheet, ending at `relo://auth/callback` (as on the iPhone).
@MainActor
enum BrowserSignInSession {
    enum Failure: Error { case cancelled, unavailable }

    /// The web sheet attaches to Relo's own window (the onboarding or the main window, where sign-in starts). Only
    /// when none is open (sign-in started from the menu bar) does a small window hold it, closing when sign-in ends.
    private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        let window: NSWindow
        /// The window was made for this sign-in (and goes away after it), not one of Relo's own.
        let owned: Bool

        @MainActor override init() {
            // A titled window of Relo's own: never the notch's borderless panel.
            let candidates = [NSApp.keyWindow].compactMap { $0 } + NSApp.windows
            if let existing = candidates.first(where: { $0.isVisible && $0.canBecomeKey && $0.styleMask.contains(.titled) }) {
                window = existing
                owned = false
            } else {
                window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 120),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
                window.title = "Sign in to Relo"
                window.isReleasedWhenClosed = false
                window.center()
                owned = true
            }
            super.init()
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            MainActor.assumeIsolated { window }
        }

        func close() { if owned { window.orderOut(nil) } }
    }

    private static var active: (session: ASWebAuthenticationSession, anchor: Anchor)?

    /// Closes the web sheet of a sign-in the owner gave up on; its authenticate call ends as cancelled.
    static func cancel() {
        guard let current = active else { return }
        current.session.cancel()
        // The holder window of a menu-bar sign-in goes with it, even when the system's callback is slow to come.
        current.anchor.close()
    }

    static func authenticate(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let anchor = Anchor()
            // AuthenticationServices calls back on its own queue: the handler must not be main-actor
            // isolated (that traps), so it hops to the main actor itself.
            let completion: @Sendable (URL?, (any Error)?) -> Void = { callback, error in
                let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                Task { @MainActor in
                    active?.anchor.close()
                    active = nil
                    if let callback { continuation.resume(returning: callback) }
                    else if cancelled { continuation.resume(throwing: Failure.cancelled) }
                    else { continuation.resume(throwing: Failure.unavailable) }
                }
            }
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: BrowserSignIn.callbackScheme,
                                                     completionHandler: completion)
            session.presentationContextProvider = anchor
            // Reuse an existing web login so a signed-in owner only confirms.
            session.prefersEphemeralWebBrowserSession = false
            active = (session, anchor)
            NSApp.activate(ignoringOtherApps: true)
            anchor.window.makeKeyAndOrderFront(nil)
            if !session.start() {
                anchor.close()
                active = nil
                continuation.resume(throwing: Failure.unavailable)
            }
        }
    }
}
