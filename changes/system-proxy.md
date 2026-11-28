### Added

- With no `HTTPS_PROXY` or `HTTP_PROXY` set, the CLI now uses the proxy from system settings: the Windows proxy settings (Group Policy, per-user or machine-wide, and the WinHTTP proxy), PAC files, automatic detection through WPAD (DHCP and DNS), the macOS proxy settings and GNOME's on Linux. `AIAND_PROXY_PAC` (a PAC URL, or `auto`) and a managed policy `proxyPac` setting name a PAC file on any system; `AIAND_SYSTEM_PROXY=0` turns this off.
- Proxy sign-in without a password prompt: NTLM and Negotiate (Kerberos) as the signed-in Windows user, and Negotiate with the Kerberos ticket on macOS and Linux, with tokens computed by the operating system's own curl. Basic, and NTLM away from Windows, use `AIAND_PROXY_USERNAME` and `AIAND_PROXY_PASSWORD`. No proxy credential is written to disk or printed.
- PAC files run in an isolated worker with only the PAC functions, a time limit per call and a memory cap.
- Coding agents opened with `aiand <agent>` go through the same proxy route, and `aiand <agent> on` says when an agent started on its own cannot. The IT administrator guide (English and Japanese) documents all of this, with a table of each agent's proxy support.
