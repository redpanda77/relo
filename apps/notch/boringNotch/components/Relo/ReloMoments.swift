//
//  ReloMoments.swift
//  Relo
//
//  Relo for Mac's half of ADR 0013 (docs/adr/0013-sensory-language.md): the owner's moments, found once from the
//  store (not from a view, so they hold whatever the notch shows), each cued once by id with Relo's own sound set
//  (Resources/Sounds, rendered by scripts/sounds/render.sh). The closed notch's expansion follows `batch`.
//

import AppKit
import AVFoundation
import Defaults
import ReloNotchKit
import ReloVoice
import SwiftUI

/// Relo's sound set: one file per cue, the same files the iPhone app and the Dashboard play.
enum ReloCue: String, CaseIterable {
    case needsYou = "needs-you", yourTurn = "your-turn", done, failed, sent, linked, start, update
    case turn, open, close, expand, collapse, launch, quit, tab, section, on, off

    /// Interface sounds (the notch opening and closing, a card unfolding, a tab, a Settings section or switch,
    /// onboarding pages, the app launching and quitting) have their own switch.
    var isInterface: Bool { [.turn, .open, .close, .expand, .collapse, .launch, .quit, .tab, .section, .on, .off].contains(self) }
}

/// How sound and voice share an update (Settings › Voice). The voice is Relo's live TTS, never a rendered file.
enum ReloVoiceMode: String, CaseIterable {
    case soundOnly = "sound", soundThenVoice = "then", soundAsKind = "kind", voiceOnly = "voice"

    static var current: ReloVoiceMode { ReloVoiceMode(rawValue: Defaults[.reloVoiceMode]) ?? .soundOnly }
    /// Updates are said aloud.
    var speaks: Bool { self != .soundOnly }
}

@MainActor
final class ReloCuePlayer {
    static let shared = ReloCuePlayer()
    private var players: [ReloCue: AVAudioPlayer] = [:]
    private var lastPlayed: [ReloCue: Date] = [:]
    /// When the cue playing now ends: the voice waits for it (ADR 0015).
    private(set) var endsAt = Date.distantPast

    /// Plays `cue` when Relo's sounds (and, for interface sounds, their switch) are on; `force` is Settings' preview.
    func play(_ cue: ReloCue, force: Bool = false) {
        if !force {
            guard Defaults[.reloSounds] else { return }
            if cue.isInterface, !Defaults[.reloInterfaceSounds] { return }
        }
        // docs/SOUND.md: the same cue again within 400 ms plays once (a burst of tab clicks is one sound).
        if !force, Date().timeIntervalSince(lastPlayed[cue] ?? .distantPast) < 0.4 { return }
        lastPlayed[cue] = Date()
        guard let player = player(cue) else { return }
        // One volume for every cue: the files carry their tiers (docs/SOUND.md), as the owner approved them.
        player.volume = 0.6
        player.currentTime = 0
        // An output that has been quiet for a while (AirPods, a display's speakers) drops the first fraction of a second
        // while it wakes: a short cue vanished whole and only the voice after it was heard. After a quiet spell the cue
        // starts a moment late, once the output is awake, and the voice waits for that later end.
        let now = Date()
        let lead = now.timeIntervalSince(lastSound) > Self.wakeAfter ? Self.wakeLead : 0
        if lead > 0 { player.play(atTime: player.deviceCurrentTime + lead) } else { player.play() }
        lastSound = now.addingTimeInterval(lead + player.duration)
        endsAt = lastSound
    }

    /// When Relo last made a sound (a cue's end, or a line the voice said): the output stays awake a while after.
    private var lastSound = Date.distantPast
    /// Quiet longer than this, the output may be asleep; the cue then waits `wakeLead` for it.
    static let wakeAfter: TimeInterval = 8
    static let wakeLead: TimeInterval = 0.35

    /// The voice just spoke: the output is awake, so the next cue needs no wake-up wait.
    func noteSpoke(until end: Date = Date()) { lastSound = max(lastSound, end) }

    /// How long `cue` lasts (0 when it has no file): quitting waits for its sound.
    func duration(_ cue: ReloCue) -> TimeInterval { player(cue)?.duration ?? 0 }

    private func player(_ cue: ReloCue) -> AVAudioPlayer? {
        if let player = players[cue] { return player }
        guard let url = Bundle.main.url(forResource: cue.rawValue, withExtension: "caf")
                ?? Bundle.main.url(forResource: cue.rawValue, withExtension: "caf", subdirectory: "Sounds"),
              let player = try? AVAudioPlayer(contentsOf: url) else { return nil }
        player.prepareToPlay()
        players[cue] = player
        return player
    }
}

@MainActor
@Observable
final class ReloMoments {
    static let shared = ReloMoments()

