export type GatewayCommand =
  | { kind: "plain"; text: string }
  | { kind: "help" }
  | { kind: "start" }
  | { kind: "retry" }
  | { kind: "status" }
  | { kind: "projects" }
  | { kind: "use-project"; selector: string }
  | { kind: "pull-current" }
  | { kind: "tasks" }
  | { kind: "use-task"; selector: string }
  | { kind: "create-task"; taskSlug: string; title?: string }
  | { kind: "close-task" }
  | { kind: "close-task-confirm"; taskSlug: string }
  | { kind: "translate"; enabled: boolean }
  | { kind: "unknown"; name: string };

export function parseGatewayCommand(input: string): GatewayCommand {
  const text = input.trim();
  if (!text.startsWith("/")) {
    return { kind: "plain", text };
  }

  const [rawName = "", ...rest] = splitArgs(text);
  const name = rawName.toLowerCase();
  switch (name) {
    case "/help":
      return { kind: "help" };
    case "/start":
      return { kind: "start" };
    case "/retry":
      return { kind: "retry" };
    case "/status":
      return { kind: "status" };
    case "/projects":
      return { kind: "projects" };
    case "/use-project":
      return rest[0] ? { kind: "use-project", selector: rest.join(" ") } : { kind: "unknown", name };
    case "/pull-current":
      return { kind: "pull-current" };
    case "/tasks":
      return { kind: "tasks" };
    case "/use-task":
      return rest[0] ? { kind: "use-task", selector: rest[0] } : { kind: "unknown", name };
    case "/create-task": {
      const [taskSlug, ...titleParts] = rest;
      return taskSlug
        ? { kind: "create-task", taskSlug, title: titleParts.join(" ").trim() || undefined }
        : { kind: "unknown", name };
    }
    case "/close-task":
      if (rest[0]?.toLowerCase() === "confirm" && rest[1]) {
        return { kind: "close-task-confirm", taskSlug: rest[1] };
      }
      return { kind: "close-task" };
    case "/translate":
      if (rest[0]?.toLowerCase() === "on") {
        return { kind: "translate", enabled: true };
      }
      if (rest[0]?.toLowerCase() === "off") {
        return { kind: "translate", enabled: false };
      }
      return { kind: "unknown", name };
    default:
      return { kind: "unknown", name };
  }
}

function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    out.push(current);
  }
  return out;
}
