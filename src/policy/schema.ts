import { z } from "zod";

/**
 * Domains group tools for policy rules. They match the files in src/tools and
 * are attached to every definition by `withDomain` in src/tools/index.ts.
 */
export const TOOL_DOMAINS = [
  "auth",
  "tickets",
  "assets",
  "cmdb",
  "projects",
  "issues",
  "people",
  "reference",
  "reports",
] as const;

export type ToolDomain = (typeof TOOL_DOMAINS)[number];

/** `inherit` defers to the domain rule, then to the capability default. */
export const RULES = ["allow", "deny", "inherit"] as const;

export type Rule = (typeof RULES)[number];

const RuleSchema = z.enum(RULES);

const CapabilityRulesSchema = z
  .object({
    read: RuleSchema.optional(),
    create: RuleSchema.optional(),
    edit: RuleSchema.optional(),
    destroy: RuleSchema.optional(),
  })
  .strict();

export type CapabilityRules = z.infer<typeof CapabilityRulesSchema>;

export const ToolPolicyFileSchema = z
  .object({
    $schema: z.string().optional(),
    defaults: CapabilityRulesSchema.optional(),
    domains: z.record(z.string(), CapabilityRulesSchema).optional(),
    tools: z.record(z.string(), RuleSchema).optional(),
    /**
     * Several TeamDynamix endpoints have no PATCH, so those tools GET the record
     * and PUT it back. A concurrent change is silently lost, which some hosts
     * consider destructive rather than an edit.
     */
    treatReadModifyWriteAsDestroy: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const domain of Object.keys(value.domains ?? {})) {
      if (!(TOOL_DOMAINS as readonly string[]).includes(domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["domains", domain],
          message: `unknown domain; expected one of ${TOOL_DOMAINS.join(", ")}`,
        });
      }
    }
  });

export type ToolPolicyFile = z.infer<typeof ToolPolicyFileSchema>;
