import 'package:flutter_test/flutter_test.dart';
import 'package:patient/reconsent_contract.dart';

class FakeSender implements ReconsentSender {
  FakeSender(this.receipt);

  final ReconsentReceipt receipt;
  final requests = <ReconsentRequest>[];

  @override
  Future<ReconsentReceipt> send(ReconsentRequest request) async {
    requests.add(request);
    return receipt;
  }
}

class FailingSender implements ReconsentSender {
  @override
  Future<ReconsentReceipt> send(ReconsentRequest request) async {
    throw StateError('server failure');
  }
}

void main() {
  const terms = 'terms_of_service';
  const privacy = 'privacy_policy_ack';
  const health = 'health_data_collection';
  const analytics = 'optional_analytics';
  const yes = ConsentDecision(accepted: true, documentVersion: 'v2');
  const no = ConsentDecision(accepted: false, documentVersion: 'v2');

  ConsentRequirements requirements({
    List<String> required = const [terms, privacy, health],
  }) => ConsentRequirements(
    requiredConsents: required,
    documentVersions: {
      terms: 'v2',
      privacy: 'v2',
      health: 'v2',
      analytics: 'v2',
    },
  );

  ReconsentRequest request(
    Map<String, ConsentDecision> consents, {
    String key = 'retry-1',
  }) => ReconsentRequest(idempotencyKey: key, consents: consents);

  test(
    'only a confirmed server receipt is success; retries retain key',
    () async {
      final sender = FakeSender(ReconsentReceipt.confirmed);
      final service = ReconsentService(sender);
      final submission = request({
        terms: yes,
        privacy: yes,
        health: yes,
        analytics: no,
      });
      expect(
        await service.submit(requirements(), submission),
        ReconsentReceipt.confirmed,
      );
      expect(
        await service.submit(requirements(), submission),
        ReconsentReceipt.confirmed,
      );
      expect(sender.requests.map((r) => r.idempotencyKey), [
        'retry-1',
        'retry-1',
      ]);
      expect(sender.requests.first.consents[analytics]!.accepted, isFalse);
    },
  );

  test('unconfirmed and failed sends never become success', () async {
    final submission = request({terms: yes, privacy: yes, health: yes});
    expect(
      await ReconsentService(FakeSender(ReconsentReceipt.notConfirmed))
          .submit(requirements(), submission),
      ReconsentReceipt.notConfirmed,
    );
    await expectLater(
      ReconsentService(FailingSender()).submit(requirements(), submission),
      throwsStateError,
    );
  });

  test('dynamic required list requires every explicit acceptance', () async {
    final sender = FakeSender(ReconsentReceipt.confirmed);
    final service = ReconsentService(sender);
    for (final decisions in [
      {terms: yes},
      {terms: yes, privacy: no, health: yes},
    ]) {
      await expectLater(
        service.submit(requirements(), request(decisions)),
        throwsStateError,
      );
    }
    expect(sender.requests, isEmpty);
    expect(
      await service.submit(
        requirements(required: [terms, privacy, health, analytics]),
        request({terms: yes, privacy: yes, health: yes, analytics: yes}),
      ),
      ReconsentReceipt.confirmed,
    );
  });

  test(
    'rejects empty or unknown settings and unknown or stale decisions',
    () async {
      final sender = FakeSender(ReconsentReceipt.confirmed);
      final service = ReconsentService(sender);
      final invalid = <(ConsentRequirements, ReconsentRequest)>[
        (
          ConsentRequirements(requiredConsents: [], documentVersions: {}),
          request({terms: yes}),
        ),
        (
          ConsentRequirements(
            requiredConsents: ['unknown'],
            documentVersions: {'unknown': 'v2'},
          ),
          request({terms: yes}),
        ),
        (requirements(required: [terms]), request({terms: yes})),
        (
          requirements(),
          request({terms: yes, privacy: yes, health: yes, 'unknown': yes}),
        ),
        (
          requirements(),
          request({
            terms: const ConsentDecision(accepted: true, documentVersion: 'v1'),
            privacy: yes,
            health: yes,
          }),
        ),
        (
          requirements(),
          request({terms: yes, privacy: yes, health: yes}, key: ''),
        ),
        (
          requirements(),
          request({terms: yes, privacy: yes, health: yes}, key: 'bad key'),
        ),
      ];
      for (final (config, submission) in invalid) {
        await expectLater(service.submit(config, submission), throwsStateError);
      }
      expect(sender.requests, isEmpty);
    },
  );
}