    /// The latest new moments, most important first; `serial` changes with every batch.
    struct Batch: Equatable {
        var serial = 0
        var events: [NotchEvent] = []
    }

    private(set) var batch = Batch()
    /// New notices (`relo notify`) this Mac shows because no iPhone gets them; `serial` changes with every batch. A notice
    /// has no sound of its own: the notch opens a short line and the orb breathes until Relo's tab is opened.
    private(set) var notices = NoticeArrivals()

    /// The latest card that finished a plan step; `serial` changes with every one (the closed notch's step light).
    struct Stepped: Equatable {
        var serial = 0
        var rowID: String?
    }

    private(set) var stepped = Stepped()
    /// A moment arrived that the owner has not seen yet: the closed notch's orb breathes until Relo's tab opens.
    private(set) var unseen = false

    func markSeen() { if unseen { unseen = false } }

    @ObservationIgnored private let store = ReloNotch.store
    @ObservationIgnored private var previous: NotchPresentation?
    @ObservationIgnored private var cued = Set<String>()
    /// The previous summary's server time: changes with older evidence are not announced again (after wake or launch).
    @ObservationIgnored private var previousServerTime: Date?
    @ObservationIgnored private var lastCue = Date.distantPast
    @ObservationIgnored private var lastConnection: ReloNotchStore.Connection?
    @ObservationIgnored private var accepted = Set<String>()
    @ObservationIgnored private var started = false
    @ObservationIgnored private var wasWorking = false
    @ObservationIgnored private var wasStaged = false
    @ObservationIgnored private var speech = SpokenQueue()
    @ObservationIgnored private var speaking: Task<Void, Never>?
    /// When each card last said a finished step: at most one every 45 seconds per card, so progress never becomes chatter.
    @ObservationIgnored private var progressSaid: [String: Date] = [:]
    /// When each card last ticked for a finished step (the update cue).
    @ObservationIgnored private var stepTicked: [String: Date] = [:]

    /// The owner's spoken detail (Settings › Voice), the ceiling for every card's own level.
    private static var ownerDetail: SpokenLine.Detail { SpokenLine.Detail(name: Defaults[.reloVoiceDetail]) ?? .verbose }

    func start() {
        guard !started else { return }
        started = true
        receive()
        track()
    }

    private func track() {
        withObservationTracking {
            _ = store.presentation
            _ = store.connection
            _ = store.answers
            _ = store.noticeArrivals
            _ = store.resetGeneration
        } onChange: {
            Task { @MainActor [weak self] in
                self?.receive()
                self?.track()
            }
        }
    }

    /// The sign-out or refused credential the moments last saw: after one, nothing before it is compared again.
    @ObservationIgnored private var seenReset = 0

    private func receive() {
        if store.resetGeneration != seenReset {
            seenReset = store.resetGeneration
            previous = nil
            previousServerTime = nil
        }
        let working = store.presentation.machines.contains { $0.working > 0 }
        if working && !wasWorking { ReloNotch.usage.wake() }
        wasWorking = working
        signInMoment()
        answerMoment()
        noticeMoment()
        // Nothing fetched yet (launch, sign-in): the empty state is no baseline. The first real summary is, so what
        // already waits is shown but never cued or said again after a restart.
        // Relo for Mac's own onboarding is staged as a work (ReloOnboardingNotch): it has no server summary, but its
        // transitions are real moments. It starts from an empty notch, never from a baseline, and says nothing aloud.
        let staged = store.isStagingOnboarding
        defer { wasStaged = staged }
        guard store.summary != nil || staged else { previous = nil; return }
        let next = store.presentation
        // The staging ended: the server's own rows return silently, as at launch (they are not new).
        if wasStaged, !staged { previous = next; return }
        let baseline = previous == nil && !staged
        let before: NotchPresentation? = previous ?? (staged ? NotchPresentation.empty : nil)
        // Once per moment: a question still open, a card still done, never cue again (a reconnect, a remount). The
        // staged work repeats its moments (Your turn at every choice), so it is not deduplicated.
        var events = NotchEvent.between(before, next, summary: store.summary, previousServerTime: previousServerTime)
            .filter { staged || cued.insert($0.momentKey).inserted }
        if let time = store.summary?.serverTime { previousServerTime = time }
        if staged, let old = before?.focus, let row = next.focus, row.id == OnboardingStage.rowID,
           old.id == row.id, old.tone == .failed, row.tone == .working {
            events.append(NotchEvent(kind: .started, row: row))
        }
        if let before {
            if !staged { sayProgress(from: before, to: next) }
            stepMoment(from: before, to: next, staged: staged)
        }
        previous = next
        guard !events.isEmpty else { return }
        batch = Batch(serial: batch.serial + 1, events: events)
        if !baseline { unseen = true }
        // The first observation after launch is the baseline: what already waits shows, but makes no sound.
        guard !baseline else { return }
        let moments = events.filter { Self.cue(for: $0) != nil }
        guard let lead = moments.first else { return }
        // A line is being said: the cue waits and plays right before this update's own line, never on top of the voice.
        let busy = ReloNotch.voice.phase != nil || speaking != nil
        if staged { cue(lead, staged: true); return }
        if !(busy && say(moments, deferring: lead)) { cue(lead); say(moments) }
    }

