import ActivityKit
import ReloCore
import SwiftUI
import UIKit

@main
struct ReloNativeReferenceHost: App {
    @State private var status = "Preparing native reference"

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Image(systemName: "rectangle.on.rectangle.angled")
                    .font(.largeTitle)
                Text("Relo Native Reference")
                    .font(.headline)
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            .task { await startRequestedReference() }
        }
    }

    @MainActor
    private func startRequestedReference() async {
        let arguments = ProcessInfo.processInfo.arguments
        guard let marker = arguments.firstIndex(of: "--reference-case"),
              arguments.indices.contains(marker + 1) else {
            status = "Missing --reference-case"
            return
        }
        let name = arguments[marker + 1]
        for activity in Activity<ReloActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        guard let sample = NativeReferenceSample.named(name) else {
            status = "Unknown reference case"
            return
        }
        // `--reference-also <case>` starts a second activity first, so the island shows two (the shared layout).
        if let also = arguments.firstIndex(of: "--reference-also"), arguments.indices.contains(also + 1),
           let other = NativeReferenceSample.named(arguments[also + 1]) {
            _ = try? Activity<ReloActivityAttributes>.request(
                attributes: ReloActivityAttributes(eventID: "act_reference_also", generation: 1,
                    sourceName: other.presentation.header ?? "Relo", style: .standard, accountID: "acc_reference123456"),
                content: ActivityContent(state: .init(generation: 1, updatedAt: .now, sequence: 1, staleAt: other.staleAt,
                    interaction: other.interaction, presentation: other.presentation, owner: other.owner), staleDate: nil),
                pushType: nil)
        }
        do {
            let state = ReloActivityAttributes.ContentState(
                generation: 1,
                updatedAt: .now,
                sequence: 1,
                staleAt: sample.staleAt,
                interaction: sample.interaction,
                presentation: sample.presentation,
                owner: sample.owner
            )
            let attributes = ReloActivityAttributes(
                eventID: "act_reference_\(name.replacingOccurrences(of: "-", with: "_"))",
                generation: 1,
                sourceName: sample.presentation.header ?? "Relo",
                style: .standard,
                accountID: "acc_reference123456"
            )
            let activity = try Activity<ReloActivityAttributes>.request(
                attributes: attributes,
                content: ActivityContent(state: state,
                    staleDate: LiveActivitySurfaceProjection.invalidationDate(staleAt: sample.staleAt, interaction: state.interaction)),
                pushType: nil
            )
            status = "Reference active: \(name)"
            if arguments.contains("--reference-alert") {
                status = "Alert update in 5 seconds. Return to the Home Screen."
                let backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Reference alert")
                defer { if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask) } }
                try await Task.sleep(for: .seconds(5))
                var update = state
                update.sequence += 1
                update.updatedAt = .now
                await activity.update(ActivityContent(state: update,
                    staleDate: LiveActivitySurfaceProjection.invalidationDate(staleAt: sample.staleAt, interaction: update.interaction)),
                    alertConfiguration: .init(title: "Relo reference", body: "Live Activity alert layout", sound: .default))
                status = "Alert update requested. System presentation must be captured separately."
            }
        } catch {
            status = "ActivityKit could not start the reference"
        }
    }
}

struct NativeReferenceSample {
    let presentation: LiveActivityPresentation
    let interaction: LiveActivityContentInteraction?
    var staleAt: Date? = nil
    var owner: LiveActivityOwner? = nil

