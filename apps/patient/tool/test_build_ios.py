"""Exercise build command construction without running Flutter or Apple tools."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_ios


class AnalyticsBuildTests(unittest.TestCase):
    def test_unsigned_and_signed_commands_exclude_ad_identifier_support(self):
        for signed in (False, True):
            with self.subTest(signed=signed), tempfile.TemporaryDirectory() as root:
                config = Path(root) / 'config.json'
                config.write_text(json.dumps({
                    'FIREBASE_PROJECT_ID': 'project-7efcc4c4-6c86-490c-ba5',
                    'FIREBASE_APP_ID': '1:842827776169:ios:synthetic',
                    'FIREBASE_API_KEY': 'synthetic-public-config',
                    'API_BASE_URL': 'https://api.example.invalid',
                }))
                export = Path(root) / 'export.plist'
                export.write_text('synthetic command-construction fixture')
                argv = ['build_ios.py', '--config', str(config), '--build-number', '3']
                argv += ['--team', 'SYNTHETIC0', '--export-options', str(export)] if signed else ['--unsigned']
                with patch('sys.argv', argv), patch('subprocess.run') as run:
                    build_ios.main()
                self.assertEqual(len(run.call_args_list), 3 if signed else 1)
                for call in run.call_args_list:
                    self.assertEqual(call.kwargs['env']['FIREBASE_ANALYTICS_WITHOUT_ADID'], 'true')
                    self.assertTrue(call.kwargs['check'])


if __name__ == '__main__':
    unittest.main()
