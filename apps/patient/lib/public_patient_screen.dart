import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'public_patient_api.dart';

class _Utf16LengthLimitingTextInputFormatter extends TextInputFormatter {
  const _Utf16LengthLimitingTextInputFormatter(this.maxCodeUnits);

  final int maxCodeUnits;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (newValue.text.length <= maxCodeUnits) return newValue;
    var end = maxCodeUnits;
    final last = newValue.text.codeUnitAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    final text = newValue.text.substring(0, end);
    final selection = newValue.selection;
    final offset = selection.baseOffset.clamp(0, end);
    final extent = selection.extentOffset.clamp(0, end);
    return TextEditingValue(
      text: text,
      selection: TextSelection(
        baseOffset: offset,
        extentOffset: extent,
        affinity: selection.affinity,
        isDirectional: selection.isDirectional,
      ),
    );
  }
}

/// Patient workflow backed entirely by the authenticated API. PHI is kept in
/// memory and cleared on every auth change. Never uses the preview fixtures.
class PublicPatientScreen extends StatefulWidget {
  const PublicPatientScreen({
    super.key,
    required this.api,
    required this.signIn,
    required this.signOut,
    required this.resetPassword,
    required this.changes,
    this.initialFacilityId = '',
    this.refreshEmailVerification,
    this.sendEmailVerification,
  });
  final PublicPatientApi api;
  final Future<void> Function(String, String) signIn;
  final Future<void> Function() signOut;
  final Future<void> Function(String) resetPassword;
  final Stream<void> changes;
  final String initialFacilityId;
  final Future<bool> Function()? refreshEmailVerification;
  final Future<void> Function()? sendEmailVerification;
  @override
  State<PublicPatientScreen> createState() => _PublicPatientScreenState();
}

