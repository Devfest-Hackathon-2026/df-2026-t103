/// Preparation only: document content and the integration are not approved.
/// This contract does not authenticate users or contact an API.
const _knownConsentTypes = {
  'terms_of_service',
  'privacy_policy_ack',
  'health_data_collection',
  'hospital_disclosure',
  'optional_analytics',
};
const _baselineConsentTypes = {
  'terms_of_service',
  'privacy_policy_ack',
  'health_data_collection',
};

class ConsentDecision {
  const ConsentDecision({
    required this.accepted,
    required this.documentVersion,
  });

  final bool accepted;
  final String documentVersion;
}

/// A snapshot supplied by a future trusted configuration integration.
class ConsentRequirements {
  ConsentRequirements({
    required Iterable<String> requiredConsents,
    required Map<String, String> documentVersions,
  }) : requiredConsents = List.unmodifiable(requiredConsents),
       documentVersions = Map.unmodifiable(documentVersions);

  final List<String> requiredConsents;
  final Map<String, String> documentVersions;

  void validate() {
    if (!requiredConsents.toSet().containsAll(_baselineConsentTypes) ||
        documentVersions.isEmpty ||
        requiredConsents.toSet().length != requiredConsents.length ||
        documentVersions.keys.any(
          (type) => !_knownConsentTypes.contains(type),
        ) ||
        documentVersions.values.any(
          (version) => version.trim().isEmpty || version.length > 100,
        ) ||
        requiredConsents.any((type) => !documentVersions.containsKey(type))) {
      throw StateError('Invalid consent requirements');
    }
  }
}

class ReconsentRequest {
  ReconsentRequest({
    required this.idempotencyKey,
    required Map<String, ConsentDecision> consents,
    this.locale = 'ja-JP',
  }) : consents = Map.unmodifiable(consents);

  /// Reuse the same key only for retries of the identical request. Server
  /// deduplication is scoped to the authenticated principal and operation.
  final String idempotencyKey;
  final Map<String, ConsentDecision> consents;
  final String locale;

  void validate(ConsentRequirements requirements) {
    requirements.validate();
    if (idempotencyKey.isEmpty ||
        idempotencyKey.length > 200 ||
        RegExp(r'\s').hasMatch(idempotencyKey) ||
        !RegExp(r'^[a-zA-Z-]{2,20}$').hasMatch(locale) ||
        consents.isEmpty) {
      throw StateError('Invalid reconsent request');
    }
    for (final type in requirements.requiredConsents) {
      if (consents[type]?.accepted != true) {
        throw StateError('Required consent not granted');
      }
    }
    for (final entry in consents.entries) {
      if (!requirements.documentVersions.containsKey(entry.key) ||
          entry.value.documentVersion !=
              requirements.documentVersions[entry.key]) {
        throw StateError('Unknown consent or outdated document');
      }
    }
  }
}

/// Confirmation must represent the server's successful persisted response,
/// not a locally queued or merely transmitted request.
enum ReconsentReceipt { confirmed, notConfirmed }

abstract interface class ReconsentSender {
  Future<ReconsentReceipt> send(ReconsentRequest request);
}

class ReconsentService {
  const ReconsentService(this.sender);

  final ReconsentSender sender;

  Future<ReconsentReceipt> submit(
    ConsentRequirements requirements,
    ReconsentRequest request,
  ) async {
    request.validate(requirements);
    return sender.send(request);
  }
}
