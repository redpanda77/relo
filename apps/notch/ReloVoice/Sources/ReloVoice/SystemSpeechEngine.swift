import AVFoundation
import Foundation

/// The Mac's own voice: nothing to download, so the play button works before the Relo voice is in place,
/// and when it fails to load.
public final class SystemSpeechEngine: SpeechEngine {
    public init() {}

    public func render(_ text: String) async throws -> SpokenClip {
        let collector = Collector()
        return try await withCheckedThrowingContinuation { continuation in
            collector.render(text) { continuation.resume(with: $0) }
        }
    }

    public func unload() async {}

    /// Holds the synthesizer until its last buffer arrives; `write` delivers on its own queue.
    private final class Collector: @unchecked Sendable {
        private let synthesizer = AVSpeechSynthesizer()
        private var samples: [Float] = []
        private var sampleRate: Double = 22_050
        private var finished = false

        func render(_ text: String, done: @escaping @Sendable (Result<SpokenClip, Error>) -> Void) {
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
            synthesizer.write(utterance) { [self] buffer in
                guard !finished, let pcm = buffer as? AVAudioPCMBuffer else { return }
                // An empty buffer ends the utterance.
                guard pcm.frameLength > 0 else {
                    finished = true
                    done(samples.isEmpty ? .failure(SpeechEngineError.silent)
                                         : .success(SpokenClip(samples: samples, sampleRate: sampleRate)))
                    return
                }
                sampleRate = pcm.format.sampleRate
                let count = Int(pcm.frameLength)
                if let floats = pcm.floatChannelData?[0] {
                    samples.append(contentsOf: UnsafeBufferPointer(start: floats, count: count))
                } else if let ints = pcm.int16ChannelData?[0] {
                    samples.append(contentsOf: UnsafeBufferPointer(start: ints, count: count).map { Float($0) / 32_768 })
                }
            }
        }
    }
}
