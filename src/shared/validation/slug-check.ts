const TASK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface SlugValidationResult {
  ok: boolean;
  message?: string;
}

export function validateTaskSlug(taskSlug: string): SlugValidationResult {
  if (!taskSlug.trim()) {
    return { ok: false, message: "Task slug is required." };
  }

  if (!TASK_SLUG_PATTERN.test(taskSlug)) {
    return {
      ok: false,
      message: "Use 3-64 lowercase letters, numbers, and hyphens. Start and end with a letter or number."
    };
  }

  if (taskSlug.includes("--")) {
    return { ok: false, message: "Task slug cannot contain consecutive hyphens." };
  }

  return { ok: true };
}

export function assertValidTaskSlug(taskSlug: string): void {
  const result = validateTaskSlug(taskSlug);
  if (!result.ok) {
    throw new Error(result.message);
  }
}
