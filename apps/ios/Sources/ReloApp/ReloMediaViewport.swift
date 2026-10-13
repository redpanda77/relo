import SwiftUI

/// Loading, failure, and image pixels all use the same layout allocation.
/// An overlay prevents intrinsic image dimensions from resizing the surrounding feed.
struct ReloMediaViewport<Content: View>: View {
    let height: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        Color.clear
            .frame(height: height)
            .overlay {
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .clipped()
    }
}
