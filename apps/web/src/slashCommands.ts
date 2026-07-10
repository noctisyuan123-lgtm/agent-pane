/** Grok agent shell builtins advertised via available_commands_update. */
export type SlashCommand = {
  name: string;
  description: string;
  /** Argument hint, if any */
  input?: string;
  /** Local UI handling — do not send to agent */
  local?: "new" | "plan" | "agent" | "auto" | "model";
};

/**
 * Built-ins that matter in Agent Pane (ACP session/prompt intercepts these
 * when the message starts with `/name`). Skills are merged at runtime.
 */
export const BUILTIN_SLASH: SlashCommand[] = [
  {
    name: "compact",
    description: "Compress conversation history to save context window",
    input: "optional context to preserve",
  },
  {
    name: "context",
    description: "Show context window usage and session stats",
  },
  {
    name: "usage",
    description: "View weekly credit usage / billing (Grok SuperGrok quota)",
  },
  {
    name: "billing",
    description: "Alias for /usage — weekly credits",
  },
  {
    name: "session-info",
    description: "Show session details (model, turns, context usage)",
  },
  {
    name: "always-approve",
    description: "Toggle always-approve mode (skip permission prompts)",
    input: "on|off",
  },
  {
    name: "model",
    description: "Switch model (or use the model picker in the bar)",
    input: "model id",
    local: "model",
  },
  {
    name: "plan",
    description: "Enter plan mode (no file edits)",
    input: "optional plan goal",
    local: "plan",
  },
  {
    name: "flush",
    description: "Flush conversation memory to disk now",
  },
  {
    name: "dream",
    description: "Run memory consolidation",
  },
  {
    name: "memory",
    description: "Browse or toggle memories",
    input: "on|off",
  },
  {
    name: "remember",
    description: "Save a note to memory immediately",
    input: "note text",
  },
  {
    name: "feedback",
    description: "Send feedback about the session",
    input: "feedback text",
  },
  {
    name: "loop",
    description: "Run a prompt on a recurring interval",
    input: "[interval] <prompt>",
  },
  {
    name: "goal",
    description: "Set or manage an autonomous goal",
    input: "<objective> | status | pause | resume | clear",
  },
  {
    name: "new",
    description: "Start a new agent session (local)",
    local: "new",
  },
  {
    name: "clear",
    description: "Start a new agent session (local alias)",
    local: "new",
  },
  {
    name: "agent",
    description: "Switch to Agent mode (always-approve tools)",
    local: "agent",
  },
  {
    name: "auto",
    description: "Switch to Auto mode (may ask before tools)",
    local: "auto",
  },
  {
    name: "help",
    description: "Grok docs — config, MCP, auth, skills, commands",
  },
];

export function parseSlashInput(text: string): {
  active: boolean;
  /** Token after `/` being typed (no space yet) */
  query: string;
  /** Full first token without leading / */
  cmd: string;
  /** Rest after first space */
  args: string;
} {
  const t = text;
  if (!t.startsWith("/")) {
    return { active: false, query: "", cmd: "", args: "" };
  }
  // only autocomplete when the caret is still on the first token
  const sp = t.indexOf(" ");
  const first = sp < 0 ? t.slice(1) : t.slice(1, sp);
  const args = sp < 0 ? "" : t.slice(sp + 1);
  return {
    active: sp < 0, // hide menu once user typed args
    query: first.toLowerCase(),
    cmd: first,
    args,
  };
}

export function filterSlashCommands(
  commands: SlashCommand[],
  query: string
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, 40);
  const scored = commands
    .map((c) => {
      const n = c.name.toLowerCase();
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80;
      else if (n.includes(q)) score = 50;
      else if (c.description.toLowerCase().includes(q)) score = 20;
      else return null;
      return { c, score };
    })
    .filter((x): x is { c: SlashCommand; score: number } => x != null)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.map((x) => x.c).slice(0, 40);
}
