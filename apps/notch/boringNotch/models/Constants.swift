//
//  Constants.swift
//  boringNotch
//
//  Created by Richard Kunkli on 2024. 10. 17..
//

import SwiftUI
import Defaults

private let availableDirectories = FileManager
    .default
    .urls(for: .documentDirectory, in: .userDomainMask)
let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
let bundleIdentifier = Bundle.main.bundleIdentifier!
let appVersion = "\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""))"

let temporaryDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
let spacing: CGFloat = 16

struct CustomVisualizer: Codable, Hashable, Equatable, Defaults.Serializable {
    let UUID: UUID
    var name: String
    var url: URL
    var speed: CGFloat = 1.0
}

enum HideNotchOption: String, Defaults.Serializable {
    case always
    case nowPlayingOnly
    case never
}

// Define notification names at file scope
extension Notification.Name {
    static let mediaControllerChanged = Notification.Name("mediaControllerChanged")
}

// Media controller types for selection in settings
enum MediaControllerType: String, CaseIterable, Identifiable, Defaults.Serializable {
    case nowPlaying = "Now Playing"
    case appleMusic = "Apple Music"
    case spotify = "Spotify"
    case youtubeMusic = "YouTube Music"
    
    var id: String { self.rawValue }
}

// Sneak peek styles for selection in settings
enum SneakPeekStyle: String, CaseIterable, Identifiable, Defaults.Serializable {
    case standard = "Default"
    case inline = "Inline"
    
    var id: String { self.rawValue }
}

extension Defaults.Keys {
    // MARK: Relo
    /// The closed notch carries Relo's card (the server's focus) ahead of music.
    static let reloClosedActivity = Key<Bool>("reloClosedActivity", default: true)
    /// The closed notch expands into the card when work starts, needs the owner, finishes or fails.
    static let reloPeek = Key<Bool>("reloPeek", default: true)
    /// Sounds for Relo's updates: one switch for all, then one per kind of update.
    static let reloSounds = Key<Bool>("reloSounds", default: true)
    static let reloSoundQuestion = Key<Bool>("reloSoundQuestion", default: true)
    static let reloSoundFailed = Key<Bool>("reloSoundFailed", default: true)
    static let reloSoundYourTurn = Key<Bool>("reloSoundYourTurn", default: true)
    static let reloSoundFinished = Key<Bool>("reloSoundFinished", default: true)
    /// A faint tick when work starts, and one when a card finishes a plan step (at most one per card every 3 minutes).
    static let reloSoundStarted = Key<Bool>("reloSoundStarted", default: true)
    static let reloSoundStep = Key<Bool>("reloSoundStep", default: true)
    /// One trackpad tap when a new question arrives or work fails.
    static let reloHaptics = Key<Bool>("reloHaptics", default: true)
    /// ADR 0013 interface sounds: the notch opening and closing, a card unfolding, onboarding pages turning, the app
    /// launching and quitting (quiet; on by default).
    static let reloInterfaceSounds = Key<Bool>("reloInterfaceSounds", default: true)
    /// The notch does not expand or play sounds while a full-screen app is in front.
    static let reloQuietInFullScreen = Key<Bool>("reloQuietInFullScreen", default: true)
    /// Cards carry a play button that says the card's line on this Mac.
    static let reloVoiceButton = Key<Bool>("reloVoiceButton", default: true)
    /// Relo for Mac's onboarding, so a relaunch resumes: the last answered screen (hello, sound, where, server, agents,
    /// setup, ready), where Relo runs (mac, server) and the agents chosen.
    static let reloOnboardingScreen = Key<String>("reloOnboardingScreen", default: "")
    static let reloOnboardingPlace = Key<String>("reloOnboardingPlace", default: "")
    static let reloOnboardingAgents = Key<[String]>("reloOnboardingAgents", default: [])
    /// How sound and voice share an update: "sound" (cues only: the default, the owner's choice), "then" (the cue,
    /// then the line), "kind" (the cue stands for the line's kind word) or "voice" (the line alone). The voice is
    /// always live TTS; the play button on cards says a line whatever this is.
    static let reloVoiceMode = Key<String>("reloVoiceMode", default: ReloVoiceMode.soundOnly.rawValue)
    /// ADR 0015 revision 1: how much an update says, "brief", "full" or "verbose" (the default: also finished steps).
    /// The ceiling over each card's own level from the producer's `relo voice`.
    static let reloVoiceDetail = Key<String>("reloVoiceDetail", default: "verbose")
    /// "relo" (Phonon, once downloaded) or "system" (the Mac's own voice).
    static let reloVoiceEngine = Key<String>("reloVoiceEngine", default: "relo")
    /// Who the Relo voice speaks as: "default" (the voice it ships with) or a Gradium catalog voice's id.
    static let reloVoiceSpeaker = Key<String>("reloVoiceSpeaker", default: "default")
    /// Expanding and sounds are paused until this time ("Pause alerts for 1 hour").
    /// Usage accounts the owner hid from the Usage tab, and ones whose alerts are muted (by account id).
    static let usageHiddenAccounts = Key<[String]>("usageHiddenAccounts", default: [])
    static let usageMutedAccounts = Key<[String]>("usageMutedAccounts", default: [])
    /// Closed-notch usage moments: at 80% and when a plan runs out (on), and when a window resets (off).
    static let usageMomentLimits = Key<Bool>("usageMomentLimits", default: true)
    static let usageMomentResets = Key<Bool>("usageMomentResets", default: false)
    /// The usage side rail on a screen edge: "off", "hover" (tucked until the pointer touches it) or "always";
    /// at rest "compact" or "expanded" (always only); on the "right" or "left" edge.
    static let usageRail = Key<String>("usageRail", default: "off")
    static let usageRailEdge = Key<String>("usageRailEdge", default: "right")
    static let reloPeeksPausedUntil = Key<Date?>("reloPeeksPausedUntil", default: nil)

