import { z, type ZodType } from 'zod';

/** Convert a zod request schema to a JSON Schema object for OpenAPI docs. */
export function jsonSchema(schema: ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
