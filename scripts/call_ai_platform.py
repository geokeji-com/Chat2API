#!/usr/bin/env python3
"""Call the local Chat2API proxy with only platform and query inputs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any


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
            "  python3 scripts/call_ai_platform.py --platform deepseek --query \"你好\"\n"
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
    parser.add_argument(
        "--reasoning-effort",
        choices=["low", "medium", "high"],
        help="Set request reasoning_effort.",
    )
    parser.add_argument("--raw", action="store_true", help="Include raw OpenAI-compatible response.")
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


def resolve_proxy_city(city: str, nodes: list[dict[str, Any]] | None) -> tuple[str, str]:
    if not city:
        return "", "not_requested"
    if nodes is None:
        return city, "sent_unverified"

    requested = normalize_city(city)
    for node in nodes:
        if not isinstance(node, dict) or not is_assignable_proxy_node(node):
            continue
        if normalize_city(node.get("city")) == requested:
            return city, "matched"
    return "", "ignored_not_in_proxy_pool"


def build_payload(query: str, model: str, proxy_city: str, args: argparse.Namespace) -> dict[str, Any]:
    messages: list[dict[str, str]] = []
    if args.system:
        messages.append({"role": "system", "content": args.system})
    messages.append({"role": "user", "content": query})

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    if args.web_search:
        payload["web_search"] = True
    if proxy_city:
        payload["proxy_city"] = proxy_city
    if args.reasoning_effort:
        payload["reasoning_effort"] = args.reasoning_effort
    return payload


def post_json(url: str, payload: dict[str, Any], api_key: str | None, timeout: float) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
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
    return data


def extract_answer(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return ""

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


def now_string() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


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
    model = args.model or str(platform_config["model"])
    proxy_nodes = fetch_proxy_nodes(args.base_url, args.management_secret, args.timeout)
    proxy_city, city_status = resolve_proxy_city(city, proxy_nodes)
    payload = build_payload(str(query), model, proxy_city, args)
    response = post_json(chat_endpoint(args.base_url), payload, args.api_key, args.timeout)
    answer = extract_answer(response)

    result: dict[str, Any] = {
        "mainTaskId": args.main_task_id or task.get("mainTaskId") or str(uuid.uuid4()),
        "platform": platform_config["label"],
        "platformId": platform_id,
        "enterpriseId": args.enterprise_id or task.get("enterpriseId") or "",
        "createTime": args.create_time or task.get("createTime") or now_string(),
        "query": str(query),
        "city": city,
        "proxyCity": proxy_city,
        "cityStatus": city_status,
        "model": model,
        "answer": answer,
        "finishReason": extract_finish_reason(response),
        "usage": response.get("usage"),
    }
    if args.raw:
        result["raw"] = response

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