    static func named(_ name: String) -> NativeReferenceSample? {
        #if DEBUG
        if let fixture = ReloLiveActivityReferenceFixtures.state(named: name) {
            return .init(presentation: fixture.presentation, interaction: fixture.interaction, staleAt: fixture.staleAt)
        }
        #endif
        switch name {
        case "information":
            return sample(title: "Release prepared", subtitle: "Ready for review", status: "Complete")
        case "progress-bar":
            return sample(
                title: "Build in progress", subtitle: "Compiling release 0.4.0", status: "Working",
                components: [["id": "progress", "type": "progress_bar", "colorRole": "project",
                              "value": 0.42, "label": "42%"]], behavior: "progress"
            )
        case "steps":
            return sample(
                title: "Release 0.4.0", subtitle: "Three-stage gate", status: "Testing",
                components: [["id": "steps", "type": "steps", "colorRole": "thread", "items": [
                    ["id": "build", "label": "Build", "state": "complete"],
                    ["id": "test", "label": "Test", "state": "current"],
                    ["id": "freeze", "label": "Freeze", "state": "pending"],
                ]]], behavior: "progress"
            )
        case "image-cache-miss":
            return sample(title: "Preview ready", subtitle: "Verified cache lookup", status: "Review",
                components: [["id": "image", "type": "image", "colorRole": "project",
                  "asset": ["kind": "relo_asset", "assetId": "ast_123456789012", "revision": 3,
                    "sha256": String(repeating: "a", count: 64), "mediaType": "image/png",
                    "byteSize": 204_800, "pixelWidth": 1_200, "pixelHeight": 630],
                  "altText": "A Relo report preview", "contentMode": "fit"]])
        case "island-plan", "island-done", "island-failed":
            // The island study's moments: a four-step plan running, finished, and stopped on its third step.
            let ended = name != "island-plan"
            let states = name == "island-done" ? ["complete", "complete", "complete", "complete"]
                : name == "island-failed" ? ["complete", "complete", "current", "pending"]
                : ["complete", "current", "pending", "pending"]
            let labels = ["Read the island code", "Design the variants", "Build the canvas", "Publish the study"]
            let items = zip(labels, states).enumerated().map { index, pair in
                ["id": "s\(index + 1)", "label": pair.0, "state": pair.1] }
            return sample(
                title: "A UI study of the Dynamic Island", subtitle: nil,
                status: name == "island-done" ? "Five compact and four open variants on one canvas"
                    : name == "island-failed" ? "The canvas would not publish; nothing was saved"
                    : "Drawing compact and expanded island variants on the canvas",
                components: [["id": "steps", "type": "steps", "colorRole": "thread", "items": items]],
                behavior: ended ? "informational" : "progress", contextual: true,
                stateKind: name == "island-done" ? "completed" : name == "island-failed" ? "failed" : "active")
        case "island-three", "island-five":
            // The plan sample with other sessions live: one satellite each, +N in the wing (five: one needs you).
            guard var sample = named("island-plan") else { return nil }
            let five = name == "island-five"
            sample.owner = LiveActivityOwner(state: "moving", placement: "shown", needsYouCount: five ? 1 : 0,
                                             live: five ? 5 : 3)
            return sample
        case "island-noplan":
            return sample(title: "Find why History repeats rounds", subtitle: nil,
                status: "Reading how History builds its rows", behavior: "progress", contextual: true)
        case "approval": return binarySample(kind: "approval")
        case "yes-no": return binarySample(kind: "yes_no")
        case "long-text":
            return sample(title: "Preparing a release with a long title and essential context", subtitle: "Review the result in Relo", status: "In progress")
        case "mixed-identity":
            return sample(title: "Release review", subtitle: "Build and test progress", status: "Testing",
                components: [
                    ["id": "steps", "type": "steps", "colorRole": "thread", "items": [
                        ["id": "build", "label": "Build", "state": "complete"],
                        ["id": "test", "label": "Test", "state": "current"],
                        ["id": "ship", "label": "Ship", "state": "pending"]]],
                    ["id": "progress", "type": "progress_bar", "colorRole": "project", "value": 0.42, "label": "Tests"]
                ], behavior: "progress", contextual: true)
        case "response-sending", "response-queued", "response-accepted", "response-rejected":
            var interaction = binarySample(kind: "approval").interaction!
            interaction.responsePhase = LiveActivityResponsePhase(rawValue: String(name.dropFirst("response-".count)))
            interaction.selectedAction = .approve
            if interaction.responsePhase == .accepted { interaction.state = "approved" }
            return sample(title: "Release approval", subtitle: "Response state reference", status: "Waiting",
                          behavior: "approval", interaction: interaction)
        case "response-expired":
            let interaction = LiveActivityContentInteraction(id: "int_reference123456", notificationID: "ntf_reference123456",
                targetDeviceID: "dev_reference123456", accountID: "acc_reference123456", kind: "approval",
                state: "pending", credential: String(repeating: "x", count: 43), expiresAtUnixSeconds: 1)
            return sample(title: "Release approval", subtitle: "Expired reference", status: "Expired", behavior: "approval", interaction: interaction)
        default: return nil
        }
    }

