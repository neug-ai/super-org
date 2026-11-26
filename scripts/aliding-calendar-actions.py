"""Read and manage a project calendar event through the configured AliDing skill."""
import os
import sys

sys.path.insert(0, os.environ["SUPERAGENT_ALIDING_SKILL_SCRIPTS"])

from alibabacloud_aliding20230426 import models
from common import ExampleError, aware_datetime, base_parser, execute, meeting_details
import add_attendee
import delete_event



class PartialPatchEventRequest(models.PatchEventRequest):
    def to_map(self):
        values = super().to_map()
        # The generated SDK serializes omitted lists as empty arrays during conversion.
        for key in ("Attendees", "CardInstances", "Reminders", "categories", "uiConfigs"):
            if values.get(key) == []:
                del values[key]
        return values


def read_event(client, runtime, args):
    event = client.get_event_with_options(
        models.GetEventRequest(calendar_id=args.calendar_id, event_id=args.event_id),
        models.GetEventHeaders(account_context=models.GetEventHeadersAccountContext(account_id=args.account_id)),
        runtime,
    ).body
    if not event or event.id != args.event_id:
        raise ExampleError("TARGET_EVENT_NOT_MATCHED")
    return event


def snapshot(event):
    return {
        "event_id": event.id, "summary": event.summary, "event_status": event.status,
        "start": event.start.date_time if event.start else None,
        "end": event.end.date_time if event.end else None,
        "room_code": meeting_details(event.online_meeting_info).get("room_code"),
        "verified": True,
    }


def attendee_ids(event):
    return {attendee.id for attendee in (event.attendees or [])}


def update(client, runtime, args, record, event):
    request = PartialPatchEventRequest(
        calendar_id=args.calendar_id, event_id=args.event_id, summary=args.title, description=args.description,
    )
    if args.start is not None or args.end is not None:
        start = args.start or (aware_datetime(event.start.date_time) if event.start and event.start.date_time else None)
        end = args.end or (aware_datetime(event.end.date_time) if event.end and event.end.date_time else None)
        if start is None or end is None or start >= end:
            raise ExampleError("INVALID_EVENT_TIME_RANGE")
        if args.start is not None:
            request.start = models.PatchEventRequestStart(date_time=start.isoformat(), time_zone="Asia/Shanghai")
        if args.end is not None:
            request.end = models.PatchEventRequestEnd(date_time=end.isoformat(), time_zone="Asia/Shanghai")
    record({"phase": "PatchEvent"})
    response = client.patch_event_with_options(
        request,
        models.PatchEventHeaders(account_context=models.PatchEventHeadersAccountContext(account_id=args.account_id)),
        runtime,
    ).body
    if not response or response.id != args.event_id:
        raise ExampleError("PATCH_EVENT_NOT_CONFIRMED")
    record({"accepted": True, "phase": "GetEventAfterPatch"})
    checked = read_event(client, runtime, args)
    if (args.title is not None and checked.summary != args.title
            or args.description is not None and (checked.description or "") != args.description
            or args.start is not None and (not checked.start or not checked.start.date_time or aware_datetime(checked.start.date_time) != args.start)
            or args.end is not None and (not checked.end or not checked.end.date_time or aware_datetime(checked.end.date_time) != args.end)):
        raise ExampleError("PATCH_READBACK_MISMATCH")
    return snapshot(checked)


def invoke(client, runtime, args, record):
    if args.action == "cancel":
        return {"event_id": args.event_id, **delete_event.invoke(client, runtime, args, record)}
    record({"phase": "GetEventBeforeAction"})
    event = read_event(client, runtime, args)
    if args.action == "read":
        return snapshot(event)
    if event.status == "cancelled":
        raise ExampleError("EVENT_ALREADY_CANCELLED")
    if args.action == "update":
        return update(client, runtime, args, record, event)

    expected = set(args.attendee_id)
    args.attendee_id = sorted(expected - attendee_ids(event))
    if not args.attendee_id:
        return snapshot(event)
    record({"phase": "AddAttendee"})
    add_attendee.invoke(client, runtime, args, record)
    record({"accepted": True, "phase": "GetEventAfterAdd"})
    checked = read_event(client, runtime, args)
    if not expected.issubset(attendee_ids(checked)):
        raise ExampleError("ATTENDEES_NOT_RETURNED")
    return snapshot(checked)


def main():
    parser = base_parser("查询、修改或取消钉钉日程，以及添加参会者")
    parser.add_argument("--action", choices=("read", "update", "cancel", "invite"), required=True)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--calendar-id", default="primary")
    parser.add_argument("--title")
    parser.add_argument("--description")
    parser.add_argument("--start", type=aware_datetime)
    parser.add_argument("--end", type=aware_datetime)
    parser.add_argument("--attendee-id", action="append", default=[])
    parser.set_defaults(room_code=None, notify_push=False, notify_chat=False)
    args = parser.parse_args()
    if args.action == "update" and all(value is None for value in (args.title, args.description, args.start, args.end)):
        parser.error("请指定要修改的字段")
    if args.action == "invite" and not args.attendee_id:
        parser.error("请指定要添加的参会人")
    return execute(args.action, args, {"event_id": args.event_id}, invoke, writes=args.action != "read")


if __name__ == "__main__":
    raise SystemExit(main())
