//
//  ReloServerChoice.swift
//  Relo
//
//  The Relo server this Mac signs in to, as the onboarding's server screen and Settings show it.
//

import ReloNotchKit
import SwiftUI

/// What the owner typed as a server address, and the one step that uses it: check it, remember it, sign in.
@MainActor @Observable
final class ReloServerAddress {
    var text = ""
    var invalid = false

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Sign in to the typed address (or, with none typed, the one already chosen). False when the address is not one.
    @discardableResult
    func signIn() -> Bool {
        let store = ReloNotch.store
        if !isEmpty {
            invalid = !store.setServerOrigin(text)
            if invalid { return false }
        } else if !store.originChosen {
            invalid = true
            return false
        }
        invalid = false
        Task { await store.signIn() }
        return true
    }
}

/// The server this Mac signs in to: its address, or the field to type one. Sign in is offered only once the owner chose
/// one (the build's own placeholder address is never a server). With `address`, the field is the onboarding's: Sign in
/// (the screen's button, or Return) uses what is typed in one step, with no "Use".
struct ReloServerChoice: View {
    private let store = ReloNotch.store
    var address: ReloServerAddress?
    @State private var editing = false
    @State private var ownText = ""
    @State private var ownInvalid = false

    private var text: Binding<String> { address.map { a in Binding(get: { a.text }, set: { a.text = $0; a.invalid = false }) } ?? $ownText }
    private var invalid: Bool { address?.invalid ?? ownInvalid }

    var body: some View {
        VStack(spacing: 8) {
            if address == nil, store.originChosen, !editing {
                HStack(spacing: 8) {
                    Image(systemName: "server.rack").foregroundStyle(.white.opacity(0.55))
                    Text(store.serverOrigin.map(ReloNotchStore.displayAddress(of:)) ?? "").font(.system(size: 12.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.8)).lineLimit(1).truncationMode(.middle)
                    Button("Change") { ownText = store.serverOrigin.map(ReloNotchStore.displayAddress(of:)) ?? ""; editing = true }
                        .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.tertiaryText)
                }
            } else {
                HStack(spacing: 8) {
                    TextField("Your Relo address, e.g. relo.example.com", text: text)
                        .textFieldStyle(.roundedBorder).frame(width: 320)
                        .onSubmit(use)
                        .accessibilityLabel("Relo address")
                    if address == nil {
                        Button("Use", action: use).buttonStyle(ReloSecondaryButtonStyle()).disabled(ownText.trimmingCharacters(in: .whitespaces).isEmpty)
                        if editing {
                            Button("Cancel") { editing = false; ownInvalid = false }
                                .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.tertiaryText)
                        }
                    }
                }
                if invalid {
                    Text("That doesn't look like a Relo address. It looks like relo.example.com.")
                        .font(.caption).foregroundStyle(ReloNotchTheme.warning).multilineTextAlignment(.center).frame(maxWidth: 380)
                }
            }
        }
        .onAppear {
            if let address {
                if address.text.isEmpty { address.text = store.originChosen ? (store.serverOrigin.map(ReloNotchStore.displayAddress(of:)) ?? "") : store.suggestedServerAddress() }
            } else if ownText.isEmpty { ownText = store.suggestedServerAddress() }
        }
    }

    private func use() {
        if let address { address.signIn(); return }
        ownInvalid = !store.setServerOrigin(ownText)
        if !ownInvalid { editing = false }
    }
}
