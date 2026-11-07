// Per-record errors inside a HubSpot batch response (CRM object batch update, property batch create).
// errors[] items are StandardError: status ("The HTTP status code associated with the error", a string), category,
// message, context (an object of string arrays; the key holding record ids, commonly `ids`, is NOT documented, so
// batchErrorFor looks in every context array).
//   https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/update-objects.md

export interface BatchError {
  status?: string;
  category?: string;
  message?: string;
  context?: Record<string, unknown>;
}

/** The batch error that names this record id (or property name) in its context, if any. */
export function batchErrorFor(errors: BatchError[], id: string): BatchError | undefined {
  return errors.find((e) =>
    Object.values(e.context ?? {}).some((v) => (Array.isArray(v) ? v.some((x) => String(x) === id) : String(v) === id)),
  );
}
