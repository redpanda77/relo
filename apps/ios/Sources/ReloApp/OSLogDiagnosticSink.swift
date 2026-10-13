import OSLog
import ReloCore

struct OSLogDiagnosticSink: DiagnosticStoring {
    let store: any DiagnosticStoring
    private let logger = Logger(subsystem: "relo.app", category: "recovery")
    func record(_ event: OperationDiagnostic) async {
        logger.info("\(event.redactedDescription, privacy: .public)")
        await store.record(event)
    }
    func snapshot() async -> DiagnosticSnapshot { await store.snapshot() }
}
