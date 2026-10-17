import SwiftUI
import UniformTypeIdentifiers
import ReloCore

struct DiagnosticsView: View {
    @Bindable var model: AppModel
    @State private var snapshot: DiagnosticSnapshot?
    @State private var export: DiagnosticExport?
    @State private var exporting = false
    @State private var exportFailed = false

    var body: some View {
        List {
            Section("Recovery") {
                ForEach(model.recoveryQueues) { queue in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(queue.operation.label).font(.headline)
                        Text(queue.depth == 0 && queue.status == .pending ? "Nothing waiting at last check" : queue.status.explanation).font(.subheadline)
                        if let depth = queue.depth {
                            Text("\(depth) pending").font(.caption).foregroundStyle(.secondary)
                        }
                        if queue.depth == nil && queue.operation != .currentSync {
                            Text("Queue count unavailable").font(.caption).foregroundStyle(.secondary)
                        }
                        if let date = queue.lastConfirmedAt {
                            Text("Last confirmed \(date.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section {
                if let checked = model.diagnosticQueuesCheckedAt {
                    Text("Queue counts checked \(checked.formatted(date: .omitted, time: .shortened)). Pull to refresh.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("A saved response is waiting for server confirmation. Apple accepting a push does not confirm that it appeared on this iPhone.")
                    .font(.footnote).foregroundStyle(.secondary)
                if snapshot?.persistenceUnavailable == true {
                    Text("Diagnostic history could not be saved. Unlock this iPhone and try again. Current actions can still continue.")
                }
                Button("Export diagnostics", systemImage: "square.and.arrow.up") {
                    Task { await prepareExport() }
                }
                Text("Contains operation states and timings only. No notification content, reply text, credentials, names, or server addresses. Nothing is uploaded automatically.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Recent operations") {
                if let snapshot {
                    if snapshot.events.isEmpty { Text("No recorded operations yet.").foregroundStyle(.secondary) }
                    ForEach(Array(snapshot.events.suffix(50).reversed())) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.operation.label).font(.headline)
                            Text(RecoveryStatus(outcome: event.outcome).explanation).font(.subheadline)
                            Text(event.timestamp, format: .dateTime.hour().minute().second())
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text("\(snapshot.events.count) of \(snapshot.capacity) diagnostic events retained")
                        .font(.caption).foregroundStyle(.secondary)
                } else { ProgressView("Loading diagnostics") }
            }
        }
        .reloGroupedScreen()
        .navigationTitle("Recovery & diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.refreshDiagnosticQueues(); snapshot = await model.diagnostics.snapshot() }
        .refreshable { await model.refreshDiagnosticQueues(); snapshot = await model.diagnostics.snapshot() }
        .fileExporter(isPresented: $exporting, document: export, contentType: .json,
                      defaultFilename: "relo-diagnostics") { result in
            if case .failure = result { exportFailed = true }
        }
        .reloConfirmation(isPresented: $exportFailed) {
            ReloConfirmSpec(
                title: "Export unavailable",
                message: "The diagnostic file could not be saved. Your responses and current state are unchanged.",
                actionTitle: "OK", destructive: false, cancelTitle: nil, action: {})
        }
    }

    private func prepareExport() async {
        let captured = await model.diagnostics.snapshot()
        snapshot = captured
        do {
            let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
            export = DiagnosticExport(data: try encoder.encode(captured)); exporting = true
        } catch { exportFailed = true }
    }
}

private struct DiagnosticExport: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private extension OperationDiagnostic.Operation {
    var label: String {
        switch self {
        case .currentSync: "Current state"
        case .responseSubmission: "Responses"
        case .readReplay: "Read status"
        case .receiptUpload: "Delivery receipts"
        case .tokenRegistration: "Push registration"
        }
    }
}

private extension RecoveryStatus {
    var explanation: String {
        switch self {
        case .pending: "Waiting for confirmation"
        case .pausedForAuth: "Reconnect this iPhone to continue"
        case .pausedForStorage: "Unlock this iPhone to access protected storage"
        case .retrying: "Waiting for a connection; saved work will retry"
        case .confirmed: "Confirmed by the server"
        case .notSentExpired: "Request expired; response is not confirmed"
        case .notSentReplaced: "Request replaced; no response applies to the newer request"
        case .failed: "Needs attention; last confirmed state is preserved"
        }
    }
}
