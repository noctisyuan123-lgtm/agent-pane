# Live process text-roll (Cursor-aligned)

Approved direction **D** (2026-07-17): match Cursor `ui-text-roll` for live tool / activity status, not dual full-card enter/exit.

## Behavior

- **Stage**: one live line; completed process items seal into `ProcessPackFold` (no long card slide-out).
- **Text roll** (parallel, clipped):
  - Previous: `translateY(0)` → `translateY(calc(-100% - 1px))`
  - Current: `translateY(calc(100% + 1px))` → `translateY(0)`
  - Duration: **300ms** (`--cursor-duration-slower`)
  - Easing: `cubic-bezier(0.215, 0.61, 0.355, 1)`
- **minHoldMs: 1200** before rolling to a newer label / chasing the latest live seat (skip intermediate flashes).

## Scope

- Add `TextRoll` + CSS
- Wire into `ToolTimeline` labels
- Simplify `LiveProcessStack` (drop 520/560 overlapping card enter/exit)

## Non-goals

- RunningDock policy (already option A)
- Full Exploring multi-row stack parity
