"""Garmin Connect credential resolution shared by the CLI entrypoints."""

import getpass
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def resolve_garmin_credentials(config: dict[str, Any]) -> tuple[str, str]:
    """Resolve the Garmin (email, password) pair.

    Password order: Supabase Vault, then system keychain, then config file, then
    interactive prompt. When the Vault provides credentials its stored email is
    returned too, so a Vault password is never paired with a config-file email.
    """
    user_id = os.environ.get("SUPABASE_USER_ID")

    # 1. Supabase Vault (SaaS multi-user — preferred when SUPABASE_USER_ID is set)
    if user_id:
        try:
            from services.supabase.credentials import get_garmin_credentials

            creds = get_garmin_credentials(user_id)
            if creds:
                email, password = creds
                return email, password
        except Exception:
            logger.warning("Supabase Vault credential lookup failed; falling back", exc_info=True)

    email = config.get("athlete", {}).get("email", "")

    # 2. macOS Keychain / system credential store (personal use)
    try:
        import keyring

        stored = keyring.get_password("athlete-management-system", email)
        if stored is None:
            # Pre-rename entries live under the old service name. Read them so an
            # existing keychain item keeps working without re-entering the password.
            stored = keyring.get_password("garmin-ai-coach", email)
        if stored:
            return email, stored
    except Exception:
        pass

    # 3. Config file (acceptable for personal setups, keep out of git)
    cfg_password = config.get("credentials", {}).get("password", "")
    if cfg_password:
        return email, cfg_password

    # 4. Interactive prompt (not available in headless contexts)
    return email, getpass.getpass("Enter Garmin Connect password: ")
