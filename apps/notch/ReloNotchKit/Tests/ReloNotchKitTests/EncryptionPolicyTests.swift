import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct EncryptionPolicyTests {
    @Test func readsTheServersChoice() {
        let on = EncryptionPolicy.parse(Data(#"{"required":true,"mode":"on"}"#.utf8))
        #expect(on?.title == "Always")
        #expect(EncryptionPolicy.parse(Data(#"{"required":false,"mode":"auto"}"#.utf8))?.title == "Automatic")
        #expect(EncryptionPolicy.parse(Data(#"{"required":false,"mode":"off"}"#.utf8))?.title == "Off")
        #expect(EncryptionPolicy.parse(Data("nope".utf8)) == nil)
    }

    @Test func theMacPicksOnlyAlwaysOrAutomatic() {
        #expect(String(decoding: EncryptionPolicy.body(always: true), as: UTF8.self) == #"{"required":true}"#)
        #expect(String(decoding: EncryptionPolicy.body(always: false), as: UTF8.self) == #"{"required":null}"#)
    }

    @Test func alwaysWithoutAnIPhoneSaysCardsOpenOnlyHere() {
        let always = EncryptionPolicy(mode: .on, required: true)
        #expect(always.note(phoneTrusted: false) == "Cards will open only on this Mac until you add an iPhone.")
        #expect(always.note(phoneTrusted: true) == nil)
        #expect(EncryptionPolicy(mode: .auto, required: false).note(phoneTrusted: false) == nil)
    }

    @Test func aTrustedPhoneIsAnotherTrustedDevice() {
        let json = #"{"devices":[{"deviceId":"dev_1","trusted":true,"isCurrent":true},{"deviceId":"dev_2","trusted":false,"isCurrent":false}]}"#
        #expect(!EncryptionPolicy.phoneTrusted(inDevices: Data(json.utf8)))
        let both = #"{"devices":[{"deviceId":"dev_1","trusted":true,"isCurrent":true},{"deviceId":"dev_2","trusted":true,"isCurrent":false}]}"#
        #expect(EncryptionPolicy.phoneTrusted(inDevices: Data(both.utf8)))
        // Another Mac (an owner overview) or a simulator is not an iPhone.
        let macs = #"{"devices":[{"deviceId":"dev_2","trusted":true,"isCurrent":false,"ownerOverview":true},{"deviceId":"dev_3","trusted":true,"isCurrent":false,"isSimulator":true}]}"#
        #expect(!EncryptionPolicy.phoneTrusted(inDevices: Data(macs.utf8)))
        let phone = #"{"devices":[{"deviceId":"dev_2","trusted":true,"isCurrent":false,"ownerOverview":false,"isSimulator":false}]}"#
        #expect(EncryptionPolicy.phoneTrusted(inDevices: Data(phone.utf8)))
    }
}
