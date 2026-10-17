import Foundation

public struct LiveActivityDisplayPresentation: Equatable, Hashable, Sendable {

    public enum VisualType: String, Codable, CaseIterable, Sendable {
        case none
        case progressBar = "progress_bar"
        case steps
        case image
    }

    public enum BehaviorType: String, Codable, CaseIterable, Sendable {
        case informational
        case progress
        case approval
        case yesNo = "yes_no"
        case textReply = "text_reply"
        case choice
    }

    public enum Privacy: String, Codable, Sendable {
        case standard
        case `private`
    }

    public enum Symbol: String, Codable, CaseIterable, Sendable {
        case terminal, code, build, success, warning, info, question, reply, image, lock

        public var systemImageName: String {
            switch self {
            case .terminal: "terminal.fill"
            case .code: "chevron.left.forwardslash.chevron.right"
            case .build: "hammer.fill"
            case .success: "checkmark.circle.fill"
            case .warning: "exclamationmark.triangle.fill"
            case .info: "info.circle.fill"
            case .question: "questionmark.circle.fill"
            case .reply: "arrowshape.turn.up.left.fill"
            case .image: "photo.fill"
            case .lock: "lock.fill"
            }
        }
    }

    public struct Step: Codable, Equatable, Hashable, Sendable, Identifiable {
        public enum State: String, Codable, Sendable { case complete, current, pending, skipped }
        public let id: String
        public let label: String
        public let state: State

        public init(id: String, label: String, state: State) {
            self.id = id
            self.label = label
            self.state = state
        }
    }

    /// A long plan's card shows a window of it: steps hidden before it (all done) and after it (not started).
    /// `progress` is the server's own count for the plan line (plan 12b, U1/U2) when the card carries it;
    /// surfaces prefer it and fall back to counting the shown steps when it is absent.
    public struct StepWindow: Codable, Equatable, Hashable, Sendable {
        public let before: Int
        public let after: Int
        public let progress: PlanProgress?
        public init(before: Int = 0, after: Int = 0, progress: PlanProgress? = nil) {
            self.before = max(0, before)
            self.after = max(0, after)
            self.progress = progress
        }
        public static let whole = StepWindow()
        public func total(_ shown: Int) -> Int { before + shown + after }
    }

    public struct AssetReference: Codable, Equatable, Hashable, Sendable {
        public enum ContentMode: String, Codable, Sendable { case fit, fill }
        public let assetId: String
        public let revision: Int
        public let sha256: String
        public let mediaType: String
        public let byteSize: Int
        public let pixelWidth: Int
        public let pixelHeight: Int
        public let altText: String
        public let contentMode: ContentMode

        public init(
            assetId: String, revision: Int, sha256: String, mediaType: String,
            byteSize: Int, pixelWidth: Int, pixelHeight: Int, altText: String,
            contentMode: ContentMode
        ) {
            self.assetId = assetId
            self.revision = revision
            self.sha256 = sha256
            self.mediaType = mediaType
            self.byteSize = byteSize
            self.pixelWidth = pixelWidth
            self.pixelHeight = pixelHeight
            self.altText = altText
            self.contentMode = contentMode
        }

        public var cacheFileName: String { "\(assetId)-r\(revision)-\(sha256)" }
    }

    public enum Visual: Equatable, Hashable, Sendable {
        case none
        case progressBar(value: Double, label: String?)
        case steps([Step], window: StepWindow = .whole)
        case image(AssetReference)

        public var type: VisualType {
            switch self {
            case .none: .none
            case .progressBar: .progressBar
            case .steps: .steps
            case .image: .image
            }
        }
    }

    public enum Behavior: Equatable, Hashable, Sendable {
        case informational
        case progress
        case approval(primary: String, secondary: String)
        case yesNo(primary: String, secondary: String)
        /// 2–4 labeled options, answered with `choose`.
        case choice([InteractionOption])
        case unsupportedTextReply(label: String, placeholder: String?, maxLength: Int)

        public var type: BehaviorType {
            switch self {
            case .informational: .informational
            case .progress: .progress
            case .approval: .approval
            case .yesNo: .yesNo
            case .choice: .choice
            case .unsupportedTextReply: .textReply
            }
        }

        public var choiceOptions: [InteractionOption]? {
            if case .choice(let options) = self { options } else { nil }
        }
    }

