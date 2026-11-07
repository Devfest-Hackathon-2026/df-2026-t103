import 'package:flutter/material.dart';

/// PATCH /me/profile に接続しないプロフィール登録（P-006）のプレビュー。
///
/// 氏名・カナ・生年月日・電話・郵便番号・住所の必須項目と、任意の持病を分けて表示し、
/// 妥当性を検証する（docs/03 §3.2、FR-A07/A08）。必須同意の確定後のみ利用できる前提。
/// 入力は画面内に保持されるが、保存（PATCH /me/profile）は未接続。
class ProfileFormScreen extends StatefulWidget {
  const ProfileFormScreen({super.key});

  @override
  State<ProfileFormScreen> createState() => _ProfileFormScreenState();
}

class _ProfileFormScreenState extends State<ProfileFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _lastName = TextEditingController();
  final _firstName = TextEditingController();
  final _lastKana = TextEditingController();
  final _firstKana = TextEditingController();
  final _birthday = TextEditingController();
  final _phone = TextEditingController();
  final _postalCode = TextEditingController();
  final _address = TextEditingController();
  final _conditions = TextEditingController();

  static final _kanaPattern = RegExp(r'^[ァ-ヶー]+$');

  @override
  void dispose() {
    for (final c in [
      _lastName,
      _firstName,
      _lastKana,
      _firstKana,
      _birthday,
      _phone,
      _postalCode,
      _address,
      _conditions,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('プロフィール登録デモ')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('架空のデモです。実在する個人情報は入力しないでください。'),
                const Text('入力は画面内に保持されますが、保存（送信）はされません。'),
                const SizedBox(height: 8),
                const Text('この画面は、必須の同意が済んだあとに利用できます。'),
                const SizedBox(height: 16),
                Text('必須の項目', style: textTheme.titleMedium),
                const SizedBox(height: 8),
                _field(_lastName, '姓（必須）', _required('姓と名を入力してください')),
                _field(_firstName, '名（必須）', _required('姓と名を入力してください')),
                _field(_lastKana, '姓カナ（必須）', _kana),
                _field(_firstKana, '名カナ（必須）', _kana),
                _field(
                  _birthday,
                  '生年月日（必須・例 1950-01-01）',
                  _required('正しい日付を選んでください'),
                ),
                _field(
                  _phone,
                  '電話番号（必須）',
                  _required('電話番号をご確認ください'),
                ),
                _field(_postalCode, '郵便番号（必須・7桁）', _postal),
                _field(_address, '住所（必須）', _required('住所を入力してください')),
                const SizedBox(height: 16),
                Text('任意の項目', style: textTheme.titleMedium),
                const SizedBox(height: 8),
                _field(
                  _conditions,
                  '持病（任意・なくても構いません）',
                  null,
                  maxLines: 3,
                ),
                const SizedBox(height: 16),
                const Text('保存（PATCH /me/profile）はこのデモでは未接続です。'),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _submit,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      textStyle: const TextStyle(fontSize: 20),
                    ),
                    child: const Text('この内容で登録する'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _field(
    TextEditingController controller,
    String label,
    String? Function(String?)? validator, {
    int maxLines = 1,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: controller,
        validator: validator,
        maxLines: maxLines,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }

  String? Function(String?) _required(String message) {
    return (value) => (value == null || value.trim().isEmpty) ? message : null;
  }

  String? _kana(String? value) {
    final text = value?.trim() ?? '';
    if (text.isEmpty || !_kanaPattern.hasMatch(text)) {
      return 'カタカナで入力してください';
    }
    return null;
  }

  String? _postal(String? value) {
    final digits = (value ?? '').replaceAll('-', '').trim();
    if (digits.length != 7 || int.tryParse(digits) == null) {
      return '7桁の郵便番号を入力してください';
    }
    return null;
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('（デモ）入力内容は保存・送信されません。')),
    );
  }
}
