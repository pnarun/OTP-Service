import {
  buildCurlCommand,
  type PlaygroundEndpoint,
  type PlaygroundSection,
  type PlaygroundTab,
} from '@/lib/playground-config-core';

export type { PlaygroundEndpoint, PlaygroundSection, PlaygroundTab };
export { buildCurlCommand };

function jsonSample(value: object): string {
  return JSON.stringify(value, null, 2);
}

/** Placeholder values — replaced by saved credentials bar on send. */
const SAMPLE_APP_ID = 'ELVA_NOTIFY';
const SAMPLE_API_KEY = 'your-issued-api-key';
const SAMPLE_BRAND_ID = 'elva-sales';
const SAMPLE_BRAND_NAME = 'ELVA Sales';
const SAMPLE_PHONE = '919876543210';
const SAMPLE_EMAIL = 'user@example.com';

export const PLAYGROUND_TABS: PlaygroundTab[] = [
  {
    id: 'sms',
    label: 'SMS',
    sections: [
      {
        id: 'sms-otp',
        title: 'OTP APIs (SMS)',
        endpoints: [
          {
            id: 'sms-otp-send',
            method: 'POST',
            path: '/otp/send',
            title: 'POST /otp/send',
            description:
              'Generate a 6-digit OTP and send via DLT SMS. Requires approved brandId. SMS branding uses the registry brandName (e.g. ELVA Sales), not appId.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              phone: SAMPLE_PHONE,
            }),
          },
          {
            id: 'sms-otp-resend',
            method: 'POST',
            path: '/otp/resend',
            title: 'POST /otp/resend',
            description:
              'Revoke the previous OTP and send a new SMS. Wait 30 seconds after a successful send (cooldown).',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              phone: SAMPLE_PHONE,
            }),
          },
          {
            id: 'sms-otp-verify',
            method: 'POST',
            path: '/otp/verify',
            title: 'POST /otp/verify',
            description: 'Verify the OTP from SMS. Use the same brandId and phone as send.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              phone: SAMPLE_PHONE,
              otp: '123456',
            }),
          },
        ],
      },
      {
        id: 'sms-notify',
        title: 'Notify API (SMS)',
        endpoints: [
          {
            id: 'sms-notify-legacy',
            method: 'POST',
            path: '/notify',
            title: 'POST /notify (legacy SMS)',
            description: 'Send free-text SMS (Fast2SMS route q). Requires approved brandId for SMS.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              channel: 'SMS',
              to: [SAMPLE_PHONE],
              message: 'Test legacy SMS from ELVA Notify',
            }),
          },
          {
            id: 'sms-notify-template',
            method: 'POST',
            path: '/notify',
            title: 'POST /notify (DLT template)',
            description:
              'Send DLT templated transactional SMS. Use templateKey from GET /platform/businesses/:id/templates. businessName should match your approved brand display name.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              channel: 'SMS',
              to: [SAMPLE_PHONE],
              templateKey: 'ORDER_PLACED',
              variables: {
                customerName: 'Arun',
                businessName: SAMPLE_BRAND_NAME,
                orderId: 'ORD-2026-001',
              },
            }),
          },
        ],
      },
    ],
  },
  {
    id: 'email',
    label: 'EMAIL',
    sections: [
      {
        id: 'email-otp',
        title: 'OTP APIs (EMAIL)',
        endpoints: [
          {
            id: 'email-otp-send',
            method: 'POST',
            path: '/otp/send',
            title: 'POST /otp/send',
            description:
              'Generate an OTP and email it. Subject and body use registry brandName (e.g. "Your ELVA Sales OTP Code"). brandId is required.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              channel: 'EMAIL',
              email: SAMPLE_EMAIL,
            }),
          },
          {
            id: 'email-otp-resend',
            method: 'POST',
            path: '/otp/resend',
            title: 'POST /otp/resend',
            description: 'Resend OTP to the same email address.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              channel: 'EMAIL',
              email: SAMPLE_EMAIL,
            }),
          },
          {
            id: 'email-otp-verify',
            method: 'POST',
            path: '/otp/verify',
            title: 'POST /otp/verify',
            description: 'Verify the OTP from email. Use the same brandId and email as send.',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              channel: 'EMAIL',
              email: SAMPLE_EMAIL,
              otp: '123456',
            }),
          },
        ],
      },
      {
        id: 'email-notify',
        title: 'Notify API (EMAIL)',
        endpoints: [
          {
            id: 'email-notify-html',
            method: 'POST',
            path: '/notify',
            title: 'POST /notify (HTML)',
            description:
              'Send EMAIL with HTML body. Credentials from the fields above are merged into the request (appId, apiKey, brandId).',
            sampleJson: jsonSample({
              appId: SAMPLE_APP_ID,
              apiKey: SAMPLE_API_KEY,
              brandId: SAMPLE_BRAND_ID,
              channel: 'EMAIL',
              to: [SAMPLE_EMAIL],
              subject: 'ELVA Sales test',
              html: '<p>Hello from notify API</p>',
            }),
          },
        ],
      },
    ],
  },
];
