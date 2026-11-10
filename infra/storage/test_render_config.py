import unittest

from render_config import build_config


class ConfigurationTests(unittest.TestCase):
    def test_upload_contract_and_scoped_deletion(self):
        config = build_config(["https://patient.test", "https://patient.test"], 31, 30)
        self.assertEqual(config["project"], "project-7efcc4c4-6c86-490c-ba5")
        self.assertEqual(config["cors"][0]["origin"], ["https://patient.test"])
        self.assertEqual(config["cors"][0]["method"], ["PUT"])
        self.assertIn("x-goog-if-generation-match", config["cors"][0]["responseHeader"])
        rule = config["lifecycle"]["rule"][0]
        self.assertEqual(rule["action"], {"type": "Delete"})
        self.assertEqual(rule["condition"], {"age": 31, "matchesPrefix": ["patient-uploads/"]})

    def test_reject_unsafe_origins(self):
        for origin in ["*", "http://patient.test", "https://*.patient.test",
                       "https://user:pass@patient.test", "https://patient.test/",
                       "https://patient.test/path", "https://patient.test?q=x",
                       "https://patient.test#x", "https://localhost",
                       "https://127.0.0.1", "https://127.0.0.2", "https://10.0.0.1",
                       "https://patient.test:443", "https://PATIENT.test", "https://[::1]", "https://patient.invalid",
                       "https://patient.test:0", "https://patient.test:65536",
                       "https://patient.test:", "https://bad!.test",
                       "https://patient.test\\evil.test", "https://patient.test\n"]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                build_config([origin], 31, 30)

    def test_retention_must_preserve_upload_ttl(self):
        for retention, ttl in [(30, 30), (29, 30), (0, 30), (31, 0), (31, -1), (31.5, 30), (True, 30)]:
            with self.subTest(retention=retention, ttl=ttl), self.assertRaises(ValueError):
                build_config(["https://patient.test"], retention, ttl)

    def test_missing_origins(self):
        with self.assertRaises(ValueError):
            build_config([], 31, 30)


if __name__ == "__main__":
    unittest.main()
