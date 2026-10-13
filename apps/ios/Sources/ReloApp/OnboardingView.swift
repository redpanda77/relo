import SwiftUI

struct OnboardingView: View {
    @Bindable var model: AppModel
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Image(systemName: "bell.badge.fill")
                        .font(.largeTitle).foregroundStyle(Color.reloInteractive)
                        .frame(width: 72, height: 72)
                        .background(Color.reloInteractive.opacity(0.1), in: RoundedRectangle(cornerRadius: 20))
                        .accessibilityHidden(true)
                    Text("Your agents.\nOne calm Inbox.").font(.largeTitle.bold())
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Get updates, follow work, and respond when your agents need you.")
                        .font(.body).foregroundStyle(Color.reloSecondaryText)
                    VStack(alignment: .leading, spacing: 8) {
                        Button { Task { _ = await model.signInWithBrowser() } } label: {
                            Text(model.isAuthenticating ? "Signing in…" : "Sign in").frame(maxWidth: .infinity, minHeight: 32)
                        }.buttonStyle(.borderedProminent).tint(.reloActionFill).disabled(model.isAuthenticating)
                        Text("Sign in with your Relo account in the browser. You'll come straight back here.")
                            .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                        Text(model.serverOrigin).font(.footnote).foregroundStyle(Color.reloSecondaryText).textSelection(.enabled)
                        if !model.hasLocalAccountAccess {
                            NavigationLink("Use another server") { SignInView(model: model) }.font(.footnote).frame(minHeight: 44)
                        }
                    }
                    if model.isAuthenticating { ProgressView("Waiting for the browser…") }
                    if let error = model.authenticationError { Text(error).foregroundStyle(Color.reloErrorText).font(.subheadline) }
                    if model.protectedRegistrationResetAvailable {
                        NavigationLink("Repair this iPhone's registration") { ConnectionSettingsView(model: model) }
                    }
                    Link("Open dashboard", destination: model.dashboardURL).frame(minHeight: 44)
                }.padding(ReloLayout.screenInset)
            }
            .reloScreenBackground().navigationTitle("Welcome").navigationBarTitleDisplayMode(.inline)
        }
    }
}
