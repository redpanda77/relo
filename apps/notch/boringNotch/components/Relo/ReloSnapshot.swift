//
//  ReloSnapshot.swift
//  Relo Notch
//
//  Debug builds only: `--relo-snapshot` reads an owner-state fixture on stdin, renders the Relo notch
//  views from it and prints each PNG as `relo-snapshot <name> <base64>`, then quits. The sandbox keeps
//  files out, so the bytes travel over stdio.
//

#if DEBUG
import AppKit
import ReloCore
import ReloNotchKit
import SwiftUI

@MainActor
enum ReloSnapshot {
    static func runIfRequested() -> Bool {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--relo-onboarding-snapshot") { onboarding(); return true }
        if arguments.contains("--relo-click-probe") { clickProbe(); return true }
        if arguments.contains("--relo-agents-snapshot") { agentsPage(); return true }
        if arguments.contains("--relo-system-snapshot") { systemStates(); return true }
        guard arguments.contains("--relo-snapshot") else { return false }
        do {
            struct Fixture: Decodable { let nowSummary: NowSummary }
            var summary = try ReloWireJSON.decoder().decode(Fixture.self, from: FileHandle.standardInput.readDataToEndOfFile()).nowSummary
            summary.needsYou = summary.needsYou.map { item in
                var item = item
                item.notificationId = "ntf_snapshot"
                item.question = try? ReloWireJSON.decoder().decode(NowItem.Question.self, from: Data(
                    #"{"id":"int_snapshot","standing":"pending","askedAt":"2026-10-14T09:58:00.000Z"}"#.utf8))
                return item
            }
            ReloNotch.store.showPreview(summary, questions: ["ntf_snapshot": .init(
                prompt: "Deploy server 0.18.108 and Relo for Mac 0.2.22 to production now?", kind: .approval, options: [], expiresAt: .distantFuture)])
            let vm = BoringViewModel(screenUUID: NSScreen.main?.displayUUID)
            vm.hideOnClosed = false
            if arguments.contains("--relo-bench") {
                try bench(vm: vm)
                return true
            }
            print("relo-snapshot info closed=\(vm.closedNotchSize) height=\(vm.effectiveClosedNotchHeight) focus=\(ReloNotch.store.presentation.focus?.id ?? "nil")")
            try render(ReloClosedActivity().environmentObject(vm).fixedSize().padding(.horizontal, cornerRadiusInsets.closed.bottom)
                .background(.black).clipShape(NotchShape(topCornerRadius: 6, bottomCornerRadius: 14)),
                       named: "closed")
            // The fixture's pending question expands the closed notch on appear: the wings must leave it black.
            try render(ReloClosedActivity().environmentObject(vm).fixedSize().padding(.horizontal, cornerRadiusInsets.closed.bottom)
                .background(.black).clipShape(NotchShape(topCornerRadius: 6, bottomCornerRadius: 14)),
                       named: "closed-expanded", settle: 1.2)
            try render(openFrame(ReloNotchView().environmentObject(vm)).clipShape(NotchShape(topCornerRadius: 19, bottomCornerRadius: 24)), named: "open")
            let presentation = ReloNotch.store.presentation
            // Collapsed cards share one height whatever they carry; the opened one shows its whole text and plan.
            let live = presentation.sections.filter { !$0.isFolded && $0.kind != .recent }.flatMap(\.rows)
            try render(VStack(spacing: ReloCardMetrics.itemSpacing) {
                ForEach(live) { row in ReloWorkCard(row: row, hero: row.tone == .needsYou) }
                if let opened = live.first(where: { $0.tone == .working }) { ReloWorkCard(row: opened, expanded: true) }
            }
            .frame(width: reloOpenNotchSize.width - 62).padding(16).background(.black), named: "cards")
            // The list's tail: the Quiet moon line, closed and opened, and the computers at work.
            let folded = presentation.sections.filter(\.isFolded)
            try render(VStack(alignment: .leading, spacing: ReloCardMetrics.itemSpacing) {
                if !folded.isEmpty {
                    ReloQuietLine(sections: folded, open: false)
                    ReloQuietLine(sections: folded, open: true)
                }
                ReloCardGroup(items: presentation.machines) { ReloMachineRow(machine: $0) }
            }
            .frame(width: reloOpenNotchSize.width - 62).padding(16).background(.black), named: "tail", settle: 1.4)
            ReloWorkList.snapshotOpened = presentation.sections.first { $0.kind == .running }?.rows.first?.id
            try render(openFrame(ReloNotchView().environmentObject(vm)).clipShape(NotchShape(topCornerRadius: 19, bottomCornerRadius: 24)),
                       named: "open-opened", settle: 0.6)
            ReloWorkList.snapshotOpened = nil
            for (kind, row) in [(NotchEvent.Kind.question, presentation.sections[0].rows[0]),
                                (.started, presentation.sections.first { $0.kind == .running }!.rows[0]),
                                (.failed, presentation.sections.first { $0.kind == .recent }!.rows[0])] {
                try render(VStack(spacing: 0) {
                    Color.black.frame(width: 420, height: vm.effectiveClosedNotchHeight)
                    ReloExpandedCard(event: NotchEvent(kind: kind, row: row), row: row, openedAt: .distantPast)
                }
                .background(.black).clipShape(NotchShape(topCornerRadius: 6, bottomCornerRadius: 14)), named: "expanded-\(kind.rawValue)")
            }
            SystemMonitor.shared.start()
            RunLoop.main.run(until: Date().addingTimeInterval(9))
            try render(SystemView().frame(width: 640 - 62, height: 250 - 32 - 12 - 8)
                .padding(.horizontal, 31).padding(.top, 40).padding(.bottom, 12).background(.black)
                .clipShape(NotchShape(topCornerRadius: 19, bottomCornerRadius: 24)), named: "system")
            try render(ReloHomeView(openNotch: {}).frame(width: 720, height: 540), named: "home", settle: 0.8)
            try renderSwiftUI(ReloHomeView(openNotch: {}).frame(width: 720, height: 540), named: "home-swiftui")
            ReloNotch.store.showPreview(NowSummary.empty(at: summary.serverTime))
            try render(openFrame(ReloNotchView().environmentObject(vm)).clipShape(NotchShape(topCornerRadius: 19, bottomCornerRadius: 24)), named: "open-empty")
            try render(ZStack { ReloAurora(); VStack(spacing: 40) { ReloOrb(mood: .clear).frame(width: 150, height: 150); ReloWordmark(size: 52) } }.frame(width: 560, height: 520), named: "welcome", settle: 0.5)
            // The onboarding's live example, once its notch has opened onto the running card.
            try render(ReloNotchDemo().padding(20).background(Color(white: 0.16)), named: "onboarding-demo", settle: 3.4)
        } catch {
            print("relo-snapshot failed: \(error)")
        }
        return true
    }

    /// Settings' Agents page with a few harnesses, set up and not, signed in to a server whose agents cannot report yet.
    private static func agentsPage() {
        ReloAgents.shared.preview([
            .init(id: "claude-code", name: "Claude Code", level: "optimize", outdated: false),
            .init(id: "codex", name: "Codex", level: "guide", outdated: true),
            .init(id: "antigravity", name: "Antigravity", level: "none", outdated: false),
            .init(id: "gemini", name: "Gemini CLI", level: "none", outdated: false),
        ], signIn: .init(signedIn: false, server: nil),
           notes: ["codex": .init(text: "Done. Restart Codex to pick it up. In Codex, open /hooks and trust Relo's hooks.", failed: false)])
        do {
            try render(ReloAgentsSettingsView().frame(width: 700, height: 760).background(Color(white: 0.08)), named: "agents", settle: 1)
        } catch { print("relo-snapshot failed-agents \(error)") }
    }

    /// The System tab in each state it leads with, from fixed samples (the study's board G).
    private static func systemStates() {
        let n = 60
        func series(_ f: (Int) -> Double) -> [Double] { (0..<n).map(f) }
        let calm = series { max(0.02, (7 + 3 * sin(Double($0) * 0.7) + 2 * sin(Double($0) * 1.9 + 1) + ($0 > 54 ? Double($0 - 54) * 1.6 : 0)) / 100) }
        let busy = series { i in i < 8 ? (9 + 3 * sin(Double(i))) / 100 : min(0.98, (70 + 22 * (1 - exp(-Double(i - 8) / 6)) + 3 * sin(Double(i) * 1.7)) / 100) }
        let middling = series { (62 + 8 * sin(Double($0) * 0.5) + 4 * sin(Double($0) * 1.7)) / 100 }
        let heat = series { i in i < 10 ? 48 + sin(Double(i)) : 48 + 48 * (1 - exp(-Double(i - 10) / 14)) }
        let network = series { 26_000 + 14_000 * abs(sin(Double($0) * 0.9)) + ($0 > 38 && $0 < 44 ? 260_000 : 0) + ($0 > 56 ? 100_000 : 0) }
        let swap = series { i in i < 12 ? 50_000_000 : min(3.1e9, 5e7 + 3.05e9 * (1 - exp(-Double(i - 12) / 16))) }
        let gb: UInt64 = 1_073_741_824
        var base = SystemMonitor.Sample()
        base.cpu = 0.16
        base.cores = [0.18, 0.11, 0.09, 0.07, 0.42, 0.31, 0.22, 0.12, 0.05, 0.04, 0.03, 0.03]
        base.temperature = 46
        base.clocks = .init(performance: 2.1, efficiency: 1.3, performanceMax: 4.5)
        base.memoryTotal = 24 * gb
        base.memoryUsed = UInt64(17.2 * Double(gb)); base.memoryWired = UInt64(3.2 * Double(gb)); base.memoryCompressed = UInt64(1.1 * Double(gb))
        base.storageFree = 78_000_000_000; base.storageTotal = 460_000_000_000
        base.downBytesPerSecond = 31_000; base.upBytesPerSecond = 116_000
        base.battery = 1; base.charging = false
        var busyState = base
        busyState.cpu = 0.94; busyState.temperature = 71
        busyState.cores = [0.81, 0.77, 0.86, 0.72, 0.99, 0.97, 0.98, 0.95, 0.96, 0.93, 0.97, 0.94]
        busyState.clocks = .init(performance: 4.4, efficiency: 2.6, performanceMax: 4.5)
        busyState.memoryUsed = UInt64(19.8 * Double(gb))
        busyState.busiest = [.init(name: "Xcode", value: 0.83), .init(name: "Safari", value: 0.06)]
        var hot = busyState
        hot.temperature = 96; hot.thermal = .serious
        hot.clocks = .init(performance: 3.9, efficiency: 2.4, performanceMax: 4.5)
        var tight = base
        tight.memoryUsed = UInt64(22.9 * Double(gb)); tight.memoryCompressed = UInt64(5.6 * Double(gb)); tight.memoryPressure = 2
        tight.swapUsed = 3_100_000_000; tight.biggest = .init(name: "Google Chrome", value: 6.2 * Double(gb))
        var low = base
        low.cpu = 0.71; low.battery = 0.12; low.onBattery = true; low.batteryMinutesLeft = 35
        low.busiest = [.init(name: "Xcode", value: 0.52)]
        var full = base
        full.storageFree = 6_200_000_000
        let states: [(String, SystemMonitor.Sample, SystemFocus, Set<SystemMeasure>, TimeInterval?, [Double])] = [
            ("rest", base, .atRest, [], nil, calm),
            ("busy", busyState, .cpuBusy, [], 130, busy),
            ("hot", hot, .hot, [], 190, busy),
            ("memory", tight, .memoryTight, [], 125, calm),
            ("battery", low, .batteryLow, [.cpu], nil, middling),
            ("disk", full, .diskFull, [], nil, calm),
        ]
        for (name, sample, focus, marked, seconds, cpu) in states {
            SystemMonitor.shared.preview(sample, focus: focus, marked: marked, seconds: seconds, cpu: cpu,
                                         temperature: heat, swap: swap, network: network)
            do {
                try render(SystemView().frame(width: 640 - 62, height: 250 - 32 - 12 - 8).padding(.horizontal, 31).padding(.vertical, 12)
                    .background(.black), named: "system-\(name)", settle: 0.6)
            } catch { print("relo-snapshot failed-system-\(name) \(error)") }
        }
    }

    /// Clicks the open notch's buttons through the real notch window (its class, style and ContentView), offscreen,
    /// and prints whether each action ran: `relo-click-probe <button> ran|ignored|missing`.
    private static func clickProbe() {
        ReloUpdater.shared.probeWaiting(.init(version: "9.9.9", critical: false, downloaded: true))
        ReloNotch.store.showPreview(.empty(at: Date()))
        if ProcessInfo.processInfo.arguments.contains("--signed-out") { ReloNotch.store.showSignedOutPreview() }
        if ProcessInfo.processInfo.arguments.contains("--agent-found") {
            ReloUpdater.shared.probeWaiting(nil)
            ReloAgents.shared.preview([.init(id: "antigravity", name: "Antigravity", level: "none", outdated: false)],
                                      signIn: .init(signedIn: true, server: nil))
        }
        let vm = BoringViewModel(screenUUID: NSScreen.main?.displayUUID)
        BoringViewCoordinator.shared.currentView = .relo
        vm.open()
        let window = BoringNotchSkyLightWindow(contentRect: NSRect(origin: NSPoint(x: -10_000, y: -10_000), size: windowSize),
                                               styleMask: [.borderless, .nonactivatingPanel, .utilityWindow, .hudWindow],
                                               backing: .buffered, defer: false)
        let host = NSHostingView(rootView: ContentView().environmentObject(vm))
        window.contentView = host
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        func find(_ label: String, in element: Any) -> NSRect? {
            guard let object = element as? NSAccessibilityProtocol else { return nil }
            if object.accessibilityLabel() == label || object.accessibilityTitle() == label { return object.accessibilityFrame() }
            for child in object.accessibilityChildren() ?? [] {
                if let frame = find(label, in: child) { return frame }
            }
            return nil
        }
        func clickAt(_ point: NSPoint, _ label: String, ran: () -> Bool) {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
                else { continue }
                window.sendEvent(event)
                RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            print("relo-click-probe \(label) \(ran() ? "ran" : "ignored") at \(point) state=\(vm.notchState)")
        }
        func click(_ label: String, ran: () -> Bool) {
            guard let frame = find(label, in: host) else {
                func dump(_ element: Any, _ depth: Int) {
                    guard let object = element as? NSAccessibilityProtocol, depth < 30 else { return }
                    print("relo-click-probe tree \(String(repeating: " ", count: depth))\(object.accessibilityRole()?.rawValue ?? "?") \(object.accessibilityLabel() ?? "") \(object.accessibilityFrame())")
                    for child in object.accessibilityChildren() ?? [] { dump(child, depth + 1) }
                }
                dump(host, 0)
                print("relo-click-probe \(label) missing state=\(vm.notchState) view=\(BoringViewCoordinator.shared.currentView)")
                return
            }
            let point = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
                else { continue }
                window.sendEvent(event)
                RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            print("relo-click-probe \(label) \(ran() ? "ran" : "ignored") at \(point)")
        }
        if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
            host.cacheDisplay(in: host.bounds, to: rep)
            print("relo-click-probe image \(rep.representation(using: .png, properties: [:])?.base64EncodedString() ?? "")")
        }
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--at"), index + 2 < arguments.count,
           let x = Double(arguments[index + 1]), let y = Double(arguments[index + 2]) {
            var asked = false
            let watch = NotificationCenter.default.addObserver(forName: .reloNeedsSetup, object: nil, queue: nil) { _ in asked = true }
            clickAt(NSPoint(x: x, y: host.bounds.height - y), "button") { ReloUpdater.shared.probeRestarts > 0 || asked }
            NotificationCenter.default.removeObserver(watch)
        }
        window.orderOut(nil)
    }

    /// Each onboarding screen in the window's own frame, from a preview flow that saves and sets up nothing.
    private static func onboarding() {
        let agents = [LocalServer.Agent(id: "claude-code", name: "Claude Code"), LocalServer.Agent(id: "codex", name: "Codex"),
                      LocalServer.Agent(id: "opencode", name: "OpenCode")]
        func shot(_ name: String, _ flow: ReloOnboardingFlow, settle: TimeInterval = 1.2) {
            do {
                try render(ZStack { ReloAurora(); ReloOnboardingScreens(flow: flow) }.frame(width: 560, height: 680),
                           named: "onboarding-\(name)", settle: settle)
            } catch { print("relo-snapshot failed-onboarding-\(name) \(error)") }
        }
        shot("hello", ReloOnboardingFlow(preview: .hello, caption: "Welcome to Relo"))
        shot("sound", ReloOnboardingFlow(preview: .sound, caption: "Done: Login crash. Fixed and tested."))
        shot("where", ReloOnboardingFlow(preview: .where))
        shot("where-server", ReloOnboardingFlow(preview: .where, place: .server))
        shot("server", ReloOnboardingFlow(preview: .server, place: .server))
        shot("agents", ReloOnboardingFlow(preview: .agents, agents: agents))
        let running = ReloOnboardingFlow(preview: .setup, agents: agents)
        running.setup.preview([.init(id: "relo", name: "Relo", state: .done), .init(id: "claude-code", name: "Claude Code", state: .done),
                               .init(id: "codex", name: "Codex", state: .running), .init(id: "opencode", name: "OpenCode")])
        shot("setup", running)
        let failed = ReloOnboardingFlow(preview: .setup, agents: agents)
        failed.setup.preview([.init(id: "relo", name: "Relo", state: .done), .init(id: "claude-code", name: "Claude Code", state: .done),
                              .init(id: "codex", name: "Codex", state: .failed("Relo could not set up Codex.")), .init(id: "opencode", name: "OpenCode")])
        shot("setup-failed", failed)
        shot("ready", ReloOnboardingFlow(preview: .ready))
        shot("ready-server", ReloOnboardingFlow(preview: .ready, place: .server))
    }

    /// The bench: the closed wings frame by frame (30 fps, 3× scale), for
    /// each state and moment, each PNG printed as `relo-bench <name> <base64>` (the sandbox keeps files out).
    private static func bench(vm: BoringViewModel) throws {
        let presentation = ReloNotch.store.presentation
        let side = max(0, vm.effectiveClosedNotchHeight - 12)
        let wing = max(side, ReloWing.orbit)
        let inset = cornerRadiusInsets.closed.bottom, top = cornerRadiusInsets.closed.top
        let width = 2 * (wing + ReloWing.outer + ReloWing.gap) + vm.closedNotchSize.width - top + 2 * inset
        let base = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let needs = ReloOrbitScene(presentation, unseen: false, now: base)
        var running = needs
        let runRow = presentation.sections.first { $0.kind == .running }?.rows.first
        running.lead = .running
        running.leadID = runRow?.id
        running.bar = runRow?.bar?.segments
        running.bar = PlanBar.make(done: 1, total: 3, current: 2, fill: 0.55).segments
        var quiet = running
        quiet.lead = .quiet
        let id = runRow?.id ?? "row"
        typealias Moment = ReloOrbitMoment
        let scenarios: [(String, ReloOrbitScene, Moment?, Double)] = [
            ("running", running, nil, 3.2),
            ("started", running, Moment(kind: .started, rowID: id, bar: running.bar, at: base), 3.0),
            ("step", running, Moment(kind: .step, rowID: id, bar: running.bar, at: base), 3.0),
            ("needs", needs, Moment(kind: .needs, rowID: needs.leadID ?? id, bar: nil, at: base), 3.6),
            ("turn", running, Moment(kind: .turn, rowID: id, bar: running.bar, at: base), 3.4),
            ("done", running, Moment(kind: .done, rowID: id, bar: running.bar, at: base), 3.4),
            ("failed", running, Moment(kind: .failed, rowID: id, bar: running.bar, at: base), 3.0),
            ("quiet", quiet, nil, 1.0)]
        // The wings' light across the states, settled (moments over), stacked one under another.
        do {
            var needsLead = needs; needsLead.lead = .needs
            var turnLead = running; turnLead.lead = .turn
            var doneLead = running; doneLead.lead = .done
            var failedLead = running; failedLead.lead = .failed
            var quietLead = running; quietLead.lead = .quiet
            var preLead = running; preLead.leadID = nil; preLead.bar = nil; preLead.more = 0
            preLead.satellites = [ReloOrbitScene.Satellite(id: "session-0", quiet: false, pace: 0.6)]; preLead.source = "claude-code"
            let rows: [(String, ReloOrbitScene)] = [("running", running), ("preplan", preLead), ("needs", needsLead), ("turn", turnLead),
                                                    ("done", doneLead), ("failed", failedLead), ("quiet", quietLead)]
            do {
                for frame in 0..<126 {
                    let now = base.addingTimeInterval(Double(frame) / 30)
                    let stack = VStack(spacing: 10) {
                        ForEach(rows, id: \.0) { row in
                            ReloOrbitFrame(scene: row.1, moment: nil, wing: wing, side: side, now: now)
                                .frame(width: width, height: vm.effectiveClosedNotchHeight)
                                .background(.black)
                                .clipShape(NotchShape(topCornerRadius: top, bottomCornerRadius: inset))
                        }
                    }
                    .padding(12)
                    .background(Color(white: 0.12))
                    let renderer = ImageRenderer(content: stack.environment(\.colorScheme, .dark))
                    renderer.scale = 3
                    guard let image = renderer.cgImage,
                          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
                    print("relo-bench light-\(String(format: "%03d", frame)) \(png.base64EncodedString())")
                }
            }
        }
        // Before a plan (a session works, no card yet) and at rest (nothing live).
        var prePlan = running
        prePlan.lead = .running; prePlan.leadID = nil; prePlan.bar = nil; prePlan.more = 0
        prePlan.satellites = [ReloOrbitScene.Satellite(id: "session-0", quiet: false, pace: 0.6)]
        prePlan.source = "claude-code"
        var rest = prePlan
        rest.lead = .rest; rest.satellites = []
        for frame in 0..<96 {
            let now = base.addingTimeInterval(Double(frame) / 30)
            try benchFrame(ReloOrbitFrame(scene: prePlan, moment: nil, wing: wing, side: side, now: now),
                           width: width, vm: vm, name: "preplan-\(String(format: "%03d", frame))")
        }
        // At rest the wings are just the mark wide: the pilot light.
        let restWidth = 2 * (side + ReloWing.outer + ReloWing.gap) + vm.closedNotchSize.width - top + 2 * inset
        for frame in stride(from: 0, to: 210, by: 3) {
            try benchFrame(ReloOrbitFrame(scene: rest, moment: nil, wing: side, side: side, now: base.addingTimeInterval(Double(frame) / 30)),
                           width: restWidth, vm: vm, name: "rest-\(String(format: "%03d", frame / 3))", canvasWidth: width)
        }
        for (name, scene, moment, seconds) in scenarios {
            do {
                for frame in 0..<Int(seconds * 30) {
                    let view = ReloOrbitFrame(scene: scene, moment: moment, wing: wing, side: side,
                                              now: base.addingTimeInterval(Double(frame) / 30))
                        .frame(width: width, height: vm.effectiveClosedNotchHeight)
                        .background(.black)
                        .clipShape(NotchShape(topCornerRadius: top, bottomCornerRadius: inset))
                        .padding(.horizontal, 12).padding(.bottom, 12)
                        .background(Color(white: 0.12))
                    let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
                    renderer.scale = 3
                    guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
                    let rep = NSBitmapImageRep(cgImage: image)
                    guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
                    print("relo-bench \(name)-\(String(format: "%03d", frame)) \(png.base64EncodedString())")
                }
            }
        }
        // The expansions, each as one gesture with real-length text: the wings play the moment, the shape grows (the
        // notch's own spring, approximated), the light comes down and the content arrives, frame by frame.
        let closedWidth = width
        func long(_ row: NotchPresentation.Row, _ edit: (inout NotchPresentation.Row) -> Void) -> NotchPresentation.Row {
            var row = row
            edit(&row)
            return row
        }
        let question = long(presentation.sections[0].rows[0]) {
            $0.title = "Deploy the closed notch polish and the card motion fix to every Mac"
        }
        let working = long(runRow ?? presentation.sections[0].rows[0]) {
            $0.title = "Polish the closed notch: shimmers, beams, backgrounds and pulses, plus the expanded views"
            $0.stepsDone = 3; $0.stepsTotal = 5; $0.currentIndex = 4; $0.currentFill = 0.4
            $0.currentStep = "Build the new expansions"
        }
        let turn = long(working) {
            $0.title = "Clean up the build box: reclaim disk from caches and Docker leftovers, merge the two documents folders, tidy home clutter"
            $0.tone = .yourTurn
            $0.status = "Found 41 GB to reclaim; pick which of the two documents folders to keep"
        }
        let failed = long(presentation.sections.first { $0.kind == .recent }!.rows[0]) {
            $0.title = "Check the new Node.js vulnerability against the build box and staging and say what to do"
            $0.status = "The audit could not reach staging over SSH: the connection timed out after 30 seconds"
        }
        let started = long(working) {
            $0.stepsDone = 0; $0.currentIndex = 1; $0.currentFill = 0.1
            $0.currentStep = "Read the closed notch code"
        }
        let finished = long(working) {
            $0.title = "Show phases and steps on the Mac cards like the iPhone"
            $0.tone = .done; $0.stepsDone = 4; $0.stepsTotal = 4
            $0.roundOutcome = "Cards group their steps under phases, the current phase open and the rest folded"
        }
        let gestures: [(String, NotchEvent, ReloOrbitScene, Moment?)] = [
            ("open-needs", NotchEvent(kind: .question, row: question), needs, Moment(kind: .needs, rowID: question.id, bar: nil, at: base)),
            ("open-turn", NotchEvent(kind: .yourTurn, row: turn), running, Moment(kind: .turn, rowID: turn.id, bar: running.bar, at: base)),
            ("open-running", NotchEvent(kind: .progressed, row: working), running, Moment(kind: .step, rowID: working.id, bar: working.bar?.segments, at: base)),
            ("open-failed", NotchEvent(kind: .failed, row: failed), running, Moment(kind: .failed, rowID: failed.id, bar: running.bar, at: base)),
            ("open-started", NotchEvent(kind: .started, row: started), running, Moment(kind: .started, rowID: started.id, bar: started.bar?.segments, at: base)),
            ("open-done", NotchEvent(kind: .finished, row: finished), running, Moment(kind: .done, rowID: finished.id, bar: finished.bar?.segments, at: base))]
        for (name, event, scene, moment) in gestures {
            let lead = ReloClosedActivity.momentLead(event.kind)
            let opened = base.addingTimeInterval(lead)
            let peek = event.kind == .started || event.kind == .finished
            func content(_ now: Date) -> some View {
                Group {
                    if peek { ReloPeekPill(event: event, row: event.row, openedAt: opened) }
                    else { ReloExpandedCard(event: event, row: event.row, openedAt: opened) }
                }
                .environment(\.reloFrozenNow, now)
            }
            let measure = ImageRenderer(content: content(opened.addingTimeInterval(5)).environment(\.colorScheme, .dark))
            measure.scale = 1
            let cardHeight = CGFloat(measure.cgImage?.height ?? 120)
            let canvasHeight = vm.effectiveClosedNotchHeight + cardHeight
            for frame in 0..<Int((lead + 3.4) * 30) {
                let now = base.addingTimeInterval(Double(frame) / 30)
                let e = now.timeIntervalSince(opened)
                // The notch's spring (snappy), approximated as critically damped.
                let w = 2 * Double.pi / 0.28 * 0.86
                let grow = e <= 0 ? 0 : 1 - (1 + w * e) * exp(-w * e)
                let wings = 1 - Ease.out(Ease.seg(e, 0.06, 0.28))
                let view = VStack(spacing: 0) {
                    ReloOrbitFrame(scene: scene, moment: moment, wing: wing, side: side, now: now)
                        .frame(width: closedWidth, height: vm.effectiveClosedNotchHeight)
                        .opacity(wings)
                    content(now)
                        .frame(height: cardHeight * grow, alignment: .top)
                        .mask(Rectangle().padding(.horizontal, -inset))
                        .padding(.horizontal, inset)
                }
                .frame(width: closedWidth + (440 + 2 * inset - closedWidth) * grow, alignment: .top)
                .clipped()
                .background(.black)
                .clipShape(NotchShape(topCornerRadius: top, bottomCornerRadius: inset))
                .frame(width: 440 + 2 * inset + 24, height: canvasHeight, alignment: .top)
                .padding(.bottom, 12)
                .background(Color(white: 0.12))
                let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
                renderer.scale = 3
                guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
                guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
                print("relo-bench \(name)-\(String(format: "%03d", frame)) \(png.base64EncodedString())")
            }
        }
    }

    /// One bench frame of the closed notch, centred on a fixed canvas so notches of different widths line up.
    private static func benchFrame(_ frame: some View, width: CGFloat, vm: BoringViewModel, name: String, canvasWidth: CGFloat? = nil) throws {
        let top = cornerRadiusInsets.closed.top, inset = cornerRadiusInsets.closed.bottom
        let view = frame
            .frame(width: width, height: vm.effectiveClosedNotchHeight)
            .background(.black)
            .clipShape(NotchShape(topCornerRadius: top, bottomCornerRadius: inset))
            .frame(width: (canvasWidth ?? width) + 24)
            .padding(.bottom, 12)
            .background(Color(white: 0.12))
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
        renderer.scale = 3
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        print("relo-bench \(name) \(png.base64EncodedString())")
    }

    /// The open notch's content area: 19 pt corner plus 12 pt padding each side, the 32 pt header above.
    private static func openFrame(_ view: some View) -> some View {
        view.frame(width: reloOpenNotchSize.width - 62, height: reloOpenNotchSize.height - 32 - 12 - 8)
            .padding(.horizontal, 31).padding(.top, 40).padding(.bottom, 12).background(.black)
    }

    /// SwiftUI's own renderer: draws blur and Metal shader effects (the orb, the aurora) that a window cache leaves out.
    private static func renderSwiftUI(_ view: some View, named name: String) throws {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        print("relo-snapshot \(name) \(png.base64EncodedString())")
    }

    /// Renders through a real (offscreen) window, so scroll views and materials draw as on screen.
    /// `settle` lets a view that changes after appearing (an expansion) finish, then measures it again.
    private static func render(_ view: some View, named name: String, prefix: String = "relo-snapshot", settle: TimeInterval? = nil) throws {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, .dark))
        let size = host.fittingSize
        guard size.width > 0, size.height > 0 else {
            print("relo-snapshot failed-\(name) empty")
            return
        }
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -10_000, y: -10_000), size: size),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(settle ?? 0.4))
        if settle != nil {
            let settled = host.fittingSize
            window.setContentSize(settled)
            host.frame = NSRect(origin: .zero, size: settled)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw CocoaError(.fileWriteUnknown) }
        host.cacheDisplay(in: host.bounds, to: rep)
        window.orderOut(nil)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        print("\(prefix) \(name) \(png.base64EncodedString())")
    }
}

private extension NowSummary {
    static func empty(at time: Date) -> NowSummary {
        let json = """
        {"serverTime":"2026-10-14T10:00:00.000Z","sinceYouLooked":{"since":"2026-10-14T06:40:00.000Z","finished":0,"failed":0,"waitingOnYou":0,"stoppedWithoutFinishing":0,"needsYou":0},
         "needsYou":[],"recent":[],"waitingOnYou":[],"running":[],"quiet":[],"paused":[],"folds":{"waitingOnYou":0,"quiet":0,"paused":0},
         "lockScreen":{"cards":[],"needsYouCount":0,"focus":null},"sessions":{"sessions":[],"folds":{"idle":0}},"refreshAt":null}
        """
        return try! ReloWireJSON.decoder().decode(NowSummary.self, from: Data(json.utf8))
    }
}
#endif
