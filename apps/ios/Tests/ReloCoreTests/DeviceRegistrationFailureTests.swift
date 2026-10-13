import Foundation
@testable import ReloCore
import Testing

@Suite("Device registration failures")
struct DeviceRegistrationFailureTests {
    @Test func accountProblemsChangeTheAccountAndNeverRetry() {
        let reauth = DeviceRegistrationPolicy.failure(for: MobileAPIError.reauthenticationRequired, at: .network)
        #expect(reauth.accountEffect == .reauthenticationRequired)
        #expect(reauth.retry == .none)
        #expect(reauth.message == "Sign in again to register this iPhone.")
        let disabled = DeviceRegistrationPolicy.failure(for: MobileAPIError.accountDisabled, at: .network)
        #expect(disabled.accountEffect == .disabled)
        #expect(disabled.retry == .none)
    }

    @Test func transientServerProblemsRetryOnTheirOwn() {
        for error in [MobileAPIError.tailnetUnavailable, .unavailable, .idempotencyConflict] {
            let failure = DeviceRegistrationPolicy.failure(for: error, at: .network)
            #expect(failure.retry == .scheduled(retryAfterSeconds: nil), "\(error)")
            #expect(failure.accountEffect == .none)
        }
        #expect(DeviceRegistrationPolicy.failure(for: MobileAPIError.idempotencyConflict, at: .network).advancesAttempt)
        #expect(!DeviceRegistrationPolicy.failure(for: MobileAPIError.unavailable, at: .network).advancesAttempt)
    }

    @Test func rateLimitsHonorRetryAfter() {
        let limited = DeviceRegistrationPolicy.failure(for: MobileAPIError.rateLimited(retryAfterSeconds: 30), at: .network)
        #expect(limited.retry == .scheduled(retryAfterSeconds: 30))
        #expect(limited.message.hasSuffix("Try again in 30 seconds."))
        let unknown = DeviceRegistrationPolicy.failure(for: MobileAPIError.rateLimited(retryAfterSeconds: nil), at: .network)
        #expect(unknown.retry == .scheduled(retryAfterSeconds: nil))
        #expect(unknown.message.hasSuffix("Try again shortly."))
    }

    @Test func rejectedRegistrationsWaitForTheOwner() {
        for error in [MobileAPIError.invalidRequest, .invalidResponse] {
            #expect(DeviceRegistrationPolicy.failure(for: error, at: .network).retry == .none, "\(error)")
        }
    }

    @Test func unexpectedErrorsAreExplainedByWhereTheyHappened() {
        struct Unexpected: Error {}
        #expect(DeviceRegistrationPolicy.failure(for: Unexpected(), at: .localRegistrationData).message
            == "The local device credential store is unreadable. Registration was not completed.")
        #expect(DeviceRegistrationPolicy.failure(for: Unexpected(), at: .credentialStore).retry == .none)
        #expect(DeviceRegistrationPolicy.failure(for: Unexpected(), at: .accountSessionStore).message
            == "The protected account session store is unreadable. Sign in again before registering.")
        let network = DeviceRegistrationPolicy.failure(for: Unexpected(), at: .network)
        #expect(network.message == "The registration server failed unexpectedly.")
        #expect(network.retry == .scheduled(retryAfterSeconds: nil))
    }
}
