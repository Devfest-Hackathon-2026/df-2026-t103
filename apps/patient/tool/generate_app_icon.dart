// Generates the interim launcher icon artwork for issue #207.
//
// The final logo/brand design is an open decision (docs/10 D-01: subject to
// brand review by the product owner and designer), so the artwork produced by
// this script is a *proposal* using only approved design-system tokens:
//   - patient.primary #075E5A background
//   - an abstract dialogue (speech-bubble) motif, which must not resemble a
//     medical cross or any official emblem (docs/10 §3)
//
// Usage:
//   dart run tool/generate_app_icon.dart
// then:
//   dart run flutter_launcher_icons

import 'dart:io';

import 'package:image/image.dart' as img;

const int _outputSize = 1080; // issue #207 recommends ~1080x1080
const int _supersample = 4;

const _tealR = 0x07, _tealG = 0x5E, _tealB = 0x5A;

// Motif geometry in unit-canvas coordinates, vertically centered on 0.5.
// The bubble body is a rounded rect; the tail is a triangle with a round tip.
const _bodyX1 = 0.231, _bodyX2 = 0.769;
const _bodyY1 = 0.278, _bodyY2 = 0.611;
const _bodyRadius = 0.102;
const _tailX1 = 0.319, _tailX2 = 0.472;
const _tailTipX = 0.361, _tailTipY = 0.722;
const _tailTipRadius = 0.022;
const _dotY = 0.4445;
const _dotXs = [0.361, 0.5, 0.639];
const _dotRadius = 0.044;

img.ColorRgb8 get _teal => img.ColorRgb8(_tealR, _tealG, _tealB);
img.ColorRgba8 get _white => img.ColorRgba8(0xFF, 0xFF, 0xFF, 0xFF);
img.ColorRgba8 get _transparent => img.ColorRgba8(0, 0, 0, 0);

/// Renders the icon at [_outputSize] x [_supersample] then downsamples for
/// antialiased edges.
///
/// [motifScale] scales the motif around the canvas center. [opaqueBackground]
/// fills the canvas with the brand primary color; otherwise the background is
/// transparent and the dot cut-outs are punched with alpha=0 so the platform
/// adaptive background shows through.
img.Image _render({required double motifScale, required bool opaqueBackground}) {
  final size = _outputSize * _supersample;
  final image = img.Image(width: size, height: size, numChannels: 4);
  img.fill(image, color: opaqueBackground ? _teal : _transparent);

  double px(double v) => (0.5 + (v - 0.5) * motifScale) * size;
  int len(double v) => (v * motifScale * size).round();

  // BlendMode.direct punches transparent holes (BlendMode.alpha with a=0
  // is a no-op per the image package's early return).
  final img.Color dotColor = opaqueBackground ? _teal : _transparent;
  final dotBlend =
      opaqueBackground ? img.BlendMode.alpha : img.BlendMode.direct;
  final bubble = _white;

  final x1 = px(_bodyX1).round(), x2 = px(_bodyX2).round();
  final y1 = px(_bodyY1).round(), y2 = px(_bodyY2).round();
  img.fillRect(image,
      x1: x1, y1: y1, x2: x2, y2: y2,
      radius: len(_bodyRadius), color: bubble);

  img.fillPolygon(image,
      vertices: [
        img.Point(px(_tailX1), y2 - 1),
        img.Point(px(_tailX2), y2 - 1),
        img.Point(px(_tailTipX), px(_tailTipY)),
      ],
      color: bubble);
  img.fillCircle(image,
      x: px(_tailTipX).round(), y: px(_tailTipY).round(),
      radius: len(_tailTipRadius), color: bubble);

  for (final dx in _dotXs) {
    img.fillCircle(image,
        x: px(dx).round(), y: px(_dotY).round(),
        radius: len(_dotRadius), color: dotColor, blend: dotBlend);
  }

  return img.copyResize(image,
      width: _outputSize,
      height: _outputSize,
      interpolation: img.Interpolation.average);
}

void main() {
  // Foreground spans ~72% of the canvas so the motif stays inside the Android
  // adaptive-icon safe zone (a ~66% diameter center circle).
  final foreground = _render(motifScale: 0.72, opaqueBackground: false);

  // The store/launcher icon keeps the motif larger since platforms apply
  // their own mask; on iOS the background fills the full rounded square.
  final master = _render(motifScale: 1.0, opaqueBackground: true);

  final outDir = Directory('assets/icon')..createSync(recursive: true);
  File('${outDir.path}/app_icon.png')
      .writeAsBytesSync(img.encodePng(master));
  File('${outDir.path}/app_icon_foreground.png')
      .writeAsBytesSync(img.encodePng(foreground));

  stdout.writeln('wrote ${outDir.path}/app_icon.png '
      '(${master.width}x${master.height})');
  stdout.writeln('wrote ${outDir.path}/app_icon_foreground.png '
      '(${foreground.width}x${foreground.height})');
}
