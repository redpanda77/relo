#if DEBUG
    import Foundation
    import ReloCore

    /// Synthetic, credential-free reference data shared by previews, the native host, and tests.
    enum ReloLiveActivityReferenceFixtures {
        static let names = [
            "max-text", "many-components", "all-pending", "all-complete",
            "zero-progress", "full-progress", "decision-with-progress", "response-denied",
            "response-canceled", "stale-progress", "expiry-transition", "question-short", "question-long",
        ]

        /// A 240-character question, the longest a sender may ask.
        static let longQuestion = String(
            "Deploy release 0.8.1 to the production server now? The database migration adds two columns, "
            + "the API restarts for about ten seconds, and every phone reconnects on its own afterwards. Approve to deploy, "
            + "deny to keep 0.8.0.".prefix(240))

        static func state(named name: String, now: Date = .now) -> ReloActivityAttributes.ContentState? {
            guard names.contains(name) else { return nil }
            let approval = [
                "decision-with-progress", "response-denied", "response-canceled", "expiry-transition", "question-long",
            ].contains(name)
            let yesNo = name == "question-short"
            var components: [LiveActivityPresentation.Component] = [
                .progressBar(
                    id: "progress", colorRole: .project,
                    value: name == "zero-progress" ? 0 : name == "full-progress" ? 1 : 0.42, label: "Tests")
            ]
            if name == "question-long" {
                components.insert(
                    .steps(
                        id: "steps", colorRole: .thread,
                        items: [
                            .init(id: "build", label: "Build", state: .complete),
                            .init(id: "test", label: "Test", state: .complete),
                            .init(id: "deploy", label: "Deploy", state: .current),
                            .init(id: "verify", label: "Verify", state: .pending),
                        ]), at: 0)
            }
            if ["all-pending", "all-complete", "many-components"].contains(name) {
                components.insert(
                    .steps(
                        id: "steps", colorRole: .thread,
                        items: (1...8).map {
                            .init(
                                id: "step\($0)", label: "Stage \($0)",
                                state: name == "all-complete" ? .complete : .pending)
                        }), at: 0)
            }
            if name == "many-components" {
                components += (1...6).map {
                    .progressBar(id: "extra\($0)", colorRole: .thread, value: 0.1, label: "Extra")
                }
            }
            let ids = components.map(\.id)
            let presentation = LiveActivityPresentation(
                header: "Relo",
                title: name == "max-text"
                    ? String(repeating: "Long task ", count: 8)
                    : name == "question-long" ? "Relo 0.8.1 rollout to production with the database migration"
                    : yesNo ? "Relo 0.8.1 rollout"
                    : approval ? "Approval needed" : "Build release #42",
                subtitle: name == "max-text"
                    ? String(repeating: "Target context ", count: 8)
                    : name == "question-long" ? longQuestion
                    : yesNo ? "Run the database migration now?" : "Deploy release #42 to Relo server?",
                status: name == "max-text"
                    ? String(repeating: "Working ", count: 10) : approval || yesNo ? "Needs you" : "Testing",
                components: components,
                surfaces: .init(
                    lockScreen: ids, expandedBottom: ids, compactTrailing: ids, minimal: ["progress"]),
                identity: .init(
                    project: .init(label: "Relo", color: "#A78BFA", icon: .project),
                    thread: .init(label: "Dashboard Test", color: "#38BDF8", icon: .thread), direct: false),
                state: .init(
                    kind: approval || yesNo ? "needs_action" : "active", tone: approval || yesNo ? "attention" : "live",
                    icon: approval || yesNo ? .needsAction : .active),
                behavior: yesNo ? .yesNo(primary: "Yes", secondary: "No")
                    : approval ? .approval(primary: "Approve", secondary: "Deny") : .progress
            )
            let interaction: LiveActivityContentInteraction? =
                approval || yesNo
                ? .init(
                    id: "int_reference123456", notificationID: "ntf_reference123456",
                    targetDeviceID: "dev_reference123456", accountID: "acc_reference123456",
                    kind: yesNo ? "yes_no" : "approval",
                    state: name == "response-denied"
                        ? "denied" : name == "response-canceled" ? "canceled" : "pending",
                    credential: String(repeating: "x", count: 43),
                    expiresAtUnixSeconds: Int64(
                        now.addingTimeInterval(name == "expiry-transition" ? 15 : 300).timeIntervalSince1970),
                    responsePhase: name == "response-denied" ? .accepted : nil,
                    selectedAction: name == "response-denied" ? .deny : nil
                ) : nil
            return .init(
                generation: 1, updatedAt: now, sequence: 1,
                staleAt: name == "stale-progress" ? now.addingTimeInterval(-1) : nil,
                interaction: interaction, presentation: presentation)
        }

        static var attributes: ReloActivityAttributes {
            .init(
                eventID: "act_reference_preview", generation: 1, sourceName: "Relo",
                style: .standard, accountID: "acc_reference123456")
        }
    }
#endif
