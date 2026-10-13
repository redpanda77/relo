import Foundation

public enum LiveActivityReinstallationRecoveryPolicy {
    public static func plan(
        pending: [LiveActivityCommandEnvelope],
        authoritativeCommands: [LiveActivityCommandEnvelope] = [],
        authoritativeActiveIdentities: Set<LiveActivityIdentity>,
        locallyActiveIdentities: Set<LiveActivityIdentity>,
        now: Date
    ) -> LiveActivityReinstallationRecoveryPlan {
        let missing = authoritativeActiveIdentities.subtracting(locallyActiveIdentities)
        guard !missing.isEmpty else {
            return .init(commands: pending, recoveryCommandKeys: [])
        }

        var newestByIdentity: [LiveActivityIdentity: LiveActivityCommandEnvelope] = [:]
        var seenCommandKeys = Set<String>()
        for envelope in authoritativeCommands + pending
        where seenCommandKeys.insert(envelope.commandKey).inserted
            && missing.contains(envelope.command.identity) {
            guard envelope.command.operation != .end else { continue }
            guard envelope.command.expiresAt.map({ $0 > now }) ?? true else { continue }
            if let current = newestByIdentity[envelope.command.identity] {
                let incoming = envelope.command.sequence ?? 0
                let existing = current.command.sequence ?? 0
                if incoming < existing { continue }
                if incoming == existing, envelope.createdAt < current.createdAt { continue }
                if incoming == existing,
                   envelope.createdAt == current.createdAt,
                   envelope.commandKey < current.commandKey { continue }
            }
            newestByIdentity[envelope.command.identity] = envelope
        }

        let recovery = newestByIdentity.values.sorted {
            if $0.command.activityId != $1.command.activityId {
                return $0.command.activityId < $1.command.activityId
            }
            return $0.command.generation < $1.command.generation
        }
        let recoveryKeys = Set(recovery.map(\.commandKey))
        return .init(
            commands: recovery + pending.filter { !recoveryKeys.contains($0.commandKey) },
            recoveryCommandKeys: recoveryKeys
        )
    }
}
