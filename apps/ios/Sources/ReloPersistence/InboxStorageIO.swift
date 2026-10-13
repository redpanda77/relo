import ReloCore
import Foundation

public struct FileInboxStorageIO: InboxStorageIO {
    public init() {}

    public func read(url: URL) throws -> Data { try Data(contentsOf: url) }

    public func replace(data: Data, at url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: ReloProtectedFileWritingOptions.complete)
    }

    public func remove(url: URL) throws { try FileManager.default.removeItem(at: url) }
}

enum InboxStorageFailure {
    static func isMissing(_ error: any Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code))
            || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
    }
}
