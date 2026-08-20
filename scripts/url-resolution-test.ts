#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { getApiBaseUrl } from "../src/constants.js";

const cases = [
  ["https://example.teamdynamix.com", "https://example.teamdynamix.com/TDWebApi/api"],
  ["https://example.teamdynamix.com/", "https://example.teamdynamix.com/TDWebApi/api"],
  ["https://example.teamdynamix.com/TDWebApi", "https://example.teamdynamix.com/TDWebApi/api"],
  ["https://example.teamdynamix.com/TDWebApi/", "https://example.teamdynamix.com/TDWebApi/api"],
  ["https://sandbox.teamdynamix.com/SBTDWebApi", "https://sandbox.teamdynamix.com/SBTDWebApi/api"],
  ["https://sandbox.teamdynamix.com/SBTDWebApi/", "https://sandbox.teamdynamix.com/SBTDWebApi/api"],
  ["https://example.teamdynamix.com/TDWebApi/api", "https://example.teamdynamix.com/TDWebApi/api"],
  ["https://sandbox.teamdynamix.com/SBTDWebApi/api", "https://sandbox.teamdynamix.com/SBTDWebApi/api"],
] as const;

const original = process.env.TEAMDYNAMIX_BASE_URL;
try {
  for (const [input, expected] of cases) {
    process.env.TEAMDYNAMIX_BASE_URL = input;
    assert.equal(getApiBaseUrl(), expected, input);
  }
  console.log(`URL resolution passed (${cases.length} cases)`);
} finally {
  if (original === undefined) delete process.env.TEAMDYNAMIX_BASE_URL;
  else process.env.TEAMDYNAMIX_BASE_URL = original;
}
