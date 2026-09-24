#!/usr/bin/env python3
"""Collects tools/*/tool.json into shell/tools.json (sorted by `order`, then name).

Run at image build time; the shell reads the result to draw its tabs.
Each manifest must provide: id, name, path. Optional: tagline, tech, icon, order.
"""
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
tools = []
for manifest in sorted((root / "tools").glob("*/tool.json")):
    data = json.loads(manifest.read_text(encoding="utf-8"))
    folder = manifest.parent.name
    for key in ("id", "name", "path"):
        if key not in data:
            sys.exit(f"{manifest}: missing required field '{key}'")
    if data["id"] != folder:
        sys.exit(f"{manifest}: id '{data['id']}' must match its folder name '{folder}'")
    if data.get("hidden"):
        continue
    tools.append({
        "id": data["id"],
        "name": data["name"],
        "tagline": data.get("tagline", ""),
        "tech": data.get("tech", ""),
        "icon": data.get("icon", "tool"),
        "path": data["path"],
        "order": data.get("order", 100),
    })

tools.sort(key=lambda t: (t["order"], t["name"].lower()))
out = root / "shell" / "tools.json"
out.write_text(json.dumps(tools, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{len(tools)} tool(s) -> {out.relative_to(root)}: " + ", ".join(t["id"] for t in tools))
