import type { GitHubRepository } from "../data";
import { isSetupMerged } from "../data/ci-rows";

/**
 * Where a repository stands in its setup, shared by Connect, its setup page, the Projects page and the sidebar
 * (founder, 28 Nov: each repository has its own setup page; those in setup show as "Setting up").
 */

/** On fenvix, or with its setup pull request open: not offered in "Pick a repository to connect". */
const CONNECTED_OR_OPEN = new Set(["pr_open", "side_by_side_pr_open", "merged", "already_fenvix", "side_by_side"]);
export const isConnectedOrOpen = (r: GitHubRepository) => CONNECTED_OR_OPEN.has(r.onboardingState) || !!r.projectId;

/** The setup pull request is open (moving the test job, or adding the side-by-side workflow). */
export const PR_OPEN = new Set(["pr_open", "side_by_side_pr_open"]);

/** States from which the App can open (or open again) the setup pull request. */
export const CAN_OPEN = new Set(["pending", "closed", "failed"]);

/** In setup: its setup pull request is open, or merged with its project not made yet. Linked to its setup page. */
export const isSettingUp = (r: GitHubRepository) => !r.removed && !r.excludedAt && !r.projectId && (PR_OPEN.has(r.onboardingState) || isSetupMerged(r.onboardingState));

/** The setup page of one repository. */
export const setupPath = (r: { repositoryId: number }) => `/projects/connect/${r.repositoryId}`;
