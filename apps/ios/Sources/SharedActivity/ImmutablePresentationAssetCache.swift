import CryptoKit
import Foundation
import ReloCore
import UIKit

enum ImmutablePresentationAssetCache {
    static func image(
        for reference: LiveActivityDisplayPresentation.AssetReference,
        accountID: String?
    ) -> UIImage? {
        guard let accountID, ReloIdentifier.isValid(accountID),
              let appGroup = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        let url = root
            .appendingPathComponent("PresentationAssets", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent(reference.cacheFileName, isDirectory: false)
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
              data.count == reference.byteSize,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == reference.sha256,
              let image = UIImage(data: data), image.size.width > 0, image.size.height > 0
        else { return nil }
        return image
    }
}
