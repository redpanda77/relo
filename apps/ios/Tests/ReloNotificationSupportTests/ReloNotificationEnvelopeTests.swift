import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif
@testable import ReloNotificationSupport
@testable import ReloCore
import XCTest

final class ReloNotificationEnvelopeTests: XCTestCase {
    func testStandardEnvelopeProjectsSenderThreadAndSafeMedia() throws {
        let envelope = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: ["relo": [
                "notificationId": "ntf_abcdefghijkl",
                "privacy": "standard",
                "sourceName": "  Codex  ",
                "serviceId": "svc_abcdefghijkl",
                "avatarUrl": "https://images.example.test/avatar.png",
                "imageUrl": "https://images.example.test/result.jpg",
            ]],
            requestIdentifier: "fallback"
        ))
        XCTAssertEqual(envelope.notificationID, "ntf_abcdefghijkl")
        XCTAssertEqual(envelope.sourceName, "Codex")
        XCTAssertEqual(envelope.conversationIdentifier, "svc_abcdefghijkl")
        XCTAssertEqual(envelope.avatarURL?.host, "images.example.test")
        XCTAssertEqual(envelope.imageURL?.pathExtension, "jpg")
        XCTAssertTrue(envelope.supportsCommunicationStyle)
    }

    func testPrivateEnvelopeCannotDonateSenderOrDownloadMedia() throws {
        let envelope = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: ["relo": [
                "notificationId": "ntf_private123456",
                "privacy": "private",
                "sourceName": "Secret Agent",
                "serviceId": "svc_private123456",
                "avatarUrl": "https://images.example.test/private.png",
                "imageUrl": "https://images.example.test/private.jpg",
            ]],
            requestIdentifier: "fallback"
        ))
        XCTAssertNil(envelope.sourceName)
        XCTAssertNil(envelope.conversationIdentifier)
        XCTAssertNil(envelope.avatarURL)
        XCTAssertNil(envelope.imageURL)
        XCTAssertFalse(envelope.supportsCommunicationStyle)
    }

    func testUnsafeIdentifiersAndMediaFailClosed() throws {
        let envelope = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: ["relo": [
                "sourceName": "Codex",
                "conversationId": "contains/a/path",
                "avatarUrl": "https://user:secret@images.example.test/avatar.png",
                "imageUrl": "http://images.example.test/result.png",
            ]],
            requestIdentifier: "request-safe"
        ))
        XCTAssertEqual(envelope.notificationID, "request-safe")
        XCTAssertEqual(envelope.conversationIdentifier, "source-codex")
        XCTAssertNil(envelope.avatarURL)
        XCTAssertNil(envelope.imageURL)
        XCTAssertTrue(envelope.supportsCommunicationStyle)
    }

    func testPublicImagePolicyRejectsLocalReservedAndRedirectTargets() throws {
        let blocked = [
            "https://localhost/image.png",
            "https://printer/image.png",
            "https://images.example.test./image.png",
            "https://worker.local/image.png",
            "https://worker.internal/image.png",
            "https://worker.home/image.png",
            "https://worker.lan/image.png",
            "https://127.0.0.1/image.png",
            "https://127.1/image.png",
            "https://2130706433/image.png",
            "https://0x7f000001/image.png",
            "https://017700000001/image.png",
            "https://0177.0.0.1/image.png",
            "https://10.0.0.1/image.png",
            "https://172.16.0.1/image.png",
            "https://192.168.1.10/image.png",
            "https://169.254.169.254/image.png",
            "https://100.64.0.1/image.png",
            "https://198.51.100.10/image.png",
            "https://[::1]/image.png",
            "https://[fc00::1]/image.png",
            "https://[fe80::1]/image.png",
            "https://[ff02::1]/image.png",
            "https://[2001:db8::1]/image.png",
            "https://[::ffff:127.0.0.1]/image.png",
            "https://[0:0:0:0:0:ffff:7f00:1]/image.png",
            "https://[0:0:0:0:0:0:7f00:1]/image.png",
        ]
        for value in blocked {
            XCTAssertNil(ReloPublicImageURLPolicy.validatedURL(value), "Unexpectedly accepted \(value)")
            let request = URLRequest(url: try XCTUnwrap(URL(string: value)))
            XCTAssertNil(ReloPublicImageURLPolicy.validatedRedirect(request))
        }
        let publicURL = try XCTUnwrap(ReloPublicImageURLPolicy.validatedURL("https://93.184.216.34/image.png"))
        XCTAssertNotNil(ReloPublicImageURLPolicy.validatedRedirect(URLRequest(url: publicURL)))
    }

    func testMediaPolicyRequiresSuccessfulBoundedImageResponse() throws {
        let url = try XCTUnwrap(URL(string: "https://images.example.test/avatar.png"))
        let success = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/2",
            headerFields: ["Content-Type": "image/png", "Content-Length": "128"]
        ))
        let failure = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 404,
            httpVersion: "HTTP/2",
            headerFields: ["Content-Type": "image/png"]
        ))
        XCTAssertTrue(ReloNotificationMediaPolicy.accepts(response: success, fileSize: 128, maximumBytes: 256))
        XCTAssertFalse(ReloNotificationMediaPolicy.accepts(response: success, fileSize: 512, maximumBytes: 256))
        XCTAssertFalse(ReloNotificationMediaPolicy.accepts(response: failure, fileSize: 128, maximumBytes: 256))
        XCTAssertEqual(ReloNotificationMediaPolicy.fileExtension(response: success, sourceURL: url), "png")
    }

    func testServicePolicyCoversPrivacyDonationFallbackSuccessTimeoutAndPreservation() throws {
        let standard = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: ["relo": ["sourceName": "Codex", "conversationId": "conversation-1"]],
            requestIdentifier: "ntf_standard12345"
        ))
        let privateEnvelope = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: ["relo": [
                "privacy": "private",
                "sourceName": "Secret",
                "conversationId": "secret-conversation",
            ]],
            requestIdentifier: "ntf_private123456"
        ))
        XCTAssertTrue(ReloNotificationServicePolicy.shouldAttemptDonation(for: standard))
        XCTAssertFalse(ReloNotificationServicePolicy.shouldAttemptDonation(for: privateEnvelope))

        let original = ReloNotificationPresentationMetadata(
            categoryIdentifier: "RELO_APPROVAL",
            threadIdentifier: "existing-thread",
            badgeNumber: 3
        )
        for outcome in [
            ReloNotificationServiceOutcome.donationFailed,
            .contentUpdateFailed,
            .timeout,
            .privateContent,
            .passthrough,
        ] {
            XCTAssertEqual(
                original.resolved(for: outcome, conversationIdentifier: "new-thread"),
                original
            )
            XCTAssertFalse(ReloNotificationServicePolicy.usesCommunicationUpdate(for: outcome))
        }
        XCTAssertEqual(
            original.resolved(for: .donationSucceeded, conversationIdentifier: "new-thread"),
            original,
            "A successful communication update must preserve an existing thread and category"
        )
        let unthreaded = ReloNotificationPresentationMetadata(
            categoryIdentifier: "RELO_YES_NO",
            threadIdentifier: "",
            badgeNumber: 3
        )
        XCTAssertEqual(
            unthreaded.resolved(for: .donationSucceeded, conversationIdentifier: "new-thread"),
            ReloNotificationPresentationMetadata(
                categoryIdentifier: "RELO_YES_NO",
                threadIdentifier: "new-thread",
                badgeNumber: 3
            )
        )
        XCTAssertTrue(ReloNotificationServicePolicy.usesCommunicationUpdate(for: .donationSucceeded))
    }

    func testReceiptStoreSerializesConcurrentIndependentInstances() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relo-nse-receipts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReloNotificationReceiptStore(baseDirectory: directory, maximumStored: 500)
        let second = ReloNotificationReceiptStore(baseDirectory: directory, maximumStored: 500)

        DispatchQueue.concurrentPerform(iterations: 250) { index in
            let identifier = String(format: "ntf_%012d", index)
            do { try (index.isMultiple(of: 2) ? first : second).add(notificationID: identifier) }
            catch { XCTFail("Receipt append failed: \(error)") }
        }

        let pending = try first.pending(limit: 500)
        XCTAssertEqual(pending.count, 250)
        XCTAssertEqual(Set(pending).count, 250)
        try second.remove(notificationIDs: Set(pending.prefix(50)))
        XCTAssertEqual(try first.pending(limit: 500).count, 200)
    }

    func testProductionOrchestratorPrivateBypassesMediaAndDonation() async {
        let capture = LockedCapture<TestNotificationContent>()
        var mediaCalls = 0
        var donationCalls = 0
        let orchestrator = makeTestOrchestrator(capture: capture)

        await orchestrator.run(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true,
                isPrivate: true,
                supportsCommunicationStyle: false,
                conversationIdentifier: nil
            ),
            enrichMedia: { _ in
                mediaCalls += 1
                return TestNotificationContent(body: "media")
            },
            donateAndUpdate: { _ in
                donationCalls += 1
                return .updated(TestNotificationContent(body: "updated"))
            }
        )
        orchestrator.timeout()

        XCTAssertEqual(mediaCalls, 0)
        XCTAssertEqual(donationCalls, 0)
        XCTAssertEqual(capture.values.count, 1)
        XCTAssertEqual(capture.values.first?.body, "original")
    }

    func testProductionOrchestratorDonationFailureAndContentUpdateFailureUseEnrichedFallback() async {
        for result in [DonationTestResult.donationFailed, .contentUpdateFailed] {
            let capture = LockedCapture<TestNotificationContent>()
            let orchestrator = makeTestOrchestrator(capture: capture)
            await orchestrator.run(
                context: ReloNotificationOrchestrationContext(
                    hasEnvelope: true,
                    isPrivate: false,
                    supportsCommunicationStyle: true,
                    conversationIdentifier: "conversation-1"
                ),
                enrichMedia: { _ in TestNotificationContent(body: "enriched") },
                donateAndUpdate: { _ in
                    switch result {
                    case .donationFailed: return .donationFailed
                    case .contentUpdateFailed: return .contentUpdateFailed
                    }
                }
            )

            XCTAssertEqual(capture.values.count, 1)
            XCTAssertEqual(capture.values.first?.body, "enriched")
            XCTAssertEqual(capture.values.first?.category, "RELO_APPROVAL")
            XCTAssertEqual(capture.values.first?.thread, "existing-thread")
            XCTAssertEqual(capture.values.first?.badge, 3)
        }
    }

    func testProductionOrchestratorTimeoutAndDonationCallbackRaceCallsHandlerOnce() async {
        let capture = LockedCapture<TestNotificationContent>()
        let latch = AsyncResultLatch<ReloNotificationDonationResult<TestNotificationContent>>()
        let donationReady = expectation(description: "donation callback is pending")
        let orchestrator = makeTestOrchestrator(capture: capture)
        let task = Task {
            await orchestrator.run(
                context: ReloNotificationOrchestrationContext(
                    hasEnvelope: true,
                    isPrivate: false,
                    supportsCommunicationStyle: true,
                    conversationIdentifier: "conversation-1"
                ),
                enrichMedia: { _ in TestNotificationContent(body: "enriched") },
                donateAndUpdate: { _ in
                    await latch.wait { donationReady.fulfill() }
                }
            )
        }
        await fulfillment(of: [donationReady], timeout: 1)

        DispatchQueue.concurrentPerform(iterations: 2) { index in
            if index == 0 {
                orchestrator.timeout()
            } else {
                latch.resume(.updated(TestNotificationContent(body: "updated")))
            }
        }
        await task.value
        for _ in 0..<10 { orchestrator.timeout() }

        XCTAssertEqual(capture.values.count, 1)
        XCTAssertTrue(["enriched", "updated"].contains(capture.values[0].body))
        XCTAssertEqual(capture.values[0].category, "RELO_APPROVAL")
        XCTAssertEqual(capture.values[0].badge, 3)
    }

