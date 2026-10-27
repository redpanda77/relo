import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct SystemAttentionTests {
    @Test func aCalmMacLeadsWithTheCPU() {
        #expect(SystemAttention.focus(SystemReadings(battery: 1, diskFree: 80_000_000_000)) == .atRest)
        #expect(SystemAttention.title(.atRest, for: nil) == "CPU")
    }

    @Test func aBusyCPULeadsOnlyAfterHalfAMinute() {
        #expect(SystemAttention.focus(SystemReadings(cpuBusyFor: 20)) == .atRest)
        #expect(SystemAttention.focus(SystemReadings(cpuBusyFor: 30)) == .cpuBusy)
        #expect(SystemAttention.title(.cpuBusy, for: 125) == "CPU busy for 2 min")
    }

    @Test func theMostUrgentMeasureLeadsAndTheRestAreMarkedRows() {
        let readings = SystemReadings(cpuBusyFor: 90, thermal: 0, memoryPressure: 1, onBattery: true, battery: 0.12)
        #expect(SystemAttention.focus(readings) == .batteryLow)
        #expect(SystemAttention.markedRows(readings) == [.cpu])

        let everything = SystemReadings(cpuBusyFor: 90, thermal: 2, memoryPressure: 4, onBattery: true, battery: 0.1, diskFree: 1)
        #expect(SystemAttention.pressured(everything) == [.hot, .memoryTight, .batteryLow, .diskFull])
        #expect(SystemAttention.markedRows(everything) == [.memory, .battery, .disk])
    }

    @Test func heatReplacesBusy() {
        // Hot already says the CPU is working hard: busy is not listed twice.
        #expect(SystemAttention.pressured(SystemReadings(cpuBusyFor: 200, thermal: 2)) == [.hot])
    }

    @Test func aLowBatteryOnPowerIsNotNews() {
        #expect(SystemAttention.focus(SystemReadings(onBattery: false, battery: 0.1)) == .atRest)
    }

    @Test func durationsReadInPlainUnits() {
        #expect(SystemAttention.duration(4) == "10 s")
        #expect(SystemAttention.duration(47) == "40 s")
        #expect(SystemAttention.duration(185) == "3 min")
        #expect(SystemAttention.duration(7300) == "2 h")
    }

    @Test func quietAppsAreNotNamed() {
        #expect(SystemAttention.busiest([("Xcode", 0.61), ("Safari", 0.22), ("Mail", 0.01)]) == "Mostly Xcode (61%) and Safari (22%)")
        #expect(SystemAttention.busiest([("Xcode", 0.61), ("Mail", 0.02)]) == "Mostly Xcode (61%)")
        #expect(SystemAttention.busiest([("Mail", 0.02)]) == nil)
    }
}
