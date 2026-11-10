import contextlib
import io
import json
import unittest
from unittest.mock import patch

import deploy_database_rules as deploy


class DatabaseRulesDeploymentTests(unittest.TestCase):
    project = "project-7efcc4c4-6c86-490c-ba5"

    def run_command(self, *extra, responses):
        with patch("sys.argv", ["deploy", "--project", self.project, *extra]), \
             patch.object(deploy.subprocess, "check_output", return_value="synthetic-token") as auth, \
             patch.object(deploy.urllib.request, "urlopen", side_effect=responses) as http, \
             contextlib.redirect_stdout(io.StringIO()):
            deploy.main()
        return auth, http

    def test_dry_run_validates_only_rules_on_exact_singapore_host(self):
        auth, http = self.run_command("--dry-run", responses=[io.BytesIO(b"{}")])
        request = http.call_args.args[0]
        self.assertEqual(request.full_url, f"https://{self.project}-status.asia-southeast1.firebasedatabase.app/.settings/rules.json?dryRun=true")
        self.assertNotIn("synthetic-token", request.full_url)
        self.assertEqual(request.method, "PUT")
        self.assertFalse(json.loads(request.data)["rules"][".write"])
        self.assertEqual(http.call_count, 1)
        self.assertIn(self.project, auth.call_args.args[0])

    def test_deployment_reads_back_the_published_rules(self):
        rules = (deploy.Path(__file__).resolve().parents[2] / "firebase/database.rules.json").read_bytes()
        _, http = self.run_command(responses=[io.BytesIO(b"{}"), io.BytesIO(rules)])
        self.assertEqual([call.args[0].get_method() for call in http.call_args_list], ["PUT", "GET"])
        self.assertTrue(all("?" not in call.args[0].full_url for call in http.call_args_list))

    def test_readback_mismatch_is_a_failure(self):
        with self.assertRaisesRegex(RuntimeError, "differ"):
            self.run_command(responses=[io.BytesIO(b"{}"), io.BytesIO(b'{"rules":{}}')])

    def test_other_project_rejected_before_credentials_or_network(self):
        with patch("sys.argv", ["deploy", "--project", "other-project"]), \
             patch.object(deploy.subprocess, "check_output") as auth, \
             patch.object(deploy.urllib.request, "urlopen") as http, \
             contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            deploy.main()
        auth.assert_not_called()
        http.assert_not_called()
