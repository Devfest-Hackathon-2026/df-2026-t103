import 'package:flutter/material.dart';

/// OCR が抽出した薬剤候補 1 件。すべてメモリ上のみで保持し、保存も送信もしない。
@immutable
class OcrMedicationCandidate {
  const OcrMedicationCandidate({
    required this.name,
    required this.dose,
    required this.usage,
    required this.quantity,
    required this.prescribedOn,
    this.confirmed = false,
  });

  /// 薬剤名。
  final String name;

  /// 容量（例: 5mg）。
  final String dose;

  /// 用法（例: 1日1回 朝食後）。
  final String usage;

  /// 数量（例: 28錠）。
  final String quantity;

  /// 処方日。架空の表示用文字列（例: 2026-10-20）。
  final String prescribedOn;

  /// 本人が内容を確認済みか。
  final bool confirmed;

  OcrMedicationCandidate copyWith({
    String? name,
    String? dose,
    String? usage,
    String? quantity,
    String? prescribedOn,
    bool? confirmed,
  }) {
    return OcrMedicationCandidate(
      name: name ?? this.name,
      dose: dose ?? this.dose,
      usage: usage ?? this.usage,
      quantity: quantity ?? this.quantity,
      prescribedOn: prescribedOn ?? this.prescribedOn,
      confirmed: confirmed ?? this.confirmed,
    );
  }
}

/// 保存や送信、API 接続を行わない薬剤候補の人手確認（P-023）プレビュー。
///
/// OCR が読み取った候補を本人が 1 件ずつ確認・編集する。全件を確認するまで
/// 「確定」はできず、自動では確定しない（E2E-003 / FR-M03・M04）。写真参照
/// （抽出根拠 FR-M08）は導線のみ示す。確定（medications API）は未接続。
class OcrCandidateScreen extends StatefulWidget {
  const OcrCandidateScreen({super.key});

  @override
  State<OcrCandidateScreen> createState() => _OcrCandidateScreenState();
}

class _OcrCandidateScreenState extends State<OcrCandidateScreen> {
  // 架空のサンプル。実際の処方情報は含めない。
  final List<OcrMedicationCandidate> _candidates = [
    const OcrMedicationCandidate(
      name: 'サンプル降圧薬',
      dose: '5mg',
      usage: '1日1回 朝食後',
      quantity: '28錠',
      prescribedOn: '2026-10-20',
    ),
    const OcrMedicationCandidate(
      name: 'サンプル胃薬',
      dose: '10mg',
      usage: '1日2回 朝夕食後',
      quantity: '56錠',
      prescribedOn: '2026-10-20',
    ),
  ];

  bool get _allConfirmed =>
      _candidates.isNotEmpty && _candidates.every((c) => c.confirmed);

  int get _confirmedCount => _candidates.where((c) => c.confirmed).length;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('薬の候補確認デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実際の処方情報は入力しないでください。'),
              const Text('内容はメモリ上のみで、保存も送信もされません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text(
                  '読み取った候補（確認 $_confirmedCount / ${_candidates.length}件）',
                  style: textTheme.titleLarge,
                ),
              ),
              const SizedBox(height: 8),
              const Text('内容が正しいか1件ずつ確認してください。自動では確定しません。'),
              const SizedBox(height: 16),
              for (final candidate in _candidates)
                _CandidateCard(
                  candidate: candidate,
                  onEdit: () => _edit(candidate),
                  onToggleConfirmed: (value) =>
                      _setConfirmed(candidate, value),
                  onViewPhoto: () => _viewPhoto(candidate),
                ),
              const SizedBox(height: 16),
              Text(
                _allConfirmed
                    ? 'すべて確認しました。確定できます。'
                    : '未確認の候補があります。すべて確認すると確定できます。',
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _allConfirmed ? _confirm : null,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    textStyle: const TextStyle(fontSize: 20),
                  ),
                  child: const Text('確定する'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _setConfirmed(OcrMedicationCandidate candidate, bool value) {
    final index = _candidates.indexOf(candidate);
    if (index < 0) return;
    setState(
      () => _candidates[index] = candidate.copyWith(confirmed: value),
    );
  }

  Future<void> _edit(OcrMedicationCandidate candidate) async {
    final index = _candidates.indexOf(candidate);
    if (index < 0) return;
    final updated = await showDialog<OcrMedicationCandidate>(
      context: context,
      builder: (context) => _EditCandidateDialog(candidate: candidate),
    );
    if (updated == null || !mounted) return;
    // 編集したら未確認に戻し、再確認を促す。
    setState(
      () => _candidates[index] = updated.copyWith(confirmed: false),
    );
  }

  void _viewPhoto(OcrMedicationCandidate candidate) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('抽出根拠（表示例）'),
        content: Text(
          '「${candidate.name}」の読み取り元となった写真の該当箇所を表示します。'
          'このデモでは写真参照は未接続です。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('閉じる'),
          ),
        ],
      ),
    );
  }

  void _confirm() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('（デモ）確定は保存・送信されません。')),
    );
  }
}