class _PublicPatientScreenState extends State<PublicPatientScreen> {
  final _email = TextEditingController(), _password = TextEditingController();
  final _symptom = TextEditingController(),
      _facilityId = TextEditingController();
  final _answerFreeText = TextEditingController();
  late final StreamSubscription<void> _subscription;
  final _profileFields = <String, TextEditingController>{
    for (final key in [
      'familyName',
      'givenName',
      'familyNameKana',
      'givenNameKana',
      'birthDate',
      'phoneNumber',
      'postalCode',
      'prefecture',
      'city',
      'line1',
    ])
      key: TextEditingController(),
  };
  Map<String, dynamic> _legal = {};
  final _accepted = <String>{};
  String? _consentKey;
  String _step = 'login';
  bool _busy = false,
      _answerAttempted = false,
      _answerUncertain = false,
      _reviewed = false,
      _share = false,
      _profile = false,
      _medications = false;
  int _generation = 0;
  String? _error, _notice, _intakeId, _questionnaireId, _deliveryId;
  String? _createKey, _finalizeKey, _sendKey;
  String? _disclosureVersion, _disclosureHash;
  String _bodyLocation = 'whole_body';
  Map<String, dynamic>? _intake, _question, _summary, _facility, _delivery;
  List<dynamic> _history = [];
  int _questionnaireRevision = 1;
  PublicPatientApi get api => widget.api;
  String _id(Object? value) {
    if (value is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{1,200}$').hasMatch(value)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    return value;
  }

  int _revision(Map<String, dynamic> data) {
    final revision = data['revision'] ?? data['intakeRevision'];
    if (revision is! int || revision < 1) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    return revision;
  }

  @override
  void initState() {
    super.initState();
    _facilityId.text = widget.initialFacilityId;
    _subscription = widget.changes.listen((_) {
      if (!mounted) return;
      setState(() {
        _generation++;
        _clear();
        _step = 'login';
        _busy = false;
      });
    });
  }

  void _clear() {
    _intake = _question = _summary = _facility = _delivery = null;
    _intakeId = _questionnaireId = _deliveryId = null;
    _createKey = _finalizeKey = _sendKey = null;
    _disclosureVersion = null;
    _disclosureHash = null;
    _history = [];
    _symptom.clear();
    _answerFreeText.clear();
    _answerAttempted = false;
    _answerUncertain = false;
    _legal = {};
    _accepted.clear();
    _consentKey = null;
    for (final field in _profileFields.values) {
      field.clear();
    }
    _password.clear();
    _bodyLocation = 'whole_body';
    _questionnaireRevision = 1;
    _reviewed = _share = _profile = _medications = false;
    _error = _notice = null;
  }

  @override
  void dispose() {
    _subscription.cancel();
    for (final c in [
      _email,
      _password,
      _symptom,
      _answerFreeText,
      _facilityId,
      ..._profileFields.values,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    final generation = _generation;
    setState(() {
      _busy = true;
      _error = _notice = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted && generation == _generation) {
        setState(() {
          _error = e is PatientRequestFailure
              ? e.message
              : '操作を完了できません。入力内容と接続を確認してください。';
        });
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  Future<void> _login() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.signIn(_email.text.trim(), _password.text);
      if (!mounted) return;
      setState(() {
        _busy = true;
      });
      _password.clear();
      final generation = _generation;
      await _resumeRegistration();
      if (!mounted || generation != _generation) return;
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e is PatientRequestFailure
              ? e.message
              : 'メールアドレス・パスワードと接続を確認してください。';
        });
      }
    } finally {
      _password.clear();
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  Future<void> _resumeRegistration() async {
    final generation = _generation;
    final refresh = widget.refreshEmailVerification;
    if (refresh != null && !await refresh()) {
      if (mounted && generation == _generation) {
        setState(() {
          _step = 'verify';
        });
      }
      return;
    }
    final me = await api.request('GET', '/me');
    if (!mounted || generation != _generation) return;
    final status = me['accountStatus'];
    if (status != null &&
        status != 'active' &&
        status != 'onboarding_pending') {
      throw const PatientRequestFailure('403');
    }
    if (me['emailVerified'] != true) {
      setState(() {
        _step = 'verify';
      });
      return;
    }
    final consent = me['requiredConsents'];
    if (consent is! Map || consent['current'] != true) {
      await _loadRegistrationDocuments();
      return;
    }
    setState(() {
      _step = status == 'active' && me['profileComplete'] == true
          ? 'home'
          : 'profile';
    });
  }

  Future<void> _loadRegistrationDocuments() async {
    final generation = _generation;
    final response = await api.request('GET', '/public/legal-documents');
    final required = response['requiredConsents'];
    final documents = response['documents'];
    const baseline = {
      'terms_of_service',
      'privacy_policy_ack',
      'health_data_collection',
    };
    if (required is! List ||
        documents is! Map ||
        required.isEmpty ||
        !required.toSet().containsAll(baseline)) {
      throw const PatientRequestFailure('LEGAL_UNAVAILABLE');
    }
    final selected = <String, dynamic>{};
    for (final type in required) {
      final doc = documents[type];
      if (type is! String ||
          !_legalLabels.containsKey(type) ||
          doc is! Map ||
          doc['text'] is! String ||
          (doc['text'] as String).trim().isEmpty ||
          (doc['text'] as String).length > 50000 ||
          doc['version'] is! String ||
          (doc['version'] as String).isEmpty ||
          doc['documentHash'] is! String ||
          (doc['documentHash'] as String).isEmpty) {
        throw const PatientRequestFailure('LEGAL_UNAVAILABLE');
      }
      selected[type] = Map<String, dynamic>.from(doc);
    }
    if (!mounted || generation != _generation) return;
    setState(() {
      _legal = selected;
      _accepted.clear();
      _consentKey = null;
      _step = 'consent';
    });
  }

  Future<void> _submitRegistrationConsents() async {
    if (_legal.isEmpty || !_accepted.containsAll(_legal.keys)) {
      throw const PatientRequestFailure('412');
    }
    _consentKey ??= patientOperationKey();
    try {
      await api.request(
        'POST',
        '/onboarding/consents',
        key: _consentKey,
        body: {
          'locale': 'ja-JP',
          'consents': {
            for (final entry in _legal.entries)
              entry.key: {
                'accepted': true,
                'documentVersion': entry.value['version'],
              },
          },
        },
      );
    } on PatientRequestFailure catch (e) {
      if (e.code == '412') await _loadRegistrationDocuments();
      rethrow;
    }
    await _resumeRegistration();
  }

  Future<void> _saveRegistrationProfile() async {
    final fields = {
      for (final e in _profileFields.entries) e.key: e.value.text.trim(),
    };
    if (fields.values.any((v) => v.isEmpty)) {
      throw const PatientRequestFailure('400');
    }
    await api.request(
      'PATCH',
      '/me/profile',
      body: {
        for (final entry in fields.entries)
          if (!{'prefecture', 'city', 'line1'}.contains(entry.key))
            entry.key: entry.value,
        'address': {
          for (final key in ['prefecture', 'city', 'line1']) key: fields[key],
        },
      },
    );
    await _resumeRegistration();
  }

  static const _legalLabels = {
    'terms_of_service': '利用規約',
    'privacy_policy_ack': 'プライバシーについて',
    'health_data_collection': '健康情報の取得について',
    'hospital_disclosure': '医療機関への情報提供について',
    'optional_analytics': '利用状況の解析について',
  };

  Future<void> _loadIntake({int? generation}) async {
    final result = await api.request('GET', '/intakes/${_id(_intakeId)}');
    if (generation != null && !_isCurrent(generation)) return;
    _intake = result;
    _revision(_intake!);
  }

  bool _validAnswers(Object? value) =>
      value is List &&
      value.every(
        (answer) =>
            answer is Map<String, dynamic> &&
            answer.keys.toSet().containsAll(const {
              'answerId',
              'questionId',
              'questionRevision',
              'stepIndex',
              'selectedCodes',
              'freeText',
              'answerState',
              'answeredAt',
              'updatedAt',
            }) &&
            answer['answerId'] is String &&
            answer['questionId'] is String &&
            answer['questionRevision'] is int &&
            answer['stepIndex'] is int &&
            answer['selectedCodes'] is List &&
            (answer['selectedCodes'] as List).every((code) => code is String) &&
            (answer['freeText'] == null || answer['freeText'] is String) &&
            {'answered', 'unknown', 'skipped'}.contains(answer['answerState']) &&
            answer['answeredAt'] is String &&
            answer['updatedAt'] is String,
      );

  Future<void> _saveSymptoms() async {
    final text = _symptom.text.trim();
    if (text.isEmpty || text.length > 1000) {
      throw const PatientRequestFailure('400');
    }
    _createKey ??= patientOperationKey();
    if (_intakeId == null) {
      final created = await api.request(
        'POST',
        '/intakes',
        key: _createKey,
        body: {'locale': 'ja-JP'},
      );
      _intakeId = _id(created['intakeId']);
    }
    await _loadIntake();
    if (_intake!['status'] == 'draft') {
      await api.request(
        'POST',
        '/intakes/$_intakeId/symptoms',
        body: {
          'initialSymptomText': text,
          'bodyLocations': [_bodyLocation],
          'expectedIntakeRevision': _revision(_intake!),
        },
      );
    }
    await _nextQuestion();
  }

  Future<void> _nextQuestion() async {
    final generation = _generation;
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    if (_intake!['status'] == 'review') {
      await _review();
      if (!_isCurrent(generation)) return;
      return;
    }
    if (_intake!['status'] == 'finalized') {
      await _loadHistory();
      if (!_isCurrent(generation)) return;
      return;
    }
    if (_intake!['status'] != 'questioning') {
      throw const PatientRequestFailure('412');
    }
    final questions = _intake!['questions'];
    final answers = _intake!['answers'];
    if (questions is! List || !_validAnswers(answers)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    final pending = questions.whereType<Map<String, dynamic>>().where(
      (q) =>
          q['status'] == 'active' &&
          !answers.whereType<Map>().any(
            (a) =>
                a['questionId'] == q['questionId'] &&
                a['questionRevision'] == q['questionRevision'],
          ),
    );
    final previousQuestion = _question;
    if (pending.isNotEmpty) {
      _question = pending.first;
    } else {
      final next = await api.request(
        'POST',
        '/intakes/$_intakeId/next-question',
        body: {'expectedIntakeRevision': _revision(_intake!)},
      );
      if (!_isCurrent(generation)) return;
      if (next['question'] == null) {
        await _review();
        if (!_isCurrent(generation)) return;
        return;
      }
      _question = Map<String, dynamic>.from(next['question'] as Map);
    }
    if (!_isCurrent(generation)) return;
    if (previousQuestion?['questionId'] != _question?['questionId'] ||
        previousQuestion?['questionRevision'] !=
            _question?['questionRevision']) {
      _answerFreeText.clear();
      _answerAttempted = false;
      _answerUncertain = false;
    }
    _id(_question!['questionId']);
    if (_question!['questionText'] is! String ||
        _question!['options'] is! List) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    if (mounted) {
      setState(() {
        _step = 'question';
      });
    }
  }

  Future<void> _answer(String? code, String state) async {
    if (_answerAttempted) return;
    final q = _question!;
    final generation = _generation;
    final freeText = _answerFreeText.text;
    if (code != null && state == 'answered' && freeText.length > 2000) {
      throw const PatientRequestFailure('400');
    }
    try {
      await _loadIntake(generation: generation);
    } catch (_) {
      if (_isCurrent(generation)) _answerAttempted = false;
      rethrow;
    }
    if (!_isCurrent(generation)) return;
    final currentAnswers = _intake?['answers'];
    if (!_validAnswers(currentAnswers)) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    if ((currentAnswers as List).any(
          (answer) =>
              answer['questionId'] == q['questionId'] &&
              answer['questionRevision'] == q['questionRevision'],
        )) {
      _answerAttempted = false;
      throw const PatientRequestFailure('412');
    }
    // Only lock the user's answer once the preflight snapshot succeeded. The
    // GET cannot establish that this user's answer was saved by another writer.
    _answerAttempted = true;
    try {
      await api.request(
        'POST',
        '/intakes/$_intakeId/answers',
        body: {
          'questionId': _id(q['questionId']),
          'questionRevision': q['questionRevision'],
          'selectedCodes': code == null ? <String>[] : [code],
          'answerState': state,
          if (code != null && state == 'answered' && freeText.trim().isNotEmpty)
            'freeText': freeText,
          'expectedIntakeRevision': _revision(_intake!),
        },
      );
    } catch (_) {
      if (_isCurrent(generation)) _answerUncertain = true;
      rethrow;
    }
    if (!_isCurrent(generation)) return;
    await _nextQuestion();
  }

  bool _isCurrent(int generation) => mounted && generation == _generation;

  Future<void> _review() async {
    final generation = _generation;
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    final result = await api.request(
      'POST',
      '/intakes/$_intakeId/summary',
      body: {'expectedIntakeRevision': _revision(_intake!)},
    );
    if (!_isCurrent(generation)) return;
    _summary = Map<String, dynamic>.from(result['summary'] as Map);
    await _loadIntake(generation: generation);
    if (!_isCurrent(generation)) return;
    if (mounted) {
      setState(() {
        _reviewed = false;
        _step = 'review';
      });
    }
  }

  Future<void> _finalize() async {
    if (!_reviewed) throw const PatientRequestFailure('412');
    _finalizeKey ??= patientOperationKey();
    final result = await api.request(
      'POST',
      '/intakes/$_intakeId/finalize',
      key: _finalizeKey,
      body: {
        'expectedIntakeRevision': _revision(_intake!),
        'summaryReviewConfirmed': true,
      },
    );
    _questionnaireId = _id(result['questionnaireId']);
    _questionnaireRevision = result['questionnaireRevision'] as int;
    if (mounted) {
      setState(() {
        _step = 'send';
      });
    }
    if (_facilityId.text.trim().isNotEmpty) await _loadFacility();
  }

  Future<void> _loadFacility() async {
    _facility = null;
    _disclosureVersion = null;
    _disclosureHash = null;
    _share = false;
    _sendKey = null;
    final result = await api.request(
      'GET',
      '/facilities/${_id(_facilityId.text.trim())}',
    );
    final docs = await api.request('GET', '/public/legal-documents');
    final version = (docs['documents'] as Map?)?['hospital_disclosure'];
    if (version is! Map ||
        version['version'] is! String ||
        (version['version'] as String).trim().isEmpty ||
        version['documentHash'] is! String ||
        (version['documentHash'] as String).trim().isEmpty) {
      throw const PatientRequestFailure('412');
    }
    if (mounted) {
      setState(() {
        _facility = result;
        _disclosureVersion = version['version'] as String;
        _disclosureHash = version['documentHash'] as String;
      });
    }
  }

  Future<void> _send() async {
    final facility = _facility;
    if (facility == null ||
        !_share ||
        facility['verificationStatus'] != 'verified' ||
        facility['receivingEnabled'] != true) {
      throw const PatientRequestFailure('412');
    }
    if (_disclosureVersion == null || _disclosureHash == null) {
      throw const PatientRequestFailure('412');
    }
    _sendKey ??= patientOperationKey();
    final scope = {
      'includeProfile': _profile,
      'includeConfirmedMedications': _medications,
      'includePrescriptionImages': false,
    };
    final result = await api.request(
      'POST',
      '/deliveries',
      key: _sendKey,
      body: {
        'questionnaireId': _id(_questionnaireId),
        'questionnaireRevision': _questionnaireRevision,
        'facilityId': _id(facility['facilityId']),
        'shareScope': scope,
        'consent': {
          'accepted': true,
          'documentVersion': _disclosureVersion,
          'documentHash': _disclosureHash,
          'shareScope': scope,
        },
      },
    );
    _deliveryId = _id(result['deliveryId']);
    if (mounted) {
      setState(() {
        _step = 'delivery';
      });
    }
    await _refreshDelivery();
  }

  Future<void> _refreshDelivery() async {
    final result = await api.request('GET', '/deliveries/${_id(_deliveryId)}');
    if (mounted) {
      setState(() {
        _delivery = result;
      });
    }
  }

  Future<void> _loadHistory() async {
    final generation = _generation;
    final result = await api.request('GET', '/questionnaires');
    if (!_isCurrent(generation)) return;
    if (result['questionnaires'] is! List) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    if (mounted) {
      setState(() {
        _history = result['questionnaires'] as List;
        _step = 'history';
      });
    }
  }

  Future<void> _openQuestionnaire(Map row) async {
    final result = await api.request(
      'GET',
      '/questionnaires/${_id(row['questionnaireId'])}',
    );
    final revision = result['revision'];
    if (revision is! Map<String, dynamic>) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    _summary = revision;
    _questionnaireId = _id(result['questionnaireId']);
    _questionnaireRevision = revision['versionNumber'] as int;
    _facility = null;
    _share = false;
    _sendKey = null;
    if (mounted) {
      setState(() {
        _step = 'send';
      });
    }
  }

  Widget _button(
    String text,
    Future<void> Function() action, {
    bool enabled = true,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: FilledButton(
      onPressed: _busy || !enabled ? null : () => _run(action),
      child: Text(text),
    ),
  );
  Widget _field(
    String label,
    TextEditingController controller, {
    bool secret = false,
    int lines = 1,
    bool readOnly = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: TextField(
      key: ValueKey(label),
      controller: controller,
      enabled: !_busy,
      readOnly: readOnly,
      obscureText: secret,
      minLines: lines,
      maxLines: lines,
      autocorrect: false,
      enableSuggestions: !secret,
      keyboardType: secret
          ? TextInputType.visiblePassword
          : label == 'メールアドレス'
          ? TextInputType.emailAddress
          : TextInputType.text,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    ),
  );
  List<Widget> _summaryWidgets() {
    final summary = _summary;
    if (summary == null) return [];
    final chief = summary['chiefComplaint'];
    final sections = summary['sections'];
    return [
      const Text('あなたが伝えたいこと', style: TextStyle(fontWeight: FontWeight.bold)),
      Text(chief is Map ? '${chief['value'] ?? '未回答'}' : '未回答'),
      if (sections is Map)
        ...sections.entries.map(
          (entry) => Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              '${_topic('${entry.key}')}：${entry.value is Map ? entry.value['value'] ?? '未回答' : '未回答'}',
            ),
          ),
        ),
      const SizedBox(height: 12),
      const Text('記載されていない内容は未回答です。診断結果ではありません。'),
    ];
  }

  String _topic(String name) =>
      const {
        'onset_timing': '症状が始まった時期',
        'severity': '症状の強さ',
        'frequency': '頻度',
        'life_impact': '生活への影響',
        'associated_symptoms': 'ほかの症状',
        'current_medication': '服薬',
        'medical_history': '持病・既往歴',
        'allergy': 'アレルギー',
      }[name] ??
      'その他';
  List<Widget> _content() => switch (_step) {
    'login' => [
      const Text(
        '医療機関に伝えたいことを、あなたの言葉で。',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 12),
      const Text('発行されたアカウントでログインしてください。未完了の登録手続きはログイン後に案内します。'),
      _field('メールアドレス', _email),
      _field('パスワード', _password, secret: true),
      FilledButton(onPressed: _busy ? null : _login, child: const Text('ログイン')),
      TextButton(
        onPressed: _busy
            ? null
            : () => _run(() async {
                if (_email.text.trim().isEmpty) {
                  throw const PatientRequestFailure('400');
                }
                try {
                  await widget.resetPassword(_email.text.trim());
                } catch (_) {
                  /* Do not disclose account existence. */
                }
                if (mounted) {
                  setState(() {
                    _notice = '該当するアカウントがあれば、再設定メールを送信します。';
                  });
                }
              }),
        child: const Text('パスワードを再設定'),
      ),
    ],
    'verify' => [
      const Text(
        'メールアドレスの確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('確認メール内のリンクを開いたあと、「確認状況を更新」を押してください。'),
      _button('確認メールを送信', () async {
        final send = widget.sendEmailVerification;
        if (send == null) throw const PatientRequestFailure('UNAVAILABLE');
        await send();
        if (mounted) {
          setState(() {
            _notice = '確認メールを送信しました。';
          });
        }
      }, enabled: widget.sendEmailVerification != null),
      _button('確認状況を更新', _resumeRegistration),
    ],
    'consent' => [
      const Text(
        'ご利用前の確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('各文書を読み、同意する項目を選んでください。医療機関への送信は、問診後に別途確認します。'),
      for (final entry in _legal.entries) ...[
        const SizedBox(height: 20),
        Text(
          '${_legalLabels[entry.key]}（${entry.value['version']}）',
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        SelectableText(entry.value['text'] as String),
        CheckboxListTile(
          title: Text('${_legalLabels[entry.key]}に同意する'),
          value: _accepted.contains(entry.key),
          onChanged: _busy || _consentKey != null
              ? null
              : (value) => setState(() {
                  if (value == true) {
                    _accepted.add(entry.key);
                  } else {
                    _accepted.remove(entry.key);
                  }
                }),
        ),
      ],
      _button(
        '同意して登録を続ける',
        _submitRegistrationConsents,
        enabled: _legal.isNotEmpty && _accepted.containsAll(_legal.keys),
      ),
    ],
    'profile' => [
      const Text(
        'プロフィール登録',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('問診を始める前に必須項目を入力してください。'),
      for (final entry in const {
        'familyName': '姓',
        'givenName': '名',
        'familyNameKana': '姓（カタカナ）',
        'givenNameKana': '名（カタカナ）',
        'birthDate': '生年月日（例：1990-01-01）',
        'phoneNumber': '電話番号',
        'postalCode': '郵便番号（7桁）',
        'prefecture': '都道府県（例：東京都）',
        'city': '市区町村',
        'line1': '町名・番地',
      }.entries)
        _field(entry.value, _profileFields[entry.key]!),
      _button('プロフィールを保存して問診へ', _saveRegistrationProfile),
    ],
    'home' => [
      const Text(
        '今日は、どんなことを伝えたいですか？',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 16),
      const Text('症状の入力 → 質問への回答 → 内容の確認 → 施設へ送信'),
      const SizedBox(height: 24),
      _button('新しい問診をはじめる', () async {
        _clear();
        setState(() {
          _step = 'symptom';
        });
      }),
      _button('過去の問診票を見る', _loadHistory),
    ],
    'symptom' => [
      const Text(
        '気になる症状を入力',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const Text('いつから、どこが、どのようにつらいか、書ける範囲で入力してください。'),
      _field('症状（1〜1000文字）', _symptom, lines: 5, readOnly: _createKey != null),
      DropdownButtonFormField<String>(
        initialValue: _bodyLocation,
        decoration: const InputDecoration(labelText: '気になる部位'),
        items:
            const {
                  'whole_body': '全身・特定できない',
                  'head': '頭',
                  'throat': '喉',
                  'chest': '胸',
                  'abdomen': 'お腹',
                  'upper_back': '背中',
                  'lower_back': '腰',
                  'skin': '皮膚',
                  'other': 'その他',
                }.entries
                .map(
                  (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                )
                .toList(),
        onChanged: _busy || _createKey != null
            ? null
            : (v) => setState(() {
                _bodyLocation = v!;
              }),
      ),
      _button(_createKey == null ? '保存して質問へ進む' : '保存状態を再確認', _saveSymptoms),
    ],
    'question' => [
      Semantics(
        header: true,
        child: Text(
          '質問 ${(_question?['stepIndex'] as int? ?? 0) + 1}',
          style: const TextStyle(color: Colors.teal),
        ),
      ),
      const SizedBox(height: 12),
      Text(
        '${_question?['questionText'] ?? ''}',
        style: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 16),
      ...((_question?['options'] as List?) ?? []).whereType<Map>().map(
        (o) => _button(
          '${o['label']}',
          () => _answer('${o['code']}', 'answered'),
          enabled: !_answerAttempted,
        ),
      ),
      TextField(
        key: const ValueKey('回答（任意）'),
        controller: _answerFreeText,
        enabled: !_busy && !_answerAttempted,
        minLines: 3,
        maxLines: 6,
        inputFormatters: const [_Utf16LengthLimitingTextInputFormatter(2000)],
        decoration: const InputDecoration(
          labelText: '回答（任意）',
          helperText: '選択肢に補足したいことがあれば入力してください（最大2000文字分。絵文字などは2文字分）',
          border: OutlineInputBorder(),
        ),
      ),
      _button(
        'わからない',
        () => _answer(null, 'unknown'),
        enabled: !_answerAttempted,
      ),
      _button(
        '答えたくない',
        () => _answer(null, 'skipped'),
        enabled: !_answerAttempted,
      ),
      if (_answerUncertain)
        Semantics(
          liveRegion: true,
          child: Text(
            '回答の保存結果を確認できません。誤った回答への置き換えを防ぐため、自動進行・再送を停止しました。サポートへお問い合わせください。',
          ),
        )
      else
        TextButton(
          onPressed: _busy ? null : () => _run(_nextQuestion),
          child: const Text('保存状態を再確認'),
        ),
    ],
    'review' => [
      const Text(
        '送信前に内容を確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      ..._summaryWidgets(),
      CheckboxListTile(
        value: _reviewed,
        onChanged: _busy
            ? null
            : (v) => setState(() {
                _reviewed = v!;
              }),
        title: const Text('問診の内容を確認しました'),
        controlAffinity: ListTileControlAffinity.leading,
      ),
      _button('この内容で問診票を確定', _finalize, enabled: _reviewed),
    ],
    'send' => [
      const Text(
        '送信先と共有内容を確認',
        style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      ..._summaryWidgets(),
      const Divider(height: 32),
      _field('施設コード', _facilityId, readOnly: _sendKey != null),
      _button('施設を確認', _loadFacility, enabled: _sendKey == null),
      if (_facility != null) ...[
        Text(
          '${_facility!['displayName']}',
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        Text('${_facility!['formattedAddress'] ?? ''}'),
        if (_facility!['verificationStatus'] != 'verified' ||
            _facility!['receivingEnabled'] != true)
          const Text('この施設は現在受け付けていません。送信できません。'),
        CheckboxListTile(
          value: _profile,
          onChanged: _busy || _sendKey != null
              ? null
              : (v) => setState(() {
                  _profile = v!;
                }),
          title: const Text('氏名・連絡先と持病を一緒に共有する'),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        CheckboxListTile(
          value: _medications,
          onChanged: _busy || _sendKey != null
              ? null
              : (v) => setState(() {
                  _medications = v!;
                }),
          title: const Text('確認済みの薬剤情報を共有する'),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        CheckboxListTile(
          value: _share,
          onChanged: _busy || _sendKey != null
              ? null
              : (v) => setState(() {
                  _share = v!;
                }),
          title: Text(
            '「${_facility!['displayName']}」へ、この問診票と選択した情報を送信することに同意します',
          ),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        _button(
          _sendKey == null ? '同意した施設へ送信' : '同じ送信の結果を再確認',
          _send,
          enabled:
              _share &&
              _facility!['verificationStatus'] == 'verified' &&
              _facility!['receivingEnabled'] == true,
        ),
      ],
    ],
    'delivery' => [
      const Icon(Icons.check_circle_outline, size: 56, color: Colors.teal),
      const Text(
        '送信状況',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      Text(switch (_delivery?['status']) {
        'created' => '受付済み・配送処理中',
        'delivered' => '施設の受信箱へ届きました',
        'acknowledged' => '施設が受領を確認しました',
        'failed' => '配送に失敗しました',
        'revoked' => '送信は取り消されました',
        _ => '状況を確認してください',
      }),
      const Text('受信・受領確認は診察や予約の確定ではありません。'),
      _button('送信状況を更新', _refreshDelivery),
      _button('ホームへ戻る', () async {
        _clear();
        setState(() {
          _step = 'home';
        });
      }),
    ],
    'history' => [
      const Text(
        '過去の問診票',
        style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
      ),
      if (_history.isEmpty) const Text('確定した問診票はまだありません。'),
      ..._history.whereType<Map>().map(
        (row) => Card(
          child: ListTile(
            title: const Text('確定済み問診票'),
            subtitle: Text('${row['finalizedAt'] ?? ''}'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _busy ? null : () => _run(() => _openQuestionnaire(row)),
          ),
        ),
      ),
    ],
    _ => [],
  };
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('もしもし問診'),
      actions: [
        if (_step != 'login')
          TextButton(
            onPressed: _busy ? null : () => _run(widget.signOut),
            child: const Text('ログアウト'),
          ),
      ],
    ),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Theme.of(context)
                        .colorScheme
                        .surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Text('確認用公開版です。架空の情報でお試しください。診断・治療・予約は行いません。'),
                ),
                const SizedBox(height: 24),
                if (_busy) const LinearProgressIndicator(),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  ),
                if (_notice != null)
                  Semantics(liveRegion: true, child: Text(_notice!)),
                ..._content(),
                if (![
                  'login',
                  'home',
                  'verify',
                  'consent',
                  'profile',
                ].contains(_step))
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                            _step = 'home';
                          }),
                    child: const Text('ホームへ'),
                  ),
                const SizedBox(height: 24),
                const Text(
                  '問診は医療機関へ伝える情報を整理するものです。',
                  style: TextStyle(fontSize: 16),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
