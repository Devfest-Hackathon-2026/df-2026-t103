import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('tester.runAsync completes a real-zone timer future', (
    tester,
  ) async {
    final runAsyncResult = await tester.runAsync(
      () => Future<String>.delayed(
        const Duration(milliseconds: 50),
        () => 'completed',
      ),
    );
    expect(runAsyncResult, 'completed');
  });
}
