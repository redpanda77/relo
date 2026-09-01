import XCTest
@testable import ReloActivityResponse
@testable import ReloCore

final class DurableActionCoordinatorTests: XCTestCase {
    func testLiveActivityResponseBuildsCapabilityRequestForServer() throws {
        let response = PendingNotificationResponse.liveActivity(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: "ntf_test123456",
            activityID: "act_test123456",
            activityGeneration: 1,
            interactionID: "int_test123456",
            action: .yes,
            credential: String(repeating: "a", count: 43),
            expiresAt: .now.addingTimeInterval(60)
        )

        let request = try LiveActivityResponseRequestFactory.make(
            response: response,
            apiOrigin: try XCTUnwrap(URL(string: "https://server.example.test"))
        )
        let body = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String]
        )

        XCTAssertEqual(request.url?.absoluteString, "https://server.example.test/api/live-activity-responses/int_test123456")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/json")
        XCTAssertEqual(body["notificationId"], "ntf_test123456")
        XCTAssertEqual(body["deviceId"], "dev_test123456")
        XCTAssertEqual(body["action"], "yes")
        XCTAssertEqual(body["credential"], String(repeating: "a", count: 43))
        XCTAssertEqual(body["idempotencyKey"], "live-activity:act_test123456:1:int_test123456:yes")
    }

    func testLiveActivityResponseRequestRejectsOrdinaryAndTextResponses() throws {
        let ordinary = PendingNotificationResponse(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: "ntf_test123456",
            action: .approve,
            value: [:],
            idempotencyKey: "ordinary-key",
            expiresAt: .now.addingTimeInterval(60)
        )
        let textActivity = PendingNotificationResponse.liveActivity(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: "ntf_test123456",
            activityID: "act_test123456",
            activityGeneration: 1,
            interactionID: "int_test123456",
            action: .answer,
            credential: String(repeating: "a", count: 43),
            expiresAt: .now.addingTimeInterval(60)
        )
        let origin = try XCTUnwrap(URL(string: "https://server.example.test"))

        XCTAssertThrowsError(try LiveActivityResponseRequestFactory.make(response: ordinary, apiOrigin: origin))
        XCTAssertThrowsError(try LiveActivityResponseRequestFactory.make(response: textActivity, apiOrigin: origin))
    }

    func testCommandsArePlannedInAscendingSequenceRegardlessOfInboxOrder() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let items = [
            item(eventID: "evt_end12345678", operation: .end, sequence: 2),
            item(eventID: "evt_update123456", operation: .update, sequence: 1),
            item(eventID: "evt_start1234567", operation: .start, sequence: 0),
        ]

        let pending = try await coordinator.pending(items: items, targetDeviceID: "dev_test123456")

        XCTAssertEqual(pending.map(\.command.operation), [.start, .update, .end])
        XCTAssertEqual(pending.map { $0.command.sequence }, [0, 1, 2])
    }

    func testReinstallationRecoveryPrioritizesNewestStateForServerActiveIdentity() throws {
        let start = item(eventID: "evt_start1234567", operation: .start, sequence: 0)
        let update = item(eventID: "evt_update123456", operation: .update, sequence: 3)
        let envelopes = try [start, update].map {
            LiveActivityCommandEnvelope(
                eventID: $0.id,
                createdAt: $0.createdAt,
                command: try XCTUnwrap($0.liveActivity)
            )
        }
        let identity = try XCTUnwrap(update.liveActivity?.identity)

        let plan = LiveActivityReinstallationRecoveryPolicy.plan(
            pending: [envelopes[0]],
            authoritativeCommands: [envelopes[1]],
            authoritativeActiveIdentities: [identity],
            locallyActiveIdentities: [],
            now: Date(timeIntervalSince1970: 100)
        )

        XCTAssertEqual(plan.commands.map { $0.command.sequence }, [3, 0])
        XCTAssertEqual(plan.recoveryCommandKeys, [plan.commands[0].commandKey])
    }

    func testReinstallationRecoveryDoesNotOverrideExistingOrTerminalActivity() throws {
        let update = item(eventID: "evt_update123456", operation: .update, sequence: 3)
        let end = item(eventID: "evt_end12345678", operation: .end, sequence: 4)
        let pending = try [update, end].map {
            LiveActivityCommandEnvelope(
                eventID: $0.id,
                createdAt: $0.createdAt,
                command: try XCTUnwrap($0.liveActivity)
            )
        }
        let identity = try XCTUnwrap(update.liveActivity?.identity)

        let localPlan = LiveActivityReinstallationRecoveryPolicy.plan(
            pending: pending,
            authoritativeActiveIdentities: [identity],
            locallyActiveIdentities: [identity],
            now: Date(timeIntervalSince1970: 100)
        )
        let terminalPlan = LiveActivityReinstallationRecoveryPolicy.plan(
            pending: [pending[1]],
            authoritativeActiveIdentities: [identity],
            locallyActiveIdentities: [],
            now: Date(timeIntervalSince1970: 100)
        )

        XCTAssertEqual(localPlan.commands, pending)
        XCTAssertTrue(localPlan.recoveryCommandKeys.isEmpty)
        XCTAssertEqual(terminalPlan.commands, [pending[1]])
        XCTAssertTrue(terminalPlan.recoveryCommandKeys.isEmpty)
    }

    func testGenerationPartitionsOrderingTerminalReplayReceiptsAndObservations() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let oldEnd = item(
            eventID: "evt_generation1end",
            operation: .end,
            sequence: 9,
            generation: 1
        )
        let resumedStart = item(
            eventID: "evt_generation2start",
            operation: .start,
            sequence: 0,
            generation: 2
        )
        let resumedUpdate = item(
            eventID: "evt_generation2update",
            operation: .update,
            sequence: 1,
            generation: 2
        )

        let initiallyPending = try await coordinator.pending(
            items: [resumedUpdate, oldEnd, resumedStart],
            targetDeviceID: "dev_test123456"
        )
        XCTAssertEqual(initiallyPending.map(\.command.generation), [1, 2, 2])
        XCTAssertEqual(initiallyPending.map { $0.command.sequence }, [9, 0, 1])

        let terminal = try XCTUnwrap(initiallyPending.first)
        try await coordinator.acknowledge(terminal)
        let afterOldTerminal = try await coordinator.pending(
            items: [oldEnd, resumedUpdate, resumedStart],
            targetDeviceID: "dev_test123456"
        )
        XCTAssertEqual(afterOldTerminal.map(\.command.generation), [2, 2])

        let generationTwoObservation = LiveActivitySystemObservation(
            snapshot: snapshot(sequence: 1, digest: "generation-2", generation: 2),
            contentUpdatedAt: Date(timeIntervalSince1970: 20),
            observedAt: Date(timeIntervalSince1970: 21)
        )
        try await coordinator.recordSystemObservation(generationTwoObservation)
        let oldObservation = try await coordinator.systemObservation(
            identity: LiveActivityIdentity(activityID: "act_test123456", generation: 1)
        )
        let currentObservation = try await coordinator.systemObservation(
            identity: LiveActivityIdentity(activityID: "act_test123456", generation: 2)
        )
        XCTAssertNil(oldObservation)
        XCTAssertEqual(currentObservation, generationTwoObservation)

        let startEnvelope = try XCTUnwrap(afterOldTerminal.first)
        try await coordinator.prepareApplication(
            for: startEnvelope,
            expected: snapshot(sequence: 0, digest: "generation-2-start", generation: 2),
            priorActive: nil
        )
        try await coordinator.markApplicationInvocationStarted(for: startEnvelope)
        try await coordinator.recordApplicationSuccess(for: startEnvelope)
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 10)
        XCTAssertEqual(receipts, [resumedStart.id])
        XCTAssertNotEqual(terminal.commandKey, startEnvelope.commandKey)
    }

    func testSuccessfulLiveActivityApplicationDurablyQueuesReceivedEvent() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_received12345", operation: .start, sequence: 0)
        let candidates = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")
        let envelope = try XCTUnwrap(candidates.first)

        try await coordinator.prepareApplication(
            for: envelope,
            expected: snapshot(sequence: 0, digest: "start-applied"),
            priorActive: nil
        )
        try await coordinator.markApplicationInvocationStarted(for: envelope)
        try await coordinator.recordApplicationSuccess(for: envelope)
        try await coordinator.acknowledge(envelope)
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        let remaining = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")

        XCTAssertEqual(receipts, [event.id])
        XCTAssertTrue(remaining.isEmpty)
    }

    func testFailedLiveActivityApplicationLeavesCommandRetryableWithoutReceipt() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_failed1234567", operation: .update, sequence: 1)
        let firstAttempt = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        let retryAttempt = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")

        XCTAssertEqual(firstAttempt.count, 1)
        XCTAssertTrue(receipts.isEmpty)
        XCTAssertEqual(retryAttempt.count, 1)
    }

    func testDuplicateAndRelaunchKeepOneDurableReceivedReceipt() async throws {
        let store = InMemoryProtectedActionStore()
        let firstCoordinator = LiveActivityCommandCoordinator(store: store)
        try await firstCoordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_relaunch12345", operation: .start, sequence: 0)
        let candidates = try await firstCoordinator.pending(items: [event], targetDeviceID: "dev_test123456")
        let envelope = try XCTUnwrap(candidates.first)
        try await firstCoordinator.prepareApplication(
            for: envelope,
            expected: snapshot(sequence: 0, digest: "start-applied"),
            priorActive: nil
        )
        try await firstCoordinator.markApplicationInvocationStarted(for: envelope)
        try await firstCoordinator.recordApplicationSuccess(for: envelope)
        try await firstCoordinator.recordApplicationSuccess(for: envelope)
        try await firstCoordinator.acknowledge(envelope)

        let relaunchedCoordinator = LiveActivityCommandCoordinator(store: store)
        try await relaunchedCoordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let receipts = try await relaunchedCoordinator.pendingReceivedEventIDs(limit: 25)
        let remaining = try await relaunchedCoordinator.pending(
            items: [event],
            targetDeviceID: "dev_test123456"
        )

        XCTAssertEqual(receipts, [event.id])
        XCTAssertTrue(remaining.isEmpty)
    }

    func testRetiredLedgerFieldsAreNeverPromotedIntoCurrentState() throws {
        let data = Data(#"{"appliedCommandKeys":["evt_old|act_old123456|2|end"],"scheduledAlertCommandKeys":[],"terminalSequenceByActivityID":{"act_old123456":2},"pendingDismissedActivityIDs":["act_old123456"],"systemObservationsByActivityID":{"act_old123456":{"snapshot":{"activityID":"act_old123456","sequence":2,"contentDigest":"old","isTerminal":true},"contentUpdatedAt":0,"observedAt":1}}}"#.utf8)

        let ledger = try JSONDecoder().decode(LiveActivityCommandLedger.self, from: data)

        XCTAssertEqual(ledger.appliedCommandKeys, ["evt_old|act_old123456|2|end"])
        XCTAssertTrue(ledger.terminalSequenceByActivityIdentity.isEmpty)
        XCTAssertTrue(ledger.pendingDismissedActivityIdentities.isEmpty)
        XCTAssertTrue(ledger.systemObservationsByActivityIdentity.isEmpty)
        XCTAssertTrue(ledger.pendingReceivedEventIDs.isEmpty)
        XCTAssertTrue(ledger.applicationJournals.isEmpty)
    }

    func testStartJournalConvergesAcrossEveryDeterministicKillBoundary() async throws {
        try await assertJournalKillBoundaries(operation: .start)
    }

    func testUpdateJournalConvergesAcrossEveryDeterministicKillBoundary() async throws {
        try await assertJournalKillBoundaries(operation: .update)
    }

    func testEndJournalConvergesAcrossEveryDeterministicKillBoundary() async throws {
        try await assertJournalKillBoundaries(operation: .end)
    }

    func testPreparedEndThatDisappearsBeforeInvocationCreatesNoFalseReceipt() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let envelope = LiveActivityCommandEnvelope(
            eventID: "evt_endnotattempted",
            createdAt: .now,
            command: try XCTUnwrap(item(
                eventID: "evt_endnotattempted",
                operation: .end,
                sequence: 2
            ).liveActivity)
        )
        try await coordinator.prepareApplication(
            for: envelope,
            expected: snapshot(sequence: 2, digest: "terminal", terminal: true),
            priorActive: snapshot(sequence: 1, digest: "prior")
        )

        let loadedJournal = try await coordinator.applicationJournal(for: envelope)
        let journal = try XCTUnwrap(loadedJournal)
        XCTAssertEqual(
            LiveActivityApplicationJournalPolicy.reconcile(journal, observed: nil),
            .indeterminate
        )
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertTrue(receipts.isEmpty)
    }

    func testSuccessfulEndThatBecomesAbsentBeforeReceiptRemainsIndeterminate() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relo-ambiguous-end-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let context = try await journalTestContext(
            operation: .end,
            suffix: "absent-after-call",
            directory: directory
        )
        let prior = snapshot(sequence: 1, digest: "end-prior")
        let expected = snapshot(sequence: 2, digest: "end-desired", terminal: true)
        let system = SimulatedLiveActivitySystem(snapshot: prior)

        let first = await LiveActivityApplicationOrchestrator.apply(
            coordinator: context.coordinator,
            envelope: context.envelope,
            expected: expected,
            priorActive: prior,
            observed: prior
        ) {
            try await system.removeThenTerminate()
        }
        XCTAssertEqual(first, .failed)

        let relaunched = try await relaunchedCoordinator(store: context.store)
        let reconciled = await LiveActivityApplicationOrchestrator.apply(
            coordinator: relaunched,
            envelope: context.envelope,
            expected: expected,
            priorActive: prior,
            observed: await system.currentSnapshot()
        ) {
            XCTFail("An absent end cannot be retried or confirmed without an ActivityKit identity")
        }
        let receipts = try await relaunched.pendingReceivedEventIDs(limit: 25)
        let pending = try await relaunched.pending(items: [context.event], targetDeviceID: "dev_test123456")
        let journal = try await relaunched.applicationJournal(for: context.envelope)

        XCTAssertEqual(reconciled, .failed)
        XCTAssertTrue(receipts.isEmpty)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(journal?.phase, .invocationStarted)
    }

    func testJournalMismatchReappliesButNewerStateAndUnjournaledAlreadyCurrentDoNotMintReceipt() async throws {
        let expected = snapshot(sequence: 2, digest: "expected")
        let journal = LiveActivityApplicationJournalEntry(
            eventID: "evt_mismatch1234",
            commandKey: "evt_mismatch1234|act_test123456|2|update",
            operation: .update,
            expected: expected,
            priorActive: nil
        )

        XCTAssertEqual(
            LiveActivityApplicationJournalPolicy.reconcile(
                journal,
                observed: snapshot(sequence: 2, digest: "different")
            ),
            .apply
        )
        XCTAssertEqual(
            LiveActivityApplicationJournalPolicy.reconcile(
                journal,
                observed: snapshot(sequence: 3, digest: "newer")
            ),
            .finishWithoutReceipt
        )

        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_nojournal1234", operation: .update, sequence: 2)
        let envelope = LiveActivityCommandEnvelope(
            eventID: event.id,
            createdAt: event.createdAt,
            command: try XCTUnwrap(event.liveActivity)
        )
        do {
            try await coordinator.recordApplicationSuccess(for: envelope)
            XCTFail("An already-current command without a journal must not mint a receipt")
        } catch LiveActivityCommandCoordinatorError.missingApplicationJournal {
            // Expected.
        }
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertTrue(receipts.isEmpty)
    }

    func testProductionOrchestratorSuppressesStaleUpdateWithoutMutationOrReceipt() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_staleorchestrator", operation: .update, sequence: 2)
        let envelope = LiveActivityCommandEnvelope(
            eventID: event.id,
            createdAt: event.createdAt,
            command: try XCTUnwrap(event.liveActivity)
        )
        let expected = snapshot(sequence: 2, digest: "expected")
        try await coordinator.prepareApplication(for: envelope, expected: expected, priorActive: nil)
        let system = SimulatedLiveActivitySystem(snapshot: snapshot(sequence: 3, digest: "newer"))

        let outcome = await LiveActivityApplicationOrchestrator.apply(
            coordinator: coordinator,
            envelope: envelope,
            expected: expected,
            priorActive: nil,
            observed: await system.currentSnapshot()
        ) {
            await system.apply(expected)
        }
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        let journal = try await coordinator.applicationJournal(for: envelope)
        let invocationCount = await system.invocationCount()

        XCTAssertEqual(outcome, .ignored)
        XCTAssertTrue(receipts.isEmpty)
        XCTAssertNil(journal)
        XCTAssertEqual(invocationCount, 0)
    }

    func testProductionOrchestratorKeepsMismatchedTerminalEndUnconfirmed() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_terminalmismatch", operation: .end, sequence: 2)
        let envelope = LiveActivityCommandEnvelope(
            eventID: event.id,
            createdAt: event.createdAt,
            command: try XCTUnwrap(event.liveActivity)
        )
        let expected = snapshot(sequence: 2, digest: "expected-terminal", terminal: true)
        let prior = snapshot(sequence: 1, digest: "prior")
        try await coordinator.prepareApplication(for: envelope, expected: expected, priorActive: prior)

        let outcome = await LiveActivityApplicationOrchestrator.apply(
            coordinator: coordinator,
            envelope: envelope,
            expected: expected,
            priorActive: prior,
            observed: snapshot(sequence: 2, digest: "other-terminal", terminal: true),
            mutation: { XCTFail("A mismatched terminal end is indeterminate") }
        )
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        let journal = try await coordinator.applicationJournal(for: envelope)

        XCTAssertEqual(outcome, .failed)
        XCTAssertTrue(receipts.isEmpty)
        XCTAssertNotNil(journal)
    }

    func testReceiptRecordedJournalReusesServerIdentityWithoutCreatingANewLocalRow() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_receiptreuse1", operation: .start, sequence: 0)
        let envelope = LiveActivityCommandEnvelope(
            eventID: event.id,
            createdAt: event.createdAt,
            command: try XCTUnwrap(event.liveActivity)
        )
        try await coordinator.prepareApplication(
            for: envelope,
            expected: snapshot(sequence: 0, digest: "applied"),
            priorActive: nil
        )
        try await coordinator.markApplicationInvocationStarted(for: envelope)
        try await coordinator.recordApplicationSuccess(for: envelope)
        try await coordinator.removeReceivedEventIDs([event.id])

        try await coordinator.recordApplicationSuccess(for: envelope)

        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertTrue(receipts.isEmpty)
    }

    func testOfflineReceivedReceiptSurvivesUntilReconnectSubmissionCompletes() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(eventID: "evt_offline123456", operation: .start, sequence: 0)
        let candidates = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")
        let envelope = try XCTUnwrap(candidates.first)
        let outcome = await LiveActivityApplicationOrchestrator.apply(
            coordinator: coordinator,
            envelope: envelope,
            expected: snapshot(sequence: 0, digest: "start-applied"),
            priorActive: nil,
            observed: nil,
            mutation: {}
        )
        XCTAssertEqual(outcome, .applied)
        try await coordinator.acknowledge(envelope)
        let offline = try await coordinator.pendingReceivedEventIDs(limit: 25)
        let retry = try await coordinator.pendingReceivedEventIDs(limit: 25)

        XCTAssertEqual(offline, [event.id])
        XCTAssertEqual(retry, [event.id])

        try await coordinator.removeReceivedEventIDs([event.id])
        let completed = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertTrue(completed.isEmpty)
    }

    func testReceivedReceiptsRemainIsolatedAcrossAccountAndDeviceSwitches() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relo-live-receipts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AccountScopedProtectedActionStore(baseDirectory: directory)
        let coordinator = LiveActivityCommandCoordinator(store: store)
        let event = item(eventID: "evt_scoped1234567", operation: .start, sequence: 0)
        let envelope = LiveActivityCommandEnvelope(
            eventID: event.id,
            createdAt: event.createdAt,
            command: try XCTUnwrap(event.liveActivity)
        )

        try await coordinator.select(accountID: "acc_first123456", deviceID: "dev_first123456")
        let outcome = await LiveActivityApplicationOrchestrator.apply(
            coordinator: coordinator,
            envelope: envelope,
            expected: snapshot(sequence: 0, digest: "start-applied"),
            priorActive: nil,
            observed: nil,
            mutation: {}
        )
        XCTAssertEqual(outcome, .applied)
        try await coordinator.acknowledge(envelope)
        try await coordinator.select(accountID: "acc_first123456", deviceID: "dev_second12345")
        let otherDevice = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertTrue(otherDevice.isEmpty)
        try await coordinator.select(accountID: "acc_second12345", deviceID: "dev_first123456")
        let otherAccount = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertTrue(otherAccount.isEmpty)
        try await coordinator.select(accountID: "acc_first123456", deviceID: "dev_first123456")
        let originalScope = try await coordinator.pendingReceivedEventIDs(limit: 25)
        XCTAssertEqual(originalScope, [event.id])
    }

    func testTerminalReplayDoesNotCreateFalseReceivedReceipt() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let end = item(eventID: "evt_terminal12345", operation: .end, sequence: 2)
        let candidates = try await coordinator.pending(items: [end], targetDeviceID: "dev_test123456")
        let terminal = try XCTUnwrap(candidates.first)
        try await coordinator.prepareApplication(
            for: terminal,
            expected: snapshot(sequence: 2, digest: "end-applied", terminal: true),
            priorActive: snapshot(sequence: 1, digest: "active-before-end")
        )
        try await coordinator.markApplicationInvocationStarted(for: terminal)
        try await coordinator.recordApplicationSuccess(for: terminal)
        try await coordinator.acknowledge(terminal)
        try await coordinator.removeReceivedEventIDs([end.id])
        let stale = item(eventID: "evt_stalereplay12", operation: .start, sequence: 0)
        let replay = try await coordinator.pending(items: [stale], targetDeviceID: "dev_test123456")
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)

        XCTAssertTrue(replay.isEmpty)
        XCTAssertTrue(receipts.isEmpty)
    }

    func testUnacknowledgedCommandRetriesAndTerminalTombstoneSuppressesReplay() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let start = item(eventID: "evt_start1234567", operation: .start, sequence: 0)
        let end = item(eventID: "evt_end12345678", operation: .end, sequence: 2)

        let firstAttempt = try await coordinator.pending(items: [start], targetDeviceID: "dev_test123456")
        let retryAttempt = try await coordinator.pending(items: [start], targetDeviceID: "dev_test123456")
        XCTAssertEqual(firstAttempt.count, 1)
        XCTAssertEqual(retryAttempt.count, 1)
        let first = try XCTUnwrap(retryAttempt.first)
        try await coordinator.acknowledge(first)
        let afterAck = try await coordinator.pending(items: [start], targetDeviceID: "dev_test123456")
        XCTAssertTrue(afterAck.isEmpty)

        let sameEventUpdated = item(eventID: start.id, operation: .update, sequence: 1)
        let authoritativeUpdate = try await coordinator.pending(
            items: [sameEventUpdated],
            targetDeviceID: "dev_test123456"
        )
        XCTAssertEqual(authoritativeUpdate.map(\.command.operation), [.update])
        try await coordinator.acknowledge(try XCTUnwrap(authoritativeUpdate.first))

        let terminalCandidates = try await coordinator.pending(items: [end], targetDeviceID: "dev_test123456")
        let terminal = try XCTUnwrap(terminalCandidates.first)
        try await coordinator.acknowledge(terminal)
        let stale = item(eventID: "evt_stale1234567", operation: .start, sequence: 0)
        let afterTerminal = try await coordinator.pending(items: [stale], targetDeviceID: "dev_test123456")
        XCTAssertTrue(afterTerminal.isEmpty)
    }

    func testResponseQueueKeepsFirstDecisionAndPrunesExpiredResponses() async throws {
        let store = InMemoryProtectedActionStore()
        await store.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let first = response(action: .approve, idempotencyKey: "first-key")
        let opposite = response(action: .deny, idempotencyKey: "opposite-key")

        let firstResult = await store.enqueue(first)
        let oppositeResult = await store.enqueue(opposite)
        let initiallyPending = await store.pending(now: .now)
        XCTAssertEqual(firstResult, .enqueued)
        XCTAssertEqual(oppositeResult, .alreadyPending(first))
        XCTAssertEqual(initiallyPending, [first])

        let expired = response(action: .yes, idempotencyKey: "expired-key", expiresAt: .distantPast, notificationID: "ntf_other123456")
        let expiredResult = await store.enqueue(expired)
        let afterPrune = await store.pending(now: .now)
        XCTAssertEqual(expiredResult, .enqueued)
        XCTAssertEqual(afterPrune, [first])
    }

    func testInvalidQueuedResponseIsRemovedBeforeNextFlushCycle() async throws {
        let store = InMemoryProtectedActionStore()
        await store.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let queued = response(action: .answer, idempotencyKey: "invalid-response-key")
        let enqueueResult = await store.enqueue(queued)
        XCTAssertEqual(enqueueResult, .enqueued)

        var submissionAttempts = 0
        for _ in 0..<2 {
            for pending in await store.pending(now: .now) {
                submissionAttempts += 1
                let resolution = await PendingResponseQueueFailureHandler.handle(
                    .invalidRequest,
                    response: pending,
                    store: store
                )
                XCTAssertEqual(resolution, .discardedInvalidResponse)
            }
        }

        let remaining = await store.pending(now: .now)
        XCTAssertEqual(submissionAttempts, 1)
        XCTAssertTrue(remaining.isEmpty)
    }

    func testRequiredAppAlertMustBeDurablyScheduledBeforeCommandAck() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        await store.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let item = item(
            eventID: "evt_alert1234567",
            operation: .start,
            sequence: 0,
            alertOwner: .app
        )
        let candidates = try await coordinator.pending(items: [item], targetDeviceID: "dev_test123456")
        let envelope = try XCTUnwrap(candidates.first)

        do {
            try await coordinator.acknowledge(envelope)
            XCTFail("The command must not ack before its sole alert is scheduled")
        } catch LiveActivityCommandCoordinatorError.requiredAlertNotScheduled {
            // Expected.
        }
        try await coordinator.acknowledgeAlertScheduled(for: envelope)
        try await coordinator.acknowledge(envelope)
        let remaining = try await coordinator.pending(items: [item], targetDeviceID: "dev_test123456")
        XCTAssertTrue(remaining.isEmpty)
    }

    func testAppliedReceiptSurvivesCompanionAlertFailureBeforeCommandAck() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        await store.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(
            eventID: "evt_alertreceipt1",
            operation: .start,
            sequence: 0,
            alertOwner: .app
        )
        let candidates = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")
        let envelope = try XCTUnwrap(candidates.first)

        try await coordinator.prepareApplication(
            for: envelope,
            expected: snapshot(sequence: 0, digest: "start-applied"),
            priorActive: nil
        )
        try await coordinator.markApplicationInvocationStarted(for: envelope)
        try await coordinator.recordApplicationSuccess(for: envelope)
        do {
            try await coordinator.acknowledge(envelope)
            XCTFail("The command must remain retryable until the required alert is scheduled")
        } catch LiveActivityCommandCoordinatorError.requiredAlertNotScheduled {
            // Expected.
        }

        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 25)
        let retry = try await coordinator.pending(items: [event], targetDeviceID: "dev_test123456")
        XCTAssertEqual(receipts, [event.id])
        XCTAssertEqual(retry.count, 1)
    }

    func testCrossProcessQueueSerializesOppositeLiveActivityChoices() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let approve = PendingNotificationResponse.liveActivity(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: "ntf_test123456",
            activityID: "act_test123456",
            activityGeneration: 1,
            interactionID: "int_test123456",
            action: .approve,
            credential: "credential-value",
            expiresAt: .now.addingTimeInterval(600)
        )
        let deny = PendingNotificationResponse.liveActivity(
            accountID: approve.accountID,
            deviceID: approve.deviceID,
            notificationID: approve.notificationID,
            activityID: "act_test123456",
            activityGeneration: 1,
            interactionID: "int_test123456",
            action: .deny,
            credential: "credential-value",
            expiresAt: approve.expiresAt
        )

        await withTaskGroup(of: Void.self) { group in
            for response in [approve, deny] {
                group.addTask { _ = try? file.enqueue(response) }
            }
        }

        let pending = try file.pending(
            accountID: approve.accountID,
            deviceID: approve.deviceID,
            now: .now
        )
        XCTAssertEqual(pending.count, 1)
        XCTAssertTrue([approve.action, deny.action].contains(try XCTUnwrap(pending.first?.action)))
        XCTAssertEqual(CrossProcessResponseFile.dataProtectionClass, "completeUntilFirstUserAuthentication")
    }

    func testCanonicalLiveActivityResponseResultIsStrictAndDefinesTerminalDismissal() throws {
        let presentedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let valid = try LiveActivityResponseServerResult.decode(
            Data(#"{"state":"yes"}"#.utf8),
            expectedAction: .yes
        )

        XCTAssertEqual(valid.state, "yes")
        XCTAssertThrowsError(try LiveActivityResponseServerResult.decode(
            Data(#"{"state":"no"}"#.utf8),
            expectedAction: .yes
        ))
        XCTAssertThrowsError(try LiveActivityResponseServerResult.decode(
            Data(#"{"accepted":true}"#.utf8),
            expectedAction: .yes
        ))
        XCTAssertEqual(
            LiveActivityResponsePolicy.terminalDismissalDate(presentedAt: presentedAt),
            presentedAt.addingTimeInterval(5)
        )
        XCTAssertEqual(LiveActivityResponsePolicy.status(phase: .sending, action: .yes), "Sending yes…")
        XCTAssertEqual(LiveActivityResponsePolicy.status(phase: .queued, action: .no), "no queued")
        XCTAssertEqual(
            LiveActivityResponsePolicy.status(phase: .accepted, action: .approve, confirmedState: "approved"),
            "Approved"
        )
        XCTAssertEqual(LiveActivityResponsePolicy.status(phase: .rejected, action: .deny), "Response not recorded")
    }

    func testProductionResponseOrchestratorPresentsAcceptedForFiveSecondsAfterUninterruptedConfirmation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = CrossProcessResponseFile(baseDirectory: directory)
        let response = liveActivityResponse(action: .yes)
        let startedAt = Date()
        var times = [startedAt, startedAt.addingTimeInterval(1), startedAt.addingTimeInterval(2)]
        var presentations: [LiveActivityResponsePresentationCommand] = []

        let outcome = await LiveActivityResponseIntentOrchestrator.perform(
            requested: response,
            queue: queue,
            clock: { times.removeFirst() },
            submit: { submitted in
                XCTAssertEqual(submitted, response)
                return try LiveActivityResponseServerResult.decode(
                    Data(#"{"state":"yes"}"#.utf8),
                    expectedAction: submitted.action
                )
            },
            present: { command in
                presentations.append(command)
                return true
            }
        )

        XCTAssertEqual(outcome, .accepted)
        XCTAssertEqual(presentations.map(\.phase), [.sending, .accepted])
        let accepted = try XCTUnwrap(presentations.last)
        XCTAssertEqual(accepted.presentedAt, startedAt.addingTimeInterval(2))
        let confirmation = try XCTUnwrap(
            queue.confirmations(
                accountID: response.accountID,
                deviceID: response.deviceID,
                now: startedAt.addingTimeInterval(3)
            ).first
        )
        XCTAssertEqual(
            confirmation.confirmedAt.timeIntervalSince1970,
            startedAt.addingTimeInterval(1).timeIntervalSince1970,
            accuracy: 1
        )

        var updateCount = 0
        var dismissal: LiveActivityResponsePresentationDismissal?
        let executed = await LiveActivityResponsePresentationExecutor.execute(
            accepted,
            activityState: .active,
            update: { updateCount += 1 },
            end: { dismissal = $0 }
        )
        XCTAssertTrue(executed)
        XCTAssertEqual(updateCount, 0)
        XCTAssertEqual(
            dismissal,
            .after(startedAt.addingTimeInterval(7))
        )
        XCTAssertNotEqual(dismissal, .immediate)
    }

    func testProductionAppReplayGivesDelayedDurableConfirmationAFreshFiveSecondPresentation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = CrossProcessResponseFile(baseDirectory: directory)
        let response = liveActivityResponse(action: .approve)
        let startedAt = Date()
        var times = [startedAt, startedAt.addingTimeInterval(1), startedAt.addingTimeInterval(2)]

        let outcome = await LiveActivityResponseIntentOrchestrator.perform(
            requested: response,
            queue: queue,
            clock: { times.removeFirst() },
            submit: { _ in LiveActivityResponseServerResult(state: "approved") },
            present: { command in command.phase != .accepted }
        )
        XCTAssertEqual(outcome, .accepted)

        let relaunchedAt = startedAt.addingTimeInterval(60)
        let confirmations = try queue.confirmations(
            accountID: response.accountID,
            deviceID: response.deviceID,
            now: relaunchedAt
        )
        let durable = try XCTUnwrap(confirmations.first)
        var replayed: [LiveActivityResponsePresentationCommand] = []
        await LiveActivityResponseReplayCoordinator.replay(
            confirmations,
            clock: { relaunchedAt },
            present: { confirmation, presentedAt in
                replayed.append(
                    .accepted(
                        confirmation,
                        credential: try! XCTUnwrap(response.responseCredential),
                        presentedAt: presentedAt
                    )
                )
            }
        )

        XCTAssertEqual(
            durable.confirmedAt.timeIntervalSince1970,
            startedAt.addingTimeInterval(1).timeIntervalSince1970,
            accuracy: 1
        )
        let replay = try XCTUnwrap(replayed.first)
        XCTAssertEqual(replay.presentedAt, relaunchedAt)
        XCTAssertEqual(
            replay.operation(for: .active),
            .end(.after(relaunchedAt.addingTimeInterval(5)))
        )
        XCTAssertNotEqual(
            replay.operation(for: .active),
            .end(.after(durable.confirmedAt.addingTimeInterval(5)))
        )
    }

    func testProductionWidgetMappingCoversActionsSendingQueuedRejectedAndAccepted() {
        let now = Date()
        var interaction = LiveActivityContentInteraction(
            id: "int_test123456",
            notificationID: "ntf_test123456",
            targetDeviceID: "dev_test123456",
            accountID: "acc_test123456",
            kind: "yes_no",
            state: "pending",
            credential: "credential-value-that-is-long-enough",
            expiresAtUnixSeconds: Int64(now.addingTimeInterval(600).timeIntervalSince1970)
        )

        XCTAssertEqual(widgetPresentation(interaction, now: now).mode, .actions)
        interaction.responsePhase = .sending
        interaction.selectedAction = .yes
        XCTAssertEqual(
            widgetPresentation(interaction, now: now),
            LiveActivityResponseWidgetPresentation(
                mode: .sending,
                label: "Sending Yes…",
                symbol: nil,
                showsProgress: true
            )
        )
        interaction.responsePhase = .queued
        XCTAssertEqual(widgetPresentation(interaction, now: now).mode, .queued)
        interaction.responsePhase = .rejected
        XCTAssertEqual(widgetPresentation(interaction, now: now).mode, .rejected)
        interaction.responsePhase = .accepted
        interaction.state = "yes"
        XCTAssertEqual(
            widgetPresentation(interaction, now: now),
            LiveActivityResponseWidgetPresentation(
                mode: .accepted,
                label: "Answered Yes",
                symbol: "checkmark.circle.fill",
                showsProgress: false
            )
        )
        XCTAssertEqual(
            LiveActivityResponseWidgetPresentation.make(
                interaction: nil,
                primary: "Yes",
                secondary: "No",
                fallbackStatus: "Yes",
                now: now
            ),
            LiveActivityResponseWidgetPresentation(
                mode: .terminal,
                label: "Yes",
                symbol: "checkmark.circle.fill",
                showsProgress: false
            )
        )
    }

    func testFirstTapDurablyQueuesBeforePresentingSending() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = CrossProcessResponseFile(baseDirectory: directory)
        let response = liveActivityResponse(action: .yes)
        var pendingCountWhenSending: Int?

        let outcome = await LiveActivityResponseIntentOrchestrator.perform(
            requested: response,
            queue: queue,
            submit: { _ in throw LiveActivityResponseTransport.SubmissionError.unavailable },
            present: { command in
                if command.phase == .sending {
                    pendingCountWhenSending = try? queue.pending(
                        accountID: response.accountID,
                        deviceID: response.deviceID,
                        now: .now
                    ).count
                }
                return true
            }
        )

        XCTAssertEqual(outcome, .queued)
        XCTAssertEqual(pendingCountWhenSending, 1)
        XCTAssertEqual(
            try queue.pending(
                accountID: response.accountID,
                deviceID: response.deviceID,
                now: .now
            ).map(\.action),
            [.yes]
        )
    }

    func testProductionTransportClassifiesCanonicalMismatchConflictAndRejection() async throws {
        let response = liveActivityResponse(action: .yes)
        let origin = try XCTUnwrap(URL(string: "https://server.example.test"))
        let success = try await LiveActivityResponseTransport.submit(
            response,
            apiOrigin: origin,
            load: { request in
                XCTAssertEqual(request.url?.path, "/api/live-activity-responses/int_test123456")
                return (
                    Data(#"{"state":"yes"}"#.utf8),
                    try XCTUnwrap(HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil))
                )
            }
        )
        XCTAssertEqual(success.state, "yes")

        for (status, body, expected) in [
            (200, #"{"state":"no"}"#, "unconfirmed"),
            (409, #"{}"#, "unconfirmed"),
            (403, #"{}"#, "rejected")
        ] {
            do {
                _ = try await LiveActivityResponseTransport.submit(
                    response,
                    apiOrigin: origin,
                    load: { request in
                        (
                            Data(body.utf8),
                            try XCTUnwrap(
                                HTTPURLResponse(
                                    url: request.url!,
                                    statusCode: status,
                                    httpVersion: nil,
                                    headerFields: nil
                                )
                            )
                        )
                    }
                )
                XCTFail("Expected \(expected)")
            } catch LiveActivityResponseTransport.SubmissionError.unconfirmed {
                XCTAssertEqual(expected, "unconfirmed")
            } catch LiveActivityResponseTransport.SubmissionError.rejected {
                XCTAssertEqual(expected, "rejected")
            } catch {
                XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testProductionOrchestratorPreservesOfflineDuplicateFirstDecisionAndScopeWithoutReceipts() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = CrossProcessResponseFile(baseDirectory: directory)
        let yes = liveActivityResponse(action: .yes)
        var submitCount = 0

        let offline = await LiveActivityResponseIntentOrchestrator.perform(
            requested: yes,
            queue: queue,
            submit: { _ in
                submitCount += 1
                throw LiveActivityResponseTransport.SubmissionError.unavailable
            },
            present: { _ in true }
        )
        XCTAssertEqual(offline, .queued)
        XCTAssertEqual(submitCount, 1)
        XCTAssertEqual(
            try queue.pending(accountID: yes.accountID, deviceID: yes.deviceID, now: .now).map(\.action),
            [.yes]
        )

        let duplicate = await LiveActivityResponseIntentOrchestrator.perform(
            requested: yes,
            queue: queue,
            submit: { _ in
                submitCount += 1
                return LiveActivityResponseServerResult(state: "yes")
            },
            present: { _ in true }
        )
        XCTAssertEqual(duplicate, .duplicatePending)
        XCTAssertEqual(submitCount, 1)

        let configurationError = await LiveActivityResponseIntentOrchestrator.retry(
            yes,
            queue: queue,
            submit: { _ in throw LiveActivityResponseTransport.SubmissionError.invalidConfiguration },
            present: { _ in true }
        )
        XCTAssertEqual(configurationError, .queued)
        XCTAssertEqual(
            try queue.pending(accountID: yes.accountID, deviceID: yes.deviceID, now: .now).map(\.action),
            [.yes]
        )

        let accepted = await LiveActivityResponseIntentOrchestrator.retry(
            yes,
            queue: queue,
            submit: { _ in LiveActivityResponseServerResult(state: "yes") },
            present: { _ in true }
        )
        XCTAssertEqual(accepted, .accepted)
        let no = liveActivityResponse(action: .no)
        var firstDecision: NotificationInteractionAction?
        let opposite = await LiveActivityResponseIntentOrchestrator.perform(
            requested: no,
            queue: queue,
            submit: { _ in
                XCTFail("A confirmed first decision must not submit again")
                return LiveActivityResponseServerResult(state: "no")
            },
            present: { command in
                firstDecision = command.response.action
                return true
            }
        )
        XCTAssertEqual(opposite, .duplicateConfirmed)
        XCTAssertEqual(firstDecision, .yes)

        let otherAccount = PendingNotificationResponse.liveActivity(
            accountID: "acc_other123456",
            deviceID: "dev_other123456",
            notificationID: yes.notificationID,
            activityID: yes.activityID!,
            activityGeneration: yes.activityGeneration!,
            interactionID: yes.interactionID!,
            action: .no,
            credential: "credential-value-that-is-long-enough",
            expiresAt: yes.expiresAt
        )
        let isolated = await LiveActivityResponseIntentOrchestrator.perform(
            requested: otherAccount,
            queue: queue,
            submit: { _ in LiveActivityResponseServerResult(state: "no") },
            present: { _ in true }
        )
        XCTAssertEqual(isolated, .accepted)
        XCTAssertEqual(
            try queue.confirmations(accountID: yes.accountID, deviceID: yes.deviceID, now: .now).map(\.action),
            [.yes]
        )
        XCTAssertEqual(
            try queue.confirmations(
                accountID: otherAccount.accountID,
                deviceID: otherAccount.deviceID,
                now: .now
            ).map(\.action),
            [.no]
        )

        let rejected = PendingNotificationResponse.liveActivity(
            accountID: "acc_rejected1234",
            deviceID: "dev_rejected1234",
            notificationID: "ntf_rejected1234",
            activityID: "act_rejected1234",
            activityGeneration: 1,
            interactionID: "int_rejected1234",
            action: .approve,
            credential: "credential-value-that-is-long-enough",
            expiresAt: yes.expiresAt
        )
        var rejectedPhases: [LiveActivityResponsePhase] = []
        let rejectedOutcome = await LiveActivityResponseIntentOrchestrator.perform(
            requested: rejected,
            queue: queue,
            submit: { _ in throw LiveActivityResponseTransport.SubmissionError.rejected },
            present: { command in
                rejectedPhases.append(command.phase)
                return true
            }
        )
        XCTAssertEqual(rejectedOutcome, .rejected)
        XCTAssertEqual(rejectedPhases, [.sending, .rejected])
        XCTAssertTrue(
            try queue.pending(
                accountID: rejected.accountID,
                deviceID: rejected.deviceID,
                now: .now
            ).isEmpty
        )

        let receiptStore = InMemoryProtectedActionStore()
        let receiptLedger = await receiptStore.load()
        XCTAssertTrue(receiptLedger.pendingReceivedEventIDs.isEmpty)
    }

    func testConfirmedLiveActivityResponseSurvivesRelaunchWithoutPersistingCredential() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = CrossProcessResponseFile(baseDirectory: directory)
        let response = liveActivityResponse(action: .approve, credential: "credential-value-that-is-long-enough")
        XCTAssertEqual(try first.enqueue(response), .enqueued)
        let confirmedAt = Date()

        let confirmation = try first.confirm(
            response,
            canonicalState: "approved",
            confirmedAt: confirmedAt
        )
        let relaunched = CrossProcessResponseFile(baseDirectory: directory)
        let pending = try relaunched.pending(
            accountID: response.accountID,
            deviceID: response.deviceID,
            now: confirmedAt.addingTimeInterval(1)
        )
        let confirmations = try relaunched.confirmations(
            accountID: response.accountID,
            deviceID: response.deviceID,
            now: confirmedAt.addingTimeInterval(1)
        )
        let fileURL = directory
            .appendingPathComponent(response.accountID, isDirectory: true)
            .appendingPathComponent(response.deviceID, isDirectory: true)
            .appendingPathComponent("pending-responses.json")
        let persisted = String(decoding: try Data(contentsOf: fileURL), as: UTF8.self)

        XCTAssertTrue(pending.isEmpty)
        XCTAssertEqual(confirmations.map(\.decisionKey), [confirmation.decisionKey])
        XCTAssertEqual(confirmations.map(\.canonicalState), [confirmation.canonicalState])
        XCTAssertFalse(persisted.contains("credential-value-that-is-long-enough"))
        XCTAssertEqual(
            confirmation.response(using: "credential-value-that-is-long-enough").responseCredential,
            "credential-value-that-is-long-enough"
        )
    }

    func testProtectedResponsesRemainIndependentAcrossActivityGenerations() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = CrossProcessResponseFile(baseDirectory: directory)
        let first = liveActivityResponse(action: .yes, generation: 1)
        let resumed = liveActivityResponse(action: .yes, generation: 2)

        XCTAssertNotEqual(first.idempotencyKey, resumed.idempotencyKey)
        XCTAssertNotEqual(first.decisionKey, resumed.decisionKey)
        XCTAssertEqual(try queue.enqueue(first), .enqueued)
        XCTAssertEqual(try queue.enqueue(resumed), .enqueued)

        let confirmation = try queue.confirm(first, canonicalState: "yes", confirmedAt: .now)
        XCTAssertEqual(confirmation.activityGeneration, 1)
        let remaining = try queue.pending(
            accountID: resumed.accountID,
            deviceID: resumed.deviceID,
            now: .now
        )
        XCTAssertEqual(remaining.map(\.id), [resumed.id])
        XCTAssertEqual(remaining.map(\.activityGeneration), [2])
    }

    func testDuplicateAndOppositeTapReuseOneDurableConfirmedDecision() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let yes = liveActivityResponse(action: .yes)
        let no = liveActivityResponse(action: .no)
        XCTAssertEqual(try file.enqueue(yes), .enqueued)
        let confirmation = try file.confirm(yes, canonicalState: "yes", confirmedAt: .now)

        guard case .alreadyConfirmed(let duplicate) = try file.enqueue(yes) else {
            return XCTFail("A duplicate tap must reuse the durable confirmation")
        }
        guard case .alreadyConfirmed(let opposite) = try file.enqueue(no) else {
            return XCTFail("An opposite tap must not create a second decision")
        }
        XCTAssertEqual(duplicate.decisionKey, confirmation.decisionKey)
        XCTAssertEqual(opposite.action, .yes)
        let confirmations = try file.confirmations(
            accountID: yes.accountID,
            deviceID: yes.deviceID,
            now: .now
        )
        XCTAssertEqual(confirmations.map(\.decisionKey), [confirmation.decisionKey])
        XCTAssertTrue(try file.pending(accountID: yes.accountID, deviceID: yes.deviceID, now: .now).isEmpty)
    }

    func testConfirmationWithoutExactPendingResponseFailsClosed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let response = liveActivityResponse(action: .deny)

        XCTAssertThrowsError(try file.confirm(response, canonicalState: "denied", confirmedAt: .now)) {
            XCTAssertEqual($0 as? LiveActivityResponseConfirmationError, .missingPendingResponse)
        }
        XCTAssertTrue(
            try file.confirmations(accountID: response.accountID, deviceID: response.deviceID, now: .now).isEmpty
        )
    }

    func testOfflineLiveActivityResponseRemainsPendingAcrossRelaunchAndAccountsStayIsolated() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = CrossProcessResponseFile(baseDirectory: directory)
        let accountA = liveActivityResponse(action: .approve)
        let accountB = PendingNotificationResponse.liveActivity(
            accountID: "acc_other123456",
            deviceID: "dev_other123456",
            notificationID: accountA.notificationID,
            activityID: accountA.activityID!,
            activityGeneration: accountA.activityGeneration!,
            interactionID: accountA.interactionID!,
            action: .deny,
            credential: "credential-value-that-is-long-enough",
            expiresAt: accountA.expiresAt
        )
        XCTAssertEqual(try first.enqueue(accountA), .enqueued)
        XCTAssertEqual(try first.enqueue(accountB), .enqueued)

        let relaunched = CrossProcessResponseFile(baseDirectory: directory)
        let pendingA = try relaunched.pending(
            accountID: accountA.accountID,
            deviceID: accountA.deviceID,
            now: .now
        )
        let pendingB = try relaunched.pending(
            accountID: accountB.accountID,
            deviceID: accountB.deviceID,
            now: .now
        )
        XCTAssertEqual(pendingA.map(\.id), [accountA.id])
        XCTAssertEqual(pendingA.map(\.action), [accountA.action])
        XCTAssertEqual(pendingB.map(\.id), [accountB.id])
        XCTAssertEqual(pendingB.map(\.action), [accountB.action])
        _ = try relaunched.confirm(accountA, canonicalState: "approved", confirmedAt: .now)
        XCTAssertEqual(
            try relaunched.pending(
                accountID: accountB.accountID,
                deviceID: accountB.deviceID,
                now: .now
            ).map(\.id),
            [accountB.id]
        )
        XCTAssertTrue(
            try relaunched.confirmations(accountID: accountB.accountID, deviceID: accountB.deviceID, now: .now).isEmpty
        )
    }

    func testEveryPrivateStyleUsesOneGenericNonInteractiveDisplay() {
        let styles = ["standard", "hero", "terminal", "steps", "approval", "shell", "verdict", "signal"]
        let expected = LiveActivityLockScreenDisplay(
            style: "standard",
            sourceName: "Relo",
            headline: "Private activity",
            detail: nil,
            status: "Open Relo to view",
            progress: nil,
            allowsInteraction: false
        )
        for style in styles {
            let command = LiveActivityCommand(
                operation: .start,
                activityId: "act_test123456",
                generation: 1,
                targetDeviceId: "dev_test123456",
                style: style,
                sourceName: "Secret source",
                headline: "Secret headline",
                detail: "Secret detail",
                status: "42% secret",
                progress: 0.42,
                privacy: .private,
                alertOwner: .app,
                interaction: LiveActivityInteractionCommand(
                    id: "int_test123456",
                    notificationId: "ntf_test123456",
                    kind: .approval,
                    state: .pending,
                    credential: "secret-credential",
                    expiresAt: .now.addingTimeInterval(600)
                )
            )
            XCTAssertEqual(command.lockScreenDisplay, expected, "Style \(style) leaked presentation semantics")
        }
    }

    func testDestinationRejectsCredentialsAndNonHTTPSURLs() {
        let insecure = baseItem(destination: URL(string: "http://example.test"))
        let credentialed = baseItem(destination: URL(string: "https://user:secret@example.test"))
        XCTAssertNil(insecure.validatedDestinationURL)
        XCTAssertNil(credentialed.validatedDestinationURL)
        let valid = baseItem(destination: URL(string: "https://example.test/path"))
        XCTAssertEqual(valid.validatedDestinationURL?.host, "example.test")
        XCTAssertNil(NotificationDestinationPolicy.validatedURL("https://user:secret@example.test/path"))
        XCTAssertNil(NotificationDestinationPolicy.validatedURL("http://example.test/path"))
    }

    func testColdRouteResolvesFromCachedInboxWithoutRemoteSync() {
        let cached = baseItem(destination: nil)
        XCTAssertTrue(NotificationRouteResolver.contains(notificationID: cached.id, in: [cached]))
        XCTAssertFalse(NotificationRouteResolver.contains(notificationID: "ntf_missing12345", in: [cached]))
    }

    func testReadinessRequiresServerAcceptanceOfCurrentAPNSToken() {
        XCTAssertFalse(DeviceReadinessPolicy.isReady(
            permissionAllowed: true,
            deviceRegistered: true,
            apnsTokenAvailable: true,
            serverAcceptedCurrentAPNSToken: false,
            hasPushRegistrationError: false,
            liveActivitiesAuthorized: true,
            liveActivityPushToStartTokenAvailable: true,
            syncCurrent: true
        ))
        XCTAssertTrue(DeviceReadinessPolicy.isReady(
            permissionAllowed: true,
            deviceRegistered: true,
            apnsTokenAvailable: true,
            serverAcceptedCurrentAPNSToken: true,
            hasPushRegistrationError: false,
            liveActivitiesAuthorized: true,
            liveActivityPushToStartTokenAvailable: true,
            syncCurrent: true
        ))
    }

    func testAPNSTokenSessionDoesNotPromoteCachedTokenToCurrentReadiness() {
        let restored = APNSTokenSessionState.restored(cachedTokenAvailable: true)
        XCTAssertTrue(restored.cachedTokenAvailable)
        XCTAssertFalse(restored.currentSessionTokenAvailable)

        let current = restored.receivingCurrentToken(persistedTokenAvailable: true)
        XCTAssertTrue(current.cachedTokenAvailable)
        XCTAssertTrue(current.currentSessionTokenAvailable)

        let retrying = current.retryingRegistration()
        XCTAssertTrue(retrying.cachedTokenAvailable)
        XCTAssertFalse(retrying.currentSessionTokenAvailable)

        let failed = retrying.registrationFailed(cachedTokenAvailable: true)
        XCTAssertTrue(failed.cachedTokenAvailable)
        XCTAssertFalse(failed.currentSessionTokenAvailable)
    }

    func testReplyValidationMatchesFourThousandCharacterContractBoundary() {
        XCTAssertFalse(NotificationReplyPolicy.isValid(nil))
        XCTAssertFalse(NotificationReplyPolicy.isValid("  \n"))
        XCTAssertTrue(NotificationReplyPolicy.isValid("x"))
        XCTAssertTrue(NotificationReplyPolicy.isValid(String(repeating: "x", count: 4_000)))
        XCTAssertFalse(NotificationReplyPolicy.isValid(String(repeating: "x", count: 4_001)))
        XCTAssertEqual(NotificationReplyPolicy.normalized("  answer \n"), "answer")

        let emoji = String(repeating: "😀", count: 2_000)
        XCTAssertEqual(NotificationReplyPolicy.utf16Count(emoji), 4_000)
        XCTAssertTrue(NotificationReplyPolicy.isValid(emoji))
        XCTAssertFalse(NotificationReplyPolicy.isValid(emoji + "😀"))

        let combining = String(repeating: "e\u{301}", count: 2_000)
        XCTAssertEqual(combining.count, 2_000)
        XCTAssertEqual(NotificationReplyPolicy.utf16Count(combining), 4_000)
        XCTAssertTrue(NotificationReplyPolicy.isValid(combining))
        XCTAssertFalse(NotificationReplyPolicy.isValid(combining + "e\u{301}"))
    }

    func testAccountDeletionRequiresPasswordAndExactDestructiveConfirmation() {
        XCTAssertTrue(AccountDeletionConfirmationPolicy.isValid(
            password: "valid-password",
            confirmation: "DELETE"
        ))
        XCTAssertFalse(AccountDeletionConfirmationPolicy.isValid(
            password: "valid-password",
            confirmation: "  DELETE\n"
        ))
        XCTAssertFalse(AccountDeletionConfirmationPolicy.isValid(
            password: "short",
            confirmation: "DELETE"
        ))
        XCTAssertFalse(AccountDeletionConfirmationPolicy.isValid(
            password: "valid-password",
            confirmation: "delete"
        ))
    }

    func testCommittedAccountDeletionInvokesNotificationCleanup() async throws {
        let cleaner = RecordingAccountNotificationCleaner()

        try await AccountDeletionNotificationCleanup.perform(using: cleaner)

        let callCount = await cleaner.callCount
        XCTAssertEqual(callCount, 1)
    }

    func testProgressPresentationUsesOnlyActualFiniteProgress() {
        let unknown = ActivityProgressPresentation(progress: nil)
        XCTAssertNil(unknown.normalizedValue)
        XCTAssertNil(unknown.percentage)
        XCTAssertNil(unknown.completedStepCount)
        XCTAssertEqual(unknown.accessibilityValue, "Progress unavailable")

        XCTAssertNil(ActivityProgressPresentation(progress: .nan).normalizedValue)
        XCTAssertNil(ActivityProgressPresentation(progress: .infinity).normalizedValue)
        XCTAssertNil(ActivityProgressPresentation(progress: -.infinity).normalizedValue)
        XCTAssertEqual(ActivityProgressPresentation(progress: -0.2).normalizedValue, 0)
        XCTAssertEqual(ActivityProgressPresentation(progress: 1.2).normalizedValue, 1)

        let partial = ActivityProgressPresentation(progress: 0.42)
        XCTAssertEqual(partial.normalizedValue, 0.42)
        XCTAssertEqual(partial.percentage, 42)
        XCTAssertEqual(partial.completedStepCount, 3)
        XCTAssertEqual(partial.accessibilityValue, "42 percent")
    }

    func testAccessibilitySummaryNeverRendersNonFiniteProgress() {
        for progress in [Double.nan, .infinity, -.infinity] {
            let summary = LiveActivityAccessibilitySummary(
                source: "Codex",
                headline: "Build",
                status: "Running",
                detail: "Unit tests",
                progress: progress,
                isPrivate: false,
                isInteractive: false
            )
            XCTAssertEqual(summary.value, "Running, Unit tests")
            XCTAssertFalse(summary.value.localizedCaseInsensitiveContains("nan"))
            XCTAssertFalse(summary.value.localizedCaseInsensitiveContains("inf"))
        }
    }

    func testRegistrationPrerequisitesNeverLeaveMissingTokenRegistering() {
        XCTAssertEqual(DeviceRegistrationPolicy.prerequisitePhase(
            hasAuthenticatedAccount: false,
            permissionAllowed: false,
            apnsTokenAvailable: false,
            pushRegistrationFailed: false
        ), .idle)
        XCTAssertEqual(DeviceRegistrationPolicy.prerequisitePhase(
            hasAuthenticatedAccount: true,
            permissionAllowed: false,
            apnsTokenAvailable: false,
            pushRegistrationFailed: false
        ), .waitingForPermission)
        XCTAssertEqual(DeviceRegistrationPolicy.prerequisitePhase(
            hasAuthenticatedAccount: true,
            permissionAllowed: true,
            apnsTokenAvailable: false,
            pushRegistrationFailed: false
        ), .waitingForAPNSToken)
        XCTAssertNil(DeviceRegistrationPolicy.prerequisitePhase(
            hasAuthenticatedAccount: true,
            permissionAllowed: true,
            apnsTokenAvailable: true,
            pushRegistrationFailed: false
        ))
        guard case .failed = DeviceRegistrationPolicy.prerequisitePhase(
            hasAuthenticatedAccount: true,
            permissionAllowed: true,
            apnsTokenAvailable: false,
            pushRegistrationFailed: true
        ) else {
            return XCTFail("An APNs registration error must be explicit and retryable")
        }
    }

    func testNotificationImagePolicyMasksPrivateAndRejectsUnsafeURLs() {
        let standard = InboxItem(
            id: "ntf_standard12345",
            kind: .notification,
            sourceName: "Codex",
            sourceImageUrl: URL(string: "https://images.example.test/status.png"),
            title: "Continue?",
            createdAt: .now
        )
        let privateItem = InboxItem(
            id: "ntf_private123456",
            kind: .notification,
            sourceName: "Codex",
            sourceImageUrl: URL(string: "https://images.example.test/private.png"),
            title: "Private",
            createdAt: .now,
            privacy: .private
        )
        XCTAssertEqual(standard.validatedSourceImageURL?.host, "images.example.test")
        XCTAssertNil(privateItem.validatedSourceImageURL)
        let blocked = [
            "http://images.example.test/status.png",
            "https://user:secret@images.example.test/status.png",
            "https://localhost/status.png",
            "https://printer/status.png",
            "https://images.example.test./status.png",
            "https://agent.local/status.png",
            "https://agent.internal/status.png",
            "https://agent.home/status.png",
            "https://agent.lan/status.png",
            "https://127.0.0.1/status.png",
            "https://127.1/status.png",
            "https://2130706433/status.png",
            "https://0x7f000001/status.png",
            "https://017700000001/status.png",
            "https://0177.0.0.1/status.png",
            "https://10.0.0.1/status.png",
            "https://169.254.169.254/status.png",
            "https://192.168.1.10/status.png",
            "https://100.100.100.100/status.png",
            "https://203.0.113.10/status.png",
            "https://[::1]/status.png",
            "https://[fd00::1]/status.png",
            "https://[fe80::1]/status.png",
            "https://[2001:db8::1]/status.png",
            "https://[::ffff:127.0.0.1]/status.png",
            "https://[0:0:0:0:0:ffff:7f00:1]/status.png",
            "https://[0:0:0:0:0:0:7f00:1]/status.png",
        ]
        for value in blocked {
            XCTAssertNil(NotificationImagePolicy.validatedURL(value), "Unexpectedly accepted \(value)")
        }
        XCTAssertNotNil(NotificationImagePolicy.validatedURL("https://93.184.216.34/status.png"))
    }

    func testHistoryProjectionPrunesToBoundAndSearchesBeyondFirstPage() {
        let durableItems = (0..<700).map { index in
            InboxItem(
                id: String(format: "ntf_%012d", index),
                kind: .notification,
                sourceName: "Codex",
                title: index == 150 ? "Needle build" : "Build \(index)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(700 - index))
            )
        }

        let retained = InboxHistoryRetention.retainingNewest(durableItems)
        var visibleLimit = InboxHistoryProjection.pageSize
        while visibleLimit < retained.count {
            visibleLimit = InboxHistoryProjection.nextVisibleLimit(
                current: visibleLimit,
                available: retained.count
            )
        }

        XCTAssertEqual(durableItems.count, 700)
        XCTAssertEqual(retained.count, InboxHistoryRetention.maximumStoredItems)
        XCTAssertEqual(Set(retained.map(\.id)).count, retained.count)
        XCTAssertTrue(InboxHistoryProjection.matchesSearch(retained[150], query: "needle"))
        XCTAssertFalse(InboxHistoryProjection.matchesSearch(retained[0], query: "needle"))
        XCTAssertEqual(InboxHistoryProjection.nextVisibleLimit(current: 50, available: retained.count), 100)
        XCTAssertEqual(visibleLimit, InboxHistoryRetention.maximumStoredItems)
        XCTAssertEqual(
            InboxHistoryProjection.nextVisibleLimit(current: visibleLimit, available: retained.count),
            InboxHistoryRetention.maximumStoredItems
        )
    }

    func testHistoryProjectionCollapsesActivityEventsAndUsesCanonicalTerminalState() {
        let context = InboxContext(
            providerName: "Codex",
            project: "Relo notifications",
            threadName: "Lifecycle audit",
            taskTitle: "Collapse repeated updates"
        )
        let summary = InboxActivitySummary(
            id: "act_logical123456",
            originThreadId: "org_thread123456",
            generation: 2,
            sequence: 3,
            state: "ended",
            title: "Codex · Relo notifications",
            status: "Complete",
            terminalReason: "ended_by_producer",
            context: context,
            updatedAt: Date(timeIntervalSince1970: 3)
        )
        let events = (1...3).map { sequence in
            InboxItem(
                id: "ntf_logical\(sequence)",
                kind: .liveActivity,
                sourceName: "developer-mac-codex",
                title: "Event \(sequence)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(sequence)),
                liveActivity: LiveActivityCommand(
                    operation: sequence == 1 ? .start : sequence == 3 ? .end : .update,
                    activityId: summary.id,
                    generation: summary.generation,
                    targetDeviceId: "dev_logical123456",
                    style: "standard",
                    sourceName: "developer-mac-codex",
                    headline: "Event \(sequence)",
                    status: sequence == 3 ? "Complete" : "Working",
                    sequence: sequence
                ),
                activitySummary: summary,
                context: context
            )
        }

        let collapsed = InboxHistoryProjection.collapsedActivities(events)

        XCTAssertEqual(collapsed.map(\.id), ["ntf_logical3"])
        XCTAssertEqual(collapsed.first?.activitySummary?.state, "ended")
        XCTAssertTrue(InboxHistoryProjection.activeActivities(events).isEmpty)
        XCTAssertTrue(InboxHistoryProjection.matchesSearch(collapsed[0], query: "Collapse repeated"))
    }

    func testActiveHistoryProjectionDropsCachedActivityPastItsPresentationDeadline() {
        let now = Date(timeIntervalSince1970: 10_000)
        let current = InboxItem(
            id: "ntf_current123456",
            kind: .liveActivity,
            sourceName: "Codex",
            title: "Current activity",
            createdAt: now.addingTimeInterval(-60),
            activitySummary: InboxActivitySummary(
                id: "act_current123456",
                generation: 1,
                sequence: 2,
                state: "active",
                title: "Current activity",
                status: "Working",
                staleAt: now.addingTimeInterval(60),
                expiresAt: now.addingTimeInterval(3_600)
            )
        )
        let stale = InboxItem(
            id: "ntf_stale123456",
            kind: .liveActivity,
            sourceName: "Codex",
            title: "Stale cached activity",
            createdAt: now.addingTimeInterval(-14_400),
            activitySummary: InboxActivitySummary(
                id: "act_stale123456",
                generation: 1,
                sequence: 1,
                state: "active",
                title: "Stale cached activity",
                status: "Working",
                staleAt: now,
                expiresAt: now.addingTimeInterval(3_600)
            )
        )
        let expired = InboxItem(
            id: "ntf_expired123456",
            kind: .liveActivity,
            sourceName: "Codex",
            title: "Expired cached activity",
            createdAt: now.addingTimeInterval(-14_400),
            activitySummary: InboxActivitySummary(
                id: "act_expired123456",
                generation: 1,
                sequence: 1,
                state: "active",
                title: "Expired cached activity",
                status: "Working",
                expiresAt: now
            )
        )

        XCTAssertEqual(
            InboxHistoryProjection.activeActivities([stale, current, expired], now: now).map(\.id),
            [current.id]
        )
    }

    func testHistoryPresentationResetsOnlyWhenAccountOrSessionScopeChanges() {
        var state = InboxHistoryPresentationState(defaultFilterIdentifier: "all")
        state.transition(to: "signed-in|account-one|user-one")
        state.searchQuery = "private account one query"
        state.filterIdentifier = "responses"
        state.showMore(available: 700)

        state.transition(to: "signed-in|account-one|user-one")

        XCTAssertEqual(state.searchQuery, "private account one query")
        XCTAssertEqual(state.filterIdentifier, "responses")
        XCTAssertEqual(state.visibleLimit, 100)

        state.transition(to: "signing-in|account-two|user-two")

        XCTAssertEqual(state.searchQuery, "")
        XCTAssertEqual(state.filterIdentifier, "all")
        XCTAssertEqual(state.visibleLimit, InboxHistoryProjection.pageSize)
    }

    func testBadgeProjectionCountsOnlyPendingUnexpiredInteractions() {
        let now = Date(timeIntervalSince1970: 1_000)
        let items = [
            interactionItem(id: "ntf_pending123456", state: .pending, expiresAt: now.addingTimeInterval(60)),
            interactionItem(id: "ntf_expired123456", state: .pending, expiresAt: now),
            interactionItem(id: "ntf_approved12345", state: .approved, expiresAt: now.addingTimeInterval(60)),
            InboxItem(
                id: "ntf_plain12345678",
                kind: .notification,
                sourceName: "Codex",
                title: "Complete",
                createdAt: now
            ),
        ]

        XCTAssertEqual(InboxBadgeProjection.pendingInteractionCount(in: items, now: now), 1)
    }

    func testOrdinaryResponseConfirmationIsDurablePrivateAndFirstDecisionWins() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let expiresAt = Date.now.addingTimeInterval(600)
        let approved = PendingNotificationResponse(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: "ntf_test123456",
            action: .approve,
            value: ["response": "must-not-survive-confirmation"],
            idempotencyKey: "ios:installation:ntf_test123456:approve",
            expiresAt: expiresAt
        )
        XCTAssertEqual(try file.enqueue(approved), .enqueued)
        let confirmation = try file.confirmNotification(approved, confirmedAt: .now)
        XCTAssertEqual(confirmation.canonicalState, "approved")
        XCTAssertTrue(
            try file.pending(
                accountID: approved.accountID,
                deviceID: approved.deviceID,
                now: .now
            ).isEmpty
        )

        let relaunched = CrossProcessResponseFile(baseDirectory: directory)
        let opposite = PendingNotificationResponse(
            accountID: approved.accountID,
            deviceID: approved.deviceID,
            notificationID: approved.notificationID,
            action: .deny,
            value: [:],
            idempotencyKey: "ios:installation:ntf_test123456:deny",
            expiresAt: expiresAt
        )
        guard case .alreadyNotificationConfirmed(let duplicate) = try relaunched.enqueue(opposite) else {
            return XCTFail("Expected the durable first decision")
        }
        XCTAssertEqual(duplicate.notificationID, confirmation.notificationID)
        XCTAssertEqual(duplicate.action, confirmation.action)
        XCTAssertEqual(duplicate.idempotencyKey, confirmation.idempotencyKey)
        XCTAssertLessThan(abs(duplicate.confirmedAt.timeIntervalSince(confirmation.confirmedAt)), 1)
        let relaunchedConfirmations = try relaunched.notificationConfirmations(
            accountID: approved.accountID,
            deviceID: approved.deviceID,
            now: .now
        )
        XCTAssertEqual(relaunchedConfirmations.count, 1)
        XCTAssertEqual(relaunchedConfirmations.first?.canonicalState, "approved")

        let accountDirectory = directory
            .appendingPathComponent(approved.accountID)
            .appendingPathComponent(approved.deviceID)
        let ledger = try String(
            contentsOf: accountDirectory.appendingPathComponent("pending-responses.json"),
            encoding: .utf8
        )
        XCTAssertFalse(ledger.contains("must-not-survive-confirmation"))
        XCTAssertTrue(
            try relaunched.notificationConfirmations(
                accountID: "acc_other123456",
                deviceID: approved.deviceID,
                now: .now
            ).isEmpty
        )
    }

    func testNotificationReceiptScopeRequiresCurrentAuthoritativeMembership() {
        XCTAssertEqual(
            NotificationReceiptScopePolicy.eligible(
                pendingNotificationIDs: ["ntf_old", "ntf_current", "ntf_current"],
                authoritativeNotificationIDs: ["ntf_current"]
            ),
            ["ntf_current"]
        )
        XCTAssertTrue(
            NotificationReceiptScopePolicy.eligible(
                pendingNotificationIDs: ["ntf_old"],
                authoritativeNotificationIDs: []
            ).isEmpty
        )
    }

    func testExactConvergenceRecordsOnlyExactNonterminalStartOrUpdateEvent() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        let startItem = item(eventID: "evt_exact123456", operation: .start, sequence: 4)
        let envelope = LiveActivityCommandEnvelope(
            eventID: startItem.id,
            createdAt: startItem.createdAt,
            command: try XCTUnwrap(startItem.liveActivity)
        )
        let exact = snapshot(sequence: 4, digest: "exact")

        try await coordinator.recordExactConvergenceSuccess(
            for: envelope,
            observed: exact,
            expected: exact
        )
        try await coordinator.recordExactConvergenceSuccess(
            for: envelope,
            observed: exact,
            expected: exact
        )
        let initialReceipts = try await coordinator.pendingReceivedEventIDs(limit: 10)
        XCTAssertEqual(initialReceipts, [envelope.eventID])

        let mismatch = snapshot(sequence: 4, digest: "mismatch")
        do {
            try await coordinator.recordExactConvergenceSuccess(
                for: envelope,
                observed: mismatch,
                expected: exact
            )
            XCTFail("A mismatched snapshot must not record a receipt")
        } catch {
            // Expected fail-closed result.
        }
        let terminal = snapshot(sequence: 4, digest: "exact", terminal: true)
        do {
            try await coordinator.recordExactConvergenceSuccess(
                for: envelope,
                observed: terminal,
                expected: terminal
            )
            XCTFail("A terminal snapshot must not record an unjournaled receipt")
        } catch {
            // Expected fail-closed result.
        }
        let finalReceipts = try await coordinator.pendingReceivedEventIDs(limit: 10)
        XCTAssertEqual(finalReceipts, [envelope.eventID])
    }

    func testPresentationDismissalQueueIsDurableDeduplicatedAndAccountScoped() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AccountScopedProtectedActionStore(baseDirectory: directory)
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")

        let identity = LiveActivityIdentity(activityID: "act_test123456", generation: 2)
        try await coordinator.recordPresentationDismissal(identity: identity)
        try await coordinator.recordPresentationDismissal(identity: identity)
        let initiallyPending = try await coordinator.pendingDismissedActivityIdentities(limit: 10)
        XCTAssertEqual(initiallyPending, [identity])

        let relaunched = LiveActivityCommandCoordinator(
            store: AccountScopedProtectedActionStore(baseDirectory: directory)
        )
        try await relaunched.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let relaunchedPending = try await relaunched.pendingDismissedActivityIdentities(limit: 10)
        XCTAssertEqual(relaunchedPending, [identity])
        try await relaunched.removeDismissedActivityIdentities([identity])
        let removedPending = try await relaunched.pendingDismissedActivityIdentities(limit: 10)
        XCTAssertTrue(removedPending.isEmpty)

        try await relaunched.select(accountID: "acc_other123456", deviceID: "dev_test123456")
        let otherAccountPending = try await relaunched.pendingDismissedActivityIdentities(limit: 10)
        XCTAssertTrue(otherAccountPending.isEmpty)
    }

    func testObservedActivityKitTerminalStateDurablyConfirmsExactEndOnly() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let firstStore = AccountScopedProtectedActionStore(baseDirectory: directory)
        let coordinator = LiveActivityCommandCoordinator(store: firstStore)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let endItem = item(eventID: "evt_directend1234", operation: .end, sequence: 4)
        let envelope = LiveActivityCommandEnvelope(
            eventID: endItem.id,
            createdAt: endItem.createdAt,
            command: try XCTUnwrap(endItem.liveActivity)
        )
        let terminal = snapshot(sequence: 4, digest: "direct-final", terminal: true)
        try await coordinator.recordSystemObservation(
            LiveActivitySystemObservation(
                snapshot: terminal,
                contentUpdatedAt: Date(timeIntervalSince1970: 4),
                observedAt: Date(timeIntervalSince1970: 5)
            )
        )
        let relaunchedStore = AccountScopedProtectedActionStore(baseDirectory: directory)
        let relaunched = LiveActivityCommandCoordinator(store: relaunchedStore)
        try await relaunched.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let firstConvergence = try await relaunched.recordObservedSystemConvergenceSuccess(
            for: envelope,
            expected: terminal
        )
        XCTAssertTrue(firstConvergence)
        let duplicateConvergence = try await relaunched.recordObservedSystemConvergenceSuccess(
            for: envelope,
            expected: terminal
        )
        XCTAssertTrue(duplicateConvergence)
        let receipts = try await relaunched.pendingReceivedEventIDs(limit: 10)
        XCTAssertEqual(receipts, [envelope.eventID])

        let mismatchedItem = item(eventID: "evt_directend5678", operation: .end, sequence: 5)
        let mismatched = LiveActivityCommandEnvelope(
            eventID: mismatchedItem.id,
            createdAt: mismatchedItem.createdAt,
            command: try XCTUnwrap(mismatchedItem.liveActivity)
        )
        let mismatchedConvergence = try await relaunched.recordObservedSystemConvergenceSuccess(
            for: mismatched,
            expected: snapshot(sequence: 5, digest: "other", terminal: true)
        )
        XCTAssertFalse(mismatchedConvergence)
        let unchanged = try await relaunched.pendingReceivedEventIDs(limit: 10)
        XCTAssertEqual(unchanged, [envelope.eventID])
    }

    func testActivityKitObservationRejectsOlderStateAndKeepsTerminalStateSticky() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        let base = LiveActivitySystemObservation(
            snapshot: snapshot(sequence: 3, digest: "current"),
            contentUpdatedAt: Date(timeIntervalSince1970: 30),
            observedAt: Date(timeIntervalSince1970: 31)
        )
        try await coordinator.recordSystemObservation(base)
        try await coordinator.recordSystemObservation(
            LiveActivitySystemObservation(
                snapshot: snapshot(sequence: 2, digest: "older"),
                contentUpdatedAt: Date(timeIntervalSince1970: 29),
                observedAt: Date(timeIntervalSince1970: 32)
            )
        )
        var observation = try await coordinator.systemObservation(
            identity: LiveActivityIdentity(activityID: "act_test123456", generation: 1)
        )
        XCTAssertEqual(observation, base)

        let terminal = LiveActivitySystemObservation(
            snapshot: snapshot(sequence: 4, digest: "final", terminal: true),
            contentUpdatedAt: Date(timeIntervalSince1970: 40),
            observedAt: Date(timeIntervalSince1970: 41)
        )
        try await coordinator.recordSystemObservation(terminal)
        try await coordinator.recordSystemObservation(
            LiveActivitySystemObservation(
                snapshot: snapshot(sequence: 5, digest: "late-active"),
                contentUpdatedAt: Date(timeIntervalSince1970: 50),
                observedAt: Date(timeIntervalSince1970: 51)
            )
        )
        observation = try await coordinator.systemObservation(
            identity: LiveActivityIdentity(activityID: "act_test123456", generation: 1)
        )
        XCTAssertEqual(observation, terminal)
    }

    func testLaterResponsePresentationDoesNotEraseEarlierExactActivityKitProof() async throws {
        let store = InMemoryProtectedActionStore()
        let coordinator = LiveActivityCommandCoordinator(store: store)
        let startItem = item(eventID: "evt_directstart12", operation: .start, sequence: 4)
        let envelope = LiveActivityCommandEnvelope(
            eventID: startItem.id,
            createdAt: startItem.createdAt,
            command: try XCTUnwrap(startItem.liveActivity)
        )
        let applied = snapshot(sequence: 4, digest: "original")
        try await coordinator.recordSystemObservation(
            LiveActivitySystemObservation(
                snapshot: applied,
                contentUpdatedAt: Date(timeIntervalSince1970: 40),
                observedAt: Date(timeIntervalSince1970: 41)
            )
        )
        try await coordinator.recordSystemObservation(
            LiveActivitySystemObservation(
                snapshot: snapshot(sequence: 4, digest: "accepted", terminal: true),
                contentUpdatedAt: Date(timeIntervalSince1970: 42),
                observedAt: Date(timeIntervalSince1970: 43)
            )
        )

        let convergence = try await coordinator.recordObservedSystemConvergenceSuccess(
            for: envelope,
            expected: applied
        )
        XCTAssertTrue(convergence)
        let receipts = try await coordinator.pendingReceivedEventIDs(limit: 10)
        XCTAssertEqual(receipts, [envelope.eventID])
    }

    func testOrdinaryResponsePolicyCoversApprovalYesNoAndText() {
        XCTAssertTrue(NotificationResponsePolicy.supports(.approve, kind: .approval))
        XCTAssertTrue(NotificationResponsePolicy.supports(.no, kind: .yesNo))
        XCTAssertTrue(NotificationResponsePolicy.supports(.answer, kind: .text))
        XCTAssertFalse(NotificationResponsePolicy.supports(.yes, kind: .approval))
        XCTAssertEqual(NotificationResponsePolicy.canonicalState(for: .answer), "replied")
        XCTAssertNil(NotificationResponsePolicy.canonicalState(for: .received))
    }

    private func item(
        eventID: String,
        operation: LiveActivityCommand.Operation,
        sequence: Int,
        generation: Int = 1,
        alertOwner: NotificationAlertOwner = .none
    ) -> InboxItem {
        InboxItem(
            id: eventID,
            kind: .liveActivity,
            sourceName: "Codex",
            title: "Build",
            createdAt: Date(timeIntervalSince1970: TimeInterval(sequence)),
            liveActivity: LiveActivityCommand(
                operation: operation,
                activityId: "act_test123456",
                generation: generation,
                targetDeviceId: "dev_test123456",
                style: "terminal",
                sourceName: "Codex",
                headline: "Build",
                status: "Running",
                alertOwner: alertOwner,
                sequence: sequence
            )
        )
    }

    private func assertJournalKillBoundaries(
        operation: LiveActivityCommand.Operation,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relo-journal-\(operation.rawValue)-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let expected = snapshot(
            sequence: 2,
            digest: "\(operation.rawValue)-desired",
            terminal: operation == .end
        )
        let prior = operation == .start
            ? nil
            : snapshot(sequence: 1, digest: "\(operation.rawValue)-prior")

        // Production boundary: the orchestrator has durably marked invocationStarted, then its
        // ActivityKit closure terminates before performing the system side effect.
        do {
            let context = try await journalTestContext(
                operation: operation,
                suffix: "before-call",
                directory: directory
            )
            let system = SimulatedLiveActivitySystem(snapshot: prior)
            let first = await LiveActivityApplicationOrchestrator.apply(
                coordinator: context.coordinator,
                envelope: context.envelope,
                expected: expected,
                priorActive: prior,
                observed: await system.currentSnapshot()
            ) {
                try await system.terminateBeforeSideEffect()
            }
            XCTAssertEqual(first, .failed, file: file, line: line)
            if operation == .end {
                await system.replaceSnapshot(nil)
            }

            let relaunched = try await relaunchedCoordinator(store: context.store)
            let retry = await LiveActivityApplicationOrchestrator.apply(
                coordinator: relaunched,
                envelope: context.envelope,
                expected: expected,
                priorActive: prior,
                observed: await system.currentSnapshot()
            ) {
                await system.apply(expected)
            }
            let receipts = try await relaunched.pendingReceivedEventIDs(limit: 25)
            let pending = try await relaunched.pending(items: [context.event], targetDeviceID: "dev_test123456")
            let invocationCount = await system.invocationCount()
            if operation == .end {
                XCTAssertEqual(retry, .failed, file: file, line: line)
                XCTAssertTrue(receipts.isEmpty, file: file, line: line)
                XCTAssertEqual(pending.count, 1, file: file, line: line)
                XCTAssertEqual(invocationCount, 1, file: file, line: line)
            } else {
                XCTAssertEqual(retry, .applied, file: file, line: line)
                XCTAssertEqual(receipts, [context.event.id], file: file, line: line)
                XCTAssertEqual(invocationCount, 2, file: file, line: line)
            }
        }

        // ActivityKit side effect is visible, but the process terminates before durable receipt.
        do {
            let context = try await journalTestContext(
                operation: operation,
                suffix: "after-call",
                directory: directory
            )
            let system = SimulatedLiveActivitySystem(snapshot: prior)
            let first = await LiveActivityApplicationOrchestrator.apply(
                coordinator: context.coordinator,
                envelope: context.envelope,
                expected: expected,
                priorActive: prior,
                observed: await system.currentSnapshot()
            ) {
                try await system.applyThenTerminate(expected)
            }
            XCTAssertEqual(first, .failed, file: file, line: line)

            let relaunched = try await relaunchedCoordinator(store: context.store)
            let converged = await LiveActivityApplicationOrchestrator.apply(
                coordinator: relaunched,
                envelope: context.envelope,
                expected: expected,
                priorActive: prior,
                observed: await system.currentSnapshot()
            ) {
                XCTFail("Exact system state must converge without a second mutation", file: file, line: line)
            }
            let receipts = try await relaunched.pendingReceivedEventIDs(limit: 25)
            let invocationCount = await system.invocationCount()
            XCTAssertEqual(converged, .applied, file: file, line: line)
            XCTAssertEqual(receipts, [context.event.id], file: file, line: line)
            XCTAssertEqual(invocationCount, 1, file: file, line: line)
        }

        // Receipt is durable, command acknowledgement is not. Relaunch reuses that success and
        // does not recreate a receipt row that was already flushed.
        do {
            let context = try await journalTestContext(
                operation: operation,
                suffix: "after-receipt",
                directory: directory
            )
            let system = SimulatedLiveActivitySystem(snapshot: prior)
            let applied = await LiveActivityApplicationOrchestrator.apply(
                coordinator: context.coordinator,
                envelope: context.envelope,
                expected: expected,
                priorActive: prior,
                observed: await system.currentSnapshot()
            ) {
                await system.apply(expected)
            }
            XCTAssertEqual(applied, .applied, file: file, line: line)
            try await context.coordinator.removeReceivedEventIDs([context.event.id])

            let relaunched = try await relaunchedCoordinator(store: context.store)
            let reused = await LiveActivityApplicationOrchestrator.apply(
                coordinator: relaunched,
                envelope: context.envelope,
                expected: expected,
                priorActive: prior,
                observed: await system.currentSnapshot()
            ) {
                XCTFail("A receiptRecorded journal must not mutate ActivityKit again", file: file, line: line)
            }
            let recreatedReceipts = try await relaunched.pendingReceivedEventIDs(limit: 25)
            XCTAssertEqual(reused, .applied, file: file, line: line)
            XCTAssertTrue(recreatedReceipts.isEmpty)
            try await relaunched.acknowledge(context.envelope)
            let remaining = try await relaunched.pending(
                items: [context.event],
                targetDeviceID: "dev_test123456"
            )
            XCTAssertTrue(remaining.isEmpty)
        }
    }

    private func journalTestContext(
        operation: LiveActivityCommand.Operation,
        suffix: String,
        directory: URL
    ) async throws -> (
        store: AccountScopedProtectedActionStore,
        coordinator: LiveActivityCommandCoordinator,
        event: InboxItem,
        envelope: LiveActivityCommandEnvelope
    ) {
        let store = AccountScopedProtectedActionStore(
            baseDirectory: directory.appendingPathComponent(suffix, isDirectory: true)
        )
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        let event = item(
            eventID: "evt_\(operation.rawValue)-\(suffix)",
            operation: operation,
            sequence: 2
        )
        return (
            store,
            coordinator,
            event,
            LiveActivityCommandEnvelope(
                eventID: event.id,
                createdAt: event.createdAt,
                command: try XCTUnwrap(event.liveActivity)
            )
        )
    }

    private func relaunchedCoordinator(
        store: AccountScopedProtectedActionStore
    ) async throws -> LiveActivityCommandCoordinator {
        let coordinator = LiveActivityCommandCoordinator(store: store)
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        return coordinator
    }

    private func snapshot(
        sequence: Int,
        digest: String,
        terminal: Bool = false,
        generation: Int = 1
    ) -> LiveActivitySystemSnapshot {
        LiveActivitySystemSnapshot(
            activityID: "act_test123456",
            generation: generation,
            sequence: sequence,
            contentDigest: digest,
            isTerminal: terminal
        )
    }

    private func response(
        action: NotificationInteractionAction,
        idempotencyKey: String,
        expiresAt: Date = .now.addingTimeInterval(600),
        notificationID: String = "ntf_test123456"
    ) -> PendingNotificationResponse {
        PendingNotificationResponse(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: notificationID,
            action: action,
            value: [:],
            idempotencyKey: idempotencyKey,
            expiresAt: expiresAt
        )
    }

    private func widgetPresentation(
        _ interaction: LiveActivityContentInteraction,
        now: Date
    ) -> LiveActivityResponseWidgetPresentation {
        LiveActivityResponseWidgetPresentation.make(
            interaction: interaction,
            primary: "Yes",
            secondary: "No",
            now: now
        )
    }

    private func liveActivityResponse(
        action: NotificationInteractionAction,
        generation: Int = 1,
        credential: String = "credential-value-that-is-long-enough"
    ) -> PendingNotificationResponse {
        PendingNotificationResponse.liveActivity(
            accountID: "acc_test123456",
            deviceID: "dev_test123456",
            notificationID: "ntf_test123456",
            activityID: "act_test123456",
            activityGeneration: generation,
            interactionID: "int_test123456",
            action: action,
            credential: credential,
            expiresAt: .now.addingTimeInterval(600)
        )
    }

    private func baseItem(destination: URL?) -> InboxItem {
        InboxItem(
            id: "ntf_test123456",
            kind: .notification,
            sourceName: "Codex",
            title: "Done",
            createdAt: .now,
            destinationUrl: destination
        )
    }

    private func interactionItem(
        id: String,
        state: InboxInteraction.State,
        expiresAt: Date
    ) -> InboxItem {
        InboxItem(
            id: id,
            kind: .notification,
            sourceName: "Codex",
            title: "Continue?",
            createdAt: expiresAt.addingTimeInterval(-60),
            interaction: InboxInteraction(
                id: "int_\(id)",
                kind: .approval,
                prompt: "Continue?",
                state: state,
                expiresAt: expiresAt
            )
        )
    }
}