    /// The ADR's table: dropped or left-unfinished work is silent; a card starting gets the quiet start cue.
    static func cue(for event: NotchEvent) -> ReloCue? {
        switch event.kind {
        case .question: .needsYou
        case .failed: event.row.tone == .failed ? .failed : nil
        case .yourTurn: .yourTurn
        case .finished: .done
        case .started: .start
        case .progressed: nil
        }
    }

    private func cue(_ event: NotchEvent, staged: Bool = false) {
        // The staged onboarding teaches every moment's sound (only Silent, which turns sounds off, mutes it) and is never
        // voiced, so the voice mode never carries its cue.
        guard let cue = Self.cue(for: event), !Self.quiet, staged || ReloSounds.enabled(event.kind), staged || !Self.voiceCarries(event.kind),
              staged || Date().timeIntervalSince(lastCue) >= 2 else { return }
        lastCue = Date()
        ReloCuePlayer.shared.play(cue)
        if Defaults[.reloHaptics], [.needsYou, .failed].contains(cue) {
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        }
    }

    /// Voice only: the spoken updates carry no cue (their line says the kind); a start still ticks.
    private static func voiceCarries(_ kind: NotchEvent.Kind) -> Bool {
        ReloVoiceMode.current == .voiceOnly && Defaults[.reloVoiceButton] && kind != .started
    }

    /// The updates' lines (ADR 0015), queued to be said after the cue ends, one at a time: the cue throttle never drops
    /// speech. Never over a call or dictation (the play button still works then).
    /// Queues the updates' lines. With `deferring`, that update's cue rides its line (played just before it); returns
    /// false when it cannot (no voice, no line), so the caller plays the cue now instead.
    @discardableResult
    private func say(_ events: [NotchEvent], deferring lead: NotchEvent? = nil) -> Bool {
        guard Defaults[.reloVoiceButton], ReloVoiceMode.current.speaks, !Self.quiet else { return false }
        guard !Microphone.inUse else { speech.clear(); return false }
        let now = Date()
        // A start only ticks: it is never said.
        var lines = events.filter { ReloSounds.enabled($0.kind) && $0.kind != .started }.compactMap { event -> SpokenQueue.Line? in
            let prompt = event.row.notificationID.flatMap { store.questions[$0]?.prompt }
            // Sound as the kind: the cue already said "needs you", so the line starts at the name.
            guard let text = SpokenLine.text(for: event.row, prompt: prompt, owner: Self.ownerDetail,
                                             kind: ReloVoiceMode.current != .soundAsKind, quiet: event.facts?.quietLine) else { return nil }
            // Aged by the server's evidence, so an old change waits no longer than its limit in the queue.
            return SpokenQueue.Line(id: event.row.id, kind: event.kind, text: text, at: now.addingTimeInterval(-(event.facts?.age ?? 0)))
        }
        if let lead, !Self.voiceCarries(lead.kind) {
            guard let cue = Self.cue(for: lead), ReloSounds.enabled(lead.kind),
                  let index = lines.firstIndex(where: { $0.id == lead.row.id && $0.kind == lead.kind }) else { return false }
            lines[index].cue = cue.rawValue
        }
        enqueue(lines)
        return true
    }

