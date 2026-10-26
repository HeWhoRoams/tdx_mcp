// Maximum size (in characters) of a single tool response before it gets truncated.
export const CHARACTER_LIMIT = 25000;

// Default page size for list/search tools.
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

// TeamDynamix search endpoints have no offset parameter: they return the first
// N matches and we page client-side. Capping N keeps deep paging from forcing
// TD to serialize hundreds of full records to render a single page.
export const MAX_SEARCH_FETCH = 251;

// Once an agent pages, widen the window so later pages come from cache. Sized
// from measurement: search costs ~440 ms fixed plus ~1 ms per row, so ~100 rows
// is roughly one page's latency and covers several pages.
export const PAGING_WINDOW = 101;

export { getApiBaseUrl, resolveApiBaseUrl } from "./config.js";
