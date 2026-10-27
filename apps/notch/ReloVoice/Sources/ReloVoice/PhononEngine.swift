import Foundation
import MLX
import MLXAudioCore
import MLXAudioTTS

/// Phonon 31M on the GPU. Loaded when a line needs it (about 40 ms from disk), kept while lines keep coming, and
/// unloaded after `idleTimeout` or on memory pressure: staying warm would hold about 180 MB for nothing the
/// owner can hear.
public actor PhononEngine: SpeechEngine {
    private let modelDirectory: URL
    private let idleTimeout: Duration
    private var model: PocketTTSModel?
    private var idleTask: Task<Void, Never>?
    private var pressure: DispatchSourceMemoryPressure?

    public init(modelDirectory: URL, idleTimeout: Duration = .seconds(300)) {
        self.modelDirectory = modelDirectory
        self.idleTimeout = idleTimeout
    }

    public func render(_ text: String) async throws -> SpokenClip { try await render(text, voice: "default") }

    /// `voice` is "default" (the voice that ships with the model) or a voice file's absolute path.
    public func render(_ text: String, voice: String) async throws -> SpokenClip {
        let model = try await loaded()
        idleTask?.cancel()
        defer { scheduleUnload() }
        let audio = try await model.generate(
            text: text, voice: voice, refAudio: nil, refText: nil, language: nil,
            generationParameters: model.defaultGenerationParameters)
        let samples = audio.asArray(Float.self)
        // MLX keeps freed buffers for reuse; between lines that is only memory held.
        Memory.clearCache()
        guard !samples.isEmpty else { throw SpeechEngineError.silent }
        return SpokenClip(samples: samples, sampleRate: Double(model.sampleRate))
    }

    public func unload() {
        idleTask?.cancel()
        idleTask = nil
        model = nil
        Memory.clearCache()
    }

    private func loaded() async throws -> PocketTTSModel {
        if let model { return model }
        guard FileManager.default.fileExists(atPath: modelDirectory.appendingPathComponent("model.safetensors").path) else {
            throw SpeechEngineError.modelMissing
        }
        // A small reuse cache: one line's buffers, not the default's fraction of all memory.
        Memory.cacheLimit = 64 * 1024 * 1024
        let model = try await PocketTTSModel.fromModelDirectory(modelDirectory)
        self.model = model
        watchMemoryPressure()
        return model
    }

    private func scheduleUnload() {
        idleTask?.cancel()
        let timeout = idleTimeout
        idleTask = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            await self?.unload()
        }
    }

    private func watchMemoryPressure() {
        guard pressure == nil else { return }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .global(qos: .utility))
        source.setEventHandler { [weak self] in
            Task { await self?.unload() }
        }
        source.resume()
        pressure = source
    }
}
