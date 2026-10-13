import CryptoKit
import Foundation
import ImageIO
import ReloCore
import UIKit

@MainActor
enum ImmutablePresentationAssetCache {
    // Widget snapshot rendering stays synchronous; repeat lookups reuse bounded thumbnails.
    private static let preparedImages: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 12; cache.totalCostLimit = 8 * 1_024 * 1_024
        return cache
    }()
    static func image(
        for reference: LiveActivityDisplayPresentation.AssetReference,
        accountID: String?
    ) -> UIImage? {
        guard NotificationMediaPolicy.accepts(reference),
              let accountID, ReloIdentifier.isValid(accountID),
              let appGroup = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        let key = "\(accountID)|\(reference.cacheFileName)" as NSString
        if let image = preparedImages.object(forKey: key) { return image }
        let url = root
            .appendingPathComponent("PresentationAssets", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent(reference.cacheFileName, isDirectory: false)
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size == reference.byteSize,
              let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
              data.count == reference.byteSize,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == reference.sha256,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 720,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary)
        else { return nil }
        let image = UIImage(cgImage: thumbnail)
        preparedImages.setObject(image, forKey: key, cost: thumbnail.bytesPerRow * thumbnail.height)
        return image
    }
}
