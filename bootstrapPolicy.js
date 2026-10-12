import crypto from 'node:crypto';

export const bootstrapContextHash=({firstName,lastName,email,password},secret)=>crypto
  .createHmac('sha256',secret)
  .update(JSON.stringify([
    String(firstName||'').trim(),
    String(lastName||'').trim(),
    String(email||'').trim().toLowerCase(),
    String(password||''),
  ]))
  .digest('hex');

export const maskedEmail=value=>{
  const [local,domain]=String(value||'').split('@');
  if(!local||!domain)return'';
  return `${local.slice(0,2)}${'*'.repeat(Math.max(3,local.length-2))}@${domain}`;
};
