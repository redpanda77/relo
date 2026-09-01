import ActivityKit
import ReloCore
import SwiftUI

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
        do {
            let state = ReloActivityAttributes.ContentState(
                generation: 1,
                updatedAt: Date(timeIntervalSince1970: 1_786_060_800),
                sequence: 1,
                interaction: sample.interaction,
                presentation: sample.presentation
            )
            let attributes = ReloActivityAttributes(
                eventID: "act_reference_\(name.replacingOccurrences(of: "-", with: "_"))",
                generation: 1,
                sourceName: sample.presentation.header ?? "Relo",
                style: .standard,
                accountID: "acc_reference123456"
            )
            _ = try Activity<ReloActivityAttributes>.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            status = "Reference active: \(name)"
        } catch {
            status = "ActivityKit could not start the reference"
        }
    }
}

struct NativeReferenceSample {
    let presentation: LiveActivityPresentation
    let interaction: LiveActivityContentInteraction?

    static func named(_ name: String) -> NativeReferenceSample? {
        switch name {
        case "information":
            return sample(title: "Release prepared", subtitle: "Ready for review", status: "Complete")
        case "progress-bar":
            return sample(
                title: "Build in progress", subtitle: "Compiling release 0.4.0", status: "Working",
                components: [["id": "progress", "type": "progress_bar", "colorRole": "project",
                              "value": 0.42, "label": "42%"]], behavior: "progress", theme: "dark"
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
        case "approval": return binarySample(kind: "approval")
        case "yes-no": return binarySample(kind: "yes_no")
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
        theme: String = "system",
        interaction: LiveActivityContentInteraction? = nil
    ) -> NativeReferenceSample {
        let componentIDs = components.compactMap { $0["id"] as? String }
        let identity: [String: Any] = ["project": NSNull(), "thread": NSNull(), "direct": true]
        let surfaces: [String: Any] = [
            "lock_screen": componentIDs, "expanded_leading": [], "expanded_trailing": [],
            "expanded_bottom": componentIDs, "compact_leading": [], "compact_trailing": componentIDs,
            "minimal": Array(componentIDs.prefix(1)),
        ]
        let state: [String: Any] = behavior == "approval" || behavior == "yes_no"
            ? ["kind": "needs_action", "tone": "attention", "icon": "needs_action"]
            : ["kind": "active", "tone": "live", "icon": "active"]
        let appearance: [String: Any] = ["theme": theme, "roles": [
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
