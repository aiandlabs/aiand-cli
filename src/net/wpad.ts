/**
 * Web Proxy Auto-Discovery: a PAC URL from DHCP (option 252) if the network
 * offered one, else `http://wpad.<suffix>/wpad.dat` for the first suffix of
 * the machine's DNS domain whose `wpad` host resolves, walking up one label
 * at a time as Windows does.
 */

/**
 * The DNS suffixes WPAD may look under, most specific first. Without a
 * public-suffix list, the walk stays conservative: under a two-letter
 * country TLD it stops at three labels (`corp.example.co.jp` and
 * `example.co.jp`, never `co.jp`, `kyoto.jp` or `example.jp`), and under
 * any other TLD at two (`corp.example.com`, `example.com`).
 */
export function wpadSuffixes(domains: string[]): string[] {
  const suffixes: string[] = [];
  for (const domain of domains) {
    const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
    const tld = labels.at(-1) ?? "";
    const floor = /^[a-z]{2}$/.test(tld) ? 3 : 2;
    for (let i = 0; labels.length - i >= floor; i++) suffixes.push(labels.slice(i).join("."));
  }
  return [...new Set(suffixes)];
}

/** `wpad.<suffix>` hosts to try, most specific first. */
export function wpadHosts(domains: string[]): string[] {
  return wpadSuffixes(domains).map((suffix) => `wpad.${suffix}`);
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
