import { parse, bool, str } from "../cli/args.js";
import { json, out, style, table } from "../cli/output.js";
import { openSession } from "../api/client.js";
import { listOrgs, type AccountOrg } from "../api/account.js";
import { resolveProfile } from "../config.js";

export const help = `${style.bold("aiand orgs")} -- list your organizations

Usage
  aiand orgs [options]

Options
  --json              machine-readable output

The CLI's key is scoped to one organization at login, so this list is read-only.
To work in a different org, change your default org in the console and run
\`aiand login --force\`.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (bool(parsed, "help")) return out(help);

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const orgs = await listOrgs(session);

  if (bool(parsed, "json")) {
    return json(orgs.map((org, i) => ({ ...org, active: i === 0 })));
  }

  if (orgs.length === 0) {
    out(style.dim("You do not belong to any organizations."));
    return;
  }

  table<AccountOrg & { index: number }>(
    orgs.map((org, index) => ({ ...org, index })),
    [
      { header: "", value: (o) => (o.index === 0 ? style.green("*") : " ") },
      { header: "name", value: (o) => o.name },
      { header: "id", value: (o) => style.dim(o.id) },
    ]
  );

  if (orgs.length > 1) {
    out();
    out(style.dim("* the org this CLI session is scoped to"));
  }
}
