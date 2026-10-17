#if DEBUG && RELO_FLOW_CAPTURE
import ReloCore
import SwiftUI

/// Capture only: the plan card on fixture plans (flat, nested, several rounds, long), for the visual check.
struct PlanFixtureGallery: View {
    let model: AppModel
    let variant: String

    private var item: InboxItem? { model.items.first { $0.id == "ntf_previewworking" } ?? model.items.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let item {
                    ForEach(Array(outlines.enumerated()), id: \.offset) { _, outline in
                        ReloMissionTimeline(
                            item: item, steps: [], outline: outline, progress: nil, status: "Working", now: .now,
                            serverOutcome: .init(label: "Running", color: .reloSignalIndigo, symbol: "waveform"))
                    }
                }
            }
            .padding(16)
        }
        .reloScreenBackground()
    }

    private func e(_ id: String, _ label: String, _ state: PlanOutline.State, parent: String? = nil, round: Int = 1,
                   mins: Double? = nil, readable: Bool = true) -> PlanOutline.Entry {
        let end = Date.now.addingTimeInterval(-600)
        return PlanOutline.Entry(id: id, label: label, state: state, parent: parent, round: round, readable: readable,
                                 startedAt: mins.map { end.addingTimeInterval(-$0 * 60) }, doneAt: mins == nil ? nil : end)
    }

    private var outlines: [PlanOutline] {
        switch variant {
        case "rounds": [rounds, longPlan]
        case "e2e": [endToEnd]
        default: [flat, nested]
        }
    }

    private var flat: PlanOutline {
        .make(entries: [e("a", "Reproduce the crash", .complete, mins: 4), e("b", "Find the cause", .complete, mins: 11),
                        e("c", "Patch token refresh with a label long enough that it has to wrap onto a second line", .current),
                        e("d", "Run the tests", .pending), e("e", "Ship", .pending)], rounds: nil)
    }

    /// The owner's end-to-end test card (16 October): ten phases, two steps under each, real full-length labels.
    private var endToEnd: PlanOutline {
        let phases: [(String, [String])] = [
            ("Check readiness of the CLI and the server", ["Run relo doctor and read every check", "Confirm auth on this server"]),
            ("Verify the work lifecycle from start to finish", ["Start a work with a plan of three steps", "Jump steps with --step and read the echo"]),
            ("Verify updates and the status line", ["Update with --status and a long sentence", "Read relo state output unfiltered"]),
            ("Verify ask approvals end to end", ["Approval ask: deploy to production", "Deny exits 5 and nothing runs"]),
            ("Verify deliver and rounds", ["Deliver the first round", "Start a second round"]),
            ("Verify handoff", ["Write a handoff note", "Pick it up in a fresh session"]),
            ("Verify notify", ["Notify with no open work", "Read the outcome on the phone"]),
            ("Verify the sealed card", ["Seal for the phone", "Open it on the phone"]),
            ("Verify hooks", ["Read the prompt-time context", "Read the stop reminder"]),
            ("Clean up the test cards", ["Finish every test work", "Check nothing is left open"]),
        ]
        var entries: [PlanOutline.Entry] = []
        for (index, phase) in phases.enumerated() {
            let id = "p\(index)"
            entries.append(e(id, phase.0, index == 0 ? .current : .pending))
            for (sub, label) in phase.1.enumerated() {
                entries.append(e("\(id)s\(sub)", label, index == 0 && sub == 0 ? .current : .pending, parent: id))
            }
        }
        return .make(entries: entries, rounds: nil)
    }

    private var nested: PlanOutline {
        .make(entries: [
            e("s1", "Audit the plan model", .complete, mins: 12),
            e("k1", "Read the contracts", .complete, parent: "s1"), e("k2", "Read the server", .complete, parent: "s1"),
            e("k3", "Read the CLI", .complete, parent: "s1"),
            e("s2", "Patch token refresh", .current),
            e("t1", "Write the failing test", .complete, parent: "s2", mins: 3),
            e("t2", "Fix the refresh race", .current, parent: "s2"), e("t3", "Cover the offline case", .pending, parent: "s2"),
            e("s3", "Run the tests", .pending),
            e("u1", "Unit tests", .pending, parent: "s3"), e("u2", "iOS tests", .pending, parent: "s3"),
            e("s4", "Ship", .pending), e("s5", "Fix what the check shows", .skipped),
            e("s6", "Step 6", .pending, readable: false)], rounds: nil)
    }

    private func closed(_ n: Int, _ title: String, _ outcome: String, mins: Double) -> InboxCardDigest.PlanRound {
        .init(n: n, closed: true, title: title, outcome: outcome,
              openedAt: .now.addingTimeInterval(-7200 * Double(7 - n)), closedAt: .now.addingTimeInterval(-7200 * Double(7 - n) + mins * 60))
    }

    private var rounds: PlanOutline {
        .make(entries: [
            e("r1a", "Reproduce the crash", .complete, mins: 14), e("r1b", "Patch and test", .complete, round: 1, mins: 60),
            e("r2a", "Share the refresh client", .complete, round: 2, mins: 25),
            e("r3a", "Map the offline paths", .complete, round: 3, mins: 4),
            e("r3b", "Queue refreshes while offline", .current, round: 3),
            e("r3b1", "Store the pending refresh", .current, parent: "r3b", round: 3),
            e("r3b2", "Replay on reconnect", .pending, parent: "r3b", round: 3),
            e("r3c", "Ship", .pending, round: 3)],
            rounds: [closed(1, "Fix the login crash", "Login fixed: token refresh patched and tested", mins: 120),
                     closed(2, "Expand to iOS", "iOS login uses the same refresh path", mins: 40),
                     .init(n: 3, closed: false, title: "Cover offline mode")])
    }

    private var longPlan: PlanOutline {
        var entries: [PlanOutline.Entry] = (1...7).map { e("m\($0)", "Backfill month \($0)", .complete, mins: 6) }
        entries += [e("m8", "Backfill month 8", .complete, mins: 5), e("m9", "Backfill month 9", .current),
                    e("m10", "Backfill month 10", .pending), e("m11", "Backfill month 11", .pending),
                    e("m12", "Backfill month 12", .pending), e("x1", "Reconcile totals", .pending),
                    e("x2", "Email the finance team", .pending), e("x3", "Archive the old ledger", .pending),
                    e("x4", "Ship the report", .pending)]
        entries = entries.map { PlanOutline.Entry(id: $0.id, label: $0.label, state: $0.state, parent: nil, round: 6,
                                                  startedAt: $0.startedAt, doneAt: $0.doneAt) }
        let old = (1...5).map { e("o\($0)", "Old step \($0)", .complete, round: $0) }
        return .make(entries: old + entries, rounds: [
            closed(1, "Set up the billing queue", "Queue live; retries capped at five", mins: 60),
            closed(2, "Export the ledgers", "All ledgers exported to the new format", mins: 120),
            closed(3, "Find the missing invoices", "312 invoices missing between January and September", mins: 50),
            closed(4, "Plan the backfill", "Backfill month by month, oldest first", mins: 20),
            closed(5, "Migrate the billing exports", "Exports moved to the new queue; old jobs removed", mins: 180),
            .init(n: 6, closed: false, title: "Backfill the missing invoices")])
    }
}
#endif
