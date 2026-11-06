import 'package:flutter_test/flutter_test.dart';
import 'package:patient/firebase_bootstrap.dart';

void main() {
  group('EmulatorConfig.validate', () {
    test('accepts explicit demo emulator configuration on loopback', () {
      const config = EmulatorConfig(
        enabled: true,
        projectId: 'demo-mmr-dev',
        host: 'localhost',
      );
      expect(
        () => config.validate(androidHostAliasAllowed: false),
        returnsNormally,
      );

      const ipConfig = EmulatorConfig(
        enabled: true,
        projectId: 'demo-mmr-dev',
        host: '127.0.0.1',
      );
      expect(
        () => ipConfig.validate(androidHostAliasAllowed: true),
        returnsNormally,
      );
    });

    test('accepts the Android host alias only when it is allowed', () {
      const config = EmulatorConfig(
        enabled: true,
        projectId: 'demo-mmr-dev',
        host: '10.0.2.2',
      );
      expect(
        () => config.validate(androidHostAliasAllowed: true),
        returnsNormally,
      );
      expect(
        () => config.validate(androidHostAliasAllowed: false),
        throwsStateError,
      );
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
        expect(
          () => config.validate(androidHostAliasAllowed: false),
          throwsStateError,
          reason: '${config.enabled} ${config.projectId} "${config.host}"',
        );
      }
    });

    test('rejects external, URL, IPv6 and lookalike hosts', () {
      const rejected = [
        '192.168.1.10',
        '10.0.2.3',
        '10.0.2.2', // rejected whenever the Android alias is not allowed
        'example.com',
        'localhost.evil.example',
        'http://localhost:9099',
        'localhost:9099',
        '[::1]',
        '::1',
        'LOCALHOST',
        ' localhost',
      ];
      for (final host in rejected) {
        final config = EmulatorConfig(
          enabled: true,
          projectId: 'demo-mmr-dev',
          host: host,
        );
        expect(
          () => config.validate(androidHostAliasAllowed: false),
          throwsStateError,
          reason: host,
        );
      }
    });
  });

  group('isDemoEmulatorHost', () {
    test('accepts loopback hosts regardless of the Android alias', () {
      for (final host in ['localhost', '127.0.0.1']) {
        expect(
          isDemoEmulatorHost(host, androidHostAliasAllowed: false),
          isTrue,
          reason: host,
        );
        expect(
          isDemoEmulatorHost(host, androidHostAliasAllowed: true),
          isTrue,
          reason: host,
        );
      }
    });

    test('accepts 10.0.2.2 only when the Android alias is allowed', () {
      expect(
        isDemoEmulatorHost('10.0.2.2', androidHostAliasAllowed: true),
        isTrue,
      );
      expect(
        isDemoEmulatorHost('10.0.2.2', androidHostAliasAllowed: false),
        isFalse,
      );
    });

    test('rejects any other host in both modes', () {
      const rejected = [
        '',
        ' ',
        'LOCALHOST',
        'Localhost',
        ' localhost',
        'localhost ',
        'localhost:9099',
        'localhost.evil.example',
        '127.0.0.1.evil.example',
        '10.0.2.2.evil.example',
        '10.0.2.3',
        '0.0.0.0',
        '127.0.0.2',
        '169.254.169.254',
        'metadata.google.internal',
        '[::1]',
        '::1',
        'evil.example.com',
      ];
      for (final host in rejected) {
        expect(
          isDemoEmulatorHost(host, androidHostAliasAllowed: false),
          isFalse,
          reason: host,
        );
        expect(
          isDemoEmulatorHost(host, androidHostAliasAllowed: true),
          isFalse,
          reason: host,
        );
      }
    });
  });

  test(
    'initializeDemoFirebase rejects an unsafe host before Firebase init',
    () async {
      // The guard throws inside the async body before Firebase.initializeApp
      // is reached, so no Firebase service is contacted by this test.
      await expectLater(
        initializeDemoFirebase(
          const EmulatorConfig(
            enabled: true,
            projectId: 'demo-mmr-dev',
            host: '192.168.1.10',
          ),
        ),
        throwsStateError,
      );
    },
  );
}