class _CandidateCard extends StatelessWidget {
  const _CandidateCard({
    required this.candidate,
    required this.onEdit,
    required this.onToggleConfirmed,
    required this.onViewPhoto,
  });

  final OcrMedicationCandidate candidate;
  final VoidCallback onEdit;
  final ValueChanged<bool> onToggleConfirmed;
  final VoidCallback onViewPhoto;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(candidate.name, style: textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('容量: ${candidate.dose}'),
            Text('用法: ${candidate.usage}'),
            Text('数量: ${candidate.quantity}'),
            Text('処方日: ${candidate.prescribedOn}'),
            const SizedBox(height: 8),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 8,
              children: [
                Semantics(
                  button: true,
                  label: '${candidate.name}の抽出根拠の写真を見る',
                  child: TextButton.icon(
                    onPressed: onViewPhoto,
                    style: TextButton.styleFrom(
                      minimumSize: const Size(48, 48),
                    ),
                    icon: const Icon(Icons.photo_outlined),
                    label: const Text('写真を見る'),
                  ),
                ),
                Semantics(
                  button: true,
                  label: '${candidate.name}を編集',
                  child: TextButton.icon(
                    onPressed: onEdit,
                    style: TextButton.styleFrom(
                      minimumSize: const Size(48, 48),
                    ),
                    icon: const Icon(Icons.edit),
                    label: const Text('編集'),
                  ),
                ),
              ],
            ),
            CheckboxListTile(
              title: Text('${candidate.name}の内容を確認しました'),
              value: candidate.confirmed,
              onChanged: (value) => onToggleConfirmed(value ?? false),
            ),
          ],
        ),
      ),
    );
  }
}

class _EditCandidateDialog extends StatefulWidget {
  const _EditCandidateDialog({required this.candidate});

  final OcrMedicationCandidate candidate;

  @override
  State<_EditCandidateDialog> createState() => _EditCandidateDialogState();
}

class _EditCandidateDialogState extends State<_EditCandidateDialog> {
  late final _name = TextEditingController(text: widget.candidate.name);
  late final _dose = TextEditingController(text: widget.candidate.dose);
  late final _usage = TextEditingController(text: widget.candidate.usage);
  late final _quantity =
      TextEditingController(text: widget.candidate.quantity);
  late final _prescribedOn =
      TextEditingController(text: widget.candidate.prescribedOn);

  @override
  void dispose() {
    _name.dispose();
    _dose.dispose();
    _usage.dispose();
    _quantity.dispose();
    _prescribedOn.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('候補の編集'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _field(_name, 'お薬の名前'),
            _field(_dose, '容量'),
            _field(_usage, '用法'),
            _field(_quantity, '数量'),
            _field(_prescribedOn, '処方日'),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('やめる'),
        ),
        TextButton(
          onPressed: () {
            final name = _name.text.trim();
            if (name.isEmpty) return;
            Navigator.of(context).pop(
              widget.candidate.copyWith(
                name: name,
                dose: _dose.text.trim(),
                usage: _usage.text.trim(),
                quantity: _quantity.text.trim(),
                prescribedOn: _prescribedOn.text.trim(),
              ),
            );
          },
          child: const Text('保存'),
        ),
      ],
    );
  }

  Widget _field(TextEditingController controller, String label) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: TextField(
        controller: controller,
        maxLength: 100,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }
}
