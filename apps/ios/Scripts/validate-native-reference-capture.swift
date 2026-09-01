#!/usr/bin/env swift

import Foundation
import Vision

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: validate-native-reference-capture.swift <png> <case>\n".utf8))
    exit(64)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
let caseName = CommandLine.arguments[2]
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

do {
    try VNImageRequestHandler(url: imageURL).perform([request])
} catch {
    FileHandle.standardError.write(Data("Could not inspect native capture: \(error)\n".utf8))
    exit(65)
}

let recognized = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")
let forbiddenAuthorizationText = [
    "Always Allow",
    "Don't Allow",
    "allow Live Activities",
]

if forbiddenAuthorizationText.contains(where: recognized.localizedCaseInsensitiveContains) {
    FileHandle.standardError.write(Data(
        "Native capture for \(caseName) contains a Live Activities authorization sheet; authorize the dedicated simulator and rerun.\n".utf8
    ))
    exit(66)
}

guard recognized.localizedCaseInsensitiveContains("Relo") else {
    FileHandle.standardError.write(Data(
        "Native capture for \(caseName) does not contain the expected source-rendered Relo activity.\n".utf8
    ))
    exit(67)
}
