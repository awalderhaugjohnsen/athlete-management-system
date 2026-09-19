"""Supabase client — server-side only, uses service_role key (bypasses RLS)."""
from __future__ import annotations

import os
from functools import cache
from typing import Any, cast

from supabase import Client, create_client


@cache
def get_supabase() -> Client:
    """Return a singleton Supabase client using the service_role (secret) key."""
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def rows(response: Any) -> list[dict[str, Any]]:
    """Return an executed query's .data as list[dict[str, Any]].

    postgrest can't know a table's schema statically, so it types every row as the
    fully generic recursive JSON union rather than dict[str, Any] — every row this app
    reads is, in practice, a flat JSON object matching a known table shape. This is the
    single cast point for that instead of scattering `# type: ignore`/asserts across
    every call site.
    """
    return cast("list[dict[str, Any]]", response.data or [])


def row(response: Any) -> dict[str, Any] | None:
    """Same as rows(), for a .maybe_single()/.single() query returning one row or None.

    postgrest's maybe_single().execute() returns bare None (not a response wrapping
    None) when the query matches zero rows, rather than an object with a .data
    attribute — so that has to be checked before touching .data.
    """
    if response is None:
        return None
    return cast("dict[str, Any] | None", response.data)
