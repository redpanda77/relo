@preconcurrency import AVFoundation
import ReloCore
import SwiftUI
import UIKit
import VisionKit

/// Scans a Relo QR code in Settings → Devices: the `relo-link:1:…` code the web Dashboard shows (Link a browser), or
/// the sign-in link `relo auth login` shows on a computer (Sign in a computer). Uses VisionKit's data scanner where the
/// device supports it, else AVFoundation's QR reader.
struct CodeScannerView<Code>: View {
    let title: String
    /// What to point the camera at, and where the code comes from when the camera cannot be used.
    let hint: String
    let source: String
    /// A scanned or pasted text → the code, or an error whose description is shown.
    let parse: (String) throws -> Code
    /// Called once with a well-formed code; the caller dismisses the scanner.
    let onCode: (Code) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var camera: CameraState = .checking
    @State private var problem: String?
    @State private var lastRejected: String?
    @State private var delivered = false

    private enum CameraState { case checking, ready, denied, unavailable }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Color.black.ignoresSafeArea()
                switch camera {
                case .checking:
                    ProgressView().tint(.white).frame(maxWidth: .infinity, maxHeight: .infinity)
                case .ready:
                    scanner.ignoresSafeArea()
                case .denied:
                    message("Relo needs the camera to scan \(source). Allow Camera for Relo in Settings, or paste the code instead.")
                case .unavailable:
                    message("This device has no camera Relo can use. Paste \(source) instead.")
                }
                Text(problem ?? hint)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(problem == nil ? Color.white : Color.reloErrorText)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
                    .padding()
                    .accessibilityIdentifier("browser-link-scanner-hint")
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    PasteButton(payloadType: String.self) { strings in
                        if let text = strings.first { Task { @MainActor in handle(text) } }
                    }
                    .labelStyle(.iconOnly)
                }
            }
        }
        .task { camera = await Self.cameraState() }
    }

    @ViewBuilder private var scanner: some View {
        if DataScannerViewController.isSupported {
            DataScannerRepresentable { handle($0) }
        } else {
            MetadataScannerRepresentable { handle($0) }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func handle(_ text: String) {
        guard !delivered, text != lastRejected else { return }
        do {
            let code = try parse(text)
            delivered = true
            onCode(code)
        } catch {
            lastRejected = text
            problem = (error as? LocalizedError)?.errorDescription ?? "This is not a Relo code."
        }
    }

    private static func cameraState() async -> CameraState {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { return .denied }
        default: return .denied
        }
        return AVCaptureDevice.default(for: .video) == nil ? .unavailable : .ready
    }
}

private struct DataScannerRepresentable: UIViewControllerRepresentable {
    let onScan: @MainActor (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
            recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        Task { @MainActor in try? controller.startScanning() }
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        context.coordinator.onScan = onScan
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onScan: @MainActor (String) -> Void
        init(onScan: @escaping @MainActor (String) -> Void) { self.onScan = onScan }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue { onScan(value); return }
            }
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            if case .barcode(let barcode) = item, let value = barcode.payloadStringValue { onScan(value) }
        }
    }
}

private struct MetadataScannerRepresentable: UIViewControllerRepresentable {
    let onScan: @MainActor (String) -> Void

    func makeUIViewController(context: Context) -> MetadataScannerController {
        let controller = MetadataScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ controller: MetadataScannerController, context: Context) {
        controller.onScan = onScan
    }
}

private final class MetadataScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: (@MainActor (String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let box = SessionBox(session: session)
        DispatchQueue.global(qos: .userInitiated).async { box.session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let box = SessionBox(session: session)
        DispatchQueue.global(qos: .userInitiated).async { box.session.stopRunning() }
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection
    ) {
        guard let value = metadataObjects.lazy.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        // The delegate queue is the main queue.
        MainActor.assumeIsolated { onScan?(value) }
    }
}

/// AVCaptureSession is thread-safe for start/stop; Apple recommends calling them off the main thread.
private struct SessionBox: @unchecked Sendable { let session: AVCaptureSession }
