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
}

export function paginate<T>(all: T[], limit: number, offset: number): PaginatedResult<T> {
  const total = all.length;
  const page = all.slice(offset, offset + limit);
  const has_more = total > offset + page.length;
  return {
    total,
    count: page.length,
    offset,
    items: page,
    has_more,
    ...(has_more ? { next_offset: offset + page.length } : {}),
  };
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
  RequestorName?: string;
  RequestorEmail?: string;
  ResponsibleFullName?: string;
  ResponsibleGroupName?: string;
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
