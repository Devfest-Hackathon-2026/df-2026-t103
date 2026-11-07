import 'dart:convert';

import 'package:patient/reconsent_contract.dart';

/// Supplies the metadata response body from the public API.
///
/// This contract retrieves document versions and hashes only. It does not
/// retrieve legal text, record consent, or assert that consent was given.
abstract interface class LegalDocumentMetadataTransport {
  Future<String> getLegalDocumentMetadata();
}

class LegalDocumentClient {
  const LegalDocumentClient(this.transport);

  final LegalDocumentMetadataTransport transport;

  Future<ConsentRequirements> fetchRequirements() async {
    final body = await transport.getLegalDocumentMetadata();
    try {
      final decoded = jsonDecode(body);
      if (decoded is! Map<String, dynamic> ||
          !decoded.containsKey('documents') ||
          !decoded.containsKey('requiredConsents') ||
          !decoded.containsKey('updatedAt')) {
        throw const FormatException('Invalid legal document metadata');
      }
      final rawDocuments = decoded['documents'];
      final rawRequired = decoded['requiredConsents'];
      final updatedAt = decoded['updatedAt'];
      if (rawDocuments is! Map<String, dynamic> ||
          rawRequired is! List<dynamic> ||
          (updatedAt != null && !_isBoundedString(updatedAt, maxLength: 64))) {
        throw const FormatException('Invalid legal document metadata');
      }

      const knownTypes = {
        'terms_of_service',
        'privacy_policy_ack',
        'health_data_collection',
        'hospital_disclosure',
        'optional_analytics',
      };
      if (rawRequired.length > knownTypes.length || rawDocuments.length > 128) {
        throw const FormatException('Invalid legal document metadata');
      }

      final required = <String>[];
      for (final type in rawRequired) {
        if (type is! String ||
            type.length > 64 ||
            !knownTypes.contains(type) ||
            required.contains(type)) {
          throw const FormatException('Invalid legal document metadata');
        }
        required.add(type);
      }

      final versions = <String, String>{};
      for (final entry in rawDocuments.entries) {
        final type = entry.key;
        final value = entry.value;
        if (type.length > 64) {
          throw const FormatException('Invalid legal document metadata');
        }
        // Unknown optional documents do not grant consent and can be ignored.
        // Unknown required types were rejected in the list above.
        if (!knownTypes.contains(type)) continue;
        if (value is! Map<String, dynamic> ||
            !value.containsKey('version') ||
            !value.containsKey('documentHash') ||
            !value.containsKey('publishedAt')) {
          throw const FormatException('Invalid legal document metadata');
        }
        final version = value['version'];
        final hash = value['documentHash'];
        final publishedAt = value['publishedAt'];
        // Hashes are opaque bounded metadata, not an authenticity proof.
        if (version is! String ||
            version.trim().isEmpty ||
            version.length > 100 ||
            !_isBoundedString(hash, maxLength: 256, allowEmpty: false) ||
            !_isPublishedAt(publishedAt)) {
          throw const FormatException('Invalid legal document metadata');
        }
        versions[type] = version;
      }

      final requirements = ConsentRequirements(
        requiredConsents: required,
        documentVersions: versions,
      );
      // Includes baseline-required coverage and required-document version
      // availability. Unknown required types were rejected above.
      requirements.validate();
      return requirements;
    } on FormatException {
      rethrow;
    } on Object {
      throw const FormatException('Invalid legal document metadata');
    }
  }

  static bool _isBoundedString(
    Object? value, {
    required int maxLength,
    bool allowEmpty = true,
  }) =>
      value is String &&
      value.length <= maxLength &&
      (allowEmpty || value.isNotEmpty);

  // The response schema exposes this as a string; the route emits ISO text or
  // an empty string when the source timestamp is missing or invalid.
  static bool _isPublishedAt(Object? value) =>
      _isBoundedString(value, maxLength: 64);
}
