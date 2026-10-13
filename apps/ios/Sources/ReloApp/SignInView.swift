import AuthenticationServices
import ReloCore
import SwiftUI

/// Runs one ASWebAuthenticationSession and returns the `relo://auth/callback` URL.
@MainActor
enum BrowserSignInSession {
    enum Failure: Error { case cancelled, unavailable }

    private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.flatMap(\.windows).first ?? ASPresentationAnchor()
        }
    }

    private static var active: (session: ASWebAuthenticationSession, anchor: Anchor)?

    static func authenticate(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let anchor = Anchor()
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: BrowserSignIn.callbackScheme) { callback, error in
                Task { @MainActor in
                    active = nil
                    if let callback { continuation.resume(returning: callback) }
                    else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { continuation.resume(throwing: Failure.cancelled) }
                    else { continuation.resume(throwing: Failure.unavailable) }
                }
            }
            session.presentationContextProvider = anchor
            // Reuse an existing web login in Safari so a signed-in owner only taps Sign in.
            session.prefersEphemeralWebBrowserSession = false
            active = (session, anchor)
            if !session.start() {
                active = nil
                continuation.resume(throwing: Failure.unavailable)
            }
        }
    }
}

/// The single sign-in surface: first run, "Sign in again", and the Now re-auth banner all land here.
struct SignInView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var origin = ""
    @State private var editsOrigin = false
    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Connect to your Relo server").font(.headline)
                    Text("Sign in with your Relo account in the browser. You'll come straight back here.")
                        .font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                }.padding(.vertical, 4)
            }
            Section("Server") {
                Text(model.serverOrigin).foregroundStyle(Color.reloSecondaryText).textSelection(.enabled)
                if !model.hasLocalAccountAccess {
                    DisclosureGroup("Choose server", isExpanded: $editsOrigin) {
                        TextField("https://relo.example.com", text: $origin)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .accessibilityLabel("Server origin")
                        Button("Use this server") {
                            if model.selectServerOrigin(origin) { editsOrigin = false }
                        }.frame(minHeight: 28).disabled(model.isAuthenticating)
                    }
                }
            }
            Section {
                Button(action: signIn) {
                    HStack {
                        Text(model.isAuthenticating ? "Signing in…" : "Sign in")
                        Spacer()
                        if model.isAuthenticating { ProgressView() }
                    }.frame(minHeight: 28)
                }.disabled(model.isAuthenticating || editsOrigin)
                if let error = model.authenticationError { Text(error).foregroundStyle(Color.reloErrorText).font(.subheadline) }
            }
        }
        .reloGroupedScreen().navigationTitle("Sign in").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.isAuthenticating) } }
        .onAppear { origin = model.serverOrigin }
    }
    private func signIn() {
        guard !model.isAuthenticating, !editsOrigin else { return }
        Task { if await model.signInWithBrowser() { dismiss() } }
    }
}
