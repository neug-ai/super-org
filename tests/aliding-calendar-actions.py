"""Offline tests using the installed AliDing skill and SDK models, with a mocked client."""
from argparse import Namespace
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace as Value
from unittest import TestCase, main
from unittest.mock import Mock
import runpy

from alibabacloud_aliding20230426.client import Client
from alibabacloud_tea_openapi.models import Config
from alibabacloud_tea_util.models import RuntimeOptions

bridge = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "aliding-calendar-actions.py"))
invoke = bridge["invoke"]


def event(title="Original", status="confirmed", start="2030-01-01T15:00:00+08:00", attendees=()):
    return Value(id="event-1", summary=title, status=status, start=Value(date_time=start),
                 end=Value(date_time="2030-01-01T17:00:00+08:00"), online_meeting_info=None,
                 description="Description", attendees=[Value(id=id) for id in attendees])


def args(action, **fields):
    return Namespace(**({"action": action, "account_id": "owner", "calendar_id": "primary", "event_id": "event-1",
                         "title": None, "description": None, "start": None, "end": None, "room_code": None,
                         "attendee_id": [], "notify_push": False, "notify_chat": False} | fields))


class CalendarActions(TestCase):
    def test_patch_sends_only_changes_and_reads_back(self):
        client = Client(Config(endpoint="aliding.aliyuncs.com"))
        start = "2030-01-01T16:00:00+08:00"
        client.get_event_with_options = Mock(side_effect=[Value(body=event()), Value(body=event("Renamed", start=start))])
        client.call_api = Mock(return_value={"body": {"id": "event-1"}})
        result = invoke(client, RuntimeOptions(), args("update", title="Renamed", start=datetime.fromisoformat(start)), lambda _: None)
        operation, request, _ = client.call_api.call_args.args
        self.assertEqual(operation.action, "PatchEvent")
        self.assertEqual(set(request.body), {"CalendarId", "EventId", "Summary", "Start"})
        self.assertEqual(request.body["Summary"], "Renamed")
        self.assertEqual(request.query, {})
        self.assertEqual(result["summary"], "Renamed")
        self.assertEqual(client.get_event_with_options.call_count, 2)

    def test_patch_acknowledgement_survives_a_readback_mismatch(self):
        client = Mock()
        client.get_event_with_options.return_value = Value(body=event())
        client.patch_event_with_options.return_value = Value(body=Value(id="event-1"))
        record = Mock()
        with self.assertRaisesRegex(bridge["ExampleError"], "PATCH_READBACK_MISMATCH"):
            invoke(client, object(), args("update", title="Renamed"), record)
        record.assert_any_call({"accepted": True, "phase": "GetEventAfterPatch"})
        client.patch_event_with_options.assert_called_once()

    def test_only_invites_missing_attendees_and_verifies_all_requested(self):
        client = Mock()
        client.get_event_with_options.side_effect = [
            Value(body=event(attendees=["existing"])), Value(body=event(attendees=["existing", "new"])),
        ]
        client.add_attendee_with_options.return_value = Value(body=Value(success=True, http_status_code=200, request_id="request"))
        result = invoke(client, object(), args("invite", attendee_id=["existing", "new"]), lambda _: None)
        request = client.add_attendee_with_options.call_args.args[0]
        self.assertEqual([attendee.id for attendee in request.attendees_to_add], ["new"])
        self.assertTrue(result["verified"])

    def test_cancel_checks_persisted_status(self):
        client = Mock()
        client.get_event_with_options.side_effect = [Value(body=event()), Value(body=event(status="cancelled"))]
        client.delete_event_with_options.return_value = Value(body=Value(success=True), status_code=200)
        result = invoke(client, object(), args("cancel"), lambda _: None)
        self.assertEqual(result["event_status"], "cancelled")
        self.assertTrue(result["verified"])
        client.delete_event_with_options.assert_called_once()


if __name__ == "__main__":
    main()