    public let header: String?
    public let title: String
    public let subtitle: String?
    public let status: String
    public let visual: Visual
    public let behavior: Behavior
    public let accentColor: String
    public let secondaryColor: String?
    public let symbol: Symbol
    public let privacy: Privacy

    public init(
        header: String?, title: String, subtitle: String?, status: String,
        visual: Visual, behavior: Behavior,
        accentColor: String = LiveActivityPresentationFormatting.defaultAccentColor,
        secondaryColor: String? = nil, symbol: Symbol = .info,
        privacy: Privacy = .standard
    ) {
        self.header = header
        self.title = title
        self.subtitle = subtitle
        self.status = status
        self.visual = visual
        self.behavior = behavior
        self.accentColor = LiveActivityPresentationFormatting.normalizedAccentColor(accentColor)
        self.secondaryColor = secondaryColor.map(LiveActivityPresentationFormatting.normalizedAccentColor)
        self.symbol = symbol
        self.privacy = privacy
    }

    public static let privateProjection = LiveActivityDisplayPresentation(
        header: "Relo", title: "Private activity", subtitle: nil,
        status: "Open Relo to view", visual: .none, behavior: .informational,
        symbol: .lock, privacy: .private
    )

    public var projectedForDisplay: LiveActivityDisplayPresentation {
        guard privacy != .private else { return .privateProjection }
        return self
    }

    public var permitsLiveActivityActions: Bool {
        switch behavior {
        case .approval, .yesNo, .choice: privacy == .standard
        case .informational, .progress, .unsupportedTextReply: false
        }
    }


}

public struct LiveActivityPresentation: Codable, Equatable, Hashable, Sendable {
    public static let maxCanonicalBytes = 3_072

    public enum IdentityRole: String, Codable, CaseIterable, Sendable {
        case project, thread, state, control, neutral
    }

    public enum Surface: String, Codable, CaseIterable, Sendable {
        case lockScreen = "lock_screen"
        case expandedLeading = "expanded_leading"
        case expandedTrailing = "expanded_trailing"
        case expandedBottom = "expanded_bottom"
        case compactLeading = "compact_leading"
        case compactTrailing = "compact_trailing"
        case minimal
    }

    public enum SemanticIcon: String, Codable, CaseIterable, Sendable {
        case terminal, code, build, success, warning, info, question, reply, image, lock
        case project, thread, direct, active, waiting, needsAction = "needs_action"
        case completed, failed, cancelled, expired, superseded
        case laptop, desktop, server, cloud

        /// An icon this build does not know (a newer server) decodes as `.project`, so one new
        /// value never kills the whole presentation. The state icon decodes with `.active` instead.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = SemanticIcon(rawValue: raw) ?? .project
        }

        public var systemImageName: String {
            switch self {
            case .terminal: "terminal.fill"
            case .code: "chevron.left.forwardslash.chevron.right"
            case .build: "hammer.fill"
            case .success, .completed: "checkmark.circle.fill"
            case .warning, .failed: "exclamationmark.triangle.fill"
            case .info: "info.circle.fill"
            case .question, .needsAction: "questionmark.circle.fill"
            case .reply: "arrowshape.turn.up.left.fill"
            case .image: "photo.fill"
            case .lock: "lock.fill"
            case .project: "folder.fill"
            case .thread: "point.3.connected.trianglepath.dotted"
            case .direct: "terminal"
            case .active: "waveform.path.ecg"
            case .waiting: "clock.fill"
            case .cancelled: "xmark.circle.fill"
            case .expired: "timer"
            case .superseded: "arrow.trianglehead.2.clockwise.rotate.90"
            case .laptop: "laptopcomputer"
            case .desktop: "desktopcomputer"
            case .server: "server.rack"
            case .cloud: "cloud.fill"
            }
        }

