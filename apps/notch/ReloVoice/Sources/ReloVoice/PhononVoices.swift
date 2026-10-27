import Foundation

/// The Relo voice's speakers. Phonon speaks as whoever a small voice file (one 1×512×125 `speaker_wavs` tensor,
/// 256 KB) describes; Relo ships `default-voice.safetensors` and the owner may pick another. The others come from
/// Gradium's catalog (`gradium/phonon-voices`, Apache-2.0) at one pinned revision, each file checked against its
/// SHA-256 like the model's, and fetched only when picked. Only the English ones: the 31M model speaks English.
public struct PhononVoice: Sendable, Identifiable, Equatable {
    public enum Kind: String, Sendable, CaseIterable {
        case female, male, character
    }

    public var id: String
    public var name: String
    public var kind: Kind
    /// "American" or "British"; nil for a character.
    public var accent: String?
    public var age: String?
    public var description: String
    public var sha256: String

    public static let bytes: Int64 = 256_136
    public static let repo = "gradium/phonon-voices"
    public static let revision = "0ee17205f254b5abc43b266c8a0f215565c352f7"

    /// The voice that ships with the model; what speaks unless the owner picks another.
    public static let defaultID = "default"

    var url: URL { URL(string: "https://huggingface.co/\(Self.repo)/resolve/\(Self.revision)/voices/\(id).safetensors")! }

    public static func named(_ id: String) -> PhononVoice? { english.first { $0.id == id } }

