import ReloCore
import Foundation

public enum RuntimeServerOrigin {
    public static let defaultsKey = "relo.serverOrigin"

    public static func resolve(
        sharedOrigin: String?,
        localOrigin: String?,
        bundledOrigin: String?
    ) -> URL? {
        for value in [sharedOrigin, localOrigin, bundledOrigin] {
            guard
                let value,
                let candidate = URL(string: value),
                let origin = DashboardURLProvider(origin: candidate)?.origin
            else { continue }
            return origin
        }
        return nil
    }

    public static func current(bundle: Bundle = .main) -> URL? {
        let appGroup = bundle.object(forInfoDictionaryKey: "RELOAppGroup") as? String
        let shared = appGroup.flatMap(UserDefaults.init(suiteName:))
        return resolve(
            sharedOrigin: shared?.string(forKey: defaultsKey),
            localOrigin: UserDefaults.standard.string(forKey: defaultsKey),
            bundledOrigin: bundle.object(forInfoDictionaryKey: "RELOAPIOrigin") as? String
        )
    }

    public static func persist(_ origin: URL, bundle: Bundle = .main) {
        guard let normalized = DashboardURLProvider(origin: origin)?.origin else { return }
        UserDefaults.standard.set(normalized.absoluteString, forKey: defaultsKey)
        if
            let appGroup = bundle.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
            let shared = UserDefaults(suiteName: appGroup)
        {
            shared.set(normalized.absoluteString, forKey: defaultsKey)
        }
    }
}
