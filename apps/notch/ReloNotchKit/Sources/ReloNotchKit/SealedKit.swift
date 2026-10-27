import Foundation
import ReloCore
import ReloNotificationSupport

/// The Mac's sealed-content tools with the Keychain read once, not on every open. Opening a Now envelope loads the key
/// ring and the trusted computers and consults the name book; the Keychain is slow and the same answer every time, so
/// each is held in memory and written through when this app changes it. `invalidate()` forgets all of it (keys
/// published, a computer approved or declined, sign-out), and the next use reads the Keychain again.
struct SealedKit: Sendable {
    let content: ReloSealedContent
    let ring: ReloKeyRing
    let trust: ReloTrustedClients
    let names: CachedNameBook
    /// Bumped by `invalidate()`: work that started before it must not write what it learned afterwards.
    let generation: InvalidationGeneration
    private let ringStore: CachedKeyRingStore
    private let trustStore: CachedTrustedClientStore

    init(ring: ReloKeyRing, trust: ReloTrustedClients, ledger: (any ReloReplayLedger)?, nameBook: any ReloNameBook) {
        let ringStore = CachedKeyRingStore(ring.store)
        let trustStore = CachedTrustedClientStore(trust.store)
        let generation = InvalidationGeneration()
        let names = CachedNameBook(nameBook, generation: generation)
        self.generation = generation
        self.ringStore = ringStore
        self.trustStore = trustStore
        self.names = names
        self.ring = ReloKeyRing(store: ringStore, factory: ring.factory, policy: ring.policy)
        self.trust = ReloTrustedClients(store: trustStore)
        content = ReloSealedContent(ring: self.ring, trust: self.trust, ledger: ledger, nameBook: names)
    }

    static func live() -> SealedKit {
        let group = ReloKeyRing.sharedAccessGroup()
        return SealedKit(ring: .live(), trust: .live(), ledger: KeychainReplayLedger(accessGroup: group),
                         nameBook: KeychainNameBook(accessGroup: group))
    }

    /// Reads everything once (off the main thread), so the first Now to open finds it in memory.
    func warm() {
        _ = try? ringStore.load()
        _ = try? trustStore.load()
        _ = names.names()
    }

    func invalidate() {
        generation.bump()
        ringStore.invalidate()
        trustStore.invalidate()
        names.invalidate()
    }
}

final class InvalidationGeneration: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }
    func bump() { lock.withLock { count += 1 } }
}

final class CachedKeyRingStore: ReloKeyRingStore, @unchecked Sendable {
    private let inner: any ReloKeyRingStore
    private let lock = NSLock()
    private var cache: ReloKeyRingState??

    init(_ inner: any ReloKeyRingStore) { self.inner = inner }

    func load() throws -> ReloKeyRingState? {
        try lock.withLock {
            if let cache { return cache }
            let loaded = try inner.load()
            cache = .some(loaded)
            return loaded
        }
    }

    func save(_ state: ReloKeyRingState) throws {
        try lock.withLock {
            cache = nil
            try inner.save(state)
            cache = .some(state)
        }
    }

    func delete() throws {
        try lock.withLock {
            cache = nil
            try inner.delete()
        }
    }

    func invalidate() { lock.withLock { cache = nil } }
}

final class CachedTrustedClientStore: ReloTrustedClientStore, @unchecked Sendable {
    private let inner: any ReloTrustedClientStore
    private let lock = NSLock()
    private var cache: [ReloTrustedClient]?

    init(_ inner: any ReloTrustedClientStore) { self.inner = inner }

    func load() throws -> [ReloTrustedClient] {
        try lock.withLock {
            if let cache { return cache }
            let loaded = try inner.load()
            cache = loaded
            return loaded
        }
    }

    func save(_ clients: [ReloTrustedClient]) throws {
        try lock.withLock {
            cache = nil
            try inner.save(clients)
            cache = clients
        }
    }

    func invalidate() { lock.withLock { cache = nil } }
}

/// Handle → name held in memory. `names()` never touches the Keychain after the first read, and `learn` reaches the
/// Keychain only for a name it does not already hold (a handle another computer owns is offered once, not every fetch).
final class CachedNameBook: ReloNameBook, @unchecked Sendable {
    private let inner: any ReloNameBook
    private let generation: InvalidationGeneration
    private let state = NSLock()
    private let learning = NSLock()
    private var current: [String: String]?
    private var offered: Set<String> = []

    init(_ inner: any ReloNameBook, generation: InvalidationGeneration = InvalidationGeneration()) {
        self.inner = inner
        self.generation = generation
    }

    func names() -> [String: String] {
        let (held, started) = state.withLock { (current, generation.value) }
        if let held { return held }
        let loaded = inner.names()
        // A read that began before an invalidation is returned but never kept: it may be the old account's names.
        return state.withLock {
            if current == nil, generation.value == started { current = loaded }
            return current ?? loaded
        }
    }

    func learn(_ names: [String: String], sender: String) {
        let started = generation.value
        let known = self.names()
        let fresh = state.withLock {
            ReloNames.accepted(names).filter { known[$0.key] != $0.value && !offered.contains("\(sender)|\($0.key)|\($0.value)") }
        }
        guard !fresh.isEmpty else { return }
        learning.withLock {
            // Signed out (or keys changed) since this work started: nothing it learned is written back.
            guard generation.value == started else { return }
            inner.learn(fresh, sender: sender)
            let after = inner.names()
            state.withLock {
                guard generation.value == started else { return }
                for (handle, name) in fresh { offered.insert("\(sender)|\(handle)|\(name)") }
                current = after
            }
        }
    }

    func invalidate() {
        // Waits for a learn already writing, so none lands after this returns.
        learning.withLock {
            generation.bump()
            state.withLock {
                current = nil
                offered = []
            }
        }
    }
}
