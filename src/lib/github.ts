const GITHUB = "https://github.com";

/**
 * Where on GitHub the owner of an installation picks which repositories the App may see: the installation's own
 * configuration page (a personal account's settings, or the organization's).
 */
export function installationConfigureUrl(i: { installationId: number; account: string; accountType: "User" | "Organization" | "Enterprise" }): string {
  return i.accountType === "User"
    ? `${GITHUB}/settings/installations/${i.installationId}`
    : `${GITHUB}/organizations/${encodeURIComponent(i.account)}/settings/installations/${i.installationId}`;
}

