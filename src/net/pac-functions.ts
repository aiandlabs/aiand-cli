/**
 * The PAC API, as script source that runs inside the PAC's own context. It is
 * source rather than host functions on purpose: a host function handed to the
 * context would give the PAC a way back to the host's Function constructor.
 * `__aiand_dns`, `__aiand_ip` and `__aiand_now` are set by the prelude before
 * this runs. A lookup the table cannot answer records the host in
 * `__aiand_need` and throws; the evaluator resolves it outside and runs the
 * PAC again with a fresh context.
 *
 * Function bodies follow Mozilla's ascii_pac_utils.js and the Microsoft IPv6
 * extensions, which every corporate PAC is written against.
 */
export const PAC_FUNCTIONS = String.raw`
var __aiand_need = null;
delete globalThis.Atomics;
delete globalThis.SharedArrayBuffer;
delete globalThis.WebAssembly;
function __aiand_isIp(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s)); }
function __aiand_resolve(host) {
  host = String(host).toLowerCase();
  if (__aiand_isIp(host)) return host;
  if (Object.prototype.hasOwnProperty.call(__aiand_dns, host)) return __aiand_dns[host];
  if (__aiand_need === null) __aiand_need = host;
  throw new Error("PAC lookup pending");
}
function dnsResolve(host) { return __aiand_resolve(host); }
function dnsResolveEx(host) { var r = __aiand_resolve(host); return r === null ? "" : r; }
function isResolvable(host) { return __aiand_resolve(host) !== null; }
function isResolvableEx(host) { return __aiand_resolve(host) !== null; }
function myIpAddress() { return __aiand_ip; }
function myIpAddressEx() { return __aiand_ip; }
function getClientVersion() { return "1.0"; }
function sortIpAddressList(list) { return String(list); }
function alert() {}
function isPlainHostName(host) {
  host = String(host);
  return host.indexOf(".") === -1 && host.indexOf(":") === -1;
}
function dnsDomainIs(host, domain) {
  host = String(host).toLowerCase();
  domain = String(domain).toLowerCase();
  return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
}
function localHostOrDomainIs(host, hostdom) {
  host = String(host).toLowerCase();
  hostdom = String(hostdom).toLowerCase();
  return host === hostdom || hostdom.lastIndexOf(host + ".", 0) === 0;
}
function dnsDomainLevels(host) { return String(host).split(".").length - 1; }
function shExpMatch(url, pattern) {
  pattern = String(pattern).replace(/[.+^${"$"}{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + pattern + "$").test(String(url));
}
function convert_addr(ipchars) {
  var b = String(ipchars).split(".");
  return (((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff)) >>> 0;
}
function isInNet(ipaddr, pattern, maskstr) {
  ipaddr = String(ipaddr);
  if (!__aiand_isIp(ipaddr)) {
    ipaddr = __aiand_resolve(ipaddr);
    if (ipaddr === null) return false;
  }
  if (!__aiand_isIp(pattern) || !__aiand_isIp(maskstr)) return false;
  var mask = convert_addr(maskstr);
  return ((convert_addr(ipaddr) & mask) >>> 0) === ((convert_addr(pattern) & mask) >>> 0);
}
function isInNetEx(ipaddr, prefix) {
  var parts = String(prefix).split("/");
  if (parts.length !== 2 || !__aiand_isIp(parts[0])) return false;
  var bits = Number(parts[1]);
  if (!(bits >= 0 && bits <= 32)) return false;
  ipaddr = String(ipaddr);
  if (!__aiand_isIp(ipaddr)) {
    ipaddr = __aiand_resolve(ipaddr);
    if (ipaddr === null) return false;
  }
  var mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((convert_addr(ipaddr) & mask) >>> 0) === ((convert_addr(parts[0]) & mask) >>> 0);
}
var __aiand_days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
var __aiand_months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function __aiand_month(name) { return __aiand_months.indexOf(String(name).toUpperCase()); }
function __aiand_clock(gmt) {
  var d = new Date(__aiand_now);
  if (!gmt) return d;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
function weekdayRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = args[args.length - 1] === "GMT";
  if (gmt) args.pop();
  if (args.length < 1) return false;
  var today = __aiand_clock(gmt).getDay();
  var a = __aiand_days.indexOf(String(args[0]).toUpperCase());
  var b = args.length > 1 ? __aiand_days.indexOf(String(args[1]).toUpperCase()) : a;
  if (a < 0 || b < 0) return false;
  return a <= b ? today >= a && today <= b : today >= a || today <= b;
}
function dateRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = args[args.length - 1] === "GMT";
  if (gmt) args.pop();
  var argc = args.length;
  if (argc < 1) return false;
  var now = __aiand_clock(gmt);
  var tmp;
  if (argc === 1) {
    tmp = parseInt(args[0], 10);
    if (isNaN(tmp)) return now.getMonth() === __aiand_month(args[0]);
    if (tmp < 32) return now.getDate() === tmp;
    return now.getFullYear() === tmp;
  }
  var year = now.getFullYear();
  var date1 = new Date(year, 0, 1, 0, 0, 0);
  var date2 = new Date(year, 11, 31, 23, 59, 59);
  var adjustMonth = false;
  var half = argc >> 1;
  for (var i = 0; i < argc; i++) {
    var target = i < half ? date1 : date2;
    tmp = parseInt(args[i], 10);
    if (isNaN(tmp)) target.setMonth(__aiand_month(args[i]));
    else if (tmp < 32) {
      if (i < half) adjustMonth = argc <= 2;
      target.setDate(tmp);
    } else target.setFullYear(tmp);
  }
  if (adjustMonth) {
    date1.setMonth(now.getMonth());
    date2.setMonth(now.getMonth());
  }
  return date1 <= date2 ? date1 <= now && now <= date2 : date2 >= now || now >= date1;
}
function timeRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = args[args.length - 1] === "GMT";
  if (gmt) args.pop();
  var argc = args.length;
  if (argc < 1) return false;
  var now = __aiand_clock(gmt);
  if (argc === 1) return now.getHours() === Number(args[0]);
  if (argc === 2) return Number(args[0]) <= now.getHours() && now.getHours() <= Number(args[1]);
  var date1 = new Date(now.getTime());
  var date2 = new Date(now.getTime());
  if (argc === 6) {
    date1.setSeconds(args[2]);
    date2.setSeconds(args[5]);
  } else if (argc !== 4) {
    return false;
  }
  var middle = argc >> 1;
  date1.setHours(args[0]);
  date1.setMinutes(args[1]);
  date2.setHours(args[middle]);
  date2.setMinutes(args[middle + 1]);
  if (middle === 2) {
    date1.setSeconds(0);
    date2.setSeconds(59);
  }
  return date1 <= date2 ? date1 <= now && now <= date2 : date2 >= now || now >= date1;
}
`;
