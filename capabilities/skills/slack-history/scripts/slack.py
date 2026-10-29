#!/usr/bin/env python3
"""Read-only Slack history helper for the agent inside Wirebot.

Only Slack read methods are called. The token comes from the file named by
WIREBOT_SLACK_TOKEN_FILE and is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://slack.com/api/"
READ_METHODS = {
    "conversations.replies",
    "conversations.history",
    "conversations.info",
    "users.conversations",
    "users.info",
    "conversations.list",
}


class SlackError(Exception):
    pass


def token() -> str:
    path = os.environ.get("WIREBOT_SLACK_TOKEN_FILE", "").strip()
    if not path:
        raise SlackError(
            "WIREBOT_SLACK_TOKEN_FILE is not set; this Wirebot instance has no Slack read access"
        )
    try:
        with open(path, encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError as error:
        raise SlackError(f"cannot read the Slack token file: {error.strerror}") from None
    if not value:
        raise SlackError("the Slack token file is empty")
    return value


def call(method: str, **params: object) -> dict:
    if method not in READ_METHODS:
        raise SlackError(f"refusing non-read Slack method {method}")
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    request = urllib.request.Request(
        f"{API}{method}?{query}", headers={"Authorization": f"Bearer {token()}"}
    )
    for _attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                time.sleep(int(error.headers.get("Retry-After", "5")))
                continue
            raise SlackError(f"{method}: HTTP {error.code}") from None
        if data.get("ok"):
            return data
        if data.get("error") == "ratelimited":
            time.sleep(5)
            continue
        detail = data.get("error", "unknown_error")
        needed = data.get("needed")
        raise SlackError(f"{method}: {detail}" + (f" (needs scope {needed})" if needed else ""))
    raise SlackError(f"{method}: still rate limited after retries")


def paginate(method: str, key: str, limit: int, **params: object) -> list[dict]:
    items: list[dict] = []
    cursor = None
    while len(items) < limit:
        page = call(method, limit=min(200, limit - len(items)), cursor=cursor, **params)
        items.extend(page.get(key, []))
        cursor = (page.get("response_metadata") or {}).get("next_cursor") or None
        if not cursor:
            break
    return items[:limit]


_names: dict[str, str] = {}


def name_of(user_id: str | None, fallback: str = "unknown") -> str:
    if not user_id:
        return fallback
    if user_id not in _names:
        try:
            user = call("users.info", user=user_id)["user"]
            profile = user.get("profile") or {}
            _names[user_id] = (
                profile.get("display_name") or profile.get("real_name") or user.get("name") or user_id
            )
        except SlackError:
            _names[user_id] = user_id
    return _names[user_id]


MENTION = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>")
CHANNEL = re.compile(r"<#([CG][A-Z0-9]+)\|([^>]*)>")
LINK = re.compile(r"<(https?://[^|>]+)(?:\|([^>]*))?>")


def plain(text: str) -> str:
    text = MENTION.sub(lambda m: "@" + name_of(m.group(1)), text)
    text = CHANNEL.sub(lambda m: "#" + (m.group(2) or m.group(1)), text)
    text = LINK.sub(lambda m: m.group(2) or m.group(1), text)
    return text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def stamp(ts: str) -> str:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def render(message: dict, indent: str = "") -> str:
    author = name_of(message.get("user"), message.get("username") or message.get("bot_id") or "bot")
    body = plain(message.get("text") or "").strip()
    files = [f"[file: {f.get('name') or f.get('title') or 'attachment'}]" for f in message.get("files", [])]
    replies = message.get("reply_count")
    extra = f" [thread: {replies} replies, ts {message['ts']}]" if replies else ""
    content = " ".join(part for part in [body, *files] if part)
    lines = (content or "(no text)").splitlines() or [""]
    head = f"{indent}[{stamp(message['ts'])}] {author}: {lines[0]}{extra}"
    return "\n".join([head, *[f"{indent}    {line}" for line in lines[1:]]])


def thread(channel: str, ts: str, limit: int) -> list[dict]:
    return paginate("conversations.replies", "messages", limit, channel=channel, ts=ts)


def cmd_thread(args: argparse.Namespace) -> None:
    for message in thread(args.channel, args.ts, args.limit):
        print(render(message))


def parse_link(url: str) -> tuple[str, str, str | None]:
    match = re.search(r"/archives/([A-Z0-9]+)/p(\d{10})(\d{6})", url)
    if not match:
        raise SlackError("not a Slack message link (expected .../archives/<channel>/p<digits>)")
    channel, seconds, micros = match.groups()
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    return channel, f"{seconds}.{micros}", (query.get("thread_ts") or [None])[0]


def cmd_link(args: argparse.Namespace) -> None:
    channel, ts, thread_ts = parse_link(args.url)
    for message in thread(channel, thread_ts or ts, args.limit):
        marker = ">> " if message["ts"] == ts else ""
        print(marker + render(message))


def cmd_history(args: argparse.Namespace) -> None:
    oldest = None if args.days is None else str(time.time() - args.days * 86_400)
    messages = paginate(
        "conversations.history", "messages", args.limit, channel=args.channel, oldest=oldest
    )
    for message in reversed(messages):
        print(render(message))
        if args.with_threads and message.get("reply_count"):
            for reply in thread(args.channel, message["ts"], args.limit)[1:]:
                print(render(reply, indent="    "))


def bot_conversations(types: str) -> list[dict]:
    return paginate("users.conversations", "channels", 2_000, types=types, exclude_archived="true")


def cmd_channels(args: argparse.Namespace) -> None:
    for channel in bot_conversations(args.types):
        if channel.get("is_im"):
            label = f"DM with {name_of(channel.get('user'))}"
        else:
            label = ("private " if channel.get("is_private") else "") + f"#{channel.get('name', '?')}"
        print(f"{channel['id']}\t{label}")


def cmd_find_channel(args: argparse.Namespace) -> None:
    wanted = args.name.lstrip("#").lower()
    matches = [
        c
        for c in bot_conversations("public_channel,private_channel")
        if wanted in (c.get("name") or "").lower()
    ]
    if not matches:
        print(f"No channel the bot is a member of matches '{wanted}'.")
    for channel in matches:
        print(f"{channel['id']}\t#{channel.get('name')}")


def cmd_user(args: argparse.Namespace) -> None:
    user = call("users.info", user=args.user)["user"]
    profile = user.get("profile") or {}
    print(
        f"{user['id']}\t{profile.get('real_name') or user.get('name')}"
        f"\t{profile.get('display_name') or ''}\t{profile.get('title') or ''}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Slack history helper")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("thread", help="print a whole thread")
    p.add_argument("channel")
    p.add_argument("ts")
    p.add_argument("--limit", type=int, default=1_000)
    p.set_defaults(run=cmd_thread)
    p = sub.add_parser("link", help="print the thread a Slack message link points to")
    p.add_argument("url")
    p.add_argument("--limit", type=int, default=1_000)
    p.set_defaults(run=cmd_link)
    p = sub.add_parser("history", help="print recent top-level channel messages")
    p.add_argument("channel")
    p.add_argument("--days", type=float, default=7)
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--with-threads", action="store_true")
    p.set_defaults(run=cmd_history)
    p = sub.add_parser("channels", help="list conversations the bot is a member of")
    p.add_argument("--types", default="public_channel,private_channel,mpim")
    p.set_defaults(run=cmd_channels)
    p = sub.add_parser("find-channel", help="resolve a channel name to its ID")
    p.add_argument("name")
    p.set_defaults(run=cmd_find_channel)
    p = sub.add_parser("user", help="show a user's name and title")
    p.add_argument("user")
    p.set_defaults(run=cmd_user)
    args = parser.parse_args()
    try:
        args.run(args)
    except SlackError as error:
        print(f"slack.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