    /// Gradium's English voices: 13 women and 12 men (American and British), then 12 characters.
    public static let english: [PhononVoice] = [
        PhononVoice(id: "gfP44RlHwr2kEwk7", name: "Bryony", kind: .female, accent: "British", age: "Middle-age",
                    description: "Full, rich mid-range tones, softly relaxed and spoken close to the mic, moving briskly with light pitch play.",
                    sha256: "bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b"),
        PhononVoice(id: "y9bQqIDnyxwqK01t", name: "Elodie-Rose", kind: .female, accent: "British", age: "Young",
                    description: "A young British voice with sharp, enthusiastic energy and crisp articulation, sparky and to the point for customer support and care.",
                    sha256: "21eade9d83b2e66b9364e1b6cd999a3a6704c000a71f27f34e05ace5cdfd58bb"),
        PhononVoice(id: "GgfEkEJtxZR7gnpy", name: "Freya", kind: .female, accent: "British", age: "Young",
                    description: "A young British voice, glossy and confident with fast, girly chatter and bubbly sparkle, perfect for a friendly receptionist or assistant.",
                    sha256: "eb3cd47418349e618408c16bea7153988b3ad04b41a6033039dd474a9a4dcd23"),
        PhononVoice(id: "gDT1nz7Ie36ZhL-C", name: "Imogen", kind: .female, accent: "British", age: "Adult",
                    description: "A bubbly, friendly British English adult voice that puts callers instantly at ease. Great for onboarding assistants and warm concierge interactions.",
                    sha256: "1980ab3c35fa98a25b5f3b5e643fd852e14ca8a12a4a26b06aaf1abf2a8c68b1"),
        PhononVoice(id: "m9MxpY6IUGXtWp76", name: "Lottie", kind: .female, accent: "British", age: "Young Adult",
                    description: "Sparky and to the point, high forward energy with clean edges on the consonants and the range to drop low for one line then climb back.",
                    sha256: "a906ebf17e43fded12b3d6bd077abb2df33bc86eff51c1beeb82e5d416527db3"),
        PhononVoice(id: "6PWnV0Nq4wu7RVBT", name: "Maeve", kind: .female, accent: "British", age: "Adult",
                    description: "A sparky, attentive British English adult voice that gets to the point with a smile. Ideal for fast, efficient customer support and helpful voice assistants.",
                    sha256: "56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844"),
        PhononVoice(id: "uem82D50GRv2Dwma", name: "Pippa", kind: .female, accent: "British", age: "Adult",
                    description: "A confident, upbeat British English adult voice with infectious energy. Perfect for proactive assistants and motivating customer success calls.",
                    sha256: "d41a8f01d6e33450f1ce062d332914da10beee99e585dab531750706f187c48a"),
        PhononVoice(id: "nGzMHMPAWGaJFHOo", name: "Delia", kind: .female, accent: "American", age: "Middle-age",
                    description: "Low, grounded and quick to the point, with a sincerity that keeps an apology honest.",
                    sha256: "a0c3dcb91b2247eca56536be9ae8e8becc1c807b1136c5fe101552d6a155b24a"),
        PhononVoice(id: "vjFyp2BcCyTlUmYb", name: "Everly", kind: .female, accent: "American", age: "Middle-age",
                    description: "Rounded, soft-edged tone with gentle lift at the end of phrases and an easy, relaxed delivery.",
                    sha256: "958ea94da14f46dd48c7f64adac11ed2ad2aa45f7ccd165dfebab5272664402e"),
        PhononVoice(id: "bXwrkHhURL1VFJdG", name: "Hadley", kind: .female, accent: "American", age: "Middle-age",
                    description: "Settled, even-toned and genuinely kind, with crisp consonants that hold up over a handset.",
                    sha256: "a879938aa9a2df0a8220bdadef88137929f71e887bd91e7db205bd5fa11661d2"),
        PhononVoice(id: "4SZHfMpw-p46Ywgs", name: "Harper", kind: .female, accent: "American", age: "Adult",
                    description: "Modern, confident and friendly voice with a standard American accent.",
                    sha256: "6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123"),
        PhononVoice(id: "NIWIOv5vTi5eRMj8", name: "Juniper", kind: .female, accent: "American", age: "Young Adult",
                    description: "Cheerful presence with real resonance under it, personable when the copy turns intimate and decisive on the final line.",
                    sha256: "444378eb06b7c492b86e8fc7d13e4db1a3c0cf3e68891a960bf6f0a41a13ef35"),
        PhononVoice(id: "NbpkqMVS3CJeq2j8", name: "Zoey", kind: .female, accent: "American", age: "Adult",
                    description: "Playful, upbeat and Gen Z energy voice with a standard American accent. Perfect for engaging conversations!",
                    sha256: "97c7f8c253413574406ab80dd23f49c3ebb2517163b00a9bf86b9c4cf43e7e23"),
        PhononVoice(id: "X6NceqF285Gr04gb", name: "Alfie", kind: .male, accent: "British", age: "Young Adult",
                    description: "Punchy and forward, with crisp consonant attack and a pitch that lifts across a line, sitting high over a music bed.",
                    sha256: "4de75497fff3030168e8aa6dca23ffeb332b1bc8c25d0bf3507ceadac953ae9c"),
        PhononVoice(id: "zUCxzrOrugTSis03", name: "Edwin", kind: .male, accent: "British", age: "Middle-age",
                    description: "Efficient and firm, sincere in attention, with tidy articulation that holds up at phone bandwidth.",
                    sha256: "ff1d0735b8b45710462b1d1f846da040f970c6eb62c7c2f36dbfb8e5bde74f1e"),
        PhononVoice(id: "YyKcxPG7iIgS3jsK", name: "Hugh", kind: .male, accent: "British", age: "Middle-age",
                    description: "Soft and close, airy in texture, with lively pitch movement and an attentive, sincere delivery.",
                    sha256: "3169d74b47a54d1eb15e4c243f56393abe9fe90c7e1c308ecf96ee67618b152a"),
        PhononVoice(id: "JOW0vchyswkQUMDS", name: "Spencer", kind: .male, accent: "British", age: "Middle-age",
                    description: "Light and airy, sitting a touch higher, with crisp consonants and a slow, patient delivery.",
                    sha256: "cc9ac1107b0ffce282374a19beb7bfa95847724e6b7afbac991b4ae4277d5e6d"),
        PhononVoice(id: "Zn7g6NxLqXlJb7Qi", name: "Teddy", kind: .male, accent: "British", age: "Young Adult",
                    description: "Sparky and close in, quick off the mark, with firm consonants and the range to drop right down for a clause then come back up.",
                    sha256: "baea0ea9506f3237a5ebfc61afb7c72dbd189c5603b199ef42fbb00dbda379e0"),
        PhononVoice(id: "dME3IWyZBvmh1n1q", name: "Toby", kind: .male, accent: "British", age: "Adult",
                    description: "A sparky, attentive British English adult voice that gets to the point with a smile. Ideal for fast, efficient customer support and helpful voice assistants.",
                    sha256: "09ab315c7f4b72b4d71e66cb756184cedfb1f14d222d096e115bf95bfe7b29dc"),
        PhononVoice(id: "LMDIYE0Oa377Qh6Z", name: "Easton", kind: .male, accent: "American", age: "Young Adult",
                    description: "Punchy and close in, with crisp consonant attack that cuts through a music bed and pitch that lifts across each line.",
                    sha256: "45c582673cb20edb04ddcca2b5a8865ddfb0a82599efadb269021e87d20fbdd4"),
        PhononVoice(id: "40QrMVgAxFiUnP9f", name: "Micah", kind: .male, accent: "American", age: "Young Adult",
                    description: "Buoyant and high in energy, with a playful lift at the ends of phrases and clean attack that survives a loud mix.",
                    sha256: "0de1098d1051686a138d068e83ff09deb5053328bc74ec9541a1fdb90bfc24da"),
        PhononVoice(id: "d9XCyhjo4JhkHF1d", name: "Miles", kind: .male, accent: "American", age: "Young Adult",
                    description: "Resonant and decisive, with genuine dynamic range, dropping right down for one clause then driving back up.",
                    sha256: "eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8"),
        PhononVoice(id: "qIxlZ7Ei8KvWlyQH", name: "Preston", kind: .male, accent: "American", age: "Middle-age",
                    description: "Trim, focused delivery with clean edges on every consonant and a steady, low-set core that carries through phone bandwidth.",
                    sha256: "6e04b84d3ae8751b22bca0a4f63936f9cb648f4f2182b2d0788071ea1c0b68a1"),
        PhononVoice(id: "_6Aslh2DxfmnRLmP", name: "Russell", kind: .male, accent: "American", age: "Adult",
                    description: "A high-energy American adult voice that pushes and encourages with the intensity of someone who genuinely believes in you.",
                    sha256: "beae9e4030efce0a935fcb0f807dc0784d598bcaa87ad4aacb047436b1eaa411"),
        PhononVoice(id: "0zLApsZfVLLNaEGl", name: "Trevor", kind: .male, accent: "American", age: "Middle-age",
                    description: "Buoyant energy over a resonant mid-low core, phrases landing softly and consonants cutting through a handset.",
                    sha256: "dc1341c8937af5534e6bbcc5c0fc5e7c10312229b59061228074f93683fe2261"),
        PhononVoice(id: "dGyGDKo2osj7h3s7", name: "Azgorath", kind: .character, accent: nil, age: nil,
                    description: "An enormous ancient demon. A cavernous, impossibly deep bass voice that rumbles like stone grinding in a crypt, with a dry rasping edge and a faint hiss on every s. Calm, slow and amused, never shouting, every syllable set down deliberately, menace held under perfect control.",
                    sha256: "83900e020c14946426614c6553c5a138ba6277e1aaa69832223bd0f0f8b73893"),
        PhononVoice(id: "xPDpsV3F592srkjA", name: "Captain Silas Blackwater", kind: .character, accent: nil, age: nil,
                    description: "An old British pirate captain from the West Country, around sixty. Deep, gravelly and booming, rolling his Rs, salt-cracked from decades of shouting over gales. Roguish and hearty, with a wicked chuckle under every boast.",
                    sha256: "a09f615b0084980ebc4076d71550bf73ccd8d4df076bbbee4a9beb523a1379d9"),
        PhononVoice(id: "QXNr0SvkukLB4wPq", name: "Fairy Godmother", kind: .character, accent: nil, age: nil,
                    description: "A kind fairy godmother, an older woman in her sixties. A low, warm, velvety alto voice, cosy and grandmotherly, unhurried and soothing, with a soft rich chuckle and a twinkle in every word. Gentle and reassuring, never high, never thin.",
                    sha256: "f390c09f5e279c0f2171995a534b92f5ca5c83443906879da68fc27445f89d89"),
        PhononVoice(id: "cXoIXJ2llS8S0WOW", name: "Fennick the Young Elf", kind: .character, accent: nil, age: nil,
                    description: "A curious, kind-hearted elf boy of about ten. A natural child's voice in a warm, soft middle range, never squeaky or shrill, earnest and wide-eyed, a little breathless with excitement, speaking quickly when amazed. Clean, close studio recording with no background noise or hiss.",
                    sha256: "a05944e4c69d61d10d66f689175ba0b081930df2d77b22f04d00ac40d3d69ecb"),
        PhononVoice(id: "cYtsRSxV5q9IMehn", name: "Grub the Ogre", kind: .character, accent: nil, age: nil,
                    description: "A big, good-natured ogre who lives under a bridge. Gruff and grainy, rumbling low end, heavy chest resonance, slow lumbering rhythm with loose rounded words, and warm humour sitting just under the grumble.",
                    sha256: "b30fa847686ec1eb6be8c5bea4b6a5c5076ea66c3ff053cf98210a155d8aad1e"),
        PhononVoice(id: "gSgG5Tor0GPEnqzC", name: "Master Aldric", kind: .character, accent: nil, age: nil,
                    description: "A wise old British wizard, around eighty. Rich and resonant with an aged grain, warm and kindly, deliberate pace with weighted pauses before the words that matter, able to rise into a ringing incantation.",
                    sha256: "a83430cc022b85c83753f859f9e44f406651646dab994fced8ef7a9a88005971"),
        PhononVoice(id: "nOykTmcH9ydsGGIc", name: "Morwenna of the Deep", kind: .character, accent: nil, age: nil,
                    description: "A sultry, seductive woman in her thirties. Low, husky alto, close to the microphone and almost whispered, slow and languid, purring, with a warm knowing smile in every word. Intimate, flirtatious and teasing, like a late-night torch singer luring someone closer, with a hint of danger underneath.",
                    sha256: "2ff2db91e70648623df8d42c0dcd7c336b2f14cb4362d602a20f292a4d862154"),
        PhononVoice(id: "lX3LavMNdlIbgEHH", name: "Old Mortlake", kind: .character, accent: nil, age: nil,
                    description: "An elderly gravedigger in a Victorian churchyard. Low, raspy and half whispered, melancholic, with heavy pauses that let every word settle like dirt on a coffin lid.",
                    sha256: "d3f9429205e5906dcd3c78edaf7c9d5148c7e389e34c82c86f72f154adb5d923"),
        PhononVoice(id: "y2eiKxtQo2B67deU", name: "Sir Bramwell", kind: .character, accent: nil, age: nil,
                    description: "A brave but pompous English knight, middle-aged. Booming, plummy and theatrical, full of puffed-up self-importance, rolling grand phrases, with a comic wobble of nerves showing through the bravado.",
                    sha256: "b3cea6789aeb58822af16ba08c4e5105d7febb840dcb67b47f426c19d1a8f209"),
        PhononVoice(id: "NIWoEurJHMJjyUTe", name: "The Snow Queen", kind: .character, accent: nil, age: nil,
                    description: "A regal, cold-hearted queen of ice. A cool, crystalline mezzo voice, poised and elegant, precise articulation, unhurried and quietly commanding, with an enigmatic chill and a faint smile that never warms.",
                    sha256: "bc8a8fcb95bb4f32d2d4376aa69d81b186b3ba2f8e9b6cb6a403b2b194590e85"),
        PhononVoice(id: "GXaSqMEmOg12OIYb", name: "The Thing Under the Stairs", kind: .character, accent: nil, age: nil,
                    description: "A monstrous creature lurking in the dark. Gravelly, breathy and pitched near the floor, a threatening growl that stays quiet to stay frightening, with a slow mocking sneer.",
                    sha256: "bfa37bac98aefbb9de80f792c47d01a0f9e3b94e73776169040c249c8b722759"),
        PhononVoice(id: "xO8xQo3BrB8FuI6J", name: "Vyrmathrax the Ancient", kind: .character, accent: nil, age: nil,
                    description: "An ancient dragon, thousands of years old. Very low and resonant, deep chest weight with gravel at the bottom of the register, slow and controlled with long pauses, dry and offhand, with the flat calm of something far too old to be impressed.",
                    sha256: "63ab4b15427844a804480a1603774262e8903dee33cb279e2749860dbfaedd10")
    ]
}
