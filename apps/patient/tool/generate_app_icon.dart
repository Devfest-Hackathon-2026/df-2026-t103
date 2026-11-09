// Platform launcher assets from the owner-supplied source.png.
// Run from apps/patient: dart run tool/generate_app_icon.dart
import 'dart:io';

import 'package:image/image.dart' as img;

img.Image padded(
  img.Image source,
  int size,
  double fraction, {
  bool transparent = false,
}) {
  final image = img.Image(width: size, height: size, numChannels: 4);
  img.fill(image, color: img.ColorRgba8(255, 255, 255, transparent ? 0 : 255));
  final side = (size * fraction).floor();
  final resized = img.copyResize(
    source,
    width: side,
    height: side,
    interpolation: img.Interpolation.average,
  );
  return img.compositeImage(
    image,
    resized,
    dstX: (size - side) ~/ 2,
    dstY: (size - side) ~/ 2,
  );
}

void main() {
  final source = img.decodePng(
    File('assets/icon/source.png').readAsBytesSync(),
  );
  if (source == null || source.width != source.height) {
    throw StateError('Expected the square owner-supplied PNG');
  }
  File('assets/icon/app_icon.png')
      .writeAsBytesSync(img.encodePng(padded(source, 1080, 1)));
  // Keep the complete square inside Android's central safe circle.
  File('assets/icon/app_icon_foreground.png').writeAsBytesSync(
    img.encodePng(padded(source, 1080, 0.46, transparent: true)),
  );
  final result = Process.runSync(Platform.resolvedExecutable, [
    'run',
    'flutter_launcher_icons',
  ]);
  stdout.write(result.stdout);
  stderr.write(result.stderr);
  if (result.exitCode != 0) exit(result.exitCode);
  // Web maskable icons have an 80% diameter safe circle.
  for (final size in [192, 512]) {
    File('web/icons/Icon-maskable-$size.png')
        .writeAsBytesSync(img.encodePng(padded(source, size, 0.55)));
  }
}
