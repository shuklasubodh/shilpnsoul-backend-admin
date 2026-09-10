export const userColumns='id,first_name,last_name,email,country_code,phone,whatsapp_number,role,is_active,email_verified_at,phone_verified_at,whatsapp_verified_at,preferred_notification_channel,return_window_days,created_at,updated_at';
export const isId=value=>/^\d+$/.test(String(value))&&Number(value)>0;
export const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeCountryCode=value=>{const digits=String(value||'').replace(/\D/g,'');return /^[1-9]\d{0,3}$/.test(digits)?`+${digits}`:''};
export const phoneWithCountryCode=(countryCode,value)=>{const code=normalizeCountryCode(countryCode),raw=String(value||'').trim();if(!code||!raw)return'';if(raw.startsWith('+'))return raw.startsWith(code)&&/^\+[1-9]\d{6,14}$/.test(raw)?raw:'';const local=raw.replace(/\D/g,'').replace(/^0+/,'');return local&&/^\d{6,14}$/.test(local)&&`${code}${local}`.length<=16?`${code}${local}`:''};
export const page=query=>{const start=Math.max(0,Number.parseInt(query._start,10)||0);const end=Math.max(start+1,Number.parseInt(query._end,10)||start+20);return{start,limit:Math.min(end-start,100)}};
export const notFound=(res,name)=>res.status(404).json({error:`${name} not found.`});
