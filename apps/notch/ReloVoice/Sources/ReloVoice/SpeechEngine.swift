import Foundation

/// One rendered line: mono samples at `sampleRate`, kept in memory only (a clip is the plaintext of a sealed card).
public struct SpokenClip: Sendable {
    public var samples: [Float]
    public var sampleRate: Double

    public init(samples: [Float], sampleRate: Double) {
        self.samples = samples
        self.sampleRate = sampleRate
    }

    public var duration: TimeInterval { sampleRate > 0 ? Double(samples.count) / sampleRate : 0 }
}

/// A voice that turns a line into a clip. Engines are swappable: the app asks for a clip and plays it, so a
/// different model (or a helper process) replaces one engine without touching the player or the cards.
public protocol SpeechEngine: Sendable {
    func render(_ text: String) async throws -> SpokenClip
    /// Frees what the engine holds (a model, GPU buffers); the next render loads again.
    func unload() async
}

public enum SpeechEngineError: Error, LocalizedError {
    case modelMissing
    case silent

    public var errorDescription: String? {
        switch self {
        case .modelMissing: "The Relo voice is not downloaded"
        case .silent: "The voice produced no audio"
        }
    }
}
