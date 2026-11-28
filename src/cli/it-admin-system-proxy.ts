import { PROXY_SUPPORT, type ProxySupport, type Support } from "../agents/proxy-support.js";
import { AGENTS } from "../agents/registry.js";
import { PROXY_PASSWORD_VAR, PROXY_USER_VAR } from "../net/system-bridge.js";
import { PAC_SETTING, SYSTEM_PROXY_SWITCH } from "../net/system-proxy.js";
import {
  LINUX_POLICY_PATH,
  MACOS_POLICY_PATH,
  WINDOWS_MACHINE_POLICY_KEY,
  WINDOWS_USER_POLICY_KEY,
} from "../policy.js";

type Locale = "en" | "ja";

const POLICY_PLACES = `\`${LINUX_POLICY_PATH}\`, \`${MACOS_POLICY_PATH}\`, \`${WINDOWS_MACHINE_POLICY_KEY}\` / \`${WINDOWS_USER_POLICY_KEY}\` (REG_SZ)`;
const CREDENTIALS = `\`${PROXY_USER_VAR}\` / \`${PROXY_PASSWORD_VAR}\``;

const copy = {
  en: {
    heading: "Proxy settings from the operating system",
    intro:
      "When none of the proxy variables above is set, `aiand` uses the proxy that the operating system or an administrator configures, taking the first of these that is present:",
    orderHeading: "Order",
    settingHeading: "Setting",
    whereHeading: "Where aiand reads it",
    rows: [
      ["Managed policy `proxyPac`: a PAC URL, or `auto` for WPAD", POLICY_PLACES],
      [`\`${PAC_SETTING}\`: a PAC URL, or \`auto\` for WPAD`, "The environment"],
      [
        "Windows proxy settings: automatic detection (WPAD), the automatic configuration script, then the proxy server and its exceptions",
        "Group Policy (`Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings`) over the per-user Internet Settings, or the machine-wide ones when `ProxySettingsPerUser` is 0; then the WinHTTP proxy (`netsh winhttp set proxy`)",
      ],
      [
        "macOS proxy settings: auto proxy discovery, the automatic proxy configuration URL, the HTTP and HTTPS proxies and their exceptions",
        "`scutil --proxy`, the active network service's settings",
      ],
      [
        "Linux desktop proxy settings (GNOME): automatic, a configuration URL, or manual",
        "`gsettings list-recursively org.gnome.system.proxy`, when a desktop session is running. On other desktops, set `proxyPac` or `AIAND_PROXY_PAC`",
      ],
    ],
    wpad: "Automatic detection (WPAD) tries a PAC URL offered by DHCP (option 252, on Windows), then `http://wpad.<suffix>/wpad.dat` for each suffix of the machine's DNS domain and search list, most specific first. It never looks above a two-label suffix, nor at a registry suffix such as `co.jp`.",
    pac: "`aiand` fetches the PAC file directly, never through a proxy, up to 1 MB. It runs the PAC in an isolated worker with a 64 MB memory cap, in a context that holds only the standard PAC functions (including Microsoft's `Ex` functions): no files, network, processes, timers or module loading, no code generation from strings, and one second per call. `PROXY`, `HTTP` and `DIRECT` entries are tried in order; `SOCKS` and `HTTPS` entries are skipped. When the PAC cannot be loaded or fails, the fixed proxy applies, as on Windows.",
    bridge:
      "When the settings send anything through a proxy, `aiand` starts a bridge on `127.0.0.1` that lives only as long as that `aiand` command, and relaunches itself with `HTTPS_PROXY` and `HTTP_PROXY` pointing at it. The bridge chooses a route for each connection from the PAC (or from the fixed proxy and its exceptions; loopback always goes direct), opens a CONNECT tunnel through the corporate proxy, and signs in to it. It does not decrypt TLS. Its URL carries a random password, so other users of the same machine cannot use it. Coding agents opened with `aiand <agent>` inherit the same variables, so their requests take the same route. On a network where none of the settings applies, `aiand` reads the settings and does nothing else.",
    signInHeading: "Proxy sign-in",
    schemeHeading: "Scheme",
    signIn: [
      [
        "Negotiate (Kerberos)",
        "The signed-in Windows user, through SSPI",
        "A Kerberos ticket (the Kerberos SSO extension or `kinit`), through GSS-API",
        "A Kerberos ticket from `kinit`, through GSS-API",
      ],
      [
        "NTLM",
        "The signed-in Windows user, through SSPI",
        `Only with ${CREDENTIALS}`,
        `Only with ${CREDENTIALS}`,
      ],
      ["Basic", `With ${CREDENTIALS}`, `With ${CREDENTIALS}`, `With ${CREDENTIALS}`],
    ],
    tokens:
      "Node.js cannot call SSPI or GSS-API, so `aiand` has the operating system's own curl compute each Negotiate and NTLM token: `%SystemRoot%\\System32\\curl.exe`, which ships with Windows 10 1803 and later, or `/usr/bin/curl`. That curl connects only to a listener of `aiand`'s on loopback, and `aiand` relays each token to the proxy on its own connection. Nobody types a password, and no proxy credential is written to disk or printed. Because curl.exe is a Microsoft-signed part of Windows, the default AppLocker rules allow it, and PowerShell's Constrained Language Mode does not affect it. Nothing is installed and no administrator rights are needed. On Linux, curl must be built with GSS-API (`curl -V` lists `GSS-API` and `SPNEGO`).",
    controls: `\`${SYSTEM_PROXY_SWITCH}=0\` turns all of this off. \`AIAND_DEBUG=1\` prints where the settings came from and the route chosen for each connection. When a command fails because the proxy could not be reached or refused the sign-in, \`aiand\` prints the reason, such as the schemes the proxy offered, after the command ends.`,
    agentsHeading: "Coding agents behind the proxy",
    agentsIntro:
      "**Opened with aiand** means the agent started by `aiand <agent>` (or the launcher): it inherits `HTTPS_PROXY`, `HTTP_PROXY` and `NODE_USE_ENV_PROXY=1` pointing at the bridge, so PAC, WPAD and sign-in are handled by `aiand`. The other columns describe the agent started on its own after `aiand <agent> on`, which is when the agent's own support matters; on a network that needs PAC, WPAD or sign-in, `aiand <agent> on` says so. They follow each agent's runtime and documentation, and \"Unverified\" entries await the enterprise test network.",
    columns: [
      "Agent",
      "Runtime",
      "Opened with aiand",
      "`HTTPS_PROXY`",
      "`user:password@` in the proxy URL",
      "System proxy",
      "PAC / WPAD",
      "NTLM / Kerberos",
    ],
    values: {
      yes: "Yes",
      no: "No",
      "node-flag": "With `NODE_USE_ENV_PROXY=1`",
      unverified: "Unverified",
    },
  },
  ja: {
    heading: "オペレーティングシステムのプロキシ設定",
    intro:
      "上記のプロキシ変数がどれも設定されていない場合、`aiand` はオペレーティングシステムまたは管理者が設定したプロキシを使用します。次の順に調べ、最初に見つかった設定を使います。",
    orderHeading: "順序",
    settingHeading: "設定",
    whereHeading: "aiand の読み取り元",
    rows: [
      ["管理ポリシーの `proxyPac`: PAC の URL、または WPAD を使う `auto`", POLICY_PLACES],
      [`\`${PAC_SETTING}\`: PAC の URL、または WPAD を使う \`auto\``, "環境変数"],
      [
        "Windows のプロキシ設定: 設定を自動的に検出する (WPAD)、自動構成スクリプト、プロキシサーバーとその例外の順",
        "グループポリシー (`Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings`) をユーザーごとのインターネット設定より優先します。`ProxySettingsPerUser` が 0 の場合はコンピューター全体の設定を使います。その次に WinHTTP のプロキシ (`netsh winhttp set proxy`)",
      ],
      [
        "macOS のプロキシ設定: プロキシの自動検出、自動プロキシ構成の URL、HTTP / HTTPS プロキシとその例外",
        "`scutil --proxy` (使用中のネットワークサービスの設定)",
      ],
      [
        "Linux デスクトップのプロキシ設定 (GNOME): 自動、構成 URL、または手動",
        "デスクトップセッションが動作している場合の `gsettings list-recursively org.gnome.system.proxy`。その他のデスクトップでは `proxyPac` または `AIAND_PROXY_PAC` を設定してください",
      ],
    ],
    wpad: "自動検出 (WPAD) では、まず DHCP が提供する PAC の URL (Windows のオプション 252) を試し、次にマシンの DNS ドメインと検索リストの各サフィックスについて、より具体的なものから順に `http://wpad.<サフィックス>/wpad.dat` を試します。2 ラベルより上のサフィックスや、`co.jp` のような登録用サフィックスは調べません。",
    pac: "`aiand` は PAC ファイルをプロキシを経由せず直接、最大 1 MB まで取得します。PAC は、メモリ上限 64 MB の独立したワーカー内で、標準の PAC 関数 (Microsoft の `Ex` 関数を含む) だけを持つコンテキストで実行されます。ファイル、ネットワーク、プロセス、タイマー、モジュールの読み込みは使えず、文字列からのコード生成もできず、1 回の呼び出しは 1 秒までです。`PROXY`、`HTTP`、`DIRECT` のエントリを順に試し、`SOCKS` と `HTTPS` のエントリは飛ばします。PAC を読み込めないか失敗した場合は、Windows と同じく固定のプロキシ設定を使います。",
    bridge:
      "設定によっていずれかの通信がプロキシを経由する場合、`aiand` はその `aiand` コマンドの実行中だけ `127.0.0.1` 上でブリッジを起動し、`HTTPS_PROXY` と `HTTP_PROXY` をそのブリッジに向けて自身を再起動します。ブリッジは接続ごとに PAC (または固定のプロキシとその例外。ループバックは常に直接接続) から経路を選び、企業プロキシを通る CONNECT トンネルを開いて、プロキシにサインインします。TLS は復号しません。ブリッジの URL にはランダムなパスワードが含まれるため、同じマシンの他のユーザーは使用できません。`aiand <agent>` で開いたコーディングエージェントも同じ変数を継承するため、その通信も同じ経路を通ります。どの設定も当てはまらないネットワークでは、`aiand` は設定を読み取るだけで、それ以外は何もしません。",
    signInHeading: "プロキシへのサインイン",
    schemeHeading: "方式",
    signIn: [
      [
        "Negotiate (Kerberos)",
        "サインイン中の Windows ユーザー (SSPI 経由)",
        "Kerberos チケット (Kerberos SSO 拡張機能または `kinit`、GSS-API 経由)",
        "`kinit` で取得した Kerberos チケット (GSS-API 経由)",
      ],
      [
        "NTLM",
        "サインイン中の Windows ユーザー (SSPI 経由)",
        `${CREDENTIALS} を設定した場合のみ`,
        `${CREDENTIALS} を設定した場合のみ`,
      ],
      [
        "Basic",
        `${CREDENTIALS} を設定した場合`,
        `${CREDENTIALS} を設定した場合`,
        `${CREDENTIALS} を設定した場合`,
      ],
    ],
    tokens:
      "Node.js からは SSPI や GSS-API を呼び出せないため、`aiand` は Negotiate と NTLM のトークンをオペレーティングシステム標準の curl に計算させます。Windows 10 1803 以降に含まれる `%SystemRoot%\\System32\\curl.exe`、または `/usr/bin/curl` です。この curl はループバック上の `aiand` のリスナーにだけ接続し、`aiand` が各トークンを自身の接続でプロキシに中継します。パスワードを入力する必要はなく、プロキシの認証情報がディスクに書き込まれたり表示されたりすることもありません。curl.exe は Microsoft が署名した Windows の一部なので、AppLocker の既定の規則で許可され、PowerShell の制約付き言語モードの影響も受けません。インストールも管理者権限も不要です。Linux の curl は GSS-API 付きでビルドされている必要があります (`curl -V` に `GSS-API` と `SPNEGO` が表示されること)。",
    controls: `\`${SYSTEM_PROXY_SWITCH}=0\` を設定すると、この仕組み全体が無効になります。\`AIAND_DEBUG=1\` を設定すると、設定の読み取り元と、接続ごとに選んだ経路が表示されます。プロキシに到達できない、またはサインインが拒否されたためにコマンドが失敗した場合、\`aiand\` はコマンドの終了後に、プロキシが提示した方式などの理由を表示します。`,
    agentsHeading: "プロキシの内側でのコーディングエージェント",
    agentsIntro:
      "**aiand から開く** とは、`aiand <agent>` (またはランチャー) でエージェントを起動することです。エージェントはブリッジを指す `HTTPS_PROXY`、`HTTP_PROXY`、`NODE_USE_ENV_PROXY=1` を継承するため、PAC、WPAD、サインインは `aiand` が処理します。その他の列は、`aiand <agent> on` の後にエージェントを単独で起動した場合で、このときはエージェント自身の対応状況が問題になります。PAC、WPAD、サインインが必要なネットワークでは、`aiand <agent> on` がその旨を表示します。各列はエージェントのランタイムとドキュメントに基づいており、「未検証」の項目はエンタープライズ検証ネットワークでの確認を待っています。",
    columns: [
      "エージェント",
      "ランタイム",
      "aiand から開く",
      "`HTTPS_PROXY`",
      "プロキシ URL の `user:password@`",
      "システムのプロキシ",
      "PAC / WPAD",
      "NTLM / Kerberos",
    ],
    values: {
      yes: "はい",
      no: "いいえ",
      "node-flag": "`NODE_USE_ENV_PROXY=1` が必要",
      unverified: "未検証",
    },
  },
} satisfies Record<Locale, unknown>;

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Each registered agent's proxy support, one row per agent, from PROXY_SUPPORT. */
function renderAgentProxyTable(locale: Locale): string {
  const text = copy[locale];
  const cell = (value: Support): string => text.values[value];
  const keys: (keyof Omit<ProxySupport, "runtime">)[] = [
    "viaAiand",
    "envProxy",
    "basicInUrl",
    "systemProxy",
    "pac",
    "signIn",
  ];
  const rows = AGENTS.map((adapter) => {
    const support = PROXY_SUPPORT[adapter.id];
    if (!support) throw new Error(`No proxy support recorded for ${adapter.id}.`);
    return row([
      `${adapter.label} (\`${adapter.id}\`)`,
      support.runtime,
      ...keys.map((k) => cell(support[k])),
    ]);
  });
  return [row(text.columns), row(text.columns.map(() => "---")), ...rows].join("\n");
}

export function renderSystemProxySection(locale: Locale): string {
  const text = copy[locale];
  const order = [
    row([text.orderHeading, text.settingHeading, text.whereHeading]),
    row(["---", "---", "---"]),
    ...text.rows.map(([setting, where], index) => row([String(index + 1), setting!, where!])),
  ].join("\n");
  const signIn = [
    row([text.schemeHeading, "Windows", "macOS", "Linux"]),
    row(["---", "---", "---", "---"]),
    ...text.signIn.map((cells) => row(cells)),
  ].join("\n");
  return [
    `## ${text.heading}`,
    text.intro,
    order,
    text.wpad,
    text.pac,
    text.bridge,
    `### ${text.signInHeading}`,
    signIn,
    text.tokens,
    text.controls,
    `## ${text.agentsHeading}`,
    text.agentsIntro,
    renderAgentProxyTable(locale),
  ].join("\n\n");
}
