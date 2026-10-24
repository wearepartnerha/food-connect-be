import type { Context } from "hono";
import { z } from "zod";

/** An error whose message is safe to show the client, with the HTTP status to send it with. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);

/** Parses the JSON request body against a schema; invalid input becomes a 400. */
export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  return parse(schema, raw);
}

/** Parses the query string against a schema; invalid input becomes a 400. */
export function query<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  return parse(schema, c.req.query());
}

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(
      issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input.",
    );
  }
  return result.data;
}
