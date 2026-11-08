import 'package:flutter/material.dart';

import 'patient_intake_api.dart';

/// Connected AI 問診 Q&A（P-013/P-014）。固定デモではなく、バックエンドの
/// next-question / answers / summary / finalize に実接続して対話を駆動する。
///
/// - 1 画面 1 問・選択肢タップで回答（docs/03 §3.5）。選択肢に加えて
///   「答えたくない」を常に出す。選択肢中の「分からない」(UNKNOWN) は
///   answerState=unknown として保存する。
/// - 次質問が無くなったら要約（review）へ遷移し、患者の確認後に確定する。
/// - 医学的判断・診断は行わない。表示は回答の整理のみ。
class IntakeQuestionFlow extends StatefulWidget {
  const IntakeQuestionFlow({
    super.key,
    required this.api,
    required this.submission,
    required this.startRevision,
  });

  final PatientIntakeApi api;
  final IntakeSubmission submission;

  /// `submit` が返した questioning 状態の intake revision。
  final int startRevision;

  @override
  State<IntakeQuestionFlow> createState() => _IntakeQuestionFlowState();
}

enum _Phase { questioning, review, done }

class _AnsweredItem {
  const _AnsweredItem(this.questionText, this.answerLabel);
  final String questionText;
  final String answerLabel;
}

class _IntakeQuestionFlowState extends State<IntakeQuestionFlow> {
  late int _revision;
  _Phase _phase = _Phase.questioning;
  IntakeQuestion? _question;
  IntakeSummary? _summary;
  final List<_AnsweredItem> _history = [];
  bool _busy = false;
  String? _message;

  @override
  void initState() {
    super.initState();
    _revision = widget.startRevision;
    _loadNext();
  }

  Future<void> _loadNext() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final next = await widget.api.nextQuestion(widget.submission, _revision);
      if (!mounted) return;
      _revision = next.intakeRevision;
      if (next.question == null) {
        await _enterReview();
        return;
      }
      setState(() {
        _question = next.question;
        _busy = false;
      });
    } catch (error) {
      _fail(error, '次の質問を取得できません。');
    }
  }

  Future<void> _answer(
    IntakeQuestion question, {
    required String answerState,
    required List<String> selectedCodes,
    required String answerLabel,
  }) async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final revision = await widget.api.saveAnswer(
        widget.submission,
        question: question,
        selectedCodes: selectedCodes,
        answerState: answerState,
        expectedIntakeRevision: _revision,
      );
      if (!mounted) return;
      _revision = revision;
      _history.add(_AnsweredItem(question.questionText, answerLabel));
      await _loadNext();
    } catch (error) {
      _fail(error, '回答を保存できません。');
    }
  }

  Future<void> _enterReview() async {
    try {
      final summary = await widget.api.summarize(widget.submission, _revision);
      if (!mounted) return;
      _revision = summary.intakeRevision;
      setState(() {
        _summary = summary;
        _phase = _Phase.review;
        _busy = false;
      });
    } catch (error) {
      _fail(error, '要約を作成できません。');
    }
  }

  Future<void> _finalize() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.api.finalize(widget.submission, _revision);
      if (!mounted) return;
      setState(() {
        _phase = _Phase.done;
        _busy = false;
      });
    } catch (error) {
      _fail(error, '問診票を確定できません。');
    }
  }

  void _fail(Object error, String fallback) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _message = error is IntakeApiException
          ? '$fallback（${error.code}）再試行してください。'
          : '$fallback 再試行してください。';
    });
  }

  Future<void> _retry() {
    switch (_phase) {
      case _Phase.questioning:
        return _loadNext();
      case _Phase.review:
        return _enterReview();
      case _Phase.done:
        return Future<void>.value();
    }
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final children = <Widget>[];
    switch (_phase) {
      case _Phase.questioning:
        children.addAll(_buildQuestioning(textTheme));
      case _Phase.review:
        children.addAll(_buildReview(textTheme));
      case _Phase.done:
        children.addAll(_buildDone(textTheme));
    }
    if (_busy) {
      children.add(const SizedBox(height: 16));
      children.add(const LinearProgressIndicator());
    }
    if (_message != null) {
      children.add(const SizedBox(height: 16));
      children.add(
        Semantics(liveRegion: true, child: Text(_message!)),
      );
      if (_phase != _Phase.done) {
        children.add(
          TextButton(
            onPressed: _busy ? null : _retry,
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            child: const Text('再試行'),
          ),
        );
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );
  }

  List<Widget> _buildQuestioning(TextTheme textTheme) {
    final question = _question;
    if (question == null) {
      // 初回ロード中・エラー時は質問カードを描かない（進捗/メッセージのみ）。
      return [
        const Text('質問を準備しています。'),
      ];
    }
    return [
      const Text('質問に答えると、医療機関に伝える内容を整理できます。診断は行いません。'),
      const SizedBox(height: 16),
      Semantics(
        header: true,
        child: Text('質問 ${_history.length + 1}', style: textTheme.titleMedium),
      ),
      const SizedBox(height: 16),
      Text(
        question.questionText,
        style: textTheme.titleLarge,
        semanticsLabel: question.questionText,
      ),
      const SizedBox(height: 16),
      for (final option in question.options)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: OutlinedButton(
            onPressed: _busy
                ? null
                : () => _answer(
                    question,
                    // 選択肢中の UNKNOWN は「分からない」= unknown 状態で保存する。
                    answerState: option.code == 'UNKNOWN' ? 'unknown' : 'answered',
                    selectedCodes:
                        option.code == 'UNKNOWN' ? const [] : [option.code],
                    answerLabel: option.label,
                  ),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(48, 48),
              textStyle: const TextStyle(fontSize: 20),
            ),
            child: Text(option.label),
          ),
        ),
      const Divider(),
      TextButton(
        onPressed: _busy
            ? null
            : () => _answer(
                question,
                answerState: 'skipped',
                selectedCodes: const [],
                answerLabel: '答えたくない',
              ),
        style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
        child: const Text('答えたくない'),
      ),
    ];
  }

  List<Widget> _buildReview(TextTheme textTheme) {
    final summary = _summary;
    return [
      Semantics(
        header: true,
        child: Text('ここまでの回答', style: textTheme.titleLarge),
      ),
      const SizedBox(height: 8),
      const Text('内容を確認してください。未回答の項目はそのまま未回答として送られます。'),
      const SizedBox(height: 16),
      if (summary?.chiefComplaint != null) ...[
        Text('主訴', style: textTheme.titleMedium),
        Text(summary!.chiefComplaint!),
        const SizedBox(height: 16),
      ],
      if (_history.isEmpty)
        const Text('回答した質問はありません。')
      else
        for (var i = 0; i < _history.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text('Q${i + 1}. ${_history[i].questionText}\n→ ${_history[i].answerLabel}'),
          ),
      if (summary != null && summary.unansweredTopics.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('未回答の項目: ${summary.unansweredTopics.length}件'),
      ],
      const SizedBox(height: 16),
      FilledButton(
        onPressed: _busy ? null : _finalize,
        style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
        child: const Text('この内容で問診票を確定'),
      ),
    ];
  }

  List<Widget> _buildDone(TextTheme textTheme) {
    return [
      Semantics(
        header: true,
        child: Text('問診票を確定しました', style: textTheme.titleLarge),
      ),
      const SizedBox(height: 16),
      const Text(
        '問診票を確定しました。',
        semanticsLabel: '問診票を確定しました。',
      ),
      const Text('医療機関への送信はまだ行っていません。送信は別の操作で確認します。'),
    ];
  }
}
