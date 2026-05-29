export interface VcmErrorInput {
  code: string;
  message: string;
  statusCode?: number;
  hint?: string;
}

export class VcmError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly hint?: string;

  constructor(input: VcmErrorInput) {
    super(input.message);
    this.name = "VcmError";
    this.code = input.code;
    this.statusCode = input.statusCode ?? 400;
    this.hint = input.hint;
  }
}

export function toVcmError(error: unknown): VcmError {
  if (error instanceof VcmError) {
    return error;
  }

  if (error instanceof Error) {
    return new VcmError({
      code: "INTERNAL_ERROR",
      message: error.message,
      statusCode: 500
    });
  }

  return new VcmError({
    code: "INTERNAL_ERROR",
    message: "Unknown error",
    statusCode: 500
  });
}
