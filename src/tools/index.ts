import type { AnyToolDefinition } from "../framework/defineTool.js";
import { assetTools } from "./assets.js";
import { authTools } from "./auth.js";
import { cmdbTools } from "./cmdb.js";
import { issueTools } from "./issues.js";
import { peopleTools } from "./people.js";
import { projectTools } from "./projects.js";
import { referenceTools } from "./reference.js";
import { reportTools } from "./reports.js";
import { ticketTools } from "./tickets.js";

/** Every tool the server can register, in the order they are advertised. */
export const allTools: AnyToolDefinition[] = [
  ...authTools,
  ...ticketTools,
  ...assetTools,
  ...cmdbTools,
  ...projectTools,
  ...issueTools,
  ...peopleTools,
  ...referenceTools,
  ...reportTools,
];