private struct SimulatedProcessTermination: Error {}

private actor SimulatedLiveActivitySystem {
    private var snapshot: LiveActivitySystemSnapshot?
    private var invocations = 0

    init(snapshot: LiveActivitySystemSnapshot?) {
        self.snapshot = snapshot
    }

    func currentSnapshot() -> LiveActivitySystemSnapshot? { snapshot }
    func invocationCount() -> Int { invocations }
    func replaceSnapshot(_ replacement: LiveActivitySystemSnapshot?) { snapshot = replacement }

    func terminateBeforeSideEffect() throws {
        invocations += 1
        throw SimulatedProcessTermination()
    }

    func applyThenTerminate(_ replacement: LiveActivitySystemSnapshot) throws {
        invocations += 1
        snapshot = replacement
        throw SimulatedProcessTermination()
    }

    func removeThenTerminate() throws {
        invocations += 1
        snapshot = nil
        throw SimulatedProcessTermination()
    }

    func apply(_ replacement: LiveActivitySystemSnapshot) {
        invocations += 1
        snapshot = replacement
    }
}

private actor RecordingAccountNotificationCleaner: AccountNotificationClearing {
    private(set) var callCount = 0

    func clearAllDeliveredAndPendingNotifications() async throws {
        callCount += 1
    }
}