    /// At the Verbose detail, a card that finished a step says so (no cue, lowest in the queue, one per card every
    /// 45 seconds; steps finished faster are said together as the latest count); only the agent's own milestones.
    private func sayProgress(from previous: NotchPresentation, to next: NotchPresentation) {
        guard Defaults[.reloVoiceButton], ReloVoiceMode.current.speaks, Self.ownerDetail == .verbose, !Self.quiet, !Microphone.inUse else { return }
        let before = Dictionary(previous.sections.flatMap(\.rows).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let now = Date()
        let lines = next.sections.filter { !$0.isFolded }.flatMap(\.rows).compactMap { row -> SpokenQueue.Line? in
            guard row.tone == .working, let old = before[row.id], old.tone == .working,
                  let done = row.stepsDone, done > (old.stepsDone ?? done),
                  now.timeIntervalSince(progressSaid[row.id] ?? .distantPast) >= 45,
                  let text = SpokenLine.progress(for: row, owner: Self.ownerDetail) else { return nil }
            progressSaid[row.id] = now
            return SpokenQueue.Line(id: row.id, kind: .progressed, text: text, at: now)
        }
        enqueue(lines)
    }

    private func enqueue(_ lines: [SpokenQueue.Line]) {
        guard !lines.isEmpty else { return }
        speech.add(lines)
        guard speaking == nil else { return }
        let wait = max(0, ReloCuePlayer.shared.endsAt.timeIntervalSinceNow) + 0.25
        speaking = Task { @MainActor [self] in
            try? await Task.sleep(for: .seconds(wait))
            await self.speakQueued()
            self.speaking = nil
        }
    }

    /// Says the queued lines in turn, each after the one playing (a play button press included) has ended.
    private func speakQueued() async {
        while true {
            while ReloNotch.voice.phase != nil { try? await Task.sleep(for: .milliseconds(150)) }
            if Self.quiet || Microphone.inUse || !ReloVoiceMode.current.speaks { speech.clear() }
            let rows = store.presentation.sections.flatMap(\.rows)
            guard let line = speech.next(now: Date(), open: { line in rows.contains { $0.id == line.id && ($0.questionPending || $0.tone == .needsYou) } })
            else { return }
            if let cue = line.cue.flatMap(ReloCue.init(rawValue:)) {
                ReloCuePlayer.shared.play(cue)
                lastCue = Date()
                try? await Task.sleep(for: .seconds(max(0, ReloCuePlayer.shared.endsAt.timeIntervalSinceNow) + 0.25))
            }
            ReloNotch.voice.speak(id: "moment|\(line.text)", text: line.text)
            try? await Task.sleep(for: .milliseconds(150))
            // While the line plays the output is awake; once it ends, a cue soon after needs no wake-up wait.
            while ReloNotch.voice.phase != nil { try? await Task.sleep(for: .milliseconds(150)) }
            ReloCuePlayer.shared.noteSpoke()
        }
    }

    /// A working card finished a plan step: one faint tick, at most one per card every three minutes and one per batch,
    /// never over another cue (the 2 s throttle) or the voice. Status text alone never ticks.
    private func stepMoment(from previous: NotchPresentation, to next: NotchPresentation, staged: Bool = false) {
        let before = Dictionary(previous.sections.flatMap(\.rows).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let now = Date()
        let finishedStep = next.sections.filter { !$0.isFolded }.flatMap(\.rows).filter { row in
            // The staged onboarding finishes a step as the owner continues from a choice (Your turn to working).
            guard row.tone == .working, let old = before[row.id], old.tone == .working || (staged && old.tone == .yourTurn),
                  let done = row.stepsDone, done > (old.stepsDone ?? done) else { return false }
            return true
        }
        // The wings light every finished step; the sound stays rare.
        if let row = finishedStep.first { stepped = Stepped(serial: stepped.serial + 1, rowID: row.id) }
        guard !Self.quiet, staged || ReloSounds.enabled(.progressed) else { return }
        // The staged onboarding's step always ticks (no three-minute throttle, no voice to wait for): the owner pressed Continue.
        if staged, finishedStep.contains(where: { $0.id == OnboardingStage.rowID }) {
            ReloCuePlayer.shared.play(.update)
            return
        }
        guard ReloNotch.voice.phase == nil, speaking == nil, now.timeIntervalSince(lastCue) >= 2 else { return }
        let ticking = finishedStep.filter { now.timeIntervalSince(stepTicked[$0.id] ?? .distantPast) >= 180 }
        guard !ticking.isEmpty else { return }
        ticking.forEach { stepTicked[$0.id] = now }
        lastCue = now
        ReloCuePlayer.shared.play(.update)
    }

    /// New notices from the store, once each (a remount or a reconnect never repeats one).
    private func noticeMoment() {
        let arrivals = store.noticeArrivals
        guard arrivals.serial != notices.serial else { return }
        notices = arrivals
        guard !arrivals.notices.isEmpty else { return }
        unseen = true
    }

    /// Signing in lands: Relo's bloom, once.
    private func signInMoment() {
        let now = store.connection
        defer { lastConnection = now }
        if lastConnection == .signingIn, now == .connecting || now == .live { ReloCuePlayer.shared.play(.linked) }
    }

    /// The owner's own answer was accepted: a quiet tap (never needs-you: the owner acting is not news).
    private func answerMoment() {
        let nowAccepted = Set(store.answers.compactMap { $0.value == .accepted ? $0.key : nil })
        let fresh = nowAccepted.subtracting(accepted)
        accepted = nowAccepted
        if !fresh.isEmpty, !Self.quiet { ReloCuePlayer.shared.play(.sent) }
    }

    /// The owner's quiet wins: Relo's own pause, or a full-screen app in front.
    static var quiet: Bool {
        if ReloNotch.alertsPaused { return true }
        if Defaults[.reloQuietInFullScreen], let uuid = NSScreen.main?.displayUUID,
           FullscreenMediaDetector.shared.fullscreenStatus[uuid] == true { return true }
        return false
    }
}
