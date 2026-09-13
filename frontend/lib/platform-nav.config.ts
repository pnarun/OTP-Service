export interface PlatformNavItem {
  title: string;
  href: string;
}

export const PLATFORM_NAV_ITEMS: PlatformNavItem[] = [
  { title: 'Overview', href: '/platform' },
  { title: 'Businesses', href: '/platform/businesses' },
  { title: 'OTP Mappings', href: '/platform/otp' },
  { title: 'Approvals', href: '/platform/approvals' },
  { title: 'Notify monitoring', href: '/platform/notify' },
];
