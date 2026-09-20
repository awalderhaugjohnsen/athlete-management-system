from unittest.mock import patch

import pytest

from services.garmin.credentials import resolve_garmin_credentials


def test_resolve_garmin_credentials_raises_when_headless_and_nothing_found(monkeypatch):
    monkeypatch.delenv("SUPABASE_USER_ID", raising=False)

    with (
        patch("keyring.get_password", return_value=None),
        patch("sys.stdin.isatty", return_value=False),
    ):
        with pytest.raises(RuntimeError, match="non-interactive session"):
            resolve_garmin_credentials({"athlete": {"email": "test@example.com"}})


def test_resolve_garmin_credentials_prompts_when_interactive(monkeypatch):
    monkeypatch.delenv("SUPABASE_USER_ID", raising=False)

    with (
        patch("keyring.get_password", return_value=None),
        patch("sys.stdin.isatty", return_value=True),
        patch("getpass.getpass", return_value="typed-password") as mock_getpass,
    ):
        email, password = resolve_garmin_credentials({"athlete": {"email": "test@example.com"}})

    assert email == "test@example.com"
    assert password == "typed-password"
    mock_getpass.assert_called_once()
