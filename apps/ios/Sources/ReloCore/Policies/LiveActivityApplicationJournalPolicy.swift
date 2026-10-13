import Foundation

public enum LiveActivityApplicationJournalPolicy {
    /// A journal is created only when the initial observation requires an ActivityKit mutation.
    /// On relaunch, matching start/update content or matching terminal end content proves
    /// convergence. Absence never proves an end succeeded: the disk write immediately before
    /// ActivityKit invocation cannot be atomic with the system call, so that state fails closed.
    public static func reconcile(
        _ journal: LiveActivityApplicationJournalEntry,
        observed: LiveActivitySystemSnapshot?
    ) -> LiveActivityJournalReconciliation {
        if journal.phase == .receiptRecorded {
            return .recordOrReuseReceipt
        }

        switch journal.operation {
        case .start, .update:
            if observed == journal.expected {
                return .recordOrReuseReceipt
            }
            if let observed,
               observed.identity == journal.expected.identity,
               observed.sequence > journal.expected.sequence {
                return .finishWithoutReceipt
            }
            return .apply

        case .end:
            guard journal.priorActive != nil else { return .indeterminate }
            guard let observed else { return .indeterminate }
            if observed.isTerminal {
                return observed == journal.expected
                    ? .recordOrReuseReceipt
                    : .indeterminate
            }
            if observed.identity != journal.expected.identity
                || observed.sequence > journal.expected.sequence {
                return .finishWithoutReceipt
            }
            return .apply
        }
    }
}
