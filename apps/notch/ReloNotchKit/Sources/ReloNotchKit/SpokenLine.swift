import Foundation

/// What the notch says (ADR 0015): one frame for every line, "<Kind>: <name>. <gist>", so a half-heard line still says
/// whether it needs the owner. The kind is a closed set of words; the name is the work's declared spoken name, else
/// the goal's first words; the gist is the card's sealed `spoken` (the CLI shortened the outcome, or the agent wrote
/// `--say`), a question's first sentence, or the current step. The Mac never shortens an outcome itself: without a
/// sealed gist it says the frame alone. It adds no facts; a sealed card this Mac could not open says nothing. Held to
/// the CLI's golden file (packages/cli/test/fixtures/spoken-lines.json).
public enum SpokenLine {
    /// The longest line spoken, cut at a word.
    static let maxLength = 180
    static let nameWords = 4
    static let gistWords = 20
    /// A question or a failure is urgent: the fewest ideas (ADR 0015 revision 1).
    static let urgentWords = 12

    /// How much is said (ADR 0015 revision 1): nothing, the kind and the name, and the gist, and finished steps. The
    /// card's level (the producer's `relo voice`) and the owner's Settings meet at the lower of the two.
    public enum Detail: Int, Comparable, Sendable, CaseIterable {
        case off, brief, full, verbose

        public init?(name: String?) {
            switch name?.lowercased() {
            case "off": self = .off
            case "brief": self = .brief
            case "full": self = .full
            case "verbose": self = .verbose
            default: return nil
            }
        }

        public var name: String { ["off", "brief", "full", "verbose"][rawValue] }
        public static func < (a: Detail, b: Detail) -> Bool { a.rawValue < b.rawValue }
    }

    /// The detail a card is said at: the lower of the owner's and the card's. A card that names no level (a readable
    /// card from Relo on this Mac carries none: the level travels in sealed text) is said at the owner's detail.
    public static func detail(for row: NotchPresentation.Row, owner: Detail) -> Detail {
        min(owner, row.spokenVoice ?? owner)
    }

    /// A finished step at the Verbose detail: "Working: Notch redesign. 3 of 5 done, now build the list."
    public static func progress(for row: NotchPresentation.Row, owner: Detail) -> String? {
        guard !row.unreadable, detail(for: row, owner: owner) == .verbose,
              let done = row.stepsDone, let total = row.stepsTotal, total > 0 else { return nil }
        let name = spokenName(goal: row.title, declared: row.spokenName)
        guard !name.isEmpty else { return nil }
        let now = row.currentStep.flatMap(stepGist).map { ", now " + $0.prefix(1).lowercased() + $0.dropFirst() } ?? "."
        return line(kind: "Working", name: name, gist: "\(done) of \(total) done" + now, question: false)
    }

    /// The card's line at `owner`'s detail (the play button passes .full: the owner asked for it). Without `kind`, the
    /// line starts at the name: a cue already said what kind of update it is.
    /// A Quiet card says its own kind and the server's reason (`quiet`, "Session idle since 3:12 PM"), never "Working".
    public static func text(for row: NotchPresentation.Row, prompt: String? = nil, owner: Detail = .full,
                            kind spokenKind: Bool = true, quiet: String? = nil) -> String? {
        guard !row.unreadable else { return nil }
        let detail = Self.detail(for: row, owner: owner)
        guard detail > .off else { return nil }
        let name = spokenName(goal: row.title, declared: row.spokenName)
        guard !name.isEmpty else { return nil }
        let sealed = row.spoken.map(clean).flatMap { $0.isEmpty ? nil : sentence($0) }
        let kind: String
        let gist: String?
        switch row.tone {
        case .needsYou: kind = "Needs you"; gist = prompt.flatMap(questionGist)
        case .failed: kind = "Failed"; gist = sealed
        case .yourTurn: kind = "Your turn"; gist = sealed
        case .done: kind = "Finished"; gist = sealed
        case .dropped, .leftUnfinished: kind = "Stopped"; gist = nil
        case .paused: kind = "Paused"; gist = nil
        case .working: kind = "Working"; gist = row.currentStep.flatMap(stepGist)
        case .quiet: kind = "Quiet"; gist = quiet.map(clean).flatMap { $0.isEmpty ? nil : sentence($0) }
        }
        return line(kind: spokenKind ? kind : nil, name: name, gist: detail >= .full ? gist : nil, question: row.tone == .needsYou)
    }

