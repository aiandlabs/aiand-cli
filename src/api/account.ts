import { requestJson, type Session } from "./client.js";

/**
 * Account endpoints an API key can read: the identity behind the key and the
 * organizations it can act for. Key and organization management are not part of
 * this surface -- they are done in the console.
 */

export type AccountUser = { id: string; email: string };
export type AccountOrg = { id: string; name: string };

export function getUser(session: Session): Promise<AccountUser> {
  return requestJson<AccountUser>(session, {
    path: "/api/user",
    baseUrl: session.profile.authUrl,
  });
}

/** Organizations the user belongs to. The key's own org sorts first. */
export function listOrgs(session: Session): Promise<AccountOrg[]> {
  return requestJson<AccountOrg[]>(session, {
    path: "/api/orgs",
    baseUrl: session.profile.authUrl,
  });
}
