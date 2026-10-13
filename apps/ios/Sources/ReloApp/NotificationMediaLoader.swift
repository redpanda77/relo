import ReloTransport
import ImageIO
import ReloCore
import SwiftUI
import UIKit

/// One bounded cache across row/detail loaders. Account identity is part of every key.
actor NotificationMediaLoader {
    static let shared = NotificationMediaLoader()
    private let cache = NSCache<NSString, UIImage>()
    init() { cache.countLimit = 64; cache.totalCostLimit = 24 * 1_024 * 1_024 }
    func image(url: URL, accountID: String?, maximumPixels: Int = 1200, maximumBytes: Int64 = 10_000_000) async throws -> UIImage {
        guard let key = NotificationMediaPolicy.Key(accountID: accountID, locator: url.absoluteString, maximumPixels: maximumPixels),
              NotificationImagePolicy.validatedURL(url) != nil else { throw URLError(.badURL) }
        let cacheKey = "\(key.accountID)|\(key.locator)|\(maximumPixels)" as NSString
        try Task.checkCancellation()
        if let image = cache.object(forKey: cacheKey) { return image }
        let data = try await NotificationMediaData.download(url: url, maximumBytes: maximumBytes)
        let image = try await decode(data, maximumPixels: maximumPixels)
        try Task.checkCancellation()
        cache.setObject(image, forKey: cacheKey, cost: Int(image.size.width * image.size.height) * 4)
        return image
    }
    func immutable(_ reference: LiveActivityDisplayPresentation.AssetReference, accountID: String?) async throws -> UIImage {
        guard let key = NotificationMediaPolicy.Key(accountID: accountID, locator: reference.cacheFileName, maximumPixels: 1200),
              NotificationMediaPolicy.accepts(reference),
              let group = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw URLError(.fileDoesNotExist) }
        let cacheKey = "\(key.accountID)|\(key.locator)|1200" as NSString
        try Task.checkCancellation()
        if let image = cache.object(forKey: cacheKey) { return image }
        let file = root.appendingPathComponent("PresentationAssets", isDirectory: true)
            .appendingPathComponent(key.accountID, isDirectory: true).appendingPathComponent(reference.cacheFileName)
        let data = try await NotificationMediaData.read(file: file, maximumBytes: 10_000_000,
            digest: reference.sha256, exactSize: reference.byteSize)
        let image = try await decode(data, maximumPixels: 1200)
        try Task.checkCancellation()
        cache.setObject(image, forKey: cacheKey, cost: Int(image.size.width * image.size.height) * 4)
        return image
    }
    private func decode(_ data: Data, maximumPixels: Int) async throws -> UIImage {
        let task = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: maximumPixels,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true
                  ] as CFDictionary) else { throw URLError(.cannotDecodeContentData) }
            try Task.checkCancellation()
            return UIImage(cgImage: image)
        }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}

struct ReloImmutableImage: View {
    let reference: LiveActivityDisplayPresentation.AssetReference
    let accountID: String?
    let row: Bool
    @State private var image: UIImage?
    var body: some View {
        ReloMediaViewport(height: row ? 96 : 240) {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: reference.contentMode == .fit ? .fit : .fill)
            } else { Label("Image unavailable", systemImage: "photo").font(.footnote).foregroundStyle(Color.reloSecondaryText) }
        }
        .background(Color.reloMediaPlaceholder).clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(reference.altText)
        .task(id: "\(accountID ?? "none")|\(reference.cacheFileName)") {
            image = nil
            let loaded = try? await NotificationMediaLoader.shared.immutable(reference, accountID: accountID)
            guard !Task.isCancelled else { return }; image = loaded
        }
    }
}

struct ReloRemoteImage: View {
    let url: URL
    let accountID: String?
    let altText: String
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        ReloMediaViewport(height: 240) {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if failed { Label("Image unavailable", systemImage: "photo").foregroundStyle(Color.reloSecondaryText) }
            else { ProgressView().tint(.reloInteractive) }
        }
        .background(Color.reloMediaPlaceholder).clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityLabel(altText)
        .task(id: "\(accountID ?? "none")|\(url)") {
            image = nil; failed = false
            do {
                let loaded = try await NotificationMediaLoader.shared.image(url: url, accountID: accountID)
                guard !Task.isCancelled else { return }; image = loaded
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}
