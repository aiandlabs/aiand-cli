/**
 * Web Proxy Auto-Discovery: a PAC URL from DHCP (option 252) if the network
 * offered one, else `http://wpad.<suffix>/wpad.dat` for the first suffix of
 * the machine's DNS domain whose `wpad` host resolves, walking up one label
 * at a time as Windows does.
 */

// Two-label suffixes that are registries, not organizations: a `wpad` host
// under one of these would be someone else's.
const PUBLIC_SECOND_LEVEL = /^(?:ac|co|com|edu|go|gov|lg|ne|net|or|org)\.[a-z]{2}$/;

/** `wpad.<suffix>` hosts to try, most specific first, never a bare TLD. */
export function wpadHosts(domains: string[]): string[] {
  const hosts: string[] = [];
  for (const domain of domains) {
    const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
    for (let i = 0; labels.length - i >= 2; i++) {
      const suffix = labels.slice(i).join(".");
      if (PUBLIC_SECOND_LEVEL.test(suffix)) break;
      hosts.push(`wpad.${suffix}`);
    }
  }
  return [...new Set(hosts)];
}

export type WpadSources = {
  dhcp: string[];
  domains: string[];
  /** Whether `host` resolves; WPAD treats a name that resolves as a candidate. */
  resolves(host: string): Promise<boolean>;
};

/**
 * The first WPAD PAC that loads, trying DHCP's URLs and then each `wpad`
 * host that resolves. Stops at the first success, so a working network pays
 * for one lookup.
 */
export async function discoverWpad(
  sources: WpadSources,
  load: (url: string) => Promise<string | null>,
): Promise<{ url: string; script: string } | null> {
  for (const url of sources.dhcp) {
    const script = await load(url).catch(() => null);
    if (script !== null) return { url, script };
  }
  for (const host of wpadHosts(sources.domains)) {
    if (!(await sources.resolves(host).catch(() => false))) continue;
    const url = `http://${host}/wpad.dat`;
    const script = await load(url).catch(() => null);
    if (script !== null) return { url, script };
  }
  return null;
}
