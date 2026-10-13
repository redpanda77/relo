import Foundation
import ReloCore

/// Validation applies to the original request, every redirect, the final URL and downloaded size.
public enum NotificationMediaData {
    public static func download(url: URL, maximumBytes: Int64) async throws -> Data {
        guard NotificationImagePolicy.validatedURL(url) != nil else { throw URLError(.badURL) }
        try Task.checkCancellation()
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.urlCache = nil
        let session = URLSession(configuration: config, delegate: BoundedMediaDownloadDelegate(maximumBytes: maximumBytes), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8; request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (file, response) = try await session.download(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let finalURL = response.url, NotificationImagePolicy.validatedURL(finalURL) != nil else {
            throw URLError(.badServerResponse)
        }
        return try await read(file: file, maximumBytes: maximumBytes, expectedLength: response.expectedContentLength)
    }
    public static func read(file: URL, maximumBytes: Int64, expectedLength: Int64 = -1,
                            digest: String? = nil, exactSize: Int? = nil) async throws -> Data {
        try Task.checkCancellation()
        let task = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            let size = Int64(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            guard NotificationMediaPolicy.accepts(byteCount: size, maximumBytes: maximumBytes, expectedLength: expectedLength) else {
                throw URLError(.dataLengthExceedsMaximum)
            }
            let data = try Data(contentsOf: file, options: [.mappedIfSafe])
            guard NotificationMediaPolicy.accepts(byteCount: Int64(data.count), maximumBytes: maximumBytes, expectedLength: expectedLength) else { throw URLError(.dataLengthExceedsMaximum) }
            if let digest, let exactSize, !NotificationMediaPolicy.matches(data, byteSize: exactSize, sha256: digest) {
                throw URLError(.cannotDecodeContentData)
            }
            try Task.checkCancellation()
            return data
        }
        return try await withTaskCancellationHandler {
            let data = try await task.value
            try Task.checkCancellation(); return data
        } onCancel: { task.cancel() }
    }
}

final class BoundedMediaDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let maximumBytes: Int64
    init(maximumBytes: Int64) { self.maximumBytes = maximumBytes }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        guard let url = request.url, NotificationImagePolicy.validatedURL(url) != nil else { return nil }
        return request
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > maximumBytes || totalBytesExpectedToWrite > maximumBytes { downloadTask.cancel() }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}
