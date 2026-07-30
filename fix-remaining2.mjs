port { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";

// ── Bug #4: Add app_id to issue tool descriptions in issues.ts ──
{
  let c = readFileSync("src/tools/issues.ts", "utf8");
  const replacements = [
    {
      old: "  - project_ids (number[], optional): Restrict search to these projects",
      new: "  - app_id (number): The application ID\n  - project_ids (number[], optional): Restrict search to these projects",
    },
    {
      old: "  - project_id (number): The project ID\n  - issue_id (number): The issue ID\n  - response_format ('markdown' | 'json', default 'markdown')\n\nReturns: Full issue details.",
      new: "  - app_id (number): The application ID\n  - project_id (number): The project ID\n  - issue_id (number): The issue ID\n  - response_format ('markdown' | 'json', default 'markdown')\n\nReturns: Full issue details.",
    },
    {
      old: "  - project_id (number): The project to create the issue under",
      new: "  - app_id (number): The application ID\n  - project_id (number): The project to create the issue under",
    },
    {
      old: "  - project_id (number): The project ID\n  - issue_id (number): The issue ID to update",
      new: "  - app_id (number): The application ID\n  - project_id (number): The project ID\n  - issue_id (number): The issue ID to update",
    },
  ];
  for (const { old, new: replacement } of replacements) {
    if (!c.includes(old)) {
      console.error("ERROR: Could not find issue description target: " + old.slice(0, 60));
      process.exit(1);
    }
    c = c.replace(old, replacement);
  }
  writeFileSync("src/tools/issues.ts", c, "utf8");
  console.log("Fixed app_id in issue tool descriptions");
}

// ── Bug #5: Update CI workflow ──
{
  let c = readFileSync(".github/workflows/ci.yml", "utf8");
  const old = "      - run: npm run build";
  const replacement = "      - run: npm run build\n      - run: npm run check:scripts\n      - run: npm run test:mcp";
  if (!c.includes(old)) {
    console.error("ERROR: Could not find CI build step");
    process.exit(1);
  }
  c = c.replace(old, replacement);
  writeFileSync(".github/workflows/ci.yml", c, "utf8");
  console.log("Fixed CI workflow");
}

// ── Bug #6: Fix express and @types/express in package.json ──
{
  let c = readFileSync("package.json", "utf8");
  c = c.replace('"dotenv": "^17.2.3",', '"dotenv": "^17.2.3",\n    "express": "^5.2.1",');
  c = c.replace('"@types/express": "^4.17.21",', '"@types/express": "^5.0.0",\n    "@types/express-serve-static-core": "^5.1.0",');
  writeFileSync("package.json", c, "utf8");
  console.log("Fixed express dependencies in package.json");
}

// ── #7-9: Rate limiting, health endpoint, constant-time token comparison ──
{
  let c = readFileSync("src/index.ts", "utf8");

  // Add imports
  c = c.replace(
    'import cors from "cors";',
    'import { timingSafeEqual } from "node:crypto";\nimport rateLimit from "express-rate-limit";\nimport cors from "cors";'
  );

  // Add rate limiting before auth check
  const rateLimitCode = `  // Rate limit only for remote deployments (loopback is trusted locally)
  if (!isLoopback) {
    app.use(
      "/mcp",
      rateLimit({
        windowMs: 60_000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Rate limit exceeded. Please slow down." },
          id: null,
        },
      })
    );
  }

  if (authToken) {`;
  c = c.replace("  if (authToken) {", rateLimitCode);

  // Replace token check with constant-time comparison
  const oldAuth = `  if (authToken) {
    app.use("/mcp", (req, res, next) => {
      if (req.headers.authorization !== \`Bearer \${authToken}\`) {
        res.status(401).set("WWW-Authenticate", "Bearer").json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return;
      }
      next();
    });
  }`;
  const newAuth = `  if (authToken) {
    const expectedAuth = \`Bearer \${authToken}\`;
    const expectedBuf = Buffer.from(expectedAuth);
    app.use("/mcp", (req, res, next) => {
      const received = req.headers.authorization ?? "";
      const receivedBuf = Buffer.from(received);
      const isValid =
        receivedBuf.length === expectedBuf.length &&
        timingSafeEqual(receivedBuf, expectedBuf);
      if (!isValid) {
        res.status(401).set("WWW-Authenticate", "Bearer").json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return;
      }
      next();
    });
  }`;
  if (!c.includes(oldAuth)) {
    console.error("ERROR: Could not find auth token block in index.ts");
    process.exit(1);
  }
  c = c.replace(oldAuth, newAuth);

  // Add health endpoint
  const healthCode = `  // Health check endpoint for load balancers and orchestrators.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "teamdynamix-mcp-server" });
  });

  // MCP Streamable HTTP spec requires GET for SSE server-to-client streams.`;
  c = c.replace("  // MCP Streamable HTTP spec requires GET for SSE server-to-client streams.", healthCode);

  writeFileSync("src/index.ts", c, "utf8");
  console.log("Fixed rate limiting, health endpoint, and constant-time token comparison in index.ts");
}

// ── Clean up temp files ──
for (const f of ["fix-reports.mjs", "fix-remaining.mjs", "fix-remaining2.mjs"]) {
  try { unlinkSync(f); } catch {}
}

console.log("\nAll remaining fixes applied.");