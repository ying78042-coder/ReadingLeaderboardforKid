from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import socket
import time
import uuid
from urllib.parse import unquote
from datetime import date, datetime, timezone


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
RECORDS_FILE = DATA_DIR / "readers.json"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5173"))
SUBJECTS = ("English", "Chinese", "Math")


def empty_records():
    return {"currentReaderId": None, "readers": []}


def load_records():
    if not RECORDS_FILE.exists():
        return empty_records()

    try:
        data = json.loads(RECORDS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return empty_records()

    records = {
        "currentReaderId": data.get("currentReaderId"),
        "readers": data.get("readers") if isinstance(data.get("readers"), list) else [],
    }
    before = json.dumps(records, sort_keys=True)
    repair_records(records)
    after = json.dumps(records, sort_keys=True)
    if before != after:
        save_records(records)

    return records


def save_records(data):
    DATA_DIR.mkdir(exist_ok=True)
    RECORDS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def normalize_name(name):
    return " ".join(str(name).strip().split()).casefold()


def clean_number(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def clean_date_key(value):
    text = str(value or "").strip()
    try:
        date.fromisoformat(text)
        return text
    except ValueError:
        return date.today().isoformat()


def clean_subject(value):
    subject = str(value or "").strip()
    return subject if subject in SUBJECTS else "English"


def clean_subject_goals(value):
    incoming = value if isinstance(value, dict) else {}
    subject_goals = {}
    for subject in SUBJECTS:
        goals = incoming.get(subject) if isinstance(incoming.get(subject), dict) else {}
        legacy_daily_goal = clean_number(goals.get("daily"), 20)
        subject_goals[subject] = {
            "workday": clean_number(goals.get("workday"), legacy_daily_goal),
            "weekend": clean_number(goals.get("weekend"), legacy_daily_goal),
        }
        subject_goals[subject]["weekly"] = (
            subject_goals[subject]["workday"] * 5 + subject_goals[subject]["weekend"] * 2
        )
    return subject_goals


def summarize_subject_goals(subject_goals):
    return {
        "daily": sum(goal["workday"] for goal in subject_goals.values()),
        "dailyWorkday": sum(goal["workday"] for goal in subject_goals.values()),
        "dailyWeekend": sum(goal["weekend"] for goal in subject_goals.values()),
        "weekly": sum(goal["weekly"] for goal in subject_goals.values()),
    }


def update_daily_record(reader, record_date, today_minutes, week_minutes, month_books):
    daily_records = reader.setdefault("dailyRecords", {})
    daily_records[record_date] = {
        "todayMinutes": clean_number(today_minutes, 0),
        "weekMinutes": clean_number(week_minutes, 0),
        "monthBooks": clean_number(month_books, 0),
    }


def repair_records(records):
    for reader in records.get("readers", []):
        goals = reader.get("goals") if isinstance(reader.get("goals"), dict) else {}
        subject_goals = clean_subject_goals(goals.get("subjects"))
        reader["goals"] = {
            **summarize_subject_goals(subject_goals),
            "subjects": subject_goals,
        }

        for record_date_key in list(reader.get("dailyRecords", {})):
            refresh_week_records(reader, record_date_key)
        sync_top_level_if_current_date(reader, date.today().isoformat())


def refresh_week_records(reader, changed_date_key):
    try:
        changed_date = date.fromisoformat(changed_date_key)
    except ValueError:
        return

    changed_year, changed_week, _ = changed_date.isocalendar()
    running_week_minutes = 0
    daily_records = reader.setdefault("dailyRecords", {})

    for record_date_key in sorted(daily_records):
        try:
            record_date = date.fromisoformat(record_date_key)
        except ValueError:
            continue

        record_year, record_week, _ = record_date.isocalendar()
        if record_year != changed_year or record_week != changed_week:
            continue

        record = daily_records[record_date_key]
        running_week_minutes += clean_number(
            record.get("todayMinutes", record.get("minutes")),
            0,
        )
        record["weekMinutes"] = running_week_minutes


def sync_top_level_if_current_date(reader, record_date_key):
    if record_date_key != date.today().isoformat():
        return

    daily_record = reader.get("dailyRecords", {}).get(record_date_key, {})
    reader["todayMinutes"] = clean_number(daily_record.get("todayMinutes"), 0)
    reader["weekMinutes"] = clean_number(daily_record.get("weekMinutes"), 0)
    reader["monthBooks"] = clean_number(daily_record.get("monthBooks"), 0)


def get_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def is_loopback_address(address):
    return address in {"127.0.0.1", "::1"} or address.startswith("127.")


class ReadingLeaderboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status, data):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/api/readers":
            self.send_json(200, load_records())
            return

        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/readers/") and self.path.endswith("/reading-session"):
            self.add_reading_session()
            return

        if self.path != "/api/readers":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            reader = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return

        name = " ".join(str(reader.get("name", "")).strip().split())
        if not name:
            self.send_json(400, {"error": "Name is required"})
            return

        records = load_records()
        if any(normalize_name(existing.get("name")) == normalize_name(name) for existing in records["readers"]):
            self.send_json(409, {"error": "Name already exists"})
            return

        reader_id = str(reader.get("id", "")).strip() or f"reader-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        reader["name"] = name
        reader["id"] = reader_id
        reader.pop("favoriteBook", None)
        incoming_goals = reader.get("goals", {}) if isinstance(reader.get("goals"), dict) else {}
        subject_goals = clean_subject_goals(incoming_goals.get("subjects"))
        reader["goals"] = {
            **summarize_subject_goals(subject_goals),
            "subjects": subject_goals,
        }
        reader["todayMinutes"] = clean_number(reader.get("todayMinutes"), 0)
        reader["weekMinutes"] = clean_number(reader.get("weekMinutes"), 0)
        reader["monthBooks"] = clean_number(reader.get("monthBooks"), 0)
        record_date = clean_date_key(reader.get("recordDate"))
        reader.pop("recordDate", None)
        update_daily_record(
            reader,
            record_date,
            reader["todayMinutes"],
            reader["weekMinutes"],
            reader["monthBooks"],
        )
        refresh_week_records(reader, record_date)
        sync_top_level_if_current_date(reader, record_date)

        records["readers"].append(reader)
        records["currentReaderId"] = reader_id
        save_records(records)
        self.send_json(200, records)

    def add_reading_session(self):
        name_from_path = unquote(self.path.removeprefix("/api/readers/").removesuffix("/reading-session"))
        normalized_name = normalize_name(name_from_path)
        if not normalized_name:
            self.send_json(400, {"error": "Name is required"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            session = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return

        minutes = max(0, clean_number(session.get("minutes"), 0))
        if minutes <= 0:
            self.send_json(400, {"error": "Reading time must be greater than zero"})
            return

        record_date = clean_date_key(session.get("recordDate"))
        subject = clean_subject(session.get("subject"))
        records = load_records()
        for reader in records["readers"]:
            if normalize_name(reader.get("name")) == normalized_name:
                daily_record = reader.setdefault("dailyRecords", {}).setdefault(
                    record_date,
                    {"todayMinutes": 0, "weekMinutes": 0, "monthBooks": clean_number(reader.get("monthBooks"), 0)},
                )
                daily_record["todayMinutes"] = clean_number(daily_record.get("todayMinutes"), 0) + minutes
                daily_record["monthBooks"] = clean_number(daily_record.get("monthBooks"), clean_number(reader.get("monthBooks"), 0))
                refresh_week_records(reader, record_date)
                sync_top_level_if_current_date(reader, record_date)
                reader.setdefault("readingSessions", []).append(
                    {
                        "minutes": minutes,
                        "subject": subject,
                        "recordDate": record_date,
                        "recordedAt": datetime.now(timezone.utc).isoformat(),
                    }
                )
                records["currentReaderId"] = reader.get("id")
                save_records(records)
                self.send_json(200, records)
                return

        self.send_json(404, {"error": "Reader not found"})

    def do_PATCH(self):
        if self.path.startswith("/api/readers/") and self.path.endswith("/goals"):
            self.update_goals()
            return

        if not self.path.startswith("/api/readers/") or not self.path.endswith("/today"):
            self.send_error(404)
            return

        name_from_path = unquote(self.path.removeprefix("/api/readers/").removesuffix("/today"))
        normalized_name = normalize_name(name_from_path)
        if not normalized_name:
            self.send_json(400, {"error": "Name is required"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            update = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return

        record_date = clean_date_key(update.get("recordDate"))
        records = load_records()
        for reader in records["readers"]:
            if normalize_name(reader.get("name")) == normalized_name:
                today_minutes = clean_number(update.get("todayMinutes"), 0)
                week_minutes = clean_number(update.get("weekMinutes"), 0)
                month_books = clean_number(update.get("monthBooks"), 0)
                update_daily_record(
                    reader,
                    record_date,
                    today_minutes,
                    week_minutes,
                    month_books,
                )
                refresh_week_records(reader, record_date)
                sync_top_level_if_current_date(reader, record_date)
                records["currentReaderId"] = reader.get("id")
                save_records(records)
                self.send_json(200, records)
                return

        self.send_json(404, {"error": "Reader not found"})

    def update_goals(self):
        name_from_path = unquote(self.path.removeprefix("/api/readers/").removesuffix("/goals"))
        normalized_name = normalize_name(name_from_path)
        if not normalized_name:
            self.send_json(400, {"error": "Name is required"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            update = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return

        incoming_goals = update.get("goals", {}) if isinstance(update.get("goals"), dict) else {}
        records = load_records()
        for reader in records["readers"]:
            if normalize_name(reader.get("name")) == normalized_name:
                existing_goals = reader.get("goals") if isinstance(reader.get("goals"), dict) else {}
                subject_goals = clean_subject_goals(
                    incoming_goals.get("subjects", existing_goals.get("subjects"))
                )
                reader["goals"] = {
                    **summarize_subject_goals(subject_goals),
                    "subjects": subject_goals,
                }
                records["currentReaderId"] = reader.get("id")
                save_records(records)
                self.send_json(200, records)
                return

        self.send_json(404, {"error": "Reader not found"})

    def do_DELETE(self):
        if self.path == "/api/readers":
            if not is_loopback_address(self.client_address[0]):
                self.send_json(403, {"error": "Reset is only allowed from the server"})
                return

            records = empty_records()
            save_records(records)
            self.send_json(200, records)
            return

        if not self.path.startswith("/api/readers/"):
            self.send_error(404)
            return

        reader_id = unquote(self.path.removeprefix("/api/readers/")).strip()
        if not reader_id:
            self.send_json(400, {"error": "Reader id is required"})
            return

        records = load_records()
        records["readers"] = [
            reader for reader in records["readers"] if str(reader.get("id")) != reader_id
        ]
        if records["currentReaderId"] == reader_id:
            records["currentReaderId"] = records["readers"][-1]["id"] if records["readers"] else None

        save_records(records)
        self.send_json(200, records)


if __name__ == "__main__":
    DATA_DIR.mkdir(exist_ok=True)
    if not RECORDS_FILE.exists():
        save_records(empty_records())

    server = ThreadingHTTPServer((HOST, PORT), ReadingLeaderboardHandler)
    print(f"Reading leaderboard local: http://127.0.0.1:{PORT}/")
    lan_ip = get_lan_ip()
    if lan_ip:
        print(f"Reading leaderboard network: http://{lan_ip}:{PORT}/")
    print(f"Records file: {RECORDS_FILE}")
    server.serve_forever()
