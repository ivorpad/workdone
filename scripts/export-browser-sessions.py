#!/usr/bin/env python3
"""Copy the Mac's signed-in sites into OVH's persistent browser.

Lists every site Chrome's Profile 2 holds a login for (chrome-canary-cdp sites), turns
the hosts into registrable domains, drops the ones that should never be reachable by an
agent, and hands the rest to ovh_session.py import in one go.

    scripts/export-browser-sessions.py                 # print the domains, copy nothing
    scripts/export-browser-sessions.py --run           # copy them to OVH
    scripts/export-browser-sessions.py --run --only linkedin.com,github.com

Google and YouTube do not survive the copy: Chrome binds Google's session to the Mac.
Sign in to those in that viewer. See the README.
"""

import argparse
import json
import os
import re
import subprocess
import sys

OVH_SESSION = os.path.expanduser(os.environ.get("OVH_SESSION", "~/src/tries/2026-08-19-agent-computer/deploy/ovh/ovh_session.py"))

# Never copied. The whole registrable domain goes, so amazon.com (it holds the AWS
# console's cookies) is here and amazon.es is not.
EXCLUDE = {
    # banks, brokers, payments, and the fraud-check services their logins use
    "bbva.es", "ing.es", "ingdirect.es", "wise.com", "trading212.com", "coinbase.com", "stripe.com", "polar.sh",
    "iesnare.com", "iovation.com", "cb-device-intelligence.com",
    # AWS
    "amazon.com", "aws", "signin.aws",
    # government ID and tax
    "policia.gob.es", "seniat.gob.ve", "citapreviadnie.es", "dnielectronico.es", "madrid.es",
    # employer SSO and HR
    "epam.com", "okta.com", "microsoftonline.com", "cloud.microsoft", "sharepoint.com", "live.com", "neoris.es", "neoris.net",
    # the account that owns the OVH server itself
    "ovh.com", "ovhcloud.com",
}
TWO_LEVEL = {"co.ve", "gob.es", "gob.ve", "com.ve", "co.uk", "com.au", "com.br"}


def registrable(host: str) -> str:
    parts = host.split(".")
    return ".".join(parts[-3:]) if ".".join(parts[-2:]) in TWO_LEVEL else ".".join(parts[-2:])


def local_only(host: str) -> bool:
    return bool(re.fullmatch(r"[\d.]+", host)) or host == "localhost" or host.endswith((".local", ".ts.net"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", action="store_true", help="copy to OVH; without it, only print the domains")
    ap.add_argument("--only", help="comma-separated domains to copy instead of every signed-in site")
    ap.add_argument("--profile", default="Profile 2", help="Chrome profile that holds the logins")
    args = ap.parse_args()

    if args.only:
        domains = [d.strip() for d in args.only.split(",") if d.strip()]
    else:
        sites = json.loads(subprocess.run(["chrome-canary-cdp", "sites", "--source", "chrome"], capture_output=True, text=True, check=True).stdout)
        domains = []
        for host in (s["host"] for s in sites["authenticated"]):
            d = registrable(host)
            if not local_only(host) and d not in EXCLUDE and d not in domains:
                domains.append(d)
    blocked = [d for d in domains if d in EXCLUDE]
    if blocked:
        print(f"refusing excluded domains: {', '.join(blocked)}", file=sys.stderr)
        return 2
    print(f"{len(domains)} domains: {' '.join(domains)}")
    if not args.run:
        return 0
    return subprocess.run(["python3", OVH_SESSION, "import", "--domains", ",".join(domains), "--chrome-profile", args.profile]).returncode


if __name__ == "__main__":
    sys.exit(main())
