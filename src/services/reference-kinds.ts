/**
 * The reference lists a ticketing or asset application exposes, and where each lives. Shared by the
 * reference tools (which return them), the ticket-reference resource, and name resolution (which
 * turns "On Hold" into an ID). Each list is cached under its endpoint path, so all of them read the
 * same cache entry.
 */

export interface KindSpec {
  /** Path under the application, e.g. `tickets/statuses`. Also the cache key suffix, so error hints and warm-up keep working. */
  path: string;
  title: string;
}

export const TICKET_KINDS: Record<string, KindSpec> = {
  types: { path: "tickets/types", title: "Ticket Types" },
  statuses: { path: "tickets/statuses", title: "Ticket Statuses" },
  priorities: { path: "tickets/priorities", title: "Ticket Priorities" },
  sources: { path: "tickets/sources", title: "Ticket Sources" },
  forms: { path: "tickets/forms", title: "Ticket Forms" },
  impacts: { path: "tickets/impacts", title: "Ticket Impacts" },
  urgencies: { path: "tickets/urgencies", title: "Ticket Urgencies" },
};

export const ASSET_KINDS: Record<string, KindSpec> = {
  asset_statuses: { path: "assets/statuses", title: "Asset Statuses" },
  product_models: { path: "assets/models", title: "Product Models" },
  ci_types: { path: "cmdb/types", title: "CI Types" },
  ci_relationship_types: { path: "cmdb/relationshiptypes", title: "CI Relationship Types" },
};

export const REFERENCE_TABLES = { ticket: TICKET_KINDS, asset: ASSET_KINDS } as const;
export type ReferenceTable = keyof typeof REFERENCE_TABLES;

/** An argument that accepts a reference value by ID or by name, and which list the name is looked up in. */
export interface ReferenceSpec {
  table: ReferenceTable;
  kind: string;
}
