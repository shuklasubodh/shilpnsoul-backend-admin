import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNotificationChannel,returnDeadlineOpen,verificationMatches} from './checkoutPolicy.js';

test('guest email takes precedence when supplied',()=>{
  assert.equal(resolveNotificationChannel({customer:false,email:'guest@example.com',requestedChannel:'SMS'}),'EMAIL');
});

test('customer preference is honored instead of forcing email',()=>{
  assert.equal(resolveNotificationChannel({customer:true,email:'customer@example.com',preferredChannel:'WHATSAPP'}),'WHATSAPP');
});

test('OTP proof must match both selected channel and exact destination',()=>{
  const claims={type:'notification-verification',purpose:'CHECKOUT',channel:'EMAIL',destination:'one@example.com'};
  assert.equal(verificationMatches({claims,channel:'EMAIL',destination:'one@example.com'}),true);
  assert.equal(verificationMatches({claims,channel:'EMAIL',destination:'two@example.com'}),false);
  assert.equal(verificationMatches({claims,channel:'SMS',destination:'one@example.com'}),false);
});

test('return eligibility closes after the configured delivery window',()=>{
  const deliveredAt='2026-09-01T00:00:00.000Z';
  assert.equal(returnDeadlineOpen({deliveredAt,windowDays:2,now:Date.parse('2026-09-03T00:00:00.000Z')}),true);
  assert.equal(returnDeadlineOpen({deliveredAt,windowDays:2,now:Date.parse('2026-09-03T00:00:00.001Z')}),false);
});
