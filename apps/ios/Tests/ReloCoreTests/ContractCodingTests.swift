@testable import ReloPersistence
import CryptoKit
import Foundation
import XCTest
// SwiftPM builds the shared activity sources as ReloActivityWire; Xcode compiles them into the app.
#if canImport(ReloActivityWire)
@testable import ReloActivityWire
#else
@testable import Relo
#endif
@testable import ReloCore

final class ContractCodingTests: XCTestCase {
    func testDeliveryEvidenceGoldenFixtureUsesTheSharedOrderedVocabulary() throws {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: "delivery-evidence-v1",
            withExtension: "json"
        ))
        let decoder = ReloWireJSON.decoder()
        let evidence = try decoder.decode(
            DeliveryEvidenceResponse.self,
            from: Data(contentsOf: url)
        )

        XCTAssertEqual(evidence.version, 1)
        XCTAssertEqual(evidence.order, "newest_first")
        XCTAssertEqual(
            evidence.items.map(\.stage),
            [
                "reconciled", "opened", "device_received", "provider_accepted",
                "attempted", "queued", "canonicalized", "accepted",
            ]
        )
        XCTAssertEqual(evidence.items.map(\.stageOrder), [130, 100, 90, 50, 40, 30, 20, 10])
        XCTAssertEqual(evidence.items.first?.detailCode, "mark_accepted")
    }

    func testVersionedStorageCodecAcceptsOnlyTheCurrentEnvelope() throws {
        struct Payload: Codable, Equatable { let value: String }
        let versionOne = Data(#"{"schemaVersion":1,"payload":{"value":"ready"}}"#.utf8)
        let decoded = try VersionedStorageCodec.decode(
            Payload.self,
            from: versionOne,
            schemaVersion: 1
        )
        XCTAssertEqual(decoded.payload, Payload(value: "ready"))

        let retired = Data(#"{"schemaVersion":2,"payload":{"value":"ready"}}"#.utf8)
        XCTAssertThrowsError(try VersionedStorageCodec.decode(
            Payload.self,
            from: retired,
            schemaVersion: 1
        )) { error in
            XCTAssertEqual(error as? VersionedStorageError, .unsupportedSchemaVersion(2))
        }

        XCTAssertThrowsError(try VersionedStorageCodec.decode(
            Payload.self,
            from: Data(#"{"schemaVersion":2}"#.utf8),
            schemaVersion: 1
        )) { error in
            XCTAssertEqual(error as? VersionedStorageError, .malformedEnvelope)
        }
    }

    func testUnifiedHealthKeepsDeliveryDiagnosticsIndependentFromInboxReadiness() {
        let health = DeviceHealthProjection.project(
            accountNeedsAttention: false,
            notificationPermission: .allowed,
            registration: .registered,
            deviceCredentialPresent: true,
            apnsTokenAvailable: true,
            serverAcceptedCurrentAPNSToken: true,
            hasPushRegistrationError: false,
            liveActivitiesAuthorized: true,
            liveActivityPushToStartTokenAvailable: true,
            activeLiveActivityCount: 1,
            inbox: .current,
            hasCachedActivity: true,
            deliveryTransportStatus: nil,
            deliveryTransportError: "Relo server's delivery-status service is unavailable."
        )

        XCTAssertEqual(health.readiness.label, "Ready")
        XCTAssertEqual(health.inboxSync.label, "Current")
        XCTAssertEqual(health.deliveryPath.label, "Unavailable")
        XCTAssertEqual(health.deliveryPath.severity, .degraded)
        XCTAssertEqual(health.liveActivities.label, "Ready")
        XCTAssertEqual(health.liveActivities.detail, "1 active")
    }

    func testUnifiedHealthKeepsPrimaryReadinessStableDuringCachedRefresh() {
        let health = DeviceHealthProjection.project(
            accountNeedsAttention: false,
            notificationPermission: .allowed,
            registration: .registered,
            deviceCredentialPresent: true,
            apnsTokenAvailable: true,
            serverAcceptedCurrentAPNSToken: true,
            hasPushRegistrationError: false,
            liveActivitiesAuthorized: true,
            liveActivityPushToStartTokenAvailable: true,
            activeLiveActivityCount: 1,
            inbox: .syncing,
            hasCachedActivity: true,
            deliveryTransportStatus: nil,
            deliveryTransportError: nil
        )

        XCTAssertEqual(health.readiness.label, "Ready")
        XCTAssertEqual(health.readiness.severity, .normal)
        XCTAssertEqual(health.inboxSync.label, "Syncing")
    }

    func testUnifiedHealthMakesRegistrationFailureThePrimaryRecoveryState() {
        let health = DeviceHealthProjection.project(
            accountNeedsAttention: false,
            notificationPermission: .allowed,
            registration: .failed("Local credential store unreadable"),
            deviceCredentialPresent: false,
            apnsTokenAvailable: true,
            serverAcceptedCurrentAPNSToken: false,
            hasPushRegistrationError: false,
            liveActivitiesAuthorized: false,
            liveActivityPushToStartTokenAvailable: false,
            activeLiveActivityCount: 0,
            inbox: .offline("Recent activity is cached"),
            hasCachedActivity: true,
            deliveryTransportStatus: nil,
            deliveryTransportError: nil
        )

        XCTAssertEqual(health.readiness.label, "Needs attention")
        XCTAssertEqual(health.readiness.severity, .actionRequired)
        XCTAssertEqual(health.registration.detail, "Local credential store unreadable")
        XCTAssertEqual(health.inboxSync.label, "Offline")
        XCTAssertEqual(health.liveActivities.label, "Unavailable")
    }

    func testServerEndpointPolicyAllowsHTTPSAndPrivateLANHTTPOnly() throws {
        XCTAssertTrue(ServerEndpointPolicy.accepts(try XCTUnwrap(URL(string: "https://server.example.test"))))
        XCTAssertTrue(ServerEndpointPolicy.accepts(try XCTUnwrap(URL(string: "http://192.168.1.10:8180"))))
        XCTAssertTrue(ServerEndpointPolicy.accepts(try XCTUnwrap(URL(string: "http://server.local:8180"))))
        XCTAssertTrue(ServerEndpointPolicy.accepts(try XCTUnwrap(URL(string: "http://127.0.0.1:8180"))))
        XCTAssertFalse(ServerEndpointPolicy.accepts(try XCTUnwrap(URL(string: "http://example.com"))))
        XCTAssertFalse(ServerEndpointPolicy.accepts(try XCTUnwrap(URL(string: "http://8.8.8.8"))))
    }

    func testAuthenticatedDeviceRegistrationMatchesFrozenMobileContract() throws {
        let registration = DeviceRegistrationRequest(
            stableDeviceId: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            name: "Personal iPhone",
            bundleIdentifier: "com.example.relo.notifications",
            appVersion: "1.0.0",
            appBuild: "1",
            osVersion: "18.0",
            model: "iPhone",
            apnsEnvironment: "sandbox",
            notificationAuthorization: .pending,
            liveActivityAuthorization: .authorized,
            liveActivityPushToStartToken: "aabbccdd"
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(registration)) as? [String: Any]
        )

        XCTAssertEqual(object["stableDeviceId"] as? String, registration.stableDeviceId.uuidString)
        XCTAssertEqual(object["bundleIdentifier"] as? String, "com.example.relo.notifications")
        XCTAssertEqual(object["notificationAuthorization"] as? String, "pending")
        XCTAssertNil(object["pairingCode"])
        XCTAssertNil(object["apnsToken"])
        XCTAssertEqual(object["liveActivityPushToStartToken"] as? String, "aabbccdd")
    }

    func testStoredDeviceCredentialRequiresCurrentAccountAndRevision() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertThrowsError(try decoder.decode(
            DeviceCredential.self,
            from: Data(#"{"deviceId":"dev_123456789012","installationId":"6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8","accessToken":"device-token-long-enough-for-a-fixture","issuedAt":"2026-08-06T12:00:00Z","expiresAt":null}"#.utf8)
        ))
    }

    func testWireDatesDecodeWholeMillisecondAndMicrosecondPrecision() throws {
        struct Stamped: Decodable { let at: Date }
        let decoder = ReloWireJSON.decoder()
        for (text, expected) in [
            ("2026-10-06T16:16:10Z", 1_791_303_370.0),
            ("2026-10-06T16:16:10.324Z", 1_791_303_370.324),
            ("2026-10-06T16:16:10.324123Z", 1_791_303_370.324123),
        ] {
            let value = try decoder.decode(Stamped.self, from: Data(#"{"at":"\#(text)"}"#.utf8))
            XCTAssertEqual(value.at.timeIntervalSince1970, expected, accuracy: 0.000_01, text)
        }
        XCTAssertThrowsError(try decoder.decode(Stamped.self, from: Data(#"{"at":"yesterday"}"#.utf8)))
    }

    func testInboxPageDecodesSharedContract() throws {
        let json = #"{"items":[{"id":"evt_abcdefghijkl","kind":"notification","sourceName":"Codex","sourceImageUrl":null,"title":"Done","detail":null,"result":null,"deliveryState":"accepted_by_apns","apnsAcceptedAt":"2027-01-15T12:00:00Z","receivedAt":null,"openedAt":null,"createdAt":"2027-01-15T11:59:00Z"}],"cursor":"opaque-cursor","hasMore":false,"serverTime":"2027-01-15T12:00:01Z"}"#
        let decoder = ReloWireJSON.decoder()

        let page = try decoder.decode(InboxPage.self, from: Data(json.utf8))

        XCTAssertEqual(page.cursor, "opaque-cursor")
        XCTAssertFalse(page.hasMore)
        XCTAssertEqual(page.items.first?.deliveryState, .acceptedByAPNs)
    }

    func testTaskMutationMetadataDecodesGenerationReuseAndResumeWithoutHeuristicDefaults() throws {
        let explicit = try JSONDecoder().decode(
            TaskLiveActivityMutationMetadata.self,
            from: Data(#"{"activity":{"id":"act_generation1234","generation":4},"replayed":false,"reused":true,"resumed":false}"#.utf8)
        )
        XCTAssertEqual(explicit.activity.identity, LiveActivityIdentity(activityID: "act_generation1234", generation: 4))
        XCTAssertTrue(explicit.reused)
        XCTAssertFalse(explicit.resumed)

        let legacyFlags = try JSONDecoder().decode(
            TaskLiveActivityMutationMetadata.self,
            from: Data(#"{"activity":{"id":"act_generation1234","generation":4},"replayed":true}"#.utf8)
        )
        XCTAssertFalse(legacyFlags.reused)
        XCTAssertFalse(legacyFlags.resumed)
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                TaskLiveActivityMutationMetadata.self,
                from: Data(#"{"activity":{"id":"act_generation1234"},"replayed":false}"#.utf8)
            )
        )
    }

    func testActivityKitAttributesRequireTheSamePositiveGenerationPrimitive() throws {
        let valid = try JSONDecoder().decode(
            ReloActivityAttributes.self,
            from: Data(#"{"eventID":"act_generation1234","generation":5,"sourceName":"Relo","style":"standard","accountID":"acc_generation1234"}"#.utf8)
        )
        XCTAssertEqual(valid.identity, LiveActivityIdentity(activityID: "act_generation1234", generation: 5))

        for payload in [
            #"{"eventID":"act_generation1234","sourceName":"Relo","style":"standard"}"#,
            #"{"eventID":"act_generation1234","generation":0,"sourceName":"Relo","style":"standard"}"#,
            #"{"eventID":"act_generation1234","generation":"5","sourceName":"Relo","style":"standard"}"#,
            #"{"eventID":"act_generation1234","generation":1.5,"sourceName":"Relo","style":"standard"}"#,
        ] {
            XCTAssertThrowsError(
                try JSONDecoder().decode(ReloActivityAttributes.self, from: Data(payload.utf8))
            )
        }
    }

    func testInteractiveActionLabelRenderModelUsesStyleDefaultsForUnsafeValues() {
        let expectedDefaults: [(String, String, String)] = [
            ("approval", "Approve", "Deny"),
            ("shell", "[ allow ]", "[ reject ]"),
            ("verdict", "YES", "NO"),
            ("signal", "Respond", "Dismiss"),
        ]

        for (style, expectedPrimary, expectedSecondary) in expectedDefaults {
            let labels = LiveActivityActionLabels(
                style: style,
                primaryLabel: "Line one\nLine two",
                secondaryLabel: String(repeating: "x", count: 25)
            )
            XCTAssertEqual(labels.primary, expectedPrimary, "Unexpected primary fallback for \(style)")
            XCTAssertEqual(labels.secondary, expectedSecondary, "Unexpected secondary fallback for \(style)")
        }
    }

    func testInteractiveActionLabelRenderModelPreservesSafeCustomValues() {
        let labels = LiveActivityActionLabels(
            style: "verdict",
            primaryLabel: "Ship it",
            secondaryLabel: "Hold"
        )

        XCTAssertEqual(labels.primary, "Ship it")
        XCTAssertEqual(labels.secondary, "Hold")
    }

    func testDetailActionPresentationKeepsCanonicalActionsWithCustomLabels() throws {
        let approval = try XCTUnwrap(BinaryNotificationActionPresentation(
            kind: .approval,
            style: "shell",
            primaryLabel: "Run once",
            secondaryLabel: "Block"
        ))
        XCTAssertEqual(approval.primaryLabel, "Run once")
        XCTAssertEqual(approval.primaryAction, .approve)
        XCTAssertEqual(approval.secondaryLabel, "Block")
        XCTAssertEqual(approval.secondaryAction, .deny)

        let verdict = try XCTUnwrap(BinaryNotificationActionPresentation(
            kind: .yesNo,
            style: "verdict",
            primaryLabel: "Line one\nLine two",
            secondaryLabel: nil
        ))
        XCTAssertEqual(verdict.primaryLabel, "YES")
        XCTAssertEqual(verdict.primaryAction, .yes)
        XCTAssertEqual(verdict.secondaryLabel, "NO")
        XCTAssertEqual(verdict.secondaryAction, .no)
        XCTAssertNil(BinaryNotificationActionPresentation(kind: .text, style: "shell"))
    }

    func testTaskLiveActivitySymbolsMapToStableSystemImages() {
        XCTAssertEqual(LiveActivitySymbol.terminal.systemImageName, "terminal.fill")
        XCTAssertEqual(LiveActivitySymbol.code.systemImageName, "chevron.left.forwardslash.chevron.right")
        XCTAssertEqual(LiveActivitySymbol.build.systemImageName, "hammer.fill")
        XCTAssertEqual(LiveActivitySymbol.success.systemImageName, "checkmark.circle.fill")
        XCTAssertEqual(LiveActivitySymbol.warning.systemImageName, "exclamationmark.triangle.fill")
    }

    func testInboxPageDecodesPendingInteraction() throws {
        let json = #"{"items":[{"id":"ntf_abcdefghijkl","kind":"notification","sourceName":"Relo","sourceImageUrl":"https://images.example.test/approval.png","title":"Approval needed","detail":"Deploy to Relo server?","result":null,"deliveryState":"queued","apnsAcceptedAt":null,"receivedAt":null,"openedAt":null,"createdAt":"2027-01-15T11:59:00Z","destinationUrl":"https://example.test/deploy/123","privacy":"standard","liveActivity":null,"interaction":{"id":"int_abcdefghijkl","kind":"approval","prompt":"Deploy to Relo server?","state":"pending","expiresAt":"2027-01-15T12:10:00Z","respondedAt":null}}],"cursor":"opaque-cursor","hasMore":false,"serverTime":"2027-01-15T12:00:01Z"}"#
        let decoder = ReloWireJSON.decoder()

        let page = try decoder.decode(InboxPage.self, from: Data(json.utf8))
        let interaction = try XCTUnwrap(page.items.first?.interaction)

        XCTAssertEqual(interaction.kind, .approval)
        XCTAssertEqual(interaction.state, .pending)
        XCTAssertEqual(interaction.prompt, "Deploy to Relo server?")
        XCTAssertEqual(page.items.first?.validatedSourceImageURL?.host, "images.example.test")
        XCTAssertEqual(page.items.first?.validatedDestinationURL?.path, "/deploy/123")
    }

    func testActivityDeepLinkContainsOnlyValidatedCredentialFreeIdentifier() throws {
        let identity = LiveActivityIdentity(activityID: "act_abcdefghijkl", generation: 7)
        let versionedURL = try XCTUnwrap(ReloDeepLink.activityURL(identity: identity))
        XCTAssertEqual(versionedURL.absoluteString, "relo://activity/act_abcdefghijkl?generation=7")
        XCTAssertEqual(ReloDeepLink.activityIdentity(from: versionedURL), identity)
        XCTAssertNil(ReloDeepLink.activityIdentity(from: try XCTUnwrap(URL(string: "relo://activity/act_ok?generation=0"))))
        XCTAssertNil(ReloDeepLink.activityIdentity(from: try XCTUnwrap(URL(string: "relo://activity/act_ok?generation=1&token=secret"))))
        XCTAssertNil(ReloDeepLink.activityIdentity(from: try XCTUnwrap(URL(string: "relo://activity/act_ok?token=secret"))))
        XCTAssertNil(ReloDeepLink.activityIdentity(from: try XCTUnwrap(URL(string: "https://activity/act_ok?generation=1"))))
    }

    func testLiveActivityAccessibilitySummaryMasksPrivateContent() {
        let summary = LiveActivityAccessibilitySummary(
            source: "Codex",
            headline: "Sensitive deployment",
            status: "Waiting",
            detail: "Contains secret material",
            progress: 0.42,
            isPrivate: true,
            isInteractive: true
        )
        XCTAssertEqual(summary.label, "Relo private activity")
        XCTAssertEqual(summary.value, "Open Relo to view")
        XCTAssertFalse("\(summary.label) \(summary.value) \(summary.hint)".contains("Sensitive"))
        XCTAssertFalse("\(summary.label) \(summary.value) \(summary.hint)".contains("secret"))
    }

    func testLiveActivityAccessibilitySummaryIncludesStatusAndProgress() {
        let summary = LiveActivityAccessibilitySummary(
            source: "Codex",
            headline: "Build",
            status: "Testing",
            detail: "Unit tests",
            progress: 0.42,
            isPrivate: false,
            isInteractive: false
        )
        XCTAssertEqual(summary.label, "Codex, Build")
        XCTAssertEqual(summary.value, "Testing, 42 percent, Unit tests")
    }

    func testForegroundRefreshIsABoundedFallbackRatherThanOneSecondPolling() {
        XCTAssertGreaterThanOrEqual(InboxRefreshPolicy.foregroundFallbackSeconds, 15)
        XCTAssertLessThanOrEqual(InboxRefreshPolicy.foregroundFallbackSeconds, 60)
        XCTAssertEqual(
            (0...7).map { InboxRefreshPolicy.foregroundDelaySeconds(afterAttempt: $0) },
            [2, 3, 5, 8, 13, 15, 15, 15]
        )
        XCTAssertEqual(
            (0...6).map {
                InboxRefreshPolicy.foregroundDelaySeconds(
                    afterAttempt: $0,
                    directPushAvailable: false
                )
            },
            [2, 3, 5, 8, 10, 10, 10]
        )
        XCTAssertEqual(
            (0...4).map {
                InboxRefreshPolicy.foregroundDelaySeconds(
                    afterAttempt: $0,
                    directPushAvailable: true
                )
            },
            [30, 60, 60, 60, 60]
        )
    }

    func testLiveActivityOrderingRejectsStaleTimestampAndSameSequenceConflict() {
        let now = Date(timeIntervalSince1970: 2_000)
        XCTAssertEqual(
            LiveActivityCommandOrderingPolicy.evaluate(
                operation: .update,
                incomingSequence: 3,
                incomingTimestamp: now,
                expiresAt: now.addingTimeInterval(60),
                observedSequence: 2,
                observedTimestamp: now.addingTimeInterval(-1),
                now: now
            ),
            .apply
        )
        XCTAssertEqual(
            LiveActivityCommandOrderingPolicy.evaluate(
                operation: .update,
                incomingSequence: 2,
                incomingTimestamp: now,
                expiresAt: nil,
                observedSequence: 2,
                observedTimestamp: now,
                now: now
            ),
            .conflict
        )
        XCTAssertEqual(
            LiveActivityCommandOrderingPolicy.evaluate(
                operation: .end,
                incomingSequence: 3,
                incomingTimestamp: now.addingTimeInterval(-2),
                expiresAt: nil,
                observedSequence: 2,
                observedTimestamp: now,
                now: now
            ),
            .stale
        )
        XCTAssertFalse(
            LiveActivityCommandOrderingPolicy.permitsInitialStart(
                sequence: 0,
                timestamp: now,
                expiresAt: now,
                now: now
            )
        )
    }

    func testActivityKitTokenCodecProducesLowercaseZeroPaddedHex() {
        XCTAssertEqual(ActivityKitTokenCodec.hex(Data([0x00, 0x0f, 0xa5, 0xff])), "000fa5ff")
    }

    func testActivityKitTimestampTreatsRemoteNumericValueAsUnixSeconds() {
        let date = ActivityKitTimestamp.date(fromUnixSeconds: 1_787_000_000.25)
        XCTAssertEqual(date.timeIntervalSince1970, 1_787_000_000.25, accuracy: 0.001)
        XCTAssertEqual(
            ActivityKitTimestamp.date(fromISO8601: "2026-08-07T00:00:00.250Z")?.timeIntervalSince1970 ?? -1,
            1_786_060_800.25,
            accuracy: 0.001
        )
    }

    func testActivityKitInteractionUsesStrictIntegerUnixSecondsAndExactIDCasing() throws {
        let secret = "credential-at-least-32-characters-long"
        let data = Data(#"{"id":"int_abcdefghijkl","notificationID":"ntf_abcdefghijkl","targetDeviceID":"dev_abcdefghijkl","accountID":"acc_abcdefghijkl","kind":"yes_no","state":"pending","credential":"credential-at-least-32-characters-long","expiresAtUnixSeconds":1735730245}"#.utf8)

        let interaction = try JSONDecoder().decode(LiveActivityContentInteraction.self, from: data)
        let encoded = try JSONEncoder().encode(interaction)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        XCTAssertEqual(interaction.notificationID, "ntf_abcdefghijkl")
        XCTAssertEqual(interaction.targetDeviceID, "dev_abcdefghijkl")
        XCTAssertEqual(interaction.accountID, "acc_abcdefghijkl")
        XCTAssertEqual(interaction.expiresAtUnixSeconds, 1_735_730_245)
        XCTAssertEqual(interaction.expiresAt, Date(timeIntervalSince1970: 1_735_730_245))
        XCTAssertEqual(object["expiresAtUnixSeconds"] as? Int64, 1_735_730_245)
        XCTAssertNil(object["expiresAt"])
        XCTAssertFalse(interaction.description.contains(secret))
        XCTAssertTrue(interaction.description.contains("<redacted>"))
    }

    func testActivityKitInteractionFeedbackRoundTripsWithOptionalPendingFeedback() throws {
        let interaction = LiveActivityContentInteraction(
            id: "int_abcdefghijkl",
            notificationID: "ntf_abcdefghijkl",
            targetDeviceID: "dev_abcdefghijkl",
            accountID: "acc_abcdefghijkl",
            kind: "yes_no",
            state: "pending",
            credential: "credential-at-least-32-characters-long",
            expiresAtUnixSeconds: 1_735_730_245,
            responsePhase: .sending,
            selectedAction: .yes
        )
        let encoded = try JSONEncoder().encode(interaction)
        let decoded = try JSONDecoder().decode(LiveActivityContentInteraction.self, from: encoded)
        let pendingWithoutFeedback = try JSONDecoder().decode(
            LiveActivityContentInteraction.self,
            from: Data(#"{"id":"int_abcdefghijkl","notificationID":"ntf_abcdefghijkl","targetDeviceID":"dev_abcdefghijkl","accountID":"acc_abcdefghijkl","kind":"yes_no","state":"pending","credential":"credential-at-least-32-characters-long","expiresAtUnixSeconds":1735730245}"#.utf8)
        )

        XCTAssertEqual(decoded.responsePhase, .sending)
        XCTAssertEqual(decoded.selectedAction, .yes)
        XCTAssertTrue(decoded.isValidForPresentation)
        XCTAssertNil(pendingWithoutFeedback.responsePhase)
        XCTAssertNil(pendingWithoutFeedback.selectedAction)
        XCTAssertTrue(pendingWithoutFeedback.isValidForPresentation)
    }

    func testActivityKitInteractionFeedbackRejectsImpossibleOrNonBinaryStates() {
        let acceptedPending = LiveActivityContentInteraction(
            id: "int_abcdefghijkl",
            notificationID: "ntf_abcdefghijkl",
            targetDeviceID: "dev_abcdefghijkl",
            accountID: "acc_abcdefghijkl",
            kind: "approval",
            state: "pending",
            credential: "credential-at-least-32-characters-long",
            expiresAtUnixSeconds: 1_735_730_245,
            responsePhase: .accepted,
            selectedAction: .approve
        )
        let terminalMismatch = LiveActivityContentInteraction(
            id: acceptedPending.id,
            notificationID: acceptedPending.notificationID,
            targetDeviceID: acceptedPending.targetDeviceID,
            accountID: acceptedPending.accountID,
            kind: acceptedPending.kind,
            state: "denied",
            credential: acceptedPending.credential,
            expiresAtUnixSeconds: acceptedPending.expiresAtUnixSeconds,
            responsePhase: .accepted,
            selectedAction: .approve
        )
        let textReply = LiveActivityContentInteraction(
            id: acceptedPending.id,
            notificationID: acceptedPending.notificationID,
            targetDeviceID: acceptedPending.targetDeviceID,
            accountID: acceptedPending.accountID,
            kind: "text",
            state: "pending",
            credential: acceptedPending.credential,
            expiresAtUnixSeconds: acceptedPending.expiresAtUnixSeconds,
            responsePhase: .sending,
            selectedAction: .answer
        )

        XCTAssertFalse(acceptedPending.isValidForPresentation)
        XCTAssertFalse(terminalMismatch.isValidForPresentation)
        XCTAssertFalse(textReply.isValidForPresentation)
    }

    func testPresentationDecodesMultipleServerSelectedComponentsAndIdentityRoles() throws {
        let data = Data(#"""
        {
            "generation":7,
            "updatedAt":1786060800,
            "header":"Relo",
            "title":"Ship compositional presentation",
            "subtitle":"Contract and native renderer",
            "status":"Step 4 of 8 · Build iOS renderer",
            "componentsJson":"[{\"colorRole\":\"thread\",\"id\":\"release-steps\",\"items\":[{\"id\":\"server\",\"label\":\"Server\",\"state\":\"complete\"},{\"id\":\"ios\",\"label\":\"iOS\",\"state\":\"current\"}],\"type\":\"steps\"},{\"colorRole\":\"project\",\"id\":\"release-progress\",\"label\":\"50%\",\"type\":\"progress_bar\",\"value\":0.5}]",
            "surfacesJson":"{\"compact_leading\":[\"release-steps\"],\"compact_trailing\":[\"release-progress\"],\"expanded_bottom\":[\"release-steps\"],\"expanded_leading\":[],\"expanded_trailing\":[\"release-progress\"],\"lock_screen\":[\"release-steps\",\"release-progress\"],\"minimal\":[\"release-progress\"]}",
            "identityJson":"{\"direct\":false,\"project\":{\"color\":\"#A78BFA\",\"icon\":\"project\",\"label\":\"Relo\",\"provenance\":\"generated\",\"revision\":1},\"thread\":{\"color\":\"#38BDF8\",\"icon\":\"thread\",\"label\":\"Release execution\",\"provenance\":\"generated\",\"revision\":1}}",
            "stateJson":"{\"icon\":\"active\",\"kind\":\"active\",\"tone\":\"live\"}",
            "behaviorType":"progress",
            "primaryAction":null,
            "primaryLabel":null,
            "secondaryAction":null,
            "secondaryLabel":null,
            "appearanceJson":"{\"roles\":{\"cardIdentity\":\"project\",\"componentIdentity\":\"thread\",\"statusEmphasis\":\"state\"},\"theme\":\"system\"}",
            "privacy":"standard",
            "sequence":2
        }
        """#.utf8)

        let state = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: data)
        let presentation = state.presentation
        XCTAssertEqual(presentation.components(for: .lockScreen).count, 2)
        XCTAssertEqual(presentation.identity.project?.label, "Relo")
        XCTAssertEqual(presentation.identity.thread?.color, "#38BDF8")
        XCTAssertEqual(presentation.state.kind, "active")
        XCTAssertEqual(state.progress, 0.5)

        let roundTrip = try JSONDecoder().decode(
            ReloActivityAttributes.ContentState.self,
            from: JSONEncoder().encode(state)
        )
        XCTAssertEqual(roundTrip.presentation, presentation)
    }

    func testContentStateDecodesStartedAtFromEpochOrISO8601AndToleratesItsAbsence() throws {
        let base = #"{"generation":2,"updatedAt":1786060800,"header":"Relo","title":"Build","status":"Running","componentsJson":"[]","surfacesJson":"{\"compact_leading\":[],\"compact_trailing\":[],\"expanded_bottom\":[],\"expanded_leading\":[],\"expanded_trailing\":[],\"lock_screen\":[],\"minimal\":[]}","identityJson":"{\"direct\":true}","stateJson":"{\"icon\":\"active\",\"kind\":\"active\",\"tone\":\"live\"}","behaviorType":"progress","appearanceJson":"{\"roles\":{\"cardIdentity\":\"project\",\"componentIdentity\":\"thread\",\"statusEmphasis\":\"state\"},\"theme\":\"system\"}","privacy":"standard","sequence":1"#
        let without = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: Data((base + "}").utf8))
        XCTAssertNil(without.startedAt)

        let epoch = try JSONDecoder().decode(
            ReloActivityAttributes.ContentState.self, from: Data((base + #","startedAt":1786057200}"#).utf8))
        XCTAssertEqual(epoch.startedAt, Date(timeIntervalSince1970: 1_786_057_200))

        let iso = try JSONDecoder().decode(
            ReloActivityAttributes.ContentState.self, from: Data((base + #","startedAt":"2026-08-06T23:00:00Z"}"#).utf8))
        XCTAssertEqual(iso.startedAt, Date(timeIntervalSince1970: 1_786_057_200))

        // Dates travel as Unix seconds, as they do on the wire.
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let roundTrip = try JSONDecoder().decode(
            ReloActivityAttributes.ContentState.self, from: encoder.encode(epoch))
        XCTAssertEqual(roundTrip.startedAt, epoch.startedAt)
        let bare = try JSONDecoder().decode(
            ReloActivityAttributes.ContentState.self, from: encoder.encode(without))
        XCTAssertNil(bare.startedAt)
    }

    func testActivityKitInteractionRejectsMissingNullFractionalStringAndLegacyDateExpiry() {
        let prefix = #"{"id":"int_abcdefghijkl","notificationID":"ntf_abcdefghijkl","targetDeviceID":"dev_abcdefghijkl","accountID":"acc_abcdefghijkl","kind":"approval","state":"pending","credential":"credential-at-least-32-characters-long""#
        let invalid = [
            prefix + "}",
            prefix + #", "expiresAtUnixSeconds":null}"#,
            prefix + #", "expiresAtUnixSeconds":1735730245.5}"#,
            prefix + #", "expiresAtUnixSeconds":"1735730245"}"#,
            prefix + #", "expiresAt":"2025-01-01T00:00:00Z"}"#,
        ]

        for json in invalid {
            XCTAssertThrowsError(
                try JSONDecoder().decode(LiveActivityContentInteraction.self, from: Data(json.utf8)),
                "Unexpectedly decoded: \(json)"
            )
        }
    }

    func testActivityKitInteractionEpochAndSupportedRangeAreExplicit() {
        let epoch = liveActivityContentInteraction(expiresAtUnixSeconds: 0)
        let maximum = liveActivityContentInteraction(
            expiresAtUnixSeconds: LiveActivityContentInteraction.maximumUnixSeconds
        )
        let negative = liveActivityContentInteraction(expiresAtUnixSeconds: -1)
        let beyondMaximum = liveActivityContentInteraction(
            expiresAtUnixSeconds: LiveActivityContentInteraction.maximumUnixSeconds + 1
        )

        XCTAssertEqual(epoch.expiresAt, Date(timeIntervalSince1970: 0))
        XCTAssertTrue(epoch.isValidForPresentation)
        XCTAssertTrue(maximum.isValidForPresentation)
        XCTAssertFalse(negative.isValidForPresentation)
        XCTAssertFalse(beyondMaximum.isValidForPresentation)
    }

    func testAPNsOwnedStartCannotCreateLocalDuplicateButFallbackCan() {
        let apnsOwned = LiveActivityCommand(
            operation: .start,
            activityId: "act_abcdefghijkl",
            generation: 1,
            targetDeviceId: "dev_abcdefghijkl",
            style: "standard",
            sourceName: "Codex",
            headline: "Build",
            status: "Running",
            alertOwner: .apns
        )
        let appOwned = LiveActivityCommand(
            operation: .start,
            activityId: "act_abcdefghijkl",
            generation: 1,
            targetDeviceId: "dev_abcdefghijkl",
            style: "standard",
            sourceName: "Codex",
            headline: "Build",
            status: "Running",
            alertOwner: .app
        )

        XCTAssertFalse(apnsOwned.permitsLocalStart)
        XCTAssertTrue(appOwned.permitsLocalStart)
    }

    func testOnlyServerSelectedUpdatesPermitLocalActivityRecovery() {
        func update(state: String) -> LiveActivityCommand {
            LiveActivityCommand(
                operation: .update,
                activityId: "act_abcdefghijkl",
                generation: 1,
                targetDeviceId: "dev_abcdefghijkl",
                style: "steps",
                sourceName: "Codex",
                headline: "Build",
                status: "Level 7 · 38%",
                presentationState: state
            )
        }

        XCTAssertTrue(update(state: "foreground").permitsLocalRecovery)
        XCTAssertTrue(update(state: "pending_token").permitsLocalRecovery)
        XCTAssertFalse(update(state: "background").permitsLocalRecovery)
        XCTAssertFalse(update(state: "not_presented").permitsLocalRecovery)
    }

    func testFileReceiptStoreSerializesIndependentConcurrentWritersAndRemovers() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relo-receipts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = FilePendingNotificationReceiptStore(baseDirectory: directory, maximumStored: 500)
        let second = FilePendingNotificationReceiptStore(baseDirectory: directory, maximumStored: 500)

        DispatchQueue.concurrentPerform(iterations: 200) { index in
            let identifier = String(format: "ntf_%012d", index)
            do { try (index.isMultiple(of: 2) ? first : second).add(notificationID: identifier) }
            catch { XCTFail("Receipt append failed: \(error)") }
        }
        XCTAssertEqual(Set(try first.pending(limit: 500)).count, 200)

        let group = DispatchGroup()
        let queue = DispatchQueue(label: "relo.receipts.concurrent", attributes: .concurrent)
        group.enter()
        queue.async {
            // A bounded lock attempt may yield to writers; replay the same removal below.
            _ = Result { try first.remove(notificationIDs: Set((0..<100).map { String(format: "ntf_%012d", $0) })) }
            group.leave()
        }
        for index in 200..<300 {
            group.enter()
            queue.async {
                do { try second.add(notificationID: String(format: "ntf_%012d", index)) }
                catch { XCTFail("Receipt append failed: \(error)") }
                group.leave()
            }
        }
        group.wait()
        try first.remove(notificationIDs: Set((0..<100).map { String(format: "ntf_%012d", $0) }))

        let pending = Set(try first.pending(limit: 500))
        XCTAssertEqual(pending.count, 200)
        XCTAssertTrue(pending.contains("ntf_000000000299"))
        XCTAssertFalse(pending.contains("ntf_000000000000"))
    }

    private func liveActivityContentInteraction(
        expiresAtUnixSeconds: Int64
    ) -> LiveActivityContentInteraction {
        LiveActivityContentInteraction(
            id: "int_abcdefghijkl",
            notificationID: "ntf_abcdefghijkl",
            targetDeviceID: "dev_abcdefghijkl",
            accountID: "acc_abcdefghijkl",
            kind: "approval",
            state: "pending",
            credential: "credential-at-least-32-characters-long",
            expiresAtUnixSeconds: expiresAtUnixSeconds
        )
    }
}
