import { ToolInputError } from "../framework/defineTool.js";

/**
 * TeamDynamix ticket status classes. TeamDynamix ignores an `IsOpen` field on ticket search, so
 * "open" and "closed" are expressed as status classes (`StatusClassIDs`).
 *
 * The numeric IDs below follow TeamDynamix's `StatusClass` enumeration. `npm run test:contract`
 * checks them against a live organization (open and closed result sets must be disjoint), so a
 * wrong value fails loudly instead of silently returning the wrong tickets.
 */
export const STATUS_CLASS_IDS = {
  new: 1,
  in_process: 2,
  completed: 3,
  cancelled: 4,
  on_hold: 5,
  requested: 6,
} as const;

export type StatusClassName = keyof typeof STATUS_CLASS_IDS;

export const STATUS_CLASS_NAMES = Object.keys(STATUS_CLASS_IDS) as [StatusClassName, ...StatusClassName[]];

/** Classes that count as open: work is expected. */
export const OPEN_CLASSES: readonly StatusClassName[] = ["new", "in_process", "on_hold", "requested"];

/** Classes that count as closed: no further work is expected. */
export const CLOSED_CLASSES: readonly StatusClassName[] = ["completed", "cancelled"];

export interface StatusClassArgs {
  is_open?: boolean;
  status_classes?: StatusClassName[];
}

/**
 * The `StatusClassIDs` to send, or undefined when the caller did not filter by class.
 * `is_open` is shorthand for a set of classes, so giving both is ambiguous and rejected.
 */
export function statusClassFilter(args: StatusClassArgs): number[] | undefined {
  if (args.is_open !== undefined && args.status_classes !== undefined) {
    throw new ToolInputError("Pass either is_open or status_classes, not both. is_open is shorthand for a set of status classes.");
  }
  const names =
    args.status_classes !== undefined ? args.status_classes : args.is_open === undefined ? undefined : args.is_open ? OPEN_CLASSES : CLOSED_CLASSES;
  if (names === undefined) return undefined;
  return [...new Set(names)].map((name) => STATUS_CLASS_IDS[name]);
}
