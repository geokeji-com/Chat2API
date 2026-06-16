#!/usr/bin/env python3
"""Call the local Chat2API proxy with only platform and query inputs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any

STANDARD_CHUNK_KEYS = {"id", "object", "created", "model", "choices", "usage"}
MESSAGE_EXTRA_KEYS = {
    "citations",
    "references",
    "sources",
    "source_list",
    "search_results",
    "searchResults",
    "search_queries",
    "searchQueries",
    "related_searches",
    "relatedSearches",
    "share_url",
    "shareUrl",
}
CITATION_MARKER_RE = re.compile(r"\[citation:(\d+)\]")
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DEBUG_LOG_DIR = os.path.join(PROJECT_ROOT, "logs", "platform-calls")
SENSITIVE_KEY_RE = re.compile(r"authorization|cookie|token|secret|password|credential|x-ds-pow-response|set-cookie", re.I)


PLATFORMS: dict[str, dict[str, Any]] = {
    "doubao": {
        "label": "豆包",
        "model": "doubao",
        "aliases": ["豆包", "doubao", "Doubao"],
    },
    "deepseek": {
        "label": "DeepSeek",
        "model": "deepseek-v4-flash",
        "aliases": ["deepseek", "DeepSeek", "深度求索", "深度"],
    },
    "yuanbao": {
        "label": "元宝",
        "model": "hunyuan",
        "aliases": ["元宝", "腾讯元宝", "yuanbao", "Yuanbao"],
    },
    "kimi": {
        "label": "Kimi",
        "model": "Kimi-K2.6",
        "aliases": ["kimi", "Kimi", "月之暗面"],
    },
    "qwen": {
        "label": "通义千问",
        "model": "Qwen3.7-千问",
        "aliases": ["qwen", "Qwen", "千问", "通义", "通义千问"],
    },
}


def build_alias_map() -> dict[str, str]:
    aliases: dict[str, str] = {}
    for platform_id, config in PLATFORMS.items():
        aliases[platform_id.lower()] = platform_id
        for alias in config["aliases"]:
            aliases[str(alias).strip().lower()] = platform_id
    return aliases


ALIASES = build_alias_map()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Call Chat2API local OpenAI-compatible proxy by platform and query.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 scripts/call_ai_platform.py 豆包 \"查询词\"\n"
            "  python3 scripts/call_ai_platform.py 豆包 \"查询词\" --city 上海\n"
            "  python3 scripts/call_ai_platform.py --platform deepseek --query \"你好\" --expert\n"
            "  python3 scripts/call_ai_platform.py --input-json '{\"platform\":\"豆包\",\"query\":\"查询词\",\"city\":\"上海\"}'\n"
            "  python3 scripts/call_ai_platform.py --list-platforms\n"
        ),
    )
    parser.add_argument("pos_platform", nargs="?", help="Platform name, e.g. 豆包/deepseek/qwen")
    parser.add_argument("pos_query", nargs="?", help="Query text")
    parser.add_argument("-p", "--platform", help="Platform name. Overrides JSON/positional input.")
    parser.add_argument("-q", "--query", help="Query text. Overrides JSON/positional input.")
    parser.add_argument(
        "--input-json",
        help="JSON string, @file path, or '-' for stdin. Only platform/query are required.",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("CHAT2API_BASE_URL", "http://127.0.0.1:8080/v1"),
        help="Chat2API base URL. Default: CHAT2API_BASE_URL or http://127.0.0.1:8080/v1",
    )
    parser.add_argument(
        "--management-secret",
        default=os.getenv("CHAT2API_MGMT_SECRET"),
        help="Optional management API secret for proxy-pool city validation.",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("CHAT2API_API_KEY") or os.getenv("OPENAI_API_KEY"),
        help="Optional Chat2API API key. Default: CHAT2API_API_KEY or OPENAI_API_KEY.",
    )
    parser.add_argument("--model", help="Override the default model for the selected platform.")
    parser.add_argument("--system", help="Optional system prompt.")
    parser.add_argument("--timeout", type=float, default=120.0, help="HTTP timeout in seconds. Default: 120")
    parser.add_argument("--main-task-id", help="Optional task id for output envelope.")
    parser.add_argument("--enterprise-id", help="Optional enterprise id for output envelope.")
    parser.add_argument("--create-time", help="Optional create time for output envelope.")
    parser.add_argument("--city", default=os.getenv("CHAT2API_CITY"), help="Optional proxy-pool target city, e.g. 上海.")
    parser.add_argument("--web-search", action="store_true", help="Set request web_search=true.")
    parser.add_argument("--expert", action="store_true", help="DeepSeek only: use expert model (R1, no web search).")
    parser.add_argument("--raw", action="store_true", help="Include raw OpenAI-compatible response.")
    parser.add_argument(
        "--no-debug-raw",
        action="store_true",
        help="Disable raw request/response debug logging (enabled by default).",
    )
    parser.add_argument(
        "--debug-log-file",
        help=f"Debug raw JSONL log file path. Default: {DEFAULT_DEBUG_LOG_DIR}/<platform>-<timestamp>-<taskId>.jsonl",
    )
    parser.add_argument(
        "--no-stream",
        action="store_true",
        help="Debug override: request non-streaming JSON instead of the default silent stream.",
    )
    parser.add_argument("--list-platforms", action="store_true", help="Print supported platform names and exit.")
    return parser.parse_args()


def load_input_json(value: str | None) -> dict[str, Any]:
    if not value:
        return {}

    if value == "-":
        text = sys.stdin.read()
    elif value.startswith("@"):
        with open(value[1:], "r", encoding="utf-8") as file:
            text = file.read()
    elif os.path.exists(value):
        with open(value, "r", encoding="utf-8") as file:
            text = file.read()
    else:
        text = value

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid --input-json: {exc}") from exc

    if not isinstance(data, dict):
        raise SystemExit("--input-json must be a JSON object")
    return data


def resolve_platform(platform: str) -> tuple[str, dict[str, Any]]:
    key = platform.strip().lower()
    platform_id = ALIASES.get(key)
    if not platform_id:
        supported = ", ".join(config["label"] for config in PLATFORMS.values())
        raise SystemExit(f"Unsupported platform: {platform}. Supported: {supported}")
    return platform_id, PLATFORMS[platform_id]


def chat_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def management_base_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return base[:-3]
    if base.endswith("/v1/chat/completions"):
        return base[: -len("/v1/chat/completions")]
    if base.endswith("/chat/completions"):
        return base[: -len("/chat/completions")]
    return base


def normalize_city(value: Any) -> str:
    return clean_text(value).removesuffix("市").lower()


def is_assignable_proxy_node(node: dict[str, Any]) -> bool:
    if node.get("enabled") is False:
        return False
    status = node.get("status") or "active"
    if status in {"inactive", "error"}:
        return False
    if status == "cooldown" and node.get("cooldownUntil"):
        try:
            return int(node["cooldownUntil"]) <= int(dt.datetime.now().timestamp() * 1000)
        except (TypeError, ValueError):
            return False
    return True


def fetch_proxy_nodes(base_url: str, management_secret: str | None, timeout: float) -> list[dict[str, Any]] | None:
    if not management_secret:
        return None

    url = f"{management_base_url(base_url)}/v0/management/proxy-pool/nodes"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {management_secret}",
    }
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError):
        return None

    nodes = data.get("data") if isinstance(data, dict) else None
    return nodes if isinstance(nodes, list) else None


def resolve_proxy_city(city: str, nodes: list[dict[str, Any]] | None) -> tuple[str, str, dict[str, Any] | None]:
    if not city:
        return "", "not_requested", None
    if nodes is None:
        return city, "sent_unverified", None

    requested = normalize_city(city)
    for node in nodes:
        if not isinstance(node, dict) or not is_assignable_proxy_node(node):
            continue
        if normalize_city(node.get("city")) == requested:
            return city, "matched", node
    return "", "ignored_not_in_proxy_pool", None


def resolve_model(platform_id: str, default_model: str, args: argparse.Namespace) -> str:
    requested_model = args.model or default_model

    if platform_id != "deepseek" or args.model:
        return requested_model

    if getattr(args, "expert", False):
        return "deepseek-expert"

    if args.web_search:
        return f"{requested_model}-search"
    return requested_model


def build_payload(query: str, model: str, proxy_city: str, args: argparse.Namespace, debug_log_file: str = "", debug_raw: bool = False) -> dict[str, Any]:
    messages: list[dict[str, str]] = []
    if args.system:
        messages.append({"role": "system", "content": args.system})
    messages.append({"role": "user", "content": query})

    stream_enabled = not args.no_stream
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": stream_enabled,
    }
    if stream_enabled:
        payload["stream_options"] = {"include_final_response": True}
    if args.web_search:
        payload["web_search"] = True
    if debug_raw:
        payload["chat2api_debug_raw"] = True
        if debug_log_file:
            payload["chat2api_debug_log_file"] = debug_log_file
    if proxy_city:
        payload["proxy_city"] = proxy_city
    return payload


def post_chat_completion(url: str, payload: dict[str, Any], api_key: str | None, timeout: float, debug_raw: bool = False) -> dict[str, Any]:
    stream_enabled = bool(payload.get("stream"))
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream_enabled else "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/event-stream" in content_type:
                return read_sse_final_response(response, debug_raw)
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} from {url}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Failed to connect to {url}: {exc.reason}") from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Response is not JSON: {text[:500]}") from exc

    if not isinstance(data, dict):
        raise SystemExit(f"Unexpected response: {data!r}")
    if debug_raw:
        data["__chat2api_debug"] = {
            "raw_response_text": text,
        }
    return data


def read_sse_final_response(response: Any, debug_raw: bool = False) -> dict[str, Any]:
    state = create_stream_state()
    final_response: dict[str, Any] | None = None
    event_lines: list[str] = []
    raw_events: list[str] = []

    def process_event() -> None:
        nonlocal final_response, event_lines
        data = extract_sse_data(event_lines)
        event_lines = []
        if not data or data == "[DONE]":
            return

        if debug_raw:
            raw_events.append(data)

        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            return

        if not isinstance(chunk, dict):
            return

        candidate = chunk.get("final_response")
        if isinstance(candidate, dict):
            final_response = candidate
            add_stream_chunk(state, chunk)
            return

        add_stream_chunk(state, chunk)

    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            process_event()
        else:
            event_lines.append(line)

    if event_lines:
        process_event()

    aggregated = create_response_from_stream_state(state)
    result = merge_final_response_with_aggregated(final_response, aggregated) if final_response else aggregated
    if debug_raw:
        result["__chat2api_debug"] = {
            "raw_sse_events": raw_events,
        }
    return result


def extract_sse_data(event_lines: list[str]) -> str | None:
    data_lines: list[str] = []
    for line in event_lines:
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data = line[5:]
            data_lines.append(data[1:] if data.startswith(" ") else data)
    return "\n".join(data_lines) if data_lines else None


def create_stream_state() -> dict[str, Any]:
    return {
        "id": "",
        "model": "",
        "created": int(dt.datetime.now().timestamp()),
        "content": "",
        "reasoning_content": "",
        "finish_reason": None,
        "usage": None,
        "message_extras": {},
        "response_extras": {},
        "tool_calls": [],
    }


def add_stream_chunk(state: dict[str, Any], chunk: dict[str, Any]) -> None:
    if isinstance(chunk.get("id"), str) and chunk["id"]:
        state["id"] = chunk["id"]
    if isinstance(chunk.get("model"), str) and chunk["model"]:
        state["model"] = chunk["model"]
    if isinstance(chunk.get("created"), int):
        state["created"] = chunk["created"]
    if isinstance(chunk.get("usage"), dict):
        state["usage"] = chunk["usage"]

    collect_provider_extras(state, chunk)

    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return

    choice = choices[0]
    if choice.get("finish_reason"):
        state["finish_reason"] = choice.get("finish_reason")

    delta = choice.get("delta")
    if isinstance(delta, dict):
        append_message_parts(state, delta)

    message = choice.get("message")
    if isinstance(message, dict):
        append_message_parts(state, message)
        for key in MESSAGE_EXTRA_KEYS:
            if key in message:
                state["message_extras"][key] = message[key]


def append_message_parts(state: dict[str, Any], message_part: dict[str, Any]) -> None:
    content = message_part.get("content")
    if isinstance(content, str):
        state["content"] += content
    reasoning_content = message_part.get("reasoning_content")
    if isinstance(reasoning_content, str):
        state["reasoning_content"] += reasoning_content
    tool_calls = message_part.get("tool_calls")
    if isinstance(tool_calls, list):
        merge_tool_calls(state["tool_calls"], tool_calls)


def collect_provider_extras(state: dict[str, Any], chunk: dict[str, Any]) -> None:
    for key, value in chunk.items():
        if value is None or key in STANDARD_CHUNK_KEYS:
            continue
        if key in MESSAGE_EXTRA_KEYS:
            state["message_extras"][key] = value
        else:
            state["response_extras"][key] = value


def merge_tool_calls(target: list[dict[str, Any]], delta_tool_calls: list[Any]) -> None:
    for delta_tool_call in delta_tool_calls:
        if not isinstance(delta_tool_call, dict):
            continue

        index = delta_tool_call.get("index")
        if not isinstance(index, int):
            index = len(target)

        tool_call = next((item for item in target if item.get("index") == index), None)
        if tool_call is None:
            tool_call = {
                "index": index,
                "id": "",
                "type": "function",
                "function": {"name": "", "arguments": ""},
            }
            target.append(tool_call)

        if delta_tool_call.get("id"):
            tool_call["id"] = delta_tool_call["id"]
        if delta_tool_call.get("type"):
            tool_call["type"] = delta_tool_call["type"]

        function_delta = delta_tool_call.get("function")
        if isinstance(function_delta, dict):
            if function_delta.get("name"):
                tool_call["function"]["name"] = function_delta["name"]
            if function_delta.get("arguments"):
                tool_call["function"]["arguments"] += str(function_delta["arguments"])


def create_response_from_stream_state(state: dict[str, Any]) -> dict[str, Any]:
    tool_calls = [
        {key: value for key, value in tool_call.items() if key != "index"}
        for tool_call in sorted(state["tool_calls"], key=lambda item: item.get("index", 0))
    ]
    message: dict[str, Any] = {
        "role": "assistant",
        "content": None if tool_calls else (state["content"] or None),
    }
    if state["reasoning_content"]:
        message["reasoning_content"] = state["reasoning_content"]
    if tool_calls:
        message["tool_calls"] = tool_calls
    message.update(state["message_extras"])

    finish_reason = state["finish_reason"] or ("tool_calls" if tool_calls else "stop")
    response = {
        "id": state["id"],
        "object": "chat.completion",
        "created": state["created"],
        "model": state["model"],
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": state["usage"],
    }
    response.update(state["response_extras"])
    return response


def merge_missing_extras(target: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    result = {**target}
    for key in MESSAGE_EXTRA_KEYS:
        if result.get(key) in (None, "", [], {}) and fallback.get(key) not in (None, "", [], {}):
            result[key] = fallback[key]
    return result


def merge_final_response_with_aggregated(final_response: dict[str, Any], aggregated: dict[str, Any]) -> dict[str, Any]:
    result = {**aggregated, **final_response}

    final_message = extract_message(final_response)
    aggregated_message = extract_message(aggregated)
    if final_message or aggregated_message:
        merged_message = merge_missing_extras(final_message, aggregated_message)
        if merged_message.get("content") in (None, "") and aggregated_message.get("content") not in (None, ""):
            merged_message["content"] = aggregated_message.get("content")
        if merged_message.get("reasoning_content") in (None, "") and aggregated_message.get("reasoning_content") not in (None, ""):
            merged_message["reasoning_content"] = aggregated_message.get("reasoning_content")

        choices = result.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            result["choices"] = [
                {
                    **choices[0],
                    "message": merged_message,
                },
                *choices[1:],
            ]

    for key in MESSAGE_EXTRA_KEYS:
        if result.get(key) in (None, "", [], {}) and aggregated.get(key) not in (None, "", [], {}):
            result[key] = aggregated[key]
    return result


def extract_message(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return {}
    message = choices[0].get("message")
    return message if isinstance(message, dict) else {}


def extract_answer(response: dict[str, Any]) -> str:
    message = extract_message(response)
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            elif item is not None:
                parts.append(str(item))
        return "".join(parts)
    return "" if content is None else str(content)


def extract_finish_reason(response: dict[str, Any]) -> Any:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    return choices[0].get("finish_reason")


def first_defined(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def first_non_empty(*values: Any) -> Any:
    for value in values:
        if value in (None, "", [], {}):
            continue
        return value
    return None


def pick_text(record: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if value is not None and not isinstance(value, (dict, list)):
            text = str(value).strip()
            if text:
                return text
    return ""


def pick_int(*values: Any) -> int | None:
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return None


def normalize_text_list(value: Any) -> list[str]:
    if value in (None, ""):
        return []

    entries = value if isinstance(value, list) else [value]
    result: list[str] = []
    seen: set[str] = set()

    for entry in entries:
        text = ""
        if isinstance(entry, str):
            text = entry.strip()
        elif isinstance(entry, dict):
            text = pick_text(entry, ["query", "question", "text", "content", "title"])
        elif entry is not None:
            text = str(entry).strip()

        if text and text not in seen:
            seen.add(text)
            result.append(text)

    return result


def citation_entries(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in [
            "citations",
            "references",
            "sources",
            "source_list",
            "results",
            "search_results",
            "searchResults",
            "items",
            "list",
        ]:
            nested = value.get(key)
            if isinstance(nested, list):
                return nested
        if value.get("url") or value.get("title"):
            return [value]
    return []


def normalize_citations(value: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in citation_entries(value):
        if not isinstance(item, dict):
            normalized.append({
                "index": None,
                "citeIndex": None,
                "url": "",
                "title": "",
                "snippet": str(item),
                "platform": "",
                "publishedAt": None,
                "siteIcon": "",
            })
            continue

        index = pick_int(item.get("index"), item.get("cite_index"), item.get("citeIndex"), item.get("ref_num"), item.get("ref"))
        cite_index = pick_int(item.get("cite_index"), item.get("citeIndex"), item.get("index"), item.get("ref_num"), item.get("ref"))
        normalized.append({
            "index": index,
            "citeIndex": cite_index,
            "url": pick_text(item, ["url", "href", "link"]),
            "title": pick_text(item, ["title", "name"]),
            "snippet": pick_text(item, ["snippet", "summary", "content", "text", "description", "abstract", "passage", "quote"]),
            "platform": pick_text(item, ["site_name", "siteName", "platform", "source", "source_name", "website", "host", "domain"]),
            "publishedAt": first_defined(item.get("published_at"), item.get("publishedAt"), item.get("publish_time"), item.get("date")),
            "siteIcon": pick_text(item, ["site_icon", "siteIcon", "icon", "favicon"]),
        })
    return normalized


def render_citation_markers(text: str, citations: list[dict[str, Any]]) -> str:
    if not text:
        return ""

    by_index: dict[int, dict[str, Any]] = {}
    for citation in citations:
        for key in ("citeIndex", "index"):
            value = citation.get(key)
            if isinstance(value, int) and value not in by_index:
                by_index[value] = citation

    def replace(match: re.Match[str]) -> str:
        cite_index = int(match.group(1))
        citation = by_index.get(cite_index)
        if not citation:
            return f"[{cite_index}]"

        url = clean_text(citation.get("url"))
        if not url:
            return f"[{cite_index}]"
        return f"[{cite_index}](<{url}>)"

    return CITATION_MARKER_RE.sub(replace, text)


def extract_chat2api(response: dict[str, Any], message: dict[str, Any]) -> dict[str, Any]:
    for value in (response.get("chat2api"), message.get("chat2api")):
        if isinstance(value, dict):
            return value
    return {}


def extract_structured_fields(response: dict[str, Any]) -> dict[str, Any]:
    message = extract_message(response)
    chat2api = extract_chat2api(response, message)
    citations_source = first_non_empty(
        message.get("citations"),
        response.get("citations"),
        message.get("references"),
        response.get("references"),
        message.get("sources"),
        response.get("sources"),
        message.get("source_list"),
        response.get("source_list"),
        message.get("search_results"),
        response.get("search_results"),
        message.get("searchResults"),
        response.get("searchResults"),
    )
    citations = normalize_citations(citations_source)
    answer = extract_answer(response)
    reasoning_content = clean_text(message.get("reasoning_content"))
    message_ids = first_non_empty(chat2api.get("message_ids"), chat2api.get("messageIds"))

    return {
        "answer": answer,
        "reasoningContent": reasoning_content,
        "searchQueries": normalize_text_list(first_non_empty(
            message.get("search_queries"),
            response.get("search_queries"),
            message.get("searchQueries"),
            response.get("searchQueries"),
        )),
        "relatedSearches": normalize_text_list(first_non_empty(
            message.get("related_searches"),
            response.get("related_searches"),
            message.get("relatedSearches"),
            response.get("relatedSearches"),
        )),
        "citations": citations,
        "shareUrl": clean_text(first_non_empty(chat2api.get("share_url"), chat2api.get("shareUrl"), message.get("share_url"), response.get("share_url"), message.get("shareUrl"), response.get("shareUrl"))),
        "shareId": clean_text(first_non_empty(chat2api.get("share_id"), chat2api.get("shareId"))),
        "conversationUrl": clean_text(first_non_empty(chat2api.get("conversation_url"), chat2api.get("conversationUrl"))),
        "sessionId": clean_text(first_non_empty(chat2api.get("session_id"), chat2api.get("sessionId"))),
        "messageIds": message_ids if isinstance(message_ids, list) else [],
    }


def extract_snapshots_from_debug_log(log_path: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """从服务端写入同一日志文件的 debug trace 事件中提取用户快照和 proxy 快照。"""
    user_snapshot: dict[str, Any] = {}
    proxy_snapshot: dict[str, Any] | None = None

    try:
        with open(log_path, "r", encoding="utf-8") as file:
            for raw_line in file:
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue

                if proxy_snapshot is None and isinstance(entry.get("proxy"), dict):
                    proxy_snapshot = {
                        k: v for k, v in entry["proxy"].items()
                        if not SENSITIVE_KEY_RE.search(k)
                    }

                if "users.current.response" in entry.get("event", "") and not user_snapshot:
                    data = entry.get("data") or {}
                    biz_data = (
                        data.get("data", {}).get("biz_data")
                        or data.get("biz_data")
                    )
                    if isinstance(biz_data, dict):
                        chat = biz_data.get("chat") or {}
                        for key in ("id", "email", "mobile_number"):
                            if key in biz_data:
                                user_snapshot[key] = biz_data[key]
                        if "is_muted" in chat:
                            user_snapshot["is_muted"] = chat["is_muted"]
                        if "mute_until" in chat:
                            user_snapshot["mute_until"] = chat["mute_until"]
    except (OSError, IOError):
        pass

    return user_snapshot, proxy_snapshot


def now_string() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def slugify_filename(value: Any) -> str:
    text = clean_text(value)
    text = re.sub(r"[^\w.-]+", "-", text, flags=re.UNICODE).strip("-")
    return text or "call"


def default_debug_log_path(platform_id: str, task_id: str) -> str:
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{slugify_filename(platform_id)}-{timestamp}-{slugify_filename(task_id)[:12]}.jsonl"
    return os.path.abspath(os.path.join(DEFAULT_DEBUG_LOG_DIR, filename))


def resolve_debug_log_path(path: str | None, platform_id: str, task_id: str) -> str:
    absolute_path = os.path.abspath(path) if path else default_debug_log_path(platform_id, task_id)
    project_log_dir = os.path.abspath(DEFAULT_DEBUG_LOG_DIR)
    try:
        inside_project_logs = os.path.commonpath([project_log_dir, absolute_path]) == project_log_dir
    except ValueError:
        inside_project_logs = False
    if inside_project_logs:
        return absolute_path
    return os.path.join(project_log_dir, os.path.basename(absolute_path))


def sanitize_debug_value(value: Any, key_hint: str = "", depth: int = 0) -> Any:
    if SENSITIVE_KEY_RE.search(key_hint):
        return "[redacted]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value
    if depth >= 8:
        return "[max-depth]"
    if isinstance(value, list):
        return [sanitize_debug_value(item, key_hint, depth + 1) for item in value]
    if isinstance(value, dict):
        return {
            str(key): sanitize_debug_value(nested, str(key), depth + 1)
            for key, nested in value.items()
        }
    return str(value)


def append_debug_log_event(path: str, event: str, data: dict[str, Any]) -> tuple[str, int]:
    absolute_path = resolve_debug_log_path(path, "debug", "manual")
    os.makedirs(os.path.dirname(absolute_path), exist_ok=True)
    entry = sanitize_debug_value({
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "event": event,
        **data,
    })
    text = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
    with open(absolute_path, "a", encoding="utf-8") as file:
        file.write(text)
        file.write("\n")
    return absolute_path, os.path.getsize(absolute_path)


def raw_event_count(debug_data: Any, key: str) -> int:
    if not isinstance(debug_data, dict):
        return 0
    value = debug_data.get(key)
    return len(value) if isinstance(value, list) else 0


def print_platforms() -> None:
    rows = []
    for platform_id, config in PLATFORMS.items():
        rows.append(
            {
                "platformId": platform_id,
                "platform": config["label"],
                "defaultModel": config["model"],
                "aliases": config["aliases"],
            }
        )
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def main() -> int:
    args = parse_args()
    if args.list_platforms:
        print_platforms()
        return 0

    task = load_input_json(args.input_json)
    platform = args.platform or args.pos_platform or task.get("platform")
    query = args.query or args.pos_query or task.get("query")
    city = clean_text(args.city or task.get("city"))

    if not platform:
        raise SystemExit("Missing platform. Use --platform or positional platform.")
    if not query:
        raise SystemExit("Missing query. Use --query or positional query.")

    platform_id, platform_config = resolve_platform(str(platform))
    model = resolve_model(platform_id, str(platform_config["model"]), args)
    main_task_id = args.main_task_id or task.get("mainTaskId") or str(uuid.uuid4())
    debug_raw = not args.no_debug_raw
    debug_log_file = resolve_debug_log_path(args.debug_log_file, platform_id, main_task_id) if debug_raw else ""
    proxy_nodes = fetch_proxy_nodes(args.base_url, args.management_secret, args.timeout)
    proxy_city, city_status, matched_proxy_node = resolve_proxy_city(city, proxy_nodes)
    payload = build_payload(str(query), model, proxy_city, args, debug_log_file, debug_raw)
    if debug_raw:
        append_debug_log_event(debug_log_file, "script.request", {
            "mainTaskId": main_task_id,
            "platform": platform_config["label"],
            "platformId": platform_id,
            "query": str(query),
            "request": {
                "url": chat_endpoint(args.base_url),
                "payload": payload,
            },
        })
    response = post_chat_completion(chat_endpoint(args.base_url), payload, args.api_key, args.timeout, debug_raw)
    structured = extract_structured_fields(response)

    # 从服务端写入的 debug trace 事件中提取用户快照和 proxy 快照
    user_snapshot, proxy_snapshot = extract_snapshots_from_debug_log(debug_log_file) if debug_raw else ({}, None)

    create_time = args.create_time or task.get("createTime") or now_string()
    result: dict[str, Any] = {
        "mainTaskId": main_task_id,
        "platform": platform_config["label"],
        "platformId": platform_id,
        "enterpriseId": args.enterprise_id or task.get("enterpriseId") or "",
        "createTime": create_time,
        "query": str(query),
        "city": city,
        "proxyCity": proxy_city,
        "cityStatus": city_status,
        "model": model,
        "answer": structured["answer"],
        "reasoningContent": structured["reasoningContent"],
        "searchQueries": structured["searchQueries"],
        "relatedSearches": structured["relatedSearches"],
        "citations": structured["citations"],
        "shareUrl": structured["shareUrl"],
        "shareId": structured["shareId"],
        "conversationUrl": structured["conversationUrl"],
        "sessionId": structured["sessionId"],
        "userSnapshot": user_snapshot if user_snapshot else None,
        "proxySnapshot": proxy_snapshot,
    }
    if debug_raw:
        proxy_debug = response.get("__chat2api_debug")
        provider_debug = response.get("chat2api_debug")
        append_debug_log_event(debug_log_file, "script.result", {
            "mainTaskId": main_task_id,
            "platform": platform_config["label"],
            "platformId": platform_id,
            "createTime": create_time,
            "query": str(query),
            "response": {
                "structured": result,
                "raw": response,
            },
            "rawResponses": {
                "proxy": proxy_debug,
                "provider": provider_debug,
            },
        })
    if args.raw:
        result["raw"] = response

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
