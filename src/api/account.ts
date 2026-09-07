import { requestJson, type Session } from "./client.js";

export type AccountUser = { id: string; email: string };
export type AccountOrg = { id: string; name: string };

export function getUser(session: Session): Promise<AccountUser> {
  return requestJson<AccountUser>(session, {
    path: "/api/user",
    baseUrl: session.profile.authUrl,
  });
}

export function listOrgs(session: Session): Promise<AccountOrg[]> {
  return requestJson<AccountOrg[]>(session, {
    path: "/api/orgs",
    baseUrl: session.profile.authUrl,
  });
}
