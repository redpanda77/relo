import Foundation

public enum ReloIdentifier {
    public static func isValid(_ value: String) -> Bool {
        guard (1...200).contains(value.count) else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return value.unicodeScalars.allSatisfy(allowed.contains)
    }
}
