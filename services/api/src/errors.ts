import type { z } from "zod";

/** Thrown by handlers; rendered as { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please log in") => new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have access to this") => new ApiError(403, "FORBIDDEN", message);
export const notFound = (what = "Not found") => new ApiError(404, "NOT_FOUND", what);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new ApiError(422, code, message, details);

/** Validate a request part with zod; 400 VALIDATION with the issues on failure. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(
      400,
      "VALIDATION",
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}
