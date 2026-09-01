#if !SWIFT_PACKAGE
import Foundation

private final class ReloCoreTestsBundleMarker {}

extension Bundle {
    static let module = Bundle(for: ReloCoreTestsBundleMarker.self)
}
#endif
