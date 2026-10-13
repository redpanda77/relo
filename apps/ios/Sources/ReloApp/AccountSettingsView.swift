import ReloCore
import SwiftUI

struct AccountSettingsView: View {
    @Bindable var model: AppModel
    @State private var confirmsSignOut = false
    @State private var showsDeletion = false
    var body: some View {
        Form {
            Section("Account") {
                if let email = model.signedInEmail { LabeledContent("Email", value: email) }
                if model.requiresReauthentication {
                    NavigationLink("Sign in again") { SignInView(model: model) }
                }
                if model.accountState == .disabled {
                    Text("Your account needs recovery. Open the dashboard to restore access.").foregroundStyle(Color.reloSecondaryText)
                }
                Link("Open dashboard", destination: model.dashboardURL).frame(minHeight: 28)
            }
            Section {
                Button(model.isSigningOut ? "Signing out…" : "Sign out", role: .destructive) { confirmsSignOut = true }
                    .frame(minHeight: 28).disabled(model.isSigningOut)
                if let error = model.signOutError { Text(error).foregroundStyle(Color.reloErrorText) }
            }
            if model.canDeleteAccount {
                Section {
                    Button("Delete account", role: .destructive) {
                        model.clearAccountDeletionError(); showsDeletion = true
                    }.frame(minHeight: 28).disabled(model.isDeletingAccount)
                }
            }
        }
        .reloGroupedScreen().navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Sign out of Relo?", isPresented: $confirmsSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { _ = await model.signOut() } }
        } message: { Text("This iPhone stops getting notifications and Live Activities, and its saved activity is removed. You can sign back in anytime.") }
        .sheet(isPresented: $showsDeletion) { AccountDeletionView(model: model) }
    }
}

private struct AccountDeletionView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirmation = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This permanently deletes your account, devices, services, notification history, approvals, and sessions. This cannot be undone.")
                        .foregroundStyle(Color.reloSecondaryText)
                }
                Section("Confirm your identity") {
                    SecureField("Current password", text: $password).textContentType(.password)
                    TextField("Type DELETE", text: $confirmation).textInputAutocapitalization(.characters).autocorrectionDisabled()
                }
                if let error = model.accountDeletionError { Section { Text(error).foregroundStyle(Color.reloErrorText) } }
                Section {
                    Button(model.isDeletingAccount ? "Deleting…" : "Permanently delete account", role: .destructive) {
                        Task {
                            if await model.deleteAccount(password: password, confirmation: confirmation) {
                                password = ""; confirmation = ""; dismiss()
                            }
                        }
                    }
                    .frame(minHeight: 28)
                    .disabled(model.isDeletingAccount || !AccountDeletionConfirmationPolicy.isValid(password: password, confirmation: confirmation))
                } footer: { Text("Protected data stays on this iPhone unless your server commits the deletion.") }
            }
            .reloGroupedScreen().navigationTitle("Delete account").navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.isDeletingAccount)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.isDeletingAccount) } }
            .onDisappear { password = ""; confirmation = ""; model.clearAccountDeletionError() }
        }
    }
}
