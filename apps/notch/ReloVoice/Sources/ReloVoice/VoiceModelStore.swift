import CryptoKit
import Foundation
import Network
import Observation

/// The Relo voice's files: one pinned Hugging Face revision, each file checked against its SHA-256, so what
/// runs is what was reviewed. Downloaded by the app itself into its own Application Support, on its own when the
/// network is not metered, or when the owner asks.
public struct VoiceModel: Sendable {
    public struct File: Sendable {
        public var name: String
        public var bytes: Int64
        public var sha256: String
    }

    public var id: String
    public var repo: String
    public var revision: String
    public var files: [File]

    public var bytes: Int64 { files.reduce(0) { $0 + $1.bytes } }

    public static let phonon31mEn = VoiceModel(
        id: "phonon-31m-en",
        repo: "gradium/phonon-31m-en",
        revision: "541f5752bc3c79583068bb205bfda5eb39aaa08a",
        files: [
            File(name: "config.json", bytes: 4_634,
                 sha256: "b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85"),
            File(name: "tokenizer.model", bytes: 65_045,
                 sha256: "82e4572006d64d483317074c22c368e87779640b6f3a9dcd07b7caae32b030ce"),
            File(name: "default-voice.safetensors", bytes: 256_136,
                 sha256: "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18"),
            File(name: "model.safetensors", bytes: 102_823_920,
                 sha256: "8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607")
        ])

    func url(_ file: File) -> URL {
        URL(string: "https://huggingface.co/\(repo)/resolve/\(revision)/\(file.name)")!
    }
}

@MainActor
@Observable
public final class VoiceModelStore {
    public enum State: Equatable, Sendable {
        case missing
        case downloading(Double)
        case ready
        case failed(String)
    }

    public let model: VoiceModel
    public let directory: URL
    /// Picked speakers' files (`PhononVoice`), apart from the model's so a new model revision keeps them.
    public let voicesDirectory: URL
    public private(set) var state: State = .missing
    /// Waiting for a network that is not metered (no hotspot, no Low Data Mode) to download on its own.
    public private(set) var waitingForNetwork = false
    /// Called once the files are in place.
    @ObservationIgnored public var onReady: (@MainActor () -> Void)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var monitor: NWPathMonitor?

    public init(model: VoiceModel = .phonon31mEn, root: URL? = nil) {
        self.model = model
        let base = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Voices", isDirectory: true)
        directory = base.appendingPathComponent("\(model.id)-\(model.revision.prefix(12))", isDirectory: true)
        voicesDirectory = base.appendingPathComponent("phonon-voices-\(PhononVoice.revision.prefix(12))", isDirectory: true)
        state = isComplete ? .ready : .missing
    }

    /// Every pinned file is in place (each was verified before it was moved there).
    public var isComplete: Bool {
        model.files.allSatisfy { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.name).path) }
    }

    /// Downloads once the network is not metered; a cellular hotspot or Low Data Mode waits for a better one.
    public func downloadWhenUnmetered() {
        guard monitor == nil, task == nil, state != .ready else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied, !path.isExpensive, !path.isConstrained else { return }
            Task { @MainActor [weak self] in
                guard let self, self.monitor != nil else { return }
                self.stopWaiting()
                self.download()
            }
        }
        self.monitor = monitor
        waitingForNetwork = true
        monitor.start(queue: .global(qos: .utility))
    }

    private func stopWaiting() {
        monitor?.cancel()
        monitor = nil
        waitingForNetwork = false
    }

    public func download() {
        stopWaiting()
        guard task == nil, state != .ready else { return }
        state = .downloading(0)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.fetchAll()
                self.state = .ready
                self.onReady?()
            } catch is CancellationError {
                self.state = .missing
            } catch {
                self.state = .failed(error.localizedDescription)
            }
            self.task = nil
        }
    }

    public func cancel() { task?.cancel() }

    public func delete() {
        stopWaiting()
        task?.cancel()
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.removeItem(at: voicesDirectory)
        state = .missing
    }

    public func file(for voice: PhononVoice) -> URL {
        voicesDirectory.appendingPathComponent("\(voice.id).safetensors")
    }

    public func has(_ voice: PhononVoice) -> Bool { FileManager.default.fileExists(atPath: file(for: voice).path) }

    /// A speaker's file, fetched and checked when it is not here yet (256 KB, so on any network).
    public func fetch(_ voice: PhononVoice) async throws -> URL {
        let target = file(for: voice)
        guard !has(voice) else { return target }
        try FileManager.default.createDirectory(at: voicesDirectory, withIntermediateDirectories: true)
        try await Self.fetchVerified(voice.url, sha256: voice.sha256, name: voice.name, to: target)
        return target
    }

    private func fetchAll() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let total = Double(model.bytes)
        var done: Int64 = 0
        for file in model.files {
            let target = directory.appendingPathComponent(file.name)
            if !FileManager.default.fileExists(atPath: target.path) {
                try await Self.fetchVerified(model.url(file), sha256: file.sha256, name: file.name, to: target)
            }
            done += file.bytes
            state = .downloading(Double(done) / total)
        }
    }

    private static func fetchVerified(_ url: URL, sha256: String, name: String, to target: URL) async throws {
        let (temporary, response) = try await URLSession.shared.download(from: url)
        try Task.checkCancellation()
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw StoreError.download(name) }
        guard try Self.sha256(of: temporary) == sha256 else {
            try? FileManager.default.removeItem(at: temporary)
            throw StoreError.checksum(name)
        }
        // Two fetches of one speaker may race: the second finds the file in place.
        if FileManager.default.fileExists(atPath: target.path) { try? FileManager.default.removeItem(at: temporary); return }
        try FileManager.default.moveItem(at: temporary, to: target)
    }

    nonisolated static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    enum StoreError: Error, LocalizedError {
        case download(String), checksum(String)
        var errorDescription: String? {
            switch self {
            case .download(let name): "Could not download \(name)"
            case .checksum(let name): "\(name) did not match its checksum"
            }
        }
    }
}
