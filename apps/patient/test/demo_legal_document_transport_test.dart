import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/demo_legal_document_transport.dart';

class MockClient extends http.BaseClient {
  MockClient(this.handler);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      handler(request);
}

void main() {
  test('GETs the fixed metadata endpoint without redirects', () async {
    final transport = DemoLegalDocumentTransport(
      baseUrl: 'http://localhost:8080',
      client: MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/v1/public/legal-documents');
        expect(request.followRedirects, isFalse);
        return http.StreamedResponse(Stream.value(utf8.encode('{}')), 200);
      }),
    );
    expect(await transport.getLegalDocumentMetadata(), '{}');
  });

  test('rejects non-loopback hosts and gates Android alias by platform', () {
    for (final host in [
      'https://localhost:8080',
      'http://localhost:8081',
      'http://evil.example:8080',
    ]) {
      expect(
        () => DemoLegalDocumentTransport(
          baseUrl: host,
          client: MockClient((_) async => throw StateError('unexpected')),
        ),
        throwsArgumentError,
      );
    }
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(
      () => DemoLegalDocumentTransport(
        baseUrl: 'http://10.0.2.2:8080',
        client: MockClient((_) async => throw StateError('unexpected')),
      ),
      throwsArgumentError,
    );
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(
      () => DemoLegalDocumentTransport(
        baseUrl: 'http://10.0.2.2:8080',
        client: MockClient((_) async => throw StateError('unexpected')),
      ),
      returnsNormally,
    );
  });

  test(
    'fails closed for redirects, bad status, oversized body and timeout',
    () async {
      final handlers =
          <Future<http.StreamedResponse> Function(http.BaseRequest)>[
            (_) async => http.StreamedResponse(const Stream.empty(), 302),
            (_) async => http.StreamedResponse(const Stream.empty(), 503),
            (_) async =>
                http.StreamedResponse(Stream.value(List.filled(65537, 0)), 200),
            (_) => Completer<http.StreamedResponse>().future,
          ];
      for (final handler in handlers) {
        final transport = DemoLegalDocumentTransport(
          baseUrl: 'http://localhost:8080',
          client: MockClient(handler),
          timeout: const Duration(milliseconds: 20),
        );
        await expectLater(
          transport.getLegalDocumentMetadata(),
          throwsStateError,
        );
      }
    },
  );
}
