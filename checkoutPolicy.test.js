import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationChannelsFor,returnDeadlineOpen,verificationChannelsFor,verificationMatches} from './checkoutPolicy.js';

test('email alone requires only email verification',()=>{
  assert.deepEqual(verificationChannelsFor({email:'guest@example.com'}),['EMAIL']);
});

test('every supplied optional contact requires verification',()=>{
  assert.deepEqual(verificationChannelsFor({email:'guest@example.com',phone:'+6590000000',whatsapp:'+6591111111'}),['EMAIL','SMS','WHATSAPP']);
});

test('email is always included and verified optional channels can be added',()=>{
  assert.deepEqual(notificationChannelsFor({requestedChannels:['SMS','WHATSAPP'],availableChannels:['EMAIL','SMS','WHATSAPP']}),['EMAIL','SMS','WHATSAPP']);
  assert.deepEqual(notificationChannelsFor({availableChannels:['EMAIL']}),['EMAIL']);
});

test('an unavailable optional notification channel is rejected',()=>{
  assert.throws(()=>notificationChannelsFor({requestedChannels:['SMS'],availableChannels:['EMAIL']}),/verified contact/);
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
