# Cursor Agents Window tokens (extracted 2026-07-10)

## A. Theme JSON (solid charcoal — classic IDE)

Source: `/Applications/Cursor.app/.../theme-cursor/themes/cursor-dark-color-theme.json`

| Token | Value | Notes |
|-------|-------|-------|
| editor.background | `#181818` | solid IDE editor |
| sideBar.background | `#141414` | solid sidebar |
| button.background | `#81A1C1` | accent (kept) |
| … | … | full table archived in git history if needed |

## B. Glass Agents Window (true look — frosted black)

Sources:

- Screenshot sample (2026-07-10): main `#151515`, sidebar `#212021`, composer `#212121`
- `workbench.glass.main.css` dark glass:
  - `--glass-surface-background: rgba(0,0,0,.42)`
  - vibrancy mixes: sidebar/chrome `color-mix(... % transparent)`
  - **Not** the blue-gray fallbacks `#0c0e11 / #14171d`

| Role | Value | Use in Agent Pane |
|------|-------|-------------------|
| deep / window | `#0a0a0a` | `--bg-deep` |
| main stage | `#151515` | `--bg-editor` |
| soft vignette | `#1c1c1c` → deep | `--bg-glow` (low contrast) |
| sidebar frosted | `rgba(22,22,22,.78)` | `--bg-sidebar` + blur |
| elevated / composer | `#212121` / `rgba(33,33,33,.82)` | `--bg-elevated` / `--glass` |
| border | `rgba(255,255,255,.06/.10)` | `--glass-border*` |
| text | white @ 88% / 55% / 32% | `--text*` |

Web uses `backdrop-filter` to approximate macOS vibrancy; real `NSVisualEffect` is left for the Tauri shell.
