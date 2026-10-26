/**
 * Capability tiers drive the tool policy (see src/policy). They follow
 * TeamDynamix's own vocabulary: posting to a record's feed is an *update* and is
 * purely additive, while writing a record's fields is an *edit*.
 */
export const CAPABILITIES = ["read", "create", "edit", "destroy"] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface ToolAnnotations {
  /** Policy tier. Stripped before the annotations are handed to the MCP client. */
  capability: Capability;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Changes nothing in TeamDynamix. */
export const READ: ToolAnnotations = {
  capability: "read",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Adds new data — a record, a feed entry, a task, a link. Nothing existing is overwritten. */
export const CREATE: ToolAnnotations = {
  capability: "create",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Overwrites fields on an existing record. */
export const EDIT: ToolAnnotations = {
  capability: "edit",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Deletes or unlinks existing data. */
export const DESTROY: ToolAnnotations = {
  capability: "destroy",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** The MCP spec has no `capability` annotation, so it is dropped on registration. */
export function clientAnnotations(annotations: ToolAnnotations): Omit<ToolAnnotations, "capability"> {
  const { capability: _capability, ...hints } = annotations;
  return hints;
}