#if canImport(UserNotifications)
    func testProductionOrchestratorDonationSuccessUsesRealContentAdapterAndPreservesMetadata() async {
        let original = UNMutableNotificationContent()
        original.body = "original"
        original.categoryIdentifier = "RELO_YES_NO"
        original.threadIdentifier = ""
        original.badge = 4
        let capture = LockedCapture<UNMutableNotificationContent>()
        let orchestrator = ReloNotificationServiceOrchestrator(
            originalContent: original,
            originalMetadata: ReloNotificationPresentationMetadata(
                categoryIdentifier: original.categoryIdentifier,
                threadIdentifier: original.threadIdentifier,
                badgeNumber: original.badge?.intValue
            ),
            contentHandler: capture.append,
            applyMetadata: ReloNotificationContentAdapter.applyingMetadata,
            copyContent: ReloNotificationContentAdapter.copying
        )

        await orchestrator.run(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true,
                isPrivate: false,
                supportsCommunicationStyle: true,
                conversationIdentifier: "conversation-1"
            ),
            enrichMedia: { ownedContent in
                ownedContent.body = "enriched"
                return ownedContent
            },
            donateAndUpdate: { enriched in
                let updated = enriched.mutableCopy() as! UNMutableNotificationContent
                updated.body = "communication"
                updated.categoryIdentifier = "INTENTS_REPLACED_CATEGORY"
                updated.threadIdentifier = "INTENTS_REPLACED_THREAD"
                updated.badge = 99
                return .updated(updated)
            }
        )
        orchestrator.timeout()

        XCTAssertEqual(capture.values.count, 1)
        XCTAssertEqual(capture.values[0].body, "communication")
        XCTAssertEqual(capture.values[0].categoryIdentifier, "RELO_YES_NO")
        XCTAssertEqual(capture.values[0].threadIdentifier, "conversation-1")
        XCTAssertEqual(capture.values[0].badge, 4)
    }

    func testMutableNotificationContentTimeoutRaceUsesIsolatedOwnedCopies() async {
        let original = UNMutableNotificationContent()
        original.body = "original"
        original.categoryIdentifier = "RELO_APPROVAL"
        let capture = LockedCapture<UNMutableNotificationContent>()
        let workingIdentities = LockedCapture<ObjectIdentifier>()
        let enrichmentStarted = expectation(description: "owned enrichment content is suspended")
        let timeoutCompleted = expectation(description: "timeout completed")
        let releaseEnrichment = AsyncResultLatch<Void>()
        let orchestrator = ReloNotificationServiceOrchestrator(
            originalContent: original,
            originalMetadata: ReloNotificationPresentationMetadata(
                categoryIdentifier: original.categoryIdentifier,
                threadIdentifier: original.threadIdentifier,
                badgeNumber: nil
            ),
            contentHandler: capture.append,
            applyMetadata: ReloNotificationContentAdapter.applyingMetadata,
            copyContent: ReloNotificationContentAdapter.copying
        )

        let task = Task {
            await orchestrator.run(
                context: ReloNotificationOrchestrationContext(
                    hasEnvelope: true,
                    isPrivate: false,
                    supportsCommunicationStyle: false,
                    conversationIdentifier: nil
                ),
                enrichMedia: { ownedContent in
                    workingIdentities.append(ObjectIdentifier(ownedContent))
                    ownedContent.body = "mutation-in-progress"
                    await releaseEnrichment.wait { enrichmentStarted.fulfill() }
                    ownedContent.body = "mutation-finished"
                    return ownedContent
                },
                donateAndUpdate: { _ in .donationFailed }
            )
        }
        await fulfillment(of: [enrichmentStarted], timeout: 1)

        DispatchQueue.global().async {
            orchestrator.timeout()
            timeoutCompleted.fulfill()
        }
        await fulfillment(of: [timeoutCompleted], timeout: 1)
        releaseEnrichment.resume(())
        await task.value

        XCTAssertEqual(capture.values.count, 1)
        XCTAssertEqual(capture.values[0].body, "original")
        XCTAssertEqual(original.body, "original")
        XCTAssertNotEqual(workingIdentities.values, [ObjectIdentifier(original)])
    }
