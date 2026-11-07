import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'firebase_bootstrap.dart' show allowsAndroidHostAlias;
import 'legal_document_client.dart';

/// Local demo origins only. The caller owns and closes [client].
class DemoLegalDocumentTransport implements LegalDocumentMetadataTransport {
  DemoLegalDocumentTransport({
    required String baseUrl,
    required this.client,
    this.timeout = const Duration(seconds: 10),
  }) : _url = _legalDocumentsUrl(baseUrl) {
    if (timeout <= Duration.zero) throw ArgumentError('Invalid timeout');
  }

  final http.Client client;
  final Uri _url;
  final Duration timeout;
  static const int _maxResponseBytes = 64 * 1024;

  static Uri _legalDocumentsUrl(String baseUrl) {
    const origins = {'http://localhost:8080', 'http://127.0.0.1:8080'};
    final androidOrigin = 'http://10.0.2.2:8080';
    if (!origins.contains(baseUrl) &&
        !(allowsAndroidHostAlias && baseUrl == androidOrigin)) {
      throw ArgumentError('Only explicit local demo API origins are allowed');
    }
    return Uri.parse('$baseUrl/v1/public/legal-documents');
  }

  @override
  Future<String> getLegalDocumentMetadata() async {
    final abort = Completer<void>();
    final request =
        http.AbortableRequest('GET', _url, abortTrigger: abort.future)
          ..followRedirects = false
          ..headers['accept'] = 'application/json';

    Future<String> send() async {
      final response = await client.send(request);
      if (response.statusCode != 200 ||
          (response.contentLength != null &&
              response.contentLength! > _maxResponseBytes)) {
        throw const FormatException('Invalid legal document response');
      }
      final bytes = <int>[];
      await for (final chunk in response.stream) {
        if (bytes.length + chunk.length > _maxResponseBytes) {
          throw const FormatException('Invalid legal document response');
        }
        bytes.addAll(chunk);
      }
      return utf8.decode(bytes, allowMalformed: false);
    }

    try {
      return await send().timeout(timeout);
    } catch (_) {
      // Do not expose transport errors that may contain request details.
      throw StateError('Legal document metadata transport failed');
    } finally {
      if (!abort.isCompleted) abort.complete();
    }
  }
}