    static func line(kind: String?, name: String, gist: String?, question: Bool) -> String {
        var line = kind.map { "\($0): \(sentence(name))" } ?? sentence(name)
        if let gist, gist.trimmingCharacters(in: CharacterSet(charactersIn: ".!?")).caseInsensitiveCompare(name) != .orderedSame {
            line += " \(gist)"
        }
        guard line.count > maxLength else { return line }
        let head = String(line.prefix(maxLength))
        let cut = head[..<(head.lastIndex(of: " ") ?? head.endIndex)]
        return sentence(String(cut).trimmingCharacters(in: CharacterSet(charactersIn: ",;: ")), end: question ? "?" : ".")
    }

    /// How the work is called aloud: the declared name, else the goal's head (before a colon or dash), at most four words.
    static func spokenName(goal: String, declared: String?) -> String {
        if let declared, !declared.isEmpty { return capWords(strip(declared), nameWords) }
        var s = strip(goal)
        for separator in [":", " — ", " – ", " - ", "(", ";", ". "] {
            if let range = s.range(of: separator), wordCount(String(s[..<range.lowerBound])) >= 2 {
                s = String(s[..<range.lowerBound])
            }
        }
        return capWords(s, nameWords)
    }

    /// A question's gist: its first sentence (a relayed permission, "Allow Bash: …?", by its tool alone), at most twelve words.
    static func questionGist(_ prompt: String) -> String? {
        if let range = prompt.range(of: #"^Allow \w+(?=: )"#, options: .regularExpression) { return String(prompt[range]) + "?" }
        let s = strip(prompt)
        var head = s
        var end = "?"
        if let range = s.range(of: #"[.!?](\s|$)"#, options: .regularExpression) {
            head = String(s[..<range.lowerBound])
            let mark = s[range.lowerBound]
            if mark != "?" { end = String(mark) }
        }
        let gist = capWords(head, urgentWords)
        return gist.isEmpty ? nil : gist + end
    }

    /// The current step said by the play button, shortened as the CLI shortens an outcome (`outcomeGist`): the first
    /// sentence's phrases in order, as many as fit in twenty words, stopping at the first that is inventory.
    static func stepGist(_ step: String) -> String? {
        let s = clean(step).replacingOccurrences(of: #"\([^)]*\)"#, with: "", options: .regularExpression)
        let first = s.range(of: #"[.!?](\s|$)"#, options: .regularExpression).map { String(s[..<$0.lowerBound]) } ?? s
        let phrases = first
            .replacingOccurrences(of: #"\s+(?=(and|but|so)\s+(I|we|it|they|you)\b)"#, with: "\u{1F}", options: .regularExpression)
            .components(separatedBy: CharacterSet(charactersIn: ";:—\u{1F}"))
            .flatMap { $0.components(separatedBy: ", ") }
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var kept: [String] = []
        var words = 0
        for phrase in phrases {
            let said = strip(phrase)
            let count = wordCount(said)
            if kept.isEmpty {
                if count == 0 { continue }
            } else if isInventory(phrase) || count < 2 || words + count > gistWords { break }
            kept.append(said)
            words += count
        }
        let gist = capWords(kept.joined(separator: ", "), gistWords)
        return gist.isEmpty ? nil : sentence(gist.prefix(1).uppercased() + gist.dropFirst())
    }

    /// A version, hash, id, link, file name or path: what a voice never reads (the CLI's `spokenInventory`).
    static func isInventory(_ text: String) -> Bool {
        [#"\bv?\d+(\.\d+){1,3}\b"#, #"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b"#, #"\b(wrk|act|int|ntf|ses)_[A-Za-z0-9-]+"#,
         #"(?i)https?://|\b[\w-]+(\.[\w-]+)*\.(ai|com|dev|io|net|org|app)\b"#, #"\b(?![A-Z][a-z]+\.js\b)[\w-]+\.(swift|md|ts|tsx|mjs|js|json|sh|yml|yaml|html|css|py|txt)\b"#,
         #"(^|\s)(~|\.{1,2})?/[\w.@-]+|[\w.@-]+/[\w.@-]+/"#]
            .contains { text.range(of: $0, options: .regularExpression) != nil }
    }

    /// The text as words to say: no markdown, glyphs as pauses, links by host, paths by their last name, ids left out.
    static func clean(_ text: String) -> String {
        var s = text
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"https?://([^/\s]+)\S*"#, with: "$1", options: .regularExpression)
        let original = s
        s = original.replacing(Self.path) { match in
            original[match.range].split(separator: "/").last.map(String.init) ?? ""
        }
        let rules: [(String, String)] = [
            (#"`{1,3}"#, ""),
            (#"\*\*|__|(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)"#, ""),
            (#"(?m)^\s*(#+|[-*+]|\d+\.)\s+"#, ""),        // headings and list markers
            (#"\b(wrk|act|int|ntf|ses)_[A-Za-z0-9-]+\b"#, ""),
            (#"\s*[·•|]\s*"#, ", "),
            (#"…|\.{3}"#, "."),
            (#"[✓✔✗✘→←]"#, "")
        ]
        for (pattern, template) in rules {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return tidy(s)
    }

    /// Clean, then without what a voice never reads: parentheses, versions, builds, hashes, codes, file names, links.
    static func strip(_ text: String) -> String {
        var s = clean(text)
        let rules: [(String, String, Bool)] = [
            (#"\([^)]*\)"#, "", false),
            (#"^v?\d+(\.\d+){1,3}\b"#, "The new version", false),
            (#"\b((in|to|on|at)\s+)?(build\s+)?v?\d+(\.\d+){1,3}\b"#, "", true),
            (#"\bbuild\s+\d+\b"#, "", true),
            (#"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b"#, "", false),
            (#",?\s*\bcode\s+[A-Z0-9]{4}-[A-Z0-9]{4}\b"#, "", true),
            (#"\b[A-Z0-9]{4}-[A-Z0-9]{4}\b"#, "", false),
            (#"\b(?![A-Z][a-z]+\.js\b)[\w-]+\.(swift|md|ts|tsx|mjs|js|json|sh|yml|yaml|html|css|py|txt)\b"#, "", false),
            (#"\b[\w-]+(\.[\w-]+)*\.(ai|com|dev|io|net|org|app)\b"#, "", true)
        ]
        for (pattern, template, anyCase) in rules {
            s = s.replacingOccurrences(of: pattern, with: template, options: anyCase ? [.regularExpression, .caseInsensitive] : .regularExpression)
        }
        s = tidy(s).replacingOccurrences(of: #"\b(server|cli|iphone|ios|phone|mac)(\s*,\s*(server|cli|iphone|ios|phone|mac))+\b"#,
                                         with: "", options: [.regularExpression, .caseInsensitive])
        return tidy(s)
    }

    private static func tidy(_ text: String) -> String {
        text
            .replacingOccurrences(of: #"\s+([,.!?:;])"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"([,:;])\s*[,:;]+"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"^[\s,;:.]+|[\s,;:]+$"#, with: "", options: .regularExpression)
    }

    /// Words a cut never ends on.
    private static let breakers: Set<String> = ["for", "on", "against", "with", "and", "so", "to", "in", "from", "by", "that",
        "of", "at", "into", "while", "because", "but", "or", "the", "a", "an", "then", "is", "are", "now", "its", "their", "as"]

    /// At most `max` words, cut at a word, never ending on a word like "the" or "and".
    static func capWords(_ text: String, _ max: Int) -> String {
        var words = text.split(separator: " ").map(String.init)
        if words.count > max {
            words = Array(words.prefix(max))
            while words.count > 2, let last = words.last,
                  breakers.contains(last.lowercased().filter(\.isLetter)) { words.removeLast() }
        }
        return words.joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: ",;: "))
    }

    private static func wordCount(_ text: String) -> Int { text.split(separator: " ").count }

    /// A file path of three or more parts: "/apps/notch/ReloCards.swift", "apps/notch/README.md", "~/Library/Caches".
    nonisolated(unsafe) private static let path = try! Regex(#"(?:~|\.{1,2}|[\w.@-]+)?(?:/[\w.@-]+){2,}/?"#)

    /// Ends with a full stop (or `end`) unless it already ends a sentence.
    static func sentence(_ text: String, end: String = ".") -> String {
        guard let last = text.last else { return text }
        return ".!?".contains(last) ? text : text + end
    }
}

/// A card's sealed words for the ear: the gist and the work's spoken name.
public struct SpokenText: Equatable, Sendable {
    public var gist: String?
    public var name: String?
    /// The producer's voice level for this card (`relo voice`); nil from an older CLI.
    public var voice: SpokenLine.Detail?

    public init(gist: String? = nil, name: String? = nil, voice: SpokenLine.Detail? = nil) {
        self.gist = gist
        self.name = name
        self.voice = voice
    }
}
