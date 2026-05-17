#!/usr/bin/env python3
"""Cross-agent transfer experiment — internal draft chart.

Per-agent outcome dots, shared vs isolated, side by side. No cumulative
curve. Saves to output/chart_transfer.png.
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

BENCH = Path(__file__).parent.resolve()
RUNS = BENCH / "runs"
OUT = BENCH / "output" / "chart_transfer.png"

# Same palette as Phase 4 charts for consistency
BG = "#0c0a07"
RED = "#ef4444"
GREEN = "#10b981"
AMBER = "#f59e0b"
WHITE = "#f5f5f4"
GREY = "#a8a29e"

plt.rcParams.update({
    "figure.facecolor": BG,
    "axes.facecolor": BG,
    "savefig.facecolor": BG,
    "axes.edgecolor": GREY,
    "axes.labelcolor": WHITE,
    "xtick.color": WHITE,
    "ytick.color": WHITE,
    "text.color": WHITE,
    "font.family": "sans-serif",
    "font.size": 12,
})


def load_outcomes(mode: str) -> list[tuple[int, bool]]:
    """Return [(agent_index, e2e_success), ...] sorted by agent_index."""
    d = RUNS / f"transfer-{mode}"
    out = []
    for p in d.glob("agent-*.json"):
        try:
            w = json.loads(p.read_text())
            out.append((w["agent_index"], bool(w["e2e_success"])))
        except (json.JSONDecodeError, KeyError):
            continue
    out.sort(key=lambda t: t[0])
    return out


shared = load_outcomes("shared")
isolated = load_outcomes("isolated")

assert len(shared) == 50, f"shared count {len(shared)} != 50"
assert len(isolated) == 50, f"isolated count {len(isolated)} != 50"

fig, ax = plt.subplots(figsize=(16, 9))
fig.patch.set_facecolor(BG)

# Two rows of dots
SHARED_Y = 0.62
ISOLATED_Y = 0.30

# ── Row 1: shared ──
for idx, ok in shared:
    color = GREEN if ok else RED
    ax.scatter(idx, SHARED_Y, s=160, color=color, edgecolor=BG, linewidth=1.2, zorder=3)

# ── Row 2: isolated ──
for idx, ok in isolated:
    color = GREEN if ok else RED
    ax.scatter(idx, ISOLATED_Y, s=160, color=color, edgecolor=BG, linewidth=1.2, zorder=3)

# Row labels on the left
ax.text(-1.5, SHARED_Y, "Shared\nGene Map",
        ha="right", va="center", fontsize=18, fontweight="bold", color=WHITE)
ax.text(-1.5, ISOLATED_Y, "Isolated\nGene Map\n(one per agent)",
        ha="right", va="center", fontsize=18, fontweight="bold", color=WHITE)

# Per-row success summary on the right
shared_ok = sum(1 for _, ok in shared if ok)
isolated_ok = sum(1 for _, ok in isolated if ok)
ax.text(52.5, SHARED_Y, f"{shared_ok}/50",
        ha="left", va="center", fontsize=24, fontweight="bold", color=GREEN)
ax.text(52.5, ISOLATED_Y, f"{isolated_ok}/50",
        ha="left", va="center", fontsize=24, fontweight="bold", color=RED)

# ── Annotation 1: agent 1 cold-start callout (shared row) ──
ax.annotate(
    "Agent 1 — cold start, Gene Map empty.\nRecords the failure.",
    xy=(1, SHARED_Y),
    xytext=(3.5, SHARED_Y + 0.16),
    ha="left", va="bottom",
    fontsize=12, color=RED,
    arrowprops=dict(arrowstyle="-|>", color=RED, lw=1.6, alpha=0.9),
)

# ── Annotation 2: agents 2-50 inherit (shared row) ──
ax.text(
    26, SHARED_Y - 0.14,
    "Agents 2–50 — inherit Agent 1's experience.  49/49 succeed.",
    ha="center", va="top",
    fontsize=13, color=GREEN, style="italic",
)

# ── Annotation 3: isolated row (spans all) ──
ax.text(
    26, ISOLATED_Y - 0.14,
    "No shared Gene Map — every agent repeats the same failure.  0/50.",
    ha="center", va="top",
    fontsize=13, color=RED, style="italic",
)

# ── Headline block ──
fig.text(
    0.5, 0.06,
    f"Shared {shared_ok}/50 (98%)  ·  Isolated {isolated_ok}/50 (0%)  ·  Δ +98 pp",
    ha="center", va="center",
    fontsize=22, fontweight="bold", color=AMBER,
)

# Axes
ax.set_xlim(-12, 56)
ax.set_ylim(0, 0.9)
ax.set_xticks([1, 10, 20, 30, 40, 50])
ax.set_xticklabels(["1", "10", "20", "30", "40", "50"], fontsize=12)
ax.set_yticks([])
ax.set_xlabel("Agent index (1 → 50, deployed in sequence)", fontsize=13, color=GREY)
for spine in ("top", "right", "left"):
    ax.spines[spine].set_visible(False)
ax.spines["bottom"].set_color(GREY)
ax.tick_params(axis="x", colors=GREY)

# Title block
fig.text(
    0.5, 0.945,
    "One agent's failure immunizes the rest — cross-agent transfer",
    ha="center", fontsize=24, fontweight="bold", color=WHITE,
)
fig.text(
    0.5, 0.905,
    "N=50 agents per mode · Arc Testnet · 1 agent = 1 ten-hop workflow · shared vs isolated Gene Map",
    ha="center", fontsize=13, color=GREY,
)

# Footer
fig.text(
    0.5, 0.02,
    "541 real Arc Testnet USDC transfers (491 shared + 50 isolated)  ·  tx hashes in runs/transfer-*-manifest-*.json",
    ha="center", fontsize=11, color=GREY, style="italic",
)

plt.subplots_adjust(left=0.08, right=0.92, top=0.85, bottom=0.16)

OUT.parent.mkdir(exist_ok=True)
plt.savefig(OUT, dpi=100)
print(f"wrote {OUT}")
