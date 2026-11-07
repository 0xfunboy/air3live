import unittest
from unittest.mock import MagicMock
import os

from server import is_authorized, extract_supplied_token, get_authorized_tokens


class SecurityTests(unittest.TestCase):
    def test_extract_supplied_token_bearer(self):
        req = MagicMock()
        req.headers = {'authorization': 'Bearer test-token-1234567890'}
        self.assertEqual(extract_supplied_token(req), 'test-token-1234567890')

    def test_extract_supplied_token_raw(self):
        req = MagicMock()
        req.headers = {'authorization': 'test-token-1234567890'}
        self.assertEqual(extract_supplied_token(req), 'test-token-1234567890')

    def test_extract_supplied_token_x_api_key(self):
        req = MagicMock()
        req.headers = {'x-api-key': 'key-token-1234567890'}
        self.assertEqual(extract_supplied_token(req), 'key-token-1234567890')

    def test_extract_supplied_token_empty(self):
        req = MagicMock()
        req.headers = {}
        self.assertEqual(extract_supplied_token(req), '')

    def test_unauthorized_when_empty_or_mismatched(self):
        self.assertFalse(is_authorized(''))
        self.assertFalse(is_authorized('invalid-token-123'))


if __name__ == '__main__':
    unittest.main()
