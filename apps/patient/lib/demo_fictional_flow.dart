import 'package:flutter/material.dart';

import 'body_location_screen.dart';
import 'home_screen.dart';
import 'patient_theme.dart';

void main() => runApp(const FictionalDemoApp());

class FictionalDemoApp extends StatelessWidget {
  const FictionalDemoApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '架空の問診デモ',
    theme: buildPatientTheme(),
    home: const _DemoFlow(),
  );
}

class _DemoFlow extends StatefulWidget {
  const _DemoFlow();

  @override
  State<_DemoFlow> createState() => _DemoFlowState();
}

class _DemoFlowState extends State<_DemoFlow> {
  static const Key _headingKey = Key('demo-step-heading');
  static const Key _resultLiveRegionKey = Key('demo-result-live-region');
  static const Key _flowScrollKey = Key('demo-flow-scroll');

  final ScrollController _scrollController = ScrollController();

  int step = 0;
  List<String> _locations = const [];
  bool consent = false;

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _goToStep(int next, {bool resetConsent = false}) {
    setState(() {
      step = next;
      if (resetConsent) {
        consent = false;
      }
    });
    if (_scrollController.hasClients) {
      _scrollController.jumpTo(0);
    }
  }

  void back() => _goToStep(step - 1);

  void next() => _goToStep(step + 1);

  void restart() => _goToStep(0, resetConsent: true);

  @override
  Widget build(BuildContext context) {
    final titles = ['ホーム', '架空の同意', '部位のサンプル', '症状のサンプル', '模擬送信の確認', '結果'];
    return PopScope(
      canPop: step == 0,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && step > 0) back();
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('架空の問診デモ')),
        body: SafeArea(
          child: SingleChildScrollView(
            key: _flowScrollKey,
            controller: _scrollController,
            padding: const EdgeInsets.all(16),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 600),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      '架空の患者・施設・同意を使う非医療デモです。診断・予約・実際の送信は行いません。実際の患者情報は入力しないでください。',
                    ),
                    const SizedBox(height: 24),
                    Semantics(
                      key: _headingKey,
                      header: true,
                      child: Text(
                        titles[step],
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                    ),
                    const SizedBox(height: 16),
                    ...switch (step) {
                      0 => [
                        SizedBox(
                          height: 600,
                          child: HomeScreen(onStartQuestionnaire: next),
                        ),
                      ],
                      1 => [
                        const Text('これは操作を示すための架空の同意であり、実際の同意ではありません。'),
                        const Text(
                          'このデモでは、同意の流れを確認するためにチェックが必要です。チェックするまで次へは進めません。',
                        ),
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('架空の同意を確認しました'),
                          value: consent,
                          onChanged: (value) =>
                              setState(() => consent = value ?? false),
                        ),
                      ],
                      2 => [
                        SizedBox(
                          height: 600,
                          child: BodyLocationScreen(onNext: (locations) {
                            _locations = List.unmodifiable(locations);
                            next();
                          }),
                        ),
                      ],
                      3 => [
                        const Text('架空の患者：サンプルさん'),
                        const Text('症状の例：昨日から頭が重い'),
                        Text('部位の例：${_locations.isEmpty ? '未選択' : _locations.join('、')}'),
                        const Text('症状・問診内容は固定サンプルです。入力や編集はできません。'),
                      ],
                      4 => [
                        const Text('架空の送信先：みほん施設'),
                        const Text('架空の患者：サンプルさん'),
                        const Text('症状の例：昨日から頭が重い'),
                        const Text('次の操作は画面上の模擬送信です。この操作で患者データが外部へ送信されることはありません。'),
                      ],
                      _ => [
                        Semantics(
                          key: _resultLiveRegionKey,
                          container: true,
                          liveRegion: true,
                          child: const Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text('模擬送信が完了しました。'),
                              Text(
                                '実際には送信されておらず、施設にも届いていません。予約や診断も行っていません。',
                              ),
                            ],
                          ),
                        ),
                      ],
                    },
                    const SizedBox(height: 24),
                    if (step < 5 && step != 0 && step != 2)
                      FilledButton(
                        onPressed: step == 1 && !consent ? null : next,
                        child: Text(switch (step) {
                          4 => '模擬送信する',
                          _ => '次へ',
                        }),
                      )
                    else
                      FilledButton(
                        onPressed: restart,
                        child: const Text('最初からやり直す'),
                      ),
                    if (step > 0)
                      TextButton(onPressed: back, child: const Text('戻る')),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
