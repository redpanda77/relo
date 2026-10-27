import AVFoundation
import Foundation
import Observation

/// What the app talks to: speak a card's line, stop, and which line is playing. One line at a time; a clip is
/// rendered once per line and kept in memory for replay (never on disk), the oldest dropped past `cacheSize`.
@MainActor
@Observable
public final class ReloVoice {
    public enum Engine: String, CaseIterable, Sendable {
        /// Phonon once downloaded; the system voice until then.
        case relo
        case system
    }

    public enum Phase: Equatable, Sendable {
        case preparing(String)
        case playing(String)
    }

    public let models: VoiceModelStore
    public var engine: Engine = .relo
    /// Who the Relo voice speaks as: `PhononVoice.defaultID` or a catalog voice's id. A changed speaker renders
    /// every line again.
    public var speaker: String = PhononVoice.defaultID {
        didSet {
            guard speaker != oldValue else { return }
            clips.removeAll()
            order.removeAll()
            speakerProblem = nil
        }
    }
    /// The speaker whose file is being fetched, and why the last fetch failed.
    public private(set) var fetchingSpeaker: String?
    public private(set) var speakerProblem: String?
    public private(set) var phase: Phase?
    public private(set) var lastError: String?

    @ObservationIgnored private let phonon: PhononEngine
    @ObservationIgnored private let system = SystemSpeechEngine()
    @ObservationIgnored private var clips: [String: SpokenClip] = [:]
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private let cacheSize = 16
    @ObservationIgnored private var job: Task<Void, Never>?
    @ObservationIgnored private let audio = AVAudioEngine()
    @ObservationIgnored private let player = AVAudioPlayerNode()
    @ObservationIgnored private var playback = 0

    public init(models: VoiceModelStore = VoiceModelStore()) {
        self.models = models
        phonon = PhononEngine(modelDirectory: models.directory)
        audio.attach(player)
        models.onReady = { [weak self] in self?.prewarm() }
    }

    /// At launch: fetch the Relo voice when it is missing (on an unmetered network), else warm it once.
    public func start() {
        if models.state == .ready { prewarm() } else { models.downloadWhenUnmetered() }
        fetchSpeaker()
    }

    /// Picks who speaks and says the preview in that voice once its file is here.
    public func choose(speaker id: String) {
        speaker = id
        fetchSpeaker { [weak self] in self?.preview() }
    }

    /// Fetches the speaker's file when it is missing; until then lines use the default voice.
    private func fetchSpeaker(then done: (@MainActor () -> Void)? = nil) {
        let id = speaker
        guard let voice = PhononVoice.named(id), !models.has(voice) else { done?(); return }
        guard fetchingSpeaker != id else { return }
        fetchingSpeaker = id
        let models = models
        Task { [weak self] in
            do {
                _ = try await models.fetch(voice)
                guard let self else { return }
                if self.fetchingSpeaker == id { self.fetchingSpeaker = nil }
                if self.speaker == id { done?() }
            } catch {
                guard let self else { return }
                if self.fetchingSpeaker == id { self.fetchingSpeaker = nil }
                if self.speaker == id { self.speakerProblem = "Could not download \(voice.name)'s voice" }
            }
        }
    }

    /// The Phonon voice argument: the speaker's file once it is here, else the default.
    private var speakerVoice: String {
        guard let voice = PhononVoice.named(speaker), models.has(voice) else { return PhononVoice.defaultID }
        return models.file(for: voice).path
    }

    /// `id` names the line (a card and what it says), so a changed card renders again.
    public func isActive(_ id: String) -> Bool {
        switch phase {
        case .preparing(let current), .playing(let current): current == id
        case nil: false
        }
    }

    public func toggle(id: String, text: String) {
        if isActive(id) { stop() } else { speak(id: id, text: text) }
    }

    public func speak(id: String, text: String) {
        stop()
        lastError = nil
        phase = .preparing(id)
        job = Task { [weak self] in
            guard let self else { return }
            do {
                let clip = try await self.clip(id: id, text: text)
                try Task.checkCancellation()
                try self.play(clip, id: id)
            } catch is CancellationError {
            } catch {
                self.lastError = error.localizedDescription
                if self.isActive(id) { self.phase = nil }
            }
        }
    }

    public func stop() {
        job?.cancel()
        job = nil
        playback += 1
        player.stop()
        // An interrupted line never reaches its completion, which is what pauses the engine: do it here, or its I/O
        // thread keeps running. `play` starts it again when it is not running.
        audio.pause()
        phase = nil
    }

    /// Deletes the Relo voice's files and frees the model if it is loaded.
    public func deleteModel() {
        stop()
        clips.removeAll()
        order.removeAll()
        let phonon = phonon
        Task { await phonon.unload() }
        models.delete()
    }

    /// Settings' preview: always rendered fresh, never cached.
    public func preview() {
        let name = PhononVoice.named(speaker)?.name
        let intro = engine == .relo && name != nil ? "This is \(name!), the Relo voice." : "This is the Relo voice."
        speak(id: "preview-\(UUID().uuidString)", text: "\(intro) Your deploy finished.")
    }

    /// After an install or an update, the first render on this Mac sets up the GPU for a few seconds: do it
    /// once in the background so it never lands on a real line. The idle timeout frees the model after.
    public func prewarm() {
        guard engine == .relo, models.state == .ready else { return }
        let phonon = phonon
        Task.detached(priority: .utility) { _ = try? await phonon.render("Ready.") }
    }

    private func clip(id: String, text: String) async throws -> SpokenClip {
        if let clip = clips[id] { return clip }
        let clip: SpokenClip
        if engine == .relo, models.state == .ready {
            do {
                clip = try await phonon.render(text, voice: speakerVoice)
            } catch {
                // The Relo voice failed to load or render: the line is still said.
                clip = try await system.render(text)
            }
        } else {
            clip = try await system.render(text)
        }
        if !id.hasPrefix("preview-") { remember(clip, id: id) }
        return clip
    }

    private func remember(_ clip: SpokenClip, id: String) {
        clips[id] = clip
        order.removeAll { $0 == id }
        order.append(id)
        while order.count > cacheSize { clips[order.removeFirst()] = nil }
    }

    private func play(_ clip: SpokenClip, id: String) throws {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: clip.sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(clip.samples.count))
        else { throw SpeechEngineError.silent }
        buffer.frameLength = buffer.frameCapacity
        clip.samples.withUnsafeBufferPointer { source in
            buffer.floatChannelData![0].update(from: source.baseAddress!, count: clip.samples.count)
        }
        audio.disconnectNodeOutput(player)
        audio.connect(player, to: audio.mainMixerNode, format: format)
        if !audio.isRunning { try audio.start() }
        playback += 1
        let token = playback
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.playback == token else { return }
                self.phase = nil
                self.audio.pause()
            }
        }
        player.play()
        phase = .playing(id)
    }
}