    // MARK: General
    static let menubarIcon = Key<Bool>("menubarIcon", default: true)
    static let showOnAllDisplays = Key<Bool>("showOnAllDisplays", default: false)
    static let automaticallySwitchDisplay = Key<Bool>("automaticallySwitchDisplay", default: true)
    
    // MARK: Behavior
    static let minimumHoverDuration = Key<TimeInterval>("minimumHoverDuration", default: 0.3)
    static let enableHaptics = Key<Bool>("enableHaptics", default: true)
    static let openNotchOnHover = Key<Bool>("openNotchOnHover", default: true)
    static let extendHoverArea = Key<Bool>("extendHoverArea", default: false)
    static let notchHeightMode = Key<WindowHeightMode>(
        "notchHeightMode",
        default: WindowHeightMode.matchRealNotchSize
    )
    static let nonNotchHeightMode = Key<WindowHeightMode>(
        "nonNotchHeightMode",
        default: WindowHeightMode.matchMenuBar
    )
    static let nonNotchHeight = Key<CGFloat>("nonNotchHeight", default: 32)
    static let notchHeight = Key<CGFloat>("notchHeight", default: 32)
    //static let openLastTabByDefault = Key<Bool>("openLastTabByDefault", default: false)
    static let showOnLockScreen = Key<Bool>("showOnLockScreen", default: false)
    static let hideFromScreenRecording = Key<Bool>("hideFromScreenRecording", default: false)
    
    // MARK: Appearance
    static let showEmojis = Key<Bool>("showEmojis", default: false)
    //static let alwaysShowTabs = Key<Bool>("alwaysShowTabs", default: true)
    static let settingsIconInNotch = Key<Bool>("settingsIconInNotch", default: true)
    static let lightingEffect = Key<Bool>("lightingEffect", default: true)
    static let enableShadow = Key<Bool>("enableShadow", default: true)
    static let cornerRadiusScaling = Key<Bool>("cornerRadiusScaling", default: true)

    static let tileShowLabels = Key<Bool>("tileShowLabels", default: false)
    static let sliderColor = Key<SliderColorEnum>(
        "sliderUseAlbumArtColor",
        default: SliderColorEnum.white
    )
    static let playerColorTinting = Key<Bool>("playerColorTinting", default: true)
    static let useMusicVisualizer = Key<Bool>("useMusicVisualizer", default: true)
    static let customVisualizers = Key<[CustomVisualizer]>("customVisualizers", default: [])
    static let selectedVisualizer = Key<CustomVisualizer?>("selectedVisualizer", default: nil)
    
    // MARK: Gestures
    static let enableGestures = Key<Bool>("enableGestures", default: true)
    static let closeGestureEnabled = Key<Bool>("closeGestureEnabled", default: true)
    static let gestureSensitivity = Key<CGFloat>("gestureSensitivity", default: 200.0)
    
    // MARK: Media playback
    static let coloredSpectrogram = Key<Bool>("coloredSpectrogram", default: true)
    static let enableSneakPeek = Key<Bool>("enableSneakPeek", default: false)
    static let sneakPeekStyles = Key<SneakPeekStyle>("sneakPeekStyles", default: .standard)
    static let waitInterval = Key<Double>("waitInterval", default: 3)
    static let showShuffleAndRepeat = Key<Bool>("showShuffleAndRepeat", default: false)
    static let enableLyrics = Key<Bool>("enableLyrics", default: false)
    static let musicControlSlots = Key<[MusicControlButton]>(
        "musicControlSlots",
        default: MusicControlButton.defaultLayout
    )
    static let musicControlSlotLimit = Key<Int>(
        "musicControlSlotLimit",
        default: MusicControlButton.defaultLayout.count
    )
    
    // MARK: Shelf
    static let boringShelf = Key<Bool>("boringShelf", default: true)
    static let openShelfByDefault = Key<Bool>("openShelfByDefault", default: true)
    static let shelfTapToOpen = Key<Bool>("shelfTapToOpen", default: true)
    static let quickShareProvider = Key<String>("quickShareProvider", default: QuickShareProvider.defaultProvider.id)
    static let copyOnDrag = Key<Bool>("copyOnDrag", default: false)
    static let autoRemoveShelfItems = Key<Bool>("autoRemoveShelfItems", default: false)
    static let expandedDragDetection = Key<Bool>("expandedDragDetection", default: true)
    
    
    // MARK: Fullscreen Media Detection
    static let hideNotchOption = Key<HideNotchOption>("hideNotchOption", default: .nowPlayingOnly)
    
    // MARK: Media Controller
    static let mediaController = Key<MediaControllerType>("mediaController", default: defaultMediaController)
    
    // MARK: Advanced Settings
    // Show or hide the title bar
    static let hideTitleBar = Key<Bool>("hideTitleBar", default: true)
    
    // Helper to determine the default media controller based on NowPlaying deprecation status
    static var defaultMediaController: MediaControllerType {
        if MusicManager.shared.isNowPlayingDeprecated {
            return .appleMusic
        } else {
            return .nowPlaying
        }
    }

    static let didClearLegacyURLCacheV1 = Key<Bool>("didClearLegacyURLCache_v1", default: false)
}
