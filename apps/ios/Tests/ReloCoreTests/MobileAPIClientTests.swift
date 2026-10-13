@testable import ReloTransport
@testable import ReloPersistence
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ReloCore

final class MobileAPIClientTests: XCTestCase {
    func testDecisionRequestCarriesExactIDAndValidatesCanonicalAcknowledgement() async throws {
        let credential = DeviceCredential(deviceId: "device", installationId: UUID(), accessToken: "test",
            issuedAt: .now, accountId: "account", credentialVersion: 1)
        let pending = PendingNotificationResponse(accountID: "account", deviceID: "device", notificationID: "event",
            action: .approve, value: [:], idempotencyKey: "original", expiresAt: .now.addingTimeInterval(300),
            interactionID: "request-original", serverOrigin: baseURL)
        StubURLProtocol.handler = { request in
            let body = try XCTUnwrap(Self.bodyData(request))
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(object["expectedInteractionId"] as? String, "request-original")
            XCTAssertEqual(object["idempotencyKey"] as? String, "original")
            XCTAssertEqual(request.timeoutInterval, 5)
            return Self.response(request, status: 201,
                body: #"{"decision":{"id":"request-original","state":"approved","respondedAt":"2026-09-30T12:00:00.000Z"}}"#)
        }
        let client = HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
        let accepted = try await client.submitDecision(credential: credential, response: pending)
        XCTAssertEqual(accepted.id, "request-original"); XCTAssertEqual(accepted.state, "approved")
        for body in [#"{}"#,
                     #"{"decision":{"id":"newer-request","state":"approved","respondedAt":"2026-09-30T12:00:00Z"}}"#,
                     #"{"decision":{"id":"request-original","state":"denied","respondedAt":"2026-09-30T12:00:00Z"}}"#] {
            StubURLProtocol.handler = { Self.response($0, status: 200, body: body) }
            do {
                _ = try await client.submitDecision(credential: credential, response: pending)
                XCTFail("Unrelated or malformed acknowledgement must not confirm the reply")
            } catch { XCTAssertEqual(error as? MobileAPIError, .invalidResponse) }
        }
        StubURLProtocol.handler = { Self.response($0, status: 409, body: #"{"error":"interaction_superseded"}"#) }
        do { _ = try await client.submitDecision(credential: credential, response: pending); XCTFail("Expected rejection") }
        catch { XCTAssertEqual(error as? MobileAPIError, .decisionRejected(.superseded)) }
    }

    func testHistorySnapshotUsesOneNoCacheRequestAndRejectsFullContent() async throws {
        let body = #"{"items":[{"id":"ntf_exact","kind":"notification","sourceName":"Source","title":"Title","privacy":"standard","createdAt":"2026-09-30T12:00:00.123456Z","updatedAt":"2026-09-30T12:00:00.123456Z","contentSummary":{"summary":"Preview","format":"markdown","byteLength":65536}}],"total":9000,"serverTime":"2026-09-30T12:00:00.123456Z","unread":{"account":8000,"projects":{}}}"#
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/inbox/snapshot")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture")
            return Self.response(request, status: 200, body: body)
        }
        let remote = HTTPInboxDataSource(baseURL: baseURL, token: "fixture", session: makeSession())
        let result = try await remote.fetchSnapshot()
        XCTAssertEqual(result.total, 9000)
        XCTAssertEqual(result.items[0].item.detail, "Preview")
        XCTAssertNil(result.items[0].item.content)
        XCTAssertEqual(result.items[0].item.createdAt, result.serverTime)
        StubURLProtocol.handler = { request in
            Self.response(request, status: 200, body: body.replacingOccurrences(of: "\"title\":", with: "\"content\":null,\"title\":"))
        }
        do { _ = try await remote.fetchSnapshot(); XCTFail("Full-content key crossed summary boundary") }
        catch { XCTAssertEqual(error as? InboxRemoteError, .incompatibleResponse) }
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testBrowserSignInExchangePostsCodeAndVerifier() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        let body = LockedTestValue<Data?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            body.value = Self.bodyData(request)
            return Self.response(
                request,
                status: 200,
                body: #"{"sessionToken":"account-session-secret","session":{"id":"session-id","expiresAt":"2026-08-13T12:00:00.000Z"},"user":{"id":"better-auth-subject","name":"Developer","email":"owner@example.com"}}"#
            )
        }

        let client = HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
        let session = try await client.exchangeBrowserSignIn(code: "relo_signin_x", codeVerifier: "verifier", installationId: "install")

        XCTAssertEqual(session.accessToken, "account-session-secret")
        XCTAssertEqual(session.sessionId, "session-id")
        XCTAssertEqual(session.user.id, "better-auth-subject")
        XCTAssertEqual(captured.value?.url?.path, "/api/mobile/sign-in/token")
        XCTAssertEqual(captured.value?.httpMethod, "POST")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body.value)) as? [String: Any])
        XCTAssertEqual(object["code"] as? String, "relo_signin_x")
        XCTAssertEqual(object["codeVerifier"] as? String, "verifier")
        XCTAssertEqual(object["installationId"] as? String, "install")
    }

    func testBrowserSignInExchangeMapsFailures() async throws {
        let cases: [(Int, MobileAPIError)] = [(400, .invalidRequest), (403, .accountDisabled), (500, .unavailable)]
        for (status, expected) in cases {
            StubURLProtocol.handler = { request in Self.response(request, status: status, body: #"{"error":"x"}"#) }
            let client = HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
            do {
                _ = try await client.exchangeBrowserSignIn(code: "c", codeVerifier: "v", installationId: "i")
                XCTFail("Expected \(expected)")
            } catch { XCTAssertEqual(error as? MobileAPIError, expected) }
        }
    }

    func testRegisterDeviceUsesAccountBearerAndIdempotencyKey() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        let capturedBody = LockedTestValue<Data?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            if let data = Self.bodyData(request) {
                capturedBody.value = data
            }
            return Self.response(
                request,
                status: 200,
                body: #"{"account":{"accountId":"acc_0123456789ab","name":"Developer","email":"owner@example.com","imageUrl":null},"device":{"deviceId":"dev_0123456789ab","installationId":"6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8","registrationState":"active","credentialVersion":2},"credential":{"accessToken":"relo_secret_returned_once","issuedAt":"2026-08-06T12:00:00.000Z","expiresAt":null}}"#
            )
        }
        let request = registrationRequest()
        let client = HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())

        let result = try await client.registerDevice(
            sessionToken: "account-session-secret",
            request: request,
            idempotencyKey: "ios-register:\(request.installationId.uuidString.lowercased()):1"
        )

        XCTAssertEqual(result.account.accountId, "acc_0123456789ab")
        XCTAssertEqual(result.device.credentialVersion, 2)
        XCTAssertEqual(captured.value?.url?.path, "/api/devices/register")
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer account-session-secret")
        XCTAssertEqual(
            captured.value?.value(forHTTPHeaderField: "Idempotency-Key"),
            "ios-register:\(request.installationId.uuidString.lowercased()):1"
        )
        let object = try XCTUnwrap(capturedBody.jsonObject)
        XCTAssertNil(object["pairingCode"])
        XCTAssertEqual(object["bundleIdentifier"] as? String, "com.example.relo.notifications")
        XCTAssertNil(object["mobileContractVersion"])
    }

    func testActiveLiveActivitySnapshotCarriesCanonicalRecoveryCommand() async throws {
        let createdAt = Date(timeIntervalSince1970: 1_786_890_000)
        let command = LiveActivityCommand(
            operation: .update,
            activityId: "act_0123456789ab",
            generation: 2,
            targetDeviceId: "dev_0123456789ab",
            style: "steps",
            sourceName: "Relo",
            headline: "Recover activity",
            status: "Running",
            sequence: 4
        )
        let responseBody = ActiveLiveActivityIdentityPage(activities: [.init(
            id: command.activityId,
            generation: command.generation,
            eventId: "ntf_0123456789ab",
            createdAt: createdAt,
            command: command
        )])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let body = try XCTUnwrap(String(data: encoder.encode(responseBody), encoding: .utf8))
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(request, status: 200, body: body)
        }

        let page = try await HTTPInboxDataSource(
            baseURL: baseURL,
            token: "device-secret",
            session: makeSession()
        ).fetchActiveLiveActivities()

        XCTAssertEqual(captured.value?.url?.path, "/api/inbox/live-activities/active")
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        XCTAssertEqual(page.activities.first?.recoveryEnvelope?.eventID, "ntf_0123456789ab")
        XCTAssertEqual(page.activities.first?.recoveryEnvelope?.command.sequence, 4)
    }

    func testDeviceSelfUsesDeviceCredential() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(
                request,
                status: 200,
                body: #"{"account":{"accountId":"acc_0123456789ab","name":"Developer","email":"owner@example.com","imageUrl":null},"device":{"deviceId":"dev_0123456789ab","installationId":"6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8","registrationState":"active","credentialVersion":2}}"#
            )
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        let result = try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
            .deviceSelf(credential: credential)

        XCTAssertEqual(result.account.accountId, "acc_0123456789ab")
        XCTAssertEqual(captured.value?.url?.path, "/api/devices/self")
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
    }

    func testDeliveryStatusUsesAccountSessionBearerAndPreservesTransportTruth() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(
                request,
                status: 200,
                body: #"{"apns":{"mode":"sandbox","remoteEnqueueEnabled":true,"providerCredentialActive":null,"deliverySemantics":"worker_direct_apns"}}"#
            )
        }

        let status = try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
            .deliveryTransportStatus(sessionToken: "account-session-secret")

        XCTAssertEqual(captured.value?.url?.path, "/api/account/deliveries/status")
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer account-session-secret")
        XCTAssertEqual(status.apns.mode, .sandbox)
        XCTAssertTrue(status.apns.remoteEnqueueEnabled)
        XCTAssertNil(status.apns.providerCredentialActive)
        XCTAssertEqual(status.apns.deliverySemantics, .workerDirectAPNs)
        XCTAssertTrue(status.apns.directDeliveryConfigured)
    }

    func testDeliveryStatusErrorGuidanceDistinguishesAuthenticationTailnetAndContractFailures() {
        XCTAssertEqual(
            DeliveryTransportStatusErrorGuidance.message(for: MobileAPIError.reauthenticationRequired),
            "Your Relo server session expired. Sign in again to check the delivery path."
        )
        XCTAssertEqual(
            DeliveryTransportStatusErrorGuidance.message(for: MobileAPIError.tailnetUnavailable),
            "The private Tailnet is unavailable."
        )
        XCTAssertEqual(
            DeliveryTransportStatusErrorGuidance.message(for: MobileAPIError.invalidResponse),
            "Relo server returned an incompatible delivery-path status."
        )
    }

    func testDeliveryStatusTreatsMissingEndpointAsUnavailable() async throws {
        StubURLProtocol.handler = { request in
            Self.response(request, status: 404, body: #"{"error":"not_found"}"#)
        }

        do {
            _ = try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
                .deliveryTransportStatus(sessionToken: "account-session-secret")
            XCTFail("Expected unavailable delivery status")
        } catch let error as MobileAPIError {
            XCTAssertEqual(error, .unavailable)
        }
    }

    func testDeliveryStatusDecodesDurableInboxOnlyAndRejectsUnknownSemantics() async throws {
        StubURLProtocol.handler = { request in
            Self.response(
                request,
                status: 200,
                body: #"{"apns":{"mode":"disabled","remoteEnqueueEnabled":false,"providerCredentialActive":false,"deliverySemantics":"durable_inbox_refresh_only"}}"#
            )
        }
        let client = HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())

        let status = try await client.deliveryTransportStatus(sessionToken: "account-session-secret")
        XCTAssertEqual(status.apns.mode, .disabled)
        XCTAssertFalse(status.apns.directDeliveryConfigured)

        StubURLProtocol.handler = { request in
            Self.response(
                request,
                status: 200,
                body: #"{"apns":{"mode":"disabled","remoteEnqueueEnabled":false,"providerCredentialActive":false,"deliverySemantics":"accepted_means_received"}}"#
            )
        }
        do {
            _ = try await client.deliveryTransportStatus(sessionToken: "account-session-secret")
            XCTFail("Unknown delivery semantics must fail closed")
        } catch let error as MobileAPIError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }

    func testHistoryPageUsesBackwardCursorAndDeviceBearer() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(
                request,
                status: 200,
                body: #"{"items":[{"id":"evt_abcdefghijkl","kind":"notification","sourceName":"Codex","sourceImageUrl":null,"title":"Done","detail":null,"result":null,"deliveryState":"accepted_by_apns","apnsAcceptedAt":null,"receivedAt":null,"openedAt":null,"createdAt":"2027-01-15T11:59:00.123456Z"}],"cursor":null,"hasMore":false,"total":2101,"serverTime":"2027-01-15T12:00:01.123456Z"}"#
            )
        }

        let page = try await HTTPInboxDataSource(
            baseURL: baseURL,
            token: "device-secret",
            session: makeSession()
        ).fetchHistoryPage(before: "previous opaque cursor")

        XCTAssertEqual(captured.value?.url?.path, "/api/inbox/history")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(captured.value?.url), resolvingAgainstBaseURL: false)?.queryItems,
            [
                URLQueryItem(name: "limit", value: "100"),
                URLQueryItem(name: "before", value: "previous opaque cursor"),
            ]
        )
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        XCTAssertEqual(page.total, 2_101)
        XCTAssertNil(page.cursor)
        XCTAssertFalse(page.hasMore)
        XCTAssertEqual(page.items.first?.id, "evt_abcdefghijkl")
    }

    func testHistoryPageMapsExpiredCursorAndRejectsInvalidCursorContract() async throws {
        StubURLProtocol.handler = { request in
            Self.response(request, status: 410, body: #"{"error":"cursor_expired"}"#)
        }
        let client = HTTPInboxDataSource(
            baseURL: baseURL,
            token: "device-secret",
            session: makeSession()
        )

        do {
            _ = try await client.fetchHistoryPage(before: "expired")
            XCTFail("HTTP 410 must reset history pagination")
        } catch let error as InboxRemoteError {
            XCTAssertEqual(error, .cursorExpired)
        }

        StubURLProtocol.handler = { request in
            Self.response(
                request,
                status: 200,
                body: #"{"items":[],"cursor":null,"hasMore":true,"total":1,"serverTime":"2027-01-15T12:00:01Z"}"#
            )
        }
        do {
            _ = try await client.fetchHistoryPage(before: nil)
            XCTFail("hasMore without an opaque cursor must fail closed")
        } catch let error as InboxRemoteError {
            XCTAssertEqual(error, .unavailable)
        }
    }

    func testNotificationDetailDecodesLongContentAndOrderedEvidence() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(
                request,
                status: 200,
                body: ##"{"item":{"id":"ntf_01234567-89ab-4cde-8fab-0123456789ab","kind":"notification","sourceName":"Codex","title":"Release","content":{"summary":"Ready","body":"# Full detail","format":"markdown","byteLength":13},"createdAt":"2026-08-14T00:00:00.000Z"},"evidence":{"deliveries":[{"id":"job_01234567-89ab-4cde-8fab-0123456789ab","deviceId":"dev_01234567-89ab-4cde-8fab-0123456789ab","transport":"notification","state":"accepted","attemptCount":1,"providerOutcome":null,"errorCode":null,"acceptedAt":"2026-08-14T00:00:01.000Z","createdAt":"2026-08-14T00:00:00.000Z","updatedAt":"2026-08-14T00:00:01.000Z"}],"interactions":[{"kind":"opened","createdAt":"2026-08-14T00:00:02.000Z"}],"withdrawals":[]}}"##
            )
        }

        let detail = try await HTTPInboxDataSource(
            baseURL: baseURL,
            token: "device-secret",
            session: makeSession()
        ).fetchDetail(notificationID: "ntf_01234567-89ab-4cde-8fab-0123456789ab")

        XCTAssertEqual(
            captured.value?.url?.path,
            "/api/inbox/ntf_01234567-89ab-4cde-8fab-0123456789ab"
        )
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        XCTAssertEqual(detail.item.content?.body, "# Full detail")
        XCTAssertEqual(detail.evidence.deliveries.first?.state, "accepted")
        XCTAssertEqual(detail.evidence.interactions.first?.kind, "opened")
    }

    func testInboxPageDistinguishesTailnetFailureFromIncompatibleServerData() async throws {
        let client = HTTPInboxDataSource(
            baseURL: baseURL,
            token: "device-secret",
            session: makeSession()
        )

        StubURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await client.fetchHistoryPage(before: nil)
            XCTFail("A tailnet transport failure must not be reported as a server or cache failure")
        } catch let error as InboxRemoteError {
            XCTAssertEqual(error, .tailnetUnavailable)
            XCTAssertEqual(InboxRefreshErrorGuidance.message(for: error), "Tailnet unavailable")
        }

        StubURLProtocol.handler = { request in
            Self.response(request, status: 200, body: #"{"items":[{"invalid":true}]}"#)
        }
        do {
            _ = try await client.fetchHistoryPage(before: nil)
            XCTFail("An incompatible successful response must be identified at the decode boundary")
        } catch let error as InboxRemoteError {
            XCTAssertEqual(error, .incompatibleResponse)
            XCTAssertEqual(
                InboxRefreshErrorGuidance.message(for: error),
                "Relo server returned incompatible activity data"
            )
        }
    }

    func testInboxRefreshGuidanceNamesLocalCacheAndServerFailuresTruthfully() {
        struct LocalCacheFailure: Error {}
        XCTAssertEqual(
            InboxRefreshErrorGuidance.message(for: LocalCacheFailure()),
            "Local Inbox cache could not be read or saved"
        )
        XCTAssertEqual(
            InboxRefreshErrorGuidance.message(for: InboxRemoteError.unavailable),
            "Relo server Inbox service unavailable"
        )
    }

    func testLiveActivityTokenRegistrationUsesFrozenDeviceEndpointAndBody() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        let body = LockedTestValue<Data?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            if let data = Self.bodyData(request) {
                body.value = data
            }
            return Self.response(request, status: 204, body: "")
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
            .registerLiveActivityToken(
                credential: credential,
                activityId: "act_abcdefghijkl",
                registration: LiveActivityTokenRegistration(
                    token: "000fa5ff",
                    nativeActivityId: "native-activity-id",
                    environment: "sandbox",
                    generation: 7
                )
            )

        XCTAssertEqual(captured.value?.httpMethod, "PUT")
        XCTAssertEqual(
            captured.value?.url?.path,
            "/api/devices/self/live-activities/act_abcdefghijkl/token"
        )
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        let object = try XCTUnwrap(body.jsonObject)
        XCTAssertEqual(Set(object.keys), Set(["token", "nativeActivityId", "environment", "generation"]))
        XCTAssertEqual(object["token"] as? String, "000fa5ff")
        XCTAssertEqual(object["nativeActivityId"] as? String, "native-activity-id")
        XCTAssertEqual(object["environment"] as? String, "sandbox")
        XCTAssertEqual(object["generation"] as? Int, 7)
    }

    func testLiveActivityTokenRegistrationTreatsGenerationMismatchAsTerminalInvalidRequest() async throws {
        StubURLProtocol.handler = { request in
            Self.response(
                request,
                status: 409,
                body: #"{"error":"activity_generation_mismatch","code":"ACTIVITY_GENERATION_MISMATCH","generation":8}"#
            )
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        do {
            try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
                .registerLiveActivityToken(
                    credential: credential,
                    activityId: "act_abcdefghijkl",
                    registration: LiveActivityTokenRegistration(
                        token: "000fa5ff",
                        nativeActivityId: "native-activity-id",
                        environment: "sandbox",
                        generation: 7
                    )
                )
            XCTFail("A generation mismatch must not enter the transient retry path")
        } catch let error as MobileAPIError {
            XCTAssertEqual(error, .invalidRequest)
        }
    }

    func testLiveActivityDismissalUsesDeviceBearerAndExactActivityEndpoint() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(request, status: 200, body: #"{"status":"dismissed","changed":true}"#)
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
            .reportLiveActivityDismissed(
                credential: credential,
                activityId: "act_abcdefghijkl"
            )

        XCTAssertEqual(captured.value?.httpMethod, "POST")
        XCTAssertEqual(
            captured.value?.url?.path,
            "/api/devices/self/live-activities/act_abcdefghijkl/dismissed"
        )
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        XCTAssertNil(Self.bodyData(try XCTUnwrap(captured.value)))
    }

    func testInteractionSubmissionUsesDeviceBearerAndIdempotencyBody() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        let body = LockedTestValue<Data?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            if let data = Self.bodyData(request) {
                body.value = data
            }
            return Self.response(request, status: 201, body: #"{"interactionId":"int_abcdefghijkl","replayed":false}"#)
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).submitInteraction(
            credential: credential,
            notificationId: "ntf_abcdefghijkl",
            action: .approve,
            value: [:],
            idempotencyKey: "ios:approve:ntf_abcdefghijkl"
        )

        XCTAssertEqual(captured.value?.url?.path, "/api/notifications/ntf_abcdefghijkl/interactions")
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        XCTAssertEqual(body.jsonObject?["kind"] as? String, "approve")
        XCTAssertEqual(body.jsonObject?["idempotencyKey"] as? String, "ios:approve:ntf_abcdefghijkl")
    }

    func testLiveActivityReceivedReceiptUsesGenericInteractionContract() async throws {
        let body = LockedTestValue<Data?>(nil)
        StubURLProtocol.handler = { request in
            if let data = Self.bodyData(request) {
                body.value = data
            }
            return Self.response(request, status: 201, body: #"{"interactionId":"int_abcdefghijkl","replayed":false}"#)
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).submitInteraction(
            credential: credential,
            notificationId: "ntf_liveactivity12",
            action: .received,
            value: [:],
            idempotencyKey: "ios:6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8:ntf_liveactivity12:received"
        )

        XCTAssertEqual(body.jsonObject?["kind"] as? String, "received")
        XCTAssertEqual(
            body.jsonObject?["idempotencyKey"] as? String,
            "ios:6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8:ntf_liveactivity12:received"
        )
    }

    func testInteractionSubmissionMapsHTTP400ToInvalidRequest() async throws {
        StubURLProtocol.handler = { request in
            Self.response(request, status: 400, body: #"{"error":"invalid_interaction"}"#)
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )

        do {
            try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).submitInteraction(
                credential: credential,
                notificationId: "ntf_abcdefghijkl",
                action: .answer,
                value: ["response": "invalid"],
                idempotencyKey: "ios:answer:ntf_abcdefghijkl"
            )
            XCTFail("HTTP 400 must be a terminal invalid-request error")
        } catch let error as MobileAPIError {
            XCTAssertEqual(error, .invalidRequest)
        }
    }

    func testAPISessionNeverSendsCookies() {
        // A stored Better Auth cookie made the server refuse sign-out (403 without Origin).
        let configuration = ReloAPISession.shared.configuration
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
    }

    func testRegistrationKeysNeverRepeatAcrossSignIns() {
        // Sign-out resets the attempt revision; the session keeps a new sign-in's key unused.
        let request = registrationRequest()
        let attempt = RegistrationAttempt(revision: 1, request: request)
        let first = attempt.idempotencyKey(installationId: request.installationId, sessionId: "session-one")
        XCTAssertNotEqual(first, attempt.idempotencyKey(installationId: request.installationId, sessionId: "session-two"))
        XCTAssertEqual(first, attempt.idempotencyKey(installationId: request.installationId, sessionId: "session-one"))
    }

    func testTwoCredentialSignOutUsesIndependentBearersAndAcceptsAlreadyRevoked() async throws {
        let requests = LockedTestValue<[URLRequest]>([])
        StubURLProtocol.handler = { request in
            requests.update { $0.append(request) }
            return Self.response(request, status: 401, body: #"{"error":"already_revoked"}"#)
        }
        let credential = DeviceCredential(
            deviceId: "dev_0123456789ab",
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            accessToken: "device-secret",
            issuedAt: .now,
            accountId: "acc_0123456789ab",
            credentialVersion: 1
        )
        let client = HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())

        try await client.revokeDevice(credential: credential)
        try await client.signOutAccount(sessionToken: "account-session-secret")

        XCTAssertEqual(requests.value.map { $0.httpMethod }, ["DELETE", "POST"])
        XCTAssertEqual(requests.value.map { $0.url?.path }, ["/api/devices/dev_0123456789ab", "/api/auth/sign-out"])
        XCTAssertEqual(requests.value[0].value(forHTTPHeaderField: "Authorization"), "Bearer device-secret")
        XCTAssertEqual(requests.value[1].value(forHTTPHeaderField: "Authorization"), "Bearer account-session-secret")
        // The auth endpoint answers a bodiless JSON POST with 400, which used to pause sign-out for good.
        XCTAssertEqual(Self.bodyData(requests.value[1]), Data("{}".utf8))
    }

    func testAccountDeletionUsesSessionBearerAndFrozenConfirmationBody() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        let body = LockedTestValue<Data?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            if let data = Self.bodyData(request) {
                body.value = data
            }
            return Self.response(request, status: 200, body: #"{"ok":true}"#)
        }

        try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).deleteAccount(
            sessionToken: "account-session-secret",
            password: "unique-password",
            confirmation: "DELETE"
        )

        XCTAssertEqual(captured.value?.httpMethod, "POST")
        XCTAssertEqual(captured.value?.url?.path, "/api/account/delete")
        XCTAssertEqual(captured.value?.value(forHTTPHeaderField: "Authorization"), "Bearer account-session-secret")
        XCTAssertEqual(Set(body.jsonObject?.keys.map { $0 } ?? []), Set(["password", "confirmation"]))
        XCTAssertEqual(body.jsonObject?["password"] as? String, "unique-password")
        XCTAssertEqual(body.jsonObject?["confirmation"] as? String, "DELETE")
    }

    func testNotificationWithdrawalUsesAccountBearerAndEncodedIdentifier() async throws {
        let captured = LockedTestValue<URLRequest?>(nil)
        StubURLProtocol.handler = { request in
            captured.value = request
            return Self.response(
                request,
                status: 200,
                body: #"{"state":"withdrawn","withdrawnAt":"2026-08-14T00:00:00.000Z"}"#
            )
        }

        try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession())
            .withdrawNotification(
                sessionToken: "account-session-secret",
                notificationID: "ntf_01234567-89ab-4cde-8fab-0123456789ab"
            )

        XCTAssertEqual(captured.value?.httpMethod, "POST")
        XCTAssertEqual(
            captured.value?.url?.path,
            "/api/account/notifications/ntf_01234567-89ab-4cde-8fab-0123456789ab/withdraw"
        )
        XCTAssertEqual(
            captured.value?.value(forHTTPHeaderField: "Authorization"),
            "Bearer account-session-secret"
        )
    }

    func testAccountDeletionFailureIsFailClosed() async throws {
        StubURLProtocol.handler = { request in
            Self.response(request, status: 400, body: #"{"error":"invalid_confirmation"}"#)
        }

        do {
            try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).deleteAccount(
                sessionToken: "account-session-secret",
                password: "wrong-password",
                confirmation: "DELETE"
            )
            XCTFail("A rejected deletion must not be treated as committed")
        } catch let error as MobileAPIError {
            XCTAssertEqual(error, .invalidRequest)
        }
    }

    func testAccountDeletionRequiresExplicitCommittedSuccessBody() async throws {
        let responses: [(Int, String)] = [
            (204, ""),
            (200, #"{"ok":false}"#),
            (200, #"{"unexpected":true}"#),
        ]

        for (status, body) in responses {
            StubURLProtocol.handler = { request in
                Self.response(request, status: status, body: body)
            }
            do {
                try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).deleteAccount(
                    sessionToken: "account-session-secret",
                    password: "unique-password",
                    confirmation: "DELETE"
                )
                XCTFail("An uncommitted response must not authorize local cleanup")
            } catch {
                XCTAssertTrue(error is MobileAPIError)
            }
        }
    }

    func testAccountDeletionMapsInvalidPasswordSeparatelyFromExpiredSession() async throws {
        let cases: [(String, MobileAPIError)] = [
            (#"{"error":"invalid_password"}"#, .invalidCredentials),
            (#"{"error":"session_expired"}"#, .reauthenticationRequired),
        ]

        for (body, expectedError) in cases {
            StubURLProtocol.handler = { request in
                Self.response(request, status: 401, body: body)
            }

            do {
                try await HTTPMobileAPIClient(baseURL: baseURL, session: makeSession()).deleteAccount(
                    sessionToken: "account-session-secret",
                    password: "unique-password",
                    confirmation: "DELETE"
                )
                XCTFail("A 401 deletion response must fail closed")
            } catch let error as MobileAPIError {
                XCTAssertEqual(error, expectedError)
            }
        }
    }

    func testAccountDeletionGuidanceDistinguishesWrongPasswordFromExpiredSession() {
        let wrongPassword = AccountDeletionErrorGuidance.message(for: MobileAPIError.invalidCredentials)
        let expiredSession = AccountDeletionErrorGuidance.message(for: MobileAPIError.reauthenticationRequired)

        XCTAssertEqual(
            wrongPassword,
            "The current password is incorrect. Check it and try again; nothing was removed from this iPhone."
        )
        XCTAssertEqual(
            expiredSession,
            "Your Relo server session expired. Sign in again before deleting the account; nothing was removed."
        )
        XCTAssertNotEqual(wrongPassword, expiredSession)
    }

    func testDashboardURLUsesConfiguredOrigin() throws {
        let provider = try XCTUnwrap(DashboardURLProvider(origin: baseURL))
        XCTAssertEqual(provider.dashboardURL.absoluteString, "http://192.168.1.10:8180/dashboard")
        XCTAssertNil(DashboardURLProvider(origin: URL(string: "http://example.com")!))
    }

    func testRuntimeOriginPrefersSharedPairingAndRejectsUnsafeValues() {
        XCTAssertEqual(
            RuntimeServerOrigin.resolve(
                sharedOrigin: "https://paired.relo.example",
                localOrigin: "https://local.relo.example",
                bundledOrigin: "https://relo.invalid"
            )?.absoluteString,
            "https://paired.relo.example"
        )
        XCTAssertEqual(
            RuntimeServerOrigin.resolve(
                sharedOrigin: "not a URL",
                localOrigin: "https://local.relo.example",
                bundledOrigin: "https://relo.invalid"
            )?.absoluteString,
            "https://local.relo.example"
        )
        XCTAssertNil(RuntimeServerOrigin.resolve(
            sharedOrigin: nil,
            localOrigin: "http://public.example",
            bundledOrigin: nil
        ))
    }

    private var baseURL: URL { URL(string: "http://192.168.1.10:8180")! }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func registrationRequest() -> DeviceRegistrationRequest {
        DeviceRegistrationRequest(
            stableDeviceId: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
            installationId: UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!,
            name: "Developer's iPhone",
            bundleIdentifier: "com.example.relo.notifications",
            appVersion: "1.0.0",
            appBuild: "1",
            osVersion: "18.0",
            model: "iPhone",
            apnsEnvironment: "sandbox",
            notificationAuthorization: .authorized,
            liveActivityAuthorization: .authorized
        )
    }

    private static func response(
        _ request: URLRequest,
        status: Int,
        headers: [String: String] = [:],
        body: String
    ) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!,
            Data(body.utf8)
        )
    }

    private static func bodyData(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 4_096)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    private static let handlers = LockedTestValue<Handler?>(nil)
    static var handler: Handler? {
        get { handlers.value }
        set { handlers.value = newValue }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: MobileAPIError.unavailable)
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

/// XCTest callbacks and URLProtocol run on different executors. Every mutable
/// access is locked; only Sendable snapshots leave the lock. Never expose inout.
private final class LockedTestValue<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
    @discardableResult func update<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.withLock { body(&stored) }
    }
}
private extension LockedTestValue where Value == Data? {
    var jsonObject: [String: Any]? {
        guard let data = value else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
