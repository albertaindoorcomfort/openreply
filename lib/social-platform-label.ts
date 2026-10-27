// Display label for a connected account's platform. Accounts created before
// the platform column existed are Instagram.
export function socialPlatformLabel(platform?: string | null) {
  return platform === 'FACEBOOK' ? 'Facebook' : 'Instagram';
}
