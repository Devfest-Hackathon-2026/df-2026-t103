import 'dart:async';

import 'package:flutter/material.dart';

import 'public_patient_api.dart';

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
  });
  final PublicPatientApi api;
  final Future<void> Function(String, String) signIn;
  final Future<void> Function() signOut;
  final Future<void> Function(String) resetPassword;
  final Stream<void> changes;
  final String initialFacilityId;
  @override
  State<PublicPatientScreen> createState() => _PublicPatientScreenState();
}

class _PublicPatientScreenState extends State<PublicPatientScreen> {
  final _email = TextEditingController(), _password = TextEditingController();
  final _symptom = TextEditingController(),
      _facilityId = TextEditingController();
  late final StreamSubscription<void> _subscription;
  String _step = 'login';
  bool _busy = false,
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
    _password.clear();
    _bodyLocation = 'whole_body';
    _questionnaireRevision = 1;
    _reviewed = _share = _profile = _medications = false;
    _error = _notice = null;
  }

  @override
  void dispose() {
    _subscription.cancel();
    for (final c in [_email, _password, _symptom, _facilityId]) {
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
      final me = await api.request('GET', '/me');
      if (!mounted || generation != _generation) return;
      final consent = me['requiredConsents'];
      if (me['accountStatus'] != 'active' ||
          me['emailVerified'] != true ||
          me['profileComplete'] != true ||
          consent is! Map ||
          consent['current'] != true) {
        throw const PatientRequestFailure('412');
      }
      setState(() {
        _step = 'home';
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'ログインまたは利用状態を確認できません。メール認証・同意・プロフィール登録済みの確認用アカウントを使用してください。';
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

  Future<void> _loadIntake() async {
    _intake = await api.request('GET', '/intakes/${_id(_intakeId)}');
    _revision(_intake!);
  }

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
    await _loadIntake();
    if (_intake!['status'] == 'review') {
      await _review();
      return;
    }
    if (_intake!['status'] == 'finalized') {
      await _loadHistory();
      return;
    }
    if (_intake!['status'] != 'questioning') {
      throw const PatientRequestFailure('412');
    }
    final questions = _intake!['questions'];
    final answers = _intake!['answers'];
    if (questions is! List || answers is! List) {
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
    if (pending.isNotEmpty) {
      _question = pending.first;
    } else {
      final next = await api.request(
        'POST',
        '/intakes/$_intakeId/next-question',
        body: {'expectedIntakeRevision': _revision(_intake!)},
      );
      if (next['question'] == null) {
        await _review();
        return;
      }
      _question = Map<String, dynamic>.from(next['question'] as Map);
    }
    _id(_question!['questionId']);
    if (_question!['questionText'] is! String ||
        _question!['options'] is! List) {
      throw const PatientRequestFailure('INVALID_RESPONSE');
    }
    await _loadIntake();
    if (mounted) {
      setState(() {
        _step = 'question';
      });
    }
  }

  Future<void> _answer(String? code, String state) async {
    final q = _question!;
    await _loadIntake();
    final answers = _intake!['answers'] as List;
    if (!answers.whereType<Map>().any(
      (a) =>
          a['questionId'] == q['questionId'] &&
          a['questionRevision'] == q['questionRevision'],
    )) {
      await api.request(
        'POST',
        '/intakes/$_intakeId/answers',
        body: {
          'questionId': _id(q['questionId']),
          'questionRevision': q['questionRevision'],
          'selectedCodes': code == null ? <String>[] : [code],
          'answerState': state,
          'expectedIntakeRevision': _revision(_intake!),
        },
      );
    }
    await _nextQuestion();
  }

  Future<void> _review() async {
    await _loadIntake();
    final result = await api.request(
      'POST',
      '/intakes/$_intakeId/summary',
      body: {'expectedIntakeRevision': _revision(_intake!)},
    );
    _summary = Map<String, dynamic>.from(result['summary'] as Map);
    await _loadIntake();
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
    final result = await api.request('GET', '/questionnaires');
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
      const Text('確認用アカウントでログインしてください。'),
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
      Text(
        '質問 ${(_question?['stepIndex'] as int? ?? 0) + 1}',
        style: const TextStyle(color: Colors.teal),
      ),
      const SizedBox(height: 12),
      Text(
        '${_question?['questionText'] ?? ''}',
        style: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 16),
      ...((_question?['options'] as List?) ?? []).whereType<Map>().map(
        (o) =>
            _button('${o['label']}', () => _answer('${o['code']}', 'answered')),
      ),
      _button('わからない', () => _answer(null, 'unknown')),
      _button('答えたくない', () => _answer(null, 'skipped')),
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
                if (!['login', 'home'].contains(_step))
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
