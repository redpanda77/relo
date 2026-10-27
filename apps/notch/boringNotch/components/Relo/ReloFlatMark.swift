//
//  ReloFlatMark.swift
//  Relo Notch
//
//  Relo's sign of life in the notch, flat: a soft disc in the state's color, with one gentle ripple
//  drifting out of it and fading while work runs or waits on the owner (the iPhone orb's breath,
//  without the 3D). Finished or failed work is a still disc. Core Animation layers only, so the
//  render server animates it and the app does no work per frame.
//

import AppKit
import ReloNotchKit
import SwiftUI

struct ReloFlatMark: NSViewRepresentable {
    let tone: NotchPresentation.Tone
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.wantsLayer = true
        view.layer?.masksToBounds = false
        return view
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? {
        CGSize(width: size, height: size)
    }

    func updateNSView(_ view: NSView, context: Context) {
        guard let root = view.layer else { return }
        let key = "\(tone.rawValue)|\(Int(size))|\(reduceMotion)"
        guard root.value(forKey: "reloMarkKey") as? String != key else { return }
        root.setValue(key, forKey: "reloMarkKey")
        root.sublayers?.forEach { $0.removeFromSuperlayer() }
        build(in: root)
    }

    private func build(in root: CALayer) {
        let color = NSColor(ReloNotchTheme.color(tone))
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        let alive = [.working, .needsYou, .yourTurn].contains(tone)
        let discSize = size * 0.62
        let disc = CGRect(x: (size - discSize) / 2, y: (size - discSize) / 2, width: discSize, height: discSize)

        // The ripple: a thin ring that grows from the disc to the edge and fades, slowly.
        if alive && !reduceMotion {
            let ripple = CAShapeLayer()
            ripple.frame = bounds
            ripple.path = CGPath(ellipseIn: disc, transform: nil)
            ripple.fillColor = nil
            ripple.strokeColor = color.cgColor
            ripple.lineWidth = 1.2
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 1
            grow.toValue = size / discSize
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.7
            fade.toValue = 0
            let breath = CAAnimationGroup()
            breath.animations = [grow, fade]
            breath.duration = tone == .needsYou ? 1.6 : 2.6
            breath.repeatCount = .infinity
            breath.timingFunction = CAMediaTimingFunction(name: .easeOut)
            ripple.add(breath, forKey: "breath")
            root.addSublayer(ripple)
        }

        // The disc.
        let fill = CAGradientLayer()
        fill.type = .radial
        fill.frame = disc
        fill.startPoint = CGPoint(x: 0.35, y: 0.3)
        fill.endPoint = CGPoint(x: 1.1, y: 1.1)
        // One flat colour, like the closed notch's dot (a key light read as a 3D ball).
        fill.colors = [color.cgColor, color.cgColor]
        fill.locations = [0, 1]
        fill.cornerRadius = discSize / 2
        fill.masksToBounds = true
        root.addSublayer(fill)

        // A slow, small swell of the disc itself while alive: soft, never a blink.
        if alive && !reduceMotion {
            let swell = CABasicAnimation(keyPath: "transform.scale")
            swell.fromValue = 0.94
            swell.toValue = 1.04
            swell.duration = tone == .needsYou ? 0.8 : 1.3
            swell.autoreverses = true
            swell.repeatCount = .infinity
            swell.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            fill.add(swell, forKey: "swell")
        }
    }
}
