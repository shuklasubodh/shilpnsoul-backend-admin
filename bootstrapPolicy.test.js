import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapContextHash,maskedEmail} from './bootstrapPolicy.js';

test('bootstrap authorization is bound to every submitted administrator detail',()=>{
  const details={firstName:'Subodh',lastName:'Shukla',email:'subodhshukla@gmail.com',password:'a sufficiently long password'};
  const original=bootstrapContextHash(details,'test-secret');
  assert.notEqual(original,bootstrapContextHash({...details,lastName:'Other'},'test-secret'));
  assert.notEqual(original,bootstrapContextHash({...details,password:'another sufficiently long password'},'test-secret'));
});

test('bootstrap email hint does not expose the full local part',()=>{
  assert.equal(maskedEmail('subodhshukla@gmail.com'),'su**********@gmail.com');
});
