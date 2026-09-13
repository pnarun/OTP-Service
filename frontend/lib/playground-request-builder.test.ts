/**
 * Unit tests for playground request builder (form fields → request payload).
 * Run: node --experimental-strip-types --test lib/playground-request-builder.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlaygroundRequestBody,
  mergePlaygroundCredentials,
} from './playground-request-builder.ts';
import { buildCurlCommand } from './playground-config-core.ts';

const CREDENTIALS = {
  appId: 'demo1-8e4db130',
  apiKey: 'test-api-key-value',
  brandId: 'demo1',
};

describe('playground EMAIL /notify request builder', () => {
  const sampleBody = JSON.stringify({
    appId: 'ELVA_NOTIFY',
    apiKey: 'your-issued-api-key',
    channel: 'EMAIL',
    to: ['user@example.com'],
    subject: 'ELVA Sales test',
    html: '<p>Hello from notify API</p>',
  }, null, 2);

  it('1–7. form credentials and content fields generate correct EMAIL payload with brandId', () => {
    const payload = buildPlaygroundRequestBody(sampleBody, CREDENTIALS, '/notify');
    const parsed = JSON.parse(payload);

    assert.equal(parsed.appId, 'demo1-8e4db130');
    assert.equal(parsed.apiKey, 'test-api-key-value');
    assert.equal(parsed.brandId, 'demo1');
    assert.equal(parsed.channel, 'EMAIL');
    assert.deepEqual(parsed.to, ['user@example.com']);
    assert.equal(parsed.subject, 'ELVA Sales test');
    assert.equal(parsed.html, '<p>Hello from notify API</p>');
  });

  it('8. Copy JSON uses current form state (including brandId)', () => {
    const json = buildPlaygroundRequestBody(sampleBody, CREDENTIALS, '/notify');
    assert.match(json, /"brandId": "demo1"/);
    assert.match(json, /"appId": "demo1-8e4db130"/);
    assert.match(json, /"apiKey": "test-api-key-value"/);
  });

  it('9. Copy cURL uses current form state (including brandId)', () => {
    const json = buildPlaygroundRequestBody(sampleBody, CREDENTIALS, '/notify');
    const curl = buildCurlCommand('http://localhost:4000', '/notify', json);
    assert.match(curl, /"brandId":"demo1"/);
    assert.match(curl, /"appId":"demo1-8e4db130"/);
    assert.match(curl, /"apiKey":"test-api-key-value"/);
    assert.match(curl, /"channel":"EMAIL"/);
  });

  it('10–11. Send request body is derived from form state; stale JSON credentials are overwritten', () => {
    const stale = JSON.stringify({
      appId: 'STALE_APP',
      apiKey: 'STALE_KEY',
      brandId: 'stale-brand',
      channel: 'EMAIL',
      to: ['fresh@example.com'],
      subject: 'Updated subject',
      html: '<p>Updated</p>',
    });
    const sent = buildPlaygroundRequestBody(stale, CREDENTIALS, '/notify');
    const parsed = JSON.parse(sent);
    assert.equal(parsed.appId, CREDENTIALS.appId);
    assert.equal(parsed.apiKey, CREDENTIALS.apiKey);
    assert.equal(parsed.brandId, CREDENTIALS.brandId);
    assert.deepEqual(parsed.to, ['fresh@example.com']);
    assert.equal(parsed.subject, 'Updated subject');
    assert.equal(parsed.html, '<p>Updated</p>');
  });

  it('field changes immediately reflect in generated JSON', () => {
    let body = sampleBody;
    let credentials = { ...CREDENTIALS };

    credentials = { ...credentials, appId: 'new-app-id' };
    assert.equal(JSON.parse(buildPlaygroundRequestBody(body, credentials, '/notify')).appId, 'new-app-id');

    credentials = { ...credentials, apiKey: 'new-api-key' };
    assert.equal(JSON.parse(buildPlaygroundRequestBody(body, credentials, '/notify')).apiKey, 'new-api-key');

    credentials = { ...credentials, brandId: 'other-brand' };
    assert.equal(JSON.parse(buildPlaygroundRequestBody(body, credentials, '/notify')).brandId, 'other-brand');

    body = JSON.stringify({
      ...JSON.parse(body),
      to: ['changed@example.com'],
      subject: 'Changed subject',
      html: '<p>Changed</p>',
    });
    const parsed = JSON.parse(buildPlaygroundRequestBody(body, credentials, '/notify'));
    assert.deepEqual(parsed.to, ['changed@example.com']);
    assert.equal(parsed.subject, 'Changed subject');
    assert.equal(parsed.html, '<p>Changed</p>');
    assert.equal(parsed.brandId, 'other-brand');
  });
});

describe('playground SMS request builder compatibility', () => {
  it('12. SMS /notify still merges brandId and credentials from form fields', () => {
    const smsBody = JSON.stringify({
      appId: 'ELVA_NOTIFY',
      apiKey: 'placeholder',
      channel: 'SMS',
      to: ['919876543210'],
      templateKey: 'ORDER_PLACED',
      variables: { customerName: 'Arun', businessName: 'Demo', orderId: '1' },
    });
    const payload = mergePlaygroundCredentials(smsBody, CREDENTIALS, '/notify');
    const parsed = JSON.parse(payload);
    assert.equal(parsed.appId, CREDENTIALS.appId);
    assert.equal(parsed.apiKey, CREDENTIALS.apiKey);
    assert.equal(parsed.brandId, CREDENTIALS.brandId);
    assert.equal(parsed.channel, 'SMS');
    assert.equal(parsed.templateKey, 'ORDER_PLACED');
  });

  it('12b. SMS /otp/send still merges brandId from form fields', () => {
    const otpBody = JSON.stringify({
      appId: 'ELVA_NOTIFY',
      apiKey: 'placeholder',
      phone: '919876543210',
    });
    const payload = mergePlaygroundCredentials(otpBody, CREDENTIALS, '/otp/send');
    const parsed = JSON.parse(payload);
    assert.equal(parsed.brandId, 'demo1');
    assert.equal(parsed.phone, '919876543210');
  });
});
