#!/usr/bin/env python3
"""Measure explicit ZenX theme-token pairs, including selected alpha layers.

This reproduces the round-six source calculator. It is not a general CSS cascade
parser, a native computed-style inspection, or a WCAG conformance test. The pair
list records manually inspected selector/background relationships. Reinspect
those relationships if component styles or theme selector structure changes.

Only the current theme.css subset is supported: :root with optional exact
[data-*="value"] attributes, source-ordered custom properties, var(--token)
aliases, six-digit hex, and rgb(integer integer integer / percentage) colors.
"""

import argparse
import itertools
import json
from pathlib import Path
import re
import sys


THEME_PATH = Path("apps/zenx/src/renderer/src/theme.css")

# Explicit foreground/background roles, not inferred from arbitrary CSS nodes.
# Order is retained to reproduce the original evidence JSON byte for byte.
OPAQUE_PAIRS = {
    "primary/card": ("text-primary", "surface"),
    "secondary/card": ("text-secondary", "surface"),
    "muted/card": ("text-muted", "surface"),
    "muted/main": ("text-muted", "surface-main"),
    "muted/inset": ("text-muted", "surface-inset"),
    "secondary/model-ID": ("text-secondary", "surface-inset"),
    "primary/input": ("text-primary", "surface-inset"),
    "secondary/readonly": ("text-secondary", "surface-code"),
    "primary/select": ("text-primary", "surface-control"),
    "control-border/card": ("border-control", "surface"),
    "control-border/input": ("border-control", "surface-inset"),
    "control-border/select": ("border-control", "surface-control"),
    "control-border/readonly": ("border-control", "surface-code"),
    "control-border/hover-select": ("border-control", "surface-control-hover"),
    "focus/card": ("focus-ring", "surface"),
    "focus/main": ("focus-ring", "surface-main"),
    "focus/inset": ("focus-ring", "surface-inset"),
    "subtle-border/card": ("border-subtle", "surface"),
    "subtle-border/inset": ("border-subtle", "surface-inset"),
    "subtle-border/main": ("border-subtle", "surface-main"),
    "secondary-button/text": ("text-secondary", "surface-elevated"),
    "secondary-button/border-inner": ("border-strong", "surface-elevated"),
    "secondary-button/border-outer": ("border-strong", "surface"),
    "primary-button/text": ("text-on-accent", "accent"),
    "success-status/card": ("status-success", "surface"),
    "danger-button/text": ("status-danger", "surface-danger"),
    "switch-off/knob-track": ("text-muted", "surface-emphasis"),
    "switch-off/border-track": ("border-strong", "surface-emphasis"),
    "switch-on/knob-track": ("control-knob", "accent"),
}


def read_root_blocks(css):
    """Read the limited, source-ordered root token blocks used by theme.css."""
    blocks = []
    for match in re.finditer(r"(:root[^{}]*)\{([^{}]*)\}", css):
        selector = match[1].strip()
        if not re.fullmatch(r':root(?:\[data-[\w-]+="[^"]+"\])*', selector):
            raise ValueError(f"Unsupported root selector: {selector}")
        attributes = dict(re.findall(r'\[data-([\w-]+)="([^"]+)"\]', selector))
        tokens = dict(re.findall(r"(--[\w-]+):\s*([^;]+);", match[2]))
        blocks.append((attributes, tokens))
    if not blocks:
        raise ValueError("No supported root token blocks found")
    return blocks


def resolve_colors(blocks, state):
    tokens = {}
    for attributes, declarations in blocks:
        if all(state.get(key) == value for key, value in attributes.items()):
            tokens.update(declarations)

    def color(name, seen=()):
        if name in seen:
            raise ValueError(f"Circular token alias: {name}")
        value = tokens[name]
        alias = re.fullmatch(r"var\((--[\w-]+)\)", value)
        if alias:
            return color(alias[1], (*seen, name))
        if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            return [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)] + [1]
        rgba = re.fullmatch(r"rgb\((\d+) (\d+) (\d+) / ([\d.]+)%\)", value)
        if rgba:
            return [int(rgba[index]) / 255 for index in (1, 2, 3)] + [float(rgba[4]) / 100]
        raise ValueError(f"Unsupported color for {name}: {value}")

    return color


def composite(foreground, background):
    """Alpha composite sRGB channels over an opaque background, without rounding."""
    return [
        foreground[index] * foreground[3]
        + background[index] * (1 - foreground[3])
        for index in range(3)
    ] + [1]


def mix(first, second, proportion):
    """The explicit color-mix(in srgb, ...) pair used by danger-button borders."""
    return [
        first[index] * proportion + second[index] * (1 - proportion)
        for index in range(3)
    ] + [1]


def luminance(color):
    return sum(
        weight * (channel / 12.92 if channel <= 0.04045
                  else ((channel + 0.055) / 1.055) ** 2.4)
        for weight, channel in zip((0.2126, 0.7152, 0.0722), color)
    )


def contrast_ratio(foreground, background):
    low, high = sorted((luminance(foreground), luminance(background)))
    return (high + 0.05) / (low + 0.05)


def display_hex(color):
    # Hex is for display only. Ratios retain unrounded composite channels.
    return "#" + "".join(f"{round(channel * 255):02x}" for channel in color[:3])


def measure(blocks):
    rows = []
    combinations = itertools.product(
        ("light", "dark"),
        ("graphite", "cobalt", "ember"),
        ("azure", "iris", "jade"),
        ("standard", "high"),
    )
    for mode, preset, accent, contrast in combinations:
        state = {
            "appearance": mode,
            "theme-preset": preset,
            "accent": accent,
            "contrast": contrast,
        }
        color = resolve_colors(blocks, state)
        row = {"state": "/".join((mode, preset, accent, contrast)), "pairs": {}}

        def add(name, foreground, background):
            row["pairs"][name] = {
                "fg": display_hex(foreground),
                "bg": display_hex(background),
                "ratio": round(contrast_ratio(foreground, background), 4),
            }

        for name, (foreground, background) in OPAQUE_PAIRS.items():
            add(name, color("--color-" + foreground), color("--color-" + background))

        # Selected controls/pills paint accent-soft over the enclosing card.
        selected = composite(color("--color-accent-soft"), color("--color-surface"))
        for token in ("text-muted", "text-primary", "text-accent", "border-accent", "focus-ring"):
            add("selected-accent/" + token, color("--color-" + token), selected)

        error_on_card = composite(color("--color-status-danger-soft"), color("--color-surface"))
        add("error/card", color("--color-status-danger"), error_on_card)
        add(
            "error/main",
            color("--color-status-danger"),
            composite(color("--color-status-danger-soft"), color("--color-surface-main")),
        )
        add("danger-status/card", color("--color-status-danger"), color("--color-surface"))
        add(
            "danger-button/border",
            mix(color("--color-status-danger"), color("--color-border"), 0.55),
            color("--color-surface-danger"),
        )
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=Path(__file__).resolve().parents[3],
        help="Repository root (default: repository containing this script)",
    )
    parser.add_argument(
        "--output", type=Path,
        help="New JSON file; refuses an existing path (default: JSON on stdout)",
    )
    args = parser.parse_args()
    try:
        css = (args.repo / THEME_PATH).read_text(encoding="utf-8")
        document = json.dumps(measure(read_root_blocks(css)), indent=2)
        if args.output is None:
            sys.stdout.write(document)
        else:
            # Exclusive creation protects previously archived evidence.
            with args.output.open("x", encoding="utf-8") as output:
                output.write(document)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Contrast calculation failed: {error}\n")


if __name__ == "__main__":
    main()
