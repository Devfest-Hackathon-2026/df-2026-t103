import 'package:flutter_test/flutter_test.dart';
import 'package:patient/firebase_bootstrap.dart';

void main() {
  test('accepts explicit demo emulator configuration', () {
    const config = EmulatorConfig(
      enabled: true,
      projectId: 'demo-mmr-dev',
      host: 'localhost',
    );
    expect(config.validate, returnsNormally);
  });

  test('rejects disabled emulator, non-demo project and empty host', () {
    for (final config in [
      const EmulatorConfig(
        enabled: false,
        projectId: 'demo-mmr-dev',
        host: 'localhost',
      ),
      const EmulatorConfig(
        enabled: true,
        projectId: 'production',
        host: 'localhost',
      ),
      const EmulatorConfig(enabled: true, projectId: 'demo-mmr-dev', host: ''),
    ]) {
      expect(config.validate, throwsStateError);
    }
  });
}
