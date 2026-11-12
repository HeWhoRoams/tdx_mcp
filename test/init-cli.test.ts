import { describe, expect, it } from "vitest";
import { clientSnippets, renderEnvFile } from "../src/cli/init-cli.js";

describe("renderEnvFile", () => {
  it("writes SSO settings without secrets", () => {
    const text = renderEnvFile({ baseUrl: "https://x.teamdynamix.com", authMethod: "sso", expectedUser: "a@x.edu", defaultAppId: 49 });
    expect(text).toContain("TEAMDYNAMIX_AUTH_METHOD=sso");
    expect(text).toContain("TEAMDYNAMIX_SSO_EXPECTED_USER=a@x.edu");
    expect(text).toContain("TEAMDYNAMIX_DEFAULT_APP_ID=49");
    expect(text).not.toContain("WS_KEY");
  });
  it("omits blank optional values and includes the admin key only for admin auth", () => {
    expect(renderEnvFile({ baseUrl: "https://x", authMethod: "sso" })).not.toMatch(/EXPECTED_USER|DEFAULT_APP_ID/);
    expect(renderEnvFile({ baseUrl: "https://x", authMethod: "admin", beid: "b", wsKey: "k" })).toMatch(/BEID=b\nTEAMDYNAMIX_WS_KEY=k/);
  });
});

describe("clientSnippets", () => {
  it("covers the three clients and carries no secrets", () => {
    const snippets = clientSnippets();
    expect(Object.keys(snippets)).toEqual(["Claude Desktop", "Claude Code", "VS Code"]);
    for (const text of Object.values(snippets)) {
      expect(text).toContain("teamdynamix-mcp-server");
      expect(text).not.toMatch(/KEY|BEID|PASSWORD/);
    }
  });
});
