// Launch artwork only. Launcher icons come from generate_app_icon.dart.
// Run from apps/patient: swift tool/render_ios_icon.swift
import AppKit

let teal = NSColor(srgbRed: 0.0, green: 0.50, blue: 0.46, alpha: 1)
let assets = URL(fileURLWithPath: "ios/Runner/Assets.xcassets")

func render(size: Int, launch: Bool = false) -> Data {
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  let context = NSGraphicsContext.current!.cgContext
  context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
  (launch ? NSColor.white : teal).setFill()
  NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1024, height: 1024)).fill()
  (launch ? teal : NSColor.white).setFill()
  NSBezierPath(roundedRect: NSRect(x: 190, y: 310, width: 644, height: 480),
               xRadius: 150, yRadius: 150).fill()
  let tail = NSBezierPath()
  tail.move(to: NSPoint(x: 300, y: 380))
  tail.line(to: NSPoint(x: 285, y: 200))
  tail.line(to: NSPoint(x: 495, y: 340))
  tail.close()
  tail.fill()
  (launch ? NSColor.white : teal).setFill()
  for x in [340, 480, 620] {
    NSBezierPath(ovalIn: NSRect(x: x, y: 505, width: 66, height: 66)).fill()
  }
  NSGraphicsContext.restoreGraphicsState()
  let opaque = CGContext(data: nil, width: size, height: size,
    bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  opaque.draw(bitmap.cgImage!, in: CGRect(x: 0, y: 0, width: size, height: size))
  return NSBitmapImageRep(cgImage: opaque.makeImage()!)
    .representation(using: .png, properties: [:])!
}

let launch = assets.appendingPathComponent("LaunchImage.imageset")
for (scale, filename) in [(1, "LaunchImage.png"), (2, "LaunchImage@2x.png"), (3, "LaunchImage@3x.png")] {
  try render(size: 160 * scale, launch: true).write(to: launch.appendingPathComponent(filename))
}
