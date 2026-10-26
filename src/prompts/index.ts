import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Prompt templates that demonstrate the intended tool-composition workflow. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "triage_ticket",
    {
      title: "Triage a TeamDynamix ticket",
      description: "Summarize a ticket, its feed and tasks, then recommend a priority, assignee, and next action.",
      argsSchema: {
        app_id: z.string().describe("The ticketing application ID."),
        ticket_id: z.string().describe("The ticket ID to triage."),
      },
    },
    ({ app_id, ticket_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Triage TeamDynamix ticket ${ticket_id} in application ${app_id}.\n\n` +
              `1. Call teamdynamix_get_ticket for the full record.\n` +
              `2. Call teamdynamix_get_ticket_feed and teamdynamix_get_ticket_tasks for history and outstanding work.\n` +
              `3. Summarize the issue in three sentences.\n` +
              `4. Recommend a priority and assignee, citing the evidence you used.\n` +
              `5. Propose the single next action. Do not modify the ticket unless I confirm.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "weekly_ticket_report",
    {
      title: "Weekly ticket report",
      description: "Summarize the last week of ticket activity for an application.",
      argsSchema: {
        app_id: z.string().describe("The ticketing application ID."),
      },
    },
    ({ app_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Produce a weekly ticket report for TeamDynamix application ${app_id}.\n\n` +
              `1. Search tickets created in the last 7 days using created_date_from.\n` +
              `2. Search tickets still open, grouped by priority and assignee.\n` +
              `3. Prefer teamdynamix_get_report or teamdynamix_run_saved_search if a matching report exists.\n` +
              `4. Report volume, the priority mix, the oldest unresolved items, and anything needing attention.`,
          },
        },
      ],
    })
  );
}
