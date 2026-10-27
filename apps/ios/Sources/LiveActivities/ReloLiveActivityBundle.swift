import ReloCore
import ReloNotificationSupport
import SwiftUI
import WidgetKit

@main
struct ReloLiveActivityBundle: WidgetBundle {
    /// End-to-end sealed cards open on this phone while their state is decoded (E5). This process
    /// has no Keychain, so it reads the widget mirror the app and the extension keep current.
    init() {
        ReloWidgetKeyMirror.installLabelMemory()
        let sealed = ReloSealedContent.live(widget: true)
        ReloSealedCards.install(sealed.cardOpener(log: ReloSealedOpenLog.live()))
        if let book = sealed.nameBook { ReloSealedCards.installNames { book.names() } }
    }

    /// Exactly one activity configuration per OS. The builder has an `if #available` but no
    /// `else`, so both branches are composed here; registering both would duplicate the card.
    var body: some Widget {
        WidgetBundleBuilder.buildBlock(
            WidgetBundleBuilder.buildOptional(watchCapable),
            WidgetBundleBuilder.buildOptional(phoneOnly),
            ReloSetupActivityWidget())
    }

    private var watchCapable: (any Widget & _LimitedAvailabilityWidgetMarker)? {
        guard #available(iOS 18.0, *) else { return nil }
        return WidgetBundleBuilder.buildLimitedAvailability(ReloLiveActivityWatchWidget())
    }

    private var phoneOnly: (any Widget & _LimitedAvailabilityWidgetMarker)? {
        if #available(iOS 18.0, *) { return nil }
        return WidgetBundleBuilder.buildLimitedAvailability(ReloLiveActivityWidget())
    }
}
