/**
 * auth.ts
 *
 * Shared TeamDynamix authentication helpers for CLI scripts.
 * Centralises credential resolution and token acquisition so changes
 * to login behaviour only need to be made in one place.
 */

import { type AxiosInstance } from "axios";

export function getAuthMethod(): "admin" | "user" {
  const explicit = process.env.TEAMDYNAMIX_AUTH_METHOD?.toLowerCase();
  if (explicit === "user" || explicit === "admin") return explicit;
  if (process.env.TEAMDYNAMIX_BEID && process.env.TEAMDYNAMIX_WS_KEY) return "admin";
  if (process.env.TEAMDYNAMIX_USERNAME && process.env.TEAMDYNAMIX_PASSWORD) return "user";
  throw new Error(
    "No credentials found.\n" +
    "Set TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY  (admin service account)\n" +
    "  OR  TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD  (user login)\n" +
    "in your .env or environment."
  );
}

export async function authenticate(http: AxiosInstance, method: "admin" | "user"): Promise<string> {
  if (method === "admin") {
    const res = await http.post<string>("/auth/loginadmin", {
      BEID: process.env.TEAMDYNAMIX_BEID,
      WebServicesKey: process.env.TEAMDYNAMIX_WS_KEY,
    });
    return typeof res.data === "string" ? res.data.trim() : String(res.data);
  }
  const res = await http.post<string>("/auth/login", {
    username: process.env.TEAMDYNAMIX_USERNAME,
    password: process.env.TEAMDYNAMIX_PASSWORD,
  });
  return typeof res.data === "string" ? res.data.trim() : String(res.data);
}