#endif

    func testPresentationBudgetCompletesWhileMediaIsSuspendedAndStopsDonation() async {
        let capture = LockedCapture<TestNotificationContent>()
        let donationCalls = LockedCapture<Bool>()
        let latch = AsyncResultLatch<TestNotificationContent>()
        let mediaStarted = expectation(description: "media suspended")
        var timeout: (@Sendable () -> Void)?
        var budget: TimeInterval?
        let orchestrator = makeTestOrchestrator(capture: capture)
        let task = orchestrator.start(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true, isPrivate: false,
                supportsCommunicationStyle: true, conversationIdentifier: "conversation-1"
            ),
            enrichMedia: { _ in await latch.wait { mediaStarted.fulfill() } },
            donateAndUpdate: { content in donationCalls.append(true); return .updated(content) },
            scheduleTimeout: { seconds, callback in budget = seconds; timeout = callback }
        )
        await fulfillment(of: [mediaStarted], timeout: 1)
        XCTAssertEqual(budget, 0.100)
        XCTAssertLessThan(ReloNotificationPresentationBudget.enrichmentSeconds + ReloNotificationPresentationBudget.receiptLockSeconds,
                          ReloNotificationPresentationBudget.processingSeconds)
        XCTAssertTrue(capture.values.isEmpty)
        timeout?()
        XCTAssertEqual(capture.values.map(\.body), ["original"])
        XCTAssertEqual(capture.values.first?.category, "RELO_APPROVAL")
        XCTAssertTrue(task.isCancelled)
        latch.resume(TestNotificationContent(body: "late media"))
        await task.value
        timeout?()
        XCTAssertTrue(donationCalls.values.isEmpty)
        XCTAssertEqual(capture.values.count, 1)
    }

    func testPresentationBudgetCompletesWhileDonationIsSuspended() async {
        let capture = LockedCapture<TestNotificationContent>()
        let latch = AsyncResultLatch<ReloNotificationDonationResult<TestNotificationContent>>()
        let donationStarted = expectation(description: "donation suspended")
        var timeout: (@Sendable () -> Void)?
        let orchestrator = makeTestOrchestrator(capture: capture)
        let task = orchestrator.start(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true, isPrivate: false,
                supportsCommunicationStyle: true, conversationIdentifier: "conversation-1"
            ),
            enrichMedia: { _ in TestNotificationContent(body: "cached media") },
            donateAndUpdate: { _ in await latch.wait { donationStarted.fulfill() } },
            scheduleTimeout: { _, callback in timeout = callback }
        )
        await fulfillment(of: [donationStarted], timeout: 1)
        timeout?()
        XCTAssertEqual(capture.values.map(\.body), ["cached media"])
        XCTAssertTrue(task.isCancelled)
        latch.resume(.updated(TestNotificationContent(body: "late donation")))
        await task.value
        XCTAssertEqual(capture.values.count, 1)
    }

    func testReceiptCaptureYieldsWhenAnotherProcessHoldsTheLock() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = ReloNotificationReceiptStore(baseDirectory: directory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("pending-notification-receipts.json.lock").path
        let descriptor = Darwin.open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        defer { Darwin.close(descriptor) }
        XCTAssertEqual(flock(descriptor, LOCK_EX | LOCK_NB), 0)
        let recorded = try store.add(notificationID: "ntf_abcdefghijkl", lockWait: 0)
        XCTAssertEqual(recorded, .notRecordedWithinBudget)
        XCTAssertEqual(flock(descriptor, LOCK_UN), 0)
        XCTAssertEqual(try store.add(notificationID: "ntf_abcdefghijkl", lockWait: 0.020), .inserted)
        XCTAssertEqual(try store.pending(limit: 10), ["ntf_abcdefghijkl"])
    }

    func testHeldReceiptLockCannotDelayTextDeadlineOrDuplicateCompletion() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let descriptor = Darwin.open(directory.appendingPathComponent("pending-notification-receipts.json.lock").path,
                                     O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        defer { flock(descriptor, LOCK_UN); Darwin.close(descriptor) }
        XCTAssertEqual(flock(descriptor, LOCK_EX), 0)
        let capture = LockedCapture<TestNotificationContent>()
        let donation = AsyncResultLatch<ReloNotificationDonationResult<TestNotificationContent>>()
        let started = expectation(description: "donation held")
        var deadline: (@Sendable () -> Void)?
        let orchestrator = makeTestOrchestrator(capture: capture)
        let task = orchestrator.start(
            context: .init(hasEnvelope: true, isPrivate: false, supportsCommunicationStyle: true,
                           conversationIdentifier: "conversation"),
            enrichMedia: { $0 },
            donateAndUpdate: { _ in await donation.wait { started.fulfill() } },
            scheduleTimeout: { seconds, callback in
                XCTAssertEqual(seconds, 0.100)
                deadline = callback
            }
        )
        await fulfillment(of: [started], timeout: 1)
        let receiptFinished = expectation(description: "bounded receipt attempt")
        DispatchQueue.global(qos: .utility).async {
            do {
                let result = try ReloNotificationReceiptStore(baseDirectory: directory).add(
                    notificationID: "ntf_held", lockWait: 0.020)
                XCTAssertEqual(result, .notRecordedWithinBudget)
            } catch { XCTFail("Unexpected receipt failure: \(error)") }
            receiptFinished.fulfill()
        }
        deadline?() // Inject the optional enrichment deadline while the receipt flock is still held.
        XCTAssertEqual(capture.values.map(\.body), ["original"])
        donation.resume(.updated(TestNotificationContent(body: "late")))
        await task.value
        await fulfillment(of: [receiptFinished], timeout: 1)
        orchestrator.timeout()
        XCTAssertEqual(capture.values.count, 1)
    }

    // MARK: Choice questions

    private func choicePayload(privacy: String = "standard", options: Any? = nil) -> [AnyHashable: Any] {
        ["relo": [
            "notificationId": "ntf_choice123456",
            "privacy": privacy,
            "interactionType": "choice",
            "interactionId": "int_choice123456",
            "interactionOptions": options ?? [
                ["id": "ship", "label": "Ship"], ["id": "wait", "label": "Wait"],
                ["id": "rollback", "label": "Roll back"],
            ],
        ] as [String: Any]]
    }

    func testStandardChoiceEnvelopeBuildsOnePerQuestionCategoryWithOptionActions() throws {
        let envelope = try XCTUnwrap(ReloNotificationEnvelope(userInfo: choicePayload(), requestIdentifier: "fallback"))
        let category = try XCTUnwrap(envelope.choiceCategory)
        XCTAssertEqual(category.identifier, "RELO_CHOICE.int_choice123456")
        XCTAssertEqual(category.actions.map(\.identifier), ["RELO_OPTION.ship", "RELO_OPTION.wait", "RELO_OPTION.rollback"])
        XCTAssertEqual(category.actions.map(\.title), ["Ship", "Wait", "Roll back"])
    }

    func testPrivateOrMalformedChoiceRegistersNoCategory() throws {
        let hidden = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: choicePayload(privacy: "private"), requestIdentifier: "fallback"))
        XCTAssertNil(hidden.choiceCategory)
        for options: Any in [
            [["id": "ship", "label": "Ship"]],
            [["id": "Ship", "label": "Ship"], ["id": "wait", "label": "Wait"]],
            [["id": "ship", "label": "Ship"], ["id": "wait", "label": "ship"]],
            [["id": "ship", "label": "Ship"], ["id": "ship", "label": "Wait"]],
            [["id": "ship", "label": String(repeating: "x", count: 25)], ["id": "wait", "label": "Wait"]],
            [["id": "ship"], ["id": "wait", "label": "Wait"]],
            "not-a-list",
        ] {
            let envelope = try XCTUnwrap(ReloNotificationEnvelope(
                userInfo: choicePayload(options: options), requestIdentifier: "fallback"))
            XCTAssertNil(envelope.choiceCategory, "\(options)")
        }
        let approval = try XCTUnwrap(ReloNotificationEnvelope(
            userInfo: ["relo": ["notificationId": "ntf_choice123456", "interactionType": "approval",
                                "interactionId": "int_choice123456"]],
            requestIdentifier: "fallback"))
        XCTAssertNil(approval.choiceCategory)
    }

    func testChoiceCategoryRetentionKeepsTheNewestTwentyAndNeverTouchesStaticCategories() {
        let policy = ChoiceNotificationCategoryPolicy.self
        let registered = ["RELO_APPROVAL", "RELO_YES_NO", "RELO_CHOICE"]
            + (0..<25).map { "RELO_CHOICE.int_\($0)" } + ["RELO_CHOICE.int_unknown"]
        let order = (0..<25).map { "RELO_CHOICE.int_\($0)" }
        let retained = policy.retainedIdentifiers(registered: registered, recentOrder: order, adding: "RELO_CHOICE.int_new")
        XCTAssertEqual(retained.count, 20)
        XCTAssertEqual(retained.last, "RELO_CHOICE.int_new")
        XCTAssertEqual(retained.first, "RELO_CHOICE.int_6")
        XCTAssertFalse(retained.contains("RELO_CHOICE.int_unknown"), "unordered categories are the oldest")
        XCTAssertFalse(retained.contains("RELO_CHOICE"))
        XCTAssertFalse(retained.contains("RELO_APPROVAL"))

        // Re-registering a question moves it to the newest end without duplicating it.
        let again = policy.retainedIdentifiers(
            registered: ["RELO_CHOICE.int_a", "RELO_CHOICE.int_b"], recentOrder: ["RELO_CHOICE.int_a", "RELO_CHOICE.int_b"],
            adding: "RELO_CHOICE.int_a")
        XCTAssertEqual(again, ["RELO_CHOICE.int_b", "RELO_CHOICE.int_a"])

        XCTAssertTrue(policy.isPerQuestionCategory("RELO_CHOICE.int_a"))
        XCTAssertFalse(policy.isPerQuestionCategory("RELO_CHOICE"))
        XCTAssertFalse(policy.isPerQuestionCategory("RELO_CHOICE."))
        XCTAssertEqual(policy.optionID(fromActionIdentifier: "RELO_OPTION.roll-back"), "roll-back")
        XCTAssertNil(policy.optionID(fromActionIdentifier: "RELO_OPTION.Ship"))
        XCTAssertNil(policy.optionID(fromActionIdentifier: "RELO_APPROVE"))
        XCTAssertNil(policy.category(interactionID: "int bad", options: [.init(id: "a", label: "A"), .init(id: "b", label: "B")]))
    }

    func testRegisteredChoiceCategoryReplacesTheStaticOneBeforeDelivery() async {
        let capture = LockedCapture<TestNotificationContent>()
        let orchestrator = makeTestOrchestrator(capture: capture)
        var order: [String] = []
        await orchestrator.run(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true, isPrivate: false, supportsCommunicationStyle: false, conversationIdentifier: nil),
            prepareCategory: {
                order.append("category")
                return "RELO_CHOICE.int_choice123456"
            },
            enrichMedia: { content in
                order.append("media")
                return content
            },
            donateAndUpdate: { _ in .donationFailed }
        )
        XCTAssertEqual(order, ["category", "media"])
        XCTAssertEqual(capture.values.count, 1)
        XCTAssertEqual(capture.values.first?.category, "RELO_CHOICE.int_choice123456")
        XCTAssertEqual(capture.values.first?.thread, "existing-thread")
    }

    func testUnregisteredOrLateChoiceCategoryKeepsTheServerCategory() async {
        let failed = LockedCapture<TestNotificationContent>()
        await makeTestOrchestrator(capture: failed).run(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true, isPrivate: false, supportsCommunicationStyle: false, conversationIdentifier: nil),
            prepareCategory: { nil },
            enrichMedia: { $0 },
            donateAndUpdate: { _ in .donationFailed }
        )
        XCTAssertEqual(failed.values.map(\.category), ["RELO_APPROVAL"])

        // The deadline wins while registration is still pending: the content never names it.
        let late = LockedCapture<TestNotificationContent>()
        let orchestrator = makeTestOrchestrator(capture: late)
        await orchestrator.run(
            context: ReloNotificationOrchestrationContext(
                hasEnvelope: true, isPrivate: false, supportsCommunicationStyle: false, conversationIdentifier: nil),
            prepareCategory: {
                orchestrator.timeout()
                return "RELO_CHOICE.int_choice123456"
            },
            enrichMedia: { $0 },
            donateAndUpdate: { _ in .donationFailed }
        )
        XCTAssertEqual(late.values.map(\.category), ["RELO_APPROVAL"])
    }

    private func makeTestOrchestrator(
        capture: LockedCapture<TestNotificationContent>
    ) -> ReloNotificationServiceOrchestrator<TestNotificationContent> {
        ReloNotificationServiceOrchestrator(
            originalContent: TestNotificationContent(body: "original"),
            originalMetadata: ReloNotificationPresentationMetadata(
                categoryIdentifier: "RELO_APPROVAL",
                threadIdentifier: "existing-thread",
                badgeNumber: 3
            ),
            contentHandler: capture.append,
            applyMetadata: { content, metadata in
                var delivered = content
                delivered.category = metadata.categoryIdentifier
                delivered.thread = metadata.threadIdentifier
                delivered.badge = metadata.badgeNumber
                return delivered
            },
            copyContent: { $0 }
        )
    }
}

private struct TestNotificationContent: Equatable {
    var body: String
    var category: String?
    var thread: String?
    var badge: Int?
}

private enum DonationTestResult {
    case donationFailed
    case contentUpdateFailed
}

private final class LockedCapture<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Value] = []

    var values: [Value] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ value: Value) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }
}

private final class AsyncResultLatch<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?

    func wait(onReady: () -> Void) async -> Value {
        await withCheckedContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            onReady()
        }
    }

    func resume(_ value: sending Value) {
        lock.lock()
        let continuation = continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }
}
