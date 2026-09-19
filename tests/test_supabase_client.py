from types import SimpleNamespace

from services.supabase.client import row, rows


def test_row_returns_none_when_maybe_single_finds_no_rows():
    # postgrest's maybe_single().execute() returns bare None (not a response
    # object with .data = None) when the query matches zero rows.
    assert row(None) is None


def test_row_returns_data_when_a_row_is_found():
    response = SimpleNamespace(data={"source": "planner"})
    assert row(response) == {"source": "planner"}


def test_rows_returns_empty_list_when_data_is_none():
    response = SimpleNamespace(data=None)
    assert rows(response) == []


def test_rows_returns_data_list():
    response = SimpleNamespace(data=[{"id": 1}, {"id": 2}])
    assert rows(response) == [{"id": 1}, {"id": 2}]
