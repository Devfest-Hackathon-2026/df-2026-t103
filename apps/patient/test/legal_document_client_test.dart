import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:patient/legal_document_client.dart';

class FakeMetadataTransport implements LegalDocumentMetadataTransport {
  FakeMetadataTransport(this.body);
  final String body;

  @override
  Future<String> getLegalDocumentMetadata() async => body;
}

const terms = 'terms_of_service';
const privacy = 'privacy_policy_ack';
const health = 'health_data_collection';

// Mirrors DEV_LEGAL_DOCUMENTS and the public route's response normalization.
Map<String, Object?> devSeedResponse() => {
  'documents': <String, Object?>{
    terms: {
      'version': '2026-11-01',
      'documentHash': 'sha256:2f1c9b4f6b4f6b6c9f2a7f3f9b6c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c',
      'publishedAt': '2026-11-01T00:00:00Z',
    },
    privacy: {
      'version': '2026-11-01',
      'documentHash': 'sha256:8a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c',
      'publishedAt': '2026-11-01T00:00:00Z',
    },
    health: {
      'version': '2026-11-01',
      'documentHash': 'sha256:5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d',
      'publishedAt': '2026-11-01T00:00:00Z',
    },
    'hospital_disclosure': {
      'version': '2026-11-01',
      'documentHash': 'sha256:1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e',
      'publishedAt': '2026-11-01T00:00:00Z',
    },
  },
  'requiredConsents': [terms, privacy, health],
  'updatedAt': null,
};

void main() {
  test('parses the DEV seed response as metadata only', () async {
    final result = await LegalDocumentClient(
      FakeMetadataTransport(jsonEncode(devSeedResponse())),
    ).fetchRequirements();
    expect(result.requiredConsents, [terms, privacy, health]);
    expect(result.documentVersions[terms], '2026-11-01');
    expect(result.documentVersions, hasLength(4));
  });

  test(
    'rejects unknown required types and missing required documents',
    () async {
      for (final payload in [
        {
          ...devSeedResponse(),
          'requiredConsents': [terms, privacy, health, 'future_type'],
        },
        {
          ...devSeedResponse(),
          'documents': {terms: devSeedResponse()['documents']},
        },
      ]) {
        await expectLater(
          LegalDocumentClient(FakeMetadataTransport(jsonEncode(payload)))
              .fetchRequirements(),
          throwsFormatException,
        );
      }
    },
  );

  test(
    'allows compatible optional extensions and bounded opaque hashes',
    () async {
      final payload = devSeedResponse();
      final documents = payload['documents'] as Map<String, Object?>;
      documents['future_optional'] = {
        'version': 'future',
        'documentHash': 'opaque:vendor-format',
        'publishedAt': '',
      };
      documents[terms] = {
        'version': '2026-11-01',
        'documentHash': 'opaque:vendor-format',
        'publishedAt': '',
        'futureField': true,
      };
      payload['futureResponseField'] = true;

      final result = await LegalDocumentClient(
        FakeMetadataTransport(jsonEncode(payload)),
      ).fetchRequirements();
      expect(result.documentVersions[terms], '2026-11-01');
      expect(result.documentVersions, isNot(contains('future_optional')));
    },
  );

  test(
    'rejects malformed JSON, oversized values, invalid hashes and versions',
    () async {
      await expectLater(
        LegalDocumentClient(FakeMetadataTransport('{')).fetchRequirements(),
        throwsFormatException,
      );
      final hugeVersion = devSeedResponse();
      (hugeVersion['documents'] as Map<String, Object?>)[terms] = {
        'version': 'v' * 101,
        'documentHash': 'opaque',
        'publishedAt': '',
      };
      final hugeHash = devSeedResponse();
      ((hugeHash['documents'] as Map<String, Object?>)[terms]
              as Map<String, Object?>)['documentHash'] =
          'h' * 257;
      for (final payload in [hugeVersion, hugeHash]) {
        await expectLater(
          LegalDocumentClient(FakeMetadataTransport(jsonEncode(payload)))
              .fetchRequirements(),
          throwsFormatException,
        );
      }
    },
  );
}