        public var displaySymbol: LiveActivityDisplayPresentation.Symbol {
            switch self {
            case .terminal, .direct, .laptop, .desktop, .server: .terminal
            case .code: .code
            case .build, .project, .thread: .build
            case .success, .completed: .success
            case .warning, .failed, .cancelled, .expired: .warning
            case .question, .needsAction: .question
            case .reply: .reply
            case .image: .image
            case .lock: .lock
            case .info, .active, .waiting, .superseded, .cloud: .info
            }
        }
    }

    public struct IdentityToken: Codable, Equatable, Hashable, Sendable {
        public let label: String
        public let color: String
        public let icon: SemanticIcon
        public let revision: Int
        public let provenance: String

        public init(label: String, color: String, icon: SemanticIcon, revision: Int = 1, provenance: String = "generated") {
            self.label = label; self.color = color; self.icon = icon
            self.revision = revision; self.provenance = provenance
        }
    }

    public struct Identity: Codable, Equatable, Hashable, Sendable {
        public let project: IdentityToken?
        public let thread: IdentityToken?
        public let direct: Bool

        public init(project: IdentityToken? = nil, thread: IdentityToken? = nil, direct: Bool) {
            self.project = project; self.thread = thread; self.direct = direct
        }
    }

    public struct State: Codable, Equatable, Hashable, Sendable {
        public let kind: String
        public let tone: String
        public let icon: SemanticIcon

        public init(kind: String, tone: String, icon: SemanticIcon) {
            self.kind = kind; self.tone = tone; self.icon = icon
        }

        private enum CodingKeys: String, CodingKey { case kind, tone, icon }

        /// An unknown state icon falls back to `.active` (the identity icon falls back to `.project`).
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decode(String.self, forKey: .kind)
            tone = try c.decode(String.self, forKey: .tone)
            let raw = try c.decode(String.self, forKey: .icon)
            icon = LiveActivityPresentation.SemanticIcon(rawValue: raw) ?? .active
        }
    }

    public struct Appearance: Codable, Equatable, Hashable, Sendable {
        public struct Roles: Codable, Equatable, Hashable, Sendable {
            public let cardIdentity: IdentityRole
            public let componentIdentity: IdentityRole
            public let statusEmphasis: IdentityRole

            public init(cardIdentity: IdentityRole = .project, componentIdentity: IdentityRole = .thread, statusEmphasis: IdentityRole = .state) {
                self.cardIdentity = cardIdentity; self.componentIdentity = componentIdentity
                self.statusEmphasis = statusEmphasis
            }
        }
        public enum ProgressDisplay: String, Codable, Hashable, Sendable { case bar, ring }

        public let roles: Roles
        /// Absent means the linear bar; `ring` draws progress as a gauge with the percent inside.
        public let progressDisplay: ProgressDisplay?

        public init(
            roles: Roles = .init(), progressDisplay: ProgressDisplay? = nil
        ) {
            self.roles = roles; self.progressDisplay = progressDisplay
        }

        private enum CodingKeys: String, CodingKey { case roles, progressDisplay }

        /// A `theme` the server still sends is ignored: Relo draws one dark look.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            roles = try c.decode(Roles.self, forKey: .roles)
            progressDisplay = try c.decodeIfPresent(ProgressDisplay.self, forKey: .progressDisplay)
        }

        public var drawsProgressAsRing: Bool { progressDisplay == .ring }
    }

    public struct Surfaces: Codable, Equatable, Hashable, Sendable {
        public let lockScreen: [String]
        public let expandedLeading: [String]
        public let expandedTrailing: [String]
        public let expandedBottom: [String]
        public let compactLeading: [String]
        public let compactTrailing: [String]
        public let minimal: [String]

        public init(
            lockScreen: [String] = [], expandedLeading: [String] = [],
            expandedTrailing: [String] = [], expandedBottom: [String] = [],
            compactLeading: [String] = [], compactTrailing: [String] = [], minimal: [String] = []
        ) {
            self.lockScreen = lockScreen; self.expandedLeading = expandedLeading
            self.expandedTrailing = expandedTrailing; self.expandedBottom = expandedBottom
            self.compactLeading = compactLeading; self.compactTrailing = compactTrailing
            self.minimal = minimal
        }

        private enum CodingKeys: String, CodingKey {
            case lockScreen = "lock_screen"
            case expandedLeading = "expanded_leading"
            case expandedTrailing = "expanded_trailing"
            case expandedBottom = "expanded_bottom"
            case compactLeading = "compact_leading"
            case compactTrailing = "compact_trailing"
            case minimal
        }

        public func componentIDs(for surface: Surface) -> [String] {
            switch surface {
            case .lockScreen: lockScreen
            case .expandedLeading: expandedLeading
            case .expandedTrailing: expandedTrailing
            case .expandedBottom: expandedBottom
            case .compactLeading: compactLeading
            case .compactTrailing: compactTrailing
            case .minimal: minimal
            }
        }
    }

    public enum Component: Codable, Equatable, Hashable, Sendable, Identifiable {
        case progressBar(id: String, colorRole: IdentityRole, value: Double, label: String?)
        case steps(id: String, colorRole: IdentityRole, items: [LiveActivityDisplayPresentation.Step],
                   window: LiveActivityDisplayPresentation.StepWindow = .whole)
        case image(id: String, colorRole: IdentityRole, asset: LiveActivityDisplayPresentation.AssetReference)

        public var id: String {
            switch self {
            case let .progressBar(id, _, _, _), let .steps(id, _, _, _), let .image(id, _, _): id
            }
        }

        public var colorRole: IdentityRole {
            switch self {
            case let .progressBar(_, role, _, _), let .steps(_, role, _, _), let .image(_, role, _): role
            }
        }

        private enum CodingKeys: String, CodingKey {
            case id, type, colorRole, value, label, items, before, after, asset, altText, contentMode
            case progress = "plan" // the server's steps component carries planProgressWire as `plan`
        }
        private enum ComponentType: String, Codable { case progressBar = "progress_bar", steps, image }
        private struct AssetCore: Codable {
            let kind: String
            let assetId: String
            let revision: Int
            let sha256: String
            let mediaType: String
            let byteSize: Int
            let pixelWidth: Int
            let pixelHeight: Int

            init(_ asset: LiveActivityDisplayPresentation.AssetReference) {
                kind = "relo_asset"
                assetId = asset.assetId
                revision = asset.revision
                sha256 = asset.sha256
                mediaType = asset.mediaType
                byteSize = asset.byteSize
                pixelWidth = asset.pixelWidth
                pixelHeight = asset.pixelHeight
            }
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            let id = try values.decode(String.self, forKey: .id)
            let role = try values.decode(IdentityRole.self, forKey: .colorRole)
            switch try values.decode(ComponentType.self, forKey: .type) {
            case .progressBar:
                let value = try values.decode(Double.self, forKey: .value)
                guard value.isFinite, (0...1).contains(value) else {
                    throw DecodingError.dataCorruptedError(forKey: .value, in: values, debugDescription: "Invalid progress")
                }
                let label = try values.decodeIfPresent(String.self, forKey: .label)
                self = .progressBar(id: id, colorRole: role, value: value, label: label)
            case .steps:
                self = .steps(id: id, colorRole: role,
                    items: try values.decode([LiveActivityDisplayPresentation.Step].self, forKey: .items),
                    window: .init(before: try values.decodeIfPresent(Int.self, forKey: .before) ?? 0,
                                  after: try values.decodeIfPresent(Int.self, forKey: .after) ?? 0,
                                  progress: (try? values.decodeIfPresent(PlanProgress.self, forKey: .progress)) ?? nil))
            case .image:
                let core = try values.decode(AssetCore.self, forKey: .asset)
                let altText = try values.decode(String.self, forKey: .altText)
                let contentMode = try values.decode(LiveActivityDisplayPresentation.AssetReference.ContentMode.self, forKey: .contentMode)
                let asset = LiveActivityDisplayPresentation.AssetReference(
                    assetId: core.assetId, revision: core.revision, sha256: core.sha256,
                    mediaType: core.mediaType, byteSize: core.byteSize, pixelWidth: core.pixelWidth,
                    pixelHeight: core.pixelHeight, altText: altText, contentMode: contentMode)
                self = .image(id: id, colorRole: role, asset: asset)
            }
        }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(id, forKey: .id)
            try values.encode(colorRole, forKey: .colorRole)
            switch self {
            case let .progressBar(_, _, value, label):
                try values.encode(ComponentType.progressBar, forKey: .type)
                try values.encode(value, forKey: .value); try values.encode(label, forKey: .label)
            case let .steps(_, _, items, window):
                try values.encode(ComponentType.steps, forKey: .type); try values.encode(items, forKey: .items)
                if window.before > 0 { try values.encode(window.before, forKey: .before) }
                if window.after > 0 { try values.encode(window.after, forKey: .after) }
                try values.encodeIfPresent(window.progress, forKey: .progress)
            case let .image(_, _, asset):
                try values.encode(ComponentType.image, forKey: .type); try values.encode(AssetCore(asset), forKey: .asset)
                try values.encode(asset.altText, forKey: .altText); try values.encode(asset.contentMode, forKey: .contentMode)
            }
        }
    }

    public let header: String?
    public let title: String
    public let subtitle: String?
    public let status: String
    public let components: [Component]
    public let surfaces: Surfaces
    public let identity: Identity
    public let state: State
    public let behavior: LiveActivityDisplayPresentation.Behavior
    public let appearance: Appearance
    public let privacy: LiveActivityDisplayPresentation.Privacy

    private enum CodingKeys: String, CodingKey {
        case header, title, subtitle, status, componentsJson, surfacesJson
        case identityJson, stateJson, behaviorType, primaryAction, primaryLabel
        case secondaryAction, secondaryLabel, appearanceJson, privacy, choiceOptions
    }

    public init(
        header: String? = nil,
        title: String,
        subtitle: String? = nil,
        status: String,
        components: [Component] = [],
        surfaces: Surfaces = .init(),
        identity: Identity = .init(direct: true),
        state: State = .init(kind: "active", tone: "live", icon: .active),
        behavior: LiveActivityDisplayPresentation.Behavior = .informational,
        appearance: Appearance = .init(),
        privacy: LiveActivityDisplayPresentation.Privacy = .standard
    ) {
        self.header = header; self.title = title; self.subtitle = subtitle; self.status = status
        self.components = components; self.surfaces = surfaces; self.identity = identity
        self.state = state; self.behavior = behavior; self.appearance = appearance; self.privacy = privacy
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        header = try values.decodeIfPresent(String.self, forKey: .header)
        title = try values.decode(String.self, forKey: .title)
        subtitle = try values.decodeIfPresent(String.self, forKey: .subtitle)
        status = try values.decode(String.self, forKey: .status)
        let componentsJSON = try values.decode(String.self, forKey: .componentsJson)
        let surfacesJSON = try values.decode(String.self, forKey: .surfacesJson)
        let identityJSON = try values.decode(String.self, forKey: .identityJson)
        let stateJSON = try values.decode(String.self, forKey: .stateJson)
        let appearanceJSON = try values.decode(String.self, forKey: .appearanceJson)
        components = try JSONDecoder().decode([Component].self, from: Data(componentsJSON.utf8))
        surfaces = try JSONDecoder().decode(Surfaces.self, from: Data(surfacesJSON.utf8))
        identity = try JSONDecoder().decode(Identity.self, from: Data(identityJSON.utf8))
        state = try JSONDecoder().decode(State.self, from: Data(stateJSON.utf8))
        appearance = try JSONDecoder().decode(Appearance.self, from: Data(appearanceJSON.utf8))
        privacy = try values.decode(LiveActivityDisplayPresentation.Privacy.self, forKey: .privacy)
        let behaviorType = try values.decode(LiveActivityDisplayPresentation.BehaviorType.self, forKey: .behaviorType)
        behavior = switch behaviorType {
        case .informational: .informational
        case .progress: .progress
        case .approval: .approval(
            primary: try values.decode(String.self, forKey: .primaryLabel),
            secondary: try values.decode(String.self, forKey: .secondaryLabel))
        case .yesNo: .yesNo(
            primary: try values.decode(String.self, forKey: .primaryLabel),
            secondary: try values.decode(String.self, forKey: .secondaryLabel))
        case .choice:
            try Self.decodeChoice(from: values)
        case .textReply:
            throw DecodingError.dataCorruptedError(
                forKey: .behaviorType, in: values,
                debugDescription: "Text reply is not part of the current Live Activity presentation contract"
            )
        }
        let ids = components.map(\.id)
        let known = Set(ids)
        guard components.count <= 8, known.count == ids.count,
              Surface.allCases.flatMap({ surfaces.componentIDs(for: $0) }).allSatisfy(known.contains) else {
            throw DecodingError.dataCorruptedError(forKey: .componentsJson, in: values, debugDescription: "Invalid presentation component graph")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(header, forKey: .header); try values.encode(title, forKey: .title)
        try values.encode(subtitle, forKey: .subtitle); try values.encode(status, forKey: .status)
        try values.encode(String(decoding: JSONEncoder.sorted.encode(components), as: UTF8.self), forKey: .componentsJson)
        try values.encode(String(decoding: JSONEncoder.sorted.encode(surfaces), as: UTF8.self), forKey: .surfacesJson)
        try values.encode(String(decoding: JSONEncoder.sorted.encode(identity), as: UTF8.self), forKey: .identityJson)
        try values.encode(String(decoding: JSONEncoder.sorted.encode(state), as: UTF8.self), forKey: .stateJson)
        try values.encode(String(decoding: JSONEncoder.sorted.encode(appearance), as: UTF8.self), forKey: .appearanceJson)
        try values.encode(behavior.type, forKey: .behaviorType)
        switch behavior {
        case let .approval(primary, secondary), let .yesNo(primary, secondary):
            try values.encode(primary, forKey: .primaryLabel); try values.encode(secondary, forKey: .secondaryLabel)
        case .informational, .progress:
            try values.encodeNil(forKey: .primaryLabel); try values.encodeNil(forKey: .secondaryLabel)
        case .choice(let options):
            try values.encodeNil(forKey: .primaryLabel); try values.encodeNil(forKey: .secondaryLabel)
            try values.encode(options, forKey: .choiceOptions)
        case .unsupportedTextReply:
            throw EncodingError.invalidValue(
                behavior,
                .init(codingPath: encoder.codingPath,
                      debugDescription: "Text reply is not part of the current Live Activity presentation contract")
            )
        }
        try values.encodeNil(forKey: .primaryAction); try values.encodeNil(forKey: .secondaryAction)
        try values.encode(privacy, forKey: .privacy)
    }

    /// `choiceOptions` is a flat array beside the other content-state fields, never a JSON string.
    private static func decodeChoice(
        from values: KeyedDecodingContainer<CodingKeys>
    ) throws -> LiveActivityDisplayPresentation.Behavior {
        let options = try values.decode([InteractionOption].self, forKey: .choiceOptions)
        guard InteractionOption.isValidList(options) else {
            throw DecodingError.dataCorruptedError(
                forKey: .choiceOptions, in: values, debugDescription: "A choice needs 2–4 distinct options")
        }
        return .choice(options)
    }

    /// How the work stands for the plan line: a finished card reads "5 of 5 done" or "Stopped at 3 of 5".
    public var planStanding: PlanProgress.Standing {
        switch state.kind {
        case "completed": .done
        case "failed", "cancelled", "canceled", "expired", "superseded": .stopped
        case "paused": .paused
        default: .moving
        }
    }

    /// The work waits on something named: the badge reads Waiting, never Running (U4).
    public var isWaiting: Bool { state.tone == "waiting" || state.kind == "waiting" }

    public var projectedForDisplay: LiveActivityPresentation? { privacy == .private ? nil : self }
    public var permitsLiveActivityActions: Bool {
        privacy == .standard && [.approval, .yesNo, .choice].contains(behavior.type)
    }
    public func components(for surface: Surface) -> [Component] {
        let byID = Dictionary(uniqueKeysWithValues: components.map { ($0.id, $0) })
        return surfaces.componentIDs(for: surface).compactMap { byID[$0] }
    }
    public func color(for role: IdentityRole) -> String {
        switch role {
        case .project: identity.project?.color ?? "#5ED8B7"
        case .thread: identity.thread?.color ?? identity.project?.color ?? "#5ED8B7"
        case .state:
            switch state.tone {
            case "success": "#5ED8B7"
            case "failure": "#FF7A90"
            case "attention": "#F2A65A"
            case "waiting": "#E2C45B"
            default: "#5ED8B7"
            }
        case .control, .neutral: "#5ED8B7"
        }
    }
    public var displayProjection: LiveActivityDisplayPresentation {
        let selectedID = surfaces.minimal.first ?? surfaces.compactTrailing.first
        let component = selectedID.flatMap { id in components.first { $0.id == id } } ?? components.first
        let visual: LiveActivityDisplayPresentation.Visual = switch component {
        case let .progressBar(_, _, value, label): .progressBar(value: value, label: label)
        case let .steps(_, _, items, window): .steps(items, window: window)
        case let .image(_, _, asset): .image(asset)
        case nil: .none
        }
        return LiveActivityDisplayPresentation(
            header: identity.project?.label ?? (identity.direct ? "Direct" : header),
            title: title, subtitle: subtitle, status: status, visual: visual, behavior: behavior,
            accentColor: color(for: appearance.roles.cardIdentity),
            symbol: state.icon.displaySymbol, privacy: privacy
        )
    }
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
