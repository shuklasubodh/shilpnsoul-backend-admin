export const userColumns='id,first_name,last_name,email,phone,role,is_active,email_verified_at,phone_verified_at,created_at,updated_at';
export const isId=value=>/^\d+$/.test(String(value))&&Number(value)>0;
export const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const page=query=>{const start=Math.max(0,Number.parseInt(query._start,10)||0);const end=Math.max(start+1,Number.parseInt(query._end,10)||start+20);return{start,limit:Math.min(end-start,100)}};
export const notFound=(res,name)=>res.status(404).json({error:`${name} not found.`});
