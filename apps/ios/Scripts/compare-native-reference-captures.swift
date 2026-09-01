#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO

guard CommandLine.arguments.count == 4 else {
    FileHandle.standardError.write(Data(
        "usage: compare-native-reference-captures.swift <first.png> <second.png> <case>\n".utf8
    ))
    exit(64)
}

func normalizedPixels(at path: String) throws -> (width: Int, height: Int, pixels: Data) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw CocoaError(.fileReadCorruptFile)
    }
    let bytesPerRow = image.width * 4
    var pixels = Data(count: bytesPerRow * image.height)
    let rendered = pixels.withUnsafeMutableBytes { rawBuffer -> Bool in
        guard let address = rawBuffer.baseAddress,
              let context = CGContext(
                data: address,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return false }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return true
    }
    guard rendered else { throw CocoaError(.coderInvalidValue) }
    return (image.width, image.height, pixels)
}

do {
    let first = try normalizedPixels(at: CommandLine.arguments[1])
    let second = try normalizedPixels(at: CommandLine.arguments[2])
    guard first.width == second.width, first.height == second.height else {
        FileHandle.standardError.write(Data(
            "Non-deterministic capture dimensions for \(CommandLine.arguments[3])\n".utf8
        ))
        exit(65)
    }
    let metrics = zip(first.pixels, second.pixels).reduce(into: (changed: 0, sum: 0, maximum: 0)) {
        let delta = abs(Int($1.0) - Int($1.1))
        if delta > 0 { $0.changed += 1 }
        $0.sum += delta
        $0.maximum = max($0.maximum, delta)
    }
    let byteCount = max(first.pixels.count, 1)
    let changedRatio = Double(metrics.changed) / Double(byteCount)
    let meanDelta = Double(metrics.sum) / Double(byteCount)
    guard changedRatio <= 0.01, meanDelta <= 0.05, metrics.maximum <= 4 else {
        FileHandle.standardError.write(Data(
            "Non-deterministic rendered pixels for \(CommandLine.arguments[3]): changedRatio=\(changedRatio), meanDelta=\(meanDelta), maxDelta=\(metrics.maximum)\n".utf8
        ))
        exit(65)
    }
    print(
        "Normalized capture \(CommandLine.arguments[3]): changedRatio=\(changedRatio), "
            + "meanDelta=\(meanDelta), maxDelta=\(metrics.maximum)"
    )
} catch {
    FileHandle.standardError.write(Data("Could not compare native captures: \(error)\n".utf8))
    exit(66)
}
