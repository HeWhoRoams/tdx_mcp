import { z } from "zod";
import { definePrompt, type PromptDefinition } from "../framework/definePrompt.js";

/**
 * Prompt templates that demonstrate the intended tool-composition workflow. Each lists the tools it
 * relies on in `uses`, so none is advertised on a server where those tools are not available.
 */
export const allPrompts: PromptDefinition[] = [
  definePrompt({
    name: "triage_ticket",
    title: "Triage a TeamDynamix ticket",
    description: "Summarize a ticket, its feed and tasks, then recommend a priority, assignee, and next action.",
    args: {
      app_id: z.string().describe("The ticketing application ID."),
      ticket_id: z.string().describe("The ticket ID to triage."),
    },
    uses: ["tdx_get_ticket", "tdx_get_ticket_feed", "tdx_get_ticket_tasks"],
    text: ({ app_id, ticket_id }) =>
      `Triage TeamDynamix ticket ${ticket_id} in application ${app_id}.\n\n` +
      `1. Call tdx_get_ticket for the full record.\n` +
      `2. Call tdx_get_ticket_feed and tdx_get_ticket_tasks for history and outstanding work.\n` +
      `3. Summarize the issue in three sentences.\n` +
      `4. Recommend a priority and assignee, citing the evidence you used.\n` +
      `5. Propose the single next action. Do not modify the ticket unless I confirm.`,
  }),
  definePrompt({
    name: "weekly_ticket_report",
    title: "Weekly ticket report",
    description: "Summarize the last week of ticket activity for an application.",
    args: {
      app_id: z.string().describe("The ticketing application ID."),
    },
    uses: ["tdx_search_tickets"],
    text: ({ app_id }) =>
      `Produce a weekly ticket report for TeamDynamix application ${app_id}.\n\n` +
      `1. Search tickets created in the last 7 days using created_date_from.\n` +
      `2. Search tickets still open, grouped by priority and assignee.\n` +
      `3. Prefer tdx_get_report or tdx_run_saved_search if a matching report exists.\n` +
      `4. Report volume, the priority mix, the oldest unresolved items, and anything needing attention.`,
  }),
];