    private static func binarySample(kind: String) -> NativeReferenceSample {
        let yesNo = kind == "yes_no"
        let interaction = LiveActivityContentInteraction(
                id: "int_reference123456", notificationID: "ntf_reference123456",
                targetDeviceID: "dev_reference123456", accountID: "acc_reference123456",
                kind: kind, state: "pending", credential: String(repeating: "x", count: 43),
                expiresAtUnixSeconds: 1_893_456_000
        )
        return sample(
            title: yesNo ? "Continue deployment?" : "Approval required",
            subtitle: "Canonical authenticated response", status: "Waiting",
            behavior: kind, interaction: interaction
        )
    }

    private static func sample(
        title: String,
        subtitle: String?,
        status: String,
        components: [[String: Any]] = [],
        behavior: String = "informational",
        interaction: LiveActivityContentInteraction? = nil,
        contextual: Bool = false,
        stateKind: String = "active"
    ) -> NativeReferenceSample {
        let componentIDs = components.compactMap { $0["id"] as? String }
        let identity: [String: Any] = contextual
            ? ["project": ["label": "Relo", "color": "#A78BFA", "icon": "project", "revision": 1, "provenance": "reference"],
               "thread": ["label": "Release review", "color": "#38BDF8", "icon": "thread", "revision": 1, "provenance": "reference"], "direct": false]
            : ["project": NSNull(), "thread": NSNull(), "direct": true]
        let surfaces: [String: Any] = [
            "lock_screen": componentIDs, "expanded_leading": [], "expanded_trailing": [],
            "expanded_bottom": componentIDs, "compact_leading": [], "compact_trailing": componentIDs,
            "minimal": Array(componentIDs.prefix(1)),
        ]
        let state: [String: Any] = behavior == "approval" || behavior == "yes_no"
            ? ["kind": "needs_action", "tone": "attention", "icon": "needs_action"]
            : stateKind == "completed" ? ["kind": "completed", "tone": "success", "icon": "completed"]
            : stateKind == "failed" ? ["kind": "failed", "tone": "failure", "icon": "failed"]
            : ["kind": "active", "tone": "live", "icon": "active"]
        let appearance: [String: Any] = ["roles": [
            "cardIdentity": "project", "componentIdentity": "thread", "statusEmphasis": "state",
        ]]
        let primary: Any
        let secondary: Any
        switch behavior {
        case "approval":
            primary = "Approve"
            secondary = "Deny"
        case "yes_no":
            primary = "Yes"
            secondary = "No"
        default:
            primary = NSNull()
            secondary = NSNull()
        }
        let payload: [String: Any] = [
            "header": "Relo", "title": title,
            "subtitle": subtitle ?? NSNull(), "status": status,
            "componentsJson": json(components), "surfacesJson": json(surfaces),
            "identityJson": json(identity), "stateJson": json(state),
            "behaviorType": behavior, "primaryAction": NSNull(), "primaryLabel": primary,
            "secondaryAction": NSNull(), "secondaryLabel": secondary,
            "appearanceJson": json(appearance), "privacy": "standard",
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return NativeReferenceSample(
            presentation: try! JSONDecoder().decode(LiveActivityPresentation.self, from: data),
            interaction: interaction
        )
    }

    private static func json(_ object: Any) -> String {
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}
