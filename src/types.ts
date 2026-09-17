export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface PaginatedResult<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
  next_cursor?: string;
  /** True when `total` is a floor: TeamDynamix returned a full window, so more may exist. */
  total_is_lower_bound?: boolean;
}

/**
 * Opaque cursor bound to the search it came from. The signature prevents a
 * cursor being replayed against a different query or sort, which would silently
 * return rows from the wrong result set.
 */
export function encodeCursor(offset: number, signature: string): string {
  return Buffer.from(JSON.stringify({ o: offset, k: signature }), "utf8").toString("base64url");
}

export interface DecodedCursor {
  offset: number;
  signature: string;
}

export function decodeCursor(cursor: string): DecodedCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown; k?: unknown };
    if (typeof parsed.o !== "number" || !Number.isInteger(parsed.o) || parsed.o < 0) return undefined;
    if (typeof parsed.k !== "string" || parsed.k.length === 0) return undefined;
    return { offset: parsed.o, signature: parsed.k };
  } catch {
    return undefined;
  }
}

export interface PaginateOptions {
  signature?: string;
  totalIsLowerBound?: boolean;
}

export function paginate<T>(all: T[], limit: number, offset: number, options: PaginateOptions = {}): PaginatedResult<T> {
  const total = all.length;
  const page = all.slice(offset, offset + limit);
  const has_more = total > offset + page.length;
  const next_offset = offset + page.length;
  return {
    total,
    count: page.length,
    offset,
    items: page,
    has_more,
    ...(options.totalIsLowerBound ? { total_is_lower_bound: true } : {}),
    ...(has_more
      ? {
          next_offset,
          ...(options.signature ? { next_cursor: encodeCursor(next_offset, options.signature) } : {}),
        }
      : {}),
  };
}

/** TeamDynamix returns applications keyed by AppID, not ID, unlike other reference data. */
export interface TdApp {
  AppID: number;
  Name: string;
  Type: string;
  Active?: boolean;
  Description?: string;
  [key: string]: unknown;
}

// Minimal shapes for TeamDynamix entities. TeamDynamix returns many more fields;
// these interfaces cover the fields tools rely on. Callers using response_format=json
// get the raw API payload passed through, so no data is lost even though these
// interfaces are intentionally partial.
export interface TdTicket {
  ID: number;
  Title: string;
  TypeID?: number;
  Type?: string;
  StatusID?: number;
  StatusName?: string;
  PriorityID?: number;
  PriorityName?: string;
  AccountID?: number;
  AccountName?: string;
  ImpactID?: number;
  ImpactName?: string;
  UrgencyID?: number;
  UrgencyName?: string;
  ServiceID?: number;
  ServiceName?: string;
  ServiceOfferingID?: number;
  ServiceOfferingName?: string;
  RequestorUid?: string;
  RequestorName?: string;
  RequestorEmail?: string;
  ResponsibleFullName?: string;
  ResponsibleGroupName?: string;
  ReviewerUid?: string;
  ReviewerFullName?: string;
  ReviewingGroupID?: number;
  ReviewingGroupName?: string;
  SourceID?: number;
  SourceName?: string;
  StartDate?: string;
  EndDate?: string;
  LocationID?: number;
  LocationName?: string;
  LocationRoomID?: number;
  LocationRoomName?: string;
  CreatedDate?: string;
  ModifiedDate?: string;
  Description?: string;
  Uri?: string;
  [key: string]: unknown;
}

export interface TdAsset {
  ID: number;
  Name: string;
  Tag?: string;
  SerialNumber?: string;
  StatusID?: number;
  StatusName?: string;
  ProductModelName?: string;
  LocationName?: string;
  OwningCustomerName?: string;
  OwningDepartmentName?: string;
  [key: string]: unknown;
}

export interface TdProject {
  ID: number;
  Name: string;
  StatusID?: number;
  StatusName?: string;
  ProjectManagerName?: string;
  StartDate?: string;
  EndDate?: string;
  PercentComplete?: number;
  [key: string]: unknown;
}

export interface TdIssue {
  ID: number;
  ProjectID: number;
  Title: string;
  StatusID?: number;
  StatusName?: string;
  PriorityName?: string;
  [key: string]: unknown;
}

export interface TdPerson {
  UID: string;
  FullName: string;
  FirstName?: string;
  LastName?: string;
  PrimaryEmail?: string;
  AlertEmail?: string;
  IsActive?: boolean;
  TypeID?: number;
  [key: string]: unknown;
}

export interface TdGroup {
  ID: number;
  Name: string;
  Description?: string;
  IsActive?: boolean;
  [key: string]: unknown;
}

export interface TdFeedEntry {
  ID: string;
  Body?: string;
  CreatedDate?: string;
  CreatedByName?: string;
  [key: string]: unknown;
}

export interface TdCi {
  ID: number;
  Name: string;
  TypeID?: number;
  TypeName?: string;
  Tag?: string;
  SerialNumber?: string;
  StatusID?: number;
  StatusName?: string;
  ProductModelName?: string;
  LocationName?: string;
  OwningCustomerName?: string;
  OwningDepartmentName?: string;
  [key: string]: unknown;
}
